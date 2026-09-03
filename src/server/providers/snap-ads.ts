import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, requestJson, safeHttpUrl, stringValue } from "./common.js";
import { ProviderError } from "./types.js";

interface SnapAdsOptions { fetch?: typeof globalThis.fetch; }

const SEARCH_ENDPOINT = "https://adsapi.snapchat.com/v1/ads_library/ads/search";
const MAX_CURSOR_PAGES_PER_SEARCH = 5;

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function trustedNextLink(value: unknown): string | null {
  const sanitized = safeHttpUrl(value);
  if (!sanitized) return null;
  const url = new URL(sanitized);
  if (url.origin !== "https://adsapi.snapchat.com" || url.pathname !== "/v1/ads_library/ads/search") return null;
  return url.toString();
}

function mediaUrls(value: unknown): { publicUrl: string; transientUrl?: string } | null {
  const transientUrl = safeHttpUrl(value);
  if (!transientUrl) return null;
  const parsed = new URL(transientUrl);
  const hasQuery = parsed.search.length > 0;
  parsed.search = "";
  const publicUrl = safeHttpUrl(parsed.toString());
  if (!publicUrl) return null;
  return hasQuery ? { publicUrl, transientUrl } : { publicUrl };
}

function webViewUrl(value: Record<string, unknown>): string | null {
  for (const key of ["web_view_preview", "web_view_properties"]) {
    const view = isRecord(value[key]) ? value[key] : {};
    const nested = isRecord(view.web_view_properties) ? view.web_view_properties : {};
    const url = safeHttpUrl(view.url) ?? safeHttpUrl(nested.url);
    if (url) return url;
  }
  return null;
}

function normalizeImagePreview(
  outer: Record<string, unknown>,
  mediaPreview: Record<string, unknown>,
  rank: number,
  source: string | null
): NormalizedHit | null {
  if (stringValue(mediaPreview.top_snap_media_type)?.toUpperCase() !== "IMAGE") return null;
  const media = mediaUrls(mediaPreview.top_snap_media_download_link);
  if (!media) return null;
  return {
    provider: "snap_ads",
    rank,
    imageUrl: media.publicUrl,
    ...(media.transientUrl ? { transientImageUrl: media.transientUrl } : {}),
    thumbnailUrl: media.publicUrl,
    landingPageUrl: webViewUrl(mediaPreview) ?? webViewUrl(outer),
    title: firstString(mediaPreview, ["headline", "name"]) ?? firstString(outer, ["headline", "name"]),
    creator: firstString(mediaPreview, ["paying_advertiser_name", "brand_name"]) ?? firstString(outer, ["paying_advertiser_name", "brand_name"]),
    licenseName: null,
    licenseUrl: null,
    width: null,
    height: null,
    sourceProvider: "Snap Ads Gallery",
    source,
    rightsStatus: "unknown"
  };
}

function normalizePreview(value: unknown, rank: number): NormalizedHit[] {
  if (!isRecord(value)) return [];
  const subRequestStatus = stringValue(value.sub_request_status);
  if (subRequestStatus && subRequestStatus !== "SUCCESS") return [];
  const preview = isRecord(value.ad_preview) ? value.ad_preview : null;
  if (!preview) return [];
  const outerId = stringValue(preview.id);
  const hits: NormalizedHit[] = [];
  const direct = normalizeImagePreview(preview, preview, rank, outerId);
  if (direct) hits.push(direct);
  const composite = isRecord(preview.composite_preview) ? preview.composite_preview : {};
  const snaps = Array.isArray(composite.ad_snaps) ? composite.ad_snaps : [];
  for (const [index, value] of snaps.entries()) {
    if (!isRecord(value)) continue;
    const snap = isRecord(value.ad_snap) ? value.ad_snap : value;
    const source = outerId ? `${outerId}:${index + 1}` : stringValue(snap.id);
    const hit = normalizeImagePreview(preview, snap, rank + hits.length, source);
    if (hit) hits.push(hit);
  }
  return hits;
}

export class SnapAdsProvider implements ImageSearchProvider {
  public readonly id = "snap_ads" as const;
  public readonly displayName = "Snap Ads Gallery";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "ad_library" as const;
  public readonly freeTier = "匿名公开 API，按广告主名搜索";
  public readonly docsUrl = "https://developers.snap.com/marketing-api/Ads-Gallery-Api/using-the-api";
  public readonly defaultSelected = false;
  public readonly configured = false;
  public readonly maxResults = 100;
  /** Cursor pages are consumed inside one bounded call; logical page numbers cannot safely replay them. */
  public readonly supportsPagination = false;
  public readonly refreshDownloadUrlOnRetry = true;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: SnapAdsOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if ((request.page ?? 1) !== 1) return [];
    const count = cappedCount(request, this.maxResults);
    const requestBody = JSON.stringify({ paying_advertiser_name: request.query });
    const visited = new Set<string>();
    const hits: NormalizedHit[] = [];
    const seenImages = new Set<string>();
    const firstEndpoint = new URL(SEARCH_ENDPOINT);
    firstEndpoint.searchParams.set("limit", String(count));
    let endpoint: string | null = firstEndpoint.toString();
    for (let page = 0; endpoint && page < MAX_CURSOR_PAGES_PER_SEARCH && hits.length < count; page += 1) {
      if (visited.has(endpoint)) break;
      visited.add(endpoint);
      const body = await requestJson(this.id, this.fetchImpl, endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { accept: "application/json", "content-type": "application/json" },
        body: requestBody
      });
      const requestStatus = stringValue(body.request_status);
      if (requestStatus && requestStatus !== "SUCCESS") throw new ProviderError(this.id, null, false);
      for (const value of Array.isArray(body.ad_previews) ? body.ad_previews : []) {
        for (const hit of normalizePreview(value, hits.length + 1)) {
          if (seenImages.has(hit.imageUrl)) continue;
          seenImages.add(hit.imageUrl);
          hits.push({ ...hit, rank: hits.length + 1 });
          if (hits.length >= count) break;
        }
        if (hits.length >= count) break;
      }
      const paging = isRecord(body.paging) ? body.paging : {};
      endpoint = trustedNextLink(paging.next_link);
      if (endpoint) {
        const nextEndpoint = new URL(endpoint);
        nextEndpoint.searchParams.set("limit", String(Math.max(1, count - hits.length)));
        endpoint = nextEndpoint.toString();
      }
    }
    return hits;
  }
}
