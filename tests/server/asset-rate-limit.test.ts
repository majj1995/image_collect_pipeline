import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetService } from "../../src/server/services/asset-service.js";
import { createDatabase, type AppDatabase } from "../../src/server/database.js";
import { SearchRepository } from "../../src/server/repositories/search.js";
import { defaultLocalSettings, type ProviderId } from "../../src/shared/contracts.js";
import { makePng, publicOnlyResolver } from "../helpers/assets.js";

const databases: AppDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("asset provider rate-limit recovery", () => {
  it("removes an aborted concurrency waiter immediately without leaking the provider slot", async () => {
    const { dataDir, database, searches } = await makeFixture();
    insertCandidate(database, "first", "wikimedia", "https://upload.wikimedia.example/first.png");
    insertCandidate(database, "aborted", "wikimedia", "https://upload.wikimedia.example/aborted.png");
    insertCandidate(database, "next", "wikimedia", "https://upload.wikimedia.example/next.png");
    const bytes = await makePng({ width: 800, height: 800 });
    let releaseFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve; });
    const starts: string[] = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadRetryAttempts: 1,
      downloadPolicy: wikimediaPolicy,
      fetch: async (input) => {
        const url = String(input);
        starts.push(url);
        if (url.endsWith("/first.png")) {
          notifyFirstStarted();
          return firstResponse;
        }
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }
    });

    const first = service.materializeCandidate("first");
    await firstStarted;
    const controller = new AbortController();
    const aborted = service.materializeCandidate("aborted", controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new Error("cancelled while waiting for provider slot"));
    const settledBeforeRelease = await Promise.race([
      aborted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))
    ]);

    releaseFirst(new Response(bytes, { headers: { "content-type": "image/png" } }));
    await Promise.all([first, aborted]);
    await service.materializeCandidate("next");

    expect(settledBeforeRelease).toBe(true);
    expect(starts).toEqual([
      "https://upload.wikimedia.example/first.png",
      "https://upload.wikimedia.example/next.png"
    ]);
    expect(database.prepare("SELECT id, pipeline_state, pipeline_error FROM candidates ORDER BY id").all()).toEqual([
      { id: "aborted", pipeline_state: "discovered", pipeline_error: "RETRYABLE_DOWNLOAD" },
      { id: "first", pipeline_state: "processed", pipeline_error: null },
      { id: "next", pipeline_state: "processed", pipeline_error: null }
    ]);
  });

  it("cancels an externally aborted pacing sleep and rolls back its unconsumed reservation", async () => {
    const { dataDir, database, searches } = await makeFixture();
    insertCandidate(database, "first", "wikimedia", "https://upload.wikimedia.example/first.png");
    insertCandidate(database, "aborted", "wikimedia", "https://upload.wikimedia.example/aborted.png");
    insertCandidate(database, "next", "wikimedia", "https://upload.wikimedia.example/next.png");
    const bytes = await makePng({ width: 800, height: 800 });
    let clock = 0;
    let cancelledSleeps = 0;
    let blockNextSleep = true;
    let notifySleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => { notifySleepStarted = resolve; });
    const sleepDelays: number[] = [];
    const starts: Array<{ url: string; at: number }> = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadRetryAttempts: 1,
      downloadPolicy: (providerId) => providerId === "wikimedia"
        ? { maxConcurrency: 1, minimumIntervalMs: 1_000 }
        : undefined,
      monotonicNow: () => clock,
      sleep: async (delayMs: number, signal: AbortSignal) => {
        sleepDelays.push(delayMs);
        if (!blockNextSleep) { clock += delayMs; return; }
        blockNextSleep = false;
        notifySleepStarted();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            cancelledSleeps += 1;
            reject(signal.reason ?? new Error("aborted"));
          };
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
      fetch: async (input) => {
        starts.push({ url: String(input), at: clock });
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }
    });

    await service.materializeCandidate("first");
    const controller = new AbortController();
    const aborted = service.materializeCandidate("aborted", controller.signal);
    await sleepStarted;
    controller.abort();
    await aborted;
    await service.materializeCandidate("next");

    expect(cancelledSleeps).toBe(1);
    expect(sleepDelays).toEqual([1_000, 1_000]);
    expect(starts).toEqual([
      { url: "https://upload.wikimedia.example/first.png", at: 0 },
      { url: "https://upload.wikimedia.example/next.png", at: 1_000 }
    ]);
  });

  it("rolls back an unconsumed reservation when the pacing scheduler rejects", async () => {
    const { dataDir, database, searches } = await makeFixture();
    insertCandidate(database, "first", "wikimedia", "https://upload.wikimedia.example/first.png");
    insertCandidate(database, "failed-wait", "wikimedia", "https://upload.wikimedia.example/failed-wait.png");
    insertCandidate(database, "next", "wikimedia", "https://upload.wikimedia.example/next.png");
    const bytes = await makePng({ width: 800, height: 800 });
    let clock = 0;
    let rejectNextSleep = true;
    const sleepDelays: number[] = [];
    const starts: Array<{ url: string; at: number }> = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadRetryAttempts: 1,
      downloadPolicy: (providerId) => providerId === "wikimedia"
        ? { maxConcurrency: 1, minimumIntervalMs: 1_000 }
        : undefined,
      monotonicNow: () => clock,
      sleep: async (delayMs) => {
        sleepDelays.push(delayMs);
        if (rejectNextSleep) { rejectNextSleep = false; throw new Error("scheduler unavailable"); }
        clock += delayMs;
      },
      fetch: async (input) => {
        starts.push({ url: String(input), at: clock });
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }
    });

    await service.materializeCandidate("first");
    await service.materializeCandidate("failed-wait");
    await service.materializeCandidate("next");

    expect(sleepDelays).toEqual([1_000, 1_000]);
    expect(starts).toEqual([
      { url: "https://upload.wikimedia.example/first.png", at: 0 },
      { url: "https://upload.wikimedia.example/next.png", at: 1_000 }
    ]);
  });

  it("shares Retry-After cooldown across candidates while leaving another provider unaffected", async () => {
    const { dataDir, database, searches } = await makeFixture();
    insertCandidate(database, "limited", "wikimedia", "https://upload.wikimedia.example/limited.png");
    insertCandidate(database, "next", "wikimedia", "https://upload.wikimedia.example/next.png");
    insertCandidate(database, "other", "fake", "https://other.example/image.png");
    const bytes = await makePng({ width: 800, height: 800 });
    let clock = 0;
    let limitedAttempts = 0;
    const sleeps: number[] = [];
    const starts: Array<{ url: string; at: number }> = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadRetryAttempts: 1,
      downloadPolicy: wikimediaPolicy,
      monotonicNow: () => clock,
      sleep: async (delayMs) => { sleeps.push(delayMs); clock += delayMs; },
      fetch: async (input) => {
        const url = String(input);
        starts.push({ url, at: clock });
        if (url.includes("limited") && limitedAttempts++ === 0) {
          return new Response("slow down", { status: 429, headers: { "retry-after": "7" } });
        }
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }
    });

    await service.materializeCandidate("limited");
    await service.materializeCandidate("other");
    await service.materializeCandidate("next");
    await service.materializeCandidate("limited");

    expect(sleeps).toEqual([7_000]);
    expect(starts).toEqual([
      { url: "https://upload.wikimedia.example/limited.png", at: 0 },
      { url: "https://other.example/image.png", at: 0 },
      { url: "https://upload.wikimedia.example/next.png", at: 7_000 },
      { url: "https://upload.wikimedia.example/limited.png", at: 7_000 }
    ]);
    expect(database.prepare("SELECT id, pipeline_state FROM candidates ORDER BY id").all()).toEqual([
      { id: "limited", pipeline_state: "processed" },
      { id: "next", pipeline_state: "processed" },
      { id: "other", pipeline_state: "processed" }
    ]);
  });

  it("uses capped exponential backoff for headerless 429s before trying the thumbnail", async () => {
    const { dataDir, database, searches } = await makeFixture();
    const primaryUrl = "https://upload.wikimedia.example/original.png";
    const thumbnailUrl = "https://upload.wikimedia.example/thumbnail.png";
    const candidateId = seedCandidateHit(searches, primaryUrl, thumbnailUrl);
    const bytes = await makePng({ width: 800, height: 800 });
    let clock = 0;
    const sleeps: number[] = [];
    const starts: Array<{ url: string; at: number }> = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadRetryAttempts: 5,
      downloadPolicy: wikimediaPolicy,
      monotonicNow: () => clock,
      sleep: async (delayMs) => { sleeps.push(delayMs); clock += delayMs; },
      fetch: async (input) => {
        const url = String(input);
        starts.push({ url, at: clock });
        return url === thumbnailUrl
          ? new Response(bytes, { headers: { "content-type": "image/png" } })
          : new Response("slow down", { status: 429 });
      }
    });

    await service.materializeCandidate(candidateId);

    expect(sleeps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
    expect(starts).toEqual([
      { url: primaryUrl, at: 0 },
      { url: primaryUrl, at: 5_000 },
      { url: primaryUrl, at: 15_000 },
      { url: primaryUrl, at: 35_000 },
      { url: primaryUrl, at: 75_000 },
      { url: thumbnailUrl, at: 135_000 }
    ]);
    expect(database.prepare("SELECT pipeline_state, pipeline_error, pipeline_failure_code FROM candidates WHERE id = ?").get(candidateId)).toEqual({
      pipeline_state: "processed", pipeline_error: null, pipeline_failure_code: null
    });
  });

  it("resets the headerless rate-limit streak after a successful retry", async () => {
    const { dataDir, database, searches } = await makeFixture();
    insertCandidate(database, "one", "wikimedia", "https://upload.wikimedia.example/one.png");
    insertCandidate(database, "two", "wikimedia", "https://upload.wikimedia.example/two.png");
    const bytes = await makePng({ width: 800, height: 800 });
    let clock = 0;
    const attempts = new Map<string, number>();
    const sleeps: number[] = [];
    const starts: number[] = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadRetryAttempts: 2,
      downloadPolicy: wikimediaPolicy,
      monotonicNow: () => clock,
      sleep: async (delayMs) => { sleeps.push(delayMs); clock += delayMs; },
      fetch: async (input) => {
        const url = String(input);
        starts.push(clock);
        const attempt = (attempts.get(url) ?? 0) + 1;
        attempts.set(url, attempt);
        return attempt === 1
          ? new Response("slow down", { status: 429 })
          : new Response(bytes, { headers: { "content-type": "image/png" } });
      }
    });

    await service.materializeCandidate("one");
    await service.materializeCandidate("two");

    expect(sleeps).toEqual([5_000, 5_000]);
    expect(starts).toEqual([0, 5_000, 5_000, 10_000]);
    expect(database.prepare("SELECT pipeline_state FROM candidates ORDER BY id").all()).toEqual([
      { pipeline_state: "processed" }, { pipeline_state: "processed" }
    ]);
  });

  it("waits through a long provider cooldown outside the network timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T04:00:00.000Z"));
    const origin = Date.now();
    const { dataDir, database, searches } = await makeFixture();
    insertCandidate(database, "limited", "wikimedia", "https://upload.wikimedia.example/limited.png");
    insertCandidate(database, "next", "wikimedia", "https://upload.wikimedia.example/next.png");
    const bytes = await makePng({ width: 800, height: 800 });
    const starts: number[] = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadRetryAttempts: 1,
      downloadPolicy: wikimediaPolicy,
      now: Date.now,
      monotonicNow: Date.now,
      limits: { ...defaultLocalSettings.cache, downloadTimeoutMs: 100 },
      fetch: async (input) => {
        starts.push(Date.now() - origin);
        return String(input).includes("limited")
          ? new Response("slow down", { status: 429, headers: { "retry-after": "60" } })
          : new Response(bytes, { headers: { "content-type": "image/png" } });
      }
    });

    await service.materializeCandidate("limited");
    const next = service.materializeCandidate("next");
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(59_900);
    await next;

    expect(starts).toEqual([0, 60_000]);
    expect(database.prepare("SELECT pipeline_state FROM candidates WHERE id = 'next'").get()).toEqual({ pipeline_state: "processed" });
  });
});

