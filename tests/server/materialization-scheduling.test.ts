import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type AppDatabase } from "../../src/server/database.js";
import { JobsRepository } from "../../src/server/repositories/jobs.js";
import { SearchRepository } from "../../src/server/repositories/search.js";
import { ReviewsRepository } from "../../src/server/repositories/reviews.js";
import { ProviderRegistry } from "../../src/server/providers/registry.js";
import { ArticProvider } from "../../src/server/providers/artic.js";
import { registerReviewRoutes } from "../../src/server/routes/reviews.js";
import { SearchService } from "../../src/server/services/search-service.js";
import type { AssetService } from "../../src/server/services/asset-service.js";

const databases: AppDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("scans past blocked ARTIC targets while preserving four global materialization slots", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "materialization-scheduling-test-")); directories.push(dataDir);
  const database = createDatabase(dataDir); databases.push(database);
  database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
  const candidates = [
    ["artic-1", "artic"],
    ["artic-2", "artic"],
    ["artic-3", "artic"],
    ["fake-1", "fake"],
    ["met-1", "met"],
    ["nasa-1", "nasa"]
  ] as const;
  const insert = database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at, pipeline_error) VALUES (?, 'job', ?, ?, ?, 'discovered', 'unknown', 'now', 'CACHE_REBUILD_REQUIRED')");
  for (const [candidateId, providerId] of candidates) {
    const url = `https://images.example.test/${candidateId}.png`;
    insert.run(candidateId, url, providerId, url);
  }
  const searches = new SearchRepository(database);
  expect(searches.materializationTargets(candidates.map(([candidateId]) => candidateId))).toEqual(
    candidates.map(([candidateId, providerId]) => ({ candidateId, providerId }))
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let activeArtic = 0;
  let maximumActiveArtic = 0;
  const assets = {
    async materializeCandidate(candidateId: string): Promise<void> {
      started.push(candidateId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (candidateId.startsWith("artic-")) {
        activeArtic += 1;
        maximumActiveArtic = Math.max(maximumActiveArtic, activeArtic);
      }
      await gate;
      active -= 1;
      if (candidateId.startsWith("artic-")) activeArtic -= 1;
    }
  } as unknown as AssetService;

  const service = new SearchService(
    new JobsRepository(database),
    searches,
    new ProviderRegistry([new ArticProvider()]),
    assets
  );

  expect(started).toEqual(["artic-1", "fake-1", "met-1", "nasa-1"]);
  expect(maximumActive).toBe(4);
  expect(maximumActiveArtic).toBe(1);

  release();
  await service.close();
  expect(started).toEqual(["artic-1", "fake-1", "met-1", "nasa-1", "artic-2", "artic-3"]);
});

it("maps more than SQLite's variable limit without losing input order or provider identity", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "materialization-target-chunks-test-")); directories.push(dataDir);
  const database = createDatabase(dataDir); databases.push(database);
  database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
  const candidateIds = Array.from({ length: 32_767 }, (_, index) => `missing-${index}`);
  candidateIds[0] = "first";
  candidateIds[16_383] = "middle";
  candidateIds[32_766] = "last";
  const insert = database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES (?, 'job', ?, ?, ?, 'discovered', 'unknown', 'now')");
  for (const [candidateId, providerId] of [["first", "artic"], ["middle", "fake"], ["last", "nasa"]] as const) {
    const url = `https://images.example.test/${candidateId}.png`;
    insert.run(candidateId, url, providerId, url);
  }

  const searches = new SearchRepository(database);

  expect(searches.materializationTargets(candidateIds)).toEqual([
    { candidateId: "first", providerId: "artic" },
    { candidateId: "middle", providerId: "fake" },
    { candidateId: "last", providerId: "nasa" }
  ]);
  expect(searches.materializationTargets([])).toEqual([]);
});

