import { sanitizePublicText } from "../../shared/public-url.js";
import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { ProviderError } from "./types.js";
import { cappedCount, isRecord, requestJson, safeHttpUrl } from "./common.js";

interface EuropeanaOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function firstText(value: unknown): string | null {
  return sanitizePublicText(firstValue(value));
}

function usableShownByUrl(value: unknown): string | null {
  const sanitized = safeHttpUrl(firstValue(value));
  if (!sanitized) return null;
  const pathname = new URL(sanitized).pathname;
  return /\.(?:tiff?|gif|bmp|jp2|j2k|jpf|jpx|svg|avif|heic|heif)$/iu.test(pathname) ? null : sanitized;
}

export class EuropeanaProvider implements ImageSearchProvider {
  public readonly id = "europeana" as const;
  public readonly displayName = "Europeana";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["EUROPEANA_API_KEY"] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "免费申请 API Key；官方公共文化遗产搜索服务";
  public readonly docsUrl = "https://pro.europeana.eu/page/get-api";
  public readonly defaultSelected = false;
  public readonly configured: boolean;
  public readonly maxResults = 100;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger(count) && count > 0 && (page - 1) * count < 1_000;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: EuropeanaOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if (!this.apiKey) return [];
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://api.europeana.eu/record/v2/search.json");
    endpoint.searchParams.set("query", request.query);
    endpoint.searchParams.set("media", "true");
    endpoint.searchParams.set("thumbnail", "true");
    endpoint.searchParams.set("profile", "rich");
    endpoint.searchParams.set("qf", "TYPE:IMAGE");
    endpoint.searchParams.set("rows", String(count));
    endpoint.searchParams.set("start", String((page - 1) * count + 1));
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", "X-Api-Key": this.apiKey }
    });
    if (body.success === false) throw new ProviderError(this.id, null, false);
    const items = Array.isArray(body.items) ? body.items : [];
    return items.flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const previewUrl = safeHttpUrl(firstValue(value.edmPreview));
      const imageUrl = usableShownByUrl(value.edmIsShownBy) ?? previewUrl;
      if (!imageUrl) return [];
      return [{
        provider: this.id,
        rank: index + 1,
        imageUrl,
        thumbnailUrl: previewUrl ?? imageUrl,
        landingPageUrl: safeHttpUrl(firstValue(value.edmIsShownAt)) ?? safeHttpUrl(value.guid),
        title: firstText(value.title),
        creator: firstText(value.dcCreator),
        licenseName: null,
        licenseUrl: safeHttpUrl(firstValue(value.rights)),
        width: null,
        height: null,
        sourceProvider: firstText(value.provider) ?? "Europeana",
        source: firstText(value.dataProvider) ?? firstText(value.id),
        rightsStatus: "unknown"
      }];
    });
  }
}
