import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, localeOptions, numberValue, providerEnvelopeError, requestJson, safeHttpUrl, stringValue } from "./common.js";
import { siteScopedPlatformQuery } from "./platform-query.js";

interface SerpApiOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }

export class SerpApiProvider implements ImageSearchProvider {
  public readonly id = "serpapi" as const;
  public readonly displayName = "SerpApi Google Images";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["SERPAPI_API_KEY"] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "免费账户月度额度，以 SerpApi 控制台当期规则为准";
  public readonly docsUrl = "https://serpapi.com/images-results";
  public readonly defaultSelected = false;
  public readonly maxResults = 200;
  public readonly supportsPagination = true;
  public readonly buildPlatformQuery = siteScopedPlatformQuery;
  public readonly canRequestPage = (page: number): boolean => Number.isSafeInteger(page) && page >= 1 && page <= 100;
  public readonly configured: boolean;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: SerpApiOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const page = request.page ?? 1;
    if (!this.canRequestPage(page)) return [];
    const locale = localeOptions(request.locale);
    const endpoint = new URL("https://serpapi.com/search.json");
    endpoint.searchParams.set("engine", "google_images");
    endpoint.searchParams.set("q", request.query);
    endpoint.searchParams.set("api_key", this.apiKey ?? "");
    endpoint.searchParams.set("hl", locale.language);
    endpoint.searchParams.set("gl", locale.country.toLowerCase());
    endpoint.searchParams.set("safe", request.safeSearch ? "active" : "off");
    endpoint.searchParams.set("ijn", String(page - 1));
    const body = await requestJson(this.id, this.fetchImpl, endpoint, { signal, headers: { accept: "application/json" } });
    if (body.error !== undefined && body.error !== null && body.error !== "") throw providerEnvelopeError(this.id, null);
    const results = Array.isArray(body.images_results) ? body.images_results : [];
    return results.slice(0, cappedCount(request, this.maxResults)).flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const imageUrl = safeHttpUrl(value.original);
      if (!imageUrl) return [];
      return [{
        provider: this.id, rank: numberValue(value.position) ?? index + 1, imageUrl, thumbnailUrl: safeHttpUrl(value.thumbnail),
        landingPageUrl: safeHttpUrl(value.link), title: stringValue(value.title), creator: null,
        licenseName: null, licenseUrl: null, width: numberValue(value.original_width), height: numberValue(value.original_height),
        sourceProvider: stringValue(value.source), source: stringValue(value.source), rightsStatus: "unknown"
      }];
    });
  }
}
