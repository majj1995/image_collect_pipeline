import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { sanitizePublicHttpUrl, sanitizePublicText } from "../../shared/public-url.js";
import { cappedCount, isRecord, numberValue, requestJson, stringValue } from "./common.js";

interface OpenverseOptions { fetch?: typeof globalThis.fetch; }

const MAX_PHYSICAL_PAGE = 20;

export class OpenverseProvider implements ImageSearchProvider {
  public readonly id = "openverse" as const;
  public readonly displayName = "Openverse";
  public readonly rightsPolicy = "open" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "匿名公开 API";
  public readonly docsUrl = "https://docs.openverse.org/api/guides/";
  public readonly defaultSelected = true;
  public readonly configured = false;
  public readonly maxResults = 200;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean => {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(count) || count < 1) return false;
    const boundedCount = Math.min(count, this.maxResults);
    const pageSize = Math.min(20, boundedCount);
    const logicalOffset = (page - 1) * boundedCount;
    const firstPage = Math.floor(logicalOffset / pageSize) + 1;
    const firstPageOffset = logicalOffset % pageSize;
    const pagesNeeded = Math.ceil((firstPageOffset + boundedCount) / pageSize);
    return firstPage >= 1 && firstPage + pagesNeeded - 1 <= MAX_PHYSICAL_PAGE;
  };
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: OpenverseOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const count = cappedCount(request, this.maxResults);
    const logicalPage = request.page ?? 1;
    if (!this.canRequestPage(logicalPage, count)) return [];
    const pageSize = Math.min(20, count);
    const logicalOffset = (logicalPage - 1) * count;
    const firstPage = Math.floor(logicalOffset / pageSize) + 1;
    const firstPageOffset = logicalOffset % pageSize;
    const pagesNeeded = Math.ceil((firstPageOffset + count) / pageSize);
    const collected: unknown[] = [];
    for (let pageIndex = 0; pageIndex < pagesNeeded; pageIndex += 1) {
      const endpoint = new URL("https://api.openverse.org/v1/images/");
      endpoint.searchParams.set("q", request.query);
      endpoint.searchParams.set("page_size", String(pageSize));
      endpoint.searchParams.set("page", String(firstPage + pageIndex));
      endpoint.searchParams.set("mature", request.safeSearch ? "false" : "true");
      const body = await requestJson(this.id, this.fetchImpl, endpoint, { signal, headers: { accept: "application/json" } });
      const pageResults = Array.isArray(body.results) ? body.results : [];
      collected.push(...pageResults);
      const pageCount = numberValue(body.page_count);
      if (pageResults.length < pageSize || (pageCount !== null && firstPage + pageIndex >= pageCount)) break;
    }
    return collected.slice(firstPageOffset, firstPageOffset + count).flatMap((item, index): NormalizedHit[] => {
      if (!isRecord(item)) return [];
      const imageUrl = sanitizePublicHttpUrl(item.url);
      if (!imageUrl) return [];
      const license = stringValue(item.license)?.toLowerCase() ?? null;
      return [{
        provider: "openverse", rank: index + 1, thumbnailUrl: sanitizePublicHttpUrl(item.thumbnail), imageUrl,
        landingPageUrl: sanitizePublicHttpUrl(item.foreign_landing_url), title: sanitizePublicText(item.title), creator: sanitizePublicText(item.creator),
        licenseName: license, licenseUrl: sanitizePublicHttpUrl(item.license_url), width: numberValue(item.width), height: numberValue(item.height),
        sourceProvider: sanitizePublicText(item.provider), source: sanitizePublicText(item.source),
        rightsStatus: license === "cc0" || license === "pdm" ? "provider_claimed" : "unknown"
      }];
    });
  }
}
