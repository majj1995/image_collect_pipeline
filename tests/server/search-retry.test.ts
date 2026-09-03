import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../../src/server/database.js";
import { ProviderError, type ImageSearchProvider, type NormalizedHit } from "../../src/server/providers/types.js";
import { SearchRepository } from "../../src/server/repositories/search.js";
import type { AssetService } from "../../src/server/services/asset-service.js";
import type { ProviderId } from "../../src/shared/contracts.js";
import { createSpeakerJob, createTestApp, waitForJob } from "../helpers/server.js";

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function createSingletonProfileJob(app: Awaited<ReturnType<typeof createTestApp>>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/jobs",
    payload: {
      name: "singleton retry isolation",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商>音箱"],
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

function failingProvider(status: number): ImageSearchProvider {
  return {
    id: "fake", displayName: "Transient fake", configured: true, maxResults: 10, rightsPolicy: "open",
    async search() { throw new ProviderError("fake", status, status === 429 || status >= 500); }
  };
}

describe("search retry integration", () => {
  it("rematerializes only the non-rejected failure when one refreshed run returns both old hits", async () => {
    const rejectedUrl = "https://images.example.test/rejected-signed.jpg";
    const activeUrl = "https://images.example.test/active-signed.jpg";
    let generation = "stale";
    const provider: ImageSearchProvider = {
      id: "openverse",
      displayName: "mixed signed download recovery fixture",
      configured: true,
      maxResults: 2,
      rightsPolicy: "open",
      refreshDownloadUrlOnRetry: true,
      supportsPagination: false,
      async search(request) {
        if (request.query !== "speaker minimal") return [];
        return [rejectedUrl, activeUrl].map((imageUrl, index): NormalizedHit => ({
          provider: "openverse",
          rank: index + 1,
          thumbnailUrl: imageUrl,
          imageUrl,
          transientImageUrl: `${imageUrl}?x-expires=1999999999&x-signature=${generation}-${index}`,
          landingPageUrl: null,
          title: index === 0 ? "rejected" : "active",
          creator: null,
          licenseName: null,
          licenseUrl: null,
          width: 800,
          height: 800,
          sourceProvider: "fixture",
          source: String(index),
          rightsStatus: "unknown"
        }));
      }
    };
    const materializeCandidate = vi.fn(async () => undefined);
    const registerTransientDownloadUrl = vi.fn();
    const assets = { materializeCandidate, registerTransientDownloadUrl } as unknown as AssetService;
    const app = await createTestApp({ providers: [provider], assetService: assets });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "mixed signed recovery",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商>音箱"],
        labelSearchProfiles: [{
          labelPath: "电商>音箱",
          zh: { terms: ["speaker"], styles: ["minimal"], requiredTerms: [], excludedTerms: [] },
          en: { terms: ["speaker"], styles: ["minimal"], requiredTerms: [], excludedTerms: [] }
        }],
        targetCount: 1,
        candidateCount: 2
      }
    });
    expect(response.statusCode).toBe(201);
    const job = response.json() as { id: string };

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["openverse"] } })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    expect(materializeCandidate).toHaveBeenCalledTimes(2);
    const firstPage = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json() as {
      items: Array<{ id: string; imageUrl: string; provenance: unknown[] }>;
    };
    const rejected = firstPage.items.find((candidate) => candidate.imageUrl === rejectedUrl)!;
    const active = firstPage.items.find((candidate) => candidate.imageUrl === activeUrl)!;
    expect(rejected.provenance).toHaveLength(1);
    expect(active.provenance).toHaveLength(1);

    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare("UPDATE candidates SET pipeline_state = 'discovered', pipeline_error = 'RETRYABLE_DOWNLOAD', pipeline_failure_code = 'NETWORK' WHERE job_id = ?").run(job.id);
    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/reviews`,
      payload: { candidateIds: [rejected.id], action: "reject" }
    })).statusCode).toBe(200);

    materializeCandidate.mockClear();
    generation = "fresh";
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["openverse"] } })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(materializeCandidate).toHaveBeenCalledTimes(1);
    expect(materializeCandidate).toHaveBeenCalledWith(active.id);
    expect(materializeCandidate).not.toHaveBeenCalledWith(rejected.id);
    const recoveredPage = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json() as {
      items: Array<{ id: string; reviewState: string; provenance: unknown[] }>;
    };
    expect(recoveredPage.items.find((candidate) => candidate.id === rejected.id)).toMatchObject({
      reviewState: "rejected",
      provenance: [expect.any(Object)]
    });
    expect(recoveredPage.items.find((candidate) => candidate.id === active.id)?.provenance).toHaveLength(1);
  });

  it("excludes rejected download failures from stable and signed-URL recovery", async () => {
    const calls: ProviderId[] = [];
    const provider = (id: "fake" | "openverse", refreshDownloadUrlOnRetry: boolean): ImageSearchProvider => ({
      id,
      displayName: `${id} rejected recovery fixture`,
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      refreshDownloadUrlOnRetry,
      async search(request) {
        calls.push(id);
        return [{
          provider: id,
          rank: 1,
          thumbnailUrl: null,
          imageUrl: `https://images.example.test/${id}-${encodeURIComponent(request.query)}.jpg`,
          landingPageUrl: null,
          title: null,
          creator: null,
          licenseName: null,
          licenseUrl: null,
          width: 800,
          height: 800,
          sourceProvider: id,
          source: id,
          rightsStatus: "unknown"
        } satisfies NormalizedHit];
      }
    });
    const app = await createTestApp({
      providers: [provider("fake", false), provider("openverse", true)],
      assetService: false
    });
    apps.push(app);
    const job = await createSpeakerJob(app);
    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake", "openverse"] }
    })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");

    const database = (app as typeof app & { database: AppDatabase }).database;
    const candidates = database.prepare("SELECT id FROM candidates WHERE job_id = ? ORDER BY rowid").all(job.id) as Array<{ id: string }>;
    expect(candidates.length).toBeGreaterThan(0);
    database.prepare("UPDATE candidates SET pipeline_state = 'discovered', pipeline_error = 'RETRYABLE_DOWNLOAD', pipeline_failure_code = 'NETWORK' WHERE job_id = ?").run(job.id);
    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/reviews`,
      payload: { candidateIds: candidates.map((candidate) => candidate.id), action: "reject" }
    })).statusCode).toBe(200);

    const searches = new SearchRepository(database);
    const runIds = database.prepare("SELECT id FROM query_runs WHERE job_id = ? ORDER BY rowid").all(job.id) as Array<{ id: string }>;
    expect(searches.listRetryableDownloadCandidateIds(String(job.id), ["fake"])).toEqual([]);
    expect(runIds.every((run) => searches.runHasRetryableDownloadCandidate(run.id) === false)).toBe(true);
    expect(searches.retryRunsForDownloadFailures(String(job.id), ["openverse"])).toBe(0);

    const callCountBeforeContinuation = calls.length;
    const exhausted = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake", "openverse"] }
    });
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toEqual({ status: "exhausted" });
    expect(calls).toHaveLength(callCountBeforeContinuation);
  });

  it("lets an untried supplemental query proceed when its base query failed terminally", async () => {
    const requests: string[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "terminal base isolation fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      async search(request) { requests.push(request.query); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createSingletonProfileJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, status, retryable, error_summary, created_at, completed_at
      ) VALUES ('failed-base', ?, ?, 'fake', 'exact_ad', 'speaker minimal', 1, 20, 'failed', 0, 'terminal', 'now', 'now')
    `).run(job.id, job.labels[0]!.id);

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(requests).toEqual(["speaker"]);
    expect(database.prepare("SELECT id, variant_name, query_text, page FROM query_runs WHERE job_id = ? ORDER BY rowid").all(job.id)).toEqual([
      { id: "failed-base", variant_name: "exact_ad", query_text: "speaker minimal", page: 1 },
      expect.objectContaining({ variant_name: "term_only", query_text: "speaker", page: 1 })
    ]);
  });

  it("continues paused work without implicitly retrying a provider failure until that provider is explicitly retried", async () => {
    let providerUnavailable = true;
    const requests: string[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "explicit transient retry fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      async search(request) {
        requests.push(request.query);
        if (providerUnavailable) throw new ProviderError("fake", 503, true);
        return [];
      }
    };
    const app = await createTestApp({ providers: [provider], assetService: false, searchRetry: { maxAttempts: 1 } });
    apps.push(app);
    const job = await createSingletonProfileJob(app);

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    const database = (app as typeof app & { database: AppDatabase }).database;
    expect(database.prepare("SELECT status FROM query_runs WHERE job_id = ?").all(job.id)).toEqual([{ status: "retryable" }]);
    database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, status, retryable, error_summary, created_at, completed_at
      ) VALUES ('paused-supplemental', ?, ?, 'fake', 'term_only', 'speaker', 1, 100, 'paused', 0, NULL, 'now', 'now')
    `).run(job.id, job.labels[0]!.id);
    providerUnavailable = false;

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(requests).toEqual(["speaker minimal", "speaker"]);
    expect(database.prepare("SELECT id, status FROM query_runs WHERE job_id = ? ORDER BY rowid").all(job.id)).toEqual([
      { id: expect.any(String), status: "retryable" },
      { id: "paused-supplemental", status: "completed" }
    ]);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"], retryFailedProviderIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    expect(requests).toEqual(["speaker minimal", "speaker", "speaker minimal"]);
    expect(database.prepare("SELECT status FROM query_runs WHERE job_id = ? ORDER BY rowid").all(job.id))
      .toEqual([{ status: "completed" }, { status: "completed" }]);
  });

  it("retries an explicitly failed combination while discovering other untried combinations", async () => {
    const requests: string[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "retry plus discovery fixture",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      async search(request) { requests.push(request.query); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createSpeakerJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare(`
      INSERT INTO query_runs (
        id, job_id, label_id, provider_id, variant_name, query_text, page,
        request_count, status, retryable, error_summary, created_at, completed_at
      ) VALUES ('failed-explicit', ?, ?, 'fake', 'exact_ad', '音箱 电商海报', 1, 4, 'failed', 0, 'terminal', 'now', 'now')
    `).run(job.id, (job.labels as Array<{ id: string }>)[0]!.id);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"], retryFailedProviderIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");

    const rows = database.prepare("SELECT id, query_text, status FROM query_runs WHERE job_id = ? ORDER BY rowid").all(job.id) as Array<{
      id: string;
      query_text: string;
      status: string;
    }>;
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ id: "failed-explicit", query_text: "音箱 电商海报", status: "completed" });
    expect(new Set(requests)).toEqual(new Set(rows.map((row) => row.query_text)));
  });

  it("retries a provider-declared transient network failure even without an HTTP status", async () => {
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "Network fake", configured: true, maxResults: 10, rightsPolicy: "open",
      async search() { throw new ProviderError("fake", null, true); }
    };
    const search = vi.spyOn(provider, "search");
    const sleep = vi.fn(async () => undefined);
    const app = await createTestApp({ providers: [provider], searchRetry: { sleep, random: () => 0, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");

    const page = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json();
    expect(page.providerRuns.every((run: { status: string; retryable: boolean; requiresExplicitRetry?: boolean; errorSummary: string }) =>
      run.status === "retryable" && run.retryable && run.requiresExplicitRetry === true
      && run.errorSummary === "提供方暂时不可用，可稍后继续重试（已尝试 3 次）。"
    )).toBe(true);
    expect(search).toHaveBeenCalledTimes(15);
    expect(sleep).toHaveBeenCalledTimes(10);
  });

  it("persists exhausted 429 runs as safely summarized retryable work", async () => {
    const provider = failingProvider(429);
    const search = vi.spyOn(provider, "search");
    const sleep = vi.fn(async () => undefined);
    const app = await createTestApp({ providers: [provider], searchRetry: { sleep, random: () => 0.5, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
    apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");

    const page = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json();
    expect(page.providerRuns).toHaveLength(5);
    expect(page.providerRuns.every((run: { status: string; retryable: boolean; errorSummary: string }) =>
      run.status === "retryable" && run.retryable && run.errorSummary === "提供方请求过于频繁，可稍后继续重试（已尝试 3 次）。"
    )).toBe(true);
    expect(search).toHaveBeenCalledTimes(15);
    expect(sleep).toHaveBeenCalledTimes(10);
  });

  it("does not retry or mark ordinary 4xx failures as retryable", async () => {
    const provider = failingProvider(403);
    const search = vi.spyOn(provider, "search");
    const app = await createTestApp({ providers: [provider], searchRetry: { sleep: async () => undefined, random: () => 0, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");

    const page = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json();
    expect(page.providerRuns.every((run: { status: string; retryable: boolean; errorSummary: string }) =>
      run.status === "failed" && !run.retryable && run.errorSummary === "提供方凭据无效或权限不足，请检查本地配置（已尝试 1 次）。"
    )).toBe(true);
    expect(search).toHaveBeenCalledTimes(5);
  });

  it("rejects a concurrent continuation before retryable run ids can be executed twice", async () => {
    const provider = failingProvider(503);
    const search = vi.spyOn(provider, "search");
    const app = await createTestApp({ providers: [provider], assetService: false, searchRetry: { maxAttempts: 1 } });
    apps.push(app);
    const job = await createSpeakerJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, request_count, status, retryable, created_at)
      VALUES ('retryable-race-run', ?, ?, 'fake', 'exact_ad', '音箱 电商海报', 1, 100, 'retryable', 1, '2025-01-01T00:00:00.000Z')
    `).run(job.id, job.labels[0].id);

    const responses = await Promise.all([
      app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } }),
      app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    await waitForJob(app, String(job.id), "reviewing");
    const retriedQueryCalls = search.mock.calls.filter(([request]) => request.query === "音箱 电商海报");
    expect(retriedQueryCalls).toHaveLength(1);
    const runs = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{
      id: string;
      status: string;
      retryable: boolean;
    }>;
    expect(runs).toHaveLength(5);
    expect(new Set(runs.map((run) => run.id)).size).toBe(5);
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "retryable-race-run", status: "retryable", retryable: true })
    ]));
  });

  it("retries terminal failures only for an explicitly requested provider and reuses its run ids", async () => {
    const failing = new Map<ProviderId, boolean>([["fake", true], ["openverse", true]]);
    const provider = (id: "fake" | "openverse"): ImageSearchProvider => ({
      id, displayName: `${id} terminal then recoverable`, configured: true, maxResults: 100, rightsPolicy: "open", supportsPagination: true,
      async search() {
        if (failing.get(id)) throw new ProviderError(id, 403, false);
        return [];
      }
    });
    const fake = provider("fake");
    const openverse = provider("openverse");
    const fakeSearch = vi.spyOn(fake, "search");
    const openverseSearch = vi.spyOn(openverse, "search");
    const app = await createTestApp({ providers: [fake, openverse], assetService: false, searchRetry: { maxAttempts: 1 } });
    apps.push(app);
    const job = await createSpeakerJob(app);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    const initialRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; providerId: ProviderId; status: string }>;
    expect(initialRuns).toHaveLength(10);
    expect(initialRuns.every((run) => run.status === "failed")).toBe(true);

    const exhausted = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toEqual({ status: "exhausted" });
    await waitForJob(app, String(job.id), "reviewing");
    expect(fakeSearch).toHaveBeenCalledTimes(5);
    expect(openverseSearch).toHaveBeenCalledTimes(5);

    failing.set("fake", false);
    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"], retryFailedProviderIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    const retriedRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as typeof initialRuns;

    expect(retriedRuns.map((run) => run.id)).toEqual(initialRuns.map((run) => run.id));
    expect(retriedRuns.filter((run) => run.providerId === "fake").every((run) => run.status === "completed")).toBe(true);
    expect(retriedRuns.filter((run) => run.providerId === "openverse").every((run) => run.status === "failed")).toBe(true);
    expect(fakeSearch).toHaveBeenCalledTimes(10);
    expect(openverseSearch).toHaveBeenCalledTimes(5);
  });
});
