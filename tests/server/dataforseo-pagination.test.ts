import { describe, expect, it } from "vitest";
import { DataForSeoProvider } from "../../src/server/providers/dataforseo.js";

describe("DataForSEO cumulative pagination", () => {
  it("returns disjoint 100-result windows for pages one and two", async () => {
    const depths: number[] = [];
    const provider = new DataForSeoProvider({
      login: "test-user",
      password: "test-secret",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const [task] = await request.json() as Array<{ depth: number }>;
        depths.push(task!.depth);
        const items = Array.from({ length: task!.depth }, (_, index) => ({
          type: "images_search",
          rank_absolute: index + 1,
          title: `Image ${index}`,
          url: `https://shop.example.test/products/${index}`,
          source_url: `https://images.example.test/products/${index}.jpg`,
          encoded_url: `https://images.example.test/products/${index}-thumb.jpg`,
          width: 1000,
          height: 1000
        }));
        return new Response(JSON.stringify({
          tasks: [{ status_code: 20000, result: [{ type: "images", items }] }]
        }), { headers: { "content-type": "application/json" } });
      }
    });
    const request = { query: "speaker ad", count: 100, locale: "zh-CN", safeSearch: true };

    const first = await provider.search({ ...request, page: 1 }, AbortSignal.timeout(1000));
    const second = await provider.search({ ...request, page: 2 }, AbortSignal.timeout(1000));

    expect(depths).toEqual([100, 200]);
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(first[0]!.imageUrl).toBe("https://images.example.test/products/0.jpg");
    expect(second[0]!.imageUrl).toBe("https://images.example.test/products/100.jpg");
    const secondUrls = new Set(second.map((hit) => hit.imageUrl));
    expect(first.every((hit) => !secondUrls.has(hit.imageUrl))).toBe(true);
  });
});
