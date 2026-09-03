import { describe, expect, it } from "vitest";
import { createLabelId, parseLabelPaths } from "../../src/shared/taxonomy.js";

describe("parseLabelPaths", () => {
  it("normalizes separators and produces a stable leaf id", () => {
    const parsed = parseLabelPaths([
      "电商快销 / 3C及电器 / 影音电器 / 音箱",
      "电商快销>3C及电器>影音电器>耳机"
    ]);

    expect(parsed.errors).toEqual([]);
    expect(parsed.leaves[0]?.path).toEqual(["电商快销", "3C及电器", "影音电器", "音箱"]);
    expect(parsed.leaves[0]?.id).toMatch(/^L[A-F0-9]{10}$/);
    expect(createLabelId(parsed.leaves[0]!.path)).toBe(parsed.leaves[0]?.id);
  });

  it("reports the later line for duplicate normalized paths", () => {
    const parsed = parseLabelPaths(["一级 / 二级", "一级>二级"]);

    expect(parsed.leaves).toHaveLength(1);
    expect(parsed.errors).toEqual([{ line: 2, message: "Duplicate normalized path; first defined on line 1." }]);
  });

  it("rejects empty hierarchy levels without silently removing them", () => {
    const parsed = parseLabelPaths(["A>>B", "A//B", ">A", "A>"]);

    expect(parsed.leaves).toEqual([]);
    expect(parsed.errors.map((error) => error.line)).toEqual([1, 2, 3, 4]);
    expect(parsed.errors.every((error) => error.message === "Path contains an empty hierarchy level.")).toBe(true);
  });
});
