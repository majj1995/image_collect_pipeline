import { sanitizePublicText } from "../../shared/public-url.js";
import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { ProviderError } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl } from "./common.js";

interface FlickrOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }

interface SelectedFlickrImage {
  imageUrl: string;
  width: number | null;
  height: number | null;
}

function selectedImage(photo: Record<string, unknown>): SelectedFlickrImage | null {
  const original = safeHttpUrl(photo.url_o);
  if (original) return { imageUrl: original, width: numberValue(photo.width_o), height: numberValue(photo.height_o) };
  const large = safeHttpUrl(photo.url_l);
  if (large) return { imageUrl: large, width: numberValue(photo.width_l), height: numberValue(photo.height_l) };
  const medium = safeHttpUrl(photo.url_c);
  return medium ? { imageUrl: medium, width: numberValue(photo.width_c), height: numberValue(photo.height_c) } : null;
}

export class FlickrProvider implements ImageSearchProvider {
  public readonly id = "flickr" as const;
  public readonly displayName = "Flickr";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["FLICKR_API_KEY"] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "免费非商业 API Key；搜索结果限制在前 4,000 条";
  public readonly docsUrl = "https://www.flickr.com/services/api/flickr.photos.search.html";
  public readonly defaultSelected = false;
  public readonly configured: boolean;
  public readonly maxResults = 500;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger(count) && count > 0 && (page - 1) * count < 4_000;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: FlickrOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if (!this.apiKey) return [];
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://www.flickr.com/services/rest/");
    endpoint.searchParams.set("method", "flickr.photos.search");
    endpoint.searchParams.set("api_key", this.apiKey);
    endpoint.searchParams.set("text", request.query);
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("per_page", String(count));
    endpoint.searchParams.set("media", "photos");
    endpoint.searchParams.set("sort", "relevance");
    endpoint.searchParams.set("safe_search", request.safeSearch ? "1" : "3");
    endpoint.searchParams.set("content_type", "7");
    endpoint.searchParams.set("extras", "url_o,url_l,url_c,owner_name,o_dims,license");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("nojsoncallback", "1");
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json" }
    });
    if (body.stat !== "ok") throw new ProviderError(this.id, null, false);
    const photosEnvelope = isRecord(body.photos) ? body.photos : {};
    const photos = Array.isArray(photosEnvelope.photo) ? photosEnvelope.photo : [];
    return photos.flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const selected = selectedImage(value);
      if (!selected) return [];
      const owner = sanitizePublicText(value.owner);
      const id = sanitizePublicText(value.id);
      const landingPageUrl = owner && id
        ? safeHttpUrl(`https://www.flickr.com/photos/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`)
        : null;
      const license = sanitizePublicText(value.license);
      return [{
        provider: this.id,
        rank: index + 1,
        imageUrl: selected.imageUrl,
        thumbnailUrl: safeHttpUrl(value.url_c) ?? selected.imageUrl,
        landingPageUrl,
        title: sanitizePublicText(value.title),
        creator: sanitizePublicText(value.ownername),
        licenseName: license ? `Flickr license ${license}` : null,
        licenseUrl: null,
        width: selected.width,
        height: selected.height,
        sourceProvider: "Flickr",
        source: id,
        rightsStatus: "unknown"
      }];
    });
  }
}
