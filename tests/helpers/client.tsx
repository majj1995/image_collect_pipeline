import type { PropsWithChildren } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi, type Mock } from "vitest";
import { App } from "../../src/client/App.js";
import {
  ApiError,
  ApiProvider,
  type ApiClient,
  type CandidatePage,
  type ExportPreflight,
  type Health,
  type JobDetail
} from "../../src/client/api.js";
import { defaultLocalSettings, type Candidate, type CreateJobInput, type Job, type LocalSettings, type ProviderRunSummary, type ProviderStatus } from "../../src/shared/contracts.js";

interface MockApiSeed {
  jobs?: Job[];
  details?: JobDetail[];
  health?: Health;
  providers?: ProviderStatus[];
  settings?: LocalSettings;
  candidates?: Candidate[];
  providerRuns?: ProviderRunSummary[];
  preflight?: ExportPreflight;
  api?: Partial<ApiClient>;
}

interface MockSpies {
  getHealth: Mock<ApiClient["getHealth"]>;
  listJobs: Mock<ApiClient["listJobs"]>;
  getJob: Mock<ApiClient["getJob"]>;
  createJob: Mock<ApiClient["createJob"]>;
  listProviders: Mock<ApiClient["listProviders"]>;
  getSettings: Mock<ApiClient["getSettings"]>;
  updateSettings: Mock<ApiClient["updateSettings"]>;
  listCandidates: Mock<ApiClient["listCandidates"]>;
  startSearch: Mock<ApiClient["startSearch"]>;
  pauseSearch: Mock<ApiClient["pauseSearch"]>;
  review: Mock<ApiClient["review"]>;
  getExportPreflight: Mock<ApiClient["getExportPreflight"]>;
  createExport: Mock<ApiClient["createExport"]>;
  getExport: Mock<ApiClient["getExport"]>;
}

const defaultProviders: ProviderStatus[] = [
  {
    id: "openverse",
    displayName: "Openverse",
    configured: false,
    enabled: true,
    rightsPolicy: "open",
    maxResults: 80,
    credentialVariables: [],
    credentialMode: "none",
    sourceCategory: "general",
    freeTier: "匿名公开 API",
    docsUrl: "https://docs.openverse.org/api/guides/",
    defaultSelected: true
  }
];

function detailFromJob(job: Job): JobDetail {
  return { ...job, labels: [] };
}

