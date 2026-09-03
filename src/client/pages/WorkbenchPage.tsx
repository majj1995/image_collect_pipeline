import Check from "lucide-react/dist/esm/icons/check.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import FolderTree from "lucide-react/dist/esm/icons/folder-tree.mjs";
import Pause from "lucide-react/dist/esm/icons/pause.mjs";
import Play from "lucide-react/dist/esm/icons/play.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { Candidate, ProviderId, ProviderRunSummary, ProviderStatus, ReviewInput } from "../../shared/contracts.js";
import { sanitizePublicHttpUrl } from "../../shared/public-url.js";
import { ApiError, useApi, type JobDetail } from "../api.js";
import { CandidateDrawer } from "../features/workbench/CandidateDrawer.js";
import { CandidateGrid } from "../features/workbench/CandidateGrid.js";
import { ExportDialog } from "../features/workbench/ExportDialog.js";
import { LabelQueue } from "../features/workbench/LabelQueue.js";
import { ProviderPicker } from "../features/workbench/ProviderPicker.js";
import { useModalFocus } from "../features/workbench/useModalFocus.js";

interface WorkbenchLifecycle { jobId: string; generation: number; }
interface PendingReview {
  id: number;
  patches: Record<string, Partial<Candidate>>;
  reconciliation?: WorkbenchLifecycle & { version: number };
}
interface CandidateLoadOptions { forceReconciliation?: boolean; lifecycle?: WorkbenchLifecycle; }
interface ReconciliationRequirement { version: number; candidateIds: Set<string>; }
interface ReconciliationLoop {
  lifecycle: WorkbenchLifecycle;
  timer: ReturnType<typeof setTimeout> | null;
  waitingForQueue: boolean;
  inFlight: boolean;
}
interface ContinuationRound {
  lifecycle: WorkbenchLifecycle;
  sequence: number;
  baselineCandidateIds: Set<string>;
}

const RECONCILIATION_RETRY_DELAY_MS = 1200;
const RECONCILIATION_RETRY_ERROR = "审核状态重新同步失败，请稍后重试。";
const SEARCH_EXHAUSTED_NOTICE = "当前已选来源和查询条件已无更多结果，请增加搜索来源或调整查询条件。";
const SEARCH_ZERO_ADDITION_NOTICE = "本轮未新增素材；已选来源或查询可能已耗尽，请增加来源或调整条件。";
const POLLING_INTERVAL_MS = 1200;
const MAX_POLLING_RETRY_DELAY_MS = 9600;
const PROVIDER_SELECTION_STORAGE_PREFIX = "material-expansion:provider-selection:v1";
const legacyProviderDisplayNames: Partial<Record<ProviderId, string>> = {
  brave: "Brave",
  serpapi: "SerpApi",
  dataforseo: "DataForSEO",
  fake: "测试提供方"
};

function providerSelectionStorageKey(jobId: string): string {
  return `${PROVIDER_SELECTION_STORAGE_PREFIX}:${encodeURIComponent(jobId)}`;
}

function readPersistedProviderSelection(jobId: string, providerSettings: ProviderStatus[]): ProviderId[] | null {
  try {
    const raw = window.localStorage.getItem(providerSelectionStorageKey(jobId));
    if (raw === null) return null;
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored) || !stored.every((id) => typeof id === "string")) return null;
    const enabledIds = new Set(providerSettings.filter((provider) => provider.enabled).map((provider) => provider.id));
    const restored = [...new Set(stored.filter((id): id is ProviderId => enabledIds.has(id as ProviderId)))];
    return stored.length > 0 && restored.length === 0 ? null : restored;
  } catch {
    return null;
  }
}

function persistProviderSelection(jobId: string, providerIds: ProviderId[]): void {
  try {
    window.localStorage.setItem(providerSelectionStorageKey(jobId), JSON.stringify(providerIds));
  } catch {
    // The workbench remains usable when browser storage is unavailable or full.
  }
}

function isSelectable(candidate: Candidate): boolean {
  return candidate.pipelineState === "processed" && Boolean(candidate.assetId);
}

function isVisibleInReviewQueue(candidate: Candidate): boolean {
  return candidate.pipelineError !== "RETRYABLE_DOWNLOAD";
}

function candidateNeedsAutomaticRefresh(candidate: Candidate): boolean {
  if (candidate.reviewState === "rejected") return false;
  if (candidate.pipelineState === "fetching") return true;
  if (candidate.pipelineState !== "discovered") return false;
  return candidate.pipelineError == null
    || candidate.pipelineError === "CACHE_REBUILD_REQUIRED"
    || candidate.pipelineError === "DOWNLOAD_INTERRUPTED";
}

function statePatch(input: ReviewInput, candidateId: string): Partial<Candidate> {
  if (input.action === "keep_highest_resolution") {
    return candidateId === input.primaryCandidateId
      ? { reviewState: "selected", labelIds: input.labelIds, primaryLabelId: input.primaryLabelId ?? null }
      : { reviewState: "rejected" };
  }
  if (input.action === "select") return { reviewState: "selected", labelIds: input.labelIds, primaryLabelId: input.primaryLabelId ?? null };
  if (input.action === "reject") return { reviewState: "rejected" };
  if (input.action === "restore") return { reviewState: "unreviewed" };
  if (input.action === "move_label" || input.action === "set_labels") return { labelIds: input.labelIds, primaryLabelId: input.primaryLabelId ?? null };
  if (input.action === "acknowledge_rights") return { rightsAcknowledged: input.rightsAcknowledged ?? true };
  if (input.action === "set_rights_evidence") return { rightsBasis: input.rightsBasis ?? "unknown", rightsEvidence: input.rightsEvidence ?? null };
  return {};
}

