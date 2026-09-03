import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../../src/server/database.js";
import { createExportReadyApp, waitAndReadZip } from "../helpers/archive.js";

const apps: Awaited<ReturnType<typeof createExportReadyApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function databaseOf(app: Awaited<ReturnType<typeof createExportReadyApp>>): AppDatabase {
  return (app as typeof app & { database: AppDatabase }).database;
}

async function selectCandidate(app: Awaited<ReturnType<typeof createExportReadyApp>>): Promise<void> {
  const selected = await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: {
    candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true
  } });
  expect(selected.statusCode).toBe(200);
}

describe("interrupted export regeneration", () => {
  it("atomically regenerates one interrupted snapshot while ready snapshots remain immutable", async () => {
    let generationStarts = 0;
    const app = await createExportReadyApp({ onExportGenerationStart: () => { generationStarts += 1; } }); apps.push(app);
    await selectCandidate(app);
    const first = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
    const exportId = first.json().id as string;
    await waitAndReadZip(app, exportId);
    expect(generationStarts).toBe(1);

    const readyAgain = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
    expect(readyAgain.json()).toMatchObject({ id: exportId, status: "ready" });
    expect(generationStarts).toBe(1);

    const database = databaseOf(app);
    const zipPath = (database.prepare("SELECT zip_path FROM exports WHERE id = ?").get(exportId) as { zip_path: string }).zip_path;
    await rm(zipPath, { force: true });
    database.prepare("UPDATE exports SET status = 'failed', error_code = 'EXPORT_INTERRUPTED', zip_path = NULL, zip_sha256 = NULL, completed_at = 'interrupted' WHERE id = ?").run(exportId);

    const [retried, duplicate] = await Promise.all([
      app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} }),
      app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} })
    ]);
    expect(retried.json().id).toBe(exportId);
    expect(duplicate.json().id).toBe(exportId);
    await waitAndReadZip(app, exportId);
    expect(generationStarts).toBe(2);
    expect(database.prepare("SELECT status, error_code FROM exports WHERE id = ?").get(exportId)).toMatchObject({ status: "ready", error_code: null });
  });

  it("reads contractual declarations live and records them in the immutable audit snapshot", async () => {
    const app = await createExportReadyApp({ contractualStorageRights: false }); apps.push(app);
    const database = databaseOf(app);
    database.prepare("UPDATE candidates SET provider_id = 'brave' WHERE id = 'candidate-1'").run();
    database.prepare("UPDATE search_hits SET provider_id = 'brave' WHERE id = 'hit-1'").run();
    await selectCandidate(app);

    const blocked = await app.inject({ method: "GET", url: "/api/jobs/job-1/exports/preflight" });
    expect(blocked.json().blockers.PROVIDER_STORAGE_RIGHTS_REQUIRED).toEqual(["candidate-1"]);

    const settings = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    const saved = await app.inject({ method: "PUT", url: "/api/settings", payload: {
      ...settings,
      contractualRightsDeclarations: { brave: true }
    } });
    expect(saved.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/jobs/job-1/exports/preflight" })).json().blockers).toEqual({});

    const created = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
    expect(created.statusCode).toBe(202);
    await waitAndReadZip(app, created.json().id);
    const snapshot = JSON.parse((database.prepare("SELECT snapshot_json FROM exports WHERE id = ?").get(created.json().id) as { snapshot_json: string }).snapshot_json);
    expect(snapshot.contractualRightsDeclarations).toEqual({ brave: true });
  });

  it("blocks an undeclared contractual provider found only in complete hit provenance", async () => {
    const app = await createExportReadyApp({ contractualStorageRights: false }); apps.push(app);
    const database = databaseOf(app);
    database.prepare("UPDATE candidates SET provider_id = 'openverse' WHERE id = 'candidate-1'").run();
    database.prepare("UPDATE search_hits SET provider_id = 'openverse' WHERE id = 'hit-1'").run();
    database.prepare("INSERT INTO search_hits (id, job_id, provider_id, normalized_image_url, image_url, rights_status) VALUES ('hit-brave', 'job-1', 'brave', 'https://source.example/item', 'https://source.example/item', 'unknown')").run();
    database.prepare("INSERT INTO candidate_hits VALUES ('candidate-1', 'hit-brave', 'run-1')").run();
    await selectCandidate(app);

    const preflight = await app.inject({ method: "GET", url: "/api/jobs/job-1/exports/preflight" });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json().blockers.PROVIDER_STORAGE_RIGHTS_REQUIRED).toEqual(["candidate-1"]);

    const created = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
    expect(created.statusCode).toBe(409);
    expect(created.json().preflight.blockers.PROVIDER_STORAGE_RIGHTS_REQUIRED).toEqual(["candidate-1"]);
  });
});
