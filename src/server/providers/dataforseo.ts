import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isDataForSeoSuccess, isRecord, localeOptions, numberValue, providerEnvelopeError, requestJson, safeHttpUrl, safeUrlHostname, stringValue } from "./common.js";

interface DataForSeoOptions { login?: string; password?: string; fetch?: typeof globalThis.fetch; }

export class DataForSeoProvider implements ImageSearchProvider {
  public readonly id = "dataforseo" as const;
  public readonly displayName = "DataForSEO Google Images";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "仅有试用金，不属于持续免费来源，仅保留旧数据兼容";
  public readonly docsUrl = "https://docs.dataforseo.com/v3/serp/google/images/live/advanced/";
  public readonly defaultSelected = false;
  public readonly maxResults = 200;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean => {
    const boundedPage = Math.max(1, Math.floor(page));
    const boundedCount = Math.max(1, Math.min(this.maxResults, Math.floor(count)));
    return (boundedPage - 1) * boundedCount < this.maxResults;
  };
  public readonly configured: boolean;
  private readonly login: string | undefined;
  private readonly password: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: DataForSeoOptions = {}) {
    this.login = options.login?.trim() || undefined;
    this.password = options.password?.trim() || undefined;
    this.configured = Boolean(this.login && this.password);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const count = cappedCount(request, this.maxResults);
    const page = Math.max(1, Math.floor(request.page ?? 1));
    if (!this.canRequestPage(page, count)) return [];
    const locale = localeOptions(request.locale);
    const offset = (page - 1) * count;
    const depth = Math.min(this.maxResults, offset + count);
    const auth = Buffer.from(`${this.login ?? ""}:${this.password ?? ""}`).toString("base64");
    const body = await requestJson(this.id, this.fetchImpl, "https://api.dataforseo.com/v3/serp/google/images/live/advanced", {
      method: "POST", signal,
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify([{
        keyword: request.query,
        language_code: locale.language,
        location_name: locale.locationName,
        depth,
        search_param: request.safeSearch ? "&safe=active" : "&safe=off"
      }])
    });
    if (body.status_code !== undefined && !isDataForSeoSuccess(body.status_code)) throw providerEnvelopeError(this.id, body.status_code);
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const items = tasks.flatMap((task) => {
      if (!isRecord(task)) return [];
      if (task.status_code !== undefined && !isDataForSeoSuccess(task.status_code)) throw providerEnvelopeError(this.id, task.status_code);
      if (!Array.isArray(task.result)) return [];
      return task.result.flatMap((result) => {
        if (!isRecord(result) || result.type !== "images" || !Array.isArray(result.items)) return [];
        return result.items.filter((item) => isRecord(item) && item.type === "images_search");
      });
    });
    return items.slice(offset, offset + count).flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const imageUrl = safeHttpUrl(value.source_url);
      if (!imageUrl) return [];
      const landingPageUrl = safeHttpUrl(value.url);
      return [{
        provider: this.id, rank: numberValue(value.rank_absolute) ?? offset + index + 1, imageUrl, thumbnailUrl: safeHttpUrl(value.encoded_url),
        landingPageUrl, title: stringValue(value.title) ?? stringValue(value.subtitle) ?? stringValue(value.alt), creator: null,
        licenseName: null, licenseUrl: null, width: numberValue(value.width), height: numberValue(value.height),
        sourceProvider: safeUrlHostname(landingPageUrl), source: imageUrl, rightsStatus: "unknown"
      }];
    });
  }
}
