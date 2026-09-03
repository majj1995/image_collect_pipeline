import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface ClevelandOptions { fetch?: typeof globalThis.fetch; }

const USER_AGENT = "MultimodalDataExpansion/1.0 (local image collection tool)";

export class ClevelandProvider implements ImageSearchProvider {
  public readonly id = "cleveland" as const;
  public readonly displayName = "Cleveland Museum of Art";
  public readonly rightsPolicy = "open" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "匿名公开 API，单页最多 1000 条";
  public readonly docsUrl = "https://openaccess-api.clevelandart.org/";
  public readonly defaultSelected = false;
  public readonly configured = false;
  public readonly maxResults = 100;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 1_000 && Number.isSafeInteger(count) && count > 0;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: ClevelandOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://openaccess-api.clevelandart.org/api/artworks/");
    endpoint.searchParams.set("q", request.query);
    endpoint.searchParams.set("has_image", "1");
    endpoint.searchParams.set("limit", String(count));
    endpoint.searchParams.set("skip", String((page - 1) * count));
    endpoint.searchParams.set("fields", "id,accession_number,share_license_status,title,creators,url,images");
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT }
    });
    const results = Array.isArray(body.data) ? body.data : [];
    const hits: NormalizedHit[] = [];
    for (const value of results) {
      if (!isRecord(value) || !isRecord(value.images)) continue;
      const web = isRecord(value.images.web) ? value.images.web : null;
      const print = isRecord(value.images.print) ? value.images.print : null;
      const full = isRecord(value.images.full) ? value.images.full : null;
      const selected = [print, web, full].find((candidate) => candidate && safeHttpUrl(candidate.url)) ?? null;
      if (!selected) continue;
      const imageUrl = safeHttpUrl(selected.url);
      if (!imageUrl) continue;
      const creator = Array.isArray(value.creators) && isRecord(value.creators[0])
        ? stringValue(value.creators[0].description)
        : null;
      const licenseName = stringValue(value.share_license_status);
      hits.push({
        provider: this.id,
        rank: hits.length + 1,
        imageUrl,
        thumbnailUrl: safeHttpUrl(web?.url) ?? imageUrl,
        landingPageUrl: safeHttpUrl(value.url),
        title: stringValue(value.title),
        creator,
        licenseName,
        licenseUrl: licenseName?.toUpperCase() === "CC0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : null,
        width: numberValue(selected.width),
        height: numberValue(selected.height),
        sourceProvider: "Cleveland Museum of Art",
        source: stringValue(value.accession_number) ?? (numberValue(value.id)?.toString() ?? null),
        rightsStatus: licenseName?.toUpperCase() === "CC0" ? "provider_claimed" : "unknown"
      });
      if (hits.length >= count) break;
    }
    return hits;
  }
}
