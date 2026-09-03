import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/server/app.js";
import type { AppDatabase } from "../../src/server/database.js";
import { JobsRepository } from "../../src/server/repositories/jobs.js";
import type { AssetService, AssetServiceOptions } from "../../src/server/services/asset-service.js";
import type { RetryPolicyOptions } from "../../src/server/services/retry-policy.js";
import type { SearchTimingOptions } from "../../src/server/services/search-service.js";
import { createJobInputSchema, type LabelSearchProfile } from "../../src/shared/contracts.js";
import { normalizePath, parseLabelPaths } from "../../src/shared/taxonomy.js";

export interface CreateTestAppOptions {
  dataDir?: string;
  providers?: unknown[];
  env?: NodeJS.ProcessEnv;
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

export async function makeTempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "data-expansion-test-"));
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<FastifyInstance> {
  const ownedDataDir = options.dataDir === undefined ? await makeTempDataDir() : undefined;
  const fixtureMode = options.env?.NODE_ENV === "test" && options.env.ALLOW_TEST_FIXTURES === "1";
  const app = await createApp({ dataDir: options.dataDir ?? ownedDataDir!, env: options.env ?? {}, providers: options.providers, assetService: options.assetService ?? (options.assetServiceOptions || fixtureMode ? undefined : false), assetServiceOptions: options.assetServiceOptions, contractualStorageRights: options.contractualStorageRights, contractualRightsDeclarations: options.contractualRightsDeclarations, onExportGenerationStart: options.onExportGenerationStart, testBeforeExportTransaction: options.testBeforeExportTransaction, closeExternalResources: options.closeExternalResources, searchRetry: options.searchRetry, searchTiming: options.searchTiming, staticRoot: options.staticRoot });
  if (ownedDataDir) {
    app.addHook("onClose", async () => {
      await rm(ownedDataDir, { recursive: true, force: true });
    });
  }
  return app;
}

export async function createSpeakerJob(app: FastifyInstance): Promise<Record<string, unknown>> {
  const input = createJobInputSchema.parse({
    name: "音箱任务",
    taskType: "advertiser_product_taxonomy",
    exportMode: "internal_research",
    labelPaths: ["电商快销>3C及电器>影音电器>音箱"]
  });
  const database = (app as typeof app & { database: AppDatabase }).database;
  return new JobsRepository(database).create(input, parseLabelPaths(input.labelPaths)) as unknown as Record<string, unknown>;
}

export function makeBilingualProfiles(labelPaths: string[]): LabelSearchProfile[] {
  return labelPaths.map((labelPath, index) => {
    const term = normalizePath(labelPath).at(-1) ?? `商品-${index + 1}`;
    const profile = {
      terms: [term, `${term} 同义词一`, `${term} 同义词二`],
      styles: ["电商海报", "电商广告", "product ad"],
      requiredTerms: [],
      excludedTerms: []
    };
    return { labelPath, zh: profile, en: profile };
  });
}

export async function waitForJob(app: FastifyInstance, jobId: string, status: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    const job = response.json() as Record<string, unknown>;
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not reach ${status}.`);
}

export async function seedInterruptedRunAndSelectedCandidate(): Promise<void> {}

export async function readRunStatus(): Promise<undefined> {
  return undefined;
}

export async function readReviewState(): Promise<undefined> {
  return undefined;
}

export async function assignLabels(app: FastifyInstance, jobId: string, labelIds: string[]) {
  return app.inject({ method: "POST", url: `/api/jobs/${jobId}/reviews`, payload: { labelIds } });
}
