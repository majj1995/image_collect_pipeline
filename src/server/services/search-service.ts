import type { JobDetail, JobsRepository } from "../repositories/jobs.js";
import { SearchRepository, type CandidateMaterializationTarget, type QueryRun, type QueryRunDraft } from "../repositories/search.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
  defaultLocalSettings,
  type LocalSettings,
  type ProviderId,
  type SearchPlatform
} from "../../shared/contracts.js";
import {
  planQueries,
  planSearchProfileQueries,
  planSupplementalSearchProfileQueries,
  type QueryVariant
} from "../../shared/query-planner.js";
import type { AssetService } from "./asset-service.js";
import {
  executeWithProviderRetry,
  providerFailureSummary,
  providerRetryAfterDisposition,
  type RetryPolicyOptions
} from "./retry-policy.js";
import { ProviderError, type ImageSearchProvider } from "../providers/types.js";
import { providerCatalogMetadata } from "../providers/types.js";

export type SearchStartResult = "started" | "exhausted" | "missing_job" | "unknown_provider" | "disabled_provider" | "active";

export interface SearchTimingOptions {
  monotonicNow: () => number;
  sleep: (delayMs: number) => Promise<void>;
}

const MAX_SEARCH_RUNS_PER_START = 2000;

interface PlannedLabel {
  labelId: string;
  variants: Record<"zh" | "en", QueryVariant[]>;
  supplementalVariants: Record<"zh" | "en", QueryVariant[]>;
  eligibleProviderIds: ReadonlySet<ProviderId>;
}

type ScheduledWork =
  | { kind: "existing"; run: QueryRun }
  | { kind: "fresh"; draft: QueryRunDraft };

const FOOD_ZH_TERMS = [
  "食品", "饮料", "饮品", "零食", "生鲜", "粮油", "调味", "乳制品", "冲调", "酒水", "糖果", "烘焙",
  "肉类", "海鲜", "果蔬", "水产", "可乐", "面包", "巧克力", "咖啡", "牛奶", "酸奶", "奶粉", "茶叶",
  "啤酒", "白酒", "红酒", "葡萄酒", "饼干", "薯片", "坚果", "蜂蜜", "果汁", "饮用水", "矿泉水",
  "方便面", "食用油", "大米", "谷物", "麦片", "罐头", "火腿", "香肠", "冰淇淋", "奶酪", "黄油"
] as const;

const FOOD_EN_TERMS = new Set([
  "food", "foods", "beverage", "beverages", "drink", "drinks", "snack", "snacks", "grocery", "groceries",
  "dairy", "bakery", "meat", "seafood", "produce", "fruit", "fruits", "vegetable", "vegetables", "cola", "soda",
  "bread", "chocolate", "coffee", "milk", "yogurt", "yoghurt", "tea", "beer", "wine", "candy", "candies",
  "biscuit", "biscuits", "cookie", "cookies", "juice", "cereal", "oatmeal", "pasta", "rice", "noodle", "noodles",
  "seasoning", "condiment", "condiments", "sauce", "cheese", "butter", "sausage", "sausages"
]);

function isFoodLabel(label: JobDetail["labels"][number]): boolean {
  const profileTerms = label.searchProfiles
    ? [...label.searchProfiles.zh.terms, ...label.searchProfiles.en.terms]
    : [];
  const values = [...label.path, label.product, ...profileTerms].map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => FOOD_ZH_TERMS.some((term) => value.includes(term)))) return true;
  return values.some((value) => (value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [])
    .some((token) => FOOD_EN_TERMS.has(token)));
}

function providerCanSearchLabel(provider: ImageSearchProvider, taskType: JobDetail["taskType"], label: JobDetail["labels"][number]): boolean {
  const metadata = providerCatalogMetadata(provider);
  if (taskType === "advertiser_product_taxonomy" && metadata.sourceCategory === "culture") return false;
  if (provider.id === "snap_ads") return false;
  if (provider.id !== "open_food_facts") return true;
  return isFoodLabel(label);
}

function queryRunKey(run: Pick<QueryRunDraft, "labelId" | "providerId" | "variantName" | "query" | "page">): string {
  return [run.labelId, run.providerId, run.variantName, run.query, run.page ?? 1].join("\u0000");
}

