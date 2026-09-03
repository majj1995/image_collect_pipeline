import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../../src/server/database.js";
import { ProviderError, type ImageSearchProvider, type NormalizedHit, type ProviderSearchRequest } from "../../src/server/providers/types.js";
import { createSpeakerJob, createTestApp, makeBilingualProfiles, waitForJob } from "../helpers/server.js";
import { failingFakeProvider, successfulFakeProvider } from "../helpers/providers.js";

const apps: Array<Awaited<ReturnType<typeof createTestApp>>> = [];

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("image discovery", () => {
  function fullDeduplicatedPageProvider(id: "fake"): ImageSearchProvider {
    return {
      id, displayName: "full paginated fixture", configured: true, maxResults: 100, rightsPolicy: "open", supportsPagination: true,
      async search(request) {
        return Array.from({ length: request.count }, (_, index): NormalizedHit => ({
          provider: id, rank: index + 1, thumbnailUrl: null,
          imageUrl: `https://images.example.test/${id}/page-${request.page ?? 1}/result-${index}.jpg`, landingPageUrl: null,
          title: null, creator: null, licenseName: null, licenseUrl: null, width: 800, height: 800,
          sourceProvider: id, source: id, rightsStatus: "unknown"
        }));
      }
    };
  }

  it("copies and searches directly seeded legacy jobs with the legacy query planner", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider = {
      ...successfulFakeProvider("fake", 0),
      async search(request: ProviderSearchRequest) { requests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    const jobId = "legacy-profile-free-job";
    const labelId = "legacy-speaker-label";
    const now = "2026-09-01T00:00:00.000Z";
    const legacyInput = {
      name: "旧版音箱任务", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["电商快销>影音电器>音箱"], aliases: ["蓝牙音响"], styles: ["极简白底"],
      requiredTerms: ["促销价"], excludedTerms: ["买家秀"], targetCount: 1, candidateCount: 10
    };
    database.prepare(`
      INSERT INTO jobs (id, name, task_type, export_mode, status, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)
    `).run(jobId, legacyInput.name, legacyInput.taskType, legacyInput.exportMode, JSON.stringify(legacyInput), now, now);
    database.prepare(`
      INSERT INTO taxonomy_nodes (job_id, label_id, parent_id, display_name, path_json)
      VALUES (?, ?, NULL, '音箱', ?)
    `).run(jobId, labelId, JSON.stringify(["电商快销", "影音电器", "音箱"]));
    database.prepare(`
      INSERT INTO label_targets (job_id, label_id, product, config_json)
      VALUES (?, ?, '音箱', ?)
    `).run(jobId, labelId, JSON.stringify({
      aliases: legacyInput.aliases, styles: legacyInput.styles,
      requiredTerms: legacyInput.requiredTerms, excludedTerms: legacyInput.excludedTerms,
      targetCount: legacyInput.targetCount, candidateCount: legacyInput.candidateCount
    }));

    const copied = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/copy` });
    expect(copied.statusCode).toBe(201);
    expect(copied.json().labels[0].searchProfiles).toBeUndefined();
    expect((await app.inject({ method: "POST", url: `/api/jobs/${copied.json().id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await waitForJob(app, copied.json().id, "reviewing");

    const queries = requests.map((request) => request.query).join("\n");
    expect(queries).toContain("音箱 电商海报 促销价 -买家秀");
    expect(queries).toContain("影音电器 音箱 电商广告 促销价 -买家秀");
    expect(queries).toContain("音箱 product ad 促销价 -买家秀");
  });

  it("allocates bilingual query budgets independently per provider despite asymmetric variants", async () => {
    const chineseRequests: ProviderSearchRequest[] = [];
    const englishRequests: ProviderSearchRequest[] = [];
    const chineseProvider = {
      ...successfulFakeProvider("baidu", 0), queryLanguage: "zh" as const,
      async search(request: ProviderSearchRequest) { chineseRequests.push(request); return []; }
    };
    const englishProvider = {
      ...successfulFakeProvider("fake", 0),
      async search(request: ProviderSearchRequest) { englishRequests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [chineseProvider, englishProvider], assetService: false });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "不对称双语配额", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["分类父级>音箱标签"], targetCount: 10, candidateCount: 20,
      labelSearchProfiles: [{
        labelPath: "分类父级>音箱标签",
        zh: { terms: ["蓝牙音箱"], styles: [], requiredTerms: [], excludedTerms: [] },
        en: { terms: ["speaker", "audio", "sound"], styles: ["minimal", "promotion"], requiredTerms: [], excludedTerms: [] }
      }]
    } });
    expect(created.statusCode).toBe(201);
    const job = created.json();

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["baidu", "fake"] } })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    expect(chineseRequests.map((request) => request.count)).toEqual([20]);
    expect(englishRequests.map((request) => request.count)).toEqual([5, 5, 5, 5]);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["baidu", "fake"] } })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    const runs = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{
      labelId: string; providerId: string; variantName: string; query: string; page: number;
    }>;
    const key = (run: (typeof runs)[number]) => [run.labelId, run.providerId, run.variantName, run.query, run.page].join("\u0000");
    expect(new Set(runs.map(key)).size).toBe(runs.length);
    expect(chineseRequests.map((request) => request.count)).toEqual([20]);
    expect(englishRequests.map((request) => request.count)).toEqual([5, 5, 5, 5, 10, 10]);
  });

  it("uses the matching bilingual search profile and locale for each provider", async () => {
    const chineseRequests: ProviderSearchRequest[] = [];
    const defaultEnglishRequests: ProviderSearchRequest[] = [];
    const explicitEnglishRequests: ProviderSearchRequest[] = [];
    const chineseProvider = {
      ...successfulFakeProvider("baidu", 0),
      queryLanguage: "zh" as const,
      async search(request: ProviderSearchRequest) { chineseRequests.push(request); return []; }
    };
    const defaultEnglishProvider = {
      ...successfulFakeProvider("fake", 0),
      async search(request: ProviderSearchRequest) { defaultEnglishRequests.push(request); return []; }
    };
    const explicitEnglishProvider = {
      ...successfulFakeProvider("brave", 0),
      queryLanguage: "en" as const,
      async search(request: ProviderSearchRequest) { explicitEnglishRequests.push(request); return []; }
    };
    const app = await createTestApp({
      providers: [chineseProvider, defaultEnglishProvider, explicitEnglishProvider],
      assetService: false
    });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "双语查询任务", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["标签父级>分类父级>标签音箱"],
      labelSearchProfiles: [{
        labelPath: "标签父级>分类父级>标签音箱",
        zh: {
          terms: ["蓝牙音箱", "智能扬声器"], styles: ["极简白底", "节日促销"],
          requiredTerms: ["新品"], excludedTerms: ["真人模特"]
        },
        en: {
          terms: ["speaker", "audio"], styles: ["minimal", "promotion"],
          requiredTerms: ["launch"], excludedTerms: ["people"]
        }
      }]
    } });
    expect(created.statusCode).toBe(201);
    const job = created.json();

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["baidu", "fake", "brave"] } })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");

    const assertChineseProfile = (requests: ProviderSearchRequest[]) => {
      const queries = requests.map((request) => request.query).join("\n");
      expect(requests).not.toHaveLength(0);
      expect(requests.every((request) => request.locale.startsWith("zh-"))).toBe(true);
      for (const term of ["蓝牙音箱", "智能扬声器", "极简白底", "节日促销", "新品", "-真人模特"]) expect(queries).toContain(term);
      expect(queries).not.toMatch(/标签父级|分类父级|标签音箱|speaker|audio|minimal|promotion|launch|people/u);
    };
    const assertEnglishProfile = (requests: ProviderSearchRequest[]) => {
      const queries = requests.map((request) => request.query).join("\n");
      expect(requests).not.toHaveLength(0);
      expect(requests.every((request) => request.locale.startsWith("en-"))).toBe(true);
      for (const term of ["speaker", "audio", "minimal", "promotion", "launch", "-people"]) expect(queries).toContain(term);
      expect(queries).not.toMatch(/标签父级|分类父级|标签音箱|蓝牙音箱|智能扬声器|极简白底|节日促销|新品|真人模特/u);
    };
    assertChineseProfile(chineseRequests);
    assertEnglishProfile(defaultEnglishRequests);
    assertEnglishProfile(explicitEnglishRequests);
  });

  it("drains active provider work before closing its externally owned transport", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let providerFinished = false;
    let cleanupSawFinished: boolean | undefined;
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "shutdown ordering", configured: true, maxResults: 1, rightsPolicy: "open",
      async search() {
        markStarted();
        await new Promise((resolve) => setTimeout(resolve, 20));
        providerFinished = true;
        return [];
      }
    };
    const app = await createTestApp({
      providers: [provider],
      assetService: false,
      closeExternalResources: async () => { cleanupSawFinished = providerFinished; }
    });
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await started;

    await app.close();

    expect(cleanupSawFinished).toBe(true);
  });

  it("uses the label candidate budget for bounded requests and stops once it is reached", async () => {
    const requests: ProviderSearchRequest[] = [];
    let requestNumber = 0;
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "budget recorder", configured: true, maxResults: 2, rightsPolicy: "open",
      async search(request) {
        requests.push(request);
        requestNumber += 1;
        return Array.from({ length: request.count }, (_, index): NormalizedHit => ({
          provider: "fake", rank: index + 1, thumbnailUrl: null,
          imageUrl: `https://images.example.test/budget-${requestNumber}-${index}.jpg`, landingPageUrl: null,
          title: null, creator: null, licenseName: null, licenseUrl: null, width: 800, height: 800,
          sourceProvider: "fake", source: "fake", rightsStatus: "unknown"
        }));
      }
    };
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "有界候选任务", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["电商>音箱"], aliases: ["蓝牙音响", "智能扬声器"], styles: ["极简白底", "节日促销"],
      labelSearchProfiles: [{
        labelPath: "电商>音箱",
        zh: { terms: ["蓝牙音响", "智能扬声器"], styles: ["极简白底", "节日促销"], requiredTerms: ["促销价"], excludedTerms: ["实拍"] },
        en: { terms: ["蓝牙音响", "智能扬声器"], styles: ["极简白底", "节日促销"], requiredTerms: ["促销价"], excludedTerms: ["实拍"] }
      }],
      requiredTerms: ["促销价"], excludedTerms: ["实拍"], targetCount: 2, candidateCount: 3
    } });
    expect(created.statusCode).toBe(201);
    const job = created.json();
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, job.id, "reviewing");

    const page = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json();
    expect(requests.map((request) => request.count)).toEqual([1, 1, 1]);
    expect(page.items).toHaveLength(3);
    expect(page.labelProgress).toEqual([{ labelId: job.labels[0].id, candidateCount: 3 }]);
    const plannedQueries = page.providerRuns.map((run: { query: string }) => run.query).join("\n");
    for (const term of ["蓝牙音响", "智能扬声器", "极简白底", "节日促销", "促销价", "-实拍"]) expect(plannedQueries).toContain(term);
  });

  it("does not call providers for a label whose selected target is already reached", async () => {
    const provider = successfulFakeProvider("fake", 1);
    const search = vi.spyOn(provider, "search");
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "已达标任务", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["电商>音箱"], labelSearchProfiles: makeBilingualProfiles(["电商>音箱"]), targetCount: 1, candidateCount: 10
    } });
    const job = response.json();
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare("UPDATE label_targets SET selected_count = 1 WHERE job_id = ? AND label_id = ?").run(job.id, job.labels[0].id);

    const exhausted = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toEqual({ status: "exhausted" });
    await waitForJob(app, job.id, "reviewing");
    expect(search).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns).toEqual([]);
  });

  it("explicitly retries a retryable provider while advancing successful paginated providers", async () => {
    const successful = fullDeduplicatedPageProvider("fake");
    const successfulSearch = vi.spyOn(successful, "search");
    let fail = true;
    const recovering: ImageSearchProvider = {
      id: "openverse", displayName: "recovering", configured: true, maxResults: 100, rightsPolicy: "open",
      async search() { if (fail) throw new ProviderError("openverse", 503, true); return []; }
    };
    const recoveringSearch = vi.spyOn(recovering, "search");
    const app = await createTestApp({ providers: [successful, recovering], assetService: false, searchRetry: { maxAttempts: 1 } }); apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
    await waitForJob(app, String(job.id), "reviewing");
    const firstRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; providerId: string }>;
    const successfulIds = firstRuns.filter((run) => run.providerId === "fake").map((run) => run.id);
    const failedIds = firstRuns.filter((run) => run.providerId === "openverse").map((run) => run.id);
    const successfulCalls = successfulSearch.mock.calls.length;

    fail = false;
    await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake", "openverse"], retryFailedProviderIds: ["openverse"] }
    });
    await waitForJob(app, String(job.id), "reviewing");
    const secondRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; providerId: string; status: string }>;
    expect(successfulSearch).toHaveBeenCalledTimes(successfulCalls * 2);
    expect(recoveringSearch).toHaveBeenCalledTimes(failedIds.length * 2);
    expect(secondRuns.filter((run) => run.providerId === "fake").map((run) => run.id).slice(0, successfulIds.length)).toEqual(successfulIds);
    expect(secondRuns.filter((run) => run.providerId === "fake")).toHaveLength(successfulIds.length * 2);
    expect(secondRuns.filter((run) => run.providerId === "openverse").map((run) => run.id)).toEqual(failedIds);
    expect(secondRuns.every((run) => run.status === "completed")).toBe(true);
  });

  it("keeps terminal provider failures unchanged while other providers advance", async () => {
    const successful = fullDeduplicatedPageProvider("fake");
    const successfulSearch = vi.spyOn(successful, "search");
    const terminal = failingFakeProvider("openverse", 400);
    const terminalSearch = vi.spyOn(terminal, "search");
    const app = await createTestApp({ providers: [successful, terminal], assetService: false, searchRetry: { maxAttempts: 1 } }); apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
    await waitForJob(app, String(job.id), "reviewing");
    const firstRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; providerId: string; status: string }>;
    const terminalIds = firstRuns.filter((run) => run.providerId === "openverse").map((run) => run.id);
    const firstSuccessfulCalls = successfulSearch.mock.calls.length;
    const firstTerminalCalls = terminalSearch.mock.calls.length;

    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
    await waitForJob(app, String(job.id), "reviewing");
    const secondRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; providerId: string; status: string; page: number }>;

    expect(successfulSearch).toHaveBeenCalledTimes(firstSuccessfulCalls * 2);
    expect(terminalSearch).toHaveBeenCalledTimes(firstTerminalCalls);
    expect(secondRuns.filter((run) => run.providerId === "openverse").map((run) => run.id)).toEqual(terminalIds);
    expect(secondRuns.filter((run) => run.providerId === "openverse").every((run) => run.status === "failed")).toBe(true);
    expect(secondRuns.filter((run) => run.providerId === "fake" && run.page === 2)).not.toHaveLength(0);
  });

  it("does not call a terminal-only provider when continuation has no fresh or resumable runs", async () => {
    const terminal = failingFakeProvider("fake", 400);
    const terminalSearch = vi.spyOn(terminal, "search");
    const app = await createTestApp({ providers: [terminal], assetService: false, searchRetry: { maxAttempts: 1 } }); apps.push(app);
    const job = await createSpeakerJob(app);

    const firstStart = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    expect(firstStart.statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    const firstCalls = terminalSearch.mock.calls.length;
    const firstRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; status: string }>;

    const continuation = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    expect(continuation.statusCode).toBe(200);
    expect(continuation.json()).toEqual({ status: "exhausted" });
    await waitForJob(app, String(job.id), "reviewing");
    const secondRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; status: string }>;

    expect(terminalSearch).toHaveBeenCalledTimes(firstCalls);
    expect(secondRuns).toEqual(firstRuns);
    expect(secondRuns.every((run) => run.status === "failed")).toBe(true);
  });

  it("fills missing keys on a failed provider's current page without retrying the failed run or advancing pages", async () => {
    const provider = successfulFakeProvider("fake", 0);
    const search = vi.spyOn(provider, "search");
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    const insert = database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, request_count, status, error_summary, retryable, created_at)
      VALUES (?, ?, ?, 'fake', ?, ?, 1, 100, ?, ?, 0, '2025-01-01T00:00:00.000Z')
    `);
    insert.run("terminal-current-page", job.id, job.labels[0].id, "exact_ad", "音箱 电商海报", "failed", "configuration rejected the request");
    insert.run("completed-parent", job.id, job.labels[0].id, "parent_disambiguated", "影音电器 音箱 电商广告", "completed", null);
    insert.run("completed-style-one", job.id, job.labels[0].id, "style_required", "音箱 电商广告 商品展示", "completed", null);
    insert.run("completed-style-two", job.id, job.labels[0].id, "style_required", "音箱 商品展示 商品展示", "completed", null);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    const afterFill = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; query: string; page: number; status: string }>;
    expect(search).toHaveBeenCalledTimes(1);
    expect(afterFill).toHaveLength(5);
    expect(afterFill).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "terminal-current-page", status: "failed", page: 1 }),
      expect.objectContaining({ query: "音箱 product ad", status: "completed", page: 1 })
    ]));

    const exhausted = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toEqual({ status: "exhausted" });
    await waitForJob(app, String(job.id), "reviewing");
    expect(search).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns).toHaveLength(5);
  });

  it("creates a large valid plan in bounded same-page batches without duplicate run keys", async () => {
    const providerIds = ["fake", "openverse", "brave", "serpapi", "dataforseo"] as const;
    const providers = providerIds.map((providerId) => successfulFakeProvider(providerId, 0));
    const app = await createTestApp({ providers, assetService: false }); apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "超大搜索计划", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: Array.from({ length: 81 }, (_, index) => `电商>商品-${index}`),
      labelSearchProfiles: makeBilingualProfiles(Array.from({ length: 81 }, (_, index) => `电商>商品-${index}`))
    } });
    expect(created.statusCode).toBe(201);
    const job = created.json();

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds } })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    const firstRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{
      id: string; labelId: string; providerId: string; variantName: string; query: string; page: number;
    }>;
    expect(firstRuns).toHaveLength(2000);
    expect(firstRuns.every((run) => run.page === 1)).toBe(true);
    expect(Object.fromEntries(providerIds.map((providerId) => [providerId, firstRuns.filter((run) => run.providerId === providerId).length])))
      .toEqual({ fake: 400, openverse: 400, brave: 400, serpapi: 400, dataforseo: 400 });

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds } })).statusCode).toBe(202);
    await waitForJob(app, job.id, "reviewing");
    const secondRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as typeof firstRuns;
    const runKey = (run: (typeof secondRuns)[number]) => [run.labelId, run.providerId, run.variantName, run.query, run.page].join("\u0000");
    expect(secondRuns).toHaveLength(2025);
    expect(secondRuns.slice(0, firstRuns.length).map((run) => run.id)).toEqual(firstRuns.map((run) => run.id));
    expect(secondRuns.slice(firstRuns.length).every((run) => run.page === 1)).toBe(true);
    expect(new Set(secondRuns.map(runKey)).size).toBe(secondRuns.length);
    expect(Object.fromEntries(providerIds.map((providerId) => [providerId, secondRuns.filter((run) => run.providerId === providerId).length])))
      .toEqual({ fake: 405, openverse: 405, brave: 405, serpapi: 405, dataforseo: 405 });
  }, 30_000);

  it("claims a legacy resumable backlog in provider-fair 2000-run batches and leaves the remainder resumable", async () => {
    const fake = successfulFakeProvider("fake", 0);
    const openverse = successfulFakeProvider("openverse", 0);
    const fakeSearch = vi.spyOn(fake, "search");
    const openverseSearch = vi.spyOn(openverse, "search");
    const app = await createTestApp({ providers: [fake, openverse], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    const insert = database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, request_count, status, retryable, created_at)
      VALUES (?, ?, ?, ?, 'legacy', ?, 1, 100, 'retryable', 1, ?)
    `);
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.prepare("UPDATE label_targets SET selected_count = 30 WHERE job_id = ? AND label_id = ?").run(job.id, job.labels[0].id);
      for (let index = 0; index < 2001; index += 1) {
        insert.run(`legacy-run-${String(index).padStart(4, "0")}`, job.id, job.labels[0].id, "fake", `legacy-query-${index}`, "2025-01-01T00:00:00.000Z");
      }
      insert.run("legacy-openverse-run", job.id, job.labels[0].id, "openverse", "legacy-openverse-query", "2025-01-01T00:00:00.000Z");
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } })).statusCode).toBe(202);
    await vi.waitFor(() => {
      const counts = database.prepare("SELECT status, COUNT(*) AS count FROM query_runs WHERE job_id = ? GROUP BY status ORDER BY status").all(job.id) as unknown as Array<{ status: string; count: number }>;
      expect(counts).toEqual([{ status: "completed", count: 2000 }, { status: "retryable", count: 2 }]);
    }, { timeout: 20_000, interval: 20 });
    expect(fakeSearch).not.toHaveBeenCalled();
    expect(openverseSearch).not.toHaveBeenCalled();
    expect((database.prepare("SELECT status FROM query_runs WHERE id = 'legacy-openverse-run'").get() as { status: string }).status).toBe("completed");
    expect((database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ? AND provider_id = 'fake' AND status = 'retryable'").get(job.id) as { count: number }).count).toBe(2);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } })).statusCode).toBe(202);
    await vi.waitFor(() => {
      const result = database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ? AND status = 'completed'").get(job.id) as { count: number };
      expect(result.count).toBe(2002);
    }, { timeout: 20_000, interval: 20 });
    expect(fakeSearch).not.toHaveBeenCalled();
    expect(openverseSearch).not.toHaveBeenCalled();
    expect((database.prepare("SELECT COUNT(DISTINCT id) AS count FROM query_runs WHERE job_id = ?").get(job.id) as { count: number }).count).toBe(2002);
  }, 30_000);

  it("advances paginated providers and never repeats page one for non-paginated providers", async () => {
    const pagedRequests: ProviderSearchRequest[] = [];
    const paged: ImageSearchProvider = {
      id: "fake", displayName: "stable pager", configured: true, maxResults: 100, rightsPolicy: "open", supportsPagination: true,
      async search(request) {
        pagedRequests.push(request);
        return Array.from({ length: request.count }, (_, index): NormalizedHit => ({
          provider: "fake", rank: index + 1, thumbnailUrl: null,
          imageUrl: `https://images.example.test/page-${request.page}-${index}.jpg`, landingPageUrl: null,
          title: null, creator: null, licenseName: null, licenseUrl: null, width: 800, height: 800,
          sourceProvider: "fake", source: "fake", rightsStatus: "unknown"
        }));
      }
    };
    const app = await createTestApp({ providers: [paged], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);
    for (let index = 0; index < 2; index += 1) {
      await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
      await waitForJob(app, String(job.id), "reviewing");
    }
    const halfway = pagedRequests.length / 2;
    expect(halfway).toBeGreaterThan(0);
    expect(pagedRequests.slice(0, halfway).every((request) => request.page === 1)).toBe(true);
    expect(pagedRequests.slice(halfway).every((request) => request.page === 2)).toBe(true);
    expect(new Set(pagedRequests.map((request) => request.count))).toEqual(new Set([20]));
    expect(pagedRequests[0]!.count).toBe(pagedRequests[halfway]!.count);

    const onePageRequests: ProviderSearchRequest[] = [];
    const onePage = {
      ...successfulFakeProvider("openverse", 0), supportsPagination: false,
      async search(request: ProviderSearchRequest) { onePageRequests.push(request); return []; }
    } as ImageSearchProvider & { supportsPagination: boolean };
    const secondApp = await createTestApp({ providers: [onePage], assetService: false }); apps.push(secondApp);
    const secondJob = await createSpeakerJob(secondApp);
    for (let index = 0; index < 2; index += 1) {
      await secondApp.inject({ method: "POST", url: `/api/jobs/${secondJob.id}/search`, payload: { providerIds: ["openverse"] } });
      await waitForJob(secondApp, String(secondJob.id), "reviewing");
    }
    expect(onePageRequests.length).toBeGreaterThan(0);
    expect(onePageRequests.every((request) => request.page === 1)).toBe(true);
    const onePageRuns = (await secondApp.inject({ method: "GET", url: `/api/jobs/${secondJob.id}/candidates` })).json().providerRuns;
    expect(onePageRuns).toHaveLength(onePageRequests.length);
  });

  it("keeps one in-flight request per provider while processing different labels concurrently", async () => {
    let active = 0;
    let peak = 0;
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "serialized provider", configured: true, maxResults: 100, rightsPolicy: "open",
      async search() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return [];
      }
    };
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "多标签并发任务", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["电商>音箱", "电商>耳机", "电商>投影仪", "电商>电视"],
      labelSearchProfiles: makeBilingualProfiles(["电商>音箱", "电商>耳机", "电商>投影仪", "电商>电视"]), styles: ["电商广告"]
    } });
    const job = response.json();
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, job.id, "reviewing");
    expect(peak).toBe(1);
  });

  it("atomically enforces the label candidate budget across concurrent providers", async () => {
    let requestNumber = 0;
    const provider = (id: "fake" | "openverse"): ImageSearchProvider => ({
      id, displayName: id, configured: true, maxResults: 100, rightsPolicy: "open",
      async search(request) {
        requestNumber += 1;
        return Array.from({ length: 3 }, (_, index): NormalizedHit => ({
          provider: id, rank: index + 1, thumbnailUrl: null,
          imageUrl: `https://images.example.test/${id}-${requestNumber}-${index}.jpg`, landingPageUrl: null,
          title: null, creator: null, licenseName: null, licenseUrl: null, width: 800, height: 800,
          sourceProvider: id, source: id, rightsStatus: "unknown"
        }));
      }
    });
    const app = await createTestApp({ providers: [provider("fake"), provider("openverse")], assetService: false }); apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "原子候选预算", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: ["电商>音箱"], labelSearchProfiles: makeBilingualProfiles(["电商>音箱"]), candidateCount: 3, targetCount: 2
    } });
    const job = created.json();

    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
    await waitForJob(app, job.id, "reviewing");
    const page = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json();

    expect(page.items).toHaveLength(3);
    expect(page.labelProgress).toEqual([{ labelId: job.labels[0].id, candidateCount: 3 }]);
  });

  it("does not create or call provider pages beyond a provider's pagination window", async () => {
    const pages: number[] = [];
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "bounded pager", configured: true, maxResults: 100, rightsPolicy: "open", supportsPagination: true,
      canRequestPage: (page) => page === 1,
      async search(request) { pages.push(request.page ?? 1); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");
    const firstRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string }>;

    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");
    const secondRuns = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string }>;

    expect(new Set(pages)).toEqual(new Set([1]));
    expect(secondRuns.map((run) => run.id)).toEqual(firstRuns.map((run) => run.id));
  });

  it("runs different provider queues concurrently for a single label", async () => {
    let release!: () => void;
    let signalBothStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const bothStarted = new Promise<void>((resolve) => { signalBothStarted = resolve; });
    let active = 0;
    let peak = 0;
    const started = new Set<string>();
    const provider = (id: "fake" | "openverse"): ImageSearchProvider => ({
      id, displayName: id, configured: true, maxResults: 100, rightsPolicy: "open",
      async search() {
        active += 1;
        peak = Math.max(peak, active);
        started.add(id);
        if (started.size === 2) signalBothStarted();
        await blocked;
        active -= 1;
        return [];
      }
    });
    const app = await createTestApp({ providers: [provider("fake"), provider("openverse")], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);

    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
    await Promise.race([bothStarted, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    const observedPeak = peak;
    release();
    await waitForJob(app, String(job.id), "reviewing");

    expect(observedPeak).toBe(2);
  });

  it("waits for every provider loop before releasing a job after an unexpected database failure", async () => {
    let releaseOpenverse!: () => void;
    let signalOpenverseStarted!: () => void;
    const openverseBlocked = new Promise<void>((resolve) => { releaseOpenverse = resolve; });
    const openverseStarted = new Promise<void>((resolve) => { signalOpenverseStarted = resolve; });
    const fakeSearch = vi.fn(async () => []);
    let openverseCalls = 0;
    const fake: ImageSearchProvider = {
      id: "fake", displayName: "failing transition", configured: true, maxResults: 100, rightsPolicy: "open", search: fakeSearch
    };
    const openverse: ImageSearchProvider = {
      id: "openverse", displayName: "blocked peer", configured: true, maxResults: 100, rightsPolicy: "open",
      async search() {
        openverseCalls += 1;
        if (openverseCalls === 1) {
          signalOpenverseStarted();
          await openverseBlocked;
        }
        return [];
      }
    };
    const app = await createTestApp({ providers: [fake, openverse], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.exec(`
      CREATE TRIGGER fail_fake_running_event BEFORE INSERT ON job_events
      WHEN NEW.status = 'running' AND (SELECT provider_id FROM query_runs WHERE id = NEW.query_run_id) = 'fake'
      BEGIN SELECT RAISE(ABORT, 'fake running event failed'); END;
    `);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } })).statusCode).toBe(202);
    await openverseStarted;
    const overlapping = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
    releaseOpenverse();
    expect(overlapping.statusCode).toBe(409);
    await waitForJob(app, String(job.id), "reviewing");
    const runs = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ providerId: string; status: string }>;
    expect(fakeSearch).not.toHaveBeenCalled();
    expect(openverseCalls).toBe(5);
    expect(runs.filter((run) => run.providerId === "fake").every((run) => run.status === "retryable")).toBe(true);
    expect(runs.filter((run) => run.providerId === "openverse").every((run) => run.status === "completed")).toBe(true);
  });

  it("restores claimed resumable rows and releases the job reservation when fresh-run creation fails", async () => {
    const fake = successfulFakeProvider("fake", 0);
    const openverse = successfulFakeProvider("openverse", 0);
    const fakeSearch = vi.spyOn(fake, "search");
    const app = await createTestApp({ providers: [fake, openverse], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, request_count, status, retryable, created_at)
      VALUES ('sync-claimed-run', ?, ?, 'fake', 'exact_ad', '音箱 电商海报', 1, 100, 'retryable', 1, '2025-01-01T00:00:00.000Z')
    `).run(job.id, job.labels[0].id);
    database.exec(`
      CREATE TRIGGER fail_fresh_pending_event BEFORE INSERT ON job_events
      WHEN NEW.status = 'pending' AND NEW.query_run_id <> 'sync-claimed-run'
      BEGIN SELECT RAISE(ABORT, 'fresh pending event failed'); END;
    `);

    const failedStart = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
    expect(failedStart.statusCode).toBe(500);
    expect((database.prepare("SELECT status FROM query_runs WHERE id = 'sync-claimed-run'").get() as { status: string }).status).toBe("retryable");
    expect((database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ?").get(job.id) as { count: number }).count).toBe(1);

    database.exec("DROP TRIGGER fail_fresh_pending_event;");
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    expect(fakeSearch).toHaveBeenCalledTimes(5);
    expect((database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ?").get(job.id) as { count: number }).count).toBe(5);
    expect((database.prepare("SELECT status FROM query_runs WHERE id = 'sync-claimed-run'").get() as { status: string }).status).toBe("completed");
  });

  it("rotates the four execution slots so a fifth provider starts before earlier queues drain", async () => {
    let releaseFirstWave!: () => void;
    let releaseRemaining!: () => void;
    let signalFirstWave!: () => void;
    let signalFifthStarted!: () => void;
    const firstWaveBlocked = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
    const remainingBlocked = new Promise<void>((resolve) => { releaseRemaining = resolve; });
    const firstWaveStarted = new Promise<void>((resolve) => { signalFirstWave = resolve; });
    const fifthStarted = new Promise<void>((resolve) => { signalFifthStarted = resolve; });
    const calls = new Map<string, number>();
    const firstFour = new Set(["fake", "openverse", "brave", "serpapi"]);
    const providerIds = ["fake", "openverse", "brave", "serpapi", "dataforseo"] as const;
    const providers = providerIds.map((id): ImageSearchProvider => ({
      id, displayName: id, configured: true, maxResults: 100, rightsPolicy: "open",
      async search() {
        const count = (calls.get(id) ?? 0) + 1;
        calls.set(id, count);
        if (id === "dataforseo") {
          signalFifthStarted();
          return [];
        }
        if (firstFour.has(id) && count === 1) {
          if ([...firstFour].every((providerId) => (calls.get(providerId) ?? 0) >= 1)) signalFirstWave();
          await firstWaveBlocked;
        } else {
          await remainingBlocked;
        }
        return [];
      }
    }));
    const app = await createTestApp({ providers, assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);

    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds } });
    await firstWaveStarted;
    releaseFirstWave();
    const fifthStartedBeforeDrain = await Promise.race([
      fifthStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    releaseRemaining();
    await waitForJob(app, String(job.id), "reviewing");

    expect(fifthStartedBeforeDrain).toBe(true);
    expect(calls.get("dataforseo")).toBeGreaterThan(0);
  });

  it("keeps round-robin label order inside each provider queue", async () => {
    const queries: string[] = [];
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "fair provider", configured: true, maxResults: 100, rightsPolicy: "open",
      async search(request) { queries.push(request.query); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const products = ["音箱", "耳机", "投影仪", "电视", "冰箱"];
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "标签公平调度", taskType: "advertiser_product_taxonomy", exportMode: "internal_research",
      labelPaths: products.map((product) => `电商>${product}`),
      labelSearchProfiles: makeBilingualProfiles(products.map((product) => `电商>${product}`)), styles: ["电商广告"]
    } });
    const job = created.json();

    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, job.id, "reviewing");

    expect(queries.slice(0, products.length)).toEqual(products.map((product) => `${product} 电商海报`));
  });

  it("keeps successful candidates when another provider fails", async () => {
    const app = await createTestApp({ providers: [successfulFakeProvider("fake", 3), failingFakeProvider("openverse", 429)] });
    apps.push(app);
    const job = await createSpeakerJob(app);
    const started = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });

    expect(started.statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    const candidates = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` });
    expect(candidates.json().items).toHaveLength(3);
    expect(candidates.json().providerRuns.some((run: { status: string }) => run.status === "failed")).toBe(true);
  });

  it("does not return provider error details that could contain credentials", async () => {
    const leakyProvider = { ...failingFakeProvider("fake", 500), search: async () => { throw new Error("token=provider-secret"); } };
    const app = await createTestApp({ providers: [leakyProvider] });
    apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");

    const candidates = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` });
    expect(candidates.body).not.toContain("provider-secret");
  });

  it("uses only the requested provider allowlist", async () => {
    const app = await createTestApp({ providers: [successfulFakeProvider("fake", 2), successfulFakeProvider("openverse", 4)] });
    apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });

    await waitForJob(app, String(job.id), "reviewing");
    const candidates = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` });
    expect(candidates.json().items).toHaveLength(2);
    expect(candidates.json().providerRuns.map((run: { providerId: string }) => run.providerId)).toEqual(["fake", "fake", "fake", "fake", "fake"]);
  });

  it("rejects an unconfigured selected provider without changing the job or creating runs", async () => {
    const disabledProvider = { ...successfulFakeProvider("brave", 1), configured: false };
    const app = await createTestApp({ providers: [disabledProvider] });
    apps.push(app);
    const job = await createSpeakerJob(app);

    const response = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["brave"] } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Requested provider is disabled." });
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().status).toBe("draft");
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns).toEqual([]);
  });

  it("deduplicates repeated normalized URLs into one candidate and one provenance hit per run", async () => {
    const base = successfulFakeProvider("fake", 1);
    const duplicateProvider = { ...base, search: async (...args: Parameters<typeof base.search>) => {
      const [hit] = await base.search(...args);
      return [hit!, { ...hit!, rank: 2 }];
    } };
    const app = await createTestApp({ providers: [duplicateProvider] });
    apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");

    const { items, providerRuns } = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json();
    expect(items).toHaveLength(1);
    expect(providerRuns).toHaveLength(5);
    expect(providerRuns).toEqual(expect.arrayContaining([expect.objectContaining({ status: "completed", hitCount: 2, errorSummary: null, startedAt: expect.any(String), completedAt: expect.any(String), durationMs: expect.any(Number) })]));
    expect(providerRuns.every((run: { hitCount: number }) => run.hitCount === 2)).toBe(true);
  });

  it("keeps URL-deduplicated candidates isolated to their collection job", async () => {
    const app = await createTestApp({ providers: [successfulFakeProvider("fake", 1)] });
    apps.push(app);
    const first = await createSpeakerJob(app);
    const second = await createSpeakerJob(app);
    for (const job of [first, second]) {
      await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
      await waitForJob(app, String(job.id), "reviewing");
    }

    expect((await app.inject({ method: "GET", url: `/api/jobs/${first.id}/candidates` })).json().items).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/jobs/${second.id}/candidates` })).json().items).toHaveLength(1);
  });

  it("rejects overlapping active searches and preserves cursor ordered events after a pause", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const slowProvider = { ...successfulFakeProvider("fake", 1), search: async () => { await pending; return []; } };
    const app = await createTestApp({ providers: [slowProvider] });
    apps.push(app);
    const job = await createSpeakerJob(app);
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/pause` })).statusCode).toBe(200);
    release();
    await waitForJob(app, String(job.id), "reviewing");
    const events = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/events` });
    expect(events.statusCode).toBe(200);
    expect(events.json().items.map((event: { cursor: number }) => event.cursor)).toEqual([...events.json().items.map((event: { cursor: number }) => event.cursor)].sort((a: number, b: number) => a - b));
  });

  it("leaves unclaimed runs paused until an explicit continuation reuses their ids", async () => {
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let providerCalls = 0;
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "pausable provider", configured: true, maxResults: 100, rightsPolicy: "open",
      async search() {
        providerCalls += 1;
        if (providerCalls === 1) {
          signalFirstStarted();
          await firstBlocked;
        }
        return [];
      }
    };
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await firstStarted;
    const beforePause = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; status: string }>;
    expect(beforePause).toHaveLength(5);
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/pause` })).json()).toEqual({ paused: 4 });
    releaseFirst();
    await waitForJob(app, String(job.id), "reviewing");

    const afterPause = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; status: string }>;
    expect(providerCalls).toBe(1);
    expect(afterPause.filter((run) => run.status === "completed")).toHaveLength(1);
    expect(afterPause.filter((run) => run.status === "paused")).toHaveLength(4);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    const afterContinuation = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; status: string }>;
    expect(providerCalls).toBe(5);
    expect(afterContinuation.map((run) => run.id)).toEqual(beforePause.map((run) => run.id));
    expect(afterContinuation.every((run) => run.status === "completed")).toBe(true);
  });

  it("claims resumed rows as pending so Pause can stop the continuation before the next provider call", async () => {
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    let providerCalls = 0;
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "resumed pause provider", configured: true, maxResults: 100, rightsPolicy: "open",
      async search() {
        providerCalls += 1;
        if (providerCalls === 1) {
          signalFirstStarted();
          await firstBlocked;
        }
        return [];
      }
    };
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const job = await createSpeakerJob(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    const insert = database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, request_count, status, retryable, created_at)
      VALUES (?, ?, ?, 'fake', ?, ?, 1, 100, 'retryable', 1, '2025-01-01T00:00:00.000Z')
    `);
    insert.run("resumed-pause-one", job.id, job.labels[0].id, "exact_ad", "音箱 电商海报");
    insert.run("resumed-pause-two", job.id, job.labels[0].id, "english_ad", "音箱 product ad");

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await firstStarted;
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/pause` })).json()).toEqual({ paused: 4 });
    releaseFirst();
    await waitForJob(app, String(job.id), "reviewing");
    const paused = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; status: string }>;
    expect(providerCalls).toBe(1);
    expect(paused).toHaveLength(5);
    expect(paused).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "resumed-pause-one", status: "paused" }),
      expect.objectContaining({ id: "resumed-pause-two", status: "paused" })
    ]));
    expect(paused.filter((run) => run.status === "paused")).toHaveLength(4);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    expect(providerCalls).toBe(5);
    const resumed = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ id: string; status: string }>;
    expect(resumed).toHaveLength(5);
    expect(resumed.every((run) => run.status === "completed")).toBe(true);
  });

  it("returns completed run transitions when polling after a running-event cursor", async () => {
    let unblock!: () => void;
    let markRunning!: () => void;
    const started = new Promise<void>((resolve) => { markRunning = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const base = successfulFakeProvider("fake", 1);
    const provider = { ...base, search: async (...args: Parameters<typeof base.search>) => {
      markRunning();
      await blocked;
      return base.search(...args);
    } };
    const app = await createTestApp({ providers: [provider] });
    apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await started;

    const before = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/events` });
    expect(before.json().items.some((event: { status: string }) => event.status === "running")).toBe(true);
    unblock();
    await waitForJob(app, String(job.id), "reviewing");
    const after = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/events?cursor=${before.json().nextCursor}` });
    expect(after.json().items.some((event: { status: string }) => event.status === "completed")).toBe(true);
    expect(after.json().items.every((event: { cursor: number }) => event.cursor > before.json().nextCursor)).toBe(true);
  });

  it("preserves an empty poll cursor and resumes from it without replaying history", async () => {
    const app = await createTestApp({ providers: [fullDeduplicatedPageProvider("fake")] });
    apps.push(app);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");
    const terminal = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/events` });
    const cursor = terminal.json().nextCursor as number;

    const empty = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/events?cursor=${cursor}` });
    expect(empty.json()).toEqual({ items: [], nextCursor: cursor });
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");
    const resumed = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/events?cursor=${cursor}` });
    expect(resumed.json().items).not.toHaveLength(0);
    expect(resumed.json().items.every((event: { cursor: number }) => event.cursor > cursor)).toBe(true);
  });
});
