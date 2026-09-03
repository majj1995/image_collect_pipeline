import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl, stringValue } from "./common.js";
import { normalizeWikimediaUserAgent } from "../config.js";

interface WikimediaOptions {
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

function metadataText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const text = stringValue(value.value);
  return text?.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim() || null;
}

export class WikimediaProvider implements ImageSearchProvider {
  public readonly id = "wikimedia" as const;
  public readonly displayName = "Wikimedia Commons";
  public readonly rightsPolicy = "open" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = ["WIKIMEDIA_USER_AGENT"] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "免 API Key；需配置 WIKIMEDIA_USER_AGENT，并包含联系 URL、邮箱或 Wikimedia User:用户名";
  public readonly docsUrl = "https://www.mediawiki.org/wiki/API:Imageinfo";
  public readonly defaultSelected = true;
  public readonly requiresConfiguration = true;
  public readonly configured: boolean;
  public readonly maxResults = 50;
  public readonly supportsPagination = true;
  public readonly downloadPolicy?: { readonly maxConcurrency: 1; readonly minimumIntervalMs: 1000; readonly userAgent: string };
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 200 && Number.isSafeInteger(count) && count > 0;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly userAgent?: string;

  public constructor(options: WikimediaOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = normalizeWikimediaUserAgent(options.userAgent);
    this.configured = this.userAgent !== undefined;
    this.downloadPolicy = this.userAgent
      ? { maxConcurrency: 1, minimumIntervalMs: 1000, userAgent: this.userAgent }
      : undefined;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if (!this.userAgent) throw new Error("Wikimedia Commons 未配置：请设置包含联系 URL、邮箱或 Wikimedia User:用户名的 WIKIMEDIA_USER_AGENT。");
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://commons.wikimedia.org/w/api.php");
    endpoint.searchParams.set("action", "query");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("formatversion", "2");
    endpoint.searchParams.set("generator", "search");
    endpoint.searchParams.set("gsrsearch", request.query);
    endpoint.searchParams.set("gsrnamespace", "6");
    endpoint.searchParams.set("gsrlimit", String(count));
    endpoint.searchParams.set("gsroffset", String((page - 1) * count));
    endpoint.searchParams.set("prop", "imageinfo");
    endpoint.searchParams.set("iiprop", "url|size|mime|mediatype|extmetadata");
    endpoint.searchParams.set("iiurlwidth", "1024");
    endpoint.searchParams.set("iiextmetadatalanguage", "en");
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", "user-agent": this.userAgent }
    });
    const query = isRecord(body.query) ? body.query : {};
    const pages = Array.isArray(query.pages) ? query.pages : [];
    const hits: NormalizedHit[] = [];
    for (const pageValue of pages) {
      if (!isRecord(pageValue)) continue;
      const imageInfo = Array.isArray(pageValue.imageinfo) && isRecord(pageValue.imageinfo[0]) ? pageValue.imageinfo[0] : null;
      if (!imageInfo || stringValue(imageInfo.mediatype)?.toUpperCase() !== "BITMAP") continue;
      const originalUrl = safeHttpUrl(imageInfo.url);
      const thumbnailUrl = safeHttpUrl(imageInfo.thumburl);
      const originalSupported = SUPPORTED_IMAGE_MIMES.has(stringValue(imageInfo.mime)?.toLowerCase() ?? "");
      const thumbnailSupported = SUPPORTED_IMAGE_MIMES.has(stringValue(imageInfo.thumbmime)?.toLowerCase() ?? "");
      const imageUrl = originalSupported ? originalUrl : thumbnailSupported ? thumbnailUrl : null;
      if (!imageUrl) continue;
      const selectedThumbnailUrl = thumbnailSupported && thumbnailUrl ? thumbnailUrl : imageUrl;
      const usesThumbnailAsPrimary = imageUrl === thumbnailUrl && !originalSupported;
      const metadata = isRecord(imageInfo.extmetadata) ? imageInfo.extmetadata : {};
      const licenseName = metadataText(metadata.LicenseShortName);
      hits.push({
        provider: this.id,
        rank: hits.length + 1,
        imageUrl,
        thumbnailUrl: selectedThumbnailUrl,
        landingPageUrl: safeHttpUrl(imageInfo.descriptionurl),
        title: metadataText(metadata.ImageDescription) ?? stringValue(pageValue.title),
        creator: metadataText(metadata.Artist),
        licenseName,
        licenseUrl: safeHttpUrl(isRecord(metadata.LicenseUrl) ? metadata.LicenseUrl.value : null),
        width: numberValue(usesThumbnailAsPrimary ? imageInfo.thumbwidth : imageInfo.width),
        height: numberValue(usesThumbnailAsPrimary ? imageInfo.thumbheight : imageInfo.height),
        sourceProvider: "Wikimedia Commons",
        source: stringValue(pageValue.title),
        rightsStatus: licenseName ? "provider_claimed" : "unknown"
      });
      if (hits.length >= count) break;
    }
    return hits;
  }
}
