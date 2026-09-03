import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import type { AppDatabase } from "../database.js";
import type { SearchRepository } from "../repositories/search.js";
import type { ProviderDownloadPolicy } from "../providers/types.js";
import { fetchImageWithPolicy, RemotePolicyError, systemResolver, type RemoteFetch, type RemoteResolver, type RemoteTransport } from "./safe-url.js";
import { defaultLocalSettings, type CacheSafetySettings, type ProviderId } from "../../shared/contracts.js";

const MAX_PIXELS = 100_000_000;
const BASE_DOWNLOAD_RATE_LIMIT_BACKOFF_MS = 5_000;
const MAX_DOWNLOAD_RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_DOWNLOAD_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export class ImageInspectionError extends Error {
  public constructor(public readonly code: "UNSUPPORTED_MEDIA" | "IMAGE_TOO_SMALL" | "IMAGE_TOO_LARGE") { super("Image cannot be used."); }
}

export interface InspectedImage {
  sourceSha256: string; normalizedSha256: string; pixelSha256: string; dHash: string; width: number; height: number; channels: 4;
  normalized: Buffer; thumbnail: Buffer; warnings: string[]; mimeType: "image/jpeg" | "image/png" | "image/webp";
}

export async function computeDHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).rotate().grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let value = "";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) value += data[y * 9 + x]! > data[y * 9 + x + 1]! ? "1" : "0";
  }
  return BigInt(`0b${value}`).toString(16).padStart(16, "0");
}

export async function inspectImage(buffer: Buffer, limits: CacheSafetySettings = defaultLocalSettings.cache): Promise<InspectedImage> {
  const detected = await fileTypeFromBuffer(buffer);
  const maxPixels = Math.min(MAX_PIXELS, limits.maxPixels);
  const minDimension = Math.max(128, limits.minDimension);
  const supportedFormats = new Set(limits.supportedFormats);
  if (!detected || !["image/jpeg", "image/png", "image/webp"].includes(detected.mime) || !supportedFormats.has(detected.mime as CacheSafetySettings["supportedFormats"][number])) throw new ImageInspectionError("UNSUPPORTED_MEDIA");
  try {
    const originalMetadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS, animated: true, failOn: "error" }).metadata();
    if (originalMetadata.pages && originalMetadata.pages > 1) throw new ImageInspectionError("UNSUPPORTED_MEDIA");
    const image = sharp(buffer, { limitInputPixels: maxPixels, animated: false, failOn: "error" }).rotate().toColorspace("srgb");
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > maxPixels) throw new ImageInspectionError("IMAGE_TOO_LARGE");
    if (metadata.pages && metadata.pages > 1) throw new ImageInspectionError("UNSUPPORTED_MEDIA");
    if (metadata.width < minDimension || metadata.height < minDimension) throw new ImageInspectionError("IMAGE_TOO_SMALL");
    const normalized = await image.clone().ensureAlpha().png().toBuffer();
    const raw = await sharp(normalized, { limitInputPixels: maxPixels }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = raw.info.width; const height = raw.info.height; const channels = 4 as const;
    const pixelSha256 = sha256(Buffer.concat([Buffer.from(`${width}:${height}:${channels}:`), raw.data]));
    return {
      sourceSha256: sha256(buffer), normalizedSha256: sha256(normalized), pixelSha256, dHash: await computeDHash(normalized), width, height, channels, normalized,
      thumbnail: await sharp(normalized, { limitInputPixels: MAX_PIXELS }).resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp().toBuffer(),
      warnings: width < 512 || height < 512 ? ["LOW_RESOLUTION"] : [], mimeType: detected.mime as InspectedImage["mimeType"]
    };
  } catch (error) {
    if (error instanceof ImageInspectionError) throw error;
    throw new ImageInspectionError("UNSUPPORTED_MEDIA");
  }
}

function hamming(first: string, second: string): number {
  let value = BigInt(`0x${first}`) ^ BigInt(`0x${second}`); let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try { await rename(temporary, path); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await stat(path);
    }
  } finally { await rm(temporary, { force: true }); }
}

