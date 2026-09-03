import { sanitizePublicText } from "../../shared/public-url.js";
import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, requestJson, safeHttpUrl } from "./common.js";

interface HarvardArtMuseumsOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }

function firstPerson(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const person of value) {
    if (!isRecord(person)) continue;
    const name = sanitizePublicText(person.displayname) ?? sanitizePublicText(person.name);
    if (name) return name;
  }
  return null;
}

function sourceId(value: unknown): string | null {
  const numeric = numberValue(value);
  return numeric === null ? sanitizePublicText(value) : String(numeric);
}

export class HarvardArtMuseumsProvider implements ImageSearchProvider {
  public readonly id = "harvard_art_museums" as const;
  public readonly displayName = "Harvard Art Museums";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["HARVARD_ART_MUSEUMS_API_KEY"] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "免费申请 API Key；文化藏品检索服务";
  public readonly docsUrl = "https://github.com/harvardartmuseums/api-docs";
  public readonly defaultSelected = false;
  public readonly configured: boolean;
  public readonly maxResults = 100;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 1_000 && Number.isSafeInteger(count) && count > 0;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: HarvardArtMuseumsOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    if (!this.apiKey) return [];
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const endpoint = new URL("https://api.harvardartmuseums.org/object");
    endpoint.searchParams.set("apikey", this.apiKey);
    endpoint.searchParams.set("keyword", request.query);
    endpoint.searchParams.set("hasimage", "1");
    endpoint.searchParams.set("size", String(count));
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("fields", "id,title,people,url,primaryimageurl,images");
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json" }
    });
    const records = Array.isArray(body.records) ? body.records : [];
    return records.flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const images = Array.isArray(value.images) ? value.images : [];
      let baseImage: Record<string, unknown> | null = null;
      let baseImageUrl: string | null = null;
      for (const candidate of images) {
        if (!isRecord(candidate)) continue;
        const candidateUrl = safeHttpUrl(candidate.baseimageurl);
        if (!candidateUrl) continue;
        baseImage = candidate;
        baseImageUrl = candidateUrl;
        break;
      }
      const primaryImageUrl = safeHttpUrl(value.primaryimageurl);
      const imageUrl = baseImageUrl ?? primaryImageUrl;
      if (!imageUrl) return [];
      return [{
        provider: this.id,
        rank: index + 1,
        imageUrl,
        thumbnailUrl: primaryImageUrl ?? imageUrl,
        landingPageUrl: safeHttpUrl(value.url),
        title: sanitizePublicText(value.title),
        creator: firstPerson(value.people),
        licenseName: null,
        licenseUrl: null,
        width: baseImage ? numberValue(baseImage.width) : null,
        height: baseImage ? numberValue(baseImage.height) : null,
        sourceProvider: "Harvard Art Museums",
        source: sourceId(value.id),
        rightsStatus: "unknown"
      }];
    });
  }
}