function queryCombinationKey(run: Pick<QueryRunDraft, "labelId" | "providerId" | "variantName" | "query">): string {
  return [run.labelId, run.providerId, run.variantName, run.query].join("\u0000");
}

function requestAllocationKey(labelId: string, providerId: ProviderId): string {
  return `${labelId}\u0000${providerId}`;
}

function interleave<Value>(...groups: Value[][]): Value[] {
  const result: Value[] = [];
  const rounds = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < rounds; index += 1) {
    for (const group of groups) {
      const value = group[index];
      if (value !== undefined) result.push(value);
    }
  }
  return result;
}

export class SearchService {
  private readonly running = new Set<Promise<void>>();
  private readonly activeJobs = new Set<string>();
  private readonly materializing = new Set<Promise<void>>();
  private readonly materializationQueue: CandidateMaterializationTarget[] = [];
  private readonly queuedCandidates = new Set<string>();
  private readonly pendingMaterializationRequeues = new Set<string>();
  private readonly activeProviderMaterializations = new Map<ProviderId, number>();
  private readonly providerWaiters = new Map<ProviderId, Array<() => void>>();
  private readonly providerNextSearchStartAt = new Map<ProviderId, number>();
  private readonly providerBlockedUntil = new Map<ProviderId, { until: number; error: ProviderError }>();
  private activeProviderRequests = 0;
  private readonly providerRequestWaiters: Array<() => void> = [];
  private readonly monotonicNow: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  public constructor(
    private readonly jobs: JobsRepository,
    private readonly searches: SearchRepository,
    private readonly providers: ProviderRegistry,
    private readonly assets?: AssetService,
    private readonly retryOptions: Partial<RetryPolicyOptions> = {},
    private readonly readSettings: () => LocalSettings = () => defaultLocalSettings,
    timing: Partial<SearchTimingOptions> = {}
  ) {
    this.monotonicNow = timing.monotonicNow ?? (() => performance.now());
    this.sleep = timing.sleep ?? ((delayMs) => new Promise((resolve) => { setTimeout(resolve, delayMs); }));
    if (this.assets) this.enqueueMaterialization(this.searches.listCandidatesRequiringCacheRebuild());
  }

  public startJobSearch(jobId: string, providerIds: ProviderId[], retryFailedProviderIds: ProviderId[] = []): SearchStartResult {
    const job = this.jobs.get(jobId);
    if (!job) return "missing_job";
    const selected = this.providers.select(providerIds);
    if (!selected) return "unknown_provider";
    if (retryFailedProviderIds.some((providerId) => !providerIds.includes(providerId))) return "unknown_provider";
    if (selected.some((provider) => !this.providers.isEnabled(provider))) return "disabled_provider";
    if (this.activeJobs.has(jobId)) return "active";
    this.activeJobs.add(jobId);
    let scheduledRunIds: string[] = [];
    try {
      if (this.searches.hasActiveRuns(jobId)) {
        this.activeJobs.delete(jobId);
        return "active";
      }
      this.searches.retryFailedRuns(jobId, retryFailedProviderIds);
      const stableProviderIds = selected.filter((provider) => provider.refreshDownloadUrlOnRetry !== true).map((provider) => provider.id);
      const refreshProviderIds = selected.filter((provider) => provider.refreshDownloadUrlOnRetry === true).map((provider) => provider.id);
      const retryableCandidateIds = this.searches.listRetryableDownloadCandidateIds(jobId, stableProviderIds);
      this.enqueueMaterialization(retryableCandidateIds);
      const hasMaterializationWork = Boolean(this.assets && retryableCandidateIds.length > 0);
      this.searches.retryRunsForDownloadFailures(jobId, refreshProviderIds);
      const plannedLabels = this.planEligibleLabels(job);
      const candidateLimits = new Map(job.labels.map((label) => [
        label.id,
        this.searches.candidateCount(jobId, label.id) + label.candidateCount
      ]));
      const providerById = new Map(selected.map((provider) => [provider.id, provider]));
      const work = this.planScheduledWork(
        providerIds,
        retryFailedProviderIds,
        plannedLabels,
        job.searchPlatforms ?? [],
        providerById,
        this.searches.listRuns(jobId)
      );
      const existingRuns = work.flatMap((entry) => entry.kind === "existing" ? [entry.run] : []);
      const claimedRuns = this.searches.claimScheduledRuns(jobId, existingRuns);
      scheduledRunIds.push(...claimedRuns.map((run) => run.id));
      const freshDrafts = work.flatMap((entry) => entry.kind === "fresh" ? [entry.draft] : []);
      const freshRuns = freshDrafts.length > 0 ? this.searches.createRuns(jobId, freshDrafts) : [];
      scheduledRunIds.push(...freshRuns.map((run) => run.id));
      const claimedById = new Map(claimedRuns.map((run) => [run.id, run]));
      const freshByKey = new Map(freshRuns.map((run) => [queryRunKey(run), run]));
      const runs = work.flatMap((entry) => entry.kind === "existing"
        ? (claimedById.get(entry.run.id) ?? [])
        : (freshByKey.get(queryRunKey(entry.draft)) ?? []));
      if (runs.length === 0 && !hasMaterializationWork) {
        this.jobs.update(jobId, { status: "reviewing" });
        this.activeJobs.delete(jobId);
        return "exhausted";
      }
      this.jobs.update(jobId, { status: "collecting" });
      let task!: Promise<void>;
      task = new Promise<void>((resolve, reject) => {
        setImmediate(() => { this.execute(jobId, runs, providerById, candidateLimits).then(resolve, reject); });
      });
      this.running.add(task);
      const release = () => {
        this.running.delete(task);
        this.activeJobs.delete(jobId);
      };
      void task.then(release, () => {
        try {
          this.searches.releaseRunsForRetry(jobId, scheduledRunIds, "搜索执行意外中断，可继续重试。");
          if (this.searches.allWorkSettled(jobId)) this.jobs.update(jobId, { status: "reviewing" });
        } catch {
          // Preserve the original task failure; startup recovery handles any remaining active rows.
        } finally {
          release();
        }
      });
      return "started";
    } catch (error) {
      try {
        this.searches.releaseRunsForRetry(jobId, scheduledRunIds, "搜索启动失败，可继续重试。");
      } catch {
        // Preserve the original planning failure; startup recovery handles any remaining active rows.
      } finally {
        this.activeJobs.delete(jobId);
      }
      throw error;
    }
  }

