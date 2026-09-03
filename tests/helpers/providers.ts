import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageSearchProvider, NormalizedHit } from "../../src/server/providers/types.js";
import type { ProviderId } from "../../src/shared/contracts.js";

const fixtureDirectory = join(process.cwd(), "tests", "fixtures", "providers");

export function fixtureFetch(name: string): typeof fetch {
  return async () => new Response(await readFile(join(fixtureDirectory, name), "utf8"), {
    headers: { "content-type": "application/json" }
  });
}

export function recordingFixtureFetch(calls: Request[], name = "openverse.json"): typeof fetch {
  const fetchFixture = fixtureFetch(name);
  return async (input, init) => {
    calls.push(new Request(input, init).clone());
    return fetchFixture(input, init);
  };
}

function hits(id: ProviderId, count: number): NormalizedHit[] {
  return Array.from({ length: count }, (_, index) => ({
    provider: id,
    rank: index + 1,
    thumbnailUrl: `https://images.example.test/${id}-${index + 1}-thumb.jpg`,
    imageUrl: `https://images.example.test/${id}-${index + 1}.jpg`,
    landingPageUrl: `https://source.example.test/${id}-${index + 1}`,
    title: `${id} result ${index + 1}`,
    creator: null,
    licenseName: null,
    licenseUrl: null,
    width: 1200,
    height: 900,
    sourceProvider: id,
    source: id,
    rightsStatus: "unknown"
  }));
}

export function successfulFakeProvider(id: ProviderId, count: number): ImageSearchProvider {
  return {
    id,
    displayName: `${id} fake`,
    rightsPolicy: "open",
    configured: true,
    maxResults: 100,
    supportsPagination: true,
    async search() { return hits(id, count); }
  };
}

export function failingFakeProvider(id: ProviderId, status: number): ImageSearchProvider {
  return {
    id,
    displayName: `${id} failing fake`,
    rightsPolicy: "open",
    configured: true,
    maxResults: 100,
    supportsPagination: true,
    async search() { throw new Error(`Provider request failed (${status})`); }
  };
}
