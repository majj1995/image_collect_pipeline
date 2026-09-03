import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface ArticOptions { fetch?: typeof globalThis.fetch; }

const USER_AGENT = "MultimodalDataExpansion/1.0 (local image collection tool)";
const ARTWORK_FIELDS = "id,title,image_id,thumbnail,artist_display,date_display,is_public_domain,copyright_notice,credit_line";

export class ArticProvider implements ImageSearchProvider {
  public readonly id = "artic" as const;
  public readonly displayName = "Art Institute of Chicago";
  public readonly rightsPolicy = "open" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "匿名公开 API；官方建议图片串行下载";
  public readonly docsUrl = "https://api.artic.edu/docs/";
  public readonly defaultSelected = false;
  public readonly configured = false;
  public readonly maxResults = 100;
  public readonly supportsPagination = true;
  public readonly downloadPolicy = { maxConcurrency: 1, minimumIntervalMs: 1000 } as const;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 100 && Number.isSafeInteger(count) && count > 0;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: ArticOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://api.artic.edu/api/v1/artworks/search");
    endpoint.searchParams.set("q", request.query);
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("limit", String(count));
    endpoint.searchParams.set("fields", ARTWORK_FIELDS);
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT }
    });
    const config = isRecord(body.config) ? body.config : {};
    const iiifBase = safeHttpUrl(config.iiif_url)?.replace(/\/$/u, "") ?? null;
    if (!iiifBase) return [];
    const results = Array.isArray(body.data) ? body.data : [];
    const hits: NormalizedHit[] = [];
    for (const value of results) {
      if (!isRecord(value)) continue;
      const id = numberValue(value.id);
      const imageId = stringValue(value.image_id);
      if (id === null || !imageId) continue;
      const encodedImageId = encodeURIComponent(imageId);
      const imageUrl = safeHttpUrl(`${iiifBase}/${encodedImageId}/full/843,/0/default.jpg`);
      if (!imageUrl) continue;
      const thumbnail = isRecord(value.thumbnail) ? value.thumbnail : {};
      const isPublicDomain = value.is_public_domain === true;
      hits.push({
        provider: this.id,
        rank: hits.length + 1,
        imageUrl,
        thumbnailUrl: safeHttpUrl(`${iiifBase}/${encodedImageId}/full/400,/0/default.jpg`) ?? imageUrl,
        landingPageUrl: `https://www.artic.edu/artworks/${id}`,
        title: stringValue(value.title),
        creator: stringValue(value.artist_display),
        licenseName: isPublicDomain ? "Public Domain" : stringValue(value.copyright_notice),
        licenseUrl: isPublicDomain ? "https://creativecommons.org/publicdomain/mark/1.0/" : null,
        width: numberValue(thumbnail.width),
        height: numberValue(thumbnail.height),
        sourceProvider: "Art Institute of Chicago",
        source: String(id),
        rightsStatus: isPublicDomain ? "provider_claimed" : "unknown"
      });
      if (hits.length >= count) break;
    }
    return hits;
  }
}