  public async close(): Promise<void> {
    await Promise.allSettled([...this.running]);
    while (this.materializing.size > 0 || this.materializationQueue.length > 0) await Promise.allSettled([...this.materializing]);
  }

  public resumeCandidateMaterialization(candidateIds: string[]): void {
    if (!this.assets) return;
    const ready: string[] = [];
    for (const candidateId of new Set(candidateIds)) {
      if (!this.queuedCandidates.has(candidateId)) {
        ready.push(candidateId);
        continue;
      }
      const isStillWaiting = this.materializationQueue.some((target) => target.candidateId === candidateId);
      if (!isStillWaiting) this.pendingMaterializationRequeues.add(candidateId);
    }
    this.enqueueMaterialization(ready);
  }

  private planEligibleLabels(job: JobDetail): PlannedLabel[] {
    return job.labels
      .filter((label) => label.selectedCount < label.targetCount)
      .map((label) => {
        const legacyVariants = () => planQueries({
          labelPath: label.path, product: label.product, aliases: label.aliases, styles: label.styles,
          requiredTerms: label.requiredTerms, excludedTerms: label.excludedTerms
        });
        const variants = label.searchProfiles
          ? {
              zh: planSearchProfileQueries(label.searchProfiles.zh),
              en: planSearchProfileQueries(label.searchProfiles.en)
            }
          : { zh: legacyVariants(), en: legacyVariants() };
        const supplementalVariants = label.searchProfiles
          ? {
              zh: planSupplementalSearchProfileQueries(label.searchProfiles.zh),
              en: planSupplementalSearchProfileQueries(label.searchProfiles.en)
            }
          : { zh: [], en: [] };
        const eligibleProviderIds = new Set(this.providers.list()
          .filter((provider) => providerCanSearchLabel(provider, job.taskType, label))
          .map((provider) => provider.id));
        return { labelId: label.id, variants, supplementalVariants, eligibleProviderIds };
      });
  }

