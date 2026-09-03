import { describe, expect, it } from "vitest";
import { EuropeanaProvider } from "../../src/server/providers/europeana.js";
import { PexelsProvider } from "../../src/server/providers/pexels.js";
import { PixabayProvider } from "../../src/server/providers/pixabay.js";
import { UnsplashProvider } from "../../src/server/providers/unsplash.js";
import { FlickrProvider } from "../../src/server/providers/flickr.js";
import { HarvardArtMuseumsProvider } from "../../src/server/providers/harvard-art-museums.js";
import { DplaProvider } from "../../src/server/providers/dpla.js";
import { ProviderError } from "../../src/server/providers/types.js";
import { fixtureFetch, recordingFixtureFetch } from "../helpers/providers.js";

const searchRequest = {
  query: "speaker commercial poster",
  count: 400,
  locale: "zh-CN",
  safeSearch: true,
  page: 3
};

const adapterCases = [
  {
    id: "europeana",
    fixture: "europeana.json",
    factory: (fetch: typeof globalThis.fetch) => new EuropeanaProvider({ apiKey: "test-secret", fetch }),
    endpoint: "https://api.europeana.eu/record/v2/search.json",
    params: { query: searchRequest.query, media: "true", thumbnail: "true", profile: "rich", qf: "TYPE:IMAGE", rows: "100", start: "201" },
    headerSecret: ["x-api-key", "test-secret"] as const,
    querySecret: null
  },
  {
    id: "pexels",
    fixture: "pexels.json",
    factory: (fetch: typeof globalThis.fetch) => new PexelsProvider({ apiKey: "test-secret", fetch }),
    endpoint: "https://api.pexels.com/v1/search",
    params: { query: searchRequest.query, page: "3", per_page: "80", locale: "zh-CN" },
    headerSecret: ["authorization", "test-secret"] as const,
    querySecret: null
  },
  {
    id: "pixabay",
    fixture: "pixabay.json",
    factory: (fetch: typeof globalThis.fetch) => new PixabayProvider({ apiKey: "test-secret", fetch }),
    endpoint: "https://pixabay.com/api/",
    params: { q: searchRequest.query, lang: "zh", image_type: "all", safesearch: "true", page: "3", per_page: "200", key: "test-secret" },
    headerSecret: null,
    querySecret: ["key", "test-secret"] as const
  },
  {
    id: "unsplash",
    fixture: "unsplash.json",
    factory: (fetch: typeof globalThis.fetch) => new UnsplashProvider({ accessKey: "test-secret", fetch }),
    endpoint: "https://api.unsplash.com/search/photos",
    params: { query: searchRequest.query, page: "3", per_page: "30", content_filter: "high" },
    headerSecret: ["authorization", "Client-ID test-secret"] as const,
    querySecret: null
  },
  {
    id: "flickr",
    fixture: "flickr.json",
    factory: (fetch: typeof globalThis.fetch) => new FlickrProvider({ apiKey: "test-secret", fetch }),
    endpoint: "https://www.flickr.com/services/rest/",
    params: {
      method: "flickr.photos.search", api_key: "test-secret", text: searchRequest.query, page: "3", per_page: "400",
      media: "photos", sort: "relevance", safe_search: "1", content_type: "7",
      extras: "url_o,url_l,url_c,owner_name,o_dims,license", format: "json", nojsoncallback: "1"
    },
    headerSecret: null,
    querySecret: ["api_key", "test-secret"] as const
  },
  {
    id: "harvard_art_museums",
    fixture: "harvard-art-museums.json",
    factory: (fetch: typeof globalThis.fetch) => new HarvardArtMuseumsProvider({ apiKey: "test-secret", fetch }),
    endpoint: "https://api.harvardartmuseums.org/object",
    params: {
      apikey: "test-secret", keyword: searchRequest.query, hasimage: "1", size: "100", page: "3",
      fields: "id,title,people,url,primaryimageurl,images"
    },
    headerSecret: null,
    querySecret: ["apikey", "test-secret"] as const
  },
  {
    id: "dpla",
    fixture: "dpla.json",
    factory: (fetch: typeof globalThis.fetch) => new DplaProvider({ apiKey: "test-secret", fetch }),
    endpoint: "https://api.dp.la/v2/items",
    params: { api_key: "test-secret", q: searchRequest.query, "sourceResource.type": "image", page_size: "400", page: "3" },
    headerSecret: null,
    querySecret: ["api_key", "test-secret"] as const
  }
] as const;

