import { access, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileTypeFromBuffer } from "file-type";
import { createApp } from "../../src/server/app.js";
import { createSpeakerJob, createTestApp, waitForJob } from "../helpers/server.js";

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("deterministic fixture gate", () => {
  it.each([undefined, "development", "production"])("rejects ALLOW_TEST_FIXTURES in NODE_ENV=%s", async (nodeEnv) => {
    await expect(createApp({
      dataDir: ":memory:",
      env: { NODE_ENV: nodeEnv, ALLOW_TEST_FIXTURES: "1" },
      assetService: false
    })).rejects.toThrow("Test fixtures require NODE_ENV=test");
  });

  it("keeps the fake provider and fixture route absent when the gate is off", async () => {
    const app = await createTestApp({ env: { NODE_ENV: "test" }, assetService: false }); apps.push(app);
    const providers = await app.inject({ method: "GET", url: "/api/providers" });
    expect(providers.json().items.some((provider: { id: string }) => provider.id === "fake")).toBe(false);
    expect((await app.inject({ method: "GET", url: "/__test-fixtures__/speaker.png" })).statusCode).toBe(404);
  });

  it("uses a fake-only registry and exact local image fixture that still materializes through image validation", async () => {
    const app = await createTestApp({ env: { NODE_ENV: "test", ALLOW_TEST_FIXTURES: "1" } }); apps.push(app);
    const providers = await app.inject({ method: "GET", url: "/api/providers" });
    expect(providers.json().items).toEqual([expect.objectContaining({ id: "fake", enabled: true, credentialVariables: [] })]);

    const image = await app.inject({ method: "GET", url: "/__test-fixtures__/speaker.png" });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toMatch(/^image\/png/);
    expect(await fileTypeFromBuffer(image.rawPayload)).toMatchObject({ mime: "image/png" });
    expect((await app.inject({ method: "GET", url: "/__test-fixtures__/speaker.png?redirect=http://127.0.0.1/private" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/__test-fixtures__/other.png" })).statusCode).toBe(404);

    const job = await createSpeakerJob(app);
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    let candidate: { pipelineState: string; assetId: string | null } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      candidate = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().items[0];
      if (candidate?.pipelineState === "processed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(candidate).toMatchObject({ pipelineState: "processed", assetId: expect.any(String) });
  });

  it("keeps file caches out of the workspace when SQLite uses the :memory: sentinel", async () => {
    const accidentalPath = resolve(":memory:");
    let leaked = false;
    try {
      const app = await createApp({ dataDir: ":memory:", env: { NODE_ENV: "test", ALLOW_TEST_FIXTURES: "1" } });
      const job = await createSpeakerJob(app);
      await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
      await waitForJob(app, String(job.id), "reviewing");
      await app.close();
      leaked = await access(accidentalPath).then(() => true, () => false);
    } finally {
      await rm(accidentalPath, { recursive: true, force: true });
    }
    expect(leaked).toBe(false);
  });

  it("applies the same tightened byte ceiling to the exact fixture loader", async () => {
    const app = await createTestApp({ env: { NODE_ENV: "test", ALLOW_TEST_FIXTURES: "1" } }); apps.push(app);
    const current = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect((await app.inject({ method: "PUT", url: "/api/settings", payload: {
      ...current,
      cache: { ...current.cache, maxBytes: 1_024 }
    } })).statusCode).toBe(200);
    const job = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(job.id), "reviewing");
    let candidate: { pipelineState: string; pipelineError: string | null } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      candidate = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().items[0];
      if (candidate?.pipelineState === "invalid") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(candidate).toMatchObject({ pipelineState: "invalid", pipelineError: "DOWNLOAD_TOO_LARGE" });
  });
});