  private plannedPageOneDrafts(
    plannedLabels: PlannedLabel[],
    providerId: ProviderId,
    supplemental: boolean
  ): QueryRunDraft[] {
    const drafts: QueryRunDraft[] = [];
    const language = this.providers.queryLanguage(providerId);
    const rounds = Math.max(0, ...plannedLabels.map((entry) => (
      supplemental ? entry.supplementalVariants[language].length : entry.variants[language].length
    )));
    for (let round = 0; round < rounds; round += 1) {
      for (const entry of plannedLabels) {
        if (!entry.eligibleProviderIds.has(providerId)) continue;
        const variants = supplemental ? entry.supplementalVariants : entry.variants;
        const variant = variants[language][round];
        if (!variant) continue;
        drafts.push({ labelId: entry.labelId, providerId, variantName: variant.name, query: variant.query, page: 1 });
      }
    }
    return drafts;
  }

  private plannedPlatformPageOneDrafts(
    plannedLabels: PlannedLabel[],
    provider: ImageSearchProvider,
    searchPlatforms: SearchPlatform[]
  ): QueryRunDraft[] {
    if (!provider.buildPlatformQuery || searchPlatforms.length === 0
      || providerCatalogMetadata(provider).sourceCategory !== "general") return [];
    const drafts: QueryRunDraft[] = [];
    const language = this.providers.queryLanguage(provider.id);
    for (const platform of searchPlatforms) {
      for (const entry of plannedLabels) {
        if (!entry.eligibleProviderIds.has(provider.id)) continue;
        const primaryVariant = entry.variants[language][0];
        if (!primaryVariant) continue;
        const query = provider.buildPlatformQuery(primaryVariant.query, platform).trim();
        if (!query) continue;
        drafts.push({
          labelId: entry.labelId,
          providerId: provider.id,
          variantName: `platform_${platform}`,
          query,
          page: 1
        });
      }
    }
    return drafts;
  }

  private planFreshRunDraftsForProvider(
    plannedLabels: PlannedLabel[],
    providerId: ProviderId,
    provider: ImageSearchProvider,
    searchPlatforms: SearchPlatform[],
    existingRuns: QueryRun[],
    existingKeys: ReadonlySet<string>
  ): QueryRunDraft[] {
    const runsByCombination = new Map<string, QueryRun[]>();
    for (const run of existingRuns) {
      const key = queryCombinationKey(run);
      const runs = runsByCombination.get(key) ?? [];
      runs.push(run);
      runsByCombination.set(key, runs);
    }
    const base = this.plannedPageOneDrafts(plannedLabels, providerId, false);
    const platform = this.plannedPlatformPageOneDrafts(plannedLabels, provider, searchPlatforms);
    const supplemental = this.plannedPageOneDrafts(plannedLabels, providerId, true);
    const primary = interleave(base, platform);
    const continuations = [...primary, ...supplemental].flatMap((draft): QueryRunDraft[] => {
      const runs = runsByCombination.get(queryCombinationKey(draft));
      const latest = runs?.at(-1);
      if (!latest || latest.status !== "completed" || latest.hitCount === 0 || latest.requestCount === null
        || provider.supportsPagination !== true) return [];
      const continuation = { ...draft, page: latest.page + 1 };
      if (existingKeys.has(queryRunKey(continuation))
        || !(provider.canRequestPage?.(continuation.page, latest.requestCount) ?? true)) return [];
      return [continuation];
    });
    const untriedBase = base.filter((draft) => !runsByCombination.has(queryCombinationKey(draft)));
    const untriedPlatform = platform.filter((draft) => !runsByCombination.has(queryCombinationKey(draft)));
    const untriedPrimary = interleave(untriedBase, untriedPlatform);
    const advancingPrimary = interleave(continuations, untriedPrimary);
    if (advancingPrimary.length > 0) return advancingPrimary;
    return supplemental.filter((draft) => !runsByCombination.has(queryCombinationKey(draft)));
  }

