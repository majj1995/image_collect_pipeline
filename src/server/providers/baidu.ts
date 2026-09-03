import type { ImageSearchProvider, NormalizedHit, ProviderSearchRequest } from "./types.js";
import { isRecord, numberValue, providerEnvelopeError, requestJson, safeHttpUrl, stringValue } from "./common.js";

interface BaiduOptions { apiKey?: string; fetch?: typeof globalThis.fetch; }

export function truncateBaiduQuery(query: string): string {
  let units = 0;
  let output = "";
  for (const character of query) {
    const characterUnits = character.codePointAt(0)! <= 0x7f ? 1 : 2;
    if (units + characterUnits > 72) break;
    output += character;
    units += characterUnits;
  }
  return output;
}

export class BaiduProvider implements ImageSearchProvider {
  public readonly id = "baidu" as const;
  public readonly displayName = "百度千帆图片搜索";
  public readonly rightsPolicy = "discovery_only" as const;
  public readonly credentialMode = "required" as const;
  public readonly credentialVariables = ["BAIDU_QIANFAN_API_KEY"] as const;
  public readonly sourceCategory = "general" as const;
  public readonly freeTier = "免费额度以百度千帆控制台当期规则为准";
  public readonly docsUrl = "https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5";
  public readonly defaultSelected = false;
  public readonly maxResults = 30;
  public readonly supportsPagination = false;
  public readonly configured: boolean;
  public readonly queryLanguage = "zh" as const;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: BaiduOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]> {
    const body = await requestJson(this.id, this.fetchImpl, "https://qianfan.baidubce.com/v2/ai_search/web_search", {
      method: "POST", signal,
      headers: { accept: "application/json", "content-type": "application/json", "X-Appbuilder-Authorization": `Bearer ${this.apiKey ?? ""}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: truncateBaiduQuery(request.query) }],
        search_source: "baidu_search_v2",
        resource_type_filter: [{ type: "image", top_k: Math.min(request.count, this.maxResults) }],
        safe_search: request.safeSearch
      })
    });
    if (body.code !== undefined && body.code !== 0 && body.code !== "0" && body.code !== 200 && body.code !== "200") {
      throw providerEnvelopeError(this.id, body.code);
    }
    const data = isRecord(body.data) ? body.data : body;
    const results = [data.references, data.results, data.items].find(Array.isArray) ?? [];
    return results.flatMap((value, index): NormalizedHit[] => {
      if (!isRecord(value)) return [];
      const image = isRecord(value.image) ? value.image : {};
      const imageUrl = safeHttpUrl(image.url ?? value.image_url ?? value.imageUrl ?? value.original);
      if (!imageUrl) return [];
      return [{
        provider: this.id, rank: index + 1, imageUrl, thumbnailUrl: safeHttpUrl(value.thumbnail_url ?? value.thumbnailUrl ?? value.thumbnail),
        landingPageUrl: safeHttpUrl(value.url ?? value.link ?? value.source_url), title: stringValue(value.title) ?? stringValue(value.web_anchor) ?? stringValue(value.content), creator: null,
        licenseName: null, licenseUrl: null, width: numberValue(image.width ?? value.width), height: numberValue(image.height ?? value.height),
        sourceProvider: "baidu_search_v2", source: stringValue(value.website) ?? stringValue(value.source), rightsStatus: "unknown"
      }];
    });
  }
}
