import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/server/app.js";
import { loadConfig, prepareEnvironmentProxy, useEnvironmentProxy } from "../../src/server/config.js";
import { createFakeProvider } from "../../src/server/providers/fake.js";
import { OpenverseProvider } from "../../src/server/providers/openverse.js";
import { createSpeakerJob, createTestApp, waitForJob } from "../helpers/server.js";
import { fixtureFetch, recordingFixtureFetch } from "../helpers/providers.js";

describe("OpenverseProvider", () => {
  it("normalizes Openverse provenance and license data", async () => {
    const provider = new OpenverseProvider({ fetch: fixtureFetch("openverse.json") });
    const results = await provider.search({ query: "音箱 product ad", count: 20, locale: "zh-CN", safeSearch: true }, AbortSignal.timeout(1000));

    expect(results[0]).toMatchObject({
      provider: "openverse",
      imageUrl: "https://images.example.test/speaker.jpg?productId=42",
      thumbnailUrl: "https://images.example.test/speaker-thumb.jpg?width=320",
      landingPageUrl: "https://source.example.test/speaker?productId=42",
      licenseName: "cc0",
      rightsStatus: "provider_claimed"
    });
  });

  it("uses Openverse's documented image endpoint and safe query parameters", async () => {
    const calls: Request[] = [];
    const provider = new OpenverseProvider({ fetch: recordingFixtureFetch(calls) });
    await provider.search({ query: "speaker", count: 20, locale: "zh-CN", safeSearch: true }, AbortSignal.timeout(1000));

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.openverse.org/v1/images/");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: "speaker", page_size: "20", page: "1", mature: "false" });
  });

  it("splits a 40-result logical request into anonymous pages of at most 20 results", async () => {
    const calls: Request[] = [];
    const provider = new OpenverseProvider({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request.clone());
        const url = new URL(request.url);
        const page = Number(url.searchParams.get("page"));
        const pageSize = Number(url.searchParams.get("page_size"));
        return Response.json({
          results: Array.from({ length: pageSize }, (_, index) => ({
            url: `https://images.example.test/page-${page}-item-${index + 1}.jpg`
          }))
        });
      }
    });

    const results = await provider.search(
      { query: "speaker", count: 40, locale: "zh-CN", safeSearch: true, page: 1 },
      AbortSignal.timeout(1000)
    );

    expect(calls.map((call) => {
      const url = new URL(call.url);
      return { page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") };
    })).toEqual([
      { page: "1", pageSize: "20" },
      { page: "2", pageSize: "20" }
    ]);
    expect(results).toHaveLength(40);
    expect(results[0]).toMatchObject({ rank: 1, imageUrl: "https://images.example.test/page-1-item-1.jpg" });
    expect(results[39]).toMatchObject({ rank: 40, imageUrl: "https://images.example.test/page-2-item-20.jpg" });
  });

  it("uses the requested page and only includes sensitive results when safe search is relaxed", async () => {
    const calls: Request[] = [];
    const provider = new OpenverseProvider({ fetch: recordingFixtureFetch(calls) });
    await provider.search({ query: "speaker", count: 20, locale: "en-GB", safeSearch: false, page: 4 }, AbortSignal.timeout(1000));

    const url = new URL(calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ page: "4", mature: "true" });
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("rejects invalid or over-window Openverse pages without a network request", async () => {
    let calls = 0;
    const provider = new OpenverseProvider({ fetch: async () => { calls += 1; return Response.json({ results: [] }); } });
    expect(provider.canRequestPage?.(1, 20)).toBe(true);
    expect(provider.canRequestPage?.(20, 20)).toBe(true);
    expect(provider.canRequestPage?.(21, 20)).toBe(false);
    expect(provider.canRequestPage?.(0, 20)).toBe(false);
    await expect(provider.search({ query: "speaker", count: 20, locale: "en-US", safeSearch: true, page: 21 }, AbortSignal.timeout(1_000))).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it("ignores malformed Openverse result members and safely normalizes field types", async () => {
    const provider = new OpenverseProvider({ fetch: async () => Response.json({ results: [
      null,
      42,
      {},
      { url: "javascript:alert(1)" },
      {
        url: "https://images.example.test/valid.jpg",
        thumbnail: 12,
        title: { secret: "not public text" },
        creator: "Creator",
        license: 99,
        width: "1200",
        height: "not-a-number",
        provider: "wikimedia",
        source: ["bad"]
      }
    ] }) });
    await expect(provider.search({ query: "speaker", count: 20, locale: "en-US", safeSearch: true }, AbortSignal.timeout(1_000))).resolves.toEqual([
      expect.objectContaining({
        imageUrl: "https://images.example.test/valid.jpg",
        thumbnailUrl: null,
        title: null,
        creator: "Creator",
        licenseName: null,
        width: 1200,
        height: null,
        sourceProvider: "wikimedia",
        source: null
      })
    ]);
  });

  it("releases a non-success response body before reporting the provider failure", async () => {
    let cancelled = 0;
    const provider = new OpenverseProvider({
      fetch: async () => new Response(new ReadableStream({ cancel() { cancelled += 1; } }), { status: 503 })
    });
    await expect(provider.search({ query: "speaker", count: 20, locale: "en-GB", safeSearch: true }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ status: 503, retryable: true });
    expect(cancelled).toBe(1);
  });

  it("preserves a real timeout for the bounded retry policy", async () => {
    const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const provider = new OpenverseProvider({ fetch: async () => { throw timeout; } });
    await expect(provider.search({ query: "speaker", count: 20, locale: "zh-CN", safeSearch: true }, AbortSignal.timeout(1000))).rejects.toBe(timeout);
  });
});

describe("provider status route", () => {
  it("returns complete safe provider metadata without configuration values", async () => {
    const app = await createTestApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers" });
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toContainEqual(expect.objectContaining({
        id: "openverse",
        enabled: true,
        configured: false,
        credentialMode: "none",
        credentialVariables: [],
        sourceCategory: "general",
        freeTier: "匿名公开 API",
        docsUrl: "https://docs.openverse.org/api/guides/",
        defaultSelected: true
      }));
    } finally {
      await app.close();
    }
  });

  it("stays explicitly anonymous even when obsolete Openverse variables are present", async () => {
    const app = await createTestApp({ env: { OPENVERSE_CLIENT_ID: "server-only-id", OPENVERSE_CLIENT_SECRET: "server-only-secret" } });
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers" });
      expect(response.json().items).toContainEqual(expect.objectContaining({ id: "openverse", configured: false, enabled: true, credentialVariables: [] }));
      expect(response.body).not.toContain("server-only-secret");
    } finally {
      await app.close();
    }
  });

  it("keeps paid legacy adapters out of the default free registry even when their secrets exist", async () => {
    const app = await createTestApp({ env: {
      BRAVE_SEARCH_API_KEY: "brave-secret",
      DATAFORSEO_LOGIN: "dataforseo-user",
      DATAFORSEO_PASSWORD: "dataforseo-secret"
    } });
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers" });
      const ids = response.json().items.map((provider: { id: string }) => provider.id);
      expect(ids).not.toContain("brave");
      expect(ids).not.toContain("dataforseo");
      expect(response.body).not.toMatch(/brave-secret|dataforseo-(user|secret)/);
    } finally {
      await app.close();
    }
  });

  it("serializes metadata supplied by a custom fake provider without a credential map", async () => {
    const provider = createFakeProvider("fake", []);
    const app = await createTestApp({ providers: [provider] });
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers" });
      expect(response.json().items).toEqual([expect.objectContaining({
        id: "fake",
        enabled: true,
        credentialMode: "none",
        credentialVariables: [],
        sourceCategory: "general",
        defaultSelected: false
      })]);
    } finally {
      await app.close();
    }
  });
});

