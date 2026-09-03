import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface MetOptions { fetch?: typeof globalThis.fetch; }

export class MetProvider implements ImageSearchProvider {
  public readonly id = "met" as const;
  public readonly displayName = "The Metropolitan Museum of Art";
  public readonly rightsPolicy = "open" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "免 Key，官方限速 80 请求/秒";
  public readonly docsUrl = "https://metmuseum.github.io/";
  public readonly defaultSelected = false;
  public readonly configured = false;
  public readonly maxResults = 20;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 10_000 && Number.isSafeInteger(count) && count > 0;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: MetOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://collectionapi.metmuseum.org/public/collection/v1/search");
    endpoint.searchParams.set("hasImages", "true");
    endpoint.searchParams.set("q", request.query);
    const search = await requestJson(this.id, this.fetchImpl, endpoint, { signal, headers: { accept: "application/json" } });
    const ids = (Array.isArray(search.objectIDs) ? search.objectIDs : [])
      .flatMap((value): Array<string | number> => typeof value === "string" || typeof value === "number" ? [value] : []);
    const offset = (page - 1) * count;
    const details: Array<Record<string, unknown>> = [];
    let firstFailure: unknown;
    let detailSuccesses = 0;
    for (const id of ids.slice(offset, offset + count)) {
      try {
        details.push(await requestJson(this.id, this.fetchImpl, `https://collectionapi.metmuseum.org/public/collection/v1/objects/${encodeURIComponent(String(id))}`, {
          signal,
          headers: { accept: "application/json" }
        }));
        detailSuccesses += 1;
      } catch (error) {
        if (signal.aborted) throw error;
        firstFailure ??= error;
      }
    }
    if (detailSuccesses === 0 && firstFailure) throw firstFailure;
    return details.flatMap((detail, index): NormalizedHit[] => {
      const imageUrl = safeHttpUrl(detail.primaryImage);
      if (!imageUrl) return [];
      const isPublicDomain = detail.isPublicDomain === true;
      return [{
        provider: this.id,
        rank: index + 1,
        imageUrl,
        thumbnailUrl: safeHttpUrl(detail.primaryImageSmall) ?? imageUrl,
        landingPageUrl: safeHttpUrl(detail.objectURL),
        title: stringValue(detail.title),
        creator: stringValue(detail.artistDisplayName),
        licenseName: isPublicDomain ? "cc0" : null,
        licenseUrl: isPublicDomain ? "https://creativecommons.org/publicdomain/zero/1.0/" : null,
        width: numberValue(detail.width),
        height: numberValue(detail.height),
        sourceProvider: "The Metropolitan Museum of Art",
        source: stringValue(detail.objectID) ?? (typeof detail.objectID === "number" ? String(detail.objectID) : null),
        rightsStatus: isPublicDomain ? "provider_claimed" : "unknown"
      }];
    });
  }
}