function makeMockApi(seed: MockApiSeed): { client: ApiClient; spies: MockSpies } {
  const jobs = [...(seed.jobs ?? [])];
  const details = new Map((seed.details ?? jobs.map(detailFromJob)).map((job) => [job.id, job]));
  const health = seed.health ?? { ok: true, service: "素材扩展台" };
  const providers = seed.providers ?? defaultProviders;
  let settings = structuredClone(seed.settings ?? defaultLocalSettings);
  const candidates = seed.candidates ?? [];
  const preflight = seed.preflight ?? { selected: 0, uniqueAssets: 0, ready: 0, blockers: {}, warnings: {} };

  const getHealth = vi.fn<ApiClient["getHealth"]>(async () => health);
  const listJobs = vi.fn<ApiClient["listJobs"]>(async () => ({ items: [...jobs] }));
  const getJob = vi.fn<ApiClient["getJob"]>(async (jobId) => {
    const job = details.get(jobId);
    if (!job) throw new ApiError("请求的资源不存在。", 404);
    return job;
  });
  const createJob = vi.fn<ApiClient["createJob"]>(async (input: CreateJobInput) => {
    const now = "2026-08-29T10:00:00.000Z";
    const job: JobDetail = {
      id: `job-created-${jobs.length + 1}`,
      name: input.name,
      taskType: input.taskType,
      exportMode: input.exportMode,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      labels: input.labelPaths.map((source, index) => {
        const path = source.normalize("NFKC").split(/\s*(?:>|\/|\t)\s*/u).map((part) => part.trim()).filter(Boolean);
        const searchProfile = input.labelSearchProfiles?.[index];
        return {
          id: `label-${index + 1}`,
          jobId: `job-created-${jobs.length + 1}`,
          path,
          product: path.at(-1) ?? "",
          aliases: input.aliases,
          styles: input.styles,
          requiredTerms: input.requiredTerms,
          excludedTerms: input.excludedTerms,
          ...(searchProfile ? { searchProfiles: { zh: searchProfile.zh, en: searchProfile.en } } : {}),
          targetCount: input.targetCount,
          candidateCount: input.candidateCount,
          selectedCount: 0
        };
      })
    };
    jobs.unshift(job);
    details.set(job.id, job);
    return job;
  });
  const listProviders = vi.fn<ApiClient["listProviders"]>(async () => ({ items: providers }));
  const getSettings = vi.fn<ApiClient["getSettings"]>(async () => structuredClone(settings));
  const updateSettings = vi.fn<ApiClient["updateSettings"]>(async (next) => {
    settings = structuredClone(next);
    return structuredClone(settings);
  });

  const candidatePage: CandidatePage = { items: candidates, nextCursor: null, labelProgress: [], providerRuns: seed.providerRuns ?? [] };
  const listCandidates = vi.fn<ApiClient["listCandidates"]>(async () => candidatePage);
  const startSearch = vi.fn<ApiClient["startSearch"]>(async () => ({ status: "collecting" as const }));
  const pauseSearch = vi.fn<ApiClient["pauseSearch"]>(async () => ({ paused: 0 }));
  const reviewStates = new Map(candidates.map((candidate) => [candidate.id, {
    candidateId: candidate.id,
    reviewState: candidate.reviewState ?? "unreviewed",
    labelIds: [...(candidate.labelIds ?? [])],
    primaryLabelId: candidate.primaryLabelId ?? null,
    rightsAcknowledged: candidate.rightsAcknowledged ?? false,
    rightsBasis: candidate.rightsBasis ?? "unknown",
    rightsEvidence: candidate.rightsEvidence ?? null,
    rightsStatus: candidate.rightsStatus,
    warningOverrides: []
  }]));
  const review = vi.fn<ApiClient["review"]>(async (_jobId, input) => ({ items: input.candidateIds.map((candidateId) => {
    const prior = reviewStates.get(candidateId) ?? { candidateId, reviewState: "unreviewed" as const, labelIds: [], primaryLabelId: null, rightsAcknowledged: false, rightsBasis: "unknown" as const, rightsEvidence: null, warningOverrides: [] };
    const next = { ...prior, labelIds: [...prior.labelIds], warningOverrides: [...prior.warningOverrides] };
    if (input.action === "select" || input.action === "keep_highest_resolution" && candidateId === input.primaryCandidateId) {
      next.reviewState = "selected";
      if (input.labelIds) next.labelIds = [...input.labelIds];
      if (input.primaryLabelId) next.primaryLabelId = input.primaryLabelId;
    } else if (input.action === "reject" || input.action === "keep_highest_resolution") next.reviewState = "rejected";
    else if (input.action === "restore") next.reviewState = "unreviewed";
    else if (input.action === "move_label" || input.action === "set_labels") { next.labelIds = [...(input.labelIds ?? [])]; next.primaryLabelId = input.primaryLabelId ?? null; }
    else if (input.action === "acknowledge_rights") next.rightsAcknowledged = input.rightsAcknowledged ?? true;
    else if (input.action === "set_rights_evidence") { next.rightsBasis = input.rightsBasis ?? "unknown"; next.rightsEvidence = input.rightsEvidence ?? null; }
    else if (input.action === "override_warning" && input.warningCode && !next.warningOverrides.includes(input.warningCode)) next.warningOverrides.push(input.warningCode);
    reviewStates.set(candidateId, next);
    return next;
  }) }));
  const getExportPreflight = vi.fn<ApiClient["getExportPreflight"]>(async () => preflight);
  const createExport = vi.fn<ApiClient["createExport"]>(async () => ({ id: "export-1", status: "generating" as const, preflight }));
  const getExport = vi.fn<ApiClient["getExport"]>(async () => ({ id: "export-1", jobId: "job-workbench", status: "ready" as const, preflight, errorCode: null, zipSha256: "abc" }));
  const client: ApiClient = {
    getHealth,
    listJobs,
    getJob,
    createJob,
    listProviders,
    getSettings,
    updateSettings,
    listCandidates,
    startSearch,
    pauseSearch,
    review,
    getExportPreflight,
    createExport,
    getExport,
    exportDownloadUrl: (exportId) => `/api/exports/${encodeURIComponent(exportId)}/download`,
    ...seed.api
  };

  return { client, spies: { getHealth, listJobs, getJob, createJob, listProviders, getSettings, updateSettings, listCandidates, startSearch, pauseSearch, review, getExportPreflight, createExport, getExport } };
}

const initial = makeMockApi({});

export const mockApi: {
  client: ApiClient;
  spies: MockSpies;
  reset(seed?: MockApiSeed): void;
} = {
  client: initial.client,
  spies: initial.spies,
  reset(seed = {}) {
    const next = makeMockApi(seed);
    this.client = next.client;
    this.spies = next.spies;
  }
};

export function TestApiBoundary({ children, client = mockApi.client }: PropsWithChildren<{ client?: ApiClient }>) {
  return <ApiProvider value={client}>{children}</ApiProvider>;
}

export function TestApp({ initialEntries = ["/"], client = mockApi.client }: { initialEntries?: string[]; client?: ApiClient }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <TestApiBoundary client={client}><App /></TestApiBoundary>
    </MemoryRouter>
  );
}

/** Task 8 replaces the routed placeholder while retaining this injected boundary. */
export function WorkbenchTestApp({ client = mockApi.client }: { client?: ApiClient }) {
  return <TestApp initialEntries={["/jobs/job-workbench"]} client={client} />;
}

/** Task 8 wires the blocker fixture into its export component through the same API client. */
export function ExportDialogTestApp({ blocker, client = mockApi.client }: { blocker: string; client?: ApiClient }) {
  return <div data-export-blocker={blocker}><TestApp initialEntries={["/jobs/job-workbench"]} client={client} /></div>;
}
