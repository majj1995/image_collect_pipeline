import { createContext, createElement, useContext, type PropsWithChildren } from "react";
import { z } from "zod";
import type {
  Candidate,
  CreateJobInput,
  Job,
  LabelTarget,
  ProviderRunSummary,
  ProviderStatus,
  ReviewInput,
  ReviewState,
  StartSearchInput
} from "../shared/contracts.js";
import {
  localSettingsSchema,
  providerCredentialModeSchema,
  providerIdSchema,
  providerSourceCategorySchema,
  retryableDownloadFailureCodes,
  searchProfileSchema,
  type LocalSettings
} from "../shared/contracts.js";

const jobSchema = z.object({
  id: z.string(),
  name: z.string(),
  taskType: z.enum(["advertiser_product_taxonomy", "content_moderation"]),
  exportMode: z.enum(["strict_compliance", "internal_research"]),
  status: z.enum(["draft", "collecting", "reviewing", "ready", "failed"]),
  createdAt: z.string(),
  updatedAt: z.string()
}) satisfies z.ZodType<Job>;

const labelTargetSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  path: z.array(z.string()),
  product: z.string(),
  aliases: z.array(z.string()),
  styles: z.array(z.string()),
  requiredTerms: z.array(z.string()),
  excludedTerms: z.array(z.string()),
  searchProfiles: z.object({ zh: searchProfileSchema, en: searchProfileSchema }).optional(),
  targetCount: z.number(),
  candidateCount: z.number(),
  selectedCount: z.number()
}) satisfies z.ZodType<LabelTarget>;

const jobDetailSchema = jobSchema.extend({ labels: z.array(labelTargetSchema) });

const healthSchema = z.object({ ok: z.boolean(), service: z.string() });
const jobsSchema = z.object({ items: z.array(jobSchema) });
const providersSchema = z.object({
  items: z.array(z.object({
    id: providerIdSchema,
    displayName: z.string(),
    configured: z.boolean(),
    enabled: z.boolean(),
    rightsPolicy: z.enum(["open", "discovery_only", "contractual"]),
    maxResults: z.number(),
    credentialVariables: z.array(z.string()),
    credentialMode: providerCredentialModeSchema,
    sourceCategory: providerSourceCategorySchema,
    freeTier: z.string(),
    docsUrl: z.url(),
    defaultSelected: z.boolean()
  }) satisfies z.ZodType<ProviderStatus>)
});

const candidateProvenanceSchema = z.object({
  hitId: z.string(),
  queryRunId: z.string(),
  provider: providerIdSchema,
  variantName: z.string(),
  query: z.string(),
  page: z.number().int().positive(),
  imageUrl: z.string().nullable(),
  landingPageUrl: z.string().nullable(),
  title: z.string().nullable(),
  creator: z.string().nullable(),
  licenseName: z.string().nullable(),
  licenseUrl: z.string().nullable(),
  sourceProvider: z.string().nullable(),
  source: z.string().nullable(),
  rightsStatus: z.enum(["provider_claimed", "unknown", "verified", "user_owned", "cc0", "pdm"])
});

const candidateSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  provider: providerIdSchema,
  imageUrl: z.string(),
  landingPageUrl: z.string().nullable(),
  title: z.string().nullable(),
  pipelineState: z.enum(["discovered", "fetching", "processed", "invalid", "quarantined"]),
  rightsStatus: z.enum(["provider_claimed", "unknown", "verified", "user_owned", "cc0", "pdm"]).optional(),
  assetId: z.string().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).nullable().optional(),
  discoveryLabelIds: z.array(z.string()).optional(),
  pipelineError: z.string().nullable().optional(),
  pipelineFailureCode: z.enum(retryableDownloadFailureCodes).nullable().optional(),
  warnings: z.array(z.string()).optional(),
  nearDuplicateGroup: z.string().nullable().optional(),
  reviewState: z.enum(["unreviewed", "selected", "rejected"]).optional(),
  labelIds: z.array(z.string()).optional(),
  primaryLabelId: z.string().nullable().optional(),
  rightsAcknowledged: z.boolean().optional(),
  rightsBasis: z.enum(["unknown", "verified_cc0", "verified_pdm", "cc0", "pdm", "user_owned", "licensed"]).optional(),
  rightsEvidence: z.string().nullable().optional(),
  provenance: z.array(candidateProvenanceSchema)
}) satisfies z.ZodType<Candidate>;

const providerRunSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  labelId: z.string(),
  providerId: providerIdSchema,
  variantName: z.string(),
  query: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "paused", "retryable"]),
  retryable: z.boolean(),
  requiresExplicitRetry: z.boolean(),
  errorSummary: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  hitCount: z.number()
}) satisfies z.ZodType<ProviderRunSummary>;

const candidatePageSchema = z.object({
  items: z.array(candidateSchema),
  nextCursor: z.number().nullable(),
  labelProgress: z.array(z.object({ labelId: z.string(), candidateCount: z.number() })),
  providerRuns: z.array(providerRunSchema)
});

const reviewResponseSchema = z.object({
  items: z.array(z.object({
    candidateId: z.string(),
    reviewState: z.enum(["unreviewed", "selected", "rejected"]),
    labelIds: z.array(z.string()),
    primaryLabelId: z.string().nullable(),
    rightsAcknowledged: z.boolean(),
    rightsBasis: z.enum(["unknown", "verified_cc0", "verified_pdm", "cc0", "pdm", "user_owned", "licensed"]),
    rightsEvidence: z.string().nullable(),
    rightsStatus: z.enum(["provider_claimed", "unknown", "verified", "user_owned", "cc0", "pdm"]).optional(),
    warningOverrides: z.array(z.string())
  }) satisfies z.ZodType<ReviewState>)
});

