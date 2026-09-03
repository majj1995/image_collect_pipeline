import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, makeTempDataDir } from "../helpers/server.js";

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const defaults = {
  defaultLocale: "zh-CN",
  defaultCountry: "CN",
  safeSearch: true,
  cache: {
    downloadTimeoutMs: 20_000,
    maxBytes: 25_000_000,
    maxPixels: 100_000_000,
    minDimension: 128,
    supportedFormats: ["image/jpeg", "image/png", "image/webp"]
  },
  contractualRightsDeclarations: {}
} as const;

describe("local settings API", () => {
  it("returns strict safe defaults and persists one atomic settings document", async () => {
    const dataDir = await makeTempDataDir();
    const first = await createTestApp({ dataDir }); apps.push(first);
    const initial = await first.inject({ method: "GET", url: "/api/settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual(defaults);

    const updated = {
      ...defaults,
      defaultLocale: "en-US",
      defaultCountry: "US",
      cache: { ...defaults.cache, downloadTimeoutMs: 10_000, maxBytes: 10_000_000, maxPixels: 50_000_000, minDimension: 256, supportedFormats: ["image/jpeg"] },
      contractualRightsDeclarations: { brave: true }
    };
    const saved = await first.inject({ method: "PUT", url: "/api/settings", payload: updated });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual(updated);
    await first.close(); apps.splice(apps.indexOf(first), 1);

    const second = await createTestApp({ dataDir }); apps.push(second);
    expect((await second.inject({ method: "GET", url: "/api/settings" })).json()).toEqual(updated);
  });

  it("rejects forbidden nested keys, unknown providers, unknown fields, and weaker safety limits without partial writes", async () => {
    const app = await createTestApp(); apps.push(app);
    const before = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    const invalidPayloads = [
      { ...before, cache: { ...before.cache, metadata: { oauthToken: "must-not-be-stored" } } },
      { ...before, contractualRightsDeclarations: { unknown_provider: true } },
      { ...before, extra: true },
      { ...before, cache: { ...before.cache, downloadTimeoutMs: 20_001 } },
      { ...before, cache: { ...before.cache, maxBytes: 25_000_001 } },
      { ...before, cache: { ...before.cache, maxPixels: 100_000_001 } },
      { ...before, cache: { ...before.cache, minDimension: 127 } },
      { ...before, cache: { ...before.cache, supportedFormats: ["image/svg+xml"] } }
    ];

    for (const payload of invalidPayloads) {
      const response = await app.inject({ method: "PUT", url: "/api/settings", payload });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("must-not-be-stored");
      expect((await app.inject({ method: "GET", url: "/api/settings" })).json()).toEqual(before);
    }
  });

  it("omits paid legacy providers while listing free-provider credential names without their values", async () => {
    const app = await createTestApp({ env: {
      BRAVE_SEARCH_API_KEY: "brave-value-that-must-stay-server-side",
      DATAFORSEO_LOGIN: "login-value-that-must-stay-server-side",
      DATAFORSEO_PASSWORD: "password-value-that-must-stay-server-side",
      SERPAPI_API_KEY: "serpapi-value-that-must-stay-server-side"
    } });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/providers" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toContainEqual(expect.objectContaining({
      id: "serpapi",
      configured: true,
      enabled: true,
      credentialVariables: ["SERPAPI_API_KEY"]
    }));
    expect(response.json().items.map((provider: { id: string }) => provider.id)).not.toEqual(expect.arrayContaining(["brave", "dataforseo"]));
    expect(response.body).not.toContain("brave-value-that-must-stay-server-side");
    expect(response.body).not.toContain("login-value-that-must-stay-server-side");
    expect(response.body).not.toContain("password-value-that-must-stay-server-side");
    expect(response.body).not.toContain("serpapi-value-that-must-stay-server-side");
  });
});
