import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createExportReadyApp, waitAndReadZip } from "../helpers/archive.js";
import { createTestApp, makeTempDataDir } from "../helpers/server.js";

const apps: Awaited<ReturnType<typeof createExportReadyApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function waitForWorker(worker: Worker, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker did not signal ${expected}.`)), 2_000);
    const onMessage = (message: string) => { if (message === expected) { clearTimeout(timer); worker.off("message", onMessage); worker.off("error", onError); resolve(); } };
    const onError = (error: Error) => { clearTimeout(timer); worker.off("message", onMessage); reject(error); };
    worker.on("message", onMessage); worker.once("error", onError);
  });
}

describe("dataset export", () => {
  it("persists search platforms in the immutable snapshot and exported dataset metadata", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const database = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database;
    const searchPlatforms = ["jd", "xiaohongshu"];
    database.prepare("UPDATE jobs SET settings_json = ? WHERE id = 'job-1'").run(JSON.stringify({ searchPlatforms: ["xiaohongshu", "jd"] }));
    await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true } });

    const created = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
    expect(created.statusCode).toBe(202);
    const snapshot = JSON.parse((database.prepare("SELECT snapshot_json FROM exports WHERE id = ?").get(created.json().id) as { snapshot_json: string }).snapshot_json);
    expect(snapshot.searchPlatforms).toEqual(searchPlatforms);
    const archive = await waitAndReadZip(app, created.json().id);
    expect(JSON.parse(archive.text("dataset.json")).searchPlatforms).toEqual(searchPlatforms);
  });
  it("exports one manifest row per selected image without paths or secrets", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true } });
    const created = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
    expect(created.statusCode).toBe(202);
    const archive = await waitAndReadZip(app, created.json().id);
    expect(archive.rootDirectory).toBe(`export-job_${created.json().id}`);
    expect(archive.rawFiles.every((name) => name.startsWith(`${archive.rootDirectory}/`))).toBe(true);
    expect(archive.files.filter((name) => name.startsWith("images/"))).toHaveLength(1);
    expect(archive.text("manifest.jsonl").trim().split("\n")).toHaveLength(1);
    expect(archive.text("checksums.sha256")).toContain("images/");
    for (const line of archive.text("checksums.sha256").trim().split("\n")) {
      const [expectedHash, path] = line.split("  ");
      expect(createHash("sha256").update(archive.bytes(path!)).digest("hex")).toBe(expectedHash);
    }
    const manifest = JSON.parse(archive.text("manifest.jsonl"));
    expect(manifest).toMatchObject({ selectedCandidateIds: ["candidate-1"], sourceCandidateIds: ["candidate-1", "candidate-2"], labelTargets: [{ labelId: "L1", product: "Speaker" }] });
    expect(manifest.provenance[0]).toMatchObject({ imageUrl: null, landingPageUrl: null });
    expect(archive.allText()).not.toMatch(/API_KEY|\/Users\/|Cookie|signature|super-secret|alice:pw|file:/i);
  });

  it("preserves complete provenance for the same image discovered by distinct hits and query runs", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const database = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database;
    database.prepare(`
      UPDATE query_runs SET variant_name = 'exact_ad', query_text = 'speaker campaign', page = 1 WHERE id = 'run-1'
    `).run();
    database.prepare(`
      UPDATE search_hits SET image_url = 'https://media.example/same.jpg?size=large&token=first-secret',
        landing_page_url = 'https://shop.example/same?sku=42&session=first-secret', title = 'Speaker campaign',
        creator = 'Example studio', license_name = 'CC0', license_url = 'https://rights.example/cc0?token=first-secret',
        source_provider = 'Example catalog', source = 'https://catalog.example/item?sku=42&token=first-secret', rights_status = 'cc0'
      WHERE id = 'hit-1'
    `).run();
    database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, status, created_at)
      VALUES ('run-2', 'job-1', 'L1', 'fake', 'style_required AccessKeyId=zip-access-secret', 'speaker Access Key ID: zip-spaced-secret; /private/var/folders/export.db; festival campaign', 2, 'completed', 'now')
    `).run();
    database.prepare(`
      INSERT INTO search_hits (id, job_id, provider_id, normalized_image_url, image_url, landing_page_url, title, creator, license_name, license_url, source_provider, source, rights_status)
      VALUES ('hit-3', 'job-1', 'fake', 'https://source.example/alternate-key',
        'https://media.example/same.jpg?size=large&AccessKeyId=zip-url-secret&token=second-secret', 'https://shop.example/same?sku=42&session=second-secret',
        'Speaker AccessKeySecret=zip-key-secret', 'Example SecretAccessKey=creator-secret; studio', 'CC0 secret=license-secret', 'https://rights.example/cc0?token=second-secret',
        'Example catalog Access Key ID: provider-secret; verified', '/home/alice/export-private.json', 'cc0')
    `).run();
    database.prepare("INSERT INTO candidate_hits VALUES ('candidate-1', 'hit-3', 'run-2')").run();
    await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true } });

    const created = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
    expect(created.statusCode).toBe(202);
    const archive = await waitAndReadZip(app, created.json().id);
    const manifest = JSON.parse(archive.text("manifest.jsonl"));
    const repeatedImageProvenance = manifest.provenance.filter((entry: { imageUrl: string | null }) => entry.imageUrl === "https://media.example/same.jpg?size=large");

    expect(repeatedImageProvenance).toEqual([
      expect.objectContaining({
        hitId: "hit-1", queryRunId: "run-1", provider: "fake", variantName: "exact_ad",
        query: "speaker campaign", page: 1, title: "Speaker campaign", creator: "Example studio",
        sourceProvider: "Example catalog", source: "https://catalog.example/item?sku=42", rightsStatus: "cc0"
      }),
      expect.objectContaining({
        hitId: "hit-3", queryRunId: "run-2", provider: "fake", variantName: "style_required [REDACTED]",
        query: "speaker [REDACTED]; [REDACTED]; festival campaign", page: 2, title: "Speaker [REDACTED]", creator: "Example [REDACTED]; studio",
        licenseName: "CC0 [REDACTED]", sourceProvider: "Example catalog [REDACTED]; verified", source: "[REDACTED]", rightsStatus: "cc0"
      })
    ]);
    expect(repeatedImageProvenance.every((entry: { licenseUrl: string | null }) => entry.licenseUrl === "https://rights.example/cc0")).toBe(true);
    expect(archive.allText()).not.toMatch(/first-secret|second-secret|zip-access-secret|zip-spaced-secret|zip-url-secret|zip-key-secret|variant-secret|query-secret|title-secret|creator-secret|license-secret|provider-secret|\/private\/|\/home\/|alice:pw/);
  });

  it("streams the immutable ZIP download instead of buffering the whole archive", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    let downloadPayloadWasReadable = false;
    app.addHook("onSend", async (request, _reply, payload) => {
      if (request.url.endsWith("/download")) downloadPayloadWasReadable = payload instanceof Readable;
      return payload;
    });
    await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true } });
    const created = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });

    await waitAndReadZip(app, created.json().id);
    const downloaded = await app.inject({ method: "GET", url: `/api/exports/${created.json().id}/download` });

    expect(downloadPayloadWasReadable).toBe(true);
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toBe("application/zip");
    expect(downloaded.headers["content-disposition"]).toBe(`attachment; filename="${created.json().id}.zip"`);
  });

  it("fails closed when unsanitized label metadata contains a generic credential or local path", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const database = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database;
    database.prepare("UPDATE label_targets SET product = 'Access Key ID: raw-label-secret' WHERE job_id = 'job-1' AND label_id = 'L1'").run();
    database.prepare("UPDATE taxonomy_nodes SET display_name = '/home/alice/private-label.json' WHERE job_id = 'job-1' AND label_id = 'L1'").run();
    await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true } });

    const created = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
    let status = created.json();
    for (let index = 0; index < 100 && status.status === "generating"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: `/api/exports/${created.json().id}` })).json();
    }

    expect(status).toMatchObject({ status: "failed", errorCode: "EXPORT_GENERATION_FAILED", zipSha256: null });
    expect((await app.inject({ method: "GET", url: `/api/exports/${created.json().id}/download` })).statusCode).toBe(404);
  });

  it("creates one immutable export record for concurrent identical requests", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true } });
    const [first, second] = await Promise.all([app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} }), app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} })]);
    expect(first.statusCode).toBe(202); expect(second.statusCode).toBe(202);
    expect(first.json().id).toBe(second.json().id);
    expect((await waitAndReadZip(app, first.json().id)).files.filter((name) => name.startsWith("images/"))).toHaveLength(1);
  });

  it("blocks taxonomy exports when selected exact duplicates have different final leaves", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    for (const [candidateId, labelId] of [["candidate-1", "L1"], ["candidate-2", "L2"]]) await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: [candidateId], action: "select", labelIds: [labelId], primaryLabelId: labelId, rightsAcknowledged: true } });
    const preflight = await app.inject({ method: "GET", url: "/api/jobs/job-1/exports/preflight" });
    expect(preflight.json().blockers.LABEL_CONFLICT).toEqual(["asset-1"]);
    expect((await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} })).statusCode).toBe(409);
  });

  it("deduplicates concurrent requests across two SQLite connections", async () => {
    const dataDir = await makeTempDataDir();
    let starts = 0;
    const firstApp = await createExportReadyApp({ dataDir, onExportGenerationStart: () => { starts += 1; } }); apps.push(firstApp);
    const secondApp = await createTestApp({ dataDir, assetService: false, contractualStorageRights: true, onExportGenerationStart: () => { starts += 1; } });
    try {
      await firstApp.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true } });
      const [first, second] = await Promise.all([firstApp.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} }), secondApp.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} })]);
      expect(first.statusCode).toBe(202); expect(second.statusCode).toBe(202); expect(first.json().id).toBe(second.json().id);
      const database = (firstApp as typeof firstApp & { database: import("../../src/server/database.js").AppDatabase }).database;
      expect(database.prepare("SELECT id FROM exports").all()).toHaveLength(1);
      expect((await waitAndReadZip(firstApp, first.json().id)).files.filter((name) => name.startsWith("images/"))).toHaveLength(1);
      expect(starts).toBe(1);
    } finally { await secondApp.close(); }
  });

  it("nulls legacy unsafe evidence at the export boundary", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true } });
    const database = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database;
    database.prepare("UPDATE candidate_review_state SET rights_basis = 'licensed', rights_evidence = 'https://e.test/evidence?SeSsIoN=secret' WHERE candidate_id = 'candidate-1'").run();
    const created = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
    const archive = await waitAndReadZip(app, created.json().id);
    expect(JSON.parse(archive.text("manifest.jsonl")).reviewAudit[0].rightsEvidence).toBeNull();
    expect(archive.allText()).not.toContain("secret");
  });

  it("waits for a competing committed review before atomically snapshotting across connections", async () => {
    const dataDir = await makeTempDataDir(); let starts = 0;
    const handshake = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
    const signalAttempt = () => { Atomics.store(handshake, 1, 1); Atomics.notify(handshake, 1); };
    const firstApp = await createExportReadyApp({ dataDir, onExportGenerationStart: () => { starts += 1; }, testBeforeExportTransaction: signalAttempt }); apps.push(firstApp);
    const secondApp = await createTestApp({ dataDir, assetService: false, contractualStorageRights: true, onExportGenerationStart: () => { starts += 1; }, testBeforeExportTransaction: signalAttempt });
    let worker: Worker | undefined;
    try {
      await firstApp.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "select", labelIds: ["L1"], primaryLabelId: "L1", rightsAcknowledged: true } });
      worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(workerData.path);
        db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
        db.prepare("UPDATE candidate_review_state SET label_ids_json = '[\\\"L2\\\"]', primary_label_id = 'L2' WHERE candidate_id = 'candidate-1'").run();
        db.prepare("UPDATE label_targets SET selected_count = CASE label_id WHEN 'L1' THEN 0 WHEN 'L2' THEN 1 ELSE selected_count END WHERE job_id = 'job-1'").run();
        const state = new Int32Array(workerData.barrier);
        Atomics.store(state, 0, 1); Atomics.notify(state, 0); parentPort.postMessage('locked');
        if (Atomics.wait(state, 1, 0, 2_000) === 'timed-out') throw new Error('Export did not attempt transaction.');
        db.exec('COMMIT;'); db.close(); Atomics.store(state, 2, 1); Atomics.notify(state, 2); parentPort.postMessage('committed');
      `, { eval: true, workerData: { path: join(dataDir, "pipeline.sqlite"), barrier: handshake.buffer } });
      await waitForWorker(worker, "locked");
      expect(Atomics.load(handshake, 0)).toBe(1);
      const committed = waitForWorker(worker, "committed");
      const [first, second] = await Promise.all([firstApp.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} }), secondApp.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} })]);
      await committed;
      expect(Atomics.load(handshake, 1)).toBe(1); expect(Atomics.load(handshake, 2)).toBe(1);
      expect(first.statusCode).toBe(202); expect(second.statusCode).toBe(202); expect(first.json().id).toBe(second.json().id);
      const archive = await waitAndReadZip(firstApp, first.json().id); const manifest = JSON.parse(archive.text("manifest.jsonl"));
      expect(manifest).toMatchObject({ primaryLabelId: "L2", labelIds: ["L2"], labelTargets: [{ labelId: "L2", product: "Headphone" }] });
      const database = (firstApp as typeof firstApp & { database: import("../../src/server/database.js").AppDatabase }).database;
      expect(database.prepare("SELECT id FROM exports").all()).toHaveLength(1); expect(starts).toBe(1);
      expect((await readdir(join(dataDir, "exports"))).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    } finally { if (worker) await worker.terminate(); await secondApp.close(); }
  });

  it("returns a safe 404 for a missing job without creating an export", async () => {
    const app = await createExportReadyApp(); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/jobs/missing/exports", payload: {} });
    expect(response.statusCode).toBe(404);
    const database = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database;
    expect(database.prepare("SELECT id FROM exports").all()).toEqual([]);
  });
});
