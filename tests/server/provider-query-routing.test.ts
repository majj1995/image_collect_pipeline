import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  ProviderId,
  ProviderSourceCategory
} from "../../src/shared/contracts.js";
import type {
  ImageSearchProvider,
  ProviderSearchRequest
} from "../../src/server/providers/types.js";
import { createTestApp, waitForJob } from "../helpers/server.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function recordingProvider(
  id: ProviderId,
  sourceCategory: ProviderSourceCategory,
  requests: ProviderSearchRequest[]
): ImageSearchProvider {
  return {
    id,
    displayName: `${id} routing fixture`,
    rightsPolicy: "discovery_only",
    credentialMode: "none",
    credentialVariables: [],
    sourceCategory,
    freeTier: "test fixture",
    docsUrl: "https://example.test/provider-docs",
    defaultSelected: true,
    configured: true,
    queryLanguage: "en",
    maxResults: 10,
    supportsPagination: false,
    async search(request) {
      requests.push({ ...request });
      return [];
    }
  };
}

async function createProductJob(
  app: FastifyInstance,
  input: { name: string; labelPath: string; zhTerm: string; enTerm: string }
): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/jobs",
    payload: {
      name: input.name,
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: [input.labelPath],
      labelSearchProfiles: [{
        labelPath: input.labelPath,
        zh: {
          terms: [input.zhTerm],
          styles: ["电商广告"],
          requiredTerms: [],
          excludedTerms: ["实拍图"]
        },
        en: {
          terms: [input.enTerm],
          styles: ["ecommerce advertisement"],
          requiredTerms: [],
          excludedTerms: ["real photo"]
        }
      }],
      targetCount: 1,
      candidateCount: 4
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

async function runSearch(
  app: FastifyInstance,
  jobId: string,
  providerIds: ProviderId[]
): Promise<Array<{ providerId: ProviderId }>> {
  const started = await app.inject({
    method: "POST",
    url: `/api/jobs/${jobId}/search`,
    payload: { providerIds }
  });
  expect([200, 202]).toContain(started.statusCode);
  if (started.statusCode === 200) expect(started.json()).toEqual({ status: "exhausted" });
  await waitForJob(app, jobId, "reviewing");
  const candidates = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/candidates` });
  expect(candidates.statusCode).toBe(200);
  return candidates.json().providerRuns as Array<{ providerId: ProviderId }>;
}

describe("provider query routing", () => {
  it("does not schedule culture collections for advertiser product-taxonomy queries", async () => {
    const generalRequests: ProviderSearchRequest[] = [];
    const cultureRequests: ProviderSearchRequest[] = [];
    const app = await createTestApp({
      providers: [
        recordingProvider("openverse", "general", generalRequests),
        recordingProvider("artic", "culture", cultureRequests),
        recordingProvider("met", "culture", cultureRequests)
      ],
      assetService: false
    });
    apps.push(app);
    const job = await createProductJob(app, {
      name: "监控摄像头来源能力路由",
      labelPath: "电商快销>3C及电器>安防设备>监控摄像头",
      zhTerm: "监控摄像头",
      enTerm: "security camera"
    });

    const runs = await runSearch(app, job.id, ["openverse", "artic", "met"]);

    expect(generalRequests.length).toBeGreaterThan(0);
    expect(cultureRequests).toEqual([]);
    expect([...new Set(runs.map((run) => run.providerId))]).toEqual(["openverse"]);
  });

  it("schedules Open Food Facts only for food labels", async () => {
    const requests: ProviderSearchRequest[] = [];
    const app = await createTestApp({
      providers: [recordingProvider("open_food_facts", "commerce", requests)],
      assetService: false
    });
    apps.push(app);
    const electronicsJob = await createProductJob(app, {
      name: "非食品商品不查询食品库",
      labelPath: "电商快销>3C及电器>安防设备>监控摄像头",
      zhTerm: "监控摄像头",
      enTerm: "security camera"
    });
    const foodJob = await createProductJob(app, {
      name: "食品商品查询食品库",
      labelPath: "电商快销>食品饮料>饮料>可乐",
      zhTerm: "可乐",
      enTerm: "cola"
    });

    const electronicsRuns = await runSearch(app, electronicsJob.id, ["open_food_facts"]);
    const foodRuns = await runSearch(app, foodJob.id, ["open_food_facts"]);

    expect(electronicsRuns).toEqual([]);
    expect(foodRuns.length).toBeGreaterThan(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.query.includes("cola"))).toBe(true);
  });

  it("uses whole food terms for flat labels without matching unrelated substrings", async () => {
    const requests: ProviderSearchRequest[] = [];
    const app = await createTestApp({
      providers: [recordingProvider("open_food_facts", "commerce", requests)],
      assetService: false
    });
    apps.push(app);
    const breadJob = await createProductJob(app, {
      name: "扁平面包标签",
      labelPath: "面包",
      zhTerm: "面包",
      enTerm: "bread"
    });
    const chocolateJob = await createProductJob(app, {
      name: "扁平巧克力标签",
      labelPath: "巧克力",
      zhTerm: "巧克力",
      enTerm: "chocolate"
    });
    const hotelSuppliesJob = await createProductJob(app, {
      name: "酒店用品不是酒类",
      labelPath: "电商快销>家居日用>酒店用品",
      zhTerm: "酒店用品",
      enTerm: "hotel supplies"
    });
    const teamApparelJob = await createProductJob(app, {
      name: "team 不是 tea",
      labelPath: "电商快销>服装>团队服饰",
      zhTerm: "团队服饰",
      enTerm: "team apparel"
    });

    const breadRuns = await runSearch(app, breadJob.id, ["open_food_facts"]);
    const chocolateRuns = await runSearch(app, chocolateJob.id, ["open_food_facts"]);
    const requestCountAfterFoods = requests.length;
    const hotelRuns = await runSearch(app, hotelSuppliesJob.id, ["open_food_facts"]);
    const apparelRuns = await runSearch(app, teamApparelJob.id, ["open_food_facts"]);

    expect(breadRuns.length).toBeGreaterThan(0);
    expect(chocolateRuns.length).toBeGreaterThan(0);
    expect(requestCountAfterFoods).toBeGreaterThan(0);
    expect(hotelRuns).toEqual([]);
    expect(apparelRuns).toEqual([]);
    expect(requests).toHaveLength(requestCountAfterFoods);
  });

  it("skips Snap Ads without an explicit advertiser while preserving product-search ad libraries", async () => {
    const bingRequests: ProviderSearchRequest[] = [];
    const snapRequests: ProviderSearchRequest[] = [];
    const app = await createTestApp({
      providers: [
        recordingProvider("bing_ads", "ad_library", bingRequests),
        recordingProvider("snap_ads", "ad_library", snapRequests)
      ],
      assetService: false
    });
    apps.push(app);
    const job = await createProductJob(app, {
      name: "无广告主字段不猜测品牌",
      labelPath: "电商快销>3C及电器>安防设备>监控摄像头",
      zhTerm: "监控摄像头",
      enTerm: "security camera"
    });

    const runs = await runSearch(app, job.id, ["bing_ads", "snap_ads"]);

    expect(bingRequests.length).toBeGreaterThan(0);
    expect(snapRequests).toEqual([]);
    expect([...new Set(runs.map((run) => run.providerId))]).toEqual(["bing_ads"]);
  });
});