export function WorkbenchPage() {
  const { jobId = "" } = useParams();
  const api = useApi();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [providerRuns, setProviderRuns] = useState<ProviderRunSummary[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [selectedProviderIds, setSelectedProviderIds] = useState<ProviderId[]>([]);
  const [activeLabelId, setActiveLabelId] = useState("");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [openCandidateId, setOpenCandidateId] = useState<string | null>(null);
  const [revealedSensitiveIds, setRevealedSensitiveIds] = useState<Set<string>>(() => new Set());
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [rightsFilter, setRightsFilter] = useState("all");
  const [sizeFilter, setSizeFilter] = useState("all");
  const [formatFilter, setFormatFilter] = useState("all");
  const [ratioFilter, setRatioFilter] = useState("all");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [labelQueueOpen, setLabelQueueOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [searchRequested, setSearchRequested] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingReviews, setPendingReviews] = useState<PendingReview[]>([]);
  const lastReviewAnchorRef = useRef<{ jobId: string; candidateId: string } | null>(null);
  const nextReviewIdRef = useRef(0);
  const reviewQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mutationVersionRef = useRef(0);
  const lifecycleRef = useRef({ mounted: false, jobId, generation: 0 });
  const latestCandidateLoadRef = useRef(new Map<number, number>());
  const reconciliationRequiredRef = useRef(new Map<number, ReconciliationRequirement>());
  const reconciliationLoopRef = useRef<ReconciliationLoop | null>(null);
  const reconciliationRunnerRef = useRef<(lifecycle: WorkbenchLifecycle) => Promise<void>>(async () => undefined);
  const searchStartInFlightRef = useRef(false);
  const searchStartSequenceRef = useRef(0);
  const continuationRoundRef = useRef<ContinuationRound | null>(null);
  const mobileLabelDialogRef = useRef<HTMLDivElement>(null);
  const mobileLabelCloseRef = useRef<HTMLButtonElement>(null);
  useModalFocus(labelQueueOpen, () => setLabelQueueOpen(false), mobileLabelDialogRef, mobileLabelCloseRef);

  const cancelReconciliationLoop = useCallback((generation: number) => {
    const loop = reconciliationLoopRef.current;
    if (!loop || loop.lifecycle.generation !== generation) return;
    if (loop.timer) clearTimeout(loop.timer);
    reconciliationLoopRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const generation = lifecycleRef.current.generation + 1;
    lifecycleRef.current = { mounted: true, jobId, generation };
    return () => {
      const current = lifecycleRef.current;
      if (current.jobId === jobId && current.generation === generation) {
        lifecycleRef.current = { ...current, mounted: false };
      }
      cancelReconciliationLoop(generation);
      latestCandidateLoadRef.current.delete(generation);
      reconciliationRequiredRef.current.delete(generation);
      const continuationRound = continuationRoundRef.current;
      if (continuationRound?.lifecycle.generation === generation) continuationRoundRef.current = null;
    };
  }, [cancelReconciliationLoop, jobId]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktopQuery = window.matchMedia("(min-width: 900px)");
    const closeMobileQueue = (event: MediaQueryListEvent) => {
      if (event.matches) setLabelQueueOpen(false);
    };
    if (desktopQuery.matches) setLabelQueueOpen(false);
    desktopQuery.addEventListener("change", closeMobileQueue);
    return () => { desktopQuery.removeEventListener("change", closeMobileQueue); };
  }, []);

  const isCurrentLifecycle = useCallback((lifecycle: WorkbenchLifecycle): boolean => {
    const current = lifecycleRef.current;
    return current.mounted && current.jobId === lifecycle.jobId && current.generation === lifecycle.generation;
  }, []);

  const scheduleReconciliation = useCallback((lifecycle: WorkbenchLifecycle) => {
    if (!isCurrentLifecycle(lifecycle) || !reconciliationRequiredRef.current.has(lifecycle.generation)) return;
    let loop = reconciliationLoopRef.current;
    if (loop && (loop.lifecycle.jobId !== lifecycle.jobId || loop.lifecycle.generation !== lifecycle.generation)) {
      if (loop.timer) clearTimeout(loop.timer);
      reconciliationLoopRef.current = null;
      loop = null;
    }
    if (!loop) {
      loop = { lifecycle, timer: null, waitingForQueue: false, inFlight: false };
      reconciliationLoopRef.current = loop;
    }
    if (loop.timer || loop.waitingForQueue || loop.inFlight) return;
    loop.timer = setTimeout(() => {
      const currentLoop = reconciliationLoopRef.current;
      if (currentLoop !== loop) return;
      currentLoop.timer = null;
      if (!isCurrentLifecycle(lifecycle) || !reconciliationRequiredRef.current.has(lifecycle.generation)) {
        reconciliationLoopRef.current = null;
        return;
      }
      currentLoop.waitingForQueue = true;
      const queuedMutations = reviewQueueRef.current;
      const run = () => reconciliationRunnerRef.current(lifecycle);
      void queuedMutations.then(run, run).catch(() => undefined);
    }, RECONCILIATION_RETRY_DELAY_MS);
  }, [isCurrentLifecycle]);

  const loadCandidates = useCallback(async (options: CandidateLoadOptions = {}): Promise<boolean> => {
    const lifecycle = options.lifecycle ?? { jobId, generation: lifecycleRef.current.generation };
    if (!isCurrentLifecycle(lifecycle)) return false;
    const requestId = (latestCandidateLoadRef.current.get(lifecycle.generation) ?? 0) + 1;
    latestCandidateLoadRef.current.set(lifecycle.generation, requestId);
    const reconciliationVersion = reconciliationRequiredRef.current.get(lifecycle.generation)?.version ?? null;
    const mutationVersion = mutationVersionRef.current;
    const items: Candidate[] = [];
    let cursor: number | undefined;
    let runs: ProviderRunSummary[] = [];
    do {
      let page: Awaited<ReturnType<typeof api.listCandidates>>;
      try {
        page = await api.listCandidates(lifecycle.jobId, cursor);
      } catch (reason) {
        if (!isCurrentLifecycle(lifecycle) || latestCandidateLoadRef.current.get(lifecycle.generation) !== requestId) return false;
        if (reconciliationRequiredRef.current.has(lifecycle.generation)) scheduleReconciliation(lifecycle);
        throw reason;
      }
      if (!isCurrentLifecycle(lifecycle)) return false;
      if (latestCandidateLoadRef.current.get(lifecycle.generation) !== requestId) {
        if (reconciliationRequiredRef.current.has(lifecycle.generation)) scheduleReconciliation(lifecycle);
        return false;
      }
      items.push(...page.items);
      runs = page.providerRuns;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const active = runs.some((run) => run.status === "pending" || run.status === "running")
      || items.some(candidateNeedsAutomaticRefresh);
    if (isCurrentLifecycle(lifecycle) && latestCandidateLoadRef.current.get(lifecycle.generation) === requestId) {
      const hiddenReviewItems = items.filter((candidate) => !isVisibleInReviewQueue(candidate));
      const hiddenReviewIds = new Set(hiddenReviewItems.map((candidate) => candidate.id));
      const clearHiddenReviewState = () => {
        if (!hiddenReviewIds.size) return;
        setCheckedIds((prior) => {
          if (![...prior].some((candidateId) => hiddenReviewIds.has(candidateId))) return prior;
          return new Set([...prior].filter((candidateId) => !hiddenReviewIds.has(candidateId)));
        });
        setOpenCandidateId((prior) => prior !== null && hiddenReviewIds.has(prior) ? null : prior);
      };
      if (mutationVersion === mutationVersionRef.current) {
        setCandidates(items);
        clearHiddenReviewState();
        if (reconciliationVersion !== null) {
          const requiredVersion = reconciliationRequiredRef.current.get(lifecycle.generation);
          if (requiredVersion !== undefined && requiredVersion.version <= reconciliationVersion) {
            reconciliationRequiredRef.current.delete(lifecycle.generation);
            cancelReconciliationLoop(lifecycle.generation);
          }
          setPendingReviews((prior) => prior.filter((review) =>
            review.reconciliation?.generation !== lifecycle.generation || review.reconciliation.version > reconciliationVersion
          ));
          setError((prior) => prior === RECONCILIATION_RETRY_ERROR ? null : prior);
        }
        setProviderRuns(runs);
        if (!active) {
          if (!searchStartInFlightRef.current) setSearchRequested(false);
          const continuationRound = continuationRoundRef.current;
          if (continuationRound
            && continuationRound.lifecycle.jobId === lifecycle.jobId
            && continuationRound.lifecycle.generation === lifecycle.generation
            && continuationRound.sequence === searchStartSequenceRef.current) {
            continuationRoundRef.current = null;
            if (!items.some((candidate) => isVisibleInReviewQueue(candidate) && !continuationRound.baselineCandidateIds.has(candidate.id))) {
              setNotice(SEARCH_ZERO_ADDITION_NOTICE);
            }
          }
        }
        return active;
      }
      if (hiddenReviewItems.length) {
        const hiddenById = new Map(hiddenReviewItems.map((candidate) => [candidate.id, candidate]));
        setCandidates((prior) => prior.map((candidate) => {
          const hidden = hiddenById.get(candidate.id);
          if (!hidden) return candidate;
          return {
            ...candidate,
            pipelineState: hidden.pipelineState,
            pipelineError: hidden.pipelineError,
            pipelineFailureCode: hidden.pipelineFailureCode,
            assetId: hidden.assetId
          };
        }));
        clearHiddenReviewState();
      }
      if (reconciliationRequiredRef.current.has(lifecycle.generation)) scheduleReconciliation(lifecycle);
      return true;
    }
    return active;
  }, [api, cancelReconciliationLoop, isCurrentLifecycle, jobId, scheduleReconciliation]);

  useEffect(() => {
    reconciliationRunnerRef.current = async (lifecycle) => {
      const loop = reconciliationLoopRef.current;
      if (!loop || loop.lifecycle.jobId !== lifecycle.jobId || loop.lifecycle.generation !== lifecycle.generation) return;
      loop.waitingForQueue = false;
      if (!isCurrentLifecycle(lifecycle) || !reconciliationRequiredRef.current.has(lifecycle.generation)) {
        cancelReconciliationLoop(lifecycle.generation);
        return;
      }
      loop.inFlight = true;
      try {
        await loadCandidates({ forceReconciliation: true, lifecycle });
      } catch {
        if (isCurrentLifecycle(lifecycle)) setError(RECONCILIATION_RETRY_ERROR);
      } finally {
        const currentLoop = reconciliationLoopRef.current;
        if (currentLoop === loop) currentLoop.inFlight = false;
        if (isCurrentLifecycle(lifecycle) && reconciliationRequiredRef.current.has(lifecycle.generation)) {
          scheduleReconciliation(lifecycle);
        } else {
          cancelReconciliationLoop(lifecycle.generation);
        }
      }
    };
  }, [cancelReconciliationLoop, isCurrentLifecycle, loadCandidates, scheduleReconciliation]);

  useEffect(() => {
    const lifecycle = { jobId, generation: lifecycleRef.current.generation };
    if (!isCurrentLifecycle(lifecycle)) return;
    mutationVersionRef.current += 1;
    reviewQueueRef.current = Promise.resolve();
    lastReviewAnchorRef.current = null;
    setPendingReviews([]);
    setJob(null); setCandidates([]); setProviderRuns([]); setProviders([]); setSelectedProviderIds([]);
    setActiveLabelId(""); setCheckedIds(new Set()); setOpenCandidateId(null); setRevealedSensitiveIds(new Set());
    setLabelQueueOpen(false); setExportOpen(false);
    searchStartSequenceRef.current += 1;
    searchStartInFlightRef.current = false;
    continuationRoundRef.current = null;
    setSearchRequested(false); setLoading(true); setError(null); setNotice(null);
    void Promise.all([api.getJob(jobId), api.listProviders(), loadCandidates({ lifecycle })]).then(
      ([nextJob, providers]) => {
        if (!isCurrentLifecycle(lifecycle)) return;
        setJob(nextJob);
        setActiveLabelId(nextJob.labels[0]?.id || "");
        setProviders(providers.items);
        const enabledProviders = providers.items.filter((provider) => provider.enabled);
        const defaults = enabledProviders.filter((provider) => provider.defaultSelected);
        const persistedSelection = readPersistedProviderSelection(jobId, providers.items);
        setSelectedProviderIds(persistedSelection ?? (defaults.length ? defaults : enabledProviders).map((provider) => provider.id));
        setLoading(false);
      },
      (reason: unknown) => {
        if (!isCurrentLifecycle(lifecycle)) return;
        setError(reason instanceof ApiError ? reason.message : "无法打开素材工作台。" ); setLoading(false);
      }
    );
  }, [api, isCurrentLifecycle, jobId, loadCandidates]);

  const hasActiveRuns = searchRequested || providerRuns.some((run) => run.status === "pending" || run.status === "running");
  const changeSelectedProviders = useCallback((nextIds: ProviderId[]) => {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle.mounted || lifecycle.jobId !== jobId || job?.id !== jobId) return;
    const requestedIds = new Set(nextIds);
    const validIds = providers
      .filter((provider) => provider.enabled && requestedIds.has(provider.id))
      .map((provider) => provider.id);
    setSelectedProviderIds(validIds);
    persistProviderSelection(jobId, validIds);
  }, [job?.id, jobId, providers]);
  const shouldPoll = hasActiveRuns || candidates.some(candidateNeedsAutomaticRefresh);
  const providerFailures = useMemo(() => {
    const groups = new Map<ProviderRunSummary["providerId"], ProviderRunSummary[]>();
    for (const run of providerRuns) {
      if (run.status !== "failed" && run.status !== "retryable") continue;
      const current = groups.get(run.providerId) ?? [];
      current.push(run);
      groups.set(run.providerId, current);
    }
    return [...groups].map(([providerId, runs]) => ({ providerId, runs }));
  }, [providerRuns]);
  useEffect(() => {
    if (!shouldPoll || pendingReviews.length > 0) return;
    const lifecycle = { jobId, generation: lifecycleRef.current.generation };
    if (!isCurrentLifecycle(lifecycle)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;
    let pollingError: string | null = null;
    const scheduleTick = (delay: number) => {
      if (!active || !isCurrentLifecycle(lifecycle)) return;
      timer = setTimeout(() => { timer = undefined; void tick(); }, delay);
    };
    const tick = async () => {
      try {
        const stillActive = await loadCandidates({ lifecycle });
        if (!active || !isCurrentLifecycle(lifecycle)) return;
        if (pollingError) {
          const recoveredError = pollingError;
          pollingError = null;
          setError((prior) => prior === recoveredError ? null : prior);
        }
        consecutiveFailures = 0;
        if (stillActive || searchStartInFlightRef.current) scheduleTick(POLLING_INTERVAL_MS);
      } catch (reason) {
        if (!active || !isCurrentLifecycle(lifecycle)) return;
        pollingError = reason instanceof ApiError ? reason.message : "候选素材刷新失败。";
        setError(pollingError);
        consecutiveFailures = Math.min(consecutiveFailures + 1, 3);
        scheduleTick(Math.min(POLLING_INTERVAL_MS * 2 ** consecutiveFailures, MAX_POLLING_RETRY_DELAY_MS));
      }
    };
    scheduleTick(POLLING_INTERVAL_MS);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [isCurrentLifecycle, jobId, loadCandidates, pendingReviews.length, shouldPoll]);

  const effectiveCandidates = useMemo(() => {
    if (!pendingReviews.length) return candidates;
    return candidates.map((candidate) => {
      let current = candidate;
      for (const review of pendingReviews) {
        const patch = review.patches[candidate.id];
        if (patch) current = { ...current, ...patch };
      }
      return current;
    });
  }, [candidates, pendingReviews]);
  const reviewCandidates = useMemo(() => effectiveCandidates.filter(isVisibleInReviewQueue), [effectiveCandidates]);

  const candidateCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const candidate of reviewCandidates) for (const labelId of candidate.discoveryLabelIds ?? []) counts.set(labelId, (counts.get(labelId) ?? 0) + 1);
    return counts;
  }, [reviewCandidates]);
  const selectedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!job) return counts;
    for (const candidate of effectiveCandidates) {
      if (candidate.reviewState !== "selected") continue;
      const labelIds = job.taskType === "advertiser_product_taxonomy" ? [candidate.primaryLabelId].filter((value): value is string => Boolean(value)) : candidate.labelIds ?? [];
      for (const labelId of labelIds) counts.set(labelId, (counts.get(labelId) ?? 0) + 1);
    }
    return counts;
  }, [effectiveCandidates, job]);

  const filteredCandidates = useMemo(() => reviewCandidates.filter((candidate) => {
    if (activeLabelId && !(candidate.discoveryLabelIds ?? []).includes(activeLabelId)) return false;
    if (onlyUnreviewed && (candidate.reviewState ?? "unreviewed") !== "unreviewed") return false;
    if (sourceFilter !== "all" && candidate.provider !== sourceFilter && !candidate.provenance.some((entry) => entry.provider === sourceFilter)) return false;
    if (rightsFilter !== "all" && (candidate.rightsStatus ?? "unknown") !== rightsFilter) return false;
    if (formatFilter !== "all" && candidate.mimeType !== formatFilter) return false;
    if (sizeFilter === "large" && Math.min(candidate.width ?? 0, candidate.height ?? 0) < 1200) return false;
    if (sizeFilter === "warning" && Math.min(candidate.width ?? Number.POSITIVE_INFINITY, candidate.height ?? Number.POSITIVE_INFINITY) >= 512) return false;
    if (ratioFilter !== "all" && candidate.width && candidate.height) {
      const ratio = candidate.width / candidate.height;
      if (ratioFilter === "square" && (ratio < 0.9 || ratio > 1.1)) return false;
      if (ratioFilter === "landscape" && ratio <= 1.1) return false;
      if (ratioFilter === "portrait" && ratio >= 0.9) return false;
    }
    if (onlyProblems && candidate.pipelineState !== "invalid" && candidate.pipelineState !== "quarantined" && candidate.pipelineError !== "RETRYABLE_DOWNLOAD" && !(candidate.warnings?.length)) return false;
    return true;
  }), [activeLabelId, formatFilter, onlyProblems, onlyUnreviewed, ratioFilter, reviewCandidates, rightsFilter, sizeFilter, sourceFilter]);

  const keyboardCandidates = useMemo(() => {
    const seenGroups = new Set<string>();
    return filteredCandidates.filter((candidate) => {
      if (!candidate.nearDuplicateGroup) return true;
      if (seenGroups.has(candidate.nearDuplicateGroup)) return false;
      seenGroups.add(candidate.nearDuplicateGroup);
      return true;
    });
  }, [filteredCandidates]);
  const hasCheckedCandidates = useMemo(
    () => filteredCandidates.some((candidate) => checkedIds.has(candidate.id)),
    [checkedIds, filteredCandidates]
  );

  const resolveAuthoritativeCandidates = useCallback((
    lifecycle: WorkbenchLifecycle,
    throughReviewId: number,
    candidateIds: string[]
  ) => {
    if (!isCurrentLifecycle(lifecycle) || !candidateIds.length) return;
    const resolved = new Set(candidateIds);
    const requirement = reconciliationRequiredRef.current.get(lifecycle.generation);
    if (requirement) {
      for (const candidateId of resolved) requirement.candidateIds.delete(candidateId);
      if (!requirement.candidateIds.size) {
        reconciliationRequiredRef.current.delete(lifecycle.generation);
        cancelReconciliationLoop(lifecycle.generation);
        setError((prior) => prior === RECONCILIATION_RETRY_ERROR ? null : prior);
      }
    }
    setPendingReviews((prior) => prior.flatMap((review) => {
      if (review.id > throughReviewId) return [review];
      const patches = Object.fromEntries(Object.entries(review.patches).filter(([candidateId]) => !resolved.has(candidateId)));
      return Object.keys(patches).length ? [{ ...review, patches }] : [];
    }));
  }, [cancelReconciliationLoop, isCurrentLifecycle]);

  const applyReview = useCallback(async (input: ReviewInput) => {
    const lifecycle = { jobId, generation: lifecycleRef.current.generation };
    if (!isCurrentLifecycle(lifecycle)) return;
    const id = ++nextReviewIdRef.current;
    const ids = [...new Set(input.candidateIds)];
    const patches = Object.fromEntries(ids.map((candidateId) => [candidateId, statePatch(input, candidateId)]));
    mutationVersionRef.current += 1;
    setError(null); setNotice(null);
    setPendingReviews((prior) => [...prior, { id, patches }]);

    const execute = async () => {
      if (!isCurrentLifecycle(lifecycle)) return;
      let failure: unknown;
      let requiresReconciliation = false;
      let unresolvedIds = ids;
      try {
        const response = await api.review(lifecycle.jobId, input);
        if (!isCurrentLifecycle(lifecycle)) return;
        const byId = new Map(response.items.map((item) => [item.candidateId, item]));
        const authoritativeIds = ids.filter((candidateId) => byId.has(candidateId));
        unresolvedIds = ids.filter((candidateId) => !byId.has(candidateId));
        const complete = unresolvedIds.length === 0;
        if (response.items.length) {
          setCandidates((prior) => prior.map((candidate) => {
            const saved = byId.get(candidate.id);
            if (!saved) return candidate;
            const { candidateId: _candidateId, ...state } = saved;
            return { ...candidate, ...state };
          }));
        }
        resolveAuthoritativeCandidates(lifecycle, id, authoritativeIds);
        if (!complete) {
          requiresReconciliation = true;
          setError("审核响应不完整，已重新同步服务器状态。");
        }
      } catch (reason) {
        if (!isCurrentLifecycle(lifecycle)) return;
        failure = reason;
        requiresReconciliation = true;
        setError("审核结果未保存，已从服务器重新同步。");
      }

      if (!isCurrentLifecycle(lifecycle)) return;
      mutationVersionRef.current += 1;
      if (requiresReconciliation) {
        const priorRequirement = reconciliationRequiredRef.current.get(lifecycle.generation);
        const version = (priorRequirement?.version ?? 0) + 1;
        reconciliationRequiredRef.current.set(lifecycle.generation, {
          version,
          candidateIds: new Set([...(priorRequirement?.candidateIds ?? []), ...unresolvedIds])
        });
        const unresolved = new Set(unresolvedIds);
        setPendingReviews((prior) => prior.map((review) => review.id === id
          ? {
              ...review,
              patches: Object.fromEntries(Object.entries(review.patches).filter(([candidateId]) => unresolved.has(candidateId))),
              reconciliation: { ...lifecycle, version }
            }
          : review));
        try { await loadCandidates({ forceReconciliation: true, lifecycle }); }
        catch {
          if (isCurrentLifecycle(lifecycle)) {
            setError(RECONCILIATION_RETRY_ERROR);
            scheduleReconciliation(lifecycle);
          }
        }
      }
      if (!isCurrentLifecycle(lifecycle)) return;
      if (reconciliationRequiredRef.current.has(lifecycle.generation)) scheduleReconciliation(lifecycle);
      if (failure) throw new Error("REVIEW_FAILED");
    };

    const queued = reviewQueueRef.current.then(execute, execute);
    reviewQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [api, isCurrentLifecycle, jobId, loadCandidates, resolveAuthoritativeCandidates, scheduleReconciliation]);

  const selectionInput = useCallback((candidate: Candidate, labelId = activeLabelId): ReviewInput => {
    if (job?.taskType === "content_moderation") {
      const labelIds = [...new Set([...(candidate.labelIds ?? []), labelId])].sort();
      return { candidateIds: [candidate.id], action: "select", labelIds, primaryLabelId: candidate.primaryLabelId ?? labelId };
    }
    return { candidateIds: [candidate.id], action: "select", labelIds: [labelId], primaryLabelId: labelId };
  }, [activeLabelId, job?.taskType]);

  const applySelectionReviews = useCallback((targets: Candidate[]): Promise<void> => {
    const grouped = new Map<string, ReviewInput>();
    for (const candidate of targets) {
      const selection = selectionInput(candidate);
      const labelIds = [...(selection.labelIds ?? [])].sort();
      const primaryLabelId = selection.primaryLabelId ?? null;
      const key = JSON.stringify([labelIds, primaryLabelId]);
      const prior = grouped.get(key);
      if (prior) prior.candidateIds.push(candidate.id);
      else {
        const input: ReviewInput = { candidateIds: [candidate.id], action: "select", labelIds };
        if (primaryLabelId) input.primaryLabelId = primaryLabelId;
        grouped.set(key, input);
      }
    }
    return Promise.all([...grouped.values()].map((input) => applyReview(input))).then(() => undefined);
  }, [applyReview, selectionInput]);

  const reviewFromCard = useCallback((candidateId: string, shiftKey: boolean, action: "select" | "reject") => {
    const index = filteredCandidates.findIndex((candidate) => candidate.id === candidateId);
    if (index < 0) return;
    let targets = [filteredCandidates[index]!].filter(Boolean);
    const anchor = lastReviewAnchorRef.current;
    const anchorIndex = anchor?.jobId === jobId
      ? filteredCandidates.findIndex((candidate) => candidate.id === anchor.candidateId)
      : -1;
    if (shiftKey && anchorIndex >= 0) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      targets = filteredCandidates.slice(start, end + 1);
    }
    lastReviewAnchorRef.current = { jobId, candidateId };
    if (action === "select") targets = targets.filter(isSelectable);
    if (!targets.length) return;
    if (action === "select") void applySelectionReviews(targets).catch(() => undefined);
    else void applyReview({ candidateIds: targets.map((candidate) => candidate.id), action: "reject" }).catch(() => undefined);
  }, [applyReview, applySelectionReviews, filteredCandidates, jobId]);

  const batchReview = (action: "select" | "reject") => {
    const lifecycle = { jobId, generation: lifecycleRef.current.generation };
    if (!isCurrentLifecycle(lifecycle)) return;
    const checked = filteredCandidates.filter((candidate) => checkedIds.has(candidate.id));
    const targets = action === "select" ? checked.filter(isSelectable) : checked;
    if (!targets.length) {
      if (action === "select" && checked.length) setNotice("所勾选素材尚未完成本地处理，无法选择。");
      return;
    }
    setNotice(null);
    const request = action === "select"
      ? applySelectionReviews(targets)
      : applyReview({ candidateIds: targets.map((candidate) => candidate.id), action: "reject" });
    void request.then(() => {
      if (isCurrentLifecycle(lifecycle)) setCheckedIds(new Set());
    }, () => undefined);
  };

  const keepHighestResolution = (groupId: string) => {
    const group = reviewCandidates.filter((candidate) => candidate.nearDuplicateGroup === groupId);
    const eligible = group.filter(isSelectable).sort((left, right) => {
      const difference = (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0);
      return difference || left.id.localeCompare(right.id);
    });
    const keep = eligible[0];
    if (!keep) { setError("重复组中没有可选择的已处理素材。"); return; }
    const selection = selectionInput(keep);
    void applyReview({
      candidateIds: group.map((candidate) => candidate.id).sort(), action: "keep_highest_resolution", primaryCandidateId: keep.id,
      labelIds: selection.labelIds, primaryLabelId: selection.primaryLabelId
    }).catch(() => undefined);
  };

  const moveLabel = (candidateId: string, labelId: string) => {
    const candidate = effectiveCandidates.find((item) => item.id === candidateId);
    if (!candidate || !labelId) return;
    void applyReview({ candidateIds: [candidateId], action: "move_label", labelIds: [labelId], primaryLabelId: labelId }).catch(() => undefined);
  };

  const setModerationLabels = (candidateId: string, labelIds: string[], primaryLabelId: string) => {
    if (!labelIds.length || !labelIds.includes(primaryLabelId)) return;
    void applyReview({ candidateIds: [candidateId], action: "set_labels", labelIds, primaryLabelId }).catch(() => undefined);
  };

  const setRightsEvidence = (candidateId: string, rightsBasis: NonNullable<Candidate["rightsBasis"]>, rightsEvidence: string | null) => {
    void applyReview({ candidateIds: [candidateId], action: "set_rights_evidence", rightsBasis, rightsEvidence }).catch(() => undefined);
  };

  const setSensitiveRevealed = useCallback((candidateId: string, revealed: boolean) => {
    setRevealedSensitiveIds((prior) => {
      const next = new Set(prior);
      if (revealed) next.add(candidateId); else next.delete(candidateId);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target;
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) return;
      if (exportOpen || labelQueueOpen || (element instanceof Element && element.closest('[role="dialog"]'))) return;
      if (event.key === "Escape") { setOpenCandidateId(null); setLabelQueueOpen(false); return; }
      const key = event.key.toLowerCase();
      const currentIndex = Math.max(0, keyboardCandidates.findIndex((candidate) => candidate.id === openCandidateId));
      const current = keyboardCandidates[currentIndex];
      if (!current) return;
      if (key === "j" || key === "k") {
        event.preventDefault();
        const direction = key === "j" ? 1 : -1;
        const next = keyboardCandidates[Math.min(keyboardCandidates.length - 1, Math.max(0, currentIndex + direction))];
        if (next) setOpenCandidateId(next.id);
      } else if (key === "s" || key === "r") {
        event.preventDefault();
        reviewFromCard(current.id, false, key === "s" ? "select" : "reject");
      } else if (key === "o") {
        const url = sanitizePublicHttpUrl(current.landingPageUrl);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [exportOpen, keyboardCandidates, labelQueueOpen, openCandidateId, reviewFromCard]);

  const continueSearch = async () => {
    const lifecycle = { jobId, generation: lifecycleRef.current.generation };
    if (!isCurrentLifecycle(lifecycle)) return;
    if (searchStartInFlightRef.current) return;
    if (!selectedProviderIds.length) { setError("请先选择至少一个可用的搜索来源。"); return; }
    const baselineCandidateIds = new Set(candidates.filter(isVisibleInReviewQueue).map((candidate) => candidate.id));
    continuationRoundRef.current = null;
    const sequence = ++searchStartSequenceRef.current;
    searchStartInFlightRef.current = true;
    setSearchRequested(true);
    setError(null); setNotice(null);
    let started = false;
    try {
      const result = await api.startSearch(lifecycle.jobId, { providerIds: selectedProviderIds, retryFailedProviderIds: [] });
      if (result.status === "exhausted") {
        if (isCurrentLifecycle(lifecycle) && searchStartSequenceRef.current === sequence) {
          continuationRoundRef.current = null;
          setSearchRequested(false);
          setNotice(SEARCH_EXHAUSTED_NOTICE);
        }
        return;
      }
      if (isCurrentLifecycle(lifecycle) && searchStartSequenceRef.current === sequence) {
        continuationRoundRef.current = { lifecycle, sequence, baselineCandidateIds };
      }
      started = true;
    } catch (reason) {
      if (isCurrentLifecycle(lifecycle) && searchStartSequenceRef.current === sequence) {
        continuationRoundRef.current = null;
        setSearchRequested(false);
        setError(reason instanceof ApiError ? reason.message : "无法继续搜索。" );
      }
    } finally {
      if (isCurrentLifecycle(lifecycle) && searchStartSequenceRef.current === sequence) searchStartInFlightRef.current = false;
    }
    if (!started || !isCurrentLifecycle(lifecycle) || searchStartSequenceRef.current !== sequence) return;
    try {
      await loadCandidates({ lifecycle });
    } catch (reason) {
      if (isCurrentLifecycle(lifecycle) && searchStartSequenceRef.current === sequence) {
        setError(reason instanceof ApiError ? reason.message : "候选素材刷新失败。");
      }
    }
  };
  const retryFailedProvider = async (providerId: ProviderRunSummary["providerId"]) => {
    const lifecycle = { jobId, generation: lifecycleRef.current.generation };
    if (!isCurrentLifecycle(lifecycle) || searchStartInFlightRef.current) return;
    continuationRoundRef.current = null;
    const sequence = ++searchStartSequenceRef.current;
    searchStartInFlightRef.current = true;
    setSearchRequested(true);
    setError(null); setNotice(null);
    let started = false;
    try {
      const result = await api.startSearch(lifecycle.jobId, { providerIds: [providerId], retryFailedProviderIds: [providerId] });
      if (result.status === "exhausted") {
        if (isCurrentLifecycle(lifecycle) && searchStartSequenceRef.current === sequence) {
          setSearchRequested(false);
          setNotice(SEARCH_EXHAUSTED_NOTICE);
        }
        return;
      }
      started = true;
    } catch (reason) {
      if (isCurrentLifecycle(lifecycle) && searchStartSequenceRef.current === sequence) {
        setSearchRequested(false);
        setError(reason instanceof ApiError ? reason.message : "无法重新尝试该来源。");
      }
    } finally {
      if (isCurrentLifecycle(lifecycle) && searchStartSequenceRef.current === sequence) searchStartInFlightRef.current = false;
    }
    if (!started || !isCurrentLifecycle(lifecycle) || searchStartSequenceRef.current !== sequence) return;
    try {
      await loadCandidates({ lifecycle });
    } catch (reason) {
      if (isCurrentLifecycle(lifecycle) && searchStartSequenceRef.current === sequence) {
        setError(reason instanceof ApiError ? reason.message : "候选素材刷新失败。");
      }
    }
  };
  const pauseSearch = async () => {
    const lifecycle = { jobId, generation: lifecycleRef.current.generation };
    if (!isCurrentLifecycle(lifecycle)) return;
    searchStartSequenceRef.current += 1;
    searchStartInFlightRef.current = false;
    continuationRoundRef.current = null;
    setError(null);
    try {
      await api.pauseSearch(lifecycle.jobId);
      if (!isCurrentLifecycle(lifecycle)) return;
      setSearchRequested(false);
      await loadCandidates({ lifecycle });
    } catch (reason) {
      if (isCurrentLifecycle(lifecycle)) setError(reason instanceof ApiError ? reason.message : "无法暂停任务。" );
    }
  };

  if (loading || (job !== null && job.id !== jobId)) return <main className="workbench-loading" role="status">正在打开素材工作台…</main>;
  if (!job) return <main className="page">{error ? <div className="inline-notice inline-notice--error" role="alert">{error}</div> : null}</main>;
  const providerDisplayNames = new Map<ProviderId, string>();
  for (const [id, name] of Object.entries(legacyProviderDisplayNames)) {
    if (name) providerDisplayNames.set(id as ProviderId, name);
  }
  for (const provider of providers) providerDisplayNames.set(provider.id, provider.displayName);
  const providerName = (id: ProviderId) => providerDisplayNames.get(id) ?? id;
  const openCandidate = filteredCandidates.find((candidate) => candidate.id === openCandidateId) ?? null;
  const providerOptions = [...new Set(effectiveCandidates.flatMap((candidate) => [candidate.provider, ...candidate.provenance.map((entry) => entry.provider)]))]
    .sort((first, second) => providerName(first).localeCompare(providerName(second)));
  const selectedTotal = effectiveCandidates.filter((candidate) => candidate.reviewState === "selected").length;

  return (
    <main className="workbench-page" aria-label={`${job.name}工作台`}>
      <div className="workbench-titlebar">
        <div><h1>{job.name}</h1><p>{job.taskType === "advertiser_product_taxonomy" ? "广告品类标注" : "内容审核"} · {hasActiveRuns ? "正在采集" : "等待审核"}</p></div>
        <div className="workbench-titlebar__actions">
          <button className="button button--secondary workbench-mobile-label-button" type="button" aria-label="打开分类队列" aria-expanded={labelQueueOpen} aria-controls="mobile-label-queue" onClick={() => setLabelQueueOpen(true)}><FolderTree aria-hidden="true" size={15} />分类队列</button>
          <ProviderPicker providers={providers} selectedIds={selectedProviderIds} onChange={changeSelectedProviders} />
          <button className="button button--secondary" type="button" disabled={hasActiveRuns} onClick={() => { void continueSearch(); }}><Play aria-hidden="true" size={15} />继续搜索</button>
          <button className="button button--secondary" type="button" onClick={() => { void pauseSearch(); }}><Pause aria-hidden="true" size={15} />暂停</button>
          <button className="button button--primary" type="button" onClick={() => setExportOpen(true)}><Download aria-hidden="true" size={15} />导出数据集</button>
        </div>
      </div>
      {error ? <div className="workbench-error" role="alert">{error}</div> : null}
      {notice ? <div className="workbench-notice" role="status">{notice}</div> : null}
      {providerFailures.length ? <section className="workbench-provider-failures" aria-label="平台拉取状态">
        <div className="workbench-provider-failures__intro"><h2>部分平台拉取未完成</h2><p>其它平台的结果已保留，以下失败不会被静默忽略。</p></div>
        <ul>{providerFailures.map(({ providerId, runs }) => {
          const retryableCount = runs.filter((run) => run.retryable || run.status === "retryable").length;
          const hasExplicitRetryWork = runs.some((run) => run.status === "failed" || run.requiresExplicitRetry);
          const retryLabel = retryableCount === runs.length ? "可重试" : retryableCount === 0 ? "需检查配置" : "部分可重试";
          const retryClass = retryableCount === runs.length ? "is-retryable" : retryableCount === 0 ? "is-terminal" : "is-mixed";
          return <li key={providerId}>
            <div className="workbench-provider-failures__provider">
              <strong>{providerDisplayNames.get(providerId) ?? legacyProviderDisplayNames[providerId] ?? providerId}</strong><span className={retryClass}>{retryLabel}</span>
              {hasExplicitRetryWork ? <button className="button button--secondary" type="button" disabled={hasActiveRuns} onClick={() => { void retryFailedProvider(providerId); }}>重新尝试该来源</button> : null}
            </div>
            <ul>{runs.map((run) => <li key={run.id}><span>{run.variantName} · {run.query}</span><p>{run.errorSummary ?? "提供方请求失败。"}</p></li>)}</ul>
          </li>;
        })}</ul>
      </section> : null}
      <div className="workbench-layout">
        <div className="label-queue-desktop">
          <LabelQueue labels={job.labels} activeLabelId={activeLabelId} candidateCounts={candidateCounts} selectedCounts={selectedCounts} onSelect={(labelId) => { setActiveLabelId(labelId); setCheckedIds(new Set()); setOpenCandidateId(null); setLabelQueueOpen(false); }} />
        </div>
        {labelQueueOpen ? <>
          <button className="label-queue-backdrop" type="button" aria-label="关闭分类队列遮罩" onClick={() => setLabelQueueOpen(false)} />
          <div ref={mobileLabelDialogRef} id="mobile-label-queue" className="label-queue-panel label-queue-panel--open" role="dialog" aria-modal="true" aria-label="分类队列" tabIndex={-1}>
            <button ref={mobileLabelCloseRef} className="icon-button label-queue-panel__close" type="button" aria-label="关闭分类队列" onClick={() => setLabelQueueOpen(false)}><X aria-hidden="true" size={17} /></button>
            <LabelQueue labels={job.labels} activeLabelId={activeLabelId} candidateCounts={candidateCounts} selectedCounts={selectedCounts} onSelect={(labelId) => { setActiveLabelId(labelId); setCheckedIds(new Set()); setOpenCandidateId(null); setLabelQueueOpen(false); }} />
          </div>
        </> : null}
        <section className="candidate-workspace" aria-label="候选素材画廊">
          <div className="candidate-toolbar">
            <label className="candidate-toolbar__check"><input type="checkbox" aria-label="全选当前素材" checked={filteredCandidates.length > 0 && filteredCandidates.every((candidate) => checkedIds.has(candidate.id))} onChange={(event) => setCheckedIds(event.currentTarget.checked ? new Set(filteredCandidates.map((candidate) => candidate.id)) : new Set())} />全选</label>
            <span className="candidate-toolbar__selected">已选 {selectedTotal}</span>
            {hasCheckedCandidates ? <button type="button" onClick={() => batchReview("select")}><Check aria-hidden="true" size={14} />批量选择</button> : null}
            {hasCheckedCandidates ? <button type="button" onClick={() => batchReview("reject")}><X aria-hidden="true" size={14} />批量拒绝</button> : null}
            <label className="candidate-toolbar__toggle"><input type="checkbox" checked={onlyUnreviewed} onChange={(event) => setOnlyUnreviewed(event.currentTarget.checked)} />仅看未审核</label>
            <label><span>图片格式</span><select aria-label="图片格式" value={formatFilter} onChange={(event) => setFormatFilter(event.currentTarget.value)}><option value="all">全部格式</option><option value="image/jpeg">JPEG</option><option value="image/png">PNG</option><option value="image/webp">WebP</option></select></label>
            <label><span>比例</span><select aria-label="比例" value={ratioFilter} onChange={(event) => setRatioFilter(event.currentTarget.value)}><option value="all">全部比例</option><option value="square">方形</option><option value="landscape">横图</option><option value="portrait">竖图</option></select></label>
            <label><span>来源</span><select aria-label="来源" value={sourceFilter} onChange={(event) => setSourceFilter(event.currentTarget.value)}><option value="all">全部来源</option>{providerOptions.map((provider) => <option key={provider} value={provider}>{providerName(provider)}</option>)}</select></label>
            <label><span>授权类型</span><select aria-label="授权类型" value={rightsFilter} onChange={(event) => setRightsFilter(event.currentTarget.value)}><option value="all">全部授权</option><option value="unknown">授权未知</option><option value="cc0">CC0</option><option value="pdm">公共领域</option><option value="verified">已核验</option></select></label>
            <label><span>尺寸</span><select aria-label="尺寸" value={sizeFilter} onChange={(event) => setSizeFilter(event.currentTarget.value)}><option value="all">全部尺寸</option><option value="large">≥1200 px</option><option value="warning">低于 512 px</option></select></label>
            <div className="candidate-toolbar__more">
              <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}><SlidersHorizontal aria-hidden="true" size={14} />更多筛选</button>
              {moreOpen ? <label className="candidate-toolbar__popover"><input type="checkbox" checked={onlyProblems} onChange={(event) => setOnlyProblems(event.currentTarget.checked)} />仅看异常素材</label> : null}
            </div>
          </div>
          <div className="candidate-workspace__body">
            <CandidateGrid candidates={filteredCandidates} providerDisplayNames={providerDisplayNames} checkedIds={checkedIds} onToggleChecked={(candidateId) => setCheckedIds((prior) => { const next = new Set(prior); if (next.has(candidateId)) next.delete(candidateId); else next.add(candidateId); return next; })} onSelect={(id, shift) => reviewFromCard(id, shift, "select")} onReject={(id, shift) => reviewFromCard(id, shift, "reject")} onOpen={setOpenCandidateId} onKeepHighestResolution={keepHighestResolution} sensitive={job.taskType === "content_moderation"} revealedIds={revealedSensitiveIds} onSetRevealed={setSensitiveRevealed} />
          </div>
        </section>
        {openCandidate ? <CandidateDrawer candidate={openCandidate} providerDisplayNames={providerDisplayNames} labels={job.labels} taskType={job.taskType} activeLabelId={activeLabelId} strictCompliance={job.exportMode === "strict_compliance"} onClose={() => setOpenCandidateId(null)} onMoveLabel={moveLabel} onSetLabels={setModerationLabels} onSetRightsEvidence={setRightsEvidence} sensitive={job.taskType === "content_moderation"} revealed={revealedSensitiveIds.has(openCandidate.id)} onSetRevealed={setSensitiveRevealed} /> : <aside className="candidate-drawer candidate-drawer--empty"><h2>素材溯源与信息</h2><p>打开素材详情后，可核对来源、授权、文件和最终标签。</p></aside>}
      </div>
      <ExportDialog job={job} open={exportOpen} onClose={() => setExportOpen(false)} />
    </main>
  );
}
