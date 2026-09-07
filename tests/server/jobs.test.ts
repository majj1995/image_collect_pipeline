import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, makeBilingualProfiles } from "../helpers/server.js";

const apps: Array<Awaited<ReturnType<typeof createTestApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("job routes", () => {
  it("rejects new jobs that omit their required bilingual search profiles", async () => {
    const app = await createTestApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "缺少双语检索条件",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商快销>影音电器>音箱"]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["labelSearchProfiles"] })
    ]));
  });

  it("creates a job with an immutable taxonomy snapshot", async () => {
    const app = await createTestApp();
    apps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "音箱任务",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商快销>3C及电器>影音电器>音箱"],
        labelSearchProfiles: makeBilingualProfiles(["电商快销>3C及电器>影音电器>音箱"])
      }
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.labels[0].product).toBe("音箱");
    const reloaded = await app.inject({ method: "GET", url: `/api/jobs/${body.id}` });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json().labels).toEqual(body.labels);
  });

  it("persists search platforms through create, read, and copy while old rows expose an empty list", async () => {
    const app = await createTestApp();
    apps.push(app);
    const searchPlatforms = ["taobao_tmall", "jd", "pinduoduo", "vipshop", "xiaohongshu", "douyin"];
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "平台定向任务",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商快销>影音电器>音箱"],
        labelSearchProfiles: makeBilingualProfiles(["电商快销>影音电器>音箱"]),
        searchPlatforms
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().searchPlatforms).toEqual(searchPlatforms);
    const copied = await app.inject({ method: "POST", url: `/api/jobs/${created.json().id}/copy` });
    expect(copied.statusCode).toBe(201);
    expect(copied.json().searchPlatforms).toEqual(searchPlatforms);

    const database = (app as typeof app & { database: import("../../src/server/database.js").AppDatabase }).database;
    database.prepare("INSERT INTO jobs (id, name, task_type, export_mode, status, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-job", "旧任务", "advertiser_product_taxonomy", "internal_research", "draft", "{}", "now", "now");
    const legacy = await app.inject({ method: "GET", url: "/api/jobs/legacy-job" });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().searchPlatforms).toEqual([]);
  });

  it("keeps label order when a later line makes an existing parent a leaf", async () => {
    const app = await createTestApp();
    apps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "层级顺序",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["A>B>C", "A>B"],
        labelSearchProfiles: makeBilingualProfiles(["A>B>C", "A>B"])
      }
    });
    const body = created.json();
    const reloaded = await app.inject({ method: "GET", url: `/api/jobs/${body.id}` });

    expect(body.labels.map((label: { path: string[] }) => label.path)).toEqual([["A", "B", "C"], ["A", "B"]]);
    expect(reloaded.json().labels).toEqual(body.labels);
  });

  it("persists and copies bilingual search profiles without using the label path as query text", async () => {
    const app = await createTestApp();
    apps.push(app);
    const profile = {
      labelPath: "安防监控>监控摄像头",
      zh: { terms: ["监控摄像头", "安防摄像机"], styles: ["电商广告"], requiredTerms: ["促销"], excludedTerms: ["实拍"] },
      en: { terms: ["security camera", "surveillance camera"], styles: ["ecommerce advertisement"], requiredTerms: ["promotion"], excludedTerms: ["real photo"] }
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "双语检索任务",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: [profile.labelPath],
        labelSearchProfiles: [profile]
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().labels[0].searchProfiles).toEqual({ zh: profile.zh, en: profile.en });

    const copied = await app.inject({ method: "POST", url: `/api/jobs/${created.json().id}/copy` });
    expect(copied.statusCode).toBe(201);
    expect(copied.json().labels[0].searchProfiles).toEqual({ zh: profile.zh, en: profile.en });
  });

  it("rejects label paths with an empty hierarchy level", async () => {
    const app = await createTestApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "坏路径",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商快销>>音箱"],
        labelSearchProfiles: makeBilingualProfiles(["电商快销>>音箱"])
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors).toEqual([
      { line: 1, message: "Path contains an empty hierarchy level." }
    ]);
  });

  it("rejects a candidate count below the target count at the API boundary", async () => {
    const app = await createTestApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name: "数量不足的任务",
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商快销>3C及电器>音箱"],
        labelSearchProfiles: makeBilingualProfiles(["电商快销>3C及电器>音箱"]),
        targetCount: 30,
        candidateCount: 20
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["candidateCount"], message: "候选素材数不能小于目标素材数。" })
    ]));
  });

  it("lists, patches, copies, and deletes only the requested job", async () => {
    const app = await createTestApp();
    apps.push(app);
    const create = async (name: string) => app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        name,
        taskType: "advertiser_product_taxonomy",
        exportMode: "internal_research",
        labelPaths: ["电商快销>影音电器>音箱"],
        labelSearchProfiles: makeBilingualProfiles(["电商快销>影音电器>音箱"])
      }
    });
    const first = (await create("原任务")).json();
    const second = (await create("保留任务")).json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${first.id}`,
      payload: { name: "已更名任务", status: "reviewing" }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "已更名任务", status: "reviewing" });

    const copied = await app.inject({ method: "POST", url: `/api/jobs/${first.id}/copy` });
    expect(copied.statusCode).toBe(201);
    expect(copied.json()).toMatchObject({ name: "已更名任务 副本", status: "draft" });
    expect(copied.json().labels.map(({ jobId, ...label }: { jobId: string }) => label)).toEqual(
      first.labels.map(({ jobId, ...label }: { jobId: string }) => label)
    );
    expect(copied.json().id).not.toBe(first.id);

    const listed = await app.inject({ method: "GET", url: "/api/jobs" });
    expect(listed.json().items.map((job: { id: string }) => job.id)).toEqual(
      expect.arrayContaining([first.id, second.id, copied.json().id])
    );

    const deleted = await app.inject({ method: "DELETE", url: `/api/jobs/${first.id}` });
    expect(deleted.body).toBe("");
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/jobs/${first.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/jobs/${second.id}` })).statusCode).toBe(200);
  });
});
