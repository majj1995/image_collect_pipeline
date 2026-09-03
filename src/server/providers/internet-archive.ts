import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface InternetArchiveOptions { fetch?: typeof globalThis.fetch; }

function firstText(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(stringValue).find(Boolean) ?? null;
  return stringValue(value);
}

function encodedArchivePath(identifier: string, name: string): string {
  return [identifier, ...name.split("/")].map((part) => encodeURIComponent(part)).join("/");
}

export class InternetArchiveProvider implements ImageSearchProvider {
  public readonly id = "internet_archive" as const;
  public readonly displayName = "Internet Archive";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "culture" as const;
  public readonly freeTier = "免 Key，需遵守公平使用和 429 退避";
  public readonly docsUrl = "https://archive.org/developers/";
  public readonly defaultSelected = false;
  public readonly configured = false;
  public readonly maxResults = 20;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number): boolean => Number.isSafeInteger(page) && page >= 1 && page <= 10_000;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: InternetArchiveOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const page = request.page ?? 1;
    if (!this.canRequestPage(page)) return [];
    const count = cappedCount(request, this.maxResults);
    const endpoint = new URL("https://archive.org/advancedsearch.php");
    endpoint.searchParams.set("q", `mediatype:image AND (${request.query})`);
    for (const field of ["identifier", "title", "creator", "description"]) endpoint.searchParams.append("fl[]", field);
    endpoint.searchParams.set("rows", String(count));
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("output", "json");
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", "user-agent": "MaterialExpansionWorkbench/1.0 (local image research tool)" }
    });
    const response = isRecord(body.response) ? body.response : {};
    const docs = Array.isArray(response.docs) ? response.docs.slice(0, count) : [];
    const resolved: NormalizedHit[] = [];
    let firstFailure: unknown;
    let metadataSuccesses = 0;
    for (const value of docs) {
      if (!isRecord(value)) continue;
      const identifier = stringValue(value.identifier);
      if (!identifier) continue;
      let metadata: Record<string, unknown>;
      try {
        metadata = await requestJson(this.id, this.fetchImpl, `https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
          signal,
          headers: { accept: "application/json", "user-agent": "MaterialExpansionWorkbench/1.0 (local image research tool)" }
        });
        metadataSuccesses += 1;
      } catch (error) {
        if (signal.aborted) throw error;
        firstFailure ??= error;
        continue;
      }
      const files = (Array.isArray(metadata.files) ? metadata.files : []).filter(isRecord);
      const original = files.find((file) => {
        const name = stringValue(file.name);
        return stringValue(file.source)?.toLowerCase() === "original"
          && name !== null
          && /\.(?:jpe?g|png)$/iu.test(name);
      });
      const name = original ? stringValue(original.name) : null;
      if (!name) continue;
      const recordMetadata = isRecord(metadata.metadata) ? metadata.metadata : {};
      const licenseUrl = safeHttpUrl(recordMetadata.licenseurl);
      const lowerLicense = licenseUrl?.toLowerCase() ?? "";
      const licenseName = lowerLicense.includes("publicdomain/mark") ? "pdm" : lowerLicense.includes("publicdomain/zero") ? "cc0" : null;
      resolved.push({
        provider: this.id,
        rank: 0,
        imageUrl: `https://archive.org/download/${encodedArchivePath(identifier, name)}`,
        thumbnailUrl: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
        landingPageUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
        title: firstText(value.title),
        creator: firstText(value.creator),
        licenseName,
        licenseUrl,
        width: null,
        height: null,
        sourceProvider: "Internet Archive",
        source: identifier,
        rightsStatus: licenseName ? "provider_claimed" as const : "unknown" as const
      });
    }
    if (metadataSuccesses === 0 && firstFailure) throw firstFailure;
    return resolved.map((hit, index) => ({ ...hit, rank: index + 1 }));
  }
}
