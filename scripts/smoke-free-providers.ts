import { loadConfig, prepareEnvironmentProxy } from "../src/server/config.js";
import { createDefaultProviderRegistry } from "../src/server/providers/registry.js";
import type { ImageSearchProvider, NormalizedHit } from "../src/server/providers/types.js";
import { inspectImage } from "../src/server/services/asset-service.js";
import { fetchImageWithPolicy } from "../src/server/services/safe-url.js";

const queries: Record<string, string[]> = {
  openverse: ["speaker advertisement", "advertising poster"],
  wikimedia: ["advertising poster", "speaker"],
  met: ["advertisement", "poster"],
  cleveland: ["advertisement", "poster"],
  artic: ["advertisement", "poster"],
  loc: ["radio advertisement", "advertising poster"],
  nasa: ["Earth", "Apollo"],
  internet_archive: ["speaker advertisement", "advertising poster"],
  open_food_facts: ["Coca Cola", "chocolate"],
  smithsonian: ["advertisement", "radio"],
  rijksmuseum: ["poster", "advertisement"],
  bing_ads: ["speaker", "Nike"],
  snap_ads: ["Badger", "Nike", "Coca-Cola"]
};

const expected = Object.keys(queries);
const environmentProxy = prepareEnvironmentProxy(process.env);

async function firstHit(provider: ImageSearchProvider): Promise<{ hit: NormalizedHit; query: string } | null> {
  for (const query of queries[provider.id] ?? ["advertisement"]) {
    const hits = await provider.search({ query, count: 1, locale: "en-US", safeSearch: true, page: 1 }, AbortSignal.timeout(30_000));
    if (hits[0]) return { hit: hits[0], query };
  }
  return null;
}

async function probeDownload(hit: NormalizedHit, provider: ImageSearchProvider): Promise<{ bytes: number; contentType: string | null }> {
  const response = await fetchImageWithPolicy(hit.transientImageUrl ?? hit.imageUrl, {
    fetch: environmentProxy?.fetch,
    timeoutMs: 30_000,
    maxBytes: 25_000_000,
    userAgent: provider.downloadPolicy?.userAgent
  });
  await inspectImage(response.bytes);
  return { bytes: response.bytes.length, contentType: response.contentType };
}

async function check(provider: ImageSearchProvider): Promise<Record<string, unknown>> {
  const started = Date.now();
  try {
    const found = await firstHit(provider);
    if (!found) return { provider: provider.id, status: "EMPTY", durationMs: Date.now() - started };
    const probe = await probeDownload(found.hit, provider);
    return {
      provider: provider.id,
      status: "PASS",
      query: found.query,
      imageHost: new URL(found.hit.imageUrl).hostname,
      bytesProbed: probe.bytes,
      contentType: probe.contentType,
      durationMs: Date.now() - started
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown failure";
    return { provider: provider.id, status: "FAIL", detail: detail.slice(0, 180), durationMs: Date.now() - started };
  }
}

const config = loadConfig(process.env);
const registry = createDefaultProviderRegistry(config.credentials, environmentProxy?.fetch, config.wikimediaUserAgent);
const providers = expected
  .map((id) => registry.list().find((provider) => provider.id === id))
  .filter((provider): provider is ImageSearchProvider => Boolean(provider && registry.isEnabled(provider)));
const results: Array<Record<string, unknown>> = [];
for (let offset = 0; offset < providers.length; offset += 3) {
  const batch = await Promise.all(providers.slice(offset, offset + 3).map(check));
  for (const result of batch) {
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
const failed = results.filter((result) => result.status !== "PASS");
process.stdout.write(`${JSON.stringify({ summary: { passed: results.length - failed.length, total: results.length, failed: failed.map((result) => result.provider) } })}\n`);
if (failed.length) process.exitCode = 1;
await environmentProxy?.close();