const preflightSchema = z.object({
  selected: z.number(),
  uniqueAssets: z.number(),
  ready: z.number(),
  blockers: z.record(z.string(), z.array(z.string())),
  warnings: z.record(z.string(), z.array(z.string()))
});

const createExportSchema = z.object({
  id: z.string(),
  status: z.enum(["generating", "ready", "failed"]),
  preflight: preflightSchema
});

const exportStatusSchema = createExportSchema.extend({
  jobId: z.string(),
  errorCode: z.string().nullable(),
  zipSha256: z.string().nullable()
});

export type Health = z.infer<typeof healthSchema>;
export type JobDetail = z.infer<typeof jobDetailSchema>;
export type CandidatePage = z.infer<typeof candidatePageSchema>;
export type ExportPreflight = z.infer<typeof preflightSchema>;
export type ExportStatus = z.infer<typeof exportStatusSchema>;

function localizedError(status: number): string {
  if (status === 400) return "请求内容无效，请检查输入。";
  if (status === 404) return "请求的资源不存在。";
  if (status === 409) return "当前状态不允许执行此操作。";
  if (status >= 500) return "本地服务处理失败，请稍后重试。";
  return "本地服务拒绝了该请求。";
}

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number | null,
    public readonly details?: unknown,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

/** Every HTTP response crosses this single Zod-validated boundary. */
export async function request<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: RequestInit = {},
  fetcher: typeof fetch = globalThis.fetch
): Promise<z.output<Schema>> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetcher(path, { ...init, headers });
  } catch (cause) {
    throw new ApiError("无法连接本地服务，请确认后端已启动。", null, undefined, { cause });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) throw new ApiError(localizedError(response.status), response.status, payload);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError("本地服务返回了无法识别的数据。", response.status, parsed.error.issues);
  }
  return parsed.data;
}

export interface ApiClient {
  getHealth(): Promise<Health>;
  listJobs(): Promise<{ items: Job[] }>;
  getJob(jobId: string): Promise<JobDetail>;
  createJob(input: CreateJobInput): Promise<JobDetail>;
  listProviders(): Promise<{ items: ProviderStatus[] }>;
  getSettings(): Promise<LocalSettings>;
  updateSettings(settings: LocalSettings): Promise<LocalSettings>;
  listCandidates(jobId: string, cursor?: number): Promise<CandidatePage>;
  startSearch(jobId: string, input: StartSearchInput): Promise<{ status: "collecting" | "exhausted" }>;
  pauseSearch(jobId: string): Promise<{ paused: number }>;
  review(jobId: string, input: ReviewInput): Promise<{ items: ReviewState[] }>;
  getExportPreflight(jobId: string): Promise<ExportPreflight>;
  createExport(jobId: string): Promise<z.infer<typeof createExportSchema>>;
  getExport(exportId: string): Promise<ExportStatus>;
  exportDownloadUrl(exportId: string): string;
}

const encoded = (value: string) => encodeURIComponent(value);

export function createApiClient(fetcher: typeof fetch = globalThis.fetch): ApiClient {
  const call = <Schema extends z.ZodType>(path: string, schema: Schema, init?: RequestInit) => request(path, schema, init, fetcher);
  return {
    getHealth: () => call("/api/health", healthSchema),
    listJobs: () => call("/api/jobs", jobsSchema),
    getJob: (jobId) => call(`/api/jobs/${encoded(jobId)}`, jobDetailSchema),
    createJob: (input) => call("/api/jobs", jobDetailSchema, { method: "POST", body: JSON.stringify(input) }),
    listProviders: () => call("/api/providers", providersSchema),
    getSettings: () => call("/api/settings", localSettingsSchema),
    updateSettings: (settings) => call("/api/settings", localSettingsSchema, { method: "PUT", body: JSON.stringify(settings) }),
    listCandidates: (jobId, cursor) => call(`/api/jobs/${encoded(jobId)}/candidates${cursor === undefined ? "" : `?cursor=${cursor}`}`, candidatePageSchema),
    startSearch: (jobId, input) => call(`/api/jobs/${encoded(jobId)}/search`, z.object({ status: z.enum(["collecting", "exhausted"]) }), { method: "POST", body: JSON.stringify(input) }),
    pauseSearch: (jobId) => call(`/api/jobs/${encoded(jobId)}/pause`, z.object({ paused: z.number() }), { method: "POST" }),
    review: (jobId, input) => call(`/api/jobs/${encoded(jobId)}/reviews`, reviewResponseSchema, { method: "POST", body: JSON.stringify(input) }),
    getExportPreflight: (jobId) => call(`/api/jobs/${encoded(jobId)}/exports/preflight`, preflightSchema),
    createExport: (jobId) => call(`/api/jobs/${encoded(jobId)}/exports`, createExportSchema, { method: "POST" }),
    getExport: (exportId) => call(`/api/exports/${encoded(exportId)}`, exportStatusSchema),
    exportDownloadUrl: (exportId) => `/api/exports/${encoded(exportId)}/download`
  };
}

export const ApiContext = createContext<ApiClient | null>(null);
const defaultApiClient = createApiClient();

export function ApiProvider({ children, value }: PropsWithChildren<{ value?: ApiClient }>) {
  return createElement(ApiContext.Provider, { value: value ?? defaultApiClient }, children);
}

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("ApiProvider is required.");
  return api;
}
