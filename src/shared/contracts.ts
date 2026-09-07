import { z } from "zod";
import { planQueries, planSearchProfileQueries } from "./query-planner.js";

const MAX_EXPANSION_TERMS = 64;
const MAX_EXPANSION_TERM_LENGTH = 160;
const MAX_LABEL_PATH_LENGTH = 640;
const MAX_LABEL_LEVEL_LENGTH = 160;
const MAX_GENERATED_QUERY_LENGTH = 1000;
const expansionTermSchema = z.string().trim().min(1).max(MAX_EXPANSION_TERM_LENGTH);
const labelPathSchema = z.string().trim().min(1).max(MAX_LABEL_PATH_LENGTH);

function normalizedPath(value: string): string[] {
  return value.normalize("NFKC").split(/\s*(?:>|\/|\t)\s*/u).map((part) => part.trim()).filter(Boolean);
}

export const taskTypeSchema = z.enum([
  "advertiser_product_taxonomy",
  "content_moderation"
]);

export const exportModeSchema = z.enum(["strict_compliance", "internal_research"]);

export const searchPlatformIds = [
  "taobao_tmall",
  "jd",
  "pinduoduo",
  "vipshop",
  "xiaohongshu",
  "douyin"
] as const;

export const searchPlatformSchema = z.enum(searchPlatformIds);
export type SearchPlatform = z.infer<typeof searchPlatformSchema>;

export const searchPlatformLabels: Record<SearchPlatform, string> = {
  taobao_tmall: "淘宝/天猫",
  jd: "京东",
  pinduoduo: "拼多多",
  vipshop: "唯品会",
  xiaohongshu: "小红书",
  douyin: "抖音电商"
};

export const searchPlatformSelectionSchema = z.array(searchPlatformSchema)
  .max(searchPlatformIds.length)
  .refine((platforms) => new Set(platforms).size === platforms.length, {
    message: "Search platforms must be unique."
  })
  .transform((platforms) => searchPlatformIds.filter((platform) => platforms.includes(platform)));

export const providerIds = [
  "openverse",
  "baidu",
  "brave",
  "serpapi",
  "dataforseo",
  "fake",
  "wikimedia",
  "met",
  "cleveland",
  "artic",
  "loc",
  "nasa",
  "internet_archive",
  "open_food_facts",
  "smithsonian",
  "rijksmuseum",
  "bing_ads",
  "snap_ads",
  "europeana",
  "pexels",
  "pixabay",
  "unsplash",
  "flickr",
  "harvard_art_museums",
  "dpla",
  "tiktok_ads"
] as const;

export const providerIdSchema = z.enum(providerIds);
export const providerCredentialModeSchema = z.enum(["none", "optional", "required", "approval"]);
export const providerSourceCategorySchema = z.enum(["general", "culture", "commerce", "ad_library"]);

export const moderationRiskCategorySchema = z.enum(["adult_content", "graphic_violence", "self_harm"]);
export type ModerationRiskCategory = z.infer<typeof moderationRiskCategorySchema>;

export const searchProfileSchema = z.object({
  terms: z.array(expansionTermSchema).min(1).max(MAX_EXPANSION_TERMS),
  styles: z.array(expansionTermSchema).max(MAX_EXPANSION_TERMS).default([]),
  requiredTerms: z.array(expansionTermSchema).max(MAX_EXPANSION_TERMS).default([]),
  excludedTerms: z.array(expansionTermSchema).max(MAX_EXPANSION_TERMS).default([])
});

export const labelSearchProfileSchema = z.object({
  labelPath: labelPathSchema,
  zh: searchProfileSchema,
  en: searchProfileSchema
});

