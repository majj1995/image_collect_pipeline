import type { SearchPlatform } from "../../shared/contracts.js";

const localizedPlatformNames: Record<SearchPlatform, string> = {
  taobao_tmall: "淘宝/天猫",
  jd: "京东",
  pinduoduo: "拼多多",
  vipshop: "唯品会",
  xiaohongshu: "小红书",
  douyin: "抖音电商"
};

const platformDomains: Record<SearchPlatform, readonly string[]> = {
  taobao_tmall: ["taobao.com", "tmall.com"],
  jd: ["jd.com"],
  pinduoduo: ["pinduoduo.com", "yangkeduo.com"],
  vipshop: ["vip.com"],
  xiaohongshu: ["xiaohongshu.com"],
  douyin: ["douyin.com", "jinritemai.com"]
};

export function localizedPlatformQuery(baseQuery: string, platform: SearchPlatform): string {
  return `${localizedPlatformNames[platform]} ${baseQuery}`.trim();
}

export function siteScopedPlatformQuery(baseQuery: string, platform: SearchPlatform): string {
  const domains = platformDomains[platform];
  const scope = domains.length === 1
    ? `site:${domains[0]}`
    : `(${domains.map((domain) => `site:${domain}`).join(" OR ")})`;
  return `${scope} ${baseQuery}`.trim();
}
