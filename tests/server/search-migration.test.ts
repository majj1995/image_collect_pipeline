import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../../src/server/database.js";
import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "../../src/server/providers/types.js";
import type { ProviderId } from "../../src/shared/contracts.js";
import { createTestApp, makeBilingualProfiles, waitForJob } from "../helpers/server.js";

const apps = new Set<Awaited<ReturnType<typeof createTestApp>>>();
const directories = new Set<string>();

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
  directories.clear();
});

describe("query-run pagination migration", () => {
  it("adds provider_hit_count to a legacy database while preserving candidate-hit fallback", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "query-run-hit-count-migration-test-"));
    directories.add(dataDir);
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "legacy provider hit fixture",
      configured: true,
      maxResults: 1,
      rightsPolicy: "open",
      async search() {
        return [{
          provider: "fake",
          rank: 1,
          thumbnailUrl: null,
          imageUrl: "https://images.example.test/legacy-provider-hit.jpg",
          landingPageUrl: null,
          title: null,
          creator: null,
          licenseName: null,
          licenseUrl: null,
          width: 800,
          height: 800,
          sourceProvider: "fake",
          source: "fake",
          rightsStatus: "unknown"
        } satisfies NormalizedHit];
      }
    };
    const firstApp = await createTestApp({ dataDir, providers: [provider], assetService: false });
    apps.add(firstApp);
    const created = await firstApp.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "legacy provider hit count", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["电商>音箱"], labelSearchProfiles: makeBilingualProfiles(["电商>音箱"]), candidateCount: 1, targetCount: 1
    } });
    expect(created.statusCode).toBe(201);
    const job = created.json();
    expect((await firstApp.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(firstApp, job.id, "reviewing");
    await firstApp.close();
    apps.delete(firstApp);

    const legacy = new DatabaseSync(join(dataDir, "pipeline.sqlite"));
    const legacyColumns = legacy.prepare("PRAGMA table_info(query_runs)").all() as unknown as Array<{ name: string }>;
    if (legacyColumns.some((column) => column.name === "provider_hit_count")) {
      legacy.exec("ALTER TABLE query_runs DROP COLUMN provider_hit_count;");
    }
    legacy.close();

    const reopened = await createTestApp({ dataDir, providers: [provider], assetService: false });
    apps.add(reopened);
    const database = (reopened as typeof reopened & { database: AppDatabase }).database;
    const migratedColumns = database.prepare("PRAGMA table_info(query_runs)").all() as unknown as Array<{ name: string }>;
    expect(migratedColumns.some((column) => column.name === "provider_hit_count")).toBe(true);
    expect(database.prepare("SELECT provider_hit_count FROM query_runs ORDER BY rowid").all())
      .toEqual(Array.from({ length: 5 }, () => ({ provider_hit_count: null })));
    const runs = (await reopened.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ hitCount: number }>;
    expect(runs.map((run) => run.hitCount)).toEqual([1, 0, 0, 0, 0]);
  });

  it.each([
    ["transient", "提供方暂时不可用，可稍后继续重试（已尝试 3 次）。"],
    ["rate limit", "提供方请求过于频繁，可稍后继续重试（已尝试 3 次）。"]
  ] as const)("migrates a legacy %s provider failure idempotently to require an explicit provider retry", async (_case, errorSummary) => {
    const dataDir = await mkdtemp(join(tmpdir(), "query-run-explicit-retry-migration-test-"));
    directories.add(dataDir);
    const requests: string[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "legacy explicit retry fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      async search(request) { requests.push(request.query); return []; }
    };
    const firstApp = await createTestApp({ dataDir, providers: [provider], assetService: false });
    apps.add(firstApp);
    const created = await firstApp.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "legacy explicit provider retry", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["电商>音箱"],
      labelSearchProfiles: [{
        labelPath: "电商>音箱",
        zh: { terms: ["speaker"], styles: ["minimal"], requiredTerms: [], excludedTerms: [] },
        en: { terms: ["speaker"], styles: ["minimal"], requiredTerms: [], excludedTerms: [] }
      }]
    } });
    expect(created.statusCode).toBe(201);
    const job = created.json() as { id: string; labels: Array<{ id: string }> };
    const database = (firstApp as typeof firstApp & { database: AppDatabase }).database;
    database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, status, retryable, error_summary, created_at
      ) VALUES (
        'legacy-provider-failure', ?, ?, 'fake', 'exact_ad', 'speaker minimal', 1,
        100, 'retryable', 1, ?, 'now'
      )
    `).run(job.id, job.labels[0]!.id, errorSummary);
    await firstApp.close();
    apps.delete(firstApp);

    const legacy = new DatabaseSync(join(dataDir, "pipeline.sqlite"));
    const legacyColumns = legacy.prepare("PRAGMA table_info(query_runs)").all() as unknown as Array<{ name: string }>;
    if (legacyColumns.some((column) => column.name === "requires_explicit_retry")) {
      legacy.exec("ALTER TABLE query_runs DROP COLUMN requires_explicit_retry;");
    }
    legacy.close();

    const reopened = await createTestApp({ dataDir, providers: [provider], assetService: false });
    apps.add(reopened);
    expect((await reopened.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(reopened, job.id, "reviewing");

    const reopenedDatabase = (reopened as typeof reopened & { database: AppDatabase }).database;
    expect(requests).toEqual(["speaker"]);
    expect(reopenedDatabase.prepare("SELECT status FROM query_runs WHERE id = 'legacy-provider-failure'").get())
      .toEqual({ status: "retryable" });

    await reopened.close();
    apps.delete(reopened);
    const reopenedAgain = await createTestApp({ dataDir, providers: [provider], assetService: false });
    apps.add(reopenedAgain);
    const ordinaryContinuation = await reopenedAgain.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    });
    expect(ordinaryContinuation.statusCode).toBe(200);
    expect(ordinaryContinuation.json()).toEqual({ status: "exhausted" });
    expect(requests).toEqual(["speaker"]);

    expect((await reopenedAgain.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"], retryFailedProviderIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(reopenedAgain, job.id, "reviewing");
    expect(requests).toEqual(["speaker", "speaker minimal"]);
    const reopenedAgainDatabase = (reopenedAgain as typeof reopenedAgain & { database: AppDatabase }).database;
    expect(reopenedAgainDatabase.prepare("SELECT status FROM query_runs WHERE id = 'legacy-provider-failure'").get())
      .toEqual({ status: "completed" });
  });

  it.each([
    ["generic", "fake", undefined],
    ["DataForSEO-compatible", "dataforseo", (page: number, count: number) => (page - 1) * count < 200]
  ] as const)("backfills legacy %s runs and adds supplemental combinations after an empty page one", async (_name, id, canRequestPage) => {
    const dataDir = await mkdtemp(join(tmpdir(), "query-run-migration-test-"));
    directories.add(dataDir);
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: id as ProviderId,
      displayName: `${id} legacy pager`,
      configured: true,
      maxResults: id === "dataforseo" ? 200 : 100,
      rightsPolicy: "open",
      supportsPagination: true,
      ...(canRequestPage ? { canRequestPage } : {}),
      async search(request) { requests.push(request); return []; }
    };

    const firstApp = await createTestApp({ dataDir, providers: [provider], assetService: false });
    apps.add(firstApp);
    const created = await firstApp.inject({ method: "POST", url: "/api/jobs", payload: {
      name: `${id} legacy pagination`, taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["电商>音箱"], labelSearchProfiles: makeBilingualProfiles(["电商>音箱"]), candidateCount: 500, targetCount: 30
    } });
    expect(created.statusCode).toBe(201);
    const job = created.json();
    expect((await firstApp.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: [id] } })).statusCode).toBe(202);
    await waitForJob(firstApp, job.id, "reviewing");
    expect(requests).toHaveLength(5);
    expect(requests.every((request) => request.page === 1 && request.count === 100)).toBe(true);

    await firstApp.close();
    apps.delete(firstApp);
    const legacy = new DatabaseSync(join(dataDir, "pipeline.sqlite"));
    legacy.exec("ALTER TABLE query_runs DROP COLUMN request_count;");
    legacy.exec("ALTER TABLE query_runs DROP COLUMN page;");
    legacy.close();

    const reopened = await createTestApp({ dataDir, providers: [provider], assetService: false });
    apps.add(reopened);
    const database = (reopened as typeof reopened & { database: AppDatabase }).database;
    const migrated = database.prepare("SELECT page, request_count FROM query_runs ORDER BY rowid").all() as unknown as Array<{ page: number; request_count: number }>;
    expect(migrated).toHaveLength(5);
    expect(migrated.every((run) => run.page === 1 && run.request_count === 100)).toBe(true);

    expect((await reopened.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: [id] } })).statusCode).toBe(202);
    await waitForJob(reopened, job.id, "reviewing");
    expect(requests).toHaveLength(9);
    expect(requests.slice(5).every((request) => request.page === 1)).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ?").get(job.id)).toEqual({ count: 9 });
  });
});
