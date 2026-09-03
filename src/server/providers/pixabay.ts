import { sanitizePublicText } from "../../shared/public-url.js";
import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, localeOptions, numberValue, requestJson, safeHttpUrl } from "./common.js";

interface PixabayOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }

const PIXABAY_LANGUAGES = new Set(["bg", "cs", "da", "de", "el", "en", "es", "fi", "fr", "hu", "id", "it", "ja", "ko", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "th", "tr", "vi", "zh"]);

function publicId(value: unknown): string | null {
  const numeric = numberValue(value);
  return numeric === null ? sanitizePublicText(value) : String(numeric);
}

export class PixabayProvider implements ImageSearchProvider {
  public readonly id = "pixabay" as const;
  public readonly displayName = "Pixabay";
  public readonly rightsPolicy = "contractual" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["PIXABAY_API_KEY"] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "免费账户 API Key；单次最多 200 条、每个查询最多 500 条";
  public readonly docsUrl = "https://pixabay.com/api/docs/";
  public readonly defaultSelected = false;
  public readonly configured: boolean;
  public readonly maxResults = 200;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger(count) && count > 0 && (page - 1) * count < 500;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: PixabayOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if (!this.apiKey) return [];
    const count = cappedCount(request, this.maxResults);
    const pageSize = Math.max(3, count);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const logicalOffset = (page - 1) * count;
    const firstPage = Math.floor(logicalOffset / pageSize) + 1;
    const firstPageOffset = logicalOffset % pageSize;
    const pagesNeeded = Math.ceil((firstPageOffset + count) / pageSize);
    const language = localeOptions(request.locale).language;
    const hits: unknown[] = [];
    for (let pageIndex = 0; pageIndex < pagesNeeded; pageIndex += 1) {
      const endpoint = new URL("https://pixabay.com/api/");
      endpoint.searchParams.set("q", Array.from(request.query).slice(0, 100).join(""));
      endpoint.searchParams.set("lang", PIXABAY_LANGUAGES.has(language) ? language : "en");
      endpoint.searchParams.set("image_type", "all");
      endpoint.searchParams.set("safesearch", request.safeSearch ? "true" : "false");
      endpoint.searchParams.set("page", String(firstPage + pageIndex));
      endpoint.searchParams.set("per_page", String(pageSize));
      endpoint.searchParams.set("key", this.apiKey);
      const body = await requestJson(this.id, this.fetchImpl, endpoint, {
        signal,
        headers: { accept: "application/json" }
      });
      const pageHits = Array.isArray(body.hits) ? body.hits : [];
      hits.push(...pageHits);
      if (pageHits.length < pageSize) break;
    }
    return hits.slice(firstPageOffset, firstPageOffset + count).flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const largeImageUrl = safeHttpUrl(value.largeImageURL);
      const webImageUrl = safeHttpUrl(value.webformatURL);
      const imageUrl = largeImageUrl ?? webImageUrl;
      if (!imageUrl) return [];
      return [{
        provider: this.id,
        rank: index + 1,
        imageUrl,
        thumbnailUrl: safeHttpUrl(value.previewURL) ?? webImageUrl ?? imageUrl,
        landingPageUrl: safeHttpUrl(value.pageURL),
        title: sanitizePublicText(value.tags),
        creator: sanitizePublicText(value.user),
        licenseName: null,
        licenseUrl: null,
        width: numberValue(largeImageUrl ? value.imageWidth : value.webformatWidth),
        height: numberValue(largeImageUrl ? value.imageHeight : value.webformatHeight),
        sourceProvider: "Pixabay",
        source: publicId(value.id),
        rightsStatus: "unknown"
      }];
    });
  }
}
