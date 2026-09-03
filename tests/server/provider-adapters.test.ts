import { describe, expect, it } from "vitest";
import { BaiduProvider, truncateBaiduQuery } from "../../src/server/providers/baidu.js";
import { BraveProvider } from "../../src/server/providers/brave.js";
import { DataForSeoProvider } from "../../src/server/providers/dataforseo.js";
import { SerpApiProvider } from "../../src/server/providers/serpapi.js";
import { localeOptions, requestJson, safeHttpUrl } from "../../src/server/providers/common.js";
import { OpenverseProvider } from "../../src/server/providers/openverse.js";
import { ProviderError } from "../../src/server/providers/types.js";
import { createSpeakerJob, createTestApp, waitForJob } from "../helpers/server.js";
import { fixtureFetch, recordingFixtureFetch } from "../helpers/providers.js";

const searchRequest = { query: "speaker commercial poster", count: 400, locale: "zh-CN", safeSearch: true };

const adapterCases = [
  ["brave", (fetch: typeof globalThis.fetch) => new BraveProvider({ apiKey: "test-secret", fetch }), "https://api.search.brave.com/res/v1/images/search", "brave.json"],
  ["baidu", (fetch: typeof globalThis.fetch) => new BaiduProvider({ apiKey: "test-secret", fetch }), "https://qianfan.baidubce.com/v2/ai_search/web_search", "baidu.json"],
  ["serpapi", (fetch: typeof globalThis.fetch) => new SerpApiProvider({ apiKey: "test-secret", fetch }), "https://serpapi.com/search.json", "serpapi.json"],
  ["dataforseo", (fetch: typeof globalThis.fetch) => new DataForSeoProvider({ login: "test-user", password: "test-secret", fetch }), "https://api.dataforseo.com/v3/serp/google/images/live/advanced", "dataforseo.json"]
] as const;

