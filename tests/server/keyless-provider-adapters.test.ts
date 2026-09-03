import { describe, expect, it } from "vitest";
import { ArticProvider } from "../../src/server/providers/artic.js";
import { ClevelandProvider } from "../../src/server/providers/cleveland.js";
import { LocProvider } from "../../src/server/providers/loc.js";
import { OpenFoodFactsProvider } from "../../src/server/providers/open-food-facts.js";
import { SmithsonianProvider } from "../../src/server/providers/smithsonian.js";
import { ProviderError } from "../../src/server/providers/types.js";
import { WikimediaProvider } from "../../src/server/providers/wikimedia.js";
import { fixtureFetch, recordingFixtureFetch } from "../helpers/providers.js";

const request = {
  query: "speaker commercial poster",
  count: 400,
  locale: "zh-CN",
  safeSearch: true,
  page: 3
};

const WIKIMEDIA_USER_AGENT = "TrainingDataCollector/2.0 (maintainer@example.test)";

const metadataCases = [
  ["wikimedia", () => new WikimediaProvider({ userAgent: WIKIMEDIA_USER_AGENT }), "none", ["WIKIMEDIA_USER_AGENT"], "general", true],
  ["cleveland", () => new ClevelandProvider(), "none", [], "culture", false],
  ["artic", () => new ArticProvider(), "none", [], "culture", false],
  ["loc", () => new LocProvider(), "none", [], "culture", false],
  ["open_food_facts", () => new OpenFoodFactsProvider(), "none", [], "commerce", true],
  ["smithsonian", () => new SmithsonianProvider(), "optional", ["SMITHSONIAN_API_KEY"], "culture", false]
] as const;

