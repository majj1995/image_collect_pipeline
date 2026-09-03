import { sanitizePublicText } from "../../shared/public-url.js";
import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl } from "./common.js";

interface UnsplashOptions { accessKey?: string; fetch?: typeof globalThis.fetch; }

export class UnsplashProvider implements ImageSearchProvider {
  public readonly id = "unsplash" as const;
  public readonly displayName = "Unsplash";
  public readonly rightsPolicy = "contractual" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["UNSPLASH_ACCESS_KEY"] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "免费 Demo 应用额度；需注册开发者应用";
  public readonly docsUrl = "https://unsplash.com/documentation#search-photos";
  public readonly defaultSelected = false;
  public readonly configured: boolean;
  public readonly maxResults = 30;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 1_000 && Number.isSafeInteger(count) && count > 0;
  private readonly accessKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: UnsplashOptions = {}) {
    this.accessKey = options.accessKey?.trim() || undefined;
    this.configured = Boolean(this.accessKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if (!this.accessKey) return [];
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://api.unsplash.com/search/photos");
    endpoint.searchParams.set("query", request.query);
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("per_page", String(count));
    endpoint.searchParams.set("content_filter", request.safeSearch ? "high" : "low");
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", Authorization: `Client-ID ${this.accessKey}` }
    });
    const results = Array.isArray(body.results) ? body.results : [];
    return results.flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const urls = isRecord(value.urls) ? value.urls : {};
      const links = isRecord(value.links) ? value.links : {};
      const user = isRecord(value.user) ? value.user : {};
      const imageUrl = safeHttpUrl(urls.full) ?? safeHttpUrl(urls.regular);
      if (!imageUrl) return [];
      return [{
        provider: this.id,
        rank: index + 1,
        imageUrl,
        thumbnailUrl: safeHttpUrl(urls.small) ?? safeHttpUrl(urls.thumb) ?? safeHttpUrl(urls.regular) ?? imageUrl,
        landingPageUrl: safeHttpUrl(links.html),
        title: sanitizePublicText(value.description) ?? sanitizePublicText(value.alt_description),
        creator: sanitizePublicText(user.name) ?? sanitizePublicText(user.username),
        licenseName: null,
        licenseUrl: null,
        width: numberValue(value.width),
        height: numberValue(value.height),
        sourceProvider: "Unsplash",
        source: sanitizePublicText(value.id),
        rightsStatus: "unknown"
      }];
    });
  }
}
