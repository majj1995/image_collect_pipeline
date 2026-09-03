import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../../src/server/database.js";
import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "../../src/server/providers/types.js";
import type { AssetService } from "../../src/server/services/asset-service.js";
import { createTestApp, waitForJob } from "../helpers/server.js";

const apps: Array<Awaited<ReturnType<typeof createTestApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createCrossProductJob(
  app: Awaited<ReturnType<typeof createTestApp>>,
  options: { candidateCount?: number; targetCount?: number } = {}
): Promise<{ id: string; labels: Array<{ id: string }> }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/jobs",
    payload: {
      name: "续搜回归任务",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商>音箱"],
      targetCount: options.targetCount ?? 1,
      candidateCount: options.candidateCount ?? 4,
      labelSearchProfiles: [{
        labelPath: "电商>音箱",
        zh: { terms: ["speaker", "audio"], styles: ["minimal", "promotion"], requiredTerms: [], excludedTerms: [] },
        en: { terms: ["speaker", "audio"], styles: ["minimal", "promotion"], requiredTerms: [], excludedTerms: [] }
      }]
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; labels: Array<{ id: string }> };
}

async function createSingletonProfileJob(
  app: Awaited<ReturnType<typeof createTestApp>>,
  options: { candidateCount?: number } = {}
): Promise<{ id: string; labels: Array<{ id: string }> }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/jobs",
    payload: {
      name: "singleton 补充续搜任务",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商>音箱"],
      targetCount: 1,
      candidateCount: options.candidateCount ?? 4,
      labelSearchProfiles: [{
        labelPath: "电商>音箱",
        zh: { terms: ["speaker"], styles: ["minimal"], requiredTerms: [], excludedTerms: [] },
        en: { terms: ["speaker"], styles: ["minimal"], requiredTerms: [], excludedTerms: [] }
      }]
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; labels: Array<{ id: string }> };
}

