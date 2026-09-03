import { resolve } from "node:path";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import ipaddr from "ipaddr.js";

const MIN_WIKIMEDIA_USER_AGENT_LENGTH = 10;
const MAX_WIKIMEDIA_USER_AGENT_LENGTH = 256;
const SAFE_HTTP_HEADER_VALUE = /^[\x20-\x7e]+$/u;
const CONTACT_EMAIL = /(?:^|[\s(;<])[-A-Z0-9.!#$%&'*+/=?^_`{|}~]+@[A-Z0-9](?:[-A-Z0-9]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[-A-Z0-9]{0,61}[A-Z0-9])?)+(?:$|[\s)>;,])/iu;
const WIKIMEDIA_USER_CONTACT = /\(([^();]+);\s*User:([^();]+)\)/giu;

function hasWikimediaUserContact(value: string): boolean {
  for (const match of value.matchAll(WIKIMEDIA_USER_CONTACT)) {
    if (match[1]?.trim() && match[2]?.trim()) return true;
  }
  return false;
}

function isReachableContactHost(hostname: string): boolean {
  const unwrapped = hostname.replace(/^\[|\]$/gu, "");
  if (!ipaddr.isValid(unwrapped)) return hostname.includes(".");
  let address = ipaddr.parse(unwrapped);
  if (address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
    address = (address as ipaddr.IPv6).toIPv4Address();
  }
  return address.range() === "unicast";
}

function hasContactUrl(value: string): boolean {
  const candidates = value.match(/https?:\/\/[^\s()<>]+/giu) ?? [];
  return candidates.some((candidate) => {
    try {
      const url = new URL(candidate.replace(/[;,]+$/u, ""));
      return (url.protocol === "http:" || url.protocol === "https:")
        && !url.username && !url.password && isReachableContactHost(url.hostname);
    } catch {
      return false;
    }
  });
}

export function normalizeWikimediaUserAgent(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || !SAFE_HTTP_HEADER_VALUE.test(normalized)) return undefined;
  if (normalized.length < MIN_WIKIMEDIA_USER_AGENT_LENGTH || normalized.length > MAX_WIKIMEDIA_USER_AGENT_LENGTH) {
    return undefined;
  }
  return hasContactUrl(normalized) || CONTACT_EMAIL.test(normalized) || hasWikimediaUserContact(normalized)
    ? normalized
    : undefined;
}

export interface AppConfig {
  dataDir: string;
  staticRoot: string;
  wikimediaUserAgent?: string;
  credentials: {
    baiduQianfanApiKey?: string;
    braveSearchApiKey?: string;
    serpapiApiKey?: string;
    dataforseoLogin?: string;
    dataforseoPassword?: string;
    europeanaApiKey?: string;
    pexelsApiKey?: string;
    pixabayApiKey?: string;
    unsplashAccessKey?: string;
    flickrApiKey?: string;
    harvardArtMuseumsApiKey?: string;
    dplaApiKey?: string;
    smithsonianApiKey?: string;
    tiktokClientKey?: string;
    tiktokClientSecret?: string;
  };
}

export function useEnvironmentProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_USE_ENV_PROXY?.trim() === "1";
}

export interface PreparedEnvironmentProxy {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

function trustedProxyUrl(value: string | undefined, allowRemote: boolean): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
    if ((!loopback && !allowRemote) || (url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) return null;
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Constructs an isolated proxy dispatcher only when both protocols are bound
 * to a trusted local proxy, or to an explicitly trusted remote corporate
 * proxy. NO_PROXY is intentionally cleared so a provider hostname can never
 * fall back to an unpinned direct fetch.
 */
export function prepareEnvironmentProxy(env: NodeJS.ProcessEnv = process.env): PreparedEnvironmentProxy | undefined {
  if (!useEnvironmentProxy(env)) return undefined;
  const allowRemote = env.ALLOW_REMOTE_ENV_PROXY?.trim() === "1";
  // Node's environment proxy uses lowercase values first, so validation must
  // use the same precedence before normalizing both spellings.
  const httpProxy = trustedProxyUrl(env.http_proxy ?? env.HTTP_PROXY, allowRemote);
  const httpsProxy = trustedProxyUrl(env.https_proxy ?? env.HTTPS_PROXY, allowRemote);
  if (!httpProxy || !httpsProxy) {
    const scope = allowRemote ? "代理" : "本机代理";
    throw new Error(`NODE_USE_ENV_PROXY=1 时必须同时配置有效的${scope} HTTP_PROXY 和 HTTPS_PROXY。`);
  }
  env.HTTP_PROXY = httpProxy;
  env.HTTPS_PROXY = httpsProxy;
  env.http_proxy = httpProxy;
  env.https_proxy = httpsProxy;
  env.NO_PROXY = "";
  env.no_proxy = "";
  const dispatcher = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: "" });
  const proxyFetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init ?? {}),
      dispatcher
    } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as globalThis.Response;
  }) as typeof globalThis.fetch;
  return { fetch: proxyFetch, close: () => dispatcher.close() };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const value = (name: string): string | undefined => env[name]?.trim() || undefined;
  return {
    dataDir: env.DATA_DIR?.trim() || resolve(process.cwd(), ".data"),
    staticRoot: resolve(process.cwd(), "dist", "client"),
    wikimediaUserAgent: normalizeWikimediaUserAgent(env.WIKIMEDIA_USER_AGENT),
    credentials: {
      baiduQianfanApiKey: value("BAIDU_QIANFAN_API_KEY"),
      braveSearchApiKey: value("BRAVE_SEARCH_API_KEY"),
      serpapiApiKey: value("SERPAPI_API_KEY"),
      dataforseoLogin: value("DATAFORSEO_LOGIN"),
      dataforseoPassword: value("DATAFORSEO_PASSWORD"),
      europeanaApiKey: value("EUROPEANA_API_KEY"),
      pexelsApiKey: value("PEXELS_API_KEY"),
      pixabayApiKey: value("PIXABAY_API_KEY"),
      unsplashAccessKey: value("UNSPLASH_ACCESS_KEY"),
      flickrApiKey: value("FLICKR_API_KEY"),
      harvardArtMuseumsApiKey: value("HARVARD_ART_MUSEUMS_API_KEY"),
      dplaApiKey: value("DPLA_API_KEY"),
      smithsonianApiKey: value("SMITHSONIAN_API_KEY"),
      tiktokClientKey: value("TIKTOK_CLIENT_KEY"),
      tiktokClientSecret: value("TIKTOK_CLIENT_SECRET")
    }
  };
}
