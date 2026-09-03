import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, makeTempDataDir } from "../helpers/server.js";

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("production static serving", () => {
  it("serves built assets and SPA history routes without masking API 404s", async () => {
    const staticRoot = await makeTempDataDir();
    await mkdir(join(staticRoot, "assets"), { recursive: true });
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><html><body><main>素材扩展台 production</main></body></html>");
    await writeFile(join(staticRoot, "assets", "app.js"), "globalThis.__appLoaded = true;");
    const app = await createTestApp({ staticRoot, assetService: false }); apps.push(app);

    for (const path of ["/", "/jobs/local-job", "/settings"]) {
      const response = await app.inject({ method: "GET", url: path, headers: { accept: "text/html" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("素材扩展台 production");
      expect(response.headers["content-type"]).toMatch(/^text\/html/);
    }
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("__appLoaded");
    const apiMissing = await app.inject({ method: "GET", url: "/api/not-a-real-route", headers: { accept: "text/html" } });
    expect(apiMissing.statusCode).toBe(404);
    expect(apiMissing.body).not.toContain("素材扩展台 production");
  });
});