async function makeFixture(): Promise<{ dataDir: string; database: AppDatabase; searches: SearchRepository }> {
  const dataDir = await mkdtemp(join(tmpdir(), "asset-rate-limit-test-"));
  directories.push(dataDir);
  const database = createDatabase(dataDir);
  databases.push(database);
  database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
  database.prepare("INSERT INTO taxonomy_nodes VALUES ('job', 'label', NULL, 'Speaker', '[\"Speaker\"]')").run();
  database.prepare("INSERT INTO label_targets (job_id, label_id, product, config_json) VALUES ('job', 'label', 'Speaker', '{}')").run();
  return { dataDir, database, searches: new SearchRepository(database) };
}

function insertCandidate(database: AppDatabase, id: string, providerId: ProviderId, imageUrl: string): void {
  database.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES (?, 'job', ?, ?, ?, 'discovered', 'unknown', 'now')")
    .run(id, imageUrl, providerId, imageUrl);
}

function seedCandidateHit(searches: SearchRepository, imageUrl: string, thumbnailUrl: string): string {
  const run = searches.createRuns("job", [{ labelId: "label", providerId: "wikimedia", variantName: "base", query: "speaker" }])[0]!;
  return searches.saveHits(run, [{
    provider: "wikimedia",
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
    sourceProvider: "Wikimedia Commons",
    source: "fixture",
    rightsStatus: "unknown"
  }], 1)[0]!;
}

function wikimediaPolicy(providerId: ProviderId) {
  return providerId === "wikimedia"
    ? { maxConcurrency: 1, minimumIntervalMs: 0, userAgent: "ConfiguredWikimediaBot/1.0 (local test)" }
    : undefined;
}
