import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, localeOptions, numberValue, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface BraveOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }

export class BraveProvider implements ImageSearchProvider {
  public readonly id = "brave" as const;
  public readonly displayName = "Brave Images";
  public readonly rightsPolicy = "contractual" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["BRAVE_SEARCH_API_KEY"] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "非持续免费来源，仅保留旧数据兼容";
  public readonly docsUrl = "https://api-dashboard.search.brave.com/app/documentation/image-search/get-started";
  public readonly defaultSelected = false;
  public readonly maxResults = 200;
  public readonly supportsPagination = false;
  public readonly configured: boolean;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: BraveOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const locale = localeOptions(request.locale);
    const endpoint = new URL("https://api.search.brave.com/res/v1/images/search");
    endpoint.searchParams.set("q", request.query);
    endpoint.searchParams.set("count", String(cappedCount(request, this.maxResults)));
    endpoint.searchParams.set("country", locale.country);
    endpoint.searchParams.set("search_lang", locale.language);
    endpoint.searchParams.set("safesearch", request.safeSearch ? "strict" : "off");
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal, headers: { accept: "application/json", "X-Subscription-Token": this.apiKey ?? "" }
    });
    const results = Array.isArray(body.results) ? body.results : [];
    return results.flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const properties = isRecord(value.properties) ? value.properties : {};
      const thumbnail = isRecord(value.thumbnail) ? value.thumbnail : {};
      const imageUrl = safeHttpUrl(properties.url);
      if (!imageUrl) return [];
      return [{
        provider: this.id, rank: index + 1, imageUrl, thumbnailUrl: safeHttpUrl(thumbnail.src),
        landingPageUrl: safeHttpUrl(value.url), title: stringValue(value.title), creator: null,
        licenseName: null, licenseUrl: null, width: numberValue(properties.width), height: numberValue(properties.height),
        sourceProvider: stringValue(value.source), source: stringValue(value.source), rightsStatus: "unknown"
      }];
    });
  }
}
