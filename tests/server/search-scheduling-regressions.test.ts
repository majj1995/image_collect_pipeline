import { afterEach, describe, expect, it } from "vitest";
import { ProviderError, type ImageSearchProvider, type NormalizedHit, type ProviderSearchRequest } from "../../src/server/providers/types.js";
import type { AppDatabase } from "../../src/server/database.js";
import { createSpeakerJob, createTestApp, type CreateTestAppOptions, waitForJob } from "../helpers/server.js";

const apps: Array<Awaited<ReturnType<typeof createTestApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("search scheduling regressions", () => {
  it("does not schedule page two when every completed page-one query returned zero hits", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "empty paginated provider",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      supportsPagination: true,
      canRequestPage: () => true,
      async search(request) {
        requests.push(request);
        return [];
      }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createSpeakerJob(app);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    const pageOneRequestCount = requests.length;
    expect(pageOneRequestCount).toBeGreaterThan(0);

    const exhausted = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    });
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toEqual({ status: "exhausted" });
    await waitForJob(app, String(job.id), "reviewing");

    const runs = (await app.inject({
      method: "GET",
      url: `/api/jobs/${job.id}/candidates`
    })).json().providerRuns as Array<{ status: string; page: number; hitCount: number; requestCount: number }>;
    expect(requests).toHaveLength(pageOneRequestCount);
    expect(new Set(runs.map((run) => run.page))).toEqual(new Set([1]));
    expect(runs.every((run) => run.status === "completed" && run.hitCount === 0 && run.hitCount < run.requestCount)).toBe(true);
  });

  it("does not create page two when the provider rejects that page for a non-empty query", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "bounded non-empty pager",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      supportsPagination: true,
      canRequestPage: (page) => page === 1,
      async search(request) {
        requests.push(request);
        return [{
          provider: "fake",
          rank: 1,
          thumbnailUrl: null,
          imageUrl: `https://images.example.test/ceiling-${encodeURIComponent(request.query)}.jpg`,
          landingPageUrl: null,
          title: null,
          creator: null,
          licenseName: null,
          licenseUrl: null,
          width: 800,
          height: 800,
          sourceProvider: "fake",
          source: "fake",
          rightsStatus: "unknown"
        } satisfies NormalizedHit];
      }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createSpeakerJob(app);

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");
    const requestCount = requests.length;

    const exhausted = await app.inject({
      method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake"] }
    });
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toEqual({ status: "exhausted" });
    const runs = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` })).json().providerRuns as Array<{ page: number }>;
    expect(requests).toHaveLength(requestCount);
    expect(new Set(runs.map((run) => run.page))).toEqual(new Set([1]));
  });

  it("does not replay a stale failed later page after its preceding page was empty while unrelated discovery proceeds", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "stale page fixture", configured: true, maxResults: 100, rightsPolicy: "open",
      supportsPagination: true, canRequestPage: () => true,
      async search(request) { requests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false });
    apps.push(app);
    const job = await createSpeakerJob(app);
    const jobId = String(job.id);
    const labelId = String((job.labels as Array<{ id: string }>)[0]!.id);
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, request_count, status, retryable, created_at, completed_at)
      VALUES ('page-one', ?, ?, 'fake', 'exact_ad', 'speaker advertisement', 1, 5, 'completed', 0, 'now', 'now'),
             ('page-two-old-failure', ?, ?, 'fake', 'exact_ad', 'speaker advertisement', 2, 5, 'failed', 0, 'now', 'now')
    `).run(jobId, labelId, jobId, labelId);

    expect((await app.inject({
      method: "POST", url: `/api/jobs/${jobId}/search`,
      payload: { providerIds: ["fake"], retryFailedProviderIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, jobId, "reviewing");

    expect(requests).not.toHaveLength(0);
    expect(requests.every((request) => request.page === 1 && request.query !== "speaker advertisement")).toBe(true);
    expect(database.prepare("SELECT status FROM query_runs WHERE id = 'page-two-old-failure'").get())
      .toEqual({ status: "completed" });
  });

  it("paces consecutive search starts using the provider minimum interval", async () => {
    let clock = 0;
    const starts: number[] = [];
    const provider: ImageSearchProvider & { readonly searchPolicy: { readonly minimumIntervalMs: number } } = {
      id: "fake",
      displayName: "paced provider",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      searchPolicy: { minimumIntervalMs: 1_000 },
      async search() {
        starts.push(clock);
        return [];
      }
    };
    const options: CreateTestAppOptions & {
      searchTiming: {
        monotonicNow: () => number;
        sleep: (delayMs: number) => Promise<void>;
      };
    } = {
      providers: [provider],
      assetService: false,
      searchTiming: {
        monotonicNow: () => clock,
        sleep: async (delayMs) => { clock += delayMs; }
      }
    };
    const app = await createTestApp(options);
    apps.push(app);
    const job = await createSpeakerJob(app);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");

    expect(starts.length).toBeGreaterThan(1);
    expect(starts.slice(1).map((start, index) => start - starts[index]!))
      .toEqual(Array.from({ length: starts.length - 1 }, () => 1_000));
  });

  it("waits for a 429 Retry-After window when it exceeds exponential backoff", async () => {
    let clock = 0;
    const attempts = new Map<string, number>();
    const sleepDelays: number[] = [];
    const provider: ImageSearchProvider = {
      id: "fake",
      displayName: "retry-after provider",
      configured: true,
      maxResults: 100,
      rightsPolicy: "open",
      async search(request) {
        const attempt = (attempts.get(request.query) ?? 0) + 1;
        attempts.set(request.query, attempt);
        if (attempt === 1) {
          throw Object.assign(new ProviderError("fake", 429, true), { retryAfterMs: 5_000 });
        }
        return [];
      }
    };
    const app = await createTestApp({
      providers: [provider],
      assetService: false,
      searchRetry: {
        maxAttempts: 2,
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        random: () => 0.5,
        sleep: async (delayMs) => { sleepDelays.push(delayMs); clock += delayMs; }
      },
      searchTiming: {
        monotonicNow: () => clock,
        sleep: async (delayMs) => { clock += delayMs; }
      }
    });
    apps.push(app);
    const job = await createSpeakerJob(app);

    expect((await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/search`,
      payload: { providerIds: ["fake"] }
    })).statusCode).toBe(202);
    await waitForJob(app, String(job.id), "reviewing");

    expect(sleepDelays).not.toHaveLength(0);
    expect(new Set(sleepDelays)).toEqual(new Set([5_000]));
  });

  it("does not truncate a Retry-After window that exceeds the normal backoff cap", async () => {
    let attempts = 0;
    const sleepDelays: number[] = [];
    const { executeWithProviderRetry } = await import("../../src/server/services/retry-policy.js");

    await executeWithProviderRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new ProviderError("fake", 429, true, 120_000);
      return "ok";
    }, {
      maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 60_000, random: () => 0.5,
      sleep: async (delayMs) => { sleepDelays.push(delayMs); }
    });

    expect(sleepDelays).toEqual([120_000]);
  });

  it("applies one provider Retry-After cooldown across concurrently queued jobs", async () => {
    let clock = 0;
    const starts: number[] = [];
    const pacingSleeps: number[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStartedSignal = new Promise<void>((resolve) => { firstStarted = resolve; });
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "shared cooldown provider", configured: true, maxResults: 100, rightsPolicy: "open",
      async search() {
        starts.push(clock);
        if (starts.length === 1) {
          firstStarted();
          await firstGate;
          throw new ProviderError("fake", 429, true, 120_000);
        }
        return [];
      }
    };
    const app = await createTestApp({
      providers: [provider], assetService: false, searchRetry: { maxAttempts: 1 },
      searchTiming: {
        monotonicNow: () => clock,
        sleep: async (delayMs) => { pacingSleeps.push(delayMs); clock += delayMs; }
      }
    });
    apps.push(app);
    const firstJob = await createSpeakerJob(app);
    const secondJob = await createSpeakerJob(app);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${firstJob.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await firstStartedSignal;
    expect((await app.inject({ method: "POST", url: `/api/jobs/${secondJob.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    releaseFirst();
    await Promise.all([
      waitForJob(app, String(firstJob.id), "reviewing"),
      waitForJob(app, String(secondJob.id), "reviewing")
    ]);

    expect(starts.slice(0, 2)).toEqual([0, 120_000]);
    expect(pacingSleeps).toContain(120_000);
  });

  it.each([
    ["above the configured safe bound", 120_000],
    ["not a finite timer value", Number.POSITIVE_INFINITY]
  ])("fast-fails queued jobs when Retry-After is %s", async (_case, retryAfterMs) => {
    let clock = 0;
    const starts: number[] = [];
    const pacingSleeps: number[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStartedSignal = new Promise<void>((resolve) => { firstStarted = resolve; });
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "unsafe cooldown provider", configured: true, maxResults: 100, rightsPolicy: "open",
      async search() {
        starts.push(clock);
        if (starts.length === 1) {
          firstStarted();
          await firstGate;
          throw new ProviderError("fake", 429, true, retryAfterMs);
        }
        return [];
      }
    };
    const app = await createTestApp({
      providers: [provider], assetService: false,
      searchRetry: { maxAttempts: 1, maxRetryAfterMs: 60_000 },
      searchTiming: {
        monotonicNow: () => clock,
        sleep: async (delayMs) => { pacingSleeps.push(delayMs); clock += delayMs; }
      }
    });
    apps.push(app);
    const firstJob = await createSpeakerJob(app);
    const secondJob = await createSpeakerJob(app);

    expect((await app.inject({ method: "POST", url: `/api/jobs/${firstJob.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    await firstStartedSignal;
    expect((await app.inject({ method: "POST", url: `/api/jobs/${secondJob.id}/search`, payload: { providerIds: ["fake"] } })).statusCode).toBe(202);
    releaseFirst();
    await Promise.all([
      waitForJob(app, String(firstJob.id), "reviewing"),
      waitForJob(app, String(secondJob.id), "reviewing")
    ]);

    expect(starts).toEqual([0]);
    expect(pacingSleeps).toEqual([]);
    for (const job of [firstJob, secondJob]) {
      const response = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` });
      const runs = response.json().providerRuns as Array<{ status: string }>;
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((run) => run.status === "retryable")).toBe(true);
    }
  });
});
