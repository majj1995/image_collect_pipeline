import { describe, expect, it } from "vitest";
import { createJobInputSchema } from "../../src/shared/contracts.js";

describe("createJobInputSchema", () => {
  it("accepts the six supported search platforms and normalizes an omitted platform list to empty", () => {
    const searchPlatforms = ["taobao_tmall", "jd", "pinduoduo", "vipshop", "xiaohongshu", "douyin"] as const;
    const parsed = createJobInputSchema.parse({
      name: "平台定向查询",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商>音箱"],
      searchPlatforms
    });

    expect(parsed.searchPlatforms).toEqual(searchPlatforms);
    expect(createJobInputSchema.parse({
      name: "兼容旧任务",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商>音箱"]
    }).searchPlatforms).toEqual([]);
    expect(createJobInputSchema.parse({
      name: "平台顺序归一化",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商>音箱"],
      searchPlatforms: ["douyin", "jd"]
    }).searchPlatforms).toEqual(["jd", "douyin"]);
  });

  it("rejects unsupported and duplicate search platforms", () => {
    const base = {
      name: "平台校验",
      taskType: "advertiser_product_taxonomy" as const,
      exportMode: "internal_research" as const,
      labelPaths: ["电商>音箱"]
    };
    expect(createJobInputSchema.safeParse({ ...base, searchPlatforms: ["amazon"] }).success).toBe(false);
    expect(createJobInputSchema.safeParse({ ...base, searchPlatforms: ["jd", "jd"] }).success).toBe(false);
  });
  it("accepts a taxonomy task and rejects an empty label list", () => {
    expect(
      createJobInputSchema.parse({
        name: "音箱广告扩充",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商快销>3C及电器>影音电器>音箱"]
      }).labelPaths
    ).toHaveLength(1);

    expect(() =>
      createJobInputSchema.parse({
        name: "empty",
        taskType: "content_moderation",
        exportMode: "strict_compliance",
        labelPaths: []
      })
    ).toThrow();
  });

  it("bounds expansion terms, taxonomy paths, and every generated provider query", () => {
    const base = {
      name: "bounded inputs",
      taskType: "advertiser_product_taxonomy" as const,
      exportMode: "internal_research" as const,
      labelPaths: ["电商>音箱"]
    };

    expect(createJobInputSchema.safeParse({
      ...base,
      aliases: Array.from({ length: 65 }, (_, index) => `别名-${index}`)
    }).success).toBe(false);
    expect(createJobInputSchema.safeParse({
      ...base,
      styles: ["x".repeat(161)]
    }).success).toBe(false);
    expect(createJobInputSchema.safeParse({
      ...base,
      labelPaths: [`${"类".repeat(161)}>音箱`]
    }).success).toBe(false);
    expect(createJobInputSchema.safeParse({
      ...base,
      requiredTerms: Array.from({ length: 64 }, (_, index) => `${index}-${"促".repeat(150)}`)
    }).success).toBe(false);
  });

  it("preserves bilingual search profiles that map one-to-one to classification labels", () => {
    const labelSearchProfiles = [{
      labelPath: "安防监控>监控摄像头",
      zh: {
        terms: ["监控摄像头", "安防摄像机"],
        styles: ["电商广告"],
        requiredTerms: ["促销"],
        excludedTerms: ["实拍"]
      },
      en: {
        terms: ["security camera", "surveillance camera"],
        styles: ["ecommerce advertisement"],
        requiredTerms: ["promotion"],
        excludedTerms: ["real photo"]
      }
    }];

    const parsed = createJobInputSchema.parse({
      name: "双语监控广告",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["安防监控>监控摄像头"],
      labelSearchProfiles
    });

    expect(parsed.labelSearchProfiles).toEqual(labelSearchProfiles);
  });

  it("rejects bilingual profiles that are missing, empty, or mapped to another label", () => {
    const base = {
      name: "无效双语映射",
      taskType: "advertiser_product_taxonomy" as const,
      exportMode: "internal_research" as const,
      labelPaths: ["安防监控>监控摄像头"],
      labelSearchProfiles: [{
        labelPath: "安防监控>其他商品",
        zh: { terms: ["监控摄像头"], styles: [], requiredTerms: [], excludedTerms: [] },
        en: { terms: ["security camera"], styles: [], requiredTerms: [], excludedTerms: [] }
      }]
    };

    expect(createJobInputSchema.safeParse(base).success).toBe(false);
    expect(createJobInputSchema.safeParse({ ...base, labelSearchProfiles: [] }).success).toBe(false);
    expect(createJobInputSchema.safeParse({
      ...base,
      labelSearchProfiles: [{
        ...base.labelSearchProfiles[0],
        labelPath: base.labelPaths[0],
        en: { terms: [], styles: [], requiredTerms: [], excludedTerms: [] }
      }]
    }).success).toBe(false);
  });

  it("rejects a bilingual profile whose generated query exceeds the provider boundary", () => {
    const longTerms = Array.from({ length: 10 }, (_, index) => `${index}-${"促".repeat(150)}`);
    expect(createJobInputSchema.safeParse({
      name: "过长双语查询",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商>音箱"],
      labelSearchProfiles: [{
        labelPath: "电商>音箱",
        zh: { terms: ["音箱"], styles: ["电商广告"], requiredTerms: longTerms, excludedTerms: [] },
        en: { terms: ["speaker"], styles: ["product ad"], requiredTerms: [], excludedTerms: [] }
      }]
    }).success).toBe(false);
  });
});