describe("documented image search adapters", () => {
  it.each([
    ["brave", () => new BraveProvider(), "required", ["BRAVE_SEARCH_API_KEY"], "general", false],
    ["baidu", () => new BaiduProvider(), "required", ["BAIDU_QIANFAN_API_KEY"], "general", false],
    ["serpapi", () => new SerpApiProvider(), "required", ["SERPAPI_API_KEY"], "general", false],
    ["dataforseo", () => new DataForSeoProvider(), "required", ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"], "general", false]
  ] as const)("declares complete safe catalog metadata for %s", (_id, factory, credentialMode, credentialVariables, sourceCategory, defaultSelected) => {
    const provider = factory();
    expect(provider).toMatchObject({ credentialMode, credentialVariables, sourceCategory, defaultSelected });
    expect(provider.freeTier).toEqual(expect.any(String));
    expect(provider.docsUrl).toMatch(/^https:\/\//u);
  });

  it.each(adapterCases)("normalizes %s results without leaking credentials", async (_id, factory, endpoint, fixture) => {
    const calls: Request[] = [];
    const provider = factory(recordingFixtureFetch(calls, fixture));
    const hits = await provider.search(searchRequest, AbortSignal.timeout(1000));

    expect(calls[0]!.url.startsWith(endpoint)).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ imageUrl: expect.stringMatching(/^https:/), landingPageUrl: expect.stringMatching(/^https:/) });
    expect(JSON.stringify(hits)).not.toMatch(/test-secret|test-user|fixture-secret|password|api[_-]?key/i);
  });

  it("sends Brave's capped documented query and token header", async () => {
    const calls: Request[] = [];
    await new BraveProvider({ apiKey: "test-secret", fetch: recordingFixtureFetch(calls, "brave.json") }).search(searchRequest, AbortSignal.timeout(1000));
    const call = calls[0]!;
    const url = new URL(call.url);
    expect(call.method).toBe("GET");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: searchRequest.query, count: "200", country: "CN", search_lang: "zh", safesearch: "strict" });
    expect(call.headers.get("x-subscription-token")).toBe("test-secret");
  });

  it("sends Baidu's exact image-search body and does not split astral code points", async () => {
    const calls: Request[] = [];
    await new BaiduProvider({ apiKey: "test-secret", fetch: recordingFixtureFetch(calls, "baidu.json") }).search(searchRequest, AbortSignal.timeout(1000));
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers.get("x-appbuilder-authorization")).toBe("Bearer test-secret");
    expect(call.headers.get("authorization")).toBeNull();
    await expect(call.json()).resolves.toEqual({
      messages: [{ role: "user", content: searchRequest.query }],
      search_source: "baidu_search_v2",
      resource_type_filter: [{ type: "image", top_k: 30 }],
      safe_search: true
    });
    expect(truncateBaiduQuery(`${"a".repeat(70)}😀x`)).toBe(`${"a".repeat(70)}😀`);
    expect(truncateBaiduQuery(`${"a".repeat(71)}😀`)).toBe("a".repeat(71));
  });

  it("normalizes Qianfan's documented nested image object and string dimensions", async () => {
    const [hit] = await new BaiduProvider({ apiKey: "test-secret", fetch: fixtureFetch("baidu.json") }).search(searchRequest, AbortSignal.timeout(1000));
    expect(hit).toMatchObject({
      imageUrl: "https://images.example.test/baidu-speaker.jpg?x-bce-process=image%2Fresize%2Cw_1080",
      thumbnailUrl: "https://images.example.test/baidu-speaker-thumb.jpg?x-oss-process=image%2Fresize%2Cw_320",
      landingPageUrl: "https://source.example.test/baidu-speaker",
      title: "Baidu speaker campaign", width: 1080, height: 1080,
      sourceProvider: "baidu_search_v2", source: "source.example.test"
    });
  });

  it("uses SerpApi's image parameters without exposing its credential in normalized hits", async () => {
    const calls: Request[] = [];
    await new SerpApiProvider({ apiKey: "test-secret", fetch: recordingFixtureFetch(calls, "serpapi.json") }).search(searchRequest, AbortSignal.timeout(1000));
    const url = new URL(calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ engine: "google_images", q: searchRequest.query, api_key: "test-secret", hl: "zh", gl: "cn", safe: "active" });
  });

  it("passes a stable one-based page to SerpApi's zero-based image page", async () => {
    const calls: Request[] = [];
    await new SerpApiProvider({ apiKey: "test-secret", fetch: recordingFixtureFetch(calls, "serpapi.json") })
      .search({ ...searchRequest, count: 20, page: 3 }, AbortSignal.timeout(1000));
    expect(new URL(calls[0]!.url).searchParams.get("ijn")).toBe("2");
  });

  it("allows only SerpApi pages 1 through 100 and refuses an out-of-window network request", async () => {
    const calls: Request[] = [];
    const provider = new SerpApiProvider({ apiKey: "test-secret", fetch: recordingFixtureFetch(calls, "serpapi.json") });

    expect(provider.canRequestPage?.(1, 20)).toBe(true);
    expect(provider.canRequestPage?.(100, 20)).toBe(true);
    expect(provider.canRequestPage?.(101, 20)).toBe(false);
    await expect(provider.search({ ...searchRequest, count: 20, page: 100 }, AbortSignal.timeout(1000))).resolves.toHaveLength(1);
    await expect(provider.search({ ...searchRequest, count: 20, page: 101 }, AbortSignal.timeout(1000))).resolves.toEqual([]);

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("ijn")).toBe("99");
  });

  it("does not create page 101 for an exhausted SerpApi combination while untried combinations proceed", async () => {
    let calls = 0;
    const provider = new SerpApiProvider({
      apiKey: "test-secret",
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ images_results: [] }), { headers: { "content-type": "application/json" } });
      }
    });
    const app = await createTestApp({ providers: [provider] });
    try {
      const job = await createSpeakerJob(app);
      const jobId = String(job.id);
      const labelId = String((job.labels as Array<{ id: string }>)[0]!.id);
      const database = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database;
      database.prepare(`
        INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, request_count, status, created_at)
        VALUES ('serpapi-page-100', ?, ?, 'serpapi', 'exact_ad', '音箱 电商海报', 100, 20, 'completed', 'now')
      `).run(jobId, labelId);

      const continuation = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/search`, payload: { providerIds: ["serpapi"] } });
      expect(continuation.statusCode).toBe(202);
      await waitForJob(app, jobId, "reviewing");

      const runs = database.prepare("SELECT id, query_text, page FROM query_runs WHERE job_id = ? AND provider_id = 'serpapi' ORDER BY rowid").all(jobId) as Array<{
        id: string;
        query_text: string;
        page: number;
      }>;
      expect(runs.filter((run) => run.query_text === "音箱 电商海报")).toEqual([
        { id: "serpapi-page-100", query_text: "音箱 电商海报", page: 100 }
      ]);
      expect(runs.some((run) => run.page === 101)).toBe(false);
      expect(runs.filter((run) => run.id !== "serpapi-page-100").every((run) => run.page === 1)).toBe(true);
      expect(calls).toBe(4);
    } finally {
      await app.close();
    }
  });

  it("sends one capped DataForSEO task with Basic authentication", async () => {
    const calls: Request[] = [];
    await new DataForSeoProvider({ login: "test-user", password: "test-secret", fetch: recordingFixtureFetch(calls, "dataforseo.json") }).search(searchRequest, AbortSignal.timeout(1000));
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe(`Basic ${Buffer.from("test-user:test-secret").toString("base64")}`);
    await expect(call.json()).resolves.toEqual([{
      keyword: searchRequest.query,
      language_code: "zh",
      location_name: "China",
      depth: 200,
      search_param: "&safe=active"
    }]);
  });

  it("applies DataForSEO country, safe-search, and cumulative pagination without a US fallback", async () => {
    const safeCalls: Request[] = [];
    await new DataForSeoProvider({ login: "test-user", password: "test-secret", fetch: recordingFixtureFetch(safeCalls, "dataforseo.json") })
      .search({ query: "affiche publicitaire", count: 25, locale: "fr-FR", safeSearch: true, page: 2 }, AbortSignal.timeout(1000));
    await expect(safeCalls[0]!.json()).resolves.toEqual([{
      keyword: "affiche publicitaire",
      language_code: "fr",
      location_name: "France",
      depth: 50,
      search_param: "&safe=active"
    }]);

    const relaxedCalls: Request[] = [];
    await new DataForSeoProvider({ login: "test-user", password: "test-secret", fetch: recordingFixtureFetch(relaxedCalls, "dataforseo.json") })
      .search({ query: "affiche publicitaire", count: 25, locale: "fr-FR", safeSearch: false }, AbortSignal.timeout(1000));
    await expect(relaxedCalls[0]!.json()).resolves.toEqual([expect.objectContaining({
      location_name: "France",
      search_param: "&safe=off"
    })]);
    expect(localeOptions("ja-JP")).toMatchObject({ language: "ja", country: "JP", locationName: "Japan" });
    expect(localeOptions("ja-JP")).not.toHaveProperty("locationCode", 2840);
  });

  it("stops DataForSEO pagination before its cumulative depth would be empty", () => {
    const provider = new DataForSeoProvider({ login: "test-user", password: "test-secret" });
    const canRequestPage = (provider as unknown as { canRequestPage?: (page: number, count: number) => boolean }).canRequestPage;
    expect(canRequestPage?.(1, 200)).toBe(true);
    expect(canRequestPage?.(2, 200)).toBe(false);
    expect(canRequestPage?.(8, 25)).toBe(true);
    expect(canRequestPage?.(9, 25)).toBe(false);
  });

  it("does not issue a DataForSEO network request outside its cumulative pagination window", async () => {
    let calls = 0;
    const provider = new DataForSeoProvider({
      login: "test-user", password: "test-secret",
      fetch: async () => { calls += 1; return new Response(JSON.stringify({ tasks: [] }), { headers: { "content-type": "application/json" } }); }
    });

    await expect(provider.search({ ...searchRequest, count: 200, page: 2 }, AbortSignal.timeout(1000))).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it("normalizes DataForSEO's official images_search item without using an HTML landing URL as the image", async () => {
    const hits = await new DataForSeoProvider({ login: "test-user", password: "test-secret", fetch: fixtureFetch("dataforseo.json") }).search(searchRequest, AbortSignal.timeout(1000));
    expect(hits).toHaveLength(1);
    expect(hits).toEqual([expect.objectContaining({
      imageUrl: "https://images.example.test/dataforseo-speaker.jpg",
      thumbnailUrl: "https://images.example.test/dataforseo-speaker-thumb.jpg",
      landingPageUrl: "https://hosting.example.test/dataforseo-speaker-page",
      title: "DataForSEO speaker poster", width: 1280, height: 720,
      sourceProvider: "hosting.example.test", source: "https://images.example.test/dataforseo-speaker.jpg"
    })]);
    expect(hits[0]!.imageUrl).not.toContain("dataforseo-speaker-page");
  });

  it.each([
    ["baidu", () => new BaiduProvider({ apiKey: "test-secret", fetch: fixtureFetch("baidu-error.json") }), null, false],
    ["serpapi", () => new SerpApiProvider({ apiKey: "test-secret", fetch: fixtureFetch("serpapi-error.json") }), null, false],
    ["dataforseo", () => new DataForSeoProvider({ login: "test-user", password: "test-secret", fetch: fixtureFetch("dataforseo-error.json") }), 401, false]
  ] as const)("treats HTTP-200 %s error envelopes as safe typed failures", async (_id, factory, status, retryable) => {
    await expect(factory().search(searchRequest, AbortSignal.timeout(1000))).rejects.toMatchObject({
      name: ProviderError.name, status, retryable
    });
    await factory().search(searchRequest, AbortSignal.timeout(1000)).catch((error: unknown) => {
      expect(String(error)).not.toMatch(/test-secret|api[_-]?key|password/i);
    });
  });

  it("preserves retryability only for HTTP-like Qianfan provider codes", async () => {
    await expect(new BaiduProvider({ apiKey: "test-secret", fetch: fixtureFetch("baidu-http-error.json") }).search(searchRequest, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ name: ProviderError.name, status: 429, retryable: true });
  });

  it.each([
    ["baidu", () => new BaiduProvider({ apiKey: "test-secret", fetch: fixtureFetch("baidu-error.json") })],
    ["serpapi", () => new SerpApiProvider({ apiKey: "test-secret", fetch: fixtureFetch("serpapi-error.json") })],
    ["dataforseo", () => new DataForSeoProvider({ login: "test-user", password: "test-secret", fetch: fixtureFetch("dataforseo-error.json") })]
  ] as const)("records HTTP-200 %s error envelopes as failed search runs instead of empty successes", async (id, factory) => {
    const app = await createTestApp({ providers: [factory()] });
    try {
      const job = await createSpeakerJob(app);
      expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: [id] } })).statusCode).toBe(202);
      await waitForJob(app, String(job.id), "reviewing");
      const { providerRuns } = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json();
      expect(providerRuns).not.toHaveLength(0);
      expect(providerRuns.every((run: { status: string; hitCount: number }) => run.status === "failed" && run.hitCount === 0)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects credential-bearing URL userinfo and removes exact sensitive parameters and fragments from safe URLs", () => {
    expect(safeHttpUrl("https://user:secret@example.test/image.jpg?token=query-secret#fragment-secret")).toBeNull();
    expect(safeHttpUrl("https://images.example.test/image.jpg?X-Amz-Signature=signed-secret&width=1200#fragment-secret"))
      .toBe("https://images.example.test/image.jpg?width=1200");
    expect(safeHttpUrl("https://images.example.test/image.jpg?monkey=keep&keyboard=keep&api_key=secret&X-Goog-Credential=signed-secret"))
      .toBe("https://images.example.test/image.jpg?monkey=keep&keyboard=keep");
  });

  it("does not retain raw authentication material in any normalized URL field", async () => {
    const hits = await new SerpApiProvider({ apiKey: "test-secret", fetch: fixtureFetch("serpapi.json") }).search(searchRequest, AbortSignal.timeout(1000));
    for (const hit of hits) {
      for (const url of [hit.imageUrl, hit.thumbnailUrl, hit.landingPageUrl, hit.licenseUrl]) {
        expect(url ?? "").not.toMatch(/fixture-secret|test-secret|token|signature|fragment|@/i);
      }
    }
  });

  it("lists the free default providers with metadata when credentials are blank and never returns secrets", async () => {
    const app = await createTestApp({ env: {
      OPENVERSE_CLIENT_ID: "  ", OPENVERSE_CLIENT_SECRET: "  ", BAIDU_QIANFAN_API_KEY: " ", BRAVE_SEARCH_API_KEY: " ",
      SERPAPI_API_KEY: " ", DATAFORSEO_LOGIN: " ", DATAFORSEO_PASSWORD: " "
    } });
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers" });
      expect(response.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "openverse", configured: false, enabled: true, rightsPolicy: "open", credentialMode: "none", credentialVariables: [] }),
        expect.objectContaining({ id: "baidu", configured: false, enabled: false, rightsPolicy: "discovery_only", credentialMode: "required", credentialVariables: ["BAIDU_QIANFAN_API_KEY"] }),
        expect.objectContaining({ id: "serpapi", configured: false, enabled: false, rightsPolicy: "discovery_only", credentialMode: "required", credentialVariables: ["SERPAPI_API_KEY"] })
      ]));
      expect(response.json().items.map((provider: { id: string }) => provider.id)).not.toEqual(expect.arrayContaining(["brave", "dataforseo"]));
      expect(response.body).not.toContain("test-secret");
    } finally {
      await app.close();
    }
  });

  it("enables configured free adapters while keeping paid legacy adapters and all credentials out of the status response", async () => {
    const app = await createTestApp({ env: {
      OPENVERSE_CLIENT_ID: "openverse-id", OPENVERSE_CLIENT_SECRET: "openverse-secret", BAIDU_QIANFAN_API_KEY: "baidu-secret",
      BRAVE_SEARCH_API_KEY: "brave-secret", SERPAPI_API_KEY: "serpapi-secret", DATAFORSEO_LOGIN: "dataforseo-user", DATAFORSEO_PASSWORD: "dataforseo-secret"
    } });
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers" });
      expect(response.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "openverse", configured: false, enabled: true, credentialVariables: [] }),
        expect.objectContaining({ id: "baidu", configured: true, enabled: true }),
        expect.objectContaining({ id: "serpapi", configured: true, enabled: true })
      ]));
      expect(response.json().items.map((provider: { id: string }) => provider.id)).not.toEqual(expect.arrayContaining(["brave", "dataforseo"]));
      expect(response.body).not.toMatch(/openverse-(id|secret)|baidu-secret|brave-secret|serpapi-secret|dataforseo-(user|secret)/);
    } finally {
      await app.close();
    }
  });

  it.each(adapterCases)("returns a typed, credential-safe retryable error for %s server failures", async (_id, factory) => {
    const provider = factory(async () => new Response("{}", { status: 503 }));
    await expect(provider.search(searchRequest, AbortSignal.timeout(1000))).rejects.toMatchObject({
      name: ProviderError.name, status: 503, retryable: true
    });
    await provider.search(searchRequest, AbortSignal.timeout(1000)).catch((error: unknown) => {
      expect(String(error)).not.toMatch(/test-secret|test-user|authorization|password|api[_-]?key/i);
    });
  });

  it.each(adapterCases)("releases a failed %s response body before surfacing a retryable error", async (_id, factory) => {
    let cancelled = 0;
    const provider = factory(async () => new Response(new ReadableStream({ cancel() { cancelled += 1; } }), { status: 503 }));
    await expect(provider.search(searchRequest, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 503, retryable: true });
    expect(cancelled).toBe(1);
  });

  it.each(adapterCases)("preserves a real %s timeout for the bounded retry policy", async (_id, factory) => {
    const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const provider = factory(async () => { throw timeout; });
    await expect(provider.search(searchRequest, AbortSignal.timeout(1000))).rejects.toBe(timeout);
  });

  it("classifies proxy, DNS, and connection-reset fetch failures as retryable without leaking details", async () => {
    const networkFailure = new TypeError("fetch failed: proxy user:secret@127.0.0.1");
    await expect(requestJson("fake", async () => { throw networkFailure; }, "https://api.example.test", { signal: AbortSignal.timeout(1_000) }))
      .rejects.toMatchObject({ name: ProviderError.name, status: null, retryable: true, message: expect.not.stringContaining("secret") });
    await expect(new OpenverseProvider({ fetch: async () => { throw networkFailure; } }).search(searchRequest, AbortSignal.timeout(1_000)))
      .rejects.toMatchObject({ name: ProviderError.name, status: null, retryable: true, message: expect.not.stringContaining("secret") });
  });

  it("preserves a timeout that fires while a response body is being read", async () => {
    const signal = AbortSignal.timeout(10);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(Object.assign(new Error("body aborted"), { name: "AbortError" })), { once: true });
      }
    });
    const fetch = async () => new Response(stream, { headers: { "content-type": "application/json" } });

    await expect(requestJson("fake", fetch, "https://api.example.test", { signal })).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
