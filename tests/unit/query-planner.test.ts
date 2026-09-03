import { describe, expect, it } from "vitest";
import {
  planQueries,
  planSearchProfileQueries,
  planSupplementalSearchProfileQueries
} from "../../src/shared/query-planner.js";

describe("legacy planQueries", () => {
  it("keeps legacy task queries stable for existing jobs", () => {
    const variants = planQueries({
      labelPath: ["电商快销", "3C及电器", "影音电器", "音箱"],
      product: "音箱",
      aliases: ["蓝牙音响"],
      styles: ["极简白底"],
      requiredTerms: ["促销价"],
      excludedTerms: ["买家秀"]
    });

    expect(variants.map((item) => item.query).join(" ")).toContain("音箱 电商海报");
    expect(variants.map((item) => item.query).join(" ")).toContain("product ad");
    expect(variants.every((item) => item.query.includes("-买家秀"))).toBe(true);
  });
});

describe("planSearchProfileQueries", () => {
  it("builds Chinese queries only from the explicit Chinese profile", () => {
    const variants = planSearchProfileQueries({
      terms: ["蓝牙音箱", "智能扬声器"],
      styles: ["极简白底", "节日促销"],
      requiredTerms: ["新品"],
      excludedTerms: ["真人 模特"]
    });

    const allowed = /^(?:(?:蓝牙音箱|智能扬声器|极简白底|节日促销|新品)|-"真人 模特")(?: (?:(?:蓝牙音箱|智能扬声器|极简白底|节日促销|新品)|-"真人 模特"))*$/u;
    const queries = variants.map((variant) => variant.query);
    expect(queries).not.toHaveLength(0);
    expect(queries.every((query) => allowed.test(query))).toBe(true);
    expect(queries.join("\n")).toContain("蓝牙音箱");
    expect(queries.join("\n")).toContain("智能扬声器");
    expect(queries.join("\n")).toContain("极简白底");
    expect(queries.join("\n")).toContain("节日促销");
    expect(queries.every((query) => query.includes("新品") && query.includes('-"真人 模特"'))).toBe(true);
  });

  it("builds English queries only from the explicit English profile", () => {
    const variants = planSearchProfileQueries({
      terms: ["speaker", "audio"],
      styles: ["minimal", "promotion"],
      requiredTerms: ["launch"],
      excludedTerms: ["people"]
    });

    const allowed = /^(?:(?:speaker|audio|minimal|promotion|launch)|-people)(?: (?:(?:speaker|audio|minimal|promotion|launch)|-people))*$/u;
    const queries = variants.map((variant) => variant.query);
    expect(queries).not.toHaveLength(0);
    expect(queries.every((query) => allowed.test(query))).toBe(true);
    expect(queries.join("\n")).toContain("speaker");
    expect(queries.join("\n")).toContain("audio");
    expect(queries.join("\n")).toContain("minimal");
    expect(queries.join("\n")).toContain("promotion");
    expect(queries.every((query) => query.includes("launch") && query.includes("-people"))).toBe(true);
  });

  it("deterministically fills the untried alias and secondary-style combinations", () => {
    const profile = {
      terms: ["speaker", "audio", "sound"],
      styles: ["minimal", "promotion", "sale"],
      requiredTerms: ["launch"],
      excludedTerms: ["people"]
    };
    const base = planSearchProfileQueries(profile);
    const supplemental = planSupplementalSearchProfileQueries(profile);

    expect(supplemental.map((variant) => variant.query)).toEqual([
      "audio promotion launch -people",
      "audio sale launch -people",
      "sound promotion launch -people",
      "sound sale launch -people"
    ]);
    expect(new Set(supplemental.map((variant) => variant.query)).size).toBe(supplemental.length);
    expect(supplemental.every((variant) => !base.some((item) => item.query === variant.query))).toBe(true);
    expect(planSupplementalSearchProfileQueries(profile)).toEqual(supplemental);
  });

  it("falls back to the primary term for a singleton profile", () => {
    expect(planSupplementalSearchProfileQueries({
      terms: ["electric toothbrush"],
      styles: ["ecommerce advertisement"],
      requiredTerms: ["product"],
      excludedTerms: ["review photo"]
    })).toEqual([{
      name: "term_only",
      query: 'electric toothbrush product -"review photo"',
      excludedTerms: ["review photo"]
    }]);
  });
});