  private planScheduledWork(
    providerIds: ProviderId[],
    retryFailedProviderIds: ProviderId[],
    plannedLabels: PlannedLabel[],
    searchPlatforms: SearchPlatform[],
    providerById: ReadonlyMap<ProviderId, ImageSearchProvider>,
    existingRuns: QueryRun[]
  ): ScheduledWork[] {
    const requestedExplicitRetryProviders = new Set(retryFailedProviderIds);
    const existingKeys = new Set(existingRuns.map(queryRunKey));
    const queues = new Map<ProviderId, ScheduledWork[]>();
    for (const providerId of providerIds) {
      const providerRuns = existingRuns.filter((run) => run.providerId === providerId);
      const explicitRetries = requestedExplicitRetryProviders.has(providerId)
        ? providerRuns.filter((run) => run.status === "retryable" && run.requiresExplicitRetry)
        : [];
      const resumableRuns = providerRuns.filter((run) => run.status === "paused"
        || (run.status === "retryable" && !run.requiresExplicitRetry));
      const resumedContinuations = resumableRuns.filter((run) => run.page > 1);
      const ordinaryResumable = resumableRuns.filter((run) => run.page <= 1);
      const provider = providerById.get(providerId)!;
      const fresh = this.planFreshRunDraftsForProvider(plannedLabels, providerId, provider, searchPlatforms, existingRuns, existingKeys);
      const freshContinuations = fresh.filter((draft) => (draft.page ?? 1) > 1);
      const freshPageOne = fresh.filter((draft) => (draft.page ?? 1) <= 1);
      const continuationWork = interleave<ScheduledWork>(
        resumedContinuations.map((run) => ({ kind: "existing", run })),
        freshContinuations.map((draft) => ({ kind: "fresh", draft }))
      );
      const ordinaryPageOne = ordinaryResumable.map((run): ScheduledWork => ({ kind: "existing", run }));
      const newPageOne = freshPageOne.map((draft): ScheduledWork => ({ kind: "fresh", draft }));
      const pageOneWork = continuationWork.length > 0
        ? interleave(ordinaryPageOne, newPageOne)
        : interleave(newPageOne, ordinaryPageOne);
      const lowerPriority = interleave(continuationWork, pageOneWork);
      const queue: ScheduledWork[] = [];
      for (let rank = 0; rank < Math.max(explicitRetries.length, lowerPriority.length); rank += 1) {
        const explicit = explicitRetries[rank];
        if (explicit) queue.push({ kind: "existing", run: explicit });
        const lower = lowerPriority[rank];
        if (lower) queue.push(lower);
      }
      queues.set(providerId, queue);
    }
    const scheduled: ScheduledWork[] = [];
    for (let rank = 0; scheduled.length < MAX_SEARCH_RUNS_PER_START; rank += 1) {
      let found = false;
      for (const providerId of providerIds) {
        const entry = queues.get(providerId)?.[rank];
        if (!entry) continue;
        found = true;
        scheduled.push(entry);
        if (scheduled.length >= MAX_SEARCH_RUNS_PER_START) break;
      }
      if (!found) break;
    }
    return scheduled;
  }

