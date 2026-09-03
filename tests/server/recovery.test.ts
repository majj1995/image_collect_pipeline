import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetService } from "../../src/server/services/asset-service.js";
import type { AppDatabase } from "../../src/server/database.js";
import { createSpeakerJob, createTestApp, makeTempDataDir, waitForJob } from "../helpers/server.js";
import { successfulFakeProvider } from "../helpers/providers.js";

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function databaseOf(app: Awaited<ReturnType<typeof createTestApp>>): AppDatabase {
  return (app as typeof app & { database: AppDatabase }).database;
}

function seedInterruptedWork(database: AppDatabase, jobId: string, labelId: string, exportId: string): void {
  database.prepare("UPDATE jobs SET status = 'collecting' WHERE id = ?").run(jobId);
  database.prepare("INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, status, started_at, created_at) VALUES ('run-interrupted', ?, ?, 'fake', 'seed', 'speaker ad', 'running', '2026-08-29T10:00:00.000Z', '2026-08-29T10:00:00.000Z')").run(jobId, labelId);
  database.prepare("INSERT INTO job_events (job_id, type, query_run_id, status, created_at) VALUES (?, 'query_run', 'run-interrupted', 'running', '2026-08-29T10:00:00.000Z')").run(jobId);
  database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('candidate-fetching', ?, 'https://images.example.test/fetching.png', 'fake', 'https://images.example.test/fetching.png', 'fetching', 'unknown', 'now')").run(jobId);
  database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('candidate-rejected-fetching', ?, 'https://images.example.test/rejected-fetching.png', 'fake', 'https://images.example.test/rejected-fetching.png', 'fetching', 'unknown', 'now')").run(jobId);
  database.prepare("INSERT INTO candidate_review_state (candidate_id, job_id, review_state, updated_at) VALUES ('candidate-rejected-fetching', ?, 'rejected', 'now')").run(jobId);
  database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('candidate-reviewed', ?, 'https://images.example.test/reviewed.png', 'fake', 'https://images.example.test/reviewed.png', 'processed', 'unknown', 'now')").run(jobId);
  database.prepare("INSERT INTO candidate_labels VALUES ('candidate-reviewed', ?, ?)").run(jobId, labelId);
  database.prepare("INSERT INTO candidate_review_state (candidate_id, job_id, review_state, label_ids_json, primary_label_id, updated_at) VALUES ('candidate-reviewed', ?, 'selected', ?, ?, 'now')").run(jobId, JSON.stringify([labelId]), labelId);
  database.prepare("INSERT INTO exports (id, job_id, status, snapshot_json, snapshot_hash, preflight_json, created_at) VALUES (?, ?, 'generating', '{}', 'interrupted-hash', '{}', 'now')").run(exportId, jobId);
}