describe("one-request keyless and public collection adapters", () => {
  it.each(metadataCases)("declares complete catalog metadata for %s", (_id, factory, credentialMode, credentialVariables, sourceCategory, defaultSelected) => {
    const provider = factory();
    expect(provider).toMatchObject({ credentialMode, credentialVariables, sourceCategory, defaultSelected });
    expect(provider.freeTier).toEqual(expect.any(String));
    expect(provider.docsUrl).toMatch(/^https:\/\//u);
  });

  it("requests Wikimedia's file namespace and uses a supported thumbnail for TIFF bitmap originals", async () => {
    const calls: Request[] = [];
    const hits = await new WikimediaProvider({ fetch: recordingFixtureFetch(calls, "wikimedia.json"), userAgent: WIKIMEDIA_USER_AGENT })
      .search(request, AbortSignal.timeout(1000));

    const call = calls[0]!;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe("https://commons.wikimedia.org/w/api.php");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      action: "query",
      format: "json",
      formatversion: "2",
      generator: "search",
      gsrsearch: request.query,
      gsrnamespace: "6",
      gsrlimit: "50",
      gsroffset: "100",
      prop: "imageinfo",
      iiprop: "url|size|mime|mediatype|extmetadata",
      iiurlwidth: "1024"
    });
    expect(call.headers.get("user-agent")).toBe(WIKIMEDIA_USER_AGENT);
    expect(hits).toEqual([
      expect.objectContaining({
        provider: "wikimedia",
        rank: 1,
        imageUrl: "https://upload.wikimedia.example.test/speaker-campaign.jpg",
        thumbnailUrl: "https://upload.wikimedia.example.test/thumb/speaker-campaign-1024px.jpg",
        landingPageUrl: "https://commons.wikimedia.org/wiki/File:Speaker_campaign.jpg",
        title: "Speaker campaign artwork",
        creator: "Example Design Studio",
        licenseName: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        width: 3000,
        height: 2000,
        sourceProvider: "Wikimedia Commons",
        source: "File:Speaker campaign.jpg",
        rightsStatus: "provider_claimed"
      }),
      expect.objectContaining({
        provider: "wikimedia",
        rank: 2,
        imageUrl: "https://upload.wikimedia.example.test/thumb/vintage-speaker-advertisement-1024px.jpg",
        thumbnailUrl: "https://upload.wikimedia.example.test/thumb/vintage-speaker-advertisement-1024px.jpg",
        width: 1024,
        height: 768
      })
    ]);
  });

  it("uses one exact configured Wikimedia User-Agent for search and media downloads", async () => {
    const calls: Request[] = [];
    const userAgent = "TrainingDataCollector/2.0 (https://collector.example.test/contact)";
    const provider = new WikimediaProvider({
      fetch: recordingFixtureFetch(calls, "wikimedia.json"),
      userAgent: `  ${userAgent}  `
    });

    await provider.search(request, AbortSignal.timeout(1000));

    expect(calls[0]!.headers.get("user-agent")).toBe(userAgent);
    expect(provider.downloadPolicy?.userAgent).toBe(userAgent);
  });

  it.each([
    ["header injection", "TrainingDataCollector/2.0\r\nX-Injected: true"],
    ["control character", "TrainingDataCollector/2.0\u0000contact"],
    ["contact-free value", "TrainingDataCollector/2.0 (local image collection tool)"],
    ["overlong value", `TrainingDataCollector/2.0 (maintainer@example.test)${"x".repeat(257)}`]
  ])("keeps Wikimedia disabled for an invalid User-Agent: %s", async (_case, userAgent) => {
    const provider = new WikimediaProvider({ userAgent });
    expect(provider).toMatchObject({ configured: false, requiresConfiguration: true, downloadPolicy: undefined });
    await expect(provider.search(request, AbortSignal.timeout(1000))).rejects.toThrow(/WIKIMEDIA_USER_AGENT/u);
  });

  it("paginates Cleveland by skip and prefers the print JPEG over its TIFF master", async () => {
    const calls: Request[] = [];
    const hits = await new ClevelandProvider({ fetch: recordingFixtureFetch(calls, "cleveland.json") })
      .search(request, AbortSignal.timeout(1000));

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://openaccess-api.clevelandart.org/api/artworks/");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: request.query, has_image: "1", limit: "100", skip: "200" });
    expect(calls[0]!.headers.get("user-agent")).toMatch(/^MultimodalDataExpansion\/1\.0/u);
    expect(hits).toEqual([expect.objectContaining({
      provider: "cleveland",
      rank: 1,
      imageUrl: "https://openaccess-cdn.clevelandart.example.test/1998.78.14_print.jpg",
      thumbnailUrl: "https://openaccess-cdn.clevelandart.example.test/1998.78.14_web.jpg",
      landingPageUrl: "https://www.clevelandart.org/art/1998.78.14",
      title: "Speaker Campaign",
      creator: "Example Design Studio (American, active 1940–1960)",
      licenseName: "CC0",
      width: 3400,
      height: 2429,
      sourceProvider: "Cleveland Museum of Art",
      source: "1998.78.14",
      rightsStatus: "provider_claimed"
    })]);
  });

  it("constructs ArtIC image URLs from the response IIIF base instead of a hardcoded host", async () => {
    const calls: Request[] = [];
    const hits = await new ArticProvider({ fetch: recordingFixtureFetch(calls, "artic.json") })
      .search(request, AbortSignal.timeout(1000));

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.artic.edu/api/v1/artworks/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: request.query,
      page: "3",
      limit: "100",
      fields: "id,title,image_id,thumbnail,artist_display,date_display,is_public_domain,copyright_notice,credit_line"
    });
    expect(calls[0]!.headers.get("user-agent")).toMatch(/^MultimodalDataExpansion\/1\.0/u);
    expect(hits).toEqual([expect.objectContaining({
      provider: "artic",
      imageUrl: "https://iiif.example.test/iiif/2/2d484387-2509-5e8e-2c43-22f9981972eb/full/843,/0/default.jpg",
      thumbnailUrl: "https://iiif.example.test/iiif/2/2d484387-2509-5e8e-2c43-22f9981972eb/full/400,/0/default.jpg",
      landingPageUrl: "https://www.artic.edu/artworks/27992",
      title: "Speaker Exhibition Poster",
      creator: "Example Design Studio\nAmerican, founded 1948",
      licenseName: "Public Domain",
      width: 6884,
      height: 4068,
      sourceProvider: "Art Institute of Chicago",
      source: "27992",
      rightsStatus: "provider_claimed"
    })]);
  });

  it("publishes ARTIC's serial 1000 ms download policy", () => {
    expect(new ArticProvider()).toMatchObject({
      downloadPolicy: { maxConcurrency: 1, minimumIntervalMs: 1000 }
    });
  });

  it("normalizes Library of Congress protocol-relative images and historical HTTP item links", async () => {
    const calls: Request[] = [];
    const hits = await new LocProvider({ fetch: recordingFixtureFetch(calls, "loc.json") })
      .search(request, AbortSignal.timeout(1000));

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://www.loc.gov/photos/");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ fo: "json", q: request.query, c: "100", sp: "3", at: "results,pagination" });
    expect(calls[0]!.headers.get("user-agent")).toMatch(/^MultimodalDataExpansion\/1\.0/u);
    expect(hits).toEqual([expect.objectContaining({
      provider: "loc",
      imageUrl: "https://cdn.loc.example.test/service/pnp/speaker_1024px.jpg",
      thumbnailUrl: "https://cdn.loc.example.test/service/pnp/speaker_150px.jpg",
      landingPageUrl: "https://www.loc.gov/item/2017645977/",
      title: "Speaker advertising poster",
      creator: "Example Design Studio",
      sourceProvider: "Library of Congress",
      source: "https://www.loc.gov/item/2017645977/",
      rightsStatus: "unknown"
    })]);
  });

  it("uses Open Food Facts' legacy full-text API and exposes the selected front image", async () => {
    const calls: Request[] = [];
    const provider = new OpenFoodFactsProvider({ fetch: recordingFixtureFetch(calls, "open-food-facts.json") });
    const hits = await provider.search(request, AbortSignal.timeout(1000));

    expect(provider.searchPolicy).toEqual({ minimumIntervalMs: 6_000 });
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://world.openfoodfacts.org/cgi/search.pl");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      search_terms: request.query,
      search_simple: "1",
      action: "process",
      json: "1",
      page: "3",
      page_size: "100",
      lc: "zh",
      cc: "cn"
    });
    expect(url.searchParams.get("fields")).toContain("image_front_url");
    expect(calls[0]!.headers.get("user-agent")).toMatch(/^MultimodalDataExpansion\/1\.0/u);
    expect(hits).toEqual([expect.objectContaining({
      provider: "open_food_facts",
      imageUrl: "https://images.openfoodfacts.example.test/images/products/301/762/401/0701/front_en.4.full.jpg",
      thumbnailUrl: "https://images.openfoodfacts.example.test/images/products/301/762/401/0701/front_en.4.200.jpg",
      landingPageUrl: "https://world.openfoodfacts.org/product/3017624010701/example-wireless-speaker-gift-box",
      title: "Example Wireless Speaker Gift Box",
      creator: "Example Audio",
      licenseName: "CC BY-SA 3.0",
      width: 850,
      height: 1200,
      sourceProvider: "Open Food Facts",
      source: "3017624010701",
      rightsStatus: "provider_claimed"
    })]);
  });

  it("uses Smithsonian's optional key, high-resolution JPEG, and content fallback without leaking credentials", async () => {
    const calls: Request[] = [];
    const provider = new SmithsonianProvider({ apiKey: "test-secret", fetch: recordingFixtureFetch(calls, "smithsonian.json") });
    const hits = await provider.search({ ...request, page: 1 }, AbortSignal.timeout(1000));

    expect(provider.configured).toBe(true);
    expect(provider.searchPolicy).toEqual({ minimumIntervalMs: 1_000 });
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.si.edu/openaccess/api/v1.0/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: `${request.query} AND online_media_type:\"Images\"`,
      rows: "500",
      start: "0",
      sort: "newest",
      api_key: "test-secret"
    });
    expect(calls[0]!.headers.get("user-agent")).toMatch(/^MultimodalDataExpansion\/1\.0/u);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      provider: "smithsonian",
      rank: 1,
      imageUrl: "https://ids.si.example.test/ids/download?id=CHNDM-000001.jpg",
      thumbnailUrl: "https://ids.si.example.test/ids/deliveryService?id=CHNDM-000001",
      landingPageUrl: "https://collection.cooperhewitt.org/objects/1952-76-2/",
      title: "Portable Speaker Advertisement",
      creator: "Example Design Studio",
      licenseName: "CC0",
      width: 6304,
      height: 4503,
      sourceProvider: "Cooper Hewitt, Smithsonian Design Museum",
      source: "edanmdm-chndm_1952-76-2",
      rightsStatus: "provider_claimed"
    });
    expect(hits[1]).toMatchObject({
      provider: "smithsonian",
      rank: 2,
      imageUrl: "https://ids.si.example.test/ids/deliveryService?id=NMAH-000002",
      thumbnailUrl: "https://ids.si.example.test/ids/deliveryService?id=NMAH-000002&max=150",
      title: "Speaker Packaging",
      licenseName: "Not determined",
      width: null,
      height: null,
      rightsStatus: "unknown"
    });
    expect(JSON.stringify(hits)).not.toMatch(/test-secret|fixture-secret|api[_-]?key|token|signature/i);
  });

  it("uses the shared Smithsonian DEMO_KEY without claiming a personal key is configured", async () => {
    const calls: Request[] = [];
    const provider = new SmithsonianProvider({ fetch: recordingFixtureFetch(calls, "smithsonian.json") });

    await provider.search({ ...request, count: 1, page: 1 }, AbortSignal.timeout(1000));

    expect(provider.configured).toBe(false);
    expect(provider.searchPolicy).toEqual({ minimumIntervalMs: 120_000 });
    expect(new URL(calls[0]!.url).searchParams.get("api_key")).toBe("DEMO_KEY");
  });

  it("overfetches newest Smithsonian rows so metadata-only image matches do not hide downloadable media", async () => {
    const calls: Request[] = [];
    const sparseResponse = {
      status: 200,
      responseCode: 1,
      response: {
        rowCount: 2,
        message: "content found",
        start: 0,
        rows: [
          {
            id: "ld1-stale-record",
            title: "Advertising object without embedded media",
            unitCode: "NMAH",
            type: "edanmdm",
            url: "edanmdm:nmah_stale",
            content: {
              freetext: {},
              indexedStructured: { online_media_type: ["Images"] },
              descriptiveNonRepeating: {
                record_ID: "nmah_stale",
                unit_code: "NMAH",
                title: { label: "Object Name", content: "Advertising object without embedded media" },
                data_source: "National Museum of American History"
              }
            }
          },
          {
            id: "ld1-downloadable-record",
            title: "Downloadable advertising card",
            unitCode: "NMAH",
            type: "edanmdm",
            url: "edanmdm:nmah_downloadable",
            content: {
              freetext: {},
              indexedStructured: { online_media_type: ["Images"] },
              descriptiveNonRepeating: {
                record_ID: "nmah_downloadable",
                unit_code: "NMAH",
                title: { label: "Object Name", content: "Downloadable advertising card" },
                data_source: "National Museum of American History",
                online_media: {
                  mediaCount: 1,
                  media: [{
                    id: "media:NMAH-downloadable",
                    guid: "http://n2t.net/ark:/65665/example",
                    type: "Images",
                    idsId: "NMAH-downloadable",
                    usage: { access: "CC0" },
                    content: "https://ids.si.edu/ids/deliveryService?id=NMAH-downloadable",
                    thumbnail: "https://ids.si.edu/ids/deliveryService?id=NMAH-downloadable&max=150",
                    resources: [{
                      label: "High-resolution JPEG",
                      url: "https://ids.si.edu/ids/download?id=NMAH-downloadable.jpg",
                      width: 2400,
                      height: 1800,
                      dimensions: "2400x1800"
                    }]
                  }]
                }
              }
            }
          }
        ]
      }
    };
    const provider = new SmithsonianProvider({
      fetch: async (input, init) => {
        const call = new Request(input, init);
        calls.push(call.clone());
        const rows = Number(new URL(call.url).searchParams.get("rows"));
        return Response.json({
          ...sparseResponse,
          response: { ...sparseResponse.response, rows: sparseResponse.response.rows.slice(0, rows) }
        });
      }
    });

    const hits = await provider.search({ ...request, query: "advertisement", count: 1, page: 1 }, AbortSignal.timeout(1000));

    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toMatchObject({
      q: "advertisement AND online_media_type:\"Images\"",
      rows: "20",
      start: "0",
      sort: "newest"
    });
    expect(hits).toEqual([expect.objectContaining({
      title: "Downloadable advertising card",
      imageUrl: "https://ids.si.edu/ids/download?id=NMAH-downloadable.jpg"
    })]);
  });

  it("maps Smithsonian logical pages over filtered downloadable rows without skipping", async () => {
    const calls: Request[] = [];
    const media = (id: number) => ({
      id: `record-${id}`,
      title: `Record ${id}`,
      content: { descriptiveNonRepeating: { online_media: { media: [{
        type: "Images",
        content: `https://ids.si.edu/ids/deliveryService?id=${id}`
      }] } } }
    });
    const provider = new SmithsonianProvider({ fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ status: 200, responseCode: 1, response: { rows: [media(1), media(2), media(3)] } });
    } });

    const first = await provider.search({ ...request, count: 1, page: 1 }, AbortSignal.timeout(1_000));
    const second = await provider.search({ ...request, count: 1, page: 2 }, AbortSignal.timeout(1_000));

    expect(first[0]?.source).toBe("record-1");
    expect(second[0]?.source).toBe("record-2");
    expect(calls.map((call) => Object.fromEntries(new URL(call.url).searchParams))).toEqual([
      expect.objectContaining({ rows: "20", start: "0" }),
      expect.objectContaining({ rows: "20", start: "0" })
    ]);
    expect(provider.canRequestPage?.(1_000, 1)).toBe(true);
    expect(provider.canRequestPage?.(1_001, 1)).toBe(false);
  });

  it("surfaces Smithsonian's successful-HTTP rate-limit envelope as retryable", async () => {
    const provider = new SmithsonianProvider({
      fetch: async () => Response.json({
        error: {
          code: "OVER_RATE_LIMIT",
          message: "You have exceeded your rate limit."
        }
      })
    });

    await expect(provider.search({ ...request, count: 1, page: 1 }, AbortSignal.timeout(1000))).rejects.toMatchObject({
      name: ProviderError.name,
      status: 429,
      retryable: true
    });
  });

  it.each([
    ["wikimedia", (fetch: typeof globalThis.fetch) => new WikimediaProvider({ fetch, userAgent: WIKIMEDIA_USER_AGENT })],
    ["cleveland", (fetch: typeof globalThis.fetch) => new ClevelandProvider({ fetch })],
    ["artic", (fetch: typeof globalThis.fetch) => new ArticProvider({ fetch })],
    ["loc", (fetch: typeof globalThis.fetch) => new LocProvider({ fetch })],
    ["open_food_facts", (fetch: typeof globalThis.fetch) => new OpenFoodFactsProvider({ fetch })],
    ["smithsonian", (fetch: typeof globalThis.fetch) => new SmithsonianProvider({ apiKey: "test-secret", fetch })]
  ] as const)("surfaces a typed retryable %s failure and releases its response body", async (_id, factory) => {
    let cancelled = 0;
    const provider = factory(async () => new Response(new ReadableStream({ cancel() { cancelled += 1; } }), { status: 503 }));

    await expect(provider.search(request, AbortSignal.timeout(1000))).rejects.toMatchObject({
      name: ProviderError.name,
      status: 503,
      retryable: true
    });
    expect(cancelled).toBe(1);
  });
});
