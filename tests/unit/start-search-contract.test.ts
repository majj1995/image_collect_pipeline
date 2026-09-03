import { describe, expect, it } from "vitest";
import {
  contractualRightsDeclarationsSchema,
  providerIdSchema,
  startSearchInputSchema
} from "../../src/shared/contracts.js";

const providerIds = [
  "openverse",
  "baidu",
  "brave",
  "serpapi",
  "dataforseo",
  "fake",
  "wikimedia",
  "met",
  "cleveland",
  "artic",
  "loc",
  "nasa",
  "internet_archive",
  "open_food_facts",
  "smithsonian",
  "rijksmuseum",
  "bing_ads",
  "snap_ads",
  "europeana",
  "pexels",
  "pixabay",
  "unsplash",
  "flickr",
  "harvard_art_museums",
  "dpla",
  "tiktok_ads"
] as const;

describe("startSearchInputSchema", () => {
  it("accepts every supported provider ID in one unique search request", () => {
    expect(providerIds.map((providerId) => providerIdSchema.parse(providerId))).toEqual(providerIds);
    expect(startSearchInputSchema.parse({ providerIds })).toEqual({
      providerIds,
      retryFailedProviderIds: []
    });
  });

  it("rejects a request that crosses the 32-source safety ceiling", () => {
    const result = startSearchInputSchema.safeParse({
      providerIds: Array.from({ length: 33 }, (_, index) => providerIds[index % providerIds.length])
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        code: "too_big",
        path: ["providerIds"],
        maximum: 32
      }));
    }
  });

  it("accepts partial declarations for known providers and rejects unknown provider keys", () => {
    expect(contractualRightsDeclarationsSchema.parse({ wikimedia: true, tiktok_ads: false })).toEqual({
      wikimedia: true,
      tiktok_ads: false
    });
    expect(contractualRightsDeclarationsSchema.safeParse({ unknown_provider: true }).success).toBe(false);
  });

  it("allows an explicit unique subset of selected providers to retry terminal failures", () => {
    expect(startSearchInputSchema.parse({
      providerIds: ["fake", "openverse"],
      retryFailedProviderIds: ["openverse"]
    })).toEqual({
      providerIds: ["fake", "openverse"],
      retryFailedProviderIds: ["openverse"]
    });
    expect(startSearchInputSchema.parse({ providerIds: ["fake"] })).toEqual({
      providerIds: ["fake"],
      retryFailedProviderIds: []
    });
    expect(startSearchInputSchema.safeParse({
      providerIds: ["fake"],
      retryFailedProviderIds: ["openverse"]
    }).success).toBe(false);
    expect(startSearchInputSchema.safeParse({
      providerIds: ["fake", "openverse"],
      retryFailedProviderIds: ["fake", "fake"]
    }).success).toBe(false);
  });
});