describe("startup recovery", () => {
  it("recovers interrupted rows once, preserves reviews, rematerializes downloads, and only removes owned temp exports", async () => {
    const dataDir = await makeTempDataDir();
    const first = await createTestApp({ dataDir, assetService: false }); apps.push(first);
    const job = await createSpeakerJob(first);
    const labelId = (job.labels as Array<{ id: string }>)[0]!.id;
    const exportId = `export_${"a".repeat(24)}`;
    seedInterruptedWork(databaseOf(first), String(job.id), labelId, exportId);

    const exportRoot = join(dataDir, "exports");
    const ownedTemp = join(exportRoot, `.tmp-${exportId}-123-${randomUUID()}`);
    const decoyTemp = join(exportRoot, ".tmp-user-project");
    const unrelatedAppShape = join(exportRoot, `.tmp-export_${"b".repeat(24)}-456-${randomUUID()}`);
    for (const directory of [ownedTemp, decoyTemp, unrelatedAppShape]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "keep.txt"), "fixture");
    }
    await first.close(); apps.splice(apps.indexOf(first), 1);

    let materialized!: () => void;
    const rematerialized = new Promise<void>((resolve) => { materialized = resolve; });
    const materializeCandidate = vi.fn(async (candidateId: string) => { if (candidateId === "candidate-fetching") materialized(); });
    const assetService = { materializeCandidate } as unknown as AssetService;
    const second = await createTestApp({ dataDir, providers: [successfulFakeProvider("fake", 0)], assetService }); apps.push(second);
    await rematerialized;

    const database = databaseOf(second);
    expect(database.prepare("SELECT status, error_summary FROM query_runs WHERE id = 'run-interrupted'").get()).toMatchObject({
      status: "retryable",
      error_summary: "搜索因本地服务重启而中断，可继续重试。"
    });
    expect(database.prepare("SELECT pipeline_state, pipeline_error FROM candidates WHERE id = 'candidate-fetching'").get()).toMatchObject({ pipeline_state: "discovered", pipeline_error: "DOWNLOAD_INTERRUPTED" });
    expect(database.prepare("SELECT pipeline_state, pipeline_error FROM candidates WHERE id = 'candidate-rejected-fetching'").get()).toMatchObject({ pipeline_state: "discovered", pipeline_error: "DOWNLOAD_INTERRUPTED" });
    expect(database.prepare("SELECT review_state FROM candidate_review_state WHERE candidate_id = 'candidate-rejected-fetching'").get()).toEqual({ review_state: "rejected" });
    expect(database.prepare("SELECT review_state FROM candidate_review_state WHERE candidate_id = 'candidate-reviewed'").get()).toMatchObject({ review_state: "selected" });
    expect(database.prepare("SELECT status, error_code FROM exports WHERE id = ?").get(exportId)).toMatchObject({ status: "failed", error_code: "EXPORT_INTERRUPTED" });
    expect(database.prepare("SELECT status FROM jobs WHERE id = ?").get(String(job.id))).toMatchObject({ status: "reviewing" });
    expect(materializeCandidate).toHaveBeenCalledWith("candidate-fetching");
    expect(materializeCandidate).not.toHaveBeenCalledWith("candidate-rejected-fetching");

    const runPage = await second.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` });
    expect(runPage.json().providerRuns).toContainEqual(expect.objectContaining({
      id: "run-interrupted",
      status: "retryable",
      retryable: true,
      requiresExplicitRetry: false
    }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM job_events WHERE query_run_id = 'run-interrupted' AND status = 'retryable'").get()).toMatchObject({ count: 1 });
    await expect(access(ownedTemp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(decoyTemp)).resolves.toBeUndefined();
    await expect(access(unrelatedAppShape)).resolves.toBeUndefined();

    await second.close(); apps.splice(apps.indexOf(second), 1);
    const third = await createTestApp({ dataDir, assetService: false }); apps.push(third);
    expect(databaseOf(third).prepare("SELECT COUNT(*) AS count FROM job_events WHERE query_run_id = 'run-interrupted' AND status = 'retryable'").get()).toMatchObject({ count: 1 });
    expect(databaseOf(third).prepare("SELECT review_state FROM candidate_review_state WHERE candidate_id = 'candidate-reviewed'").get()).toMatchObject({ review_state: "selected" });
  });

  it("continues a retryable query run with the same run id while planning unrelated discovery", async () => {
    const provider = successfulFakeProvider("fake", 1);
    const search = vi.spyOn(provider, "search");
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);
    const labelId = (job.labels as Array<{ id: string }>)[0]!.id;
    databaseOf(app).prepare("INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, status, error_summary, created_at) VALUES ('run-retryable', ?, ?, 'fake', 'exact_ad', 'speaker ad', 'retryable', '搜索因本地服务重启而中断，可继续重试。', 'now')").run(String(job.id), labelId);

    const started = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    expect(started.statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");

    const rows = databaseOf(app).prepare("SELECT id, status FROM query_runs WHERE job_id = ? ORDER BY rowid").all(String(job.id)) as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ id: "run-retryable", status: "completed" });
    expect(new Set(rows.map((row) => row.id)).size).toBe(6);
    expect(rows.every((row) => row.status === "completed")).toBe(true);
    expect(search).toHaveBeenCalledTimes(6);
  });

  it("recovers pending and running runs together, reuses every unfinished id, and still schedules newly selected providers", async () => {
    const dataDir = await makeTempDataDir();
    const first = await createTestApp({ dataDir, assetService: false }); apps.push(first);
    const job = await createSpeakerJob(first);
    const labelId = (job.labels as Array<{ id: string }>)[0]!.id;
    const database = databaseOf(first);
    database.prepare("UPDATE jobs SET status = 'collecting' WHERE id = ?").run(String(job.id));
    database.prepare("INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, status, started_at, created_at) VALUES ('unfinished-running', ?, ?, 'fake', 'exact_ad', 'speaker running', 'running', 'now', 'now')").run(String(job.id), labelId);
    database.prepare("INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, status, created_at) VALUES ('unfinished-pending', ?, ?, 'fake', 'english_ad', 'speaker pending', 'pending', 'now')").run(String(job.id), labelId);
    await first.close(); apps.splice(apps.indexOf(first), 1);

    const fake = successfulFakeProvider("fake", 0);
    const openverse = successfulFakeProvider("openverse", 0);
    const fakeSearch = vi.spyOn(fake, "search");
    const openverseSearch = vi.spyOn(openverse, "search");
    const second = await createTestApp({ dataDir, providers: [fake, openverse], assetService: false }); apps.push(second);
    expect(databaseOf(second).prepare("SELECT id, status, retryable FROM query_runs ORDER BY id").all()).toEqual([
      { id: "unfinished-pending", status: "retryable", retryable: 1 },
      { id: "unfinished-running", status: "retryable", retryable: 1 }
    ]);

    const resumed = await second.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
    expect(resumed.statusCode).toBe(202);
    await waitForJob(second, String(job.id), "reviewing");
    const rows = databaseOf(second).prepare("SELECT id, provider_id, status FROM query_runs WHERE job_id = ? ORDER BY rowid").all(String(job.id)) as Array<{ id: string; provider_id: string; status: string }>;
    const fakeRows = rows.filter((row) => row.provider_id === "fake");
    expect(fakeRows).toHaveLength(7);
    expect(fakeRows).toEqual(expect.arrayContaining([
      { id: "unfinished-running", provider_id: "fake", status: "completed" },
      { id: "unfinished-pending", provider_id: "fake", status: "completed" }
    ]));
    expect(fakeRows.every((row) => row.status === "completed")).toBe(true);
    expect(rows.filter((row) => row.provider_id === "openverse")).toHaveLength(5);
    expect(rows.filter((row) => row.provider_id === "openverse").every((row) => row.status === "completed")).toBe(true);
    expect(fakeSearch).toHaveBeenCalledTimes(7);
    expect(openverseSearch).toHaveBeenCalledTimes(5);
  });
});