it("excludes rejected candidates from cache rebuild scheduling and the final claim boundary", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "materialization-rejected-test-")); directories.push(dataDir);
  const database = createDatabase(dataDir); databases.push(database);
  database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
  const insert = database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at, pipeline_error) VALUES (?, 'job', ?, 'fake', ?, 'discovered', 'unknown', 'now', 'CACHE_REBUILD_REQUIRED')");
  insert.run("active", "https://images.example.test/active.png", "https://images.example.test/active.png");
  insert.run("rejected", "https://images.example.test/rejected.png", "https://images.example.test/rejected.png");
  database.prepare("INSERT INTO candidate_review_state (candidate_id, job_id, review_state, updated_at) VALUES ('rejected', 'job', 'rejected', 'now')").run();
  const searches = new SearchRepository(database);

  expect(searches.listCandidatesRequiringCacheRebuild()).toEqual(["active"]);
  expect(searches.materializationTargets(["rejected", "active"])).toEqual([
    { candidateId: "active", providerId: "fake" }
  ]);
  expect(searches.claimCandidate("rejected")).toBeUndefined();
  expect(database.prepare("SELECT pipeline_state, pipeline_error FROM candidates WHERE id = 'rejected'").get()).toEqual({
    pipeline_state: "discovered",
    pipeline_error: "CACHE_REBUILD_REQUIRED"
  });
});

it("restores a rejected queued candidate even when the skipped worker has not finalized", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "materialization-restore-race-test-")); directories.push(dataDir);
  const database = createDatabase(dataDir); databases.push(database);
  database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
  const insert = database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at, pipeline_error) VALUES (?, 'job', ?, 'artic', ?, 'discovered', 'unknown', 'now', 'CACHE_REBUILD_REQUIRED')");
  insert.run("blocker", "https://images.example.test/blocker.png", "https://images.example.test/blocker.png");
  insert.run("target", "https://images.example.test/target.png", "https://images.example.test/target.png");
  const searches = new SearchRepository(database);

  let releaseBlocker!: () => void;
  const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  let skippedTarget!: () => void;
  const targetSkipped = new Promise<void>((resolve) => { skippedTarget = resolve; });
  let releaseSkippedTarget!: () => void;
  const skippedTargetGate = new Promise<void>((resolve) => { releaseSkippedTarget = resolve; });
  const assets = {
    async materializeCandidate(candidateId: string): Promise<void> {
      if (candidateId === "blocker") {
        await blockerGate;
        return;
      }
      const claimed = searches.claimCandidate(candidateId);
      if (!claimed) {
        skippedTarget();
        await skippedTargetGate;
        return;
      }
      database.prepare("UPDATE candidates SET pipeline_state = 'processed', pipeline_error = NULL WHERE id = ?").run(candidateId);
    }
  } as unknown as AssetService;
  const jobs = new JobsRepository(database);
  const reviews = new ReviewsRepository(database);
  const service = new SearchService(jobs, searches, new ProviderRegistry([new ArticProvider()]), assets);
  database.prepare("UPDATE candidates SET pipeline_error = NULL WHERE id = 'target'").run();
  const app = Fastify({ logger: false });
  registerReviewRoutes(app, jobs, reviews, service);

  const rejected = await app.inject({ method: "POST", url: "/api/jobs/job/reviews", payload: { candidateIds: ["target"], action: "reject" } });
  expect(rejected.statusCode).toBe(200);
  releaseBlocker();
  await targetSkipped;

  const restored = await app.inject({ method: "POST", url: "/api/jobs/job/reviews", payload: { candidateIds: ["target"], action: "restore" } });
  expect(restored.statusCode).toBe(200);
  expect(database.prepare("SELECT review_state FROM candidate_review_state WHERE candidate_id = 'target'").get()).toEqual({ review_state: "unreviewed" });
  expect(database.prepare("SELECT pipeline_state, pipeline_error FROM candidates WHERE id = 'target'").get()).toEqual({
    pipeline_state: "discovered",
    pipeline_error: "DOWNLOAD_INTERRUPTED"
  });

  releaseSkippedTarget();
  await service.close();
  expect(database.prepare("SELECT pipeline_state, pipeline_error FROM candidates WHERE id = 'target'").get()).toEqual({
    pipeline_state: "processed",
    pipeline_error: null
  });
  await app.close();
});
