import { afterEach, describe, expect, it } from "vitest";
import { inspectImage, AssetService } from "../../src/server/services/asset-service.js";
import { createDatabase, type AppDatabase } from "../../src/server/database.js";
import { SearchRepository } from "../../src/server/repositories/search.js";
import { makePng, publicOnlyResolver } from "../helpers/assets.js";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createSpeakerJob, createTestApp, waitForJob } from "../helpers/server.js";
import { successfulFakeProvider } from "../helpers/providers.js";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../../src/server/app.js";
import type { ProviderId } from "../../src/shared/contracts.js";
import { WikimediaProvider } from "../../src/server/providers/wikimedia.js";

const databases: AppDatabase[] = [];
const directories: string[] = [];
afterEach(async () => { databases.splice(0).forEach((database) => database.close()); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("image inspection", () => {
  it("rejects HTML disguised as JPEG and groups equal pixels", async () => {
    await expect(inspectImage(Buffer.from("<html>not an image</html>"))).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
    const first = await makePng({ width: 800, height: 800, color: "#2559d6", metadata: false });
    const second = await makePng({ width: 800, height: 800, color: "#2559d6", metadata: true });
    const a = await inspectImage(first);
    const b = await inspectImage(second);
    expect(a.pixelSha256).toBe(b.pixelSha256);
    expect(a.dHash).toBe(b.dHash);
  });

  it("blocks too-small images and warns for low resolution", async () => {
    await expect(inspectImage(await makePng({ width: 127, height: 800 }))).rejects.toMatchObject({ code: "IMAGE_TOO_SMALL" });
    await expect(inspectImage(await makePng({ width: 500, height: 800 }))).resolves.toMatchObject({ warnings: ["LOW_RESOLUTION"] });
  });

  it("rejects SVG bytes even if an image caller claims JPEG", async () => {
    await expect(inspectImage(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"800\" height=\"800\"/></svg>"))).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  });

  it("uses one canonical RGBA pixel hash for opaque RGB and RGBA images", async () => {
    const rgb = await inspectImage(await makePng({ width: 800, height: 800, color: "#2559d6", channels: 3 }));
    const rgba = await inspectImage(await makePng({ width: 800, height: 800, color: "#2559d6", channels: 4 }));
    expect(rgb.pixelSha256).toBe(rgba.pixelSha256);
  });
});

describe("asset persistence", () => {
  it("falls back to the persisted provider thumbnail after retryable primary failures", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-thumbnail-fallback-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    const primaryUrl = "https://images.example.test/artic-primary.png";
    const thumbnailUrl = "https://images.example.test/artic-thumbnail.png";
    const candidateId = seedCandidateHit(database, searches, "artic", primaryUrl, thumbnailUrl);
    const requested: string[] = [];
    const thumbnail = await makePng({ width: 800, height: 800 });
    const service = new AssetService({
      database, searches, dataDir, resolver: publicOnlyResolver, downloadRetryAttempts: 2,
      fetch: async (input) => {
        requested.push(String(input));
        return String(input) === thumbnailUrl
          ? new Response(thumbnail, { headers: { "content-type": "image/png" } })
          : new Response("temporary", { status: 503 });
      }
    });

    await service.materializeCandidate(candidateId);

    expect(requested).toEqual([primaryUrl, primaryUrl, thumbnailUrl]);
    expect(database.prepare("SELECT pipeline_state, pipeline_error, pipeline_failure_code FROM candidates WHERE id = ?").get(candidateId)).toEqual({
      pipeline_state: "processed", pipeline_error: null, pipeline_failure_code: null
    });
  });

  it("quarantines an unsafe primary URL without fetching its safe thumbnail", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-thumbnail-security-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    const candidateId = seedCandidateHit(database, searches, "artic", "http://127.0.0.1/private.png", "https://images.example.test/safe-thumbnail.png");
    let fetches = 0;
    const service = new AssetService({
      database, searches, dataDir, resolver: publicOnlyResolver,
      fetch: async () => { fetches += 1; return new Response(await makePng({ width: 800, height: 800 })); }
    });

    await service.materializeCandidate(candidateId);

    expect(fetches).toBe(0);
    expect(database.prepare("SELECT pipeline_state, pipeline_error FROM candidates WHERE id = ?").get(candidateId)).toEqual({
      pipeline_state: "quarantined", pipeline_error: "UNSAFE_REMOTE_URL"
    });
  });

  it("serializes and paces every ARTIC remote attempt with a fake clock", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-artic-pacing-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('one', 'job', 'https://images.example.test/one.png', 'artic', 'https://images.example.test/one.png', 'discovered', 'unknown', 'now'), ('two', 'job', 'https://images.example.test/two.png', 'artic', 'https://images.example.test/two.png', 'discovered', 'unknown', 'now')").run();
    const bytes = await makePng({ width: 800, height: 800 });
    let clock = 0;
    let activeFetches = 0;
    let maximumFetches = 0;
    const starts: number[] = [];
    const attempts = new Map<string, number>();
    const pending: Array<{ url: string; attempt: number; resolve: (response: Response) => void }> = [];
    const service = new AssetService({
      database, searches, dataDir, resolver: publicOnlyResolver, downloadRetryAttempts: 2,
      downloadPolicy: (providerId) => providerId === "artic" ? { maxConcurrency: 1, minimumIntervalMs: 1000 } : undefined,
      monotonicNow: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
      fetch: async (input) => {
        const url = String(input);
        const attempt = (attempts.get(url) ?? 0) + 1;
        attempts.set(url, attempt);
        activeFetches += 1;
        maximumFetches = Math.max(maximumFetches, activeFetches);
        starts.push(clock);
        return new Promise<Response>((resolve) => {
          pending.push({ url, attempt, resolve: (response) => { activeFetches -= 1; resolve(response); } });
        });
      }
    });

    const materializing = Promise.all([service.materializeCandidate("one"), service.materializeCandidate("two")]);
    for (let attemptIndex = 0; attemptIndex < 4; attemptIndex += 1) {
      const current = await nextPendingFetch(pending);
      current.resolve(current.attempt === 1
        ? new Response("temporary", { status: 503 })
        : new Response(bytes, { headers: { "content-type": "image/png" } }));
    }
    await materializing;

    expect(maximumFetches).toBe(1);
    expect(starts).toEqual([0, 1000, 2000, 3000]);
    expect(database.prepare("SELECT pipeline_state FROM candidates ORDER BY id").all()).toEqual([
      { pipeline_state: "processed" }, { pipeline_state: "processed" }
    ]);
  });

  it("paces actual ARTIC transport starts after slow DNS and across redirect hops without delaying another provider", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-artic-transport-pacing-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('artic', 'job', 'https://artic.example/original.png', 'artic', 'https://artic.example/original.png', 'discovered', 'unknown', 'now'), ('other', 'job', 'https://other.example/image.png', 'fake', 'https://other.example/image.png', 'discovered', 'unknown', 'now')").run();
    const bytes = await makePng({ width: 800, height: 800 });
    let clock = 0;
    const starts: Array<{ provider: "artic" | "other"; at: number; url: string }> = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      downloadPolicy: (providerId) => providerId === "artic" ? { maxConcurrency: 1, minimumIntervalMs: 1000 } : undefined,
      monotonicNow: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
      resolver: async (hostname) => {
        if (hostname === "artic.example" || hostname === "artic-cdn.example") clock += 600;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      transport: async ({ url }) => {
        const provider = url.hostname.startsWith("artic") ? "artic" : "other";
        starts.push({ provider, at: clock, url: url.toString() });
        if (url.hostname === "artic.example") return new Response(null, { status: 302, headers: { location: "https://artic-cdn.example/final.png" } });
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }
    });

    await Promise.all([service.materializeCandidate("artic"), service.materializeCandidate("other")]);

    const articStarts = starts.filter((start) => start.provider === "artic");
    expect(articStarts).toEqual([
      { provider: "artic", at: 600, url: "https://artic.example/original.png" },
      { provider: "artic", at: 1600, url: "https://artic-cdn.example/final.png" }
    ]);
    expect(starts.find((start) => start.provider === "other")?.at).toBe(600);
    expect(database.prepare("SELECT pipeline_state FROM candidates ORDER BY id").all()).toEqual([
      { pipeline_state: "processed" }, { pipeline_state: "processed" }
    ]);
  });

  it("identifies, serializes, and paces Wikimedia media downloads without delaying another provider", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-wikimedia-pacing-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('wiki-one', 'job', 'https://upload.wikimedia.example/one.png', 'wikimedia', 'https://upload.wikimedia.example/one.png', 'discovered', 'unknown', 'now'), ('wiki-two', 'job', 'https://upload.wikimedia.example/two.png', 'wikimedia', 'https://upload.wikimedia.example/two.png', 'discovered', 'unknown', 'now'), ('other', 'job', 'https://other.example/image.png', 'fake', 'https://other.example/image.png', 'discovered', 'unknown', 'now')").run();
    const bytes = await makePng({ width: 800, height: 800 });
    const wikimediaUserAgent = "TrainingDataCollector/2.0 (maintainer@example.test)";
    const wikimedia = new WikimediaProvider({ userAgent: wikimediaUserAgent });
    let clock = 0;
    let activeWikimediaFetches = 0;
    let maximumWikimediaFetches = 0;
    const starts: Array<{ provider: "wikimedia" | "other"; at: number; userAgent: string | null }> = [];
    const pending: Array<{ url: string; attempt: number; resolve: (response: Response) => void }> = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadPolicy: (providerId) => providerId === "wikimedia" ? wikimedia.downloadPolicy : undefined,
      monotonicNow: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
      fetch: async (input, init) => {
        const provider = String(input).includes("wikimedia") ? "wikimedia" : "other";
        starts.push({ provider, at: clock, userAgent: new Headers(init?.headers).get("user-agent") });
        if (provider === "other") return new Response(bytes, { headers: { "content-type": "image/png" } });
        activeWikimediaFetches += 1;
        maximumWikimediaFetches = Math.max(maximumWikimediaFetches, activeWikimediaFetches);
        return new Promise<Response>((resolve) => {
          pending.push({ url: String(input), attempt: 1, resolve: (response) => { activeWikimediaFetches -= 1; resolve(response); } });
        });
      }
    });

    const materializing = Promise.all([
      service.materializeCandidate("wiki-one"),
      service.materializeCandidate("wiki-two"),
      service.materializeCandidate("other")
    ]);
    for (let index = 0; index < 2; index += 1) {
      const current = await nextPendingFetch(pending);
      current.resolve(new Response(bytes, { headers: { "content-type": "image/png" } }));
    }
    await materializing;

    expect(maximumWikimediaFetches).toBe(1);
    expect(starts.filter((start) => start.provider === "wikimedia")).toEqual([
      { provider: "wikimedia", at: 0, userAgent: wikimediaUserAgent },
      { provider: "wikimedia", at: 1000, userAgent: wikimediaUserAgent }
    ]);
    expect(starts.find((start) => start.provider === "other")).toEqual({ provider: "other", at: 0, userAgent: null });
    expect(database.prepare("SELECT pipeline_state FROM candidates ORDER BY id").all()).toEqual([
      { pipeline_state: "processed" }, { pipeline_state: "processed" }, { pipeline_state: "processed" }
    ]);
  });

  it.each([
    ["rejected", async () => { throw new Error("resolver internal detail must stay private"); }],
    ["empty", async () => []]
  ] as const)("persists %s DNS resolution as retryable NETWORK without exposing resolver details", async (_case, resolver) => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-dns-failure-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('candidate', 'job', 'https://unresolved.example/image.png', 'fake', 'https://unresolved.example/image.png', 'discovered', 'unknown', 'now')").run();
    const service = new AssetService({ database, searches, dataDir, resolver, downloadRetryAttempts: 1 });

    await service.materializeCandidate("candidate");

    expect(database.prepare("SELECT pipeline_state, pipeline_error, pipeline_failure_code FROM candidates WHERE id = 'candidate'").get()).toEqual({
      pipeline_state: "discovered", pipeline_error: "RETRYABLE_DOWNLOAD", pipeline_failure_code: "NETWORK"
    });
    const serialized = JSON.stringify(searches.listCandidates("job").items[0]);
    expect(serialized).not.toContain("resolver internal detail");
  });

  it("uses the safe thumbnail fallback after primary DNS resolution fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-dns-thumbnail-fallback-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    const primaryUrl = "https://unresolved.example/original.png";
    const thumbnailUrl = "https://thumbnail.example/fallback.png";
    const candidateId = seedCandidateHit(database, searches, "fake", primaryUrl, thumbnailUrl);
    const resolverCalls: string[] = [];
    const fetches: string[] = [];
    const bytes = await makePng({ width: 800, height: 800 });
    const service = new AssetService({
      database, searches, dataDir, downloadRetryAttempts: 2,
      resolver: async (hostname) => {
        resolverCalls.push(hostname);
        if (hostname === "unresolved.example") throw new Error("resolver internal detail must stay private");
        return [{ address: "93.184.216.34", family: 4 }];
      },
      fetch: async (input) => { fetches.push(String(input)); return new Response(bytes, { headers: { "content-type": "image/png" } }); }
    });

    await service.materializeCandidate(candidateId);

    expect(resolverCalls).toEqual(["unresolved.example", "unresolved.example", "thumbnail.example"]);
    expect(fetches).toEqual([thumbnailUrl]);
    expect(database.prepare("SELECT pipeline_state, pipeline_error, pipeline_failure_code FROM candidates WHERE id = ?").get(candidateId)).toEqual({
      pipeline_state: "processed", pipeline_error: null, pipeline_failure_code: null
    });
  });

  it("persists a safe retryable failure code and clears it after a successful claim", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-download-failure-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('candidate', 'job', 'https://public.example/image.png', 'fake', 'https://public.example/image.png', 'discovered', 'unknown', 'now')").run();
    const failing = new AssetService({
      database, searches, dataDir, resolver: publicOnlyResolver, downloadRetryAttempts: 1,
      fetch: async () => new Response("untrusted upstream response body", { status: 503 })
    });

    await failing.materializeCandidate("candidate");

    expect(database.prepare("SELECT pipeline_state, pipeline_error, pipeline_failure_code FROM candidates WHERE id = 'candidate'").get()).toEqual({
      pipeline_state: "discovered", pipeline_error: "RETRYABLE_DOWNLOAD", pipeline_failure_code: "NETWORK"
    });
    const failedCandidate = searches.listCandidates("job").items[0]!;
    expect(failedCandidate).toMatchObject({ pipelineError: "RETRYABLE_DOWNLOAD", pipelineFailureCode: "NETWORK" });
    expect(JSON.stringify(failedCandidate)).not.toContain("untrusted upstream response body");

    const succeeding = new AssetService({
      database, searches, dataDir, resolver: publicOnlyResolver,
      fetch: async () => new Response(await makePng({ width: 800, height: 800 }))
    });
    await succeeding.materializeCandidate("candidate");

    expect(database.prepare("SELECT pipeline_state, pipeline_error, pipeline_failure_code FROM candidates WHERE id = 'candidate'").get()).toEqual({
      pipeline_state: "processed", pipeline_error: null, pipeline_failure_code: null
    });
  });

  it("removes legacy raw-cache asset links instead of inventing a normalized hash", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-migration-test-")); directories.push(dataDir);
    const source = await makePng({ width: 800, height: 800, metadata: true });
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const legacyPath = join(dataDir, "cache", "assets", sourceHash.slice(0, 2), sourceHash);
    const legacyThumbnail = join(dataDir, "cache", "thumbnails", `${sourceHash}.webp`);
    await mkdir(join(dataDir, "cache", "assets", sourceHash.slice(0, 2)), { recursive: true });
    await mkdir(join(dataDir, "cache", "thumbnails"), { recursive: true });
    await writeFile(legacyPath, source); await writeFile(legacyThumbnail, source);
    const old = new DatabaseSync(join(dataDir, "pipeline.sqlite"));
    old.exec(`CREATE TABLE candidates (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, normalized_image_url TEXT NOT NULL, provider_id TEXT NOT NULL, image_url TEXT NOT NULL, landing_page_url TEXT, title TEXT, pipeline_state TEXT NOT NULL, rights_status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE assets (id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL UNIQUE, pixel_sha256 TEXT NOT NULL UNIQUE, dhash TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, channels INTEGER NOT NULL, mime_type TEXT NOT NULL, thumbnail_sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE candidate_assets (candidate_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
    old.prepare("INSERT INTO candidates VALUES ('candidate', 'job', 'https://public.example/a', 'fake', 'https://public.example/a', NULL, NULL, 'processed', 'unknown', 'now')").run();
    old.prepare("INSERT INTO assets VALUES ('asset', ?, 'pixel', '0000000000000000', 800, 800, 3, 'image/png', 'thumb', 'now')").run(sourceHash);
    old.prepare("INSERT INTO candidate_assets VALUES ('candidate', 'asset', 'now')").run();
    old.close();
    const database = createDatabase(dataDir); databases.push(database);
    expect(database.prepare("SELECT * FROM assets").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM candidate_assets").all()).toEqual([]);
    expect(database.prepare("SELECT pipeline_state, pipeline_error FROM candidates").all()).toEqual([{ pipeline_state: "discovered", pipeline_error: "CACHE_REBUILD_REQUIRED" }]);
    await expect(access(legacyPath)).rejects.toThrow();
    await expect(access(legacyThumbnail)).rejects.toThrow();
    const searches = new SearchRepository(database);
    const service = new AssetService({ database, searches, dataDir, resolver: publicOnlyResolver, fetch: async () => new Response(source) });
    await service.materializeCandidate("candidate");
    const asset = database.prepare("SELECT source_sha256, normalized_sha256 FROM assets").get() as { source_sha256: string; normalized_sha256: string };
    expect(asset.source_sha256).toBe(sourceHash);
    expect(asset.normalized_sha256).not.toBe(sourceHash);
  });

  it("upgrades falsely backfilled 91d cache rows and bootstraps safe rematerialization", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-upgrade-test-")); directories.push(dataDir);
    const source = await makePng({ width: 800, height: 800, metadata: true });
    const hash = createHash("sha256").update(source).digest("hex");
    const oldPath = join(dataDir, "cache", "assets", hash.slice(0, 2), hash);
    const oldThumbnail = join(dataDir, "cache", "thumbnails", `${hash}.webp`);
    await mkdir(join(dataDir, "cache", "assets", hash.slice(0, 2)), { recursive: true }); await mkdir(join(dataDir, "cache", "thumbnails"), { recursive: true });
    await writeFile(oldPath, source); await writeFile(oldThumbnail, source);
    const old = new DatabaseSync(join(dataDir, "pipeline.sqlite"));
    old.exec(`CREATE TABLE candidates (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, normalized_image_url TEXT NOT NULL, provider_id TEXT NOT NULL, image_url TEXT NOT NULL, landing_page_url TEXT, title TEXT, pipeline_state TEXT NOT NULL, rights_status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE assets (id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL UNIQUE, normalized_sha256 TEXT NOT NULL UNIQUE, pixel_sha256 TEXT NOT NULL UNIQUE, dhash TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, channels INTEGER NOT NULL, mime_type TEXT NOT NULL, thumbnail_sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE candidate_assets (candidate_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE search_hits (id TEXT PRIMARY KEY); CREATE TABLE candidate_hits (candidate_id TEXT, hit_id TEXT, query_run_id TEXT); CREATE TABLE candidate_labels (candidate_id TEXT, job_id TEXT, label_id TEXT);`);
    old.prepare("INSERT INTO candidates VALUES ('candidate', 'job', 'https://public.example/a', 'fake', 'https://public.example/a', NULL, NULL, 'processed', 'unknown', 'now')").run();
    old.prepare("INSERT INTO assets VALUES ('asset', ?, ?, 'pixel', '0000000000000000', 800, 800, 3, 'image/png', 'thumb', 'now')").run(hash, hash);
    old.prepare("INSERT INTO candidate_assets VALUES ('candidate', 'asset', 'now')").run();
    old.prepare("INSERT INTO search_hits VALUES ('hit')").run(); old.prepare("INSERT INTO candidate_hits VALUES ('candidate', 'hit', 'run')").run(); old.prepare("INSERT INTO candidate_labels VALUES ('candidate', 'job', 'label')").run();
    old.close();
    const app = await createApp({ dataDir, env: {}, assetServiceOptions: { resolver: publicOnlyResolver, fetch: async () => new Response(source) } });
    await app.close();
    const database = new DatabaseSync(join(dataDir, "pipeline.sqlite"));
    try {
      expect(database.prepare("SELECT id FROM schema_migrations WHERE id = 'normalized_cache_v2'").all()).toHaveLength(1);
      expect(database.prepare("SELECT * FROM cache_cleanup_queue").all()).toEqual([]);
      expect(database.prepare("SELECT pipeline_state FROM candidates").all()).toEqual([{ pipeline_state: "processed" }]);
      expect(database.prepare("SELECT * FROM candidate_hits").all()).toEqual([{ candidate_id: "candidate", hit_id: "hit", query_run_id: "run" }]);
      expect(database.prepare("SELECT * FROM candidate_labels").all()).toEqual([{ candidate_id: "candidate", job_id: "job", label_id: "label" }]);
      expect(database.prepare("SELECT source_sha256, normalized_sha256 FROM assets").get()).toMatchObject({ source_sha256: hash, normalized_sha256: expect.not.stringMatching(new RegExp(`^${hash}$`)) });
      await expect(access(oldPath)).rejects.toThrow(); await expect(access(oldThumbnail)).rejects.toThrow();
    } finally { database.close(); }
  });

  it("retries a durable cache cleanup queue on the next database open", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-cleanup-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const hash = "a".repeat(64);
    const path = join(dataDir, "cache", "assets", hash.slice(0, 2), hash);
    await mkdir(join(dataDir, "cache", "assets", hash.slice(0, 2)), { recursive: true }); await writeFile(path, "legacy");
    database.prepare("INSERT INTO cache_cleanup_queue (source_sha256) VALUES (?)").run(hash);
    database.close(); databases.pop();
    const reopened = createDatabase(dataDir); databases.push(reopened);
    expect(reopened.prepare("SELECT * FROM cache_cleanup_queue").all()).toEqual([]);
    await expect(access(path)).rejects.toThrow();
  });

  it("stores hash-addressed files and merges pixel-identical candidates while retaining links", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-service-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    const service = new AssetService({ database, searches, dataDir, resolver: publicOnlyResolver, fetch: async () => new Response(await makePng({ width: 800, height: 800 })) });
    database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('one', 'job', 'https://one.example/a', 'fake', 'https://one.example/a', 'discovered', 'unknown', 'now'), ('two', 'job', 'https://two.example/a', 'fake', 'https://two.example/a', 'discovered', 'unknown', 'now')").run();
    await service.materializeCandidate("one");
    await service.materializeCandidate("two");
    const assets = database.prepare("SELECT id, normalized_sha256 FROM assets").all() as Array<{ id: string; normalized_sha256: string }>;
    expect(assets).toHaveLength(1);
    expect(database.prepare("SELECT candidate_id FROM candidate_assets ORDER BY candidate_id").all()).toEqual([{ candidate_id: "one" }, { candidate_id: "two" }]);
    const stored = await readFile(join(dataDir, "cache", "assets", assets[0]!.normalized_sha256.slice(0, 2), assets[0]!.normalized_sha256));
    expect(stored.length).toBeGreaterThan(0);
  });

  it("groups near duplicates without merging their assets", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-service-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('one', 'job', 'https://one.example/a', 'fake', 'https://one.example/a', 'discovered', 'unknown', 'now'), ('two', 'job', 'https://two.example/a', 'fake', 'https://two.example/a', 'discovered', 'unknown', 'now')").run();
    const service = new AssetService({ database, searches, dataDir, resolver: publicOnlyResolver, fetch: async (input) => new Response(await makePng({ width: 800, height: 800, color: String(input).includes("one") ? "#2559d6" : "#2559d7" })) });
    await service.materializeCandidate("one"); await service.materializeCandidate("two");
    expect(database.prepare("SELECT id FROM assets").all()).toHaveLength(2);
    expect(database.prepare("SELECT near_duplicate_group FROM candidates ORDER BY id").all()).toEqual([{ near_duplicate_group: expect.any(String) }, { near_duplicate_group: expect.any(String) }]);
  });

  it("links parallel same-pixel candidates to one processed normalized asset", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-service-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('one', 'job', 'https://one.example/a', 'fake', 'https://one.example/a', 'discovered', 'unknown', 'now'), ('two', 'job', 'https://two.example/a', 'fake', 'https://two.example/a', 'discovered', 'unknown', 'now')").run();
    const rgb = await makePng({ width: 800, height: 800, channels: 3 });
    const rgba = await makePng({ width: 800, height: 800, channels: 4 });
    const service = new AssetService({ database, searches, dataDir, resolver: publicOnlyResolver, fetch: async (input) => new Response(String(input).includes("one") ? rgb : rgba) });
    await Promise.all([service.materializeCandidate("one"), service.materializeCandidate("two")]);
    expect(database.prepare("SELECT id FROM assets").all()).toHaveLength(1);
    expect(database.prepare("SELECT candidate_id FROM candidate_assets ORDER BY candidate_id").all()).toEqual([{ candidate_id: "one" }, { candidate_id: "two" }]);
    expect(database.prepare("SELECT pipeline_state FROM candidates ORDER BY id").all()).toEqual([{ pipeline_state: "processed" }, { pipeline_state: "processed" }]);
  });

  it("stores normalized bytes by their own hash while retaining original-source provenance", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "asset-service-test-")); directories.push(dataDir);
    const database = createDatabase(dataDir); databases.push(database);
    const searches = new SearchRepository(database);
    database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
    database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('one', 'job', 'https://one.example/a', 'fake', 'https://one.example/a', 'discovered', 'unknown', 'now')").run();
    const source = await makePng({ width: 800, height: 800, metadata: true });
    const service = new AssetService({ database, searches, dataDir, resolver: publicOnlyResolver, fetch: async () => new Response(source) });
    await service.materializeCandidate("one");
    const asset = database.prepare("SELECT source_sha256, normalized_sha256 FROM assets").get() as { source_sha256: string; normalized_sha256: string };
    const stored = await readFile(join(dataDir, "cache", "assets", asset.normalized_sha256.slice(0, 2), asset.normalized_sha256));
    expect(createHash("sha256").update(stored).digest("hex")).toBe(asset.normalized_sha256);
    expect(asset.source_sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect((await sharp(stored).metadata()).comments).toBeUndefined();
  });

  it("serves thumbnails by asset ID without exposing a local path", async () => {
    const app = await createTestApp({ providers: [successfulFakeProvider("fake", 1)], assetServiceOptions: { resolver: publicOnlyResolver, fetch: async () => new Response(await makePng({ width: 800, height: 800 })) } });
    try {
      const job = await createSpeakerJob(app);
      await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] } });
      await waitForJob(app, String(job.id), "reviewing");
      let candidate: { assetId?: string; pipelineState: string } | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        candidate = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().items[0];
        if (candidate?.pipelineState === "processed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(candidate).toMatchObject({ pipelineState: "processed", assetId: expect.any(String) });
      const thumbnail = await app.inject({ method: "GET", url: `/api/media/${candidate!.assetId}/thumbnail` });
      expect(thumbnail.statusCode).toBe(200);
      expect(thumbnail.headers["content-type"]).toContain("image/webp");
      expect(thumbnail.body).not.toContain("cache/");
      expect((await app.inject({ method: "GET", url: "/api/media/not-an-asset/thumbnail" })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

function seedCandidateHit(
  database: AppDatabase,
  searches: SearchRepository,
  providerId: ProviderId,
  imageUrl: string,
  thumbnailUrl: string
): string {
  database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
  database.prepare("INSERT INTO taxonomy_nodes VALUES ('job', 'label', NULL, 'Speaker', '[\"Speaker\"]')").run();
  database.prepare("INSERT INTO label_targets (job_id, label_id, product, config_json) VALUES ('job', 'label', 'Speaker', '{}')").run();
  const run = searches.createRuns("job", [{ labelId: "label", providerId, variantName: "base", query: "speaker" }])[0]!;
  const candidateId = searches.saveHits(run, [{
    provider: providerId,
    rank: 1,
    thumbnailUrl,
    imageUrl,
    landingPageUrl: null,
    title: "Speaker",
    creator: null,
    licenseName: null,
    licenseUrl: null,
    width: 800,
    height: 800,
    sourceProvider: providerId,
    source: "fixture",
    rightsStatus: "unknown"
  }], 1)[0]!;
  return candidateId;
}

async function nextPendingFetch(
  pending: Array<{ url: string; attempt: number; resolve: (response: Response) => void }>
): Promise<{ url: string; attempt: number; resolve: (response: Response) => void }> {
  for (let turn = 0; turn < 100; turn += 1) {
    const current = pending.shift();
    if (current) return current;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  throw new Error("Expected a paced remote fetch to start.");
}
