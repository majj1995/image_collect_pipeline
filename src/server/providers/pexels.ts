import { sanitizePublicText } from "../../shared/public-url.js";
import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl } from "./common.js";

interface PexelsOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }

const PEXELS_LOCALES = new Set([
  "ca-ES", "cs-CZ", "da-DK", "de-DE", "el-GR", "en-US", "es-ES", "fi-FI", "fr-FR", "hu-HU", "id-ID", "it-IT",
  "ja-JP", "ko-KR", "nb-NO", "nl-NL", "pl-PL", "pt-BR", "ro-RO", "ru-RU", "sk-SK", "sv-SE", "th-TH", "tr-TR", "uk-UA",
  "vi-VN", "zh-CN", "zh-TW"
]);

function publicText(value: unknown): string | null {
  return sanitizePublicText(value);
}

function publicId(value: unknown): string | null {
  const numeric = numberValue(value);
  return numeric === null ? publicText(value) : String(numeric);
}

export class PexelsProvider implements ImageSearchProvider {
  public readonly id = "pexels" as const;
  public readonly displayName = "Pexels";
  public readonly rightsPolicy = "contractual" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["PEXELS_API_KEY"] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "免费开发者 API Key；受官方请求速率限制";
  public readonly docsUrl = "https://www.pexels.com/api/documentation/";
  public readonly defaultSelected = false;
  public readonly configured: boolean;
  public readonly maxResults = 80;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 1_000 && Number.isSafeInteger(count) && count > 0;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: PexelsOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if (!this.apiKey) return [];
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://api.pexels.com/v1/search");
    endpoint.searchParams.set("query", request.query);
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("per_page", String(count));
    if (PEXELS_LOCALES.has(request.locale)) endpoint.searchParams.set("locale", request.locale);
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", Authorization: this.apiKey }
    });
    const photos = Array.isArray(body.photos) ? body.photos : [];
    return photos.flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const src = isRecord(value.src) ? value.src : {};
      const imageUrl = safeHttpUrl(src.original) ?? safeHttpUrl(src.large);
      if (!imageUrl) return [];
      const source = publicId(value.id);
      return [{
        provider: this.id,
        rank: index + 1,
        imageUrl,
        thumbnailUrl: safeHttpUrl(src.medium) ?? safeHttpUrl(src.small) ?? safeHttpUrl(src.large) ?? imageUrl,
        landingPageUrl: safeHttpUrl(value.url),
        title: publicText(value.alt),
        creator: publicText(value.photographer),
        licenseName: null,
        licenseUrl: null,
        width: numberValue(value.width),
        height: numberValue(value.height),
        sourceProvider: "Pexels",
        source,
        rightsStatus: "unknown"
      }];
    });
  }
}