describe("search replenishment", () => {
  it("advances each query independently after a short non-empty page and stops its empty sibling", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "independent query cursor fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      supportsPagination: true,
      canRequestPage: () => true,
      async search(request) {
        requests.push(request);
        if (request.query !== "speaker minimal") return [];
        return [{
          provider: "fake",
          rank: 1,
          thumbnailUrl: null,
          imageUrl: `https://images.example.test/${request.query.replaceAll(" ", "-")}-page-${request.page ?? 1}.jpg`,
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
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createCrossProductJob(app);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ query: "speaker minimal", page: 1, count: 2 }),
      expect.objectContaining({ query: "audio minimal", page: 1, count: 2 })
    ]));

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    const runs = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{
      labelId: string;
      providerId: string;
      variantName: string;
      query: string;
      page: number;
    }>;
    expect(requests.filter((request) => request.page === 2).map((request) => request.query)).toEqual(["speaker minimal"]);
    expect(requests.some((request) => request.query === "audio minimal" && request.page === 2)).toBe(false);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    const continuedRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as typeof runs;
    expect(requests.filter((request) => request.query === "speaker minimal").map((request) => request.page)).toEqual([1, 2, 3]);
    expect(requests.filter((request) => request.query === "audio minimal").map((request) => request.page)).toEqual([1]);
    expect(new Set(continuedRuns.map((run) => [run.labelId, run.providerId, run.variantName, run.query, run.page].join("\0"))).size).toBe(continuedRuns.length);
  });

  it("persists each provider's non-empty result count when a concurrent peer fills the candidate batch", async () => {
    const requests: Array<{ providerId: "fake" | "openverse"; request: ProviderSearchRequest }> = [];
    const started = new Set<string>();
    let signalBothStarted!: () => void;
    let releasePageOne!: () => void;
    const bothStarted = new Promise<void>((resolve) => { signalBothStarted = resolve; });
    const pageOneGate = new Promise<void>((resolve) => { releasePageOne = resolve; });
    const provider = (providerId: "fake" | "openverse"): ImageSearchProvider => ({
      id: providerId,
      displayName: `${providerId} concurrent result fixture`,
      configured: true,
      maxResults: 1,
      rightsPolicy: "open",
      supportsPagination: true,
      canRequestPage: () => true,
      async search(request) {
        requests.push({ providerId, request: { ...request } });
        if (request.page !== 1) return [];
        started.add(providerId);
        if (started.size === 2) signalBothStarted();
        await pageOneGate;
        return [{
          provider: providerId,
          rank: 1,
          thumbnailUrl: null,
          imageUrl: `https://images.example.test/concurrent-${providerId}.jpg`,
          landingPageUrl: null,
          title: null,
          creator: null,
          licenseName: null,
          licenseUrl: null,
          width: 800,
          height: 800,
          sourceProvider: providerId,
          source: providerId,
          rightsStatus: "unknown"
        } satisfies NormalizedHit];
      }
    });
    const app = await createTestApp({ providers: [provider("fake"), provider("openverse")], assetService: false });
    apps.push(app);
    const job = await createSingletonProfileJob(app, { candidateCount: 1 });

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] }
    })).statusCode).toBe(202);
    await bothStarted;
    releasePageOne();
    await waitForJob(app, job.id, "reviewing");

    const firstRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{
      providerId: string;
      query: string;
      page: number;
      status: string;
      hitCount: number;
    }>;
    expect(firstRuns).toHaveLength(2);
    expect(firstRuns.every((run) => run.status === "completed" && run.hitCount === 1)).toBe(true);

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    expect(requests.filter(({ request }) => request.page === 2).map(({ providerId }) => providerId).sort()).toEqual(["fake", "openverse"]);
  });

  it("continues a non-empty supplemental term-only query from page one to page two", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "supplemental pager fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      supportsPagination: true,
      canRequestPage: () => true,
      async search(request) {
        requests.push(request);
        if (request.query !== "speaker") return [];
        return [{
          provider: "fake",
          rank: 1,
          thumbnailUrl: null,
          imageUrl: `https://images.example.test/supplemental-page-${request.page ?? 1}.jpg`,
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
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createSingletonProfileJob(app);

    for (let start = 0; start < 3; start += 1) {
      expect((await app.inject({
        method: "POST",
        url: `/api/jobs/${job.id}/search`,
        payload: { providerIds: ["fake"] }
      })).statusCode).toBe(202);
      await waitForJob(app, job.id, "reviewing");
    }

    expect(requests.map((request) => ({ query: request.query, page: request.page }))).toEqual([
      { query: "speaker minimal", page: 1 },
      { query: "speaker", page: 1 },
      { query: "speaker", page: 2 }
    ]);
    const runs = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{
      variantName: string;
      query: string;
      page: number;
    }>;
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ variantName: "term_only", query: "speaker", page: 1 }),
      expect.objectContaining({ variantName: "term_only", query: "speaker", page: 2 })
    ]));
  });

  it("plans supplemental discovery while stable download materialization is resumable", async () => {
    const requests: string[] = [];
    const materialized: string[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "materialization coexistence fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      async search(request) { requests.push(request.query); return []; }
    };
    const assetService = {
      registerTransientDownloadUrl() {},
      async materializeCandidate(candidateId: string) { materialized.push(candidateId); }
    } as AssetService;
    const app = await createTestApp({ providers: [provider], assetService });
    apps.push(app);
    const job = await createSingletonProfileJob(app);

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare(`
      INSERT INTO candidates (
        id, job_id, normalized_image_url, provider_id, image_url, pipeline_state,
        rights_status, provider_rights_status, created_at, pipeline_error, pipeline_failure_code
      ) VALUES (
        'retryable-download', ?, 'https://images.example.test/retryable.jpg', 'fake',
        'https://images.example.test/retryable.jpg', 'discovered', 'unknown', 'unknown', 'now',
        'RETRYABLE_DOWNLOAD', 'NETWORK'
      )
    `).run(job.id);

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    await vi.waitFor(() => { expect(materialized).toEqual(["retryable-download"]); });

    expect(requests).toEqual(["speaker minimal", "speaker"]);
  });

  it("puts fresh provider work ahead of ordinary resumable backlog while preserving the 2000-run scheduling cap", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "combined ceiling fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      async search(request) { requests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "resumable plus fresh ceiling",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商>已完成", "电商>待发现"],
        targetCount: 1,
        candidateCount: 4,
        labelSearchProfiles: ["已完成", "待发现"].map((term) => ({
          labelPath: `电商>${term}`,
          zh: { terms: [term, `${term}别名`], styles: ["极简", "促销"], requiredTerms: [], excludedTerms: [] },
          en: { terms: [term, `${term}别名`], styles: ["极简", "促销"], requiredTerms: [], excludedTerms: [] }
        }))
      }
    });
    expect(response.statusCode).toBe(201);
    const job = response.json() as { id: string; labels: Array<{ id: string }> };
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare("UPDATE label_targets SET selected_count = 1 WHERE job_id = ? AND label_id = ?").run(job.id, job.labels[0]!.id);
    const insert = database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, status, retryable, created_at
      ) VALUES (?, ?, ?, 'fake', 'legacy', ?, 1, 4, 'retryable', 1, 'now')
    `);
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (let index = 0; index < 1_999; index += 1) {
        insert.run(`resumable-${index}`, job.id, job.labels[0]!.id, `legacy-${index}`);
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect((database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ?").get(job.id) as { count: number }).count).toBe(2_002);
    expect(requests).toHaveLength(3);
    expect(requests[0]!.query).toBe("待发现 极简");
  }, 30_000);

  it("schedules an eligible next page even when more than 2000 ordinary paused runs are waiting", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "continuation before paused backlog fixture",
      configured: true,
      maxResults: 10,
      rightsPolicy: "open",
      supportsPagination: true,
      canRequestPage: () => true,
      async search(request) { requests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "continuation before legacy backlog",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商>已选满", "电商>继续翻页"],
        targetCount: 1,
        candidateCount: 1,
        labelSearchProfiles: ["已选满", "继续翻页"].map((term) => ({
          labelPath: `电商>${term}`,
          zh: { terms: [term], styles: ["促销"], requiredTerms: [], excludedTerms: [] },
          en: { terms: [term], styles: ["promotion"], requiredTerms: [], excludedTerms: [] }
        }))
      }
    });
    expect(response.statusCode).toBe(201);
    const job = response.json() as { id: string; labels: Array<{ id: string }> };
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare("UPDATE label_targets SET selected_count = 1 WHERE job_id = ? AND label_id = ?").run(job.id, job.labels[0]!.id);
    const insertPaused = database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, status, retryable, created_at
      ) VALUES (?, ?, ?, 'fake', 'legacy', ?, 1, 1, 'paused', 0, 'now')
    `);
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (let index = 0; index < 2_001; index += 1) {
        insertPaused.run(`paused-${index}`, job.id, job.labels[0]!.id, `legacy ${index}`);
      }
      database.prepare(`
        INSERT INTO query_runs (
          id, job_id, label_id, provider_id, variant_name, query_text, page,
          request_count, provider_hit_count, status, retryable, created_at, completed_at
        ) VALUES ('completed-page-one', ?, ?, 'fake', 'exact_ad', '继续翻页 promotion', 1, 1, 1, 'completed', 0, 'now', 'now')
      `).run(job.id, job.labels[1]!.id);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(requests).toContainEqual(expect.objectContaining({ query: "继续翻页 promotion", page: 2 }));
    expect(database.prepare("SELECT status FROM query_runs WHERE id = 'completed-page-one'").get()).toEqual({ status: "completed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ? AND status = 'paused'").get(job.id))
      .toEqual({ count: 2 });
  }, 30_000);

  it("does not let 2000 explicit retries from one provider starve another provider's continuation", async () => {
    const openverseRequests: ProviderSearchRequest[] = [];
    const fake: ImageSearchProvider = {
      id: "fake", displayName: "explicit retry backlog", configured: true, maxResults: 10, rightsPolicy: "open",
      async search() { return []; }
    };
    const openverse: ImageSearchProvider = {
      id: "openverse", displayName: "continuation peer", configured: true, maxResults: 10, rightsPolicy: "open",
      supportsPagination: true, canRequestPage: () => true,
      async search(request) { openverseRequests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [fake, openverse], assetService: false });
    apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/api/jobs", payload: {
        name: "explicit retry does not starve peer continuation",
        taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
        labelPaths: ["电商>显式重试", "电商>继续翻页"], targetCount: 1, candidateCount: 1,
        labelSearchProfiles: ["显式重试", "继续翻页"].map((term) => ({
          labelPath: `电商>${term}`,
          zh: { terms: [term], styles: ["促销"], requiredTerms: [], excludedTerms: [] },
          en: { terms: [term], styles: ["promotion"], requiredTerms: [], excludedTerms: [] }
        }))
      }
    });
    expect(response.statusCode).toBe(201);
    const job = response.json() as { id: string; labels: Array<{ id: string }> };
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare("UPDATE label_targets SET selected_count = 1 WHERE job_id = ? AND label_id = ?").run(job.id, job.labels[0]!.id);
    const insert = database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, request_count, status, retryable, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 'now')
    `);
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (let index = 0; index < 2_000; index += 1) {
        insert.run(`failed-${index}`, job.id, job.labels[0]!.id, "fake", "legacy", `failed ${index}`, "failed", 0);
      }
      database.prepare(`
        INSERT INTO query_runs (
          id, job_id, label_id, provider_id, variant_name, query_text, page,
          request_count, provider_hit_count, status, retryable, created_at, completed_at
        ) VALUES ('openverse-page-one', ?, ?, 'openverse', 'exact_ad', '继续翻页 promotion', 1, 1, 1, 'completed', 0, 'now', 'now')
      `).run(job.id, job.labels[1]!.id);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake", "openverse"], retryFailedProviderIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(openverseRequests).toContainEqual(expect.objectContaining({ query: "继续翻页 promotion", page: 2 }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id = ? AND type = 'query_run' AND status = 'pending'").get(job.id))
      .toEqual({ count: 2_000 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ? AND provider_id = 'fake' AND status = 'completed'").get(job.id))
      .toEqual({ count: 1_999 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ? AND provider_id = 'openverse' AND page = 2 AND status = 'completed'").get(job.id))
      .toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM query_runs
      WHERE job_id = ? AND provider_id = 'fake' AND status = 'retryable' AND requires_explicit_retry = 1
    `).get(job.id)).toEqual({ count: 2 });
  }, 30_000);

  it("executes a provider continuation before that provider's ordinary paused base run", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "same provider continuation priority", configured: true, maxResults: 10, rightsPolicy: "open",
      supportsPagination: true, canRequestPage: () => true,
      async search(request) { requests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createCrossProductJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    const insert = database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, provider_hit_count, status, retryable, created_at, completed_at
      ) VALUES (?, ?, ?, 'fake', ?, ?, 1, 1, ?, ?, 0, 'now', 'now')
    `);
    const insertPaused = database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, status, retryable, created_at
      ) VALUES (?, ?, ?, 'fake', ?, ?, 1, 1, 'paused', 0, 'now')
    `);
    insert.run("page-one", job.id, job.labels[0]!.id, "exact_ad", "speaker minimal", 1, "completed");
    insertPaused.run("paused-base", job.id, job.labels[0]!.id, "alias_required", "audio minimal");

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(requests.slice(0, 2).map((request) => ({ query: request.query, page: request.page }))).toEqual([
      { query: "speaker minimal", page: 2 },
      { query: "audio minimal", page: 1 }
    ]);
  });

  it("executes an already paused page two before an untried base query from the same provider", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "paused continuation priority", configured: true, maxResults: 10, rightsPolicy: "open",
      supportsPagination: true, canRequestPage: () => true,
      async search(request) { requests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createCrossProductJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    const insert = database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, provider_hit_count, status, retryable, created_at, completed_at
      ) VALUES (?, ?, ?, 'fake', 'exact_ad', 'speaker minimal', ?, 1, ?, ?, 0, 'now', ?)
    `);
    insert.run("completed-page-one", job.id, job.labels[0]!.id, 1, 1, "completed", "now");
    insert.run("paused-page-two", job.id, job.labels[0]!.id, 2, 0, "paused", "now");

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(requests.slice(0, 2).map((request) => ({ query: request.query, page: request.page }))).toEqual([
      { query: "speaker minimal", page: 2 },
      { query: "audio minimal", page: 1 }
    ]);
  });

  it("keeps one same-provider continuation scheduled through a 2000-row explicit retry backlog", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "same provider explicit retry backlog", configured: true, maxResults: 10, rightsPolicy: "open",
      supportsPagination: true, canRequestPage: () => true,
      async search(request) { requests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/api/jobs", payload: {
        name: "same provider explicit retry and continuation",
        taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
        labelPaths: ["电商>显式重试", "电商>继续翻页"], targetCount: 1, candidateCount: 1,
        labelSearchProfiles: ["显式重试", "继续翻页"].map((term) => ({
          labelPath: `电商>${term}`,
          zh: { terms: [term], styles: ["促销"], requiredTerms: [], excludedTerms: [] },
          en: { terms: [term], styles: ["promotion"], requiredTerms: [], excludedTerms: [] }
        }))
      }
    });
    expect(response.statusCode).toBe(201);
    const job = response.json() as { id: string; labels: Array<{ id: string }> };
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare("UPDATE label_targets SET selected_count = 1 WHERE job_id = ? AND label_id = ?").run(job.id, job.labels[0]!.id);
    const insert = database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, request_count, status, retryable, created_at)
      VALUES (?, ?, ?, 'fake', ?, ?, 1, 1, ?, 0, 'now')
    `);
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (let index = 0; index < 2_000; index += 1) {
        insert.run(`failed-${index}`, job.id, job.labels[0]!.id, "legacy", `failed ${index}`, "failed");
      }
      database.prepare(`
        INSERT INTO query_runs (
          id, job_id, label_id, provider_id, variant_name, query_text, page,
          request_count, provider_hit_count, status, retryable, created_at, completed_at
        ) VALUES ('page-one', ?, ?, 'fake', 'exact_ad', '继续翻页 promotion', 1, 1, 1, 'completed', 0, 'now', 'now')
      `).run(job.id, job.labels[1]!.id);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"], retryFailedProviderIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(requests).toContainEqual(expect.objectContaining({ query: "继续翻页 promotion", page: 2 }));
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM query_runs
      WHERE job_id = ? AND provider_id = 'fake' AND status = 'retryable' AND requires_explicit_retry = 1
    `).get(job.id)).toEqual({ count: 1 });
  }, 30_000);

  it("treats candidateCount as a per-search batch limit so rejected history can be replenished", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "paged replenishment fixture",
      configured: true,
      maxResults: 1,
      rightsPolicy: "open",
      supportsPagination: true,
      canRequestPage: () => true,
      async search(request) {
        requests.push(request);
        return [{
          provider: "fake",
          rank: 1,
          thumbnailUrl: null,
          imageUrl: `https://images.example.test/replenishment-page-${request.page ?? 1}.jpg`,
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
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createCrossProductJob(app, { targetCount: 1, candidateCount: 1 });

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    const firstPage = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json();
    expect(firstPage.items).toHaveLength(1);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/reviews`,
      payload: { candidateIds: [firstPage.items[0].id], action: "reject" }
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    const replenished = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json();
    expect(requests.map((request) => request.page ?? 1)).toEqual([1, 2]);
    expect(replenished.items).toHaveLength(2);
    expect(replenished.labelProgress).toEqual([{ labelId: job.labels[0]!.id, candidateCount: 2 }]);
    expect(replenished.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstPage.items[0].id, reviewState: "rejected" }),
      expect.objectContaining({ reviewState: "unreviewed" })
    ]));
  });

  it("resumes base page-one runs deferred by the prior candidate batch without replacing their ids", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "deferred base fixture",
      configured: true,
      maxResults: 1,
      rightsPolicy: "open",
      supportsPagination: true,
      canRequestPage: () => true,
      async search(request) {
        requests.push(request);
        if (request.query !== "speaker minimal" || request.page !== 1) return [];
        return [{
          provider: "fake",
          rank: 1,
          thumbnailUrl: null,
          imageUrl: "https://images.example.test/deferred-first-batch.jpg",
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
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createCrossProductJob(app, { targetCount: 1, candidateCount: 1 });

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    expect(requests.map((request) => ({ query: request.query, page: request.page }))).toEqual([
      { query: "speaker minimal", page: 1 }
    ]);
    const firstRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{
      id: string;
      query: string;
      page: number;
      requestCount: number | null;
    }>;
    const originalBaseIds = new Map(firstRuns.map((run) => [run.query, run.id]));
    expect(firstRuns).toHaveLength(3);

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(requests.map((request) => ({ query: request.query, page: request.page }))).toEqual([
      { query: "speaker minimal", page: 1 },
      { query: "speaker minimal", page: 2 },
      { query: "audio minimal", page: 1 },
      { query: "speaker promotion", page: 1 }
    ]);
    const continuedRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as typeof firstRuns;
    expect(continuedRuns).toHaveLength(4);
    expect(continuedRuns.filter((run) => run.page === 1).map((run) => [run.query, run.id])).toEqual([
      ["speaker minimal", originalBaseIds.get("speaker minimal")],
      ["audio minimal", originalBaseIds.get("audio minimal")],
      ["speaker promotion", originalBaseIds.get("speaker promotion")]
    ]);
    expect(continuedRuns.filter((run) => run.page === 1).every((run) => run.requestCount === 1)).toBe(true);
  });

  it("starts an untried term-style combination after regular queries and pagination are exhausted", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "non-paginated cross-product fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      supportsPagination: false,
      async search(request) {
        requests.push(request);
        return [];
      }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createCrossProductJob(app);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    expect(requests.map((request) => request.query)).toEqual([
      "speaker minimal",
      "audio minimal",
      "speaker promotion"
    ]);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(requests.map((request) => request.query)).toEqual([
      "speaker minimal",
      "audio minimal",
      "speaker promotion",
      "audio promotion"
    ]);
    const runs = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ query: string; page: number }>;
    expect(runs).toEqual(expect.arrayContaining([expect.objectContaining({ query: "audio promotion", page: 1 })]));
  });

  it("returns exhausted without entering collecting when every selected-provider query is already exhausted", async () => {
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "fully exhausted fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      supportsPagination: false,
      async search() { return []; }
    };
    const search = vi.spyOn(provider, "search");
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createCrossProductJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    const insert = database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, status, retryable, created_at, completed_at
      ) VALUES (?, ?, ?, 'fake', ?, ?, 1, 4, 'completed', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `);
    [
      ["exact", "exact_ad", "speaker minimal"],
      ["alias", "alias_required", "audio minimal"],
      ["style", "style_required", "speaker promotion"],
      ["cross", "alias_required", "audio promotion"]
    ].forEach(([id, variantName, query]) => insert.run(id, job.id, job.labels[0]!.id, variantName, query));
    database.prepare("UPDATE jobs SET status = 'reviewing' WHERE id = ?").run(job.id);
    const runCountBefore = (database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ?").get(job.id) as { count: number }).count;

    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "exhausted" });
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().status).toBe("reviewing");
    expect(search).not.toHaveBeenCalled();
    expect((database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ?").get(job.id) as { count: number }).count).toBe(runCountBefore);
  });
});
