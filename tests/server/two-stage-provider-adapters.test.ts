import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InternetArchiveProvider } from "../../src/server/providers/internet-archive.js";
import { MetProvider } from "../../src/server/providers/met.js";
import { NasaProvider } from "../../src/server/providers/nasa.js";
import { RijksmuseumProvider } from "../../src/server/providers/rijksmuseum.js";

const fixtureRoot = join(process.cwd(), "tests", "fixtures", "providers");
const request = { query: "speaker advertisement", count: 4, locale: "zh-CN", safeSearch: true };

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureRoot, name), "utf8");
}

function routedFetch(calls: Request[], route: (request: Request) => string | null): typeof fetch {
  return async (input, init) => {
    const call = new Request(input, init);
    calls.push(call.clone());
    const name = route(call);
    if (!name) return Response.json({ error: "unmapped fixture route" }, { status: 404 });
    return new Response(await fixture(name), { headers: { "content-type": "application/json" } });
  };
}

describe("bounded two-stage public providers", () => {
  it("slices Met IDs locally and resolves public-domain original images", async () => {
    const calls: Request[] = [];
    const provider = new MetProvider({ fetch: routedFetch(calls, (call) => call.url.includes("/search?") ? "met-search.json" : call.url.endsWith("/objects/101") ? "met-object.json" : null) });

    const hits = await provider.search(request, AbortSignal.timeout(1_000));

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/public/collection/v1/search",
      "/public/collection/v1/objects/101"
    ]);
    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toMatchObject({ hasImages: "true", q: request.query });
    expect(hits).toEqual([expect.objectContaining({
      provider: "met",
      imageUrl: "https://images.example.test/met-speaker-poster.jpg",
      thumbnailUrl: "https://images.example.test/met-speaker-poster-small.jpg",
      creator: "Example Designer",
      licenseName: "cc0",
      rightsStatus: "provider_claimed"
    })]);
  });

  it("skips a Met detail without an image instead of producing an invalid hit", async () => {
    const provider = new MetProvider({ fetch: async (input) => String(input).includes("/search?")
      ? Response.json({ total: 1, objectIDs: [9] })
      : Response.json({ objectID: 9, primaryImage: "" }) });
    await expect(provider.search(request, AbortSignal.timeout(1_000))).resolves.toEqual([]);
  });

  it("keeps a successful Met sibling but retries when every detail request fails", async () => {
    const partial = new MetProvider({ fetch: async (input) => {
      const url = String(input);
      if (url.includes("/search?")) return Response.json({ objectIDs: [1, 2] });
      if (url.endsWith("/objects/1")) return new Response("unavailable", { status: 503 });
      return Response.json({ objectID: 2, primaryImage: "https://images.example.test/met-2.jpg" });
    } });
    await expect(partial.search(request, AbortSignal.timeout(1_000))).resolves.toEqual([
      expect.objectContaining({ imageUrl: "https://images.example.test/met-2.jpg" })
    ]);

    const unavailable = new MetProvider({ fetch: async (input) => String(input).includes("/search?")
      ? Response.json({ objectIDs: [1, 2] })
      : new Response("unavailable", { status: 503 }) });
    await expect(unavailable.search(request, AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it("resolves NASA asset manifests and prefers the original image", async () => {
    const calls: Request[] = [];
    const provider = new NasaProvider({ fetch: routedFetch(calls, (call) => call.url.includes("/search?") ? "nasa-search.json" : call.url.endsWith("/asset/NASA-SPEAKER-1") ? "nasa-asset.json" : null) });

    const hits = await provider.search({ ...request, page: 2 }, AbortSignal.timeout(1_000));

    const searchUrl = new URL(calls[0]!.url);
    expect(searchUrl.origin + searchUrl.pathname).toBe("https://images-api.nasa.gov/search");
    expect(Object.fromEntries(searchUrl.searchParams)).toMatchObject({ q: request.query, media_type: "image", page: "2", page_size: "4" });
    expect(hits).toEqual([expect.objectContaining({
      provider: "nasa",
      imageUrl: "https://images.example.test/NASA-SPEAKER-1~orig.jpg",
      thumbnailUrl: "https://images.example.test/nasa-preview.jpg",
      landingPageUrl: "https://images.nasa.gov/details/NASA-SPEAKER-1",
      creator: "NASA Example"
    })]);
  });

  it("chooses Internet Archive original JPEG/PNG files and encodes their names", async () => {
    const calls: Request[] = [];
    const provider = new InternetArchiveProvider({ fetch: routedFetch(calls, (call) => call.url.includes("advancedsearch.php") ? "archive-search.json" : call.url.includes("/metadata/speaker-ad-archive") ? "archive-metadata.json" : null) });

    const hits = await provider.search(request, AbortSignal.timeout(1_000));

    const searchUrl = new URL(calls[0]!.url);
    expect(searchUrl.searchParams.get("q")).toBe("mediatype:image AND (speaker advertisement)");
    expect(searchUrl.searchParams.getAll("fl[]")).toEqual(["identifier", "title", "creator", "description"]);
    expect(hits).toEqual([expect.objectContaining({
      provider: "internet_archive",
      imageUrl: "https://archive.org/download/speaker-ad-archive/ads/speaker%20hero.jpg",
      thumbnailUrl: "https://archive.org/services/img/speaker-ad-archive",
      landingPageUrl: "https://archive.org/details/speaker-ad-archive",
      creator: "Example Radio Company",
      licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/"
    })]);
  });

  it("keeps a successful Internet Archive sibling but retries when every metadata request fails", async () => {
    const root = { response: { docs: [{ identifier: "broken" }, { identifier: "working", title: "Working" }] } };
    const partial = new InternetArchiveProvider({ fetch: async (input) => {
      const url = String(input);
      if (url.includes("advancedsearch.php")) return Response.json(root);
      if (url.endsWith("/metadata/broken")) return new Response("unavailable", { status: 503 });
      return Response.json({ files: [{ source: "original", format: "JPEG", name: "poster.jpg" }], metadata: {} });
    } });
    await expect(partial.search(request, AbortSignal.timeout(1_000))).resolves.toEqual([
      expect.objectContaining({ imageUrl: "https://archive.org/download/working/poster.jpg" })
    ]);

    const unavailable = new InternetArchiveProvider({ fetch: async (input) => String(input).includes("advancedsearch.php")
      ? Response.json(root)
      : new Response("unavailable", { status: 503 }) });
    await expect(unavailable.search(request, AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it("serializes detail requests inside each two-stage provider slot", async () => {
    let active = 0;
    let maximum = 0;
    const provider = new MetProvider({ fetch: async (input) => {
      if (String(input).includes("/search?")) return Response.json({ objectIDs: [1, 2, 3, 4] });
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Response.json({ primaryImage: `https://images.example.test/${String(input).split("/").at(-1)}.jpg` });
    } });

    await provider.search(request, AbortSignal.timeout(1_000));
    expect(maximum).toBe(1);
  });

  it("traverses Rijksmuseum JSON-LD links and deduplicates title/description search results", async () => {
    const calls: Request[] = [];
    const provider = new RijksmuseumProvider({ fetch: routedFetch(calls, (call) => {
      const url = new URL(call.url);
      if (url.pathname === "/search/collection") return "rijks-search.json";
      if (url.pathname.endsWith("200100000")) return "rijks-object.json";
      if (url.pathname.endsWith("200100000-visual")) return "rijks-visual.json";
      if (url.pathname.endsWith("200100000-digital")) return "rijks-digital.json";
      return null;
    }) });

    const hits = await provider.search(request, AbortSignal.timeout(1_000));

    expect(calls.filter((call) => new URL(call.url).pathname === "/search/collection")).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get("title")).toBe(request.query);
    expect(new URL(calls[1]!.url).searchParams.get("description")).toBe(request.query);
    expect(calls.slice(2).every((call) => new URL(call.url).hostname === "data.rijksmuseum.nl" && new URL(call.url).searchParams.get("_profile") === "la-framed")).toBe(true);
    expect(calls.slice(2).every((call) => call.headers.get("accept") === "application/ld+json, application/json")).toBe(true);
    expect(hits).toEqual([expect.objectContaining({
      provider: "rijksmuseum",
      imageUrl: "https://iiif.micr.io/example-speaker/full/max/0/default.jpg",
      thumbnailUrl: "https://iiif.micr.io/example-speaker/full/800,/0/default.jpg",
      landingPageUrl: "https://id.rijksmuseum.nl/200100000",
      title: "Modern speaker poster",
      creator: "Rijks Example Studio"
    })]);
  });

  it("does not replay Rijksmuseum's opaque page token as a page number", async () => {
    let calls = 0;
    const provider = new RijksmuseumProvider({ fetch: async () => { calls += 1; return Response.json({ orderedItems: [] }); } });
    await expect(provider.search({ ...request, page: 2 }, AbortSignal.timeout(1_000))).resolves.toEqual([]);
    expect(calls).toBe(0);
    expect(provider.supportsPagination).toBe(false);
  });

  it("never follows untrusted Rijksmuseum entity links returned by upstream JSON-LD", async () => {
    const calls: Request[] = [];
    const provider = new RijksmuseumProvider({ fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      const url = new URL(call.url);
      if (url.pathname === "/search/collection") return Response.json({ orderedItems: [{ id: "https://id.rijksmuseum.nl/200100000" }] });
      if (url.pathname === "/200100000" && url.searchParams.get("_profile") === "la-framed") return Response.json({ shows: [{ id: "http://127.0.0.1/private" }] });
      throw new Error(`unexpected outbound request: ${call.url}`);
    } });

    await expect(provider.search(request, AbortSignal.timeout(1_000))).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => new URL(call.url).hostname === "data.rijksmuseum.nl")).toBe(true);
    expect(calls[2]!.redirect).toBe("error");
  });

  it("keeps scheme-relative-looking Rijksmuseum identity paths on the trusted data host", async () => {
    const calls: Request[] = [];
    const provider = new RijksmuseumProvider({ fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      const url = new URL(call.url);
      if (url.pathname === "/search/collection") return Response.json({ orderedItems: [{ id: "https://id.rijksmuseum.nl/200100000" }] });
      if (url.pathname === "/200100000") return Response.json({ shows: [{ id: "https://id.rijksmuseum.nl//127.0.0.1/private" }] });
      if (url.hostname === "data.rijksmuseum.nl" && url.pathname === "//127.0.0.1/private") return Response.json({});
      throw new Error(`unexpected outbound request: ${call.url}`);
    } });

    await expect(provider.search(request, AbortSignal.timeout(1_000))).resolves.toEqual([]);
    expect(calls.every((call) => new URL(call.url).hostname === "data.rijksmuseum.nl")).toBe(true);
  });

  it("accepts only the documented Rijksmuseum IIIF image origin", async () => {
    const provider = new RijksmuseumProvider({ fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/search/collection") return Response.json({ orderedItems: [{ id: "https://id.rijksmuseum.nl/1" }] });
      if (url.pathname === "/1") return Response.json({ shows: [{ id: "https://id.rijksmuseum.nl/2" }] });
      if (url.pathname === "/2") return Response.json({ digitally_shown_by: [{ id: "https://id.rijksmuseum.nl/3" }] });
      return Response.json({ access_point: [{ id: "https://example.test/attacker-controlled-image" }] });
    } });

    await expect(provider.search(request, AbortSignal.timeout(1_000))).resolves.toEqual([]);
  });
});