describe("free-key image API adapters", () => {
  it.each([
    ["europeana", () => new EuropeanaProvider(), "EUROPEANA_API_KEY", "culture"],
    ["pexels", () => new PexelsProvider(), "PEXELS_API_KEY", "general"],
    ["pixabay", () => new PixabayProvider(), "PIXABAY_API_KEY", "general"],
    ["unsplash", () => new UnsplashProvider(), "UNSPLASH_ACCESS_KEY", "general"],
    ["flickr", () => new FlickrProvider(), "FLICKR_API_KEY", "general"],
    ["harvard_art_museums", () => new HarvardArtMuseumsProvider(), "HARVARD_ART_MUSEUMS_API_KEY", "culture"],
    ["dpla", () => new DplaProvider(), "DPLA_API_KEY", "culture"]
  ] as const)("declares safe required-key metadata for %s", (_id, factory, variable, sourceCategory) => {
    const provider = factory();
    expect(provider).toMatchObject({
      configured: false,
      credentialMode: "required",
      credentialVariables: [variable],
      sourceCategory,
      defaultSelected: false,
      supportsPagination: true
    });
    expect(provider.freeTier).toEqual(expect.any(String));
    expect(provider.freeTier.length).toBeGreaterThan(0);
    expect(provider.docsUrl).toMatch(/^https:\/\//u);
  });

  it.each(adapterCases)("sends $id credentials only to its official endpoint with capped page-three parameters", async (testCase) => {
    const calls: Request[] = [];
    const provider = testCase.factory(recordingFixtureFetch(calls, testCase.fixture));
    await provider.search(searchRequest, AbortSignal.timeout(1000));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(testCase.endpoint);
    expect(call.method).toBe("GET");
    expect(Object.fromEntries(url.searchParams)).toEqual(testCase.params);

    const secretHeaders = [...call.headers.entries()].filter(([, value]) => value.includes("test-secret"));
    const secretParams = [...url.searchParams.entries()].filter(([, value]) => value.includes("test-secret"));
    expect(secretHeaders).toEqual(testCase.headerSecret ? [testCase.headerSecret] : []);
    expect(secretParams).toEqual(testCase.querySecret ? [testCase.querySecret] : []);
  });

  it("raises tiny Pixabay requests to the documented per_page minimum without over-returning", async () => {
    const calls: Request[] = [];
    const provider = new PixabayProvider({ apiKey: "test-secret", fetch: recordingFixtureFetch(calls, "pixabay.json") });

    const hits = await provider.search({ ...searchRequest, count: 1, page: 2 }, AbortSignal.timeout(1_000));

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("per_page")).toBe("3");
    expect(url.searchParams.get("page")).toBe("1");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.source).toBe("202");
    expect(provider.canRequestPage?.(500, 1)).toBe(true);
    expect(provider.canRequestPage?.(501, 1)).toBe(false);
  });

  it("maps logical Pixabay pages onto the upstream minimum page size without skipping results", async () => {
    const requestedPages: number[] = [];
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("per_page"));
      requestedPages.push(page);
      const first = (page - 1) * perPage;
      return Response.json({ hits: Array.from({ length: perPage }, (_, index) => {
        const id = first + index + 1;
        return { id, largeImageURL: `https://images.example.test/${id}.jpg`, previewURL: `https://images.example.test/${id}-preview.jpg` };
      }) });
    };
    const provider = new PixabayProvider({ apiKey: "test-secret", fetch });
    const sources: Array<string | null> = [];
    for (let page = 1; page <= 4; page += 1) {
      const hits = await provider.search({ ...searchRequest, count: 1, page }, AbortSignal.timeout(1_000));
      sources.push(hits[0]?.source ?? null);
    }
    expect(sources).toEqual(["1", "2", "3", "4"]);
    expect(requestedPages).toEqual([1, 1, 1, 2]);

    requestedPages.length = 0;
    const crossing = await provider.search({ ...searchRequest, count: 2, page: 2 }, AbortSignal.timeout(1_000));
    expect(crossing.map((hit) => hit.source)).toEqual(["3", "4"]);
    expect(requestedPages).toEqual([1, 2]);
  });

  it("bounds Pixabay query and locale parameters to documented values", async () => {
    const calls: Request[] = [];
    const provider = new PixabayProvider({ apiKey: "test-secret", fetch: recordingFixtureFetch(calls, "pixabay.json") });
    await provider.search({ ...searchRequest, query: "🔊".repeat(120), locale: "xx-INVALID", count: 3, page: 1 }, AbortSignal.timeout(1_000));
    const url = new URL(calls[0]!.url);
    expect(Array.from(url.searchParams.get("q") ?? "")).toHaveLength(100);
    expect(url.searchParams.get("lang")).toBe("en");
  });

  it("omits unsupported Pexels locales instead of forwarding arbitrary input", async () => {
    const calls: Request[] = [];
    const provider = new PexelsProvider({ apiKey: "test-secret", fetch: recordingFixtureFetch(calls, "pexels.json") });
    await provider.search({ ...searchRequest, locale: "xx-INVALID" }, AbortSignal.timeout(1_000));
    expect(new URL(calls[0]!.url).searchParams.has("locale")).toBe(false);
  });

  it.each([
    ["europeana", () => new EuropeanaProvider({ apiKey: "test-secret", fetch: fixtureFetch("europeana.json") }), {
      provider: "europeana", rank: 1,
      imageUrl: "https://media.example.test/europeana-speaker.jpg?size=full",
      thumbnailUrl: "https://api.europeana.eu/thumbnail/v3/400/fixture-speaker.jpg?size=w400",
      landingPageUrl: "https://www.europeana.eu/item/2021655/advertising_speaker_101",
      title: "Portable speaker advertising poster", creator: "Studio Europa", width: null, height: null,
      sourceProvider: "Europeana Foundation", source: "Museum of Advertising", rightsStatus: "unknown"
    }],
    ["pexels", () => new PexelsProvider({ apiKey: "test-secret", fetch: fixtureFetch("pexels.json") }), {
      provider: "pexels", rank: 1,
      imageUrl: "https://images.pexels.com/photos/101/pexels-photo-101.jpeg?auto=compress",
      thumbnailUrl: "https://images.pexels.com/photos/101/pexels-photo-101-medium.jpeg",
      landingPageUrl: "https://www.pexels.com/photo/portable-speaker-sale-101/",
      title: "Bluetooth speaker sale banner", creator: "Lin Chen", width: 2400, height: 1600,
      sourceProvider: "Pexels", source: "101", rightsStatus: "unknown"
    }],
    ["pixabay", () => new PixabayProvider({ apiKey: "test-secret", fetch: fixtureFetch("pixabay.json") }), {
      provider: "pixabay", rank: 1,
      imageUrl: "https://pixabay.com/get/speaker-large.jpg?size=large",
      thumbnailUrl: "https://cdn.pixabay.com/photo/2026/01/01/speaker-preview.jpg",
      landingPageUrl: "https://pixabay.com/illustrations/speaker-advertisement-201/",
      title: "speaker, sale, banner", creator: "pixel_shop", width: 3600, height: 2400,
      sourceProvider: "Pixabay", source: "201", rightsStatus: "unknown"
    }],
    ["unsplash", () => new UnsplashProvider({ accessKey: "test-secret", fetch: fixtureFetch("unsplash.json") }), {
      provider: "unsplash", rank: 1,
      imageUrl: "https://images.unsplash.com/photo-speaker-301?ixid=official-fixture",
      thumbnailUrl: "https://images.unsplash.com/photo-speaker-301?fit=max&w=400",
      landingPageUrl: "https://unsplash.com/photos/unsplash-speaker-301",
      title: "Premium speaker campaign artwork", creator: "Aria Design", width: 4000, height: 2667,
      sourceProvider: "Unsplash", source: "unsplash-speaker-301", rightsStatus: "unknown"
    }],
    ["flickr", () => new FlickrProvider({ apiKey: "test-secret", fetch: fixtureFetch("flickr.json") }), {
      provider: "flickr", rank: 1,
      imageUrl: "https://live.staticflickr.com/fixture/speaker-401_o.jpg?size=original",
      thumbnailUrl: "https://live.staticflickr.com/fixture/speaker-401_c.jpg",
      landingPageUrl: "https://www.flickr.com/photos/owner-401/401",
      title: "Wireless speaker launch poster", creator: "Flickr Studio", width: 3600, height: 2400,
      sourceProvider: "Flickr", source: "401", rightsStatus: "unknown"
    }],
    ["harvard_art_museums", () => new HarvardArtMuseumsProvider({ apiKey: "test-secret", fetch: fixtureFetch("harvard-art-museums.json") }), {
      provider: "harvard_art_museums", rank: 1,
      imageUrl: "https://nrs.harvard.edu/urn-3:HUAM:INV501_dynmc",
      thumbnailUrl: "https://nrs.harvard.edu/urn-3:HUAM:INV501_dynmc?height=400",
      landingPageUrl: "https://harvardartmuseums.org/collections/object/501",
      title: "Portable radio advertisement", creator: "Harvard Design Studio", width: 3000, height: 2000,
      sourceProvider: "Harvard Art Museums", source: "501", rightsStatus: "unknown"
    }],
    ["dpla", () => new DplaProvider({ apiKey: "test-secret", fetch: fixtureFetch("dpla.json") }), {
      provider: "dpla", rank: 1,
      imageUrl: "https://example-archive.test/media/speaker-601.jpg?size=original",
      thumbnailUrl: "https://example-archive.test/thumbnails/speaker-601.jpg",
      landingPageUrl: "https://example-archive.test/items/speaker-601",
      title: "Speaker catalogue cover", creator: "DPLA Retail Studio", width: null, height: null,
      sourceProvider: "Digital Public Library of America", source: "Example Advertising Archive", rightsStatus: "unknown"
    }]
  ] as const)("normalizes exact %s image, landing, creator, and dimensions without credential leakage", async (_id, factory, expected) => {
    const hits = await factory().search(searchRequest, AbortSignal.timeout(1000));
    expect(hits[0]).toEqual(expect.objectContaining(expected));
    expect(JSON.stringify(hits)).not.toMatch(/test-secret|fixture-secret|password|api[_-]?key|access[_-]?key/i);
  });

  it.each([
    ["Europeana shown-by to preview", () => new EuropeanaProvider({ apiKey: "test-secret", fetch: fixtureFetch("europeana.json") }), 1, "https://api.europeana.eu/thumbnail/v3/400/fallback-speaker.jpg"],
    ["Pexels original to large", () => new PexelsProvider({ apiKey: "test-secret", fetch: fixtureFetch("pexels.json") }), 1, "https://images.pexels.com/photos/102/pexels-photo-102-large.jpeg"],
    ["Pixabay large to web", () => new PixabayProvider({ apiKey: "test-secret", fetch: fixtureFetch("pixabay.json") }), 1, "https://pixabay.com/get/audio-web.jpg"],
    ["Unsplash full to regular", () => new UnsplashProvider({ accessKey: "test-secret", fetch: fixtureFetch("unsplash.json") }), 1, "https://images.unsplash.com/photo-speaker-302?fit=max&w=1080"],
    ["Flickr original to large", () => new FlickrProvider({ apiKey: "test-secret", fetch: fixtureFetch("flickr.json") }), 1, "https://live.staticflickr.com/fixture/speaker-402_l.jpg"],
    ["Flickr large to c", () => new FlickrProvider({ apiKey: "test-secret", fetch: fixtureFetch("flickr.json") }), 2, "https://live.staticflickr.com/fixture/speaker-403_c.jpg"],
    ["Harvard base image to primary", () => new HarvardArtMuseumsProvider({ apiKey: "test-secret", fetch: fixtureFetch("harvard-art-museums.json") }), 1, "https://nrs.harvard.edu/urn-3:HUAM:DDC502_dynmc"],
    ["DPLA hasView to object", () => new DplaProvider({ apiKey: "test-secret", fetch: fixtureFetch("dpla.json") }), 1, "https://example-archive.test/thumbnails/speaker-602.jpg"]
  ] as const)("uses the documented $0 fallback", async (_label, factory, index, expectedImageUrl) => {
    const hits = await factory().search(searchRequest, AbortSignal.timeout(1000));
    expect(hits[index]?.imageUrl).toBe(expectedImageUrl);
  });

  it.each(adapterCases)("isolates $id HTTP failures as credential-safe provider errors", async (testCase) => {
    const provider = testCase.factory(async () => new Response("api_key=test-secret", { status: 503 }));
    let error: unknown;
    try {
      await provider.search(searchRequest, AbortSignal.timeout(1000));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: testCase.id, status: 503, retryable: true });
    expect(String(error)).not.toMatch(/test-secret|api[_-]?key|password/i);
  });
});
