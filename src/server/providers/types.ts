import type {
  ProviderCredentialMode,
  ProviderId,
  ProviderSourceCategory
} from "../../shared/contracts.js";

export interface ProviderSearchRequest {
  query: string;
  count: number;
  locale: string;
  safeSearch: boolean;
  page?: number;
}

export interface NormalizedHit {
  provider: ProviderId;
  rank: number;
  thumbnailUrl: string | null;
  imageUrl: string;
  /** Server-internal one-use URL for signed CDN downloads; never persisted or returned by the API. */
  transientImageUrl?: string;
  landingPageUrl: string | null;
  title: string | null;
  creator: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
  width: number | null;
  height: number | null;
  sourceProvider: string | null;
  source: string | null;
  rightsStatus: "provider_claimed" | "unknown";
}

export interface ProviderDownloadPolicy {
  maxConcurrency: number;
  minimumIntervalMs: number;
  /** Descriptive identity sent with automated media downloads when required by the provider. */
  userAgent?: string;
}

export interface ProviderSearchPolicy {
  minimumIntervalMs: number;
}

export class ProviderError extends Error {
  public readonly status: number | null;
  public readonly retryable: boolean;

  public constructor(
    public readonly provider: string,
    status: number | null,
    retryable: boolean,
    public readonly retryAfterMs: number | null = null
  ) {
    super(`提供方 ${provider} 请求失败，请稍后重试。`);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface ImageSearchProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly rightsPolicy: "open" | "discovery_only" | "contractual";
  readonly configured: boolean;
  /** Some no-key providers still require explicit operator identification or other local configuration. */
  readonly requiresConfiguration?: boolean;
  /** Query text and request locale language used by this provider. Defaults to English. */
  readonly queryLanguage?: "zh" | "en";
  readonly maxResults: number;
  readonly credentialMode?: ProviderCredentialMode;
  readonly credentialVariables?: readonly string[];
  readonly sourceCategory?: ProviderSourceCategory;
  readonly freeTier?: string;
  readonly docsUrl?: string;
  readonly defaultSelected?: boolean;
  readonly supportsPagination?: boolean;
  /** Re-run completed discovery to obtain a replacement signed download URL after an exhausted download. Defaults to false. */
  readonly refreshDownloadUrlOnRetry?: boolean;
  readonly searchPolicy?: ProviderSearchPolicy;
  readonly downloadPolicy?: ProviderDownloadPolicy;
  readonly canRequestPage?: (page: number, count: number) => boolean;
  search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]>;
}

export interface ProviderCatalogMetadata {
  credentialMode: ProviderCredentialMode;
  credentialVariables: readonly string[];
  sourceCategory: ProviderSourceCategory;
  freeTier: string;
  docsUrl: string;
  defaultSelected: boolean;
}

/** Keeps injected legacy/test providers usable while production adapters declare complete metadata. */
export function providerCatalogMetadata(provider: ImageSearchProvider): ProviderCatalogMetadata {
  return {
    credentialMode: provider.credentialMode ?? (provider.id === "openverse" ? "none" : "required"),
    credentialVariables: provider.credentialVariables ?? [],
    sourceCategory: provider.sourceCategory ?? "general",
    freeTier: provider.freeTier ?? "自定义或测试来源",
    docsUrl: provider.docsUrl ?? "https://example.invalid/custom-image-provider",
    defaultSelected: provider.defaultSelected ?? provider.id === "openverse"
  };
}
