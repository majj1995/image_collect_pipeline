import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError, type ImageSearchProvider, type NormalizedHit, type ProviderSearchRequest } from "../../src/server/providers/types.js";
import { createDatabase } from "../../src/server/database.js";
import { SearchRepository } from "../../src/server/repositories/search.js";
import { AssetService } from "../../src/server/services/asset-service.js";
import { makePng, publicOnlyResolver } from "../helpers/assets.js";
import { createSpeakerJob, createTestApp, makeBilingualProfiles, waitForJob } from "../helpers/server.js";

it("uses a signed image URL only in memory while persisting and returning its unsigned public identity", async () => {
  const publicUrl = "https://images.example.test/tiktok-ad.jpg";
  const transientImageUrl = `${publicUrl}?x-expires=1999999999&x-signature=resource-secret`;
  const provider: ImageSearchProvider = {
    id: "tiktok_ads",
    displayName: "TikTok fixture",
    rightsPolicy: "discovery_only",
    credentialMode: "approval",
    credentialVariables: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    sourceCategory: "ad_library",
    freeTier: "fixture",
    docsUrl: "https://developers.tiktok.com/products/commercial-content-api",
    defaultSelected: false,
    configured: true,
    maxResults: 10,
    supportsPagination: false,
    async search() {
      return [{
        provider: "tiktok_ads",
        rank: 1,
        imageUrl: publicUrl,
        transientImageUrl,
        thumbnailUrl: publicUrl,
        landingPageUrl: null,
        title: "TikTok speaker ad",
        creator: "Acme",
        licenseName: null,
        licenseUrl: null,
        width: null,
        height: null,
        sourceProvider: "TikTok",
        source: "ad-1",
        rightsStatus: "unknown"
      } as NormalizedHit];
    }
  };
  const requestedUrls: string[] = [];
  const bytes = await makePng({ width: 800, height: 800 });
  const app = await createTestApp({
    providers: [provider],
    assetServiceOptions: {
      resolver: publicOnlyResolver,
      fetch: async (input) => { requestedUrls.push(String(input)); return new Response(bytes, { headers: { "content-type": "image/png" } }); }
    }
  });
  try {
    const job = await createSpeakerJob(app);
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["tiktok_ads"] } })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    let body = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` });
      body = response.body;
      if (response.json().items[0]?.pipelineState === "processed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(requestedUrls).toEqual([transientImageUrl]);
    expect(JSON.parse(body).items[0]).toMatchObject({ imageUrl: publicUrl, pipelineState: "processed" });
    expect(body).not.toContain("resource-secret");
    const stored = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database
      .prepare("SELECT image_url FROM candidates").get() as { image_url: string };
    expect(stored.image_url).toBe(publicUrl);
  } finally {
    await app.close();
  }
});

async function withTransientService(
  test: (service: AssetService, searches: SearchRepository, database: ReturnType<typeof createDatabase>) => Promise<void>,
  options: { now?: () => number; fetch?: typeof fetch } = {}
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "transient-download-test-"));
  const database = createDatabase(dataDir);
  const searches = new SearchRepository(database);
  const bytes = await makePng({ width: 800, height: 800 });
  const service = new AssetService({
    database,
    searches,
    dataDir,
    resolver: publicOnlyResolver,
    fetch: options.fetch ?? (async () => new Response(bytes, { headers: { "content-type": "image/png" } })),
    now: options.now,
    downloadRetryAttempts: 3
  });
  database.prepare("INSERT INTO jobs VALUES ('job-one', 'one', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now'), ('job-two', 'two', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
  try { await test(service, searches, database); }
  finally { database.close(); await rm(dataDir, { recursive: true, force: true }); }
}

it("reuses one in-memory signed URL for concurrent candidates sharing a public identity", async () => {
  const publicUrl = "https://images.example.test/shared.jpg";
  const signedUrl = `${publicUrl}?x-expires=1999999999&x-signature=shared-secret`;
  const requested: string[] = [];
  const bytes = await makePng({ width: 800, height: 800 });
  await withTransientService(async (service, _searches, database) => {
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('one', 'job-one', ?, 'tiktok_ads', ?, 'discovered', 'unknown', 'now'), ('two', 'job-two', ?, 'tiktok_ads', ?, 'discovered', 'unknown', 'now')")
      .run(publicUrl, publicUrl, publicUrl, publicUrl);
    service.registerTransientDownloadUrl(publicUrl, signedUrl);
    await Promise.all([service.materializeCandidate("one"), service.materializeCandidate("two")]);
    expect(requested.sort()).toEqual([signedUrl, signedUrl]);
    expect(database.prepare("SELECT pipeline_state FROM candidates ORDER BY id").all()).toEqual([{ pipeline_state: "processed" }, { pipeline_state: "processed" }]);
  }, { fetch: async (input) => { requested.push(String(input)); return new Response(bytes, { headers: { "content-type": "image/png" } }); } });
});

it("retries a transient download without discarding its signed URL", async () => {
  const publicUrl = "https://images.example.test/retry.jpg";
  const signedUrl = `${publicUrl}?x-expires=1999999999&x-signature=retry-secret`;
  const requested: string[] = [];
  const bytes = await makePng({ width: 800, height: 800 });
  await withTransientService(async (service, _searches, database) => {
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('one', 'job-one', ?, 'tiktok_ads', ?, 'discovered', 'unknown', 'now')").run(publicUrl, publicUrl);
    service.registerTransientDownloadUrl(publicUrl, signedUrl);
    await service.materializeCandidate("one");
    expect(requested).toEqual([signedUrl, signedUrl]);
    expect(database.prepare("SELECT pipeline_state, pipeline_error FROM candidates WHERE id = 'one'").get()).toEqual({ pipeline_state: "processed", pipeline_error: null });
  }, { fetch: async (input) => {
    requested.push(String(input));
    if (requested.length === 1) return new Response("temporary", { status: 503 });
    return new Response(bytes, { headers: { "content-type": "image/png" } });
  } });
});

it("ignores signed URLs that are expired according to the provider", async () => {
  const now = Date.parse("2026-08-31T12:00:00Z");
  const publicUrl = "https://images.example.test/expired.jpg";
  const signedUrl = `${publicUrl}?x-expires=${Math.floor(now / 1_000) - 1}&x-signature=expired-secret`;
  const requested: string[] = [];
  await withTransientService(async (service, _searches, database) => {
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('one', 'job-one', ?, 'tiktok_ads', ?, 'discovered', 'unknown', 'now')").run(publicUrl, publicUrl);
    service.registerTransientDownloadUrl(publicUrl, signedUrl);
    await service.materializeCandidate("one");
    expect(requested).toEqual([publicUrl]);
  }, { now: () => now, fetch: async (input) => { requested.push(String(input)); return new Response(await makePng({ width: 800, height: 800 }), { headers: { "content-type": "image/png" } }); } });
});

it("retries an exhausted stable download directly without reopening completed discovery", async () => {
  const publicUrl = "https://images.example.test/stable-recover.jpg";
  let searches = 0;
  let downloadAvailable = false;
  const provider: ImageSearchProvider = {
    id: "fake",
    displayName: "Stable retry fixture",
    rightsPolicy: "open",
    configured: true,
    maxResults: 1,
    supportsPagination: false,
    async search() {
      searches += 1;
      return [{
        provider: "fake", rank: 1, imageUrl: publicUrl, thumbnailUrl: publicUrl,
        landingPageUrl: null, title: "Stable image", creator: null, licenseName: null, licenseUrl: null,
        width: null, height: null, sourceProvider: "fixture", source: "one", rightsStatus: "unknown"
      }];
    }
  };
  const requested: string[] = [];
  const bytes = await makePng({ width: 800, height: 800 });
  const app = await createTestApp({ providers: [provider], assetServiceOptions: {
    resolver: publicOnlyResolver,
    fetch: async (input) => {
      requested.push(String(input));
      return downloadAvailable
        ? new Response(bytes, { headers: { "content-type": "image/png" } })
        : new Response("temporary", { status: 503 });
    }
  } });
  const pipelineState = async (jobId: string): Promise<string | undefined> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const item = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}/candidates` })).json().items[0];
      if (item?.pipelineState === "processed" || item?.pipelineError === "RETRYABLE_DOWNLOAD") return item.pipelineState;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  };
  try {
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "稳定地址下载恢复",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商快销>3C及电器>影音电器>音箱"],
      labelSearchProfiles: makeBilingualProfiles(["电商快销>3C及电器>影音电器>音箱"]),
      targetCount: 1,
      candidateCount: 1
    } });
    const jobId = String(created.json().id);
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/jobs/${jobId}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await waitForJob(app, jobId, "reviewing");
    expect(await pipelineState(jobId)).toBe("discovered");
    const database = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database;
    database.prepare("UPDATE candidates SET pipeline_failure_code = NULL WHERE job_id = ?").run(jobId);

    const searchesBeforeRecovery = searches;
    downloadAvailable = true;
    expect((await app.inject({ method: "POST", url: `/api/jobs/${jobId}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await waitForJob(app, jobId, "reviewing");
    expect(await pipelineState(jobId)).toBe("processed");
    expect(searches).toBe(searchesBeforeRecovery + 8);
    expect(requested.at(-1)).toBe(publicUrl);
  } finally { await app.close(); }
});

  it("reopens the exact completed query when an explicit provider retry refreshes an exhausted signed download", async () => {
  const publicUrl = "https://images.example.test/recover.jpg";
  const signedUrls = [
    `${publicUrl}?x-expires=1999999999&x-signature=stale-secret`,
    `${publicUrl}?x-expires=1999999999&x-signature=fresh-secret`
  ];
  let searches = 0;
  const searchRequests: ProviderSearchRequest[] = [];
  let fresh = false;
  let providerUnavailable = false;
  const provider: ImageSearchProvider = {
    id: "tiktok_ads",
    displayName: "TikTok signed retry fixture",
    rightsPolicy: "discovery_only",
    credentialMode: "approval",
    credentialVariables: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    sourceCategory: "ad_library",
    freeTier: "fixture",
    docsUrl: "https://example.test/docs",
    defaultSelected: false,
    configured: true,
    maxResults: 1,
    supportsPagination: false,
    refreshDownloadUrlOnRetry: true,
    async search(request) {
      searches += 1;
      searchRequests.push({ ...request });
      if (providerUnavailable) throw new ProviderError("tiktok_ads", 503, true);
      const transientImageUrl = signedUrls[fresh ? 1 : 0]!;
      return [{
        provider: "tiktok_ads", rank: 1, imageUrl: publicUrl, transientImageUrl, thumbnailUrl: publicUrl,
        landingPageUrl: null, title: "Recoverable ad", creator: null, licenseName: null, licenseUrl: null,
        width: null, height: null, sourceProvider: "fixture", source: "one", rightsStatus: "unknown"
      }];
    }
  };
  const requested: string[] = [];
  const bytes = await makePng({ width: 800, height: 800 });
  const app = await createTestApp({ providers: [provider], searchRetry: { sleep: async () => undefined }, assetServiceOptions: {
    resolver: publicOnlyResolver,
    fetch: async (input) => {
      requested.push(String(input));
      return String(input).includes("fresh-secret")
        ? new Response(bytes, { headers: { "content-type": "image/png" } })
        : new Response("temporary", { status: 503 });
    }
  } });
  const pipelineState = async (jobId: string): Promise<string | undefined> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const item = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}/candidates` })).json().items[0];
      if (item?.pipelineState === "processed" || item?.pipelineError === "RETRYABLE_DOWNLOAD") return item.pipelineState;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  };
  try {
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "满额签名下载恢复",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商快销>3C及电器>影音电器>音箱"],
      labelSearchProfiles: makeBilingualProfiles(["电商快销>3C及电器>影音电器>音箱"]),
      targetCount: 1,
      candidateCount: 1
    } });
    expect(created.statusCode).toBe(201);
    const job = created.json();
    const jobId = String(job.id);
    expect((await app.inject({ method: "POST", url: `/api/jobs/${jobId}/search`, payload: { providerIds: ["tiktok_ads"] } })).statusCode).toBe(202);
    await waitForJob(app, jobId, "reviewing");
    expect(await pipelineState(jobId)).toBe("discovered");
    const originalRunIds = ((await app.inject({ method: "GET", url: `/api/jobs/${jobId}/candidates` })).json().providerRuns as Array<{ id: string }>).map((run) => run.id);

    const searchesBeforeRetry = searches;
    providerUnavailable = true;
    expect((await app.inject({ method: "POST", url: `/api/jobs/${jobId}/search`, payload: { providerIds: ["tiktok_ads"] } })).statusCode).toBe(202);
    await waitForJob(app, jobId, "reviewing");
    expect(await pipelineState(jobId)).toBe("discovered");
    expect(searches).toBeGreaterThan(searchesBeforeRetry);
    const retryableRunIds = ((await app.inject({ method: "GET", url: `/api/jobs/${jobId}/candidates` })).json().providerRuns as Array<{ id: string }>).map((run) => run.id);
    expect(retryableRunIds.slice(0, originalRunIds.length)).toEqual(originalRunIds);

    const searchesBeforeOrdinaryContinuation = searches;
    const ordinaryContinuation = await app.inject({
      method: "POST", url: `/api/jobs/${jobId}/search`, payload: { providerIds: ["tiktok_ads"] }
    });
    expect(ordinaryContinuation.statusCode).toBe(200);
    expect(ordinaryContinuation.json()).toEqual({ status: "exhausted" });
    expect(searches).toBe(searchesBeforeOrdinaryContinuation);

    const searchesBeforeRecovery = searches;
    providerUnavailable = false;
    fresh = true;
    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/search`,
      payload: { providerIds: ["tiktok_ads"], retryFailedProviderIds: ["tiktok_ads"] }
    })).statusCode).toBe(202);
    await waitForJob(app, jobId, "reviewing");
    expect(await pipelineState(jobId)).toBe("processed");
    expect(searches).toBe(searchesBeforeRecovery + 9);
    const recoveryRequests = searchRequests.slice(searchesBeforeRecovery);
    expect(recoveryRequests.filter((request) => request.query === searchRequests[0]!.query)).toEqual([searchRequests[0]]);
    expect(requested.at(-1)).toBe(signedUrls[1]);
    expect(requested.slice(0, -1).every((url) => url === signedUrls[0])).toBe(true);
    const candidates = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/candidates` });
    expect(candidates.body).not.toContain("fresh-secret");
    expect((candidates.json().providerRuns as Array<{ id: string }>).map((run) => run.id)).toEqual(retryableRunIds);
    const stored = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database
      .prepare("SELECT image_url FROM candidates WHERE job_id = ?").get(jobId) as { image_url: string };
    expect(stored.image_url).toBe(publicUrl);
  } finally { await app.close(); }
});
