import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface BingAdsOptions { fetch?: typeof globalThis.fetch; }

interface BingSearchText {
  searchText: string;
  excludedTerms: string[];
}

function parseBingSearchText(query: string): BingSearchText {
  const excludedTerms: string[] = [];
  const searchText = query.replace(
    /(?:^|\s)-(?:"([^"]+)"|(\S+))/gu,
    (_match: string, phrase: string | undefined, token: string | undefined) => {
      const excluded = (phrase ?? token ?? "").replace(/\s+/gu, " ").trim();
      if (excluded) excludedTerms.push(excluded);
      return " ";
    }
  ).replace(/\s+/gu, " ").trim();
  return { searchText, excludedTerms };
}

function containsExcludedMetadata(ad: Record<string, unknown>, excludedTerms: string[]): boolean {
  if (excludedTerms.length === 0) return false;
  const metadataFields = [
    stringValue(ad.Title ?? ad.title),
    stringValue(ad.Description ?? ad.description),
    stringValue(ad.AdvertiserName ?? ad.advertiserName)
  ].filter((value): value is string => value !== null)
    .map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase());
  return excludedTerms.some((term) => {
    const normalizedTerm = term.normalize("NFKC").toLowerCase();
    return metadataFields.some((field) => field.includes(normalizedTerm));
  });
}

function imageAssets(value: unknown): Array<Record<string, unknown>> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown; }
    catch { return []; }
  }
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (!isRecord(parsed)) return [];
  const nested = parsed.Assets ?? parsed.assets ?? parsed.value;
  return Array.isArray(nested) ? nested.filter(isRecord) : [];
}

export class BingAdsProvider implements ImageSearchProvider {
  public readonly id = "bing_ads" as const;
  public readonly displayName = "Microsoft Bing Ad Library";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "ad_library" as const;
  public readonly freeTier = "匿名公开 API，频率限制较严";
  public readonly docsUrl = "https://learn.microsoft.com/en-us/advertising/guides/ad-library-api?view=bingads-13";
  public readonly defaultSelected = true;
  public readonly configured = false;
  public readonly maxResults = 100;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 1_000 && Number.isSafeInteger(count) && count > 0;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: BingAdsOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const page = request.page ?? 1;
    const count = cappedCount(request, this.maxResults);
    if (!this.canRequestPage(page, count)) return [];
    const { searchText, excludedTerms } = parseBingSearchText(request.query);
    if (!searchText) return [];
    const endpoint = new URL("https://adlibrary.api.bingads.microsoft.com/api/v1/Ads");
    endpoint.searchParams.set("top", String(count));
    endpoint.searchParams.set("skip", String((page - 1) * count));
    endpoint.searchParams.set("searchText", searchText);
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json" }
    });
    const ads = Array.isArray(body.value) ? body.value : [];
    const hits: NormalizedHit[] = [];
    for (const adValue of ads) {
      if (!isRecord(adValue)) continue;
      if (containsExcludedMetadata(adValue, excludedTerms)) continue;
      for (const asset of imageAssets(adValue.AssetJson ?? adValue.assetJson)) {
        const assetType = stringValue(asset.AssetType ?? asset.assetType)?.toLowerCase();
        if (assetType !== "image") continue;
        const imageUrl = safeHttpUrl(asset.AssetUrl ?? asset.assetUrl ?? asset.url);
        if (!imageUrl) continue;
        hits.push({
          provider: this.id,
          rank: hits.length + 1,
          imageUrl,
          thumbnailUrl: safeHttpUrl(asset.ThumbnailUrl ?? asset.thumbnailUrl) ?? imageUrl,
          landingPageUrl: safeHttpUrl(adValue.DestinationUrl ?? adValue.destinationUrl),
          title: stringValue(adValue.Title ?? adValue.title) ?? stringValue(adValue.Description ?? adValue.description),
          creator: stringValue(adValue.AdvertiserName ?? adValue.advertiserName),
          licenseName: null,
          licenseUrl: null,
          width: null,
          height: null,
          sourceProvider: "Microsoft Bing Ad Library",
          source: stringValue(adValue.AdId ?? adValue.adId)
            ?? (numberValue(adValue.AdId ?? adValue.adId) !== null ? String(numberValue(adValue.AdId ?? adValue.adId)) : null),
          rightsStatus: "unknown"
        });
        if (hits.length >= count) return hits;
      }
    }
    return hits;
  }
}
