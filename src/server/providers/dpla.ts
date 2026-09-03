import { sanitizePublicText } from "../../shared/public-url.js";
import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, requestJson, safeHttpUrl } from "./common.js";

interface DplaOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function firstText(value: unknown): string | null {
  return sanitizePublicText(firstValue(value));
}

function objectUrl(value: unknown): string | null {
  return isRecord(value) ? safeHttpUrl(value["@id"]) : safeHttpUrl(value);
}

function viewImageUrl(value: unknown): string | null {
  const views = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
  for (const view of views) {
    if (!isRecord(view)) continue;
    const format = firstText(view.format)?.toLowerCase();
    if (!format || !SUPPORTED_IMAGE_MIMES.has(format)) continue;
    const imageUrl = safeHttpUrl(view["@id"]);
    if (imageUrl) return imageUrl;
  }
  return null;
}

export class DplaProvider implements ImageSearchProvider {
  public readonly id = "dpla" as const;
  public readonly displayName = "Digital Public Library of America";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["DPLA_API_KEY"] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "免费申请 API Key；美国数字文化聚合目录";
  public readonly docsUrl = "https://pro.dp.la/developers/api-codex";
  public readonly defaultSelected = false;
  public readonly configured: boolean;
  public readonly maxResults = 500;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 100 && Number.isSafeInteger(count) && count > 0;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: DplaOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if (!this.apiKey) return [];
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://api.dp.la/v2/items");
    endpoint.searchParams.set("api_key", this.apiKey);
    endpoint.searchParams.set("q", request.query);
    endpoint.searchParams.set("sourceResource.type", "image");
    endpoint.searchParams.set("page_size", String(count));
    endpoint.searchParams.set("page", String(page));
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json" }
    });
    const docs = Array.isArray(body.docs) ? body.docs : [];
    return docs.flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const thumbnailUrl = objectUrl(value.object);
      const imageUrl = viewImageUrl(value.hasView) ?? thumbnailUrl;
      if (!imageUrl) return [];
      const sourceResource = isRecord(value.sourceResource) ? value.sourceResource : {};
      const provider = isRecord(value.provider) ? value.provider : {};
      return [{
        provider: this.id,
        rank: index + 1,
        imageUrl,
        thumbnailUrl: thumbnailUrl ?? imageUrl,
        landingPageUrl: safeHttpUrl(value.isShownAt),
        title: firstText(sourceResource.title),
        creator: firstText(sourceResource.creator),
        licenseName: null,
        licenseUrl: null,
        width: null,
        height: null,
        sourceProvider: firstText(provider.name) ?? "Digital Public Library of America",
        source: firstText(value.dataProvider) ?? firstText(value["@id"]),
        rightsStatus: "unknown"
      }];
    });
  }
}