export const createJobInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  taskType: taskTypeSchema,
  exportMode: exportModeSchema,
  searchPlatforms: searchPlatformSelectionSchema.default([]),
  labelPaths: z.array(labelPathSchema).min(1).max(500),
  labelSearchProfiles: z.array(labelSearchProfileSchema).min(1).max(500).optional(),
  aliases: z.array(expansionTermSchema).max(MAX_EXPANSION_TERMS).default([]),
  styles: z.array(expansionTermSchema).max(MAX_EXPANSION_TERMS).default(["电商广告", "商品展示"]),
  requiredTerms: z.array(expansionTermSchema).max(MAX_EXPANSION_TERMS).default([]),
  excludedTerms: z.array(expansionTermSchema).max(MAX_EXPANSION_TERMS).default([]),
  targetCount: z.number().int().min(1).max(1000).default(30),
  candidateCount: z.number().int().min(1).max(1000).default(100),
  allowedRiskCategories: z.array(moderationRiskCategorySchema).max(3).optional()
}).superRefine((input, context) => {
  if (input.taskType !== "content_moderation" && input.allowedRiskCategories !== undefined) {
    context.addIssue({ code: "custom", path: ["allowedRiskCategories"], message: "Risk categories may only relax moderation searches." });
  }
  if (input.candidateCount < input.targetCount) {
    context.addIssue({ code: "custom", path: ["candidateCount"], message: "候选素材数不能小于目标素材数。" });
  }
  if (input.labelSearchProfiles !== undefined) {
    if (input.labelSearchProfiles.length !== input.labelPaths.length) {
      context.addIssue({ code: "custom", path: ["labelSearchProfiles"], message: "每条标签路径都必须配置中文和英文查询条件。" });
    }
    for (const [index, profile] of input.labelSearchProfiles.entries()) {
      if (normalizedPath(profile.labelPath).join("\u001f") !== normalizedPath(input.labelPaths[index] ?? "").join("\u001f")) {
        context.addIssue({ code: "custom", path: ["labelSearchProfiles", index, "labelPath"], message: "查询条件必须与同一行标签路径对应。" });
      }
    }
  }
  for (const [index, source] of input.labelPaths.entries()) {
    const path = normalizedPath(source);
    if (path.some((level) => level.length > MAX_LABEL_LEVEL_LENGTH)) {
      context.addIssue({ code: "custom", path: ["labelPaths", index], message: `Each taxonomy level must be at most ${MAX_LABEL_LEVEL_LENGTH} characters.` });
      continue;
    }
    const profile = input.labelSearchProfiles?.[index];
    const product = path.at(-1);
    if (!product) continue;
    const variants = profile
      ? [...planSearchProfileQueries(profile.zh), ...planSearchProfileQueries(profile.en)]
      : planQueries({
          labelPath: path,
          product,
          aliases: input.aliases,
          styles: input.styles,
          requiredTerms: input.requiredTerms,
          excludedTerms: input.excludedTerms
        });
    if (variants.some((variant) => variant.query.length > MAX_GENERATED_QUERY_LENGTH)) {
      context.addIssue({ code: "custom", path: ["labelPaths", index], message: `Generated search queries must be at most ${MAX_GENERATED_QUERY_LENGTH} characters.` });
    }
  }
});

/** Public create requests must use explicit bilingual queries; the base schema stays optional for persisted legacy jobs. */
export const createJobRequestSchema = createJobInputSchema.refine(
  (input) => input.labelSearchProfiles !== undefined,
  { path: ["labelSearchProfiles"], message: "新建任务必须为每条标签路径配置中文和英文查询条件。" }
);

export type TaskType = z.infer<typeof taskTypeSchema>;
export type ExportMode = z.infer<typeof exportModeSchema>;
export type ProviderId = z.infer<typeof providerIdSchema>;
export type ProviderCredentialMode = z.infer<typeof providerCredentialModeSchema>;
export type ProviderSourceCategory = z.infer<typeof providerSourceCategorySchema>;
export type SearchProfile = z.infer<typeof searchProfileSchema>;
export type LabelSearchProfile = z.infer<typeof labelSearchProfileSchema>;
export type CreateJobInput = z.infer<typeof createJobInputSchema>;

export const supportedImageMimeTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

export const cacheSafetySettingsSchema = z.object({
  downloadTimeoutMs: z.number().int().min(100).max(20_000),
  maxBytes: z.number().int().min(1_024).max(25_000_000),
  maxPixels: z.number().int().min(128 * 128).max(100_000_000),
  minDimension: z.number().int().min(128).max(10_000),
  supportedFormats: z.array(supportedImageMimeTypeSchema).min(1).max(3)
    .refine((formats) => new Set(formats).size === formats.length, { message: "Supported formats must be unique." })
}).strict().refine((settings) => settings.minDimension * settings.minDimension <= settings.maxPixels, {
  path: ["minDimension"], message: "Minimum dimensions must fit inside the pixel limit."
});

