import { afterEach, describe, expect, it } from "vitest";
import { createExportReadyApp } from "../helpers/archive.js";
import type { AppDatabase } from "../../src/server/database.js";

const apps: Awaited<ReturnType<typeof createExportReadyApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function seedDuplicateGroup(database: AppDatabase): void {
  database.prepare("UPDATE candidates SET near_duplicate_group = 'dup-1' WHERE id IN ('candidate-1', 'candidate-2')").run();
  database.prepare("DELETE FROM candidate_assets WHERE candidate_id = 'candidate-2'").run();
  database.prepare("INSERT INTO assets VALUES ('asset-2', ?, ?, ?, '1111111111111111', 1600, 900, 4, 'image/png', 'thumb-2', 'now')")
    .run("a".repeat(64), "b".repeat(64), "c".repeat(64));
  database.prepare("INSERT INTO candidate_assets VALUES ('candidate-2', 'asset-2', 'now')").run();
}

describe("review API", () => {
  it("requires an explicit final label before selection and records cursor ordered audit events", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const unlabelled = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", rightsAcknowledged: true } });
    expect(unlabelled.statusCode).toBe(400);
    const labelled = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "set_labels", labelIds: ["L1"], primaryLabelId: "L1" } });
    expect(labelled.statusCode).toBe(200);
    const response = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", rightsAcknowledged: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({ candidateId: "candidate-1", reviewState: "selected", rightsAcknowledged: true });
    expect((await app.inject({ method: "GET", url: "/api/jobs/job-1" })).json().labels[0].selectedCount).toBe(1);
    const events = await app.inject({ method: "GET", url: "/api/jobs/job-1/events" });
    expect(events.json().items.at(-1)).toMatchObject({ type: "review", status: "selected", candidateId: "candidate-1", action: "select" });
  });

  it("rolls back an entire batch when a candidate does not belong to its job", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1", "missing"], action: "select" } });
    expect(response.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/jobs/job-1" })).json().labels[0].selectedCount).toBe(0);
  });

  it("atomically keeps the deterministic highest-resolution duplicate with explicit labels", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    seedDuplicateGroup(database);

    const partialGroup = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: {
      candidateIds: ["candidate-2"], action: "keep_highest_resolution", primaryCandidateId: "candidate-2", labelIds: ["L1"], primaryLabelId: "L1"
    } });
    expect(partialGroup.statusCode).toBe(400);
    database.prepare("UPDATE candidates SET near_duplicate_group = 'dup-2' WHERE id = 'candidate-2'").run();
    const mixedGroups = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: {
      candidateIds: ["candidate-1", "candidate-2"], action: "keep_highest_resolution", primaryCandidateId: "candidate-2", labelIds: ["L1"], primaryLabelId: "L1"
    } });
    expect(mixedGroups.statusCode).toBe(400);
    database.prepare("UPDATE candidates SET near_duplicate_group = 'dup-1' WHERE id = 'candidate-2'").run();
    expect(database.prepare("SELECT candidate_id FROM candidate_review_state").all()).toHaveLength(0);

    const wrongPrimary = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: {
      candidateIds: ["candidate-1", "candidate-2"], action: "keep_highest_resolution", primaryCandidateId: "candidate-1", labelIds: ["L1"], primaryLabelId: "L1"
    } });
    expect(wrongPrimary.statusCode).toBe(400);
    expect(database.prepare("SELECT candidate_id FROM candidate_review_state").all()).toHaveLength(0);

    const response = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: {
      candidateIds: ["candidate-1", "candidate-2"], action: "keep_highest_resolution", primaryCandidateId: "candidate-2", labelIds: ["L1"], primaryLabelId: "L1"
    } });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({ candidateId: "candidate-2", reviewState: "selected", labelIds: ["L1"], primaryLabelId: "L1" }),
      expect.objectContaining({ candidateId: "candidate-1", reviewState: "rejected" })
    ]);
    expect((database.prepare("SELECT selected_count FROM label_targets WHERE job_id = 'job-1' AND label_id = 'L1'").get() as { selected_count: number }).selected_count).toBe(1);
    expect((database.prepare("SELECT candidate_id, action FROM review_events ORDER BY id").all() as Array<{ candidate_id: string; action: string }>)).toEqual([
      { candidate_id: "candidate-2", action: "keep_highest_resolution" },
      { candidate_id: "candidate-1", action: "keep_highest_resolution" }
    ]);
  });

  it("rolls back the whole keep-highest operation if any audit event fails", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    seedDuplicateGroup(database);
    database.exec("CREATE TRIGGER fail_keep_event BEFORE INSERT ON review_events WHEN NEW.action = 'keep_highest_resolution' AND NEW.candidate_id = 'candidate-1' BEGIN SELECT RAISE(ABORT, 'event fail'); END;");

    const response = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: {
      candidateIds: ["candidate-1", "candidate-2"], action: "keep_highest_resolution", primaryCandidateId: "candidate-2", labelIds: ["L1"], primaryLabelId: "L1"
    } });

    expect(response.statusCode).toBe(500);
    expect(database.prepare("SELECT candidate_id FROM candidate_review_state").all()).toHaveLength(0);
    expect(database.prepare("SELECT id FROM review_events").all()).toHaveLength(0);
    expect((database.prepare("SELECT selected_count FROM label_targets WHERE job_id = 'job-1' AND label_id = 'L1'").get() as { selected_count: number }).selected_count).toBe(0);
  });

  it("records and clears audit-safe rights evidence without accepting paths or secrets", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const saved = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "set_rights_evidence", rightsBasis: "licensed", rightsEvidence: "https://e.test/receipt/42" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().items[0]).toMatchObject({ rightsBasis: "licensed", rightsEvidence: "https://e.test/receipt/42", rightsStatus: "verified" });
    const database = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database;
    for (const evidence of ["https://e.test/x?X-Amz-Signature=secret", "https://alice:pw@e.test/x", "https://e.test/x#fragment", "file:///Users/alice/secret-token.txt"]) {
      const unsafe = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "set_rights_evidence", rightsBasis: "licensed", rightsEvidence: evidence } });
      expect(unsafe.statusCode).toBe(400);
    }
    expect(database.prepare("SELECT id FROM review_events WHERE candidate_id = 'candidate-1'").all()).toHaveLength(1);
    expect((database.prepare("SELECT rights_evidence FROM candidate_review_state WHERE candidate_id = 'candidate-1'").get() as { rights_evidence: string }).rights_evidence).toBe("https://e.test/receipt/42");
    const cleared = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "set_rights_evidence", rightsBasis: "unknown", rightsEvidence: null } });
    expect(cleared.json().items[0]).toMatchObject({ rightsBasis: "unknown", rightsEvidence: null, rightsStatus: "unknown" });
    expect((database.prepare("SELECT payload_json FROM review_events WHERE candidate_id = 'candidate-1' ORDER BY id").all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json).rightsStatus)).toEqual(["verified", "unknown"]);
  });

  it("nulls legacy unsafe rights evidence in review responses", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "set_rights_evidence", rightsBasis: "licensed", rightsEvidence: "https://e.test/receipt/42" } });
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare("UPDATE candidate_review_state SET rights_evidence = 'https://e.test/evidence?AccessKeyId=legacy-review-secret#/home/alice/private' WHERE candidate_id = 'candidate-1'").run();

    const response = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "acknowledge_rights", rightsAcknowledged: true } });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({ rightsEvidence: null, rightsAcknowledged: true });
    expect(response.body).not.toMatch(/AccessKeyId|legacy-review-secret|\/home\/alice/i);
  });

  it("returns 409 only for taxonomy multi-label conflicts while moderation accepts the same labels", async () => {
    const taxonomy = await createExportReadyApp(); apps.push(taxonomy);
    const conflict = await taxonomy.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: {
      candidateIds: ["candidate-1"], action: "set_labels", labelIds: ["L1", "L2"], primaryLabelId: "L1"
    } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "TAXONOMY_LABEL_CONFLICT" });

    const moderation = await createExportReadyApp(); apps.push(moderation);
    const database = (moderation as typeof moderation & { database: AppDatabase }).database;
    database.prepare("UPDATE jobs SET task_type = 'content_moderation' WHERE id = 'job-1'").run();
    const accepted = await moderation.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: {
      candidateIds: ["candidate-1"], action: "set_labels", labelIds: ["L1", "L2"], primaryLabelId: "L1"
    } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().items[0]).toMatchObject({ labelIds: ["L1", "L2"], primaryLabelId: "L1" });
  });

  it("preserves explicit final labels through move, reject, restore, acknowledgement, and warning override", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const call = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], ...payload } });
    expect((await call({ action: "set_labels", labelIds: ["L1"], primaryLabelId: "L1" })).statusCode).toBe(200);
    expect((await call({ action: "move_label", labelIds: ["L2"], primaryLabelId: "L2" })).json().items[0]).toMatchObject({ labelIds: ["L2"], primaryLabelId: "L2" });
    expect((await call({ action: "select" })).statusCode).toBe(200);
    expect((await call({ action: "reject" })).json().items[0].reviewState).toBe("rejected");
    expect((await call({ action: "restore" })).json().items[0]).toMatchObject({ reviewState: "unreviewed", labelIds: ["L2"] });
    expect((await call({ action: "acknowledge_rights" })).json().items[0].rightsAcknowledged).toBe(true);
    expect((await call({ action: "override_warning", warningCode: "LOW_RESOLUTION" })).json().items[0].warningOverrides).toEqual(["LOW_RESOLUTION"]);
  });
});