export interface AssetServiceOptions {
  database: AppDatabase;
  searches: SearchRepository;
  dataDir: string;
  fetch?: RemoteFetch;
  transport?: RemoteTransport;
  resolver?: RemoteResolver;
  fixtureImageLoader?: (url: string) => Promise<Buffer | undefined>;
  limits?: CacheSafetySettings | (() => CacheSafetySettings);
  /** Test seam and the clock used to validate provider-issued signed URL expiries. */
  now?: () => number;
  /** Test seam for the monotonic provider request-start clock. */
  monotonicNow?: () => number;
  /** Test seam for provider pacing; production uses a real timer. */
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  downloadPolicy?: (providerId: ProviderId) => ProviderDownloadPolicy | undefined;
  /** Bounded attempts for transient transport/server failures. */
  downloadRetryAttempts?: number;
}

interface ProviderDownloadState {
  active: number;
  waiters: ProviderDownloadWaiter[];
  nextStartAt: number;
  rateLimitUntil: number;
  rateLimitStreak: number;
}

interface ProviderDownloadWaiter {
  grant: () => void;
}

export class AssetService {
  private readonly fetch?: RemoteFetch;
  private readonly transport?: RemoteTransport;
  private readonly resolver: RemoteResolver;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly downloadRetryAttempts: number;
  private readonly transientDownloadUrls = new Map<string, { url: string; expiresAt: number }>();
  private readonly providerDownloads = new Map<ProviderId, ProviderDownloadState>();
  public constructor(private readonly options: AssetServiceOptions) {
    this.fetch = options.fetch;
    this.transport = options.transport;
    this.resolver = options.resolver ?? systemResolver;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.sleep = options.sleep ?? ((delayMs, signal) => new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        cleanup();
        reject(signal.reason ?? new Error("Provider pacing was aborted."));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    }));
    this.downloadRetryAttempts = Math.min(5, Math.max(1, Math.floor(options.downloadRetryAttempts ?? 3)));
  }

  /** Keeps short-lived signed CDN query parameters in memory only, until their provider/local expiry. */
  public registerTransientDownloadUrl(publicUrl: string, transientUrl: string): void {
    try {
      const now = this.now();
      this.pruneTransientDownloadUrls(now);
      if (this.transientDownloadUrls.size >= 1_024) {
        const oldest = this.transientDownloadUrls.keys().next().value as string | undefined;
        if (oldest) this.transientDownloadUrls.delete(oldest);
      }
      const publicIdentity = new URL(publicUrl);
      const transientIdentity = new URL(transientUrl);
      if ((publicIdentity.protocol !== "http:" && publicIdentity.protocol !== "https:")
        || publicIdentity.protocol !== transientIdentity.protocol
        || publicIdentity.origin !== transientIdentity.origin
        || publicIdentity.pathname !== transientIdentity.pathname
        || publicIdentity.username || publicIdentity.password || transientIdentity.username || transientIdentity.password) return;
      let expiresAt = now + 5 * 60_000;
      for (const [name, value] of transientIdentity.searchParams) {
        if (name.toLowerCase() !== "x-expires") continue;
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) expiresAt = Math.min(expiresAt, numeric >= 1_000_000_000_000 ? numeric : numeric * 1_000);
      }
      if (expiresAt <= now) return;
      this.transientDownloadUrls.set(publicUrl, { url: transientUrl, expiresAt });
    } catch { /* Ignore malformed provider-only download hints. */ }
  }

  public async materializeCandidate(candidateId: string, signal?: AbortSignal): Promise<void> {
    const candidate = this.options.searches.claimCandidate(candidateId);
    if (!candidate) return;
    const limits = typeof this.options.limits === "function" ? this.options.limits() : this.options.limits ?? defaultLocalSettings.cache;
    let finalError: unknown;
    for (let attempt = 1; attempt <= this.downloadRetryAttempts; attempt += 1) {
      try {
        const downloadUrl = this.transientDownloadUrl(candidate.imageUrl);
        await this.materializeFromUrl(candidate, downloadUrl, limits, signal);
        return;
      } catch (error) {
        if (this.markTerminalFailure(candidate.id, error)) return;
        finalError = error;
        if (error instanceof RemotePolicyError && error.code === "DOWNLOAD_FAILED" && error.failureCode === "FORBIDDEN") break;
        if (attempt < this.downloadRetryAttempts) continue;
      }
    }
    if (candidate.thumbnailUrl && candidate.thumbnailUrl !== candidate.imageUrl) {
      try {
        await this.materializeFromUrl(candidate, candidate.thumbnailUrl, limits, signal);
        return;
      } catch (error) {
        if (this.markTerminalFailure(candidate.id, error)) return;
        finalError = error;
      }
    }
    const failureCode = finalError instanceof RemotePolicyError && finalError.code === "DOWNLOAD_FAILED" ? finalError.failureCode ?? "GENERIC" : "GENERIC";
    this.options.searches.markCandidateFailure(candidate.id, "discovered", "RETRYABLE_DOWNLOAD", failureCode);
  }

  public thumbnailPath(normalizedSha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(normalizedSha256)) throw new Error("Invalid asset hash.");
    return join(this.options.dataDir, "cache", "thumbnails", `${normalizedSha256}.webp`);
  }

  private transientDownloadUrl(publicUrl: string): string {
    const now = this.now();
    this.pruneTransientDownloadUrls(now);
    return this.transientDownloadUrls.get(publicUrl)?.url ?? publicUrl;
  }

  private pruneTransientDownloadUrls(now: number): void {
    for (const [key, entry] of this.transientDownloadUrls) {
      if (entry.expiresAt <= now) this.transientDownloadUrls.delete(key);
    }
  }

  private async materializeFromUrl(
    candidate: { id: string; jobId: string; providerId: ProviderId },
    url: string,
    limits: CacheSafetySettings,
    signal?: AbortSignal
  ): Promise<void> {
    const fixtureBytes = await this.options.fixtureImageLoader?.(url);
    if (fixtureBytes && fixtureBytes.length > Math.min(25_000_000, limits.maxBytes)) throw new RemotePolicyError("DOWNLOAD_TOO_LARGE");
    const fetchedBytes = fixtureBytes ?? await this.withProviderDownloadSlot(candidate.providerId, async (beforeRequest, userAgent) => (
      await fetchImageWithPolicy(url, {
        fetch: this.fetch, transport: this.transport, resolver: this.resolver,
        timeoutMs: limits.downloadTimeoutMs, maxBytes: limits.maxBytes, beforeRequest, userAgent, now: this.now, signal
      })
    ).bytes, signal);
    const inspected = await inspectImage(fetchedBytes, limits);
    const assetId = await this.persist(candidate.id, candidate.jobId, inspected);
    this.options.searches.markCandidateProcessed(candidate.id, assetId, inspected.warnings);
  }

  private markTerminalFailure(candidateId: string, error: unknown): boolean {
    if (error instanceof RemotePolicyError && (error.code === "UNSAFE_REMOTE_URL" || error.code === "UNSAFE_REDIRECT")) {
      this.options.searches.markCandidateFailure(candidateId, "quarantined", error.code);
      return true;
    }
    if (error instanceof ImageInspectionError || (error instanceof RemotePolicyError && error.code === "DOWNLOAD_TOO_LARGE")) {
      this.options.searches.markCandidateFailure(candidateId, "invalid", error instanceof Error && "code" in error ? String(error.code) : "INVALID_MEDIA");
      return true;
    }
    return false;
  }

  private async withProviderDownloadSlot<Value>(providerId: ProviderId, operation: (beforeRequest?: (signal: AbortSignal) => Promise<void>, userAgent?: string) => Promise<Value>, signal?: AbortSignal): Promise<Value> {
    const policy = this.options.downloadPolicy?.(providerId);
    const maximum = Math.max(1, Math.floor(policy?.maxConcurrency ?? 4));
    const minimumIntervalMs = Math.max(0, Math.floor(policy?.minimumIntervalMs ?? 0));
    const state = this.providerDownloadState(providerId);
    await this.acquireProviderDownloadSlot(state, maximum, signal);
    try {
      const value = await operation(
        (signal) => this.waitForProviderRequestStart(state, minimumIntervalMs, signal),
        policy?.userAgent
      );
      state.rateLimitStreak = 0;
      if (state.rateLimitUntil <= this.monotonicNow()) state.rateLimitUntil = 0;
      return value;
    } catch (error) {
      this.recordProviderRateLimit(state, error);
      throw error;
    } finally {
      state.active -= 1;
      const next = state.waiters.shift();
      if (next) {
        state.active += 1;
        next.grant();
      }
    }
  }

  private async acquireProviderDownloadSlot(state: ProviderDownloadState, maximum: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error("Provider download was aborted.");
    if (state.active < maximum && state.waiters.length === 0) {
      state.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const waiter: ProviderDownloadWaiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }
      };
      const onAbort = () => {
        if (settled) return;
        const index = state.waiters.indexOf(waiter);
        if (index < 0) return;
        state.waiters.splice(index, 1);
        settled = true;
        cleanup();
        reject(signal?.reason ?? new Error("Provider download was aborted."));
      };
      state.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private providerDownloadState(providerId: ProviderId): ProviderDownloadState {
    const existing = this.providerDownloads.get(providerId);
    if (existing) return existing;
    const created = { active: 0, waiters: [], nextStartAt: 0, rateLimitUntil: 0, rateLimitStreak: 0 };
    this.providerDownloads.set(providerId, created);
    return created;
  }

  private async waitForProviderRequestStart(state: ProviderDownloadState, minimumIntervalMs: number, signal: AbortSignal): Promise<void> {
    while (true) {
      const now = this.monotonicNow();
      const startAt = Math.max(now, state.nextStartAt, state.rateLimitUntil);
      const previousNextStartAt = state.nextStartAt;
      const reservedNextStartAt = startAt + minimumIntervalMs;
      state.nextStartAt = reservedNextStartAt;
      if (startAt > now) {
        try {
          await this.sleep(startAt - now, signal);
        } catch (error) {
          if (state.nextStartAt === reservedNextStartAt) state.nextStartAt = previousNextStartAt;
          throw error;
        }
      }
      if (state.rateLimitUntil <= this.monotonicNow()) return;
    }
  }

  private recordProviderRateLimit(state: ProviderDownloadState, error: unknown): void {
    if (!(error instanceof RemotePolicyError) || error.code !== "DOWNLOAD_FAILED" || error.failureCode !== "RATE_LIMITED") return;
    state.rateLimitStreak = Math.min(31, state.rateLimitStreak + 1);
    const exponentialBackoff = Math.min(
      MAX_DOWNLOAD_RATE_LIMIT_BACKOFF_MS,
      BASE_DOWNLOAD_RATE_LIMIT_BACKOFF_MS * (2 ** (state.rateLimitStreak - 1))
    );
    const retryAfterMs = error.retryAfterMs !== null && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
      ? Math.min(MAX_DOWNLOAD_RATE_LIMIT_COOLDOWN_MS, Math.ceil(error.retryAfterMs))
      : exponentialBackoff;
    state.rateLimitUntil = Math.max(state.rateLimitUntil, this.monotonicNow() + retryAfterMs);
  }

  private async persist(candidateId: string, jobId: string, inspected: InspectedImage): Promise<string> {
    const normalizedPath = join(this.options.dataDir, "cache", "assets", inspected.normalizedSha256.slice(0, 2), inspected.normalizedSha256);
    await atomicWrite(normalizedPath, inspected.normalized);
    await atomicWrite(this.thumbnailPath(inspected.normalizedSha256), inspected.thumbnail);
    this.options.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.options.database.prepare("SELECT id FROM assets WHERE normalized_sha256 = ? OR source_sha256 = ? OR pixel_sha256 = ? LIMIT 1").get(inspected.normalizedSha256, inspected.sourceSha256, inspected.pixelSha256) as { id: string } | undefined;
      const assetId = existing?.id ?? `asset_${inspected.normalizedSha256}`;
      if (!existing) {
        this.options.database.prepare("INSERT INTO assets (id, source_sha256, normalized_sha256, pixel_sha256, dhash, width, height, channels, mime_type, thumbnail_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(assetId, inspected.sourceSha256, inspected.normalizedSha256, inspected.pixelSha256, inspected.dHash, inspected.width, inspected.height, inspected.channels, inspected.mimeType, sha256(inspected.thumbnail), new Date().toISOString());
      }
      this.options.database.prepare("INSERT OR IGNORE INTO candidate_assets (candidate_id, asset_id, created_at) VALUES (?, ?, ?)").run(candidateId, assetId, new Date().toISOString());
      const nearby = this.options.database.prepare(`SELECT DISTINCT c.id AS candidate_id, c.near_duplicate_group AS group_id, a.dhash FROM candidate_assets ca JOIN candidates c ON c.id = ca.candidate_id JOIN assets a ON a.id = ca.asset_id WHERE c.job_id = ? AND c.id != ? AND a.id != ?`).all(jobId, candidateId, assetId) as Array<{ candidate_id: string; group_id: string | null; dhash: string }>;
      const match = nearby.find((item) => hamming(item.dhash, inspected.dHash) <= 8);
      if (match) {
        const group = match.group_id ?? `near_${assetId}`;
        this.options.database.prepare("UPDATE candidates SET near_duplicate_group = ? WHERE id IN (?, ?)").run(group, candidateId, match.candidate_id);
      }
      this.options.database.exec("COMMIT;");
      return assetId;
    } catch (error) { this.options.database.exec("ROLLBACK;"); throw error; }
  }
}
