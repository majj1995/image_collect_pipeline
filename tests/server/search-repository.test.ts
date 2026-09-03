import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../../src/server/database.js";
import { JobsRepository } from "../../src/server/repositories/jobs.js";
import { SearchRepository } from "../../src/server/repositories/search.js";
import { createJobInputSchema } from "../../src/shared/contracts.js";
import { parseLabelPaths } from "../../src/shared/taxonomy.js";

const databases: AppDatabase[] = [];

afterEach(() => { databases.splice(0).forEach((database) => database.close()); });

function createRun() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const jobs = new JobsRepository(database);
  const job = jobs.create(createJobInputSchema.parse({
    name: "atomic transitions", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
    labelPaths: ["A>B"]
  }), parseLabelPaths(["A>B"]));
  const searches = new SearchRepository(database);
  const run = searches.createRuns(job.id, [{ labelId: job.labels[0]!.id, providerId: "fake", variantName: "exact_ad", query: "speaker" }])[0]!;
  return { database, searches, jobId: job.id, run };
}

describe("query-run transition persistence", () => {
  it("rolls back both run state and event when transition event insertion fails", () => {
    const { database, searches, jobId, run } = createRun();
    database.exec("CREATE TRIGGER fail_running_event BEFORE INSERT ON job_events WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'event write failed'); END;");

    expect(() => searches.markRunning(run.id)).toThrow("event write failed");
    expect(searches.listRuns(jobId)[0]).toMatchObject({ status: "pending", startedAt: null });
    expect(searches.listEvents(jobId).map((event) => event.status)).toEqual(["pending"]);

    database.exec("DROP TRIGGER fail_running_event;");
    expect(searches.markRunning(run.id)).toBe(true);
    database.exec("CREATE TRIGGER fail_completed_event BEFORE INSERT ON job_events WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'event write failed'); END;");
    expect(() => searches.markFinished(run.id, "completed")).toThrow("event write failed");
    expect(searches.listRuns(jobId)[0]).toMatchObject({ status: "running", completedAt: null });
    expect(searches.listEvents(jobId).map((event) => event.status)).toEqual(["pending", "running"]);
  });

  it("never reclaims or silently completes a terminal failed run", () => {
    const { searches, jobId, run } = createRun();

    expect(searches.markRunning(run.id)).toBe(true);
    searches.markFinished(run.id, "failed", "configuration rejected the request");

    expect(searches.markRunning(run.id, "failed")).toBe(false);
    expect(searches.completeWithoutSearch(run.id, "failed")).toBe(false);
    expect(searches.listRuns(jobId)[0]).toMatchObject({
      id: run.id,
      status: "failed",
      errorSummary: "configuration rejected the request"
    });
  });

  it("preserves a resumed run's historical provider hit count when no new request is needed", () => {
    const { searches, jobId, run } = createRun();

    expect(searches.markRunning(run.id)).toBe(true);
    searches.markSearchCompleted(run.id, 7);
    expect(searches.claimResumableRuns(jobId, ["fake"], 1)).toHaveLength(0);

    // A paused row can be resumed after its successful request, for example when
    // candidate download recovery is pending. Completing that recovery must not
    // rewrite the raw provider result count to zero.
    const database = databases.at(-1)!;
    database.prepare("UPDATE query_runs SET status = 'paused', retryable = 0 WHERE id = ?").run(run.id);
    expect(searches.completeWithoutSearch(run.id, "paused")).toBe(true);
    expect(searches.listRuns(jobId)[0]).toMatchObject({
      id: run.id,
      status: "completed",
      hitCount: 7
    });
  });

  it("atomically reopens terminal failures only through the explicit provider retry transition", () => {
    const { database, searches, jobId, run } = createRun();
    expect(searches.markRunning(run.id)).toBe(true);
    searches.markFinished(run.id, "failed", "configuration rejected the request");
    database.exec("CREATE TRIGGER fail_retry_event BEFORE INSERT ON job_events WHEN NEW.status = 'retryable' BEGIN SELECT RAISE(ABORT, 'retry event write failed'); END;");

    expect(() => searches.retryFailedRuns(jobId, ["fake"])).toThrow("retry event write failed");
    expect(searches.listRuns(jobId)[0]).toMatchObject({ status: "failed", retryable: false });

    database.exec("DROP TRIGGER fail_retry_event;");
    expect(searches.retryFailedRuns(jobId, ["fake"])).toBe(1);
    expect(searches.listRuns(jobId)[0]).toMatchObject({ id: run.id, status: "retryable", retryable: true });
  });

  it("prioritizes an explicit provider retry through a 2000-row paused backlog without breaking provider fairness or the claim cap", () => {
    const { database, searches, jobId, run } = createRun();
    database.prepare("DELETE FROM job_events WHERE query_run_id = ?").run(run.id);
    database.prepare("DELETE FROM query_runs WHERE id = ?").run(run.id);
    const insert = database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, status, retryable, requires_explicit_retry, created_at
      ) VALUES (?, ?, ?, ?, 'backlog', ?, 1, 100, ?, ?, ?, 'now')
    `);
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (let index = 0; index < 2000; index += 1) {
        insert.run(`fake-paused-${index}`, jobId, run.labelId, "fake", `fake paused ${index}`, "paused", 0, 0);
      }
      insert.run("fake-explicit-retry", jobId, run.labelId, "fake", "fake explicit retry", "retryable", 1, 1);
      for (let index = 0; index < 2000; index += 1) {
        insert.run(`openverse-paused-${index}`, jobId, run.labelId, "openverse", `openverse paused ${index}`, "paused", 0, 0);
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }

    const claimed = searches.claimResumableRuns(jobId, ["fake", "openverse"], 2000, ["fake"]);

    expect(claimed).toHaveLength(2000);
    expect(claimed[0]).toMatchObject({ id: "fake-explicit-retry", providerId: "fake", status: "pending" });
    expect(claimed.slice(0, 4).map((entry) => entry.providerId)).toEqual(["fake", "openverse", "fake", "openverse"]);
    expect(claimed.filter((entry) => entry.providerId === "fake")).toHaveLength(1000);
    expect(claimed.filter((entry) => entry.providerId === "openverse")).toHaveLength(1000);
    expect(database.prepare("SELECT status FROM query_runs WHERE id = 'fake-explicit-retry'").get()).toEqual({ status: "pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE status = 'paused'").get()).toEqual({ count: 2001 });
  });

  it("rolls back every selected claim when its pending event cannot be recorded", () => {
    const { database, searches, jobId, run } = createRun();
    const second = searches.createRuns(jobId, [{ labelId: run.labelId, providerId: "fake", variantName: "alias_required", query: "speaker sale" }])[0]!;
    database.prepare("UPDATE query_runs SET status = 'paused' WHERE id IN (?, ?)").run(run.id, second.id);
    database.exec("CREATE TRIGGER fail_selected_pending_event BEFORE INSERT ON job_events WHEN NEW.status = 'pending' BEGIN SELECT RAISE(ABORT, 'selected claim event failed'); END;");

    expect(() => searches.claimScheduledRuns(jobId, [
      { ...run, status: "paused" },
      { ...second, status: "paused" }
    ])).toThrow("selected claim event failed");
    expect(searches.listRuns(jobId).map((entry) => ({ id: entry.id, status: entry.status }))).toEqual([
      { id: run.id, status: "paused" },
      { id: second.id, status: "paused" }
    ]);
  });
});
