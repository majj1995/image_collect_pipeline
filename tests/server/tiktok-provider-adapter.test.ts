import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TikTokAdsProvider } from "../../src/server/providers/tiktok-ads.js";

const fixtureRoot = join(process.cwd(), "tests", "fixtures", "providers");

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureRoot, name), "utf8");
}

describe("TikTok Commercial Content provider", () => {
  it("exchanges and caches a client token, queries image ads, and keeps signed download URLs transient", async () => {
    const calls: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const call = new Request(input, init);
      calls.push(call.clone());
      const isToken = new URL(call.url).pathname === "/v2/oauth/token/";
      return new Response(await fixture(isToken ? "tiktok-token.json" : "tiktok-ads.json"), { headers: { "content-type": "application/json" } });
    };
    const provider = new TikTokAdsProvider({
      clientKey: "test-client-key",
      clientSecret: "test-client-secret",
      fetch,
      now: () => new Date("2026-08-31T12:00:00.000Z")
    });
    const searchRequest = { query: "portable speaker promotion", count: 10, locale: "zh-CN", safeSearch: true };

    const first = await provider.search(searchRequest, AbortSignal.timeout(1_000));
    const second = await provider.search(searchRequest, AbortSignal.timeout(1_000));

    expect(calls).toHaveLength(3);
    const tokenCall = calls[0]!;
    expect(tokenCall.url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(await tokenCall.text()).toBe("client_key=test-client-key&client_secret=test-client-secret&grant_type=client_credentials");

    for (const adCall of calls.slice(1)) {
      const url = new URL(adCall.url);
      expect(url.origin + url.pathname).toBe("https://open.tiktokapis.com/v2/research/adlib/ad/query/");
      expect(url.searchParams.get("fields")).toContain("ad.image_urls");
      expect(adCall.headers.get("authorization")).toBe("Bearer fixture-client-access-token");
      await expect(adCall.json()).resolves.toEqual({
        filters: {
          ad_type: "IMAGES",
          ad_published_date_range: { min: "20250831", max: "20260831" }
        },
        search_term: searchRequest.query,
        search_type: "fuzzy_phrase",
        max_count: 10
      });
    }
    expect(first).toEqual([expect.objectContaining({
      provider: "tiktok_ads",
      imageUrl: "https://images.example.test/tiktok-speaker-ad.jpg",
      transientImageUrl: "https://images.example.test/tiktok-speaker-ad.jpg?x-expires=1788134400&x-signature=fixture-resource-signature",
      creator: "Acme Audio",
      source: "1923845247192304"
    })]);
    expect(second).toEqual(first);
    expect(JSON.stringify(first.map(({ transientImageUrl: _transient, ...hit }) => hit))).not.toMatch(/test-client|fixture-client|signature/i);
  });

  it("is disabled without both approved application credentials and never makes a page-two request", async () => {
    let calls = 0;
    const provider = new TikTokAdsProvider({ clientKey: "only-key", fetch: async () => { calls += 1; return Response.json({}); } });
    expect(provider.configured).toBe(false);
    expect(provider.supportsPagination).toBe(false);
    await expect(provider.search({ query: "speaker", count: 10, locale: "en-US", safeSearch: true, page: 2 }, AbortSignal.timeout(1_000))).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it("uses TikTok search_id to consume bounded additional image-ad pages", async () => {
    const calls: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const call = new Request(input, init);
      calls.push(call.clone());
      if (new URL(call.url).pathname === "/v2/oauth/token/") return Response.json({ access_token: "token", expires_in: 7_200 });
      const body = await call.clone().json() as { search_id?: string };
      const secondPage = body.search_id === "cursor-page-2";
      return Response.json({
        data: {
          ads: [{ ad: { id: secondPage ? 2 : 1, image_urls: [`https://images.example.test/ad-${secondPage ? 2 : 1}.jpg?x-expires=1999999999&x-signature=signed`] }, advertiser: { business_name: "Acme" } }],
          has_more: !secondPage,
          search_id: secondPage ? "cursor-done" : "cursor-page-2"
        },
        error: { code: "ok", http_status_code: 200 }
      });
    };
    const provider = new TikTokAdsProvider({ clientKey: "key", clientSecret: "secret", fetch, now: () => new Date("2026-08-31T12:00:00.000Z") });

    const hits = await provider.search({ query: "speaker", count: 20, locale: "en-US", safeSearch: true }, AbortSignal.timeout(1_000));

    expect(hits.map((hit) => hit.source)).toEqual(["1", "2"]);
    expect(calls).toHaveLength(3);
    await expect(calls[1]!.clone().json()).resolves.not.toHaveProperty("search_id");
    await expect(calls[2]!.clone().json()).resolves.toMatchObject({ search_id: "cursor-page-2", max_count: 10 });
  });
});
