import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl, stringValue } from "./common.js";
import { ProviderError } from "./types.js";

interface TikTokAdsOptions {
  clientKey?: string;
  clientSecret?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

interface CachedToken { value: string; expiresAt: number; }
const MAX_SEARCH_PAGES = 5;

function yyyymmdd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function transientHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function unsignedPublicUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.search = "";
    return safeHttpUrl(url.toString());
  } catch { return null; }
}

function boundedSearchTerm(value: string): string {
  return Array.from(value.trim()).slice(0, 50).join("");
}

export class TikTokAdsProvider implements ImageSearchProvider {
  public readonly id = "tiktok_ads" as const;
  public readonly displayName = "TikTok Commercial Content";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "approval" as const;
  public readonly credentialVariables = ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"] as const;
  public readonly sourceCategory = "ad_library" as const;
  public readonly freeTier = "免费申请审批，Client Token 有效期 2 小时";
  public readonly docsUrl = "https://developers.tiktok.com/products/commercial-content-api";
  public readonly defaultSelected = false;
  public readonly configured: boolean;
  public readonly maxResults = 50;
  public readonly supportsPagination = false;
  public readonly refreshDownloadUrlOnRetry = true;
  private readonly clientKey: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private token: CachedToken | null = null;

  public constructor(options: TikTokAdsOptions = {}) {
    this.clientKey = options.clientKey?.trim() || undefined;
    this.clientSecret = options.clientSecret?.trim() || undefined;
    this.configured = Boolean(this.clientKey && this.clientSecret);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    const now = this.now().getTime();
    if (this.token && this.token.expiresAt > now) return this.token.value;
    if (!this.clientKey || !this.clientSecret) throw new ProviderError(this.id, 401, false);
    const form = new URLSearchParams();
    form.set("client_key", this.clientKey);
    form.set("client_secret", this.clientSecret);
    form.set("grant_type", "client_credentials");
    const body = await requestJson(this.id, this.fetchImpl, "https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      signal,
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    const value = stringValue(body.access_token);
    const expiresIn = numberValue(body.expires_in);
    if (!value || expiresIn === null || expiresIn <= 0) throw new ProviderError(this.id, 401, false);
    this.token = { value, expiresAt: now + Math.max(1, expiresIn - 60) * 1_000 };
    return value;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if ((request.page ?? 1) !== 1) return [];
    const count = cappedCount(request, this.maxResults);
    const token = await this.accessToken(signal);
    const end = this.now();
    const start = new Date(end.getTime());
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    const endpoint = new URL("https://open.tiktokapis.com/v2/research/adlib/ad/query/");
    endpoint.searchParams.set("fields", "ad.id,ad.first_shown_date,ad.last_shown_date,ad.image_urls,advertiser.business_id,advertiser.business_name,advertiser.paid_for_by");
    const hits: NormalizedHit[] = [];
    const seenImages = new Set<string>();
    const seenSearchIds = new Set<string>();
    let searchId: string | null = null;
    for (let page = 0; page < MAX_SEARCH_PAGES && hits.length < count; page += 1) {
      const requestBody: Record<string, unknown> = {
        filters: {
          ad_type: "IMAGES",
          ad_published_date_range: { min: yyyymmdd(start), max: yyyymmdd(end) }
        },
        search_term: boundedSearchTerm(request.query),
        search_type: "fuzzy_phrase",
        max_count: Math.min(10, count - hits.length)
      };
      if (searchId) requestBody.search_id = searchId;
      const body = await requestJson(this.id, this.fetchImpl, endpoint, {
        method: "POST",
        signal,
        headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      const error = isRecord(body.error) ? body.error : null;
      const errorCode = error ? stringValue(error.code) : null;
      if (errorCode && errorCode.toLowerCase() !== "ok") {
        const status = error ? numberValue(error.http_status_code) : null;
        throw new ProviderError(this.id, status, status === 429 || (status !== null && status >= 500));
      }
      const data = isRecord(body.data) ? body.data : {};
      for (const value of Array.isArray(data.ads) ? data.ads : []) {
        if (!isRecord(value)) continue;
        const ad = isRecord(value.ad) ? value.ad : {};
        const advertiser = isRecord(value.advertiser) ? value.advertiser : {};
        const adId = stringValue(ad.id) ?? (typeof ad.id === "number" ? String(ad.id) : null);
        const creator = stringValue(advertiser.business_name) ?? stringValue(advertiser.paid_by);
        for (const rawValue of Array.isArray(ad.image_urls) ? ad.image_urls : []) {
          const transientImageUrl = transientHttpUrl(rawValue);
          const imageUrl = unsignedPublicUrl(transientImageUrl ?? "");
          if (!transientImageUrl || !imageUrl || seenImages.has(imageUrl)) continue;
          seenImages.add(imageUrl);
          hits.push({
            provider: this.id,
            rank: hits.length + 1,
            imageUrl,
            transientImageUrl,
            thumbnailUrl: imageUrl,
            landingPageUrl: null,
            title: creator ? `${creator} TikTok ad` : adId ? `TikTok ad ${adId}` : "TikTok image ad",
            creator,
            licenseName: null,
            licenseUrl: null,
            width: null,
            height: null,
            sourceProvider: "TikTok Commercial Content API",
            source: adId,
            rightsStatus: "unknown"
          });
          if (hits.length >= count) return hits;
        }
      }
      const hasMore = data.has_more === true || stringValue(data.has_more)?.toLowerCase() === "true";
      const nextSearchId = stringValue(data.search_id);
      if (!hasMore || !nextSearchId || seenSearchIds.has(nextSearchId)) break;
      seenSearchIds.add(nextSearchId);
      searchId = nextSearchId;
    }
    return hits;
  }
}
