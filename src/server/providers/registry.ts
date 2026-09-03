import type { ProviderId } from "../../shared/contracts.js";
import type { AppConfig } from "../config.js";
import { BaiduProvider } from "./baidu.js";
import { ArticProvider } from "./artic.js";
import { BingAdsProvider } from "./bing-ads.js";
import { ClevelandProvider } from "./cleveland.js";
import { DplaProvider } from "./dpla.js";
import { EuropeanaProvider } from "./europeana.js";
import { FlickrProvider } from "./flickr.js";
import { HarvardArtMuseumsProvider } from "./harvard-art-museums.js";
import { InternetArchiveProvider } from "./internet-archive.js";
import { LocProvider } from "./loc.js";
import { MetProvider } from "./met.js";
import { NasaProvider } from "./nasa.js";
import { OpenFoodFactsProvider } from "./open-food-facts.js";
import { OpenverseProvider } from "./openverse.js";
import { PexelsProvider } from "./pexels.js";
import { PixabayProvider } from "./pixabay.js";
import { RijksmuseumProvider } from "./rijksmuseum.js";
import { SerpApiProvider } from "./serpapi.js";
import { SmithsonianProvider } from "./smithsonian.js";
import { SnapAdsProvider } from "./snap-ads.js";
import { TikTokAdsProvider } from "./tiktok-ads.js";
import { UnsplashProvider } from "./unsplash.js";
import { WikimediaProvider } from "./wikimedia.js";
import { providerCatalogMetadata, type ImageSearchProvider, type ProviderDownloadPolicy, type ProviderSearchPolicy } from "./types.js";

const legacyRightsPolicies: Partial<Record<ProviderId, ImageSearchProvider["rightsPolicy"]>> = {
  openverse: "open",
  baidu: "discovery_only",
  brave: "contractual",
  serpapi: "discovery_only",
  dataforseo: "discovery_only",
  fake: "open"
};

export class ProviderRegistry {
  private readonly byId: Map<ProviderId, ImageSearchProvider>;

  public constructor(providers: ImageSearchProvider[]) {
    this.byId = new Map(providers.map((provider) => [provider.id, provider]));
  }

  public list(): ImageSearchProvider[] { return [...this.byId.values()]; }
  public get(id: ProviderId): ImageSearchProvider | undefined { return this.byId.get(id); }
  public rightsPolicy(id: ProviderId): ImageSearchProvider["rightsPolicy"] {
    return this.byId.get(id)?.rightsPolicy ?? legacyRightsPolicies[id] ?? "discovery_only";
  }
  public queryLanguage(id: ProviderId): "zh" | "en" {
    return this.byId.get(id)?.queryLanguage ?? "en";
  }
  public downloadPolicy(id: ProviderId): ProviderDownloadPolicy | undefined {
    return this.byId.get(id)?.downloadPolicy;
  }
  public searchPolicy(id: ProviderId): ProviderSearchPolicy | undefined {
    return this.byId.get(id)?.searchPolicy;
  }
  public select(ids: ProviderId[]): ImageSearchProvider[] | undefined {
    const providers = ids.map((id) => this.byId.get(id));
    return providers.every((provider): provider is ImageSearchProvider => provider !== undefined) ? providers : undefined;
  }

  public isEnabled(provider: ImageSearchProvider): boolean {
    if (provider.requiresConfiguration && !provider.configured) return false;
    const { credentialMode } = providerCatalogMetadata(provider);
    return credentialMode === "none" || credentialMode === "optional" || provider.configured;
  }
}

export function createDefaultProviderRegistry(
  credentials: AppConfig["credentials"],
  fetch?: typeof globalThis.fetch,
  wikimediaUserAgent?: string
): ProviderRegistry {
  return new ProviderRegistry([
    new OpenverseProvider({ fetch }),
    new WikimediaProvider({ fetch, userAgent: wikimediaUserAgent }),
    new MetProvider({ fetch }),
    new ClevelandProvider({ fetch }),
    new ArticProvider({ fetch }),
    new LocProvider({ fetch }),
    new NasaProvider({ fetch }),
    new InternetArchiveProvider({ fetch }),
    new OpenFoodFactsProvider({ fetch }),
    new SmithsonianProvider({ apiKey: credentials.smithsonianApiKey, fetch }),
    new RijksmuseumProvider({ fetch }),
    new BingAdsProvider({ fetch }),
    new SnapAdsProvider({ fetch }),
    new BaiduProvider({ apiKey: credentials.baiduQianfanApiKey, fetch }),
    new SerpApiProvider({ apiKey: credentials.serpapiApiKey, fetch }),
    new EuropeanaProvider({ apiKey: credentials.europeanaApiKey, fetch }),
    new PexelsProvider({ apiKey: credentials.pexelsApiKey, fetch }),
    new PixabayProvider({ apiKey: credentials.pixabayApiKey, fetch }),
    new UnsplashProvider({ accessKey: credentials.unsplashAccessKey, fetch }),
    new FlickrProvider({ apiKey: credentials.flickrApiKey, fetch }),
    new HarvardArtMuseumsProvider({ apiKey: credentials.harvardArtMuseumsApiKey, fetch }),
    new DplaProvider({ apiKey: credentials.dplaApiKey, fetch }),
    new TikTokAdsProvider({ clientKey: credentials.tiktokClientKey, clientSecret: credentials.tiktokClientSecret, fetch })
  ]);
}
