import { afterEach, describe, expect, it } from "vitest";
import { createSpeakerJob, createTestApp, waitForJob } from "../helpers/server.js";
import { makePng, publicOnlyResolver } from "../helpers/assets.js";
import { successfulFakeProvider } from "../helpers/providers.js";

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("dynamic cache safety settings", () => {
  it("applies tightened image limits to materialization without weakening the hard policy", async () => {
    const bytes = await makePng({ width: 256, height: 256 });
    const app = await createTestApp({
      providers: [successfulFakeProvider("fake", 1)],
      assetServiceOptions: {
        resolver: publicOnlyResolver,
        fetch: async () => new Response(bytes, { status: 200, headers: { "content-type": "image/png", "content-length": String(bytes.length) } })
      }
    });
    apps.push(app);
    const settings = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    const saved = await app.inject({ method: "PUT", url: "/api/settings", payload: {
      ...settings,
      cache: { ...settings.cache, minDimension: 512, supportedFormats: ["image/png"] }
    } });
    expect(saved.statusCode).toBe(200);

    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");
    let candidate: { pipelineState: string; pipelineError: string | null } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      candidate = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().items[0];
      if (candidate?.pipelineState === "invalid") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(candidate).toMatchObject({ pipelineState: "invalid", pipelineError: "IMAGE_TOO_SMALL" });
  });
});