describe("provider credential configuration", () => {
  it.each([
    ["contact URL", "  TrainingDataCollector/2.0 (https://collector.example.test/contact)  ", "TrainingDataCollector/2.0 (https://collector.example.test/contact)"],
    ["contact email", "TrainingDataCollector/2.0 (maintainer@example.test)", "TrainingDataCollector/2.0 (maintainer@example.test)"],
    ["Wikimedia user", "TrainingDataCollector/2.0 (Commons; User:Example Maintainer)", "TrainingDataCollector/2.0 (Commons; User:Example Maintainer)"]
  ])("accepts and trims a Wikimedia User-Agent with %s", (_case, userAgent, expected) => {
    expect(loadConfig({ WIKIMEDIA_USER_AGENT: userAgent }).wikimediaUserAgent).toBe(expected);
  });

  it.each([
    ["missing value", undefined],
    ["empty value", "  "],
    ["header injection", "TrainingDataCollector/2.0\r\nX-Injected: true"],
    ["control character", "TrainingDataCollector/2.0\u007f maintainer@example.test"],
    ["contact-free value", "TrainingDataCollector/2.0 (local image collection tool)"],
    ["malformed URL", "TrainingDataCollector/2.0 (https://example)"],
    ["blank Wikimedia project", "TrainingDataCollector/2.0 (   ; User:Maintainer)"],
    ["blank Wikimedia user", "TrainingDataCollector/2.0 (Commons; User: )"],
    ["loopback URL", "TrainingDataCollector/2.0 (http://127.0.0.1/contact)"],
    ["overlong value", `TrainingDataCollector/2.0 (maintainer@example.test)${"x".repeat(257)}`]
  ])("keeps Wikimedia unconfigured without failing application config for %s", (_case, userAgent) => {
    expect(() => loadConfig({ WIKIMEDIA_USER_AGENT: userAgent })).not.toThrow();
    expect(loadConfig({ WIKIMEDIA_USER_AGENT: userAgent }).wikimediaUserAgent).toBeUndefined();
  });

  it("disables only Wikimedia and exposes its non-key configuration requirement when User-Agent is missing", async () => {
    const app = await createTestApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers" });
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toContainEqual(expect.objectContaining({
        id: "wikimedia",
        configured: false,
        enabled: false,
        credentialMode: "none",
        credentialVariables: ["WIKIMEDIA_USER_AGENT"],
        freeTier: expect.stringMatching(/WIKIMEDIA_USER_AGENT.*URL.*邮箱.*User:/u)
      }));
      expect(response.json().items).toContainEqual(expect.objectContaining({
        id: "openverse",
        configured: false,
        enabled: true,
        credentialMode: "none"
      }));
    } finally {
      await app.close();
    }
  });

  it("injects the configured Wikimedia User-Agent through the app registry", async () => {
    const calls: Request[] = [];
    const userAgent = "TrainingDataCollector/2.0 (https://owner.example.test/contact)";
    const app = await createApp({
      dataDir: ":memory:",
      env: { WIKIMEDIA_USER_AGENT: userAgent },
      providerFetch: recordingFixtureFetch(calls, "wikimedia.json"),
      assetService: false
    });
    try {
      const job = await createSpeakerJob(app);
      expect((await app.inject({
        method: "POST",
        url: `/api/jobs/${String(job.id)}/search`,
        payload: { providerIds: ["wikimedia"] }
      })).statusCode).toBe(202);
      await waitForJob(app, String(job.id), "reviewing");

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.headers.get("user-agent") === userAgent)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("enables proxy-aware downloads only for an explicit NODE_USE_ENV_PROXY=1", () => {
    expect(useEnvironmentProxy({ NODE_USE_ENV_PROXY: "1" })).toBe(true);
    expect(useEnvironmentProxy({ NODE_USE_ENV_PROXY: " 1 " })).toBe(true);
    expect(useEnvironmentProxy({ NODE_USE_ENV_PROXY: "0" })).toBe(false);
    expect(useEnvironmentProxy({})).toBe(false);
  });

  it("requires complete loopback settings and clears NO_PROXY before constructing the proxy fetch", async () => {
    expect(() => prepareEnvironmentProxy({ NODE_USE_ENV_PROXY: "1" })).toThrow(/HTTP_PROXY.*HTTPS_PROXY/u);
    expect(() => prepareEnvironmentProxy({
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: "http://proxy.example.test:8080",
      HTTPS_PROXY: "http://proxy.example.test:8080"
    })).toThrow(/本机代理/u);
    expect(() => prepareEnvironmentProxy({
      NODE_USE_ENV_PROXY: "1",
      http_proxy: "http://proxy.example.test:8080",
      https_proxy: "http://proxy.example.test:8080",
      HTTP_PROXY: "http://127.0.0.1:58183",
      HTTPS_PROXY: "http://127.0.0.1:58183"
    })).toThrow(/本机代理/u);

    const env: NodeJS.ProcessEnv = {
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: "http://127.0.0.1:58183",
      HTTPS_PROXY: "http://127.0.0.1:58183",
      NO_PROXY: "*",
      no_proxy: ".example.test"
    };
    const prepared = prepareEnvironmentProxy(env);
    expect(prepared?.fetch).toEqual(expect.any(Function));
    expect(prepared?.fetch).not.toBe(globalThis.fetch);
    expect(env.NO_PROXY).toBe("");
    expect(env.no_proxy).toBe("");
    expect(env.http_proxy).toBe(env.HTTP_PROXY);
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
    await prepared?.close();
  });

  it("binds both HTTP and HTTPS requests to the newly validated proxy dispatcher", async () => {
    const httpRequests: string[] = [];
    const tunnels: string[] = [];
    const proxy = createServer((request, response) => {
      httpRequests.push(request.url ?? "");
      response.end("proxied");
    });
    proxy.on("connect", (request, socket) => {
      tunnels.push(request.url ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const port = (proxy.address() as AddressInfo).port;
    const prepared = prepareEnvironmentProxy({
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
      NO_PROXY: "*"
    })!;
    try {
      await expect(prepared.fetch("http://public.example/image.jpg", { redirect: "manual" }).then((response) => response.text())).resolves.toBe("proxied");
      await expect(prepared.fetch("https://public.example/image.jpg", { redirect: "manual" })).rejects.toThrow();
      expect(httpRequests).toEqual(["http://public.example/image.jpg"]);
      expect(tunnels).toEqual(["public.example:443"]);
    } finally {
      await prepared.close();
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("maps every free-key and approval credential from trimmed environment values", () => {
    const config = loadConfig({
      EUROPEANA_API_KEY: " europeana ",
      PEXELS_API_KEY: " pexels ",
      PIXABAY_API_KEY: " pixabay ",
      UNSPLASH_ACCESS_KEY: " unsplash ",
      FLICKR_API_KEY: " flickr ",
      HARVARD_ART_MUSEUMS_API_KEY: " harvard ",
      DPLA_API_KEY: " dpla ",
      SMITHSONIAN_API_KEY: " smithsonian ",
      TIKTOK_CLIENT_KEY: " tiktok-key ",
      TIKTOK_CLIENT_SECRET: " tiktok-secret "
    });

    expect(config.credentials).toMatchObject({
      europeanaApiKey: "europeana",
      pexelsApiKey: "pexels",
      pixabayApiKey: "pixabay",
      unsplashAccessKey: "unsplash",
      flickrApiKey: "flickr",
      harvardArtMuseumsApiKey: "harvard",
      dplaApiKey: "dpla",
      smithsonianApiKey: "smithsonian",
      tiktokClientKey: "tiktok-key",
      tiktokClientSecret: "tiktok-secret"
    });
  });
});
