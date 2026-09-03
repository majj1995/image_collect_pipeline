import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { cappedCount, isRecord, localeOptions, numberValue, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface OpenFoodFactsOptions { fetch?: typeof globalThis.fetch; }

const USER_AGENT = "MultimodalDataExpansion/1.0 (local image collection tool)";
const PRODUCT_FIELDS = [
  "code", "product_name", "brands", "url", "image_url", "image_small_url", "image_front_url", "image_front_small_url",
  "image_front_width", "image_front_height", "selected_images"
].join(",");

function firstLocalizedImage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const candidate of Object.values(value)) {
    const url = safeHttpUrl(candidate);
    if (url) return url;
  }
  return null;
}

function selectedFrontImage(product: Record<string, unknown>, size: "display" | "small"): string | null {
  if (!isRecord(product.selected_images) || !isRecord(product.selected_images.front)) return null;
  return firstLocalizedImage(product.selected_images.front[size]);
}

export class OpenFoodFactsProvider implements ImageSearchProvider {
  public readonly id = "open_food_facts" as const;
  public readonly displayName = "Open Food Facts";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "none" as const;
  public readonly credentialVariables = [] as const;
  public readonly sourceCategory = "commerce" as const;
  public readonly freeTier = "匿名读取；搜索限 10 次/分钟/IP";
  public readonly docsUrl = "https://openfoodfacts.github.io/openfoodfacts-server/api/";
  public readonly defaultSelected = true;
  public readonly configured = false;
  public readonly maxResults = 100;
  public readonly searchPolicy = { minimumIntervalMs: 6_000 } as const;
  public readonly supportsPagination = true;
  public readonly canRequestPage = (page: number, count: number): boolean =>
    Number.isSafeInteger(page) && page >= 1 && page <= 1_000 && Number.isSafeInteger(count) && count > 0;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: OpenFoodFactsOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const count = cappedCount(request, this.maxResults);
    const page = request.page ?? 1;
    if (!this.canRequestPage(page, count)) return [];
    const locale = localeOptions(request.locale);
    const endpoint = new URL("https://world.openfoodfacts.org/cgi/search.pl");
    endpoint.searchParams.set("search_terms", request.query);
    endpoint.searchParams.set("search_simple", "1");
    endpoint.searchParams.set("action", "process");
    endpoint.searchParams.set("json", "1");
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("page_size", String(count));
    endpoint.searchParams.set("lc", locale.language);
    endpoint.searchParams.set("cc", locale.country.toLowerCase());
    endpoint.searchParams.set("fields", PRODUCT_FIELDS);
    const body = await requestJson(this.id, this.fetchImpl, endpoint, {
      signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT }
    });
    const products = Array.isArray(body.products) ? body.products : [];
    const hits: NormalizedHit[] = [];
    for (const value of products) {
      if (!isRecord(value)) continue;
      const imageUrl = safeHttpUrl(value.image_front_url) ?? selectedFrontImage(value, "display") ?? safeHttpUrl(value.image_url);
      if (!imageUrl) continue;
      const code = stringValue(value.code);
      const landingPageUrl = safeHttpUrl(value.url) ?? (code ? `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}` : null);
      hits.push({
        provider: this.id,
        rank: hits.length + 1,
        imageUrl,
        thumbnailUrl: safeHttpUrl(value.image_front_small_url) ?? selectedFrontImage(value, "small") ?? safeHttpUrl(value.image_small_url) ?? imageUrl,
        landingPageUrl,
        title: stringValue(value.product_name),
        creator: stringValue(value.brands),
        licenseName: "CC BY-SA 3.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
        width: numberValue(value.image_front_width),
        height: numberValue(value.image_front_height),
        sourceProvider: "Open Food Facts",
        source: code,
        rightsStatus: "provider_claimed"
      });
      if (hits.length >= count) break;
    }
    return hits;
  }
}