  private async execute(
    jobId: string,
    runs: QueryRun[],
    providerById: Map<ProviderId, ImageSearchProvider>,
    candidateLimits: ReadonlyMap<string, number>
  ): Promise<void> {
    const localSettings = this.readSettings();
    const jobPolicy = this.jobs.getSearchPolicy(jobId);
    const safeSearch = localSettings.safeSearch || jobPolicy?.taskType !== "content_moderation" || jobPolicy.allowedRiskCategories.length === 0;
    const scheduledByLabelProvider = new Map<string, number>();
    for (const run of runs) {
      const key = requestAllocationKey(run.labelId, run.providerId);
      scheduledByLabelProvider.set(key, (scheduledByLabelProvider.get(key) ?? 0) + 1);
    }
    const fairRequestCount = new Map<string, number>();
    const currentJob = this.jobs.get(jobId);
    for (const label of currentJob?.labels ?? []) {
      const remaining = Math.max(0, (candidateLimits.get(label.id) ?? 0) - this.searches.candidateCount(jobId, label.id));
      for (const providerId of providerById.keys()) {
        const key = requestAllocationKey(label.id, providerId);
        const scheduled = scheduledByLabelProvider.get(key) ?? 0;
        if (scheduled > 0) fairRequestCount.set(key, Math.max(1, Math.ceil(remaining / scheduled)));
      }
    }
    const runsByProvider = new Map<ProviderId, QueryRun[]>();
    for (const run of runs) {
      const providerRuns = runsByProvider.get(run.providerId) ?? [];
      providerRuns.push(run);
      runsByProvider.set(run.providerId, providerRuns);
    }
    const executeRun = async (run: QueryRun) => {
      const label = this.jobs.get(jobId)?.labels.find((entry) => entry.id === run.labelId);
      const candidateCount = this.searches.candidateCount(jobId, run.labelId);
      const candidateLimit = candidateLimits.get(run.labelId) ?? candidateCount;
      const downloadRecovery = this.searches.runHasRetryableDownloadCandidate(run.id);
      if (!label || label.selectedCount >= label.targetCount) {
        this.searches.completeWithoutSearch(run.id, run.status);
        return;
      }
      if (!downloadRecovery && candidateCount >= candidateLimit) {
        this.searches.deferForNextBatch(run.id, run.status);
        return;
      }
      const provider = providerById.get(run.providerId);
      if (!provider) return;
      const currentJobForRun = this.jobs.get(jobId);
      if (!currentJobForRun || !providerCanSearchLabel(provider, currentJobForRun.taskType, label)
        || (run.page > 1 && this.searches.previousPageExhausted(run))) {
        this.searches.completeWithoutSearch(run.id, run.status);
        return;
      }
      const locale = `${this.providers.queryLanguage(run.providerId)}-${localSettings.defaultCountry}`;
      const providerLimit = Number.isSafeInteger(provider.maxResults) && provider.maxResults > 0 ? provider.maxResults : 1;
      const remaining = candidateLimit - candidateCount;
      const priorCount = run.requestCount ?? (run.page > 1 ? this.searches.previousRequestCount(run) : null);
      const stableCount = priorCount ?? fairRequestCount.get(requestAllocationKey(run.labelId, run.providerId)) ?? 1;
      const count = Math.max(1, Math.min(run.page > 1 || run.requestCount !== null ? stableCount : remaining, stableCount, providerLimit, 200));
      if (provider.canRequestPage && !provider.canRequestPage(run.page, count)) {
        this.searches.completeWithoutSearch(run.id, run.status);
        return;
      }
      let attemptCount = 0;
      let started = false;
      let skipped = false;
      let hits: Awaited<ReturnType<ImageSearchProvider["search"]>>;
      try {
        hits = await executeWithProviderRetry(
          async (attempt) => {
            attemptCount = attempt;
            return this.withProviderSlot(run.providerId, async () => {
              const blockedFailure = this.blockedProviderFailure(run.providerId);
              if (blockedFailure) {
                if (!started) {
                  if (!this.searches.markRunning(run.id, run.status, count)) {
                    skipped = true;
                    return [];
                  }
                  started = true;
                }
                throw blockedFailure;
              }
              await this.paceProviderSearch(run.providerId);
              try {
                return await this.withProviderRequestSlot(() => {
                  if (!started) {
                    if (!this.searches.markRunning(run.id, run.status, count)) {
                      skipped = true;
                      return Promise.resolve([]);
                    }
                    started = true;
                  }
                  return provider.search(
                    { query: run.query, count, locale, safeSearch, page: run.page },
                    AbortSignal.timeout(30_000)
                  );
                });
              } catch (error) {
                this.recordProviderRetryAfter(run.providerId, error);
                throw error;
              }
            });
          },
          this.retryOptions
        );
      } catch (error) {
        if (!started) throw error;
        const summary = providerFailureSummary(error, providerCatalogMetadata(provider).credentialMode);
        const message = `${summary.message.replace(/。$/u, "")}（已尝试 ${attemptCount} 次）。`;
        this.searches.markFinished(run.id, summary.retryable ? "retryable" : "failed", message, summary.retryable);
        return;
      }
      if (skipped) return;
      if (this.assets) {
        for (const hit of hits) {
          if (hit.transientImageUrl) this.assets.registerTransientDownloadUrl(hit.imageUrl, hit.transientImageUrl);
        }
      }
      const candidateIds = this.searches.saveHits(run, hits, candidateLimit);
      this.enqueueMaterialization(candidateIds);
      this.searches.markSearchCompleted(run.id, hits.length);
    };
    const providerResults = await Promise.allSettled([...runsByProvider.values()].map(async (providerRuns) => {
      for (const run of providerRuns) await executeRun(run);
    }));
    const failedProvider = providerResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedProvider) throw failedProvider.reason;
    if (this.searches.allWorkSettled(jobId)) this.jobs.update(jobId, { status: "reviewing" });
  }

  private async withProviderRequestSlot<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.activeProviderRequests < 4) {
      this.activeProviderRequests += 1;
    } else {
      await new Promise<void>((resolve) => { this.providerRequestWaiters.push(resolve); });
    }
    try {
      return await operation();
    } finally {
      const next = this.providerRequestWaiters.shift();
      if (next) next();
      else this.activeProviderRequests -= 1;
    }
  }

  private async withProviderSlot<Value>(providerId: ProviderId, operation: () => Promise<Value>): Promise<Value> {
    const waiting = this.providerWaiters.get(providerId);
    if (waiting) {
      await new Promise<void>((resolve) => { waiting.push(resolve); });
    } else {
      this.providerWaiters.set(providerId, []);
    }
    try {
      return await operation();
    } finally {
      const queue = this.providerWaiters.get(providerId);
      const next = queue?.shift();
      if (next) next();
      else this.providerWaiters.delete(providerId);
    }
  }

  private async paceProviderSearch(providerId: ProviderId): Promise<void> {
    const minimumIntervalMs = Math.max(0, Math.floor(this.providers.searchPolicy(providerId)?.minimumIntervalMs ?? 0));
    const now = this.monotonicNow();
    const startAt = Math.max(now, this.providerNextSearchStartAt.get(providerId) ?? 0);
    this.providerNextSearchStartAt.set(providerId, startAt + minimumIntervalMs);
    if (startAt > now) await this.sleep(startAt - now);
  }

  private recordProviderRetryAfter(providerId: ProviderId, error: unknown): void {
    const disposition = providerRetryAfterDisposition(error, this.retryOptions.maxRetryAfterMs);
    if (disposition.kind === "none" || !(error instanceof ProviderError)) return;
    if (disposition.kind === "blocked") {
      const until = Number.isFinite(disposition.retryAfterMs)
        ? this.monotonicNow() + disposition.retryAfterMs
        : Number.POSITIVE_INFINITY;
      this.providerBlockedUntil.set(providerId, { until, error });
      return;
    }
    const cooldownUntil = this.monotonicNow() + disposition.retryAfterMs;
    const current = this.providerNextSearchStartAt.get(providerId) ?? 0;
    if (cooldownUntil > current) this.providerNextSearchStartAt.set(providerId, cooldownUntil);
  }

  private blockedProviderFailure(providerId: ProviderId): ProviderError | null {
    const blocked = this.providerBlockedUntil.get(providerId);
    if (!blocked) return null;
    if (Number.isFinite(blocked.until) && blocked.until <= this.monotonicNow()) {
      this.providerBlockedUntil.delete(providerId);
      return null;
    }
    return blocked.error;
  }

  private enqueueMaterialization(candidateIds: string[]): void {
    if (!this.assets) return;
    for (const target of this.searches.materializationTargets(candidateIds)) {
      if (this.queuedCandidates.has(target.candidateId)) continue;
      this.queuedCandidates.add(target.candidateId);
      this.materializationQueue.push(target);
    }
    this.drainMaterializationQueue();
  }

  private drainMaterializationQueue(): void {
    while (this.assets && this.materializing.size < 4 && this.materializationQueue.length > 0) {
      const targetIndex = this.materializationQueue.findIndex((target) => {
        const maximum = this.providers.downloadPolicy(target.providerId)?.maxConcurrency ?? 4;
        return (this.activeProviderMaterializations.get(target.providerId) ?? 0) < maximum;
      });
      if (targetIndex < 0) return;
      const target = this.materializationQueue.splice(targetIndex, 1)[0]!;
      this.activeProviderMaterializations.set(target.providerId, (this.activeProviderMaterializations.get(target.providerId) ?? 0) + 1);
      let task!: Promise<void>;
      task = this.assets.materializeCandidate(target.candidateId).finally(() => {
        this.materializing.delete(task);
        this.queuedCandidates.delete(target.candidateId);
        const shouldRequeue = this.pendingMaterializationRequeues.delete(target.candidateId);
        const active = (this.activeProviderMaterializations.get(target.providerId) ?? 1) - 1;
        if (active > 0) this.activeProviderMaterializations.set(target.providerId, active);
        else this.activeProviderMaterializations.delete(target.providerId);
        if (shouldRequeue) this.enqueueMaterialization([target.candidateId]);
        else this.drainMaterializationQueue();
      });
      this.materializing.add(task);
    }
  }
}