export const contractualRightsDeclarationsSchema = z.partialRecord(providerIdSchema, z.boolean());

export const localSettingsSchema = z.object({
  defaultLocale: z.string().trim().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u).max(16),
  defaultCountry: z.string().trim().regex(/^[A-Z]{2}$/u),
  safeSearch: z.boolean(),
  cache: cacheSafetySettingsSchema,
  contractualRightsDeclarations: contractualRightsDeclarationsSchema
}).strict();

export type CacheSafetySettings = z.infer<typeof cacheSafetySettingsSchema>;
export type LocalSettings = z.infer<typeof localSettingsSchema>;

export const defaultLocalSettings: LocalSettings = {
  defaultLocale: "zh-CN",
  defaultCountry: "CN",
  safeSearch: true,
  cache: {
    downloadTimeoutMs: 20_000,
    maxBytes: 25_000_000,
    maxPixels: 100_000_000,
    minDimension: 128,
    supportedFormats: ["image/jpeg", "image/png", "image/webp"]
  },
  contractualRightsDeclarations: {}
};

export const startSearchInputSchema = z.object({
  providerIds: z.array(providerIdSchema).min(1).max(32),
  retryFailedProviderIds: z.array(providerIdSchema).max(32).default([])
}).superRefine((input, context) => {
  if (new Set(input.providerIds).size !== input.providerIds.length) {
    context.addIssue({ code: "custom", path: ["providerIds"], message: "Provider IDs must be unique." });
  }
  if (new Set(input.retryFailedProviderIds).size !== input.retryFailedProviderIds.length) {
    context.addIssue({ code: "custom", path: ["retryFailedProviderIds"], message: "Retry provider IDs must be unique." });
  }
  const selected = new Set(input.providerIds);
  if (input.retryFailedProviderIds.some((providerId) => !selected.has(providerId))) {
    context.addIssue({ code: "custom", path: ["retryFailedProviderIds"], message: "Retry providers must be selected providers." });
  }
});

export type StartSearchInput = z.input<typeof startSearchInputSchema>;

