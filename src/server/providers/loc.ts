import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface LocOptions { fetch?: typeof globalThis.fetch; }

const USER_AGENT = "MultimodalDataExpansion/1.0 (local image collection tool)";

function locUrl(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  const expanded = text.startsWith("//") ? `https:${text}` : text;
  const safe = safeHttpUrl(expanded);
  if (!safe) return null;
  const url = new URL(safe);
  if (url.protocol === "http:" && (url.hostname === "loc.gov" || url.hostname === "www.loc.gov")) url.protocol = "https:";
  return url.toString();
}

function imageScore(url: string, fallback: number): number {
  const pixels = url.match(/(?:_|\/)(\d+)px(?:\.|\/)/iu)?.[1];
  if (pixels) return Number(pixels);
  const percent = url.match(/pct:(\d+(?:\.\d+)?)/iu)?.[1];
  if (percent) return Number(percent);
  return fallback;
}

function contributor(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const candidate of value) {
    const direct = stringValue(candidate);
    if (direct) return direct;
    if (isRecord(candidate)) {
      const key = Object.keys(candidate)[0];
      if (key) return key;
    }
  }
  return null;
}

export class LocProvider implements ImageSearchProvider {
  public readonly id = "loc" as const;
  public readonly displayName = "Library of Congress";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "匿名公开 JSON API，服务端动态限流";
  public readonly docsUrl = "https://www.loc.gov/apis/json-and-yaml/";
  public readonly defaultSelected = false;
  public readonly configured = false;
  public readonly maxResults = 100;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 1_000 && Number.isSafeInteger(count) && count > 0;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: LocOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://www.loc.gov/photos/");
    endpoint.searchParams.set("fo", "json");
    endpoint.searchParams.set("q", request.query);
    endpoint.searchParams.set("c", String(count));
    endpoint.searchParams.set("sp", String(page));
    endpoint.searchParams.set("at", "results,pagination");
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT }
    });
    const results = Array.isArray(body.results) ? body.results : [];
    const hits: NormalizedHit[] = [];
    for (const value of results) {
      if (!isRecord(value) || !Array.isArray(value.image_url)) continue;
      const urls = value.image_url.map(locUrl).filter((url): url is string => Boolean(url));
      if (!urls.length) continue;
      const scored = urls.map((url, index) => ({ url, score: imageScore(url, index) }));
      const thumbnailUrl = scored.reduce((smallest, item) => item.score < smallest.score ? item : smallest).url;
      const imageUrl = scored.reduce((largest, item) => item.score > largest.score ? item : largest).url;
      const landingPageUrl = locUrl(value.url ?? value.id);
      hits.push({
        provider: this.id,
        rank: hits.length + 1,
        imageUrl,
        thumbnailUrl,
        landingPageUrl,
        title: stringValue(value.title),
        creator: contributor(value.contributor),
        licenseName: null,
        licenseUrl: null,
        width: null,
        height: null,
        sourceProvider: "Library of Congress",
        source: locUrl(value.id) ?? landingPageUrl,
        rightsStatus: "unknown"
      });
      if (hits.length >= count) break;
    }
    return hits;
  }
}
