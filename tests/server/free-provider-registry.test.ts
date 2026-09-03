import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "../../src/shared/contracts.js";
import { createTestApp } from "../helpers/server.js";

const productionIds = [
  "openverse", "wikimedia", "met", "cleveland", "artic", "loc", "nasa", "internet_archive",
  "open_food_facts", "smithsonian", "rijksmuseum", "bing_ads", "snap_ads", "baidu", "serpapi",
  "europeana", "pexels", "pixabay", "unsplash", "flickr", "harvard_art_museums", "dpla", "tiktok_ads"
] as const;

const defaultEnabledIds = [
  "openverse", "met", "cleveland", "artic", "loc", "nasa", "internet_archive",
  "open_food_facts", "smithsonian", "rijksmuseum", "bing_ads", "snap_ads"
] as const;

describe("free-only production provider registry", () => {
  it("lists the complete free live catalog and disables only sources missing required local configuration", async () => {
    const app = await createTestApp({ env: {} });
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers" });
      const items = response.json().items as ProviderStatus[];
      expect(items.map((provider) => provider.id)).toEqual(productionIds);
      expect(items.filter((provider) => provider.enabled).map((provider) => provider.id)).toEqual(defaultEnabledIds);
      expect(items.find((provider) => provider.id === "wikimedia")).toMatchObject({
        configured: false,
        enabled: false,
        credentialMode: "none",
        credentialVariables: ["WIKIMEDIA_USER_AGENT"]
      });
      expect(items.filter((provider) => !provider.enabled && provider.id !== "wikimedia").every((provider) =>
        provider.credentialMode === "required" || provider.credentialMode === "approval"
      )).toBe(true);
      expect(items.map((provider) => provider.id)).not.toEqual(expect.arrayContaining(["brave", "dataforseo"]));
      expect(items.every((provider) => provider.docsUrl?.startsWith("https://") && provider.freeTier && provider.sourceCategory)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("enables every free-key/approval provider when all server-only variables exist without exposing values", async () => {
    const secrets = {
      WIKIMEDIA_USER_AGENT: "TrainingDataCollector/2.0 (https://owner.example.test/contact)",
      BAIDU_QIANFAN_API_KEY: "baidu-secret",
      SERPAPI_API_KEY: "serpapi-secret",
      EUROPEANA_API_KEY: "europeana-secret",
      PEXELS_API_KEY: "pexels-secret",
      PIXABAY_API_KEY: "pixabay-secret",
      UNSPLASH_ACCESS_KEY: "unsplash-secret",
      FLICKR_API_KEY: "flickr-secret",
      HARVARD_ART_MUSEUMS_API_KEY: "harvard-secret",
      DPLA_API_KEY: "dpla-secret",
      SMITHSONIAN_API_KEY: "smithsonian-secret",
      TIKTOK_CLIENT_KEY: "tiktok-key-secret",
      TIKTOK_CLIENT_SECRET: "tiktok-client-secret"
    };
    const app = await createTestApp({ env: secrets });
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers" });
      const items = response.json().items as ProviderStatus[];
      expect(items).toHaveLength(productionIds.length);
      expect(items.every((provider) => provider.enabled)).toBe(true);
      for (const secret of Object.values(secrets)) expect(response.body).not.toContain(secret);
      expect(items.find((provider) => provider.id === "smithsonian")).toMatchObject({ configured: true, enabled: true, credentialMode: "optional" });
      expect(items.find((provider) => provider.id === "tiktok_ads")).toMatchObject({ configured: true, enabled: true, credentialMode: "approval" });
    } finally {
      await app.close();
    }
  });
});