export interface Job {
  id: string;
  name: string;
  taskType: TaskType;
  exportMode: ExportMode;
  /** Empty or omitted means the job is not restricted to named commerce platforms. */
  searchPlatforms?: SearchPlatform[];
  status: "draft" | "collecting" | "reviewing" | "ready" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface LabelTarget {
  id: string;
  jobId: string;
  path: string[];
  product: string;
  aliases: string[];
  styles: string[];
  requiredTerms: string[];
  excludedTerms: string[];
  searchProfiles?: { zh: SearchProfile; en: SearchProfile };
  targetCount: number;
  candidateCount: number;
  selectedCount: number;
}

export interface CandidateProvenance {
  hitId: string;
  queryRunId: string;
  provider: ProviderId;
  variantName: string;
  query: string;
  page: number;
  imageUrl: string | null;
  landingPageUrl: string | null;
  title: string | null;
  creator: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
  sourceProvider: string | null;
  source: string | null;
  rightsStatus: "provider_claimed" | "unknown" | "verified" | "user_owned" | "cc0" | "pdm";
}

export const retryableDownloadFailureCodes = ["FORBIDDEN", "RATE_LIMITED", "NETWORK", "GENERIC"] as const;
export type RetryableDownloadFailureCode = typeof retryableDownloadFailureCodes[number];
export function isRetryableDownloadFailureCode(value: unknown): value is RetryableDownloadFailureCode {
  return typeof value === "string" && retryableDownloadFailureCodes.includes(value as RetryableDownloadFailureCode);
}

export interface Candidate {
  id: string;
  jobId: string;
  provider: ProviderId;
  imageUrl: string;
  landingPageUrl: string | null;
  title: string | null;
  pipelineState: "discovered" | "fetching" | "processed" | "invalid" | "quarantined";
  rightsStatus?: "provider_claimed" | "unknown" | "verified" | "user_owned" | "cc0" | "pdm";
  assetId?: string | null;
  width?: number | null;
  height?: number | null;
  mimeType?: "image/jpeg" | "image/png" | "image/webp" | null;
  discoveryLabelIds?: string[];
  pipelineError?: string | null;
  pipelineFailureCode?: RetryableDownloadFailureCode | null;
  warnings?: string[];
  nearDuplicateGroup?: string | null;
  reviewState?: "unreviewed" | "selected" | "rejected";
  labelIds?: string[];
  primaryLabelId?: string | null;
  rightsAcknowledged?: boolean;
  rightsBasis?: RightsBasis;
  rightsEvidence?: string | null;
  provenance: CandidateProvenance[];
}

export interface ProviderStatus {
  id: ProviderId;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  rightsPolicy: "open" | "discovery_only" | "contractual";
  maxResults: number;
  credentialVariables: string[];
  credentialMode: ProviderCredentialMode;
  sourceCategory: ProviderSourceCategory;
  freeTier: string;
  docsUrl: string;
  defaultSelected: boolean;
}

export interface ProviderRunSummary {
  id: string;
  jobId: string;
  labelId: string;
  providerId: ProviderId;
  variantName: string;
  query: string;
  status: "pending" | "running" | "completed" | "failed" | "paused" | "retryable";
  retryable: boolean;
  requiresExplicitRetry: boolean;
  errorSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  hitCount: number;
}

export interface SearchEvent {
  cursor: number;
  type: "query_run" | "review";
  runId: string | null;
  status: ProviderRunSummary["status"] | ReviewState["reviewState"] | null;
  candidateId?: string | null;
  action?: ReviewAction | null;
  createdAt: string;
}

export interface SearchEventsPage {
  items: SearchEvent[];
  nextCursor: number | null;
}

export const rightsBasisSchema = z.enum(["unknown", "verified_cc0", "verified_pdm", "cc0", "pdm", "user_owned", "licensed"]);
export const reviewActionSchema = z.enum(["select", "reject", "restore", "move_label", "set_labels", "keep_highest_resolution", "acknowledge_rights", "set_rights_evidence", "override_warning"]);
export const reviewInputSchema = z.object({
  candidateIds: z.array(z.string().min(1)).min(1).max(500),
  action: reviewActionSchema,
  labelIds: z.array(z.string().min(1)).max(100).optional(),
  primaryLabelId: z.string().min(1).optional(),
  primaryCandidateId: z.string().min(1).optional(),
  rightsAcknowledged: z.boolean().optional(),
  rightsBasis: rightsBasisSchema.optional(),
  rightsEvidence: z.string().trim().min(1).max(500).nullable().optional(),
  warningCode: z.string().trim().regex(/^[A-Z0-9_:-]+$/).max(100).optional()
}).superRefine((value, context) => {
  if (value.action === "keep_highest_resolution") {
    if (!value.primaryCandidateId) context.addIssue({ code: "custom", path: ["primaryCandidateId"], message: "Primary duplicate candidate is required." });
    else if (!value.candidateIds.includes(value.primaryCandidateId)) context.addIssue({ code: "custom", path: ["primaryCandidateId"], message: "Primary duplicate candidate must be included." });
    if (!value.labelIds?.length) context.addIssue({ code: "custom", path: ["labelIds"], message: "Explicit final labels are required." });
  }
  if (value.rightsEvidence) {
    try { const url = new URL(value.rightsEvidence); if (!((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash && value.rightsEvidence.length <= 300)) throw new Error(); }
    catch { context.addIssue({ code: "custom", path: ["rightsEvidence"], message: "Rights evidence must be a queryless HTTP(S) audit reference." }); }
  }
});
export type ReviewAction = z.infer<typeof reviewActionSchema>;
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export type RightsBasis = z.infer<typeof rightsBasisSchema>;

export interface ReviewState {
  candidateId: string;
  reviewState: "unreviewed" | "selected" | "rejected";
  labelIds: string[];
  primaryLabelId: string | null;
  rightsAcknowledged: boolean;
  rightsBasis: RightsBasis;
  rightsEvidence: string | null;
  rightsStatus?: Candidate["rightsStatus"];
  warningOverrides: string[];
}
