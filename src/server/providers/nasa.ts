import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface NasaOptions { fetch?: typeof globalThis.fetch; }

function imageHref(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const href = safeHttpUrl(value.href);
  return href && /\.(?:jpe?g|png|webp)(?:$|\?)/iu.test(href) ? href : null;
}

function assetPriority(url: string): number {
  if (/~orig\./iu.test(url)) return 4;
  if (/~large\./iu.test(url)) return 3;
  if (/~medium\./iu.test(url)) return 2;
  if (/~small\./iu.test(url)) return 1;
  return 0;
}

export class NasaProvider implements ImageSearchProvider {
  public readonly id = "nasa" as const;
  public readonly displayName = "NASA Image and Video Library";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "免 Key，官方未公布固定额度";
  public readonly docsUrl = "https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf";
  public readonly defaultSelected = false;
  public readonly configured = false;
  public readonly maxResults = 20;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number): boolean => Number.isSafeInteger(page) && page >= 1 && page <= 100;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: NasaOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const page = request.page ?? 1;
    if (!this.canRequestPage(page)) return [];
    const count = cappedCount(request, this.maxResults);
    const endpoint = new URL("https://images-api.nasa.gov/search");
    endpoint.searchParams.set("q", request.query);
    endpoint.searchParams.set("media_type", "image");
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("page_size", String(count));
    const body = await requestJson(this.id, this.fetchImpl, endpoint, { signal, headers: { accept: "application/json" } });
    const collection = isRecord(body.collection) ? body.collection : {};
    const items = Array.isArray(collection.items) ? collection.items.slice(0, count) : [];
    const resolved: NormalizedHit[] = [];
    for (const value of items) {
      if (!isRecord(value)) continue;
      const data = Array.isArray(value.data) && isRecord(value.data[0]) ? value.data[0] : null;
      if (!data) continue;
      const nasaId = stringValue(data.nasa_id);
      if (!nasaId) continue;
      const preview = (Array.isArray(value.links) ? value.links : [])
        .filter(isRecord)
        .find((link) => link.rel === "preview" || link.render === "image");
      const thumbnailUrl = preview ? safeHttpUrl(preview.href) : null;
      let imageUrl: string | null = null;
      try {
        const manifest = await requestJson(this.id, this.fetchImpl, `https://images-api.nasa.gov/asset/${encodeURIComponent(nasaId)}`, {
          signal,
          headers: { accept: "application/json" }
        });
        const manifestCollection = isRecord(manifest.collection) ? manifest.collection : {};
        const images = (Array.isArray(manifestCollection.items) ? manifestCollection.items : [])
          .map(imageHref)
          .filter((url): url is string => Boolean(url))
          .sort((left, right) => assetPriority(right) - assetPriority(left));
        imageUrl = images[0] ?? null;
      } catch (error) {
        if (signal.aborted) throw error;
      }
      imageUrl ??= thumbnailUrl;
      if (!imageUrl) continue;
      resolved.push({
        provider: this.id,
        rank: 0,
        imageUrl,
        thumbnailUrl: thumbnailUrl ?? imageUrl,
        landingPageUrl: `https://images.nasa.gov/details/${encodeURIComponent(nasaId)}`,
        title: stringValue(data.title),
        creator: stringValue(data.photographer) ?? stringValue(data.secondary_creator),
        licenseName: null,
        licenseUrl: null,
        width: null,
        height: null,
        sourceProvider: "NASA Image and Video Library",
        source: nasaId,
        rightsStatus: "unknown" as const
      });
    }
    return resolved.map((hit, index) => ({ ...hit, rank: index + 1 }));
  }
}
