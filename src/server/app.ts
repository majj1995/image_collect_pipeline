import Fastify, { type FastifyInstance } from "fastify";
import { createDatabase, recoverInterruptedWork } from "./database.js";
import { JobsRepository } from "./repositories/jobs.js";
import { registerJobRoutes } from "./routes/jobs.js";
import type { ImageSearchProvider } from "./providers/types.js";
import { createDefaultProviderRegistry, ProviderRegistry } from "./providers/registry.js";
import { loadConfig } from "./config.js";
import { SearchRepository } from "./repositories/search.js";
import { SearchService } from "./services/search-service.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { AssetService, type AssetServiceOptions } from "./services/asset-service.js";
import { ReviewsRepository } from "./repositories/reviews.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { ExportsRepository } from "./repositories/exports.js";
import { ExportService } from "./services/export-service.js";
import { registerExportRoutes } from "./routes/exports.js";
import { SettingsRepository } from "./repositories/settings.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { RetryPolicyOptions } from "./services/retry-policy.js";
import type { SearchTimingOptions } from "./services/search-service.js";
import sharp from "sharp";
import { createFakeProvider } from "./providers/fake.js";
import fastifyStatic from "@fastify/static";

export interface CreateAppOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  providers?: ImageSearchProvider[];
  providerFetch?: typeof globalThis.fetch;
  assetService?: AssetService | false;
  assetServiceOptions?: Pick<AssetServiceOptions, "fetch" | "transport" | "resolver" | "now" | "monotonicNow" | "sleep">;
  contractualStorageRights?: boolean;
  contractualRightsDeclarations?: Record<string, boolean>;
  onExportGenerationStart?: () => void;
  testBeforeExportTransaction?: () => void;
  closeExternalResources?: () => Promise<void>;
  searchRetry?: Partial<RetryPolicyOptions>;
  searchTiming?: Partial<SearchTimingOptions>;
  staticRoot?: string;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const fixtureMode = testFixtureMode(options.env);
  if (fixtureMode && options.providers) throw new Error("Test fixture mode owns the provider registry.");
  const app = Fastify({ logger: false });
  const ownedRuntimeDataDir = options.dataDir === ":memory:" ? await mkdtemp(join(tmpdir(), "data-expansion-memory-")) : undefined;
  const runtimeDataDir = ownedRuntimeDataDir ?? options.dataDir;
  const database = createDatabase(options.dataDir);
  const recovery = recoverInterruptedWork(database);
  await removeInterruptedExportTemps(runtimeDataDir, recovery.interruptedExportIds);
  const jobs = new JobsRepository(database);
  const searches = new SearchRepository(database);
  const reviews = new ReviewsRepository(database);
  const settings = new SettingsRepository(database);
  const fixtureBytes = fixtureMode ? await makeFixtureImage() : undefined;
  const defaultProviderConfig = !options.providers && !fixtureMode ? loadConfig(options.env) : undefined;
  const providers = options.providers
    ? new ProviderRegistry(options.providers)
    : fixtureMode
      ? new ProviderRegistry([createFakeProvider("fake", [{
          provider: "fake", rank: 1, thumbnailUrl: TEST_FIXTURE_IMAGE_URL, imageUrl: TEST_FIXTURE_IMAGE_URL,
          landingPageUrl: null, title: "音箱电商广告素材", creator: null, licenseName: null, licenseUrl: null,
          width: 640, height: 480, sourceProvider: "local-test-fixture", source: "deterministic", rightsStatus: "unknown"
        }])])
      : createDefaultProviderRegistry(defaultProviderConfig!.credentials, options.providerFetch, defaultProviderConfig!.wikimediaUserAgent);
  const declarations = options.contractualRightsDeclarations ?? (options.contractualStorageRights ? { brave: true } : {});
  settings.mergeContractualDeclarations(declarations);
  const exports = new ExportService(database, new ExportsRepository(database), runtimeDataDir, providers, () => settings.get().contractualRightsDeclarations, { onGenerationStart: options.onExportGenerationStart, testBeforeCreateTransaction: options.testBeforeExportTransaction });
  const assetService = options.assetService === false ? undefined : options.assetService ?? new AssetService({
    database, searches, dataDir: runtimeDataDir,
    fetch: options.assetServiceOptions?.fetch,
    transport: options.assetServiceOptions?.transport,
    resolver: options.assetServiceOptions?.resolver,
    now: options.assetServiceOptions?.now,
    monotonicNow: options.assetServiceOptions?.monotonicNow,
    sleep: options.assetServiceOptions?.sleep,
    downloadPolicy: (providerId) => providers.downloadPolicy(providerId),
    fixtureImageLoader: fixtureMode
      ? async (url) => url === TEST_FIXTURE_IMAGE_URL ? Buffer.from(fixtureBytes!) : undefined
      : undefined,
    limits: () => settings.get().cache
  });
  const searchService = new SearchService(jobs, searches, providers, assetService, options.searchRetry, () => settings.get(), options.searchTiming);
  app.decorate("database", database);

  app.get("/api/health", async () => ({ ok: true, service: "素材扩展台" }));
  if (fixtureMode) {
    app.get(TEST_FIXTURE_IMAGE_PATH, async (request, reply) => {
      if (request.raw.url !== TEST_FIXTURE_IMAGE_PATH) return reply.code(404).send({ error: "Fixture not found." });
      return reply.header("content-type", "image/png").header("cache-control", "no-store").send(Buffer.from(fixtureBytes!));
    });
  }
  registerProviderRoutes(app, providers);
  registerSettingsRoutes(app, settings);
  registerJobRoutes(app, jobs, searches, searchService);
  registerReviewRoutes(app, jobs, reviews, searchService);
  registerExportRoutes(app, jobs, exports);
  app.get<{ Params: { assetId: string } }>("/api/media/:assetId/thumbnail", async (request, reply) => {
    if (!assetService) return reply.code(404).send({ error: "Thumbnail not found." });
    const asset = searches.getThumbnail(request.params.assetId);
    if (!asset) return reply.code(404).send({ error: "Thumbnail not found." });
    try {
      const { readFile } = await import("node:fs/promises");
      const bytes = await readFile(assetService.thumbnailPath(asset.normalizedSha256));
      return reply.header("content-type", "image/webp").header("cache-control", "private, max-age=86400").send(bytes);
    } catch { return reply.code(404).send({ error: "Thumbnail not found." }); }
  });
  app.addHook("onClose", async () => {
    await searchService.close();
    await exports.close();
    await options.closeExternalResources?.();
    database.close();
    if (ownedRuntimeDataDir) await rm(ownedRuntimeDataDir, { recursive: true, force: true });
  });

  if (options.staticRoot) {
    await app.register(fastifyStatic, { root: resolve(options.staticRoot), prefix: "/" });
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = request.url.split("?", 1)[0] ?? request.url;
      const acceptsHtml = request.headers.accept?.split(",").some((value) => value.trim().startsWith("text/html")) ?? false;
      if (request.method === "GET" && pathname !== "/api" && !pathname.startsWith("/api/") && acceptsHtml) {
        return reply.type("text/html; charset=utf-8").sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found." });
    });
  }

  return app;
}

