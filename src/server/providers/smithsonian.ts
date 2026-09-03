import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, numberValue, providerEnvelopeError, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface SmithsonianOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }

const USER_AGENT = "MultimodalDataExpansion/1.0 (local image collection tool)";
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

function firstFreetextContent(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const group of [value.name, value.creditLine]) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (isRecord(item)) {
        const content = stringValue(item.content);
        if (content) return content;
      }
    }
  }
  return null;
}

function titleFromDescription(value: Record<string, unknown>): string | null {
  if (!isRecord(value.title)) return null;
  return stringValue(value.title.content);
}

function resourceScore(value: Record<string, unknown>): number {
  const label = stringValue(value.label)?.toLowerCase() ?? "";
  const mime = stringValue(value.mime_type)?.toLowerCase() ?? "";
  if ((mime && !SUPPORTED_IMAGE_MIMES.has(mime)) || /\b(?:tiff?|gif|bmp|jpeg ?2000|jp2|svg|avif|heic|heif)\b/iu.test(label)) return -1;
  let score = numberValue(value.width) ?? 0;
  if (SUPPORTED_IMAGE_MIMES.has(mime)) score += 10_000;
  if (label.includes("high-resolution jpeg")) score += 100_000;
  else if (label.includes("screen image")) score += 1_000;
  return score;
}

function bestResource(media: Record<string, unknown>): { url: string; width: number | null; height: number | null } | null {
  if (!Array.isArray(media.resources)) return null;
  const candidates = media.resources.flatMap((value) => {
    if (!isRecord(value)) return [];
    const url = safeHttpUrl(value.url);
    const score = resourceScore(value);
    return url && score >= 0 ? [{ url, width: numberValue(value.width), height: numberValue(value.height), score }] : [];
  });
  if (!candidates.length) return null;
  const selected = candidates.reduce((best, candidate) => candidate.score > best.score ? candidate : best);
  return { url: selected.url, width: selected.width, height: selected.height };
}

export class SmithsonianProvider implements ImageSearchProvider {
  public readonly id = "smithsonian" as const;
  public readonly displayName = "Smithsonian Open Access";
  public readonly rightsPolicy = "open" as const;
  public readonly credentialMode = "optional" as const;
  public readonly credentialVariables = ["SMITHSONIAN_API_KEY"] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "DEMO_KEY 每 IP 30 次/小时、50 次/天；可换免费个人 Key";
  public readonly docsUrl = "https://edan.si.edu/openaccess/apidocs/";
  public readonly defaultSelected = false;
  public readonly configured: boolean;
  public readonly maxResults = 100;
  public readonly searchPolicy: { minimumIntervalMs: number };
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean => {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(count) || count < 1) return false;
    return (page - 1) * Math.min(count, this.maxResults) < 1_000;
  };
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: SmithsonianOptions = {}) {
    const configuredKey = options.apiKey?.trim();
    this.apiKey = configuredKey || "DEMO_KEY";
    this.configured = Boolean(configuredKey && configuredKey.toUpperCase() !== "DEMO_KEY");
    this.searchPolicy = { minimumIntervalMs: this.configured ? 1_000 : 120_000 };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const logicalOffset = (page - 1) * count;
    const logicalEnd = logicalOffset + count;
    // The index can mark a row as having images while omitting online_media from
    // that row.  One larger request is cheaper on DEMO_KEY than paging until a
    // usable record appears, and newest currently favours complete media rows.
    const searchRows = Math.min(1_000, Math.max(20, logicalEnd * 5));
    const endpoint = new URL("https://api.si.edu/openaccess/api/v1.0/search");
    endpoint.searchParams.set("q", `${request.query} AND online_media_type:\"Images\"`);
    endpoint.searchParams.set("rows", String(searchRows));
    endpoint.searchParams.set("start", "0");
    endpoint.searchParams.set("sort", "newest");
    endpoint.searchParams.set("api_key", this.apiKey);
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT }
    });
    const envelopeError = isRecord(body.error) ? body.error : null;
    if (envelopeError) {
      const code = stringValue(envelopeError.code)?.toUpperCase();
      throw providerEnvelopeError(this.id, code === "OVER_RATE_LIMIT" ? 429 : null);
    }
    if (body.status !== undefined && numberValue(body.status) !== 200) throw providerEnvelopeError(this.id, body.status);
    if (body.responseCode !== undefined && numberValue(body.responseCode) !== 1) throw providerEnvelopeError(this.id, null);
    const response = isRecord(body.response) ? body.response : {};
    const rows = Array.isArray(response.rows) ? response.rows : [];
    const hits: NormalizedHit[] = [];
    for (const rowValue of rows) {
      if (!isRecord(rowValue) || !isRecord(rowValue.content)) continue;
      const description = isRecord(rowValue.content.descriptiveNonRepeating) ? rowValue.content.descriptiveNonRepeating : {};
      const onlineMedia = isRecord(description.online_media) ? description.online_media : {};
      const mediaItems = Array.isArray(onlineMedia.media) ? onlineMedia.media : [];
      for (const mediaValue of mediaItems) {
        if (!isRecord(mediaValue) || !["image", "images"].includes(stringValue(mediaValue.type)?.toLowerCase() ?? "")) continue;
        const resource = bestResource(mediaValue);
        const imageUrl = resource?.url ?? safeHttpUrl(mediaValue.content) ?? safeHttpUrl(mediaValue.thumbnail);
        if (!imageUrl) continue;
        const usage = isRecord(mediaValue.usage) ? mediaValue.usage : {};
        const licenseName = stringValue(usage.access);
        const freetext = isRecord(rowValue.content.freetext) ? rowValue.content.freetext : {};
        hits.push({
          provider: this.id,
          rank: hits.length + 1,
          imageUrl,
          thumbnailUrl: safeHttpUrl(mediaValue.thumbnail) ?? imageUrl,
          landingPageUrl: safeHttpUrl(description.record_link),
          title: stringValue(rowValue.title) ?? titleFromDescription(description),
          creator: firstFreetextContent(freetext),
          licenseName,
          licenseUrl: licenseName?.toUpperCase() === "CC0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : null,
          width: resource?.width ?? null,
          height: resource?.height ?? null,
          sourceProvider: stringValue(description.data_source) ?? "Smithsonian Institution",
          source: stringValue(rowValue.id) ?? stringValue(description.record_ID),
          rightsStatus: licenseName?.toUpperCase() === "CC0" ? "provider_claimed" : "unknown"
        });
        break;
      }
      if (hits.length >= logicalEnd) break;
    }
    return hits.slice(logicalOffset, logicalEnd).map((hit, index) => ({ ...hit, rank: index + 1 }));
  }
}