const TEST_FIXTURE_IMAGE_PATH = "/__test-fixtures__/speaker.png";
const TEST_FIXTURE_IMAGE_URL = `http://127.0.0.1:8787${TEST_FIXTURE_IMAGE_PATH}`;

function testFixtureMode(env: NodeJS.ProcessEnv): boolean {
  const flag = env.ALLOW_TEST_FIXTURES?.trim();
  if (!flag || flag === "0") return false;
  if (flag !== "1") throw new Error("ALLOW_TEST_FIXTURES must be 0 or 1.");
  if (env.NODE_ENV !== "test") throw new Error("Test fixtures require NODE_ENV=test.");
  return true;
}

async function makeFixtureImage(): Promise<Buffer> {
  const overlay = Buffer.from(`<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
    <rect width="640" height="480" fill="#f6f8fc"/>
    <rect x="44" y="44" width="552" height="392" rx="24" fill="#ffffff" stroke="#d9e1ef" stroke-width="4"/>
    <circle cx="250" cy="250" r="112" fill="#172033"/>
    <circle cx="250" cy="250" r="74" fill="#316bff"/>
    <circle cx="250" cy="250" r="28" fill="#dbe7ff"/>
    <rect x="394" y="148" width="142" height="24" rx="12" fill="#316bff"/>
    <rect x="394" y="194" width="112" height="16" rx="8" fill="#8492aa"/>
    <rect x="394" y="226" width="132" height="16" rx="8" fill="#b2bdcf"/>
    <rect x="394" y="306" width="118" height="48" rx="12" fill="#172033"/>
  </svg>`);
  return sharp(overlay, { limitInputPixels: 100_000_000 }).png().toBuffer();
}

async function removeInterruptedExportTemps(dataDir: string, interruptedExportIds: string[]): Promise<void> {
  if (dataDir === ":memory:" || interruptedExportIds.length === 0) return;
  const interrupted = new Set(interruptedExportIds);
  const root = resolve(dataDir, "exports");
  let names: string[];
  try { names = await readdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const pattern = /^\.tmp-(export_[a-f0-9]{24})-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match || !interrupted.has(match[1]!)) continue;
    const path = resolve(root, name);
    if (!path.startsWith(`${root}${sep}`)) continue;
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    await rm(path, { recursive: true, force: true });
  }
}
