import { createHash, randomUUID } from "node:crypto";
import { isRetryableDownloadFailureCode, type Candidate, type CandidateProvenance, type ProviderId, type ProviderRunSummary, type RetryableDownloadFailureCode, type SearchEvent } from "../../shared/contracts.js";
import { sanitizePublicHttpUrl, sanitizePublicSource, sanitizePublicText } from "../../shared/public-url.js";
import type { NormalizedHit } from "../providers/types.js";
import type { AppDatabase } from "../database.js";
import { isSafeRightsEvidence } from "../services/rights-policy.js";

export type QueryRunStatus = "pending" | "running" | "completed" | "failed" | "paused" | "retryable";

export interface QueryRun extends ProviderRunSummary {
  page: number;
  requestCount: number | null;
}

export interface QueryRunDraft {
  labelId: string;
  providerId: ProviderId;
  variantName: string;
  query: string;
  page?: number;
}

export interface CandidateMaterializationTarget {
  candidateId: string;
  providerId: ProviderId;
}

interface QueryRunRow {
  id: string; job_id: string; label_id: string; provider_id: ProviderId; variant_name: string;
  query_text: string; page: number | bigint; request_count: number | bigint | null; provider_hit_count: number | bigint | null; status: QueryRunStatus; error_summary: string | null; retryable: number | bigint; requires_explicit_retry: number | bigint; created_at: string;
  started_at: string | null; completed_at: string | null; hit_count: number | bigint;
}

interface CandidateRow {
  id: string; job_id: string; provider_id: ProviderId; image_url: string; landing_page_url: string | null;
  title: string | null; pipeline_state: Candidate["pipelineState"]; rights_status: NonNullable<Candidate["rightsStatus"]>;
  asset_id: string | null; pipeline_error: string | null; pipeline_failure_code: string | null; pipeline_warnings_json: string; near_duplicate_group: string | null;
  width: number | bigint | null; height: number | bigint | null; mime_type: Candidate["mimeType"];
  discovery_label_ids_json: string;
  review_state: "unreviewed" | "selected" | "rejected" | null; label_ids_json: string | null; primary_label_id: string | null; rights_acknowledged: number | null; rights_basis: import("../../shared/contracts.js").RightsBasis | null; rights_evidence: string | null;
}

interface CandidateProvenanceRow {
  candidate_id: string;
  hit_id: string;
  query_run_id: string;
  provider_id: ProviderId;
  variant_name: string;
  query_text: string;
  page: number | bigint;
  image_url: string;
  landing_page_url: string | null;
  title: string | null;
  creator: string | null;
  license_name: string | null;
  license_url: string | null;
  source_provider: string | null;
  source: string | null;
  rights_status: CandidateProvenance["rightsStatus"];
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function normalizeImageUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

function toQueryRun(row: QueryRunRow, publicText = false): QueryRun {
  return {
    id: row.id, jobId: row.job_id, labelId: row.label_id, providerId: row.provider_id,
    variantName: publicText ? sanitizePublicText(row.variant_name) ?? "" : row.variant_name,
    query: publicText ? sanitizePublicText(row.query_text) ?? "" : row.query_text,
    page: Number(row.page), requestCount: row.request_count === null ? null : Number(row.request_count), status: row.status,
    retryable: row.status === "retryable", requiresExplicitRetry: Boolean(row.requires_explicit_retry),
    errorSummary: publicText ? sanitizePublicText(row.error_summary) : row.error_summary, createdAt: row.created_at, startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.completed_at ? Math.max(0, Date.parse(row.completed_at) - Date.parse(row.started_at ?? row.created_at)) : null,
    hitCount: row.provider_hit_count === null ? Number(row.hit_count) : Number(row.provider_hit_count)
  };
}

function toProvenance(row: CandidateProvenanceRow): CandidateProvenance {
  return {
    hitId: row.hit_id,
    queryRunId: row.query_run_id,
    provider: row.provider_id,
    variantName: sanitizePublicText(row.variant_name) ?? "",
    query: sanitizePublicText(row.query_text) ?? "",
    page: Number(row.page),
    imageUrl: sanitizePublicHttpUrl(row.image_url),
    landingPageUrl: sanitizePublicHttpUrl(row.landing_page_url),
    title: sanitizePublicText(row.title),
    creator: sanitizePublicText(row.creator),
    licenseName: sanitizePublicText(row.license_name),
    licenseUrl: sanitizePublicHttpUrl(row.license_url),
    sourceProvider: sanitizePublicSource(row.source_provider),
    source: sanitizePublicSource(row.source),
    rightsStatus: row.rights_status
  };
}

function toCandidate(row: CandidateRow, provenance: CandidateProvenance[] = []): Candidate {
  return {
    id: row.id, jobId: row.job_id, provider: row.provider_id, imageUrl: sanitizePublicHttpUrl(row.image_url) ?? "",
    landingPageUrl: sanitizePublicHttpUrl(row.landing_page_url), title: sanitizePublicText(row.title), pipelineState: row.pipeline_state,
    rightsStatus: row.rights_status, assetId: row.asset_id, pipelineError: row.pipeline_error,
    pipelineFailureCode: isRetryableDownloadFailureCode(row.pipeline_failure_code) ? row.pipeline_failure_code : null,
    width: row.width === null ? null : Number(row.width), height: row.height === null ? null : Number(row.height), mimeType: row.mime_type,
    discoveryLabelIds: JSON.parse(row.discovery_label_ids_json) as string[],
    warnings: JSON.parse(row.pipeline_warnings_json) as string[], nearDuplicateGroup: row.near_duplicate_group,
    reviewState: row.review_state ?? "unreviewed", labelIds: row.label_ids_json ? JSON.parse(row.label_ids_json) as string[] : undefined,
    primaryLabelId: row.primary_label_id, rightsAcknowledged: Boolean(row.rights_acknowledged), rightsBasis: row.rights_basis ?? "unknown", rightsEvidence: isSafeRightsEvidence(row.rights_evidence) ? row.rights_evidence : null,
    provenance
  };
}

export class SearchRepository {
  private readonly hasSearchHitThumbnails: boolean;

  public constructor(private readonly database: AppDatabase) {
    this.hasSearchHitThumbnails = (database.prepare("PRAGMA table_info(search_hits)").all() as unknown as Array<{ name: string }>)
      .some((column) => column.name === "thumbnail_url");
  }

  public hasActiveRuns(jobId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM query_runs WHERE job_id = ? AND status IN ('pending', 'running') LIMIT 1").get(jobId));
  }

  public createRuns(jobId: string, drafts: QueryRunDraft[]): QueryRun[] {
    const now = new Date().toISOString();
    const insert = this.database.prepare(`
      INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);
    const insertEvent = this.database.prepare("INSERT INTO job_events (job_id, type, query_run_id, status, created_at) VALUES (?, 'query_run', ?, 'pending', ?)");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const runs = drafts.map((draft) => {
        const id = randomUUID();
        const page = draft.page ?? 1;
        insert.run(id, jobId, draft.labelId, draft.providerId, draft.variantName, draft.query, page, now);
        insertEvent.run(jobId, id, now);
        return { id, jobId, ...draft, page, requestCount: null, status: "pending" as const, retryable: false, requiresExplicitRetry: false, errorSummary: null, createdAt: now, startedAt: null, completedAt: null, durationMs: null, hitCount: 0 };
      });
      this.database.exec("COMMIT;");
      return runs;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public markRunning(runId: string, expectedStatus: QueryRunStatus = "pending", requestCount = 1): boolean {
    if (!(["pending", "paused", "retryable"] as QueryRunStatus[]).includes(expectedStatus)) return false;
    if (!Number.isSafeInteger(requestCount) || requestCount < 1 || requestCount > 200) return false;
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const run = this.database.prepare("SELECT job_id FROM query_runs WHERE id = ? AND status = ?").get(runId, expectedStatus) as { job_id: string } | undefined;
      if (!run) { this.database.exec("COMMIT;"); return false; }
      this.database.prepare("UPDATE query_runs SET status = 'running', request_count = COALESCE(request_count, ?), retryable = 0, requires_explicit_retry = 0, error_summary = NULL, started_at = ?, completed_at = NULL WHERE id = ?").run(requestCount, now, runId);
      this.recordQueryRunEvent(run.job_id, runId, "running", now);
      this.database.exec("COMMIT;");
      return true;
    } catch (error) { this.database.exec("ROLLBACK;"); throw error; }
  }

  public markFinished(runId: string, status: "completed" | "failed" | "retryable", errorSummary: string | null = null, retryable = false): void {
    this.transition(runId, "running", status, errorSummary, retryable, undefined, status === "retryable");
  }

  public markSearchCompleted(runId: string, providerHitCount: number): void {
    if (!Number.isSafeInteger(providerHitCount) || providerHitCount < 0) throw new Error("Invalid provider hit count.");
    this.transition(runId, "running", "completed", null, false, providerHitCount);
  }

  public completeWithoutSearch(runId: string, expectedStatus: QueryRunStatus = "pending"): boolean {
    if (!(["pending", "paused", "retryable"] as QueryRunStatus[]).includes(expectedStatus)) return false;
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const run = this.database.prepare("SELECT job_id FROM query_runs WHERE id = ? AND status = ?").get(runId, expectedStatus) as { job_id: string } | undefined;
      if (!run) { this.database.exec("COMMIT;"); return false; }
      this.database.prepare("UPDATE query_runs SET status = 'completed', retryable = 0, requires_explicit_retry = 0, error_summary = NULL, provider_hit_count = COALESCE(provider_hit_count, 0), completed_at = ? WHERE id = ?").run(now, runId);
      this.recordQueryRunEvent(run.job_id, runId, "completed", now);
      this.database.exec("COMMIT;");
      return true;
    } catch (error) { this.database.exec("ROLLBACK;"); throw error; }
  }

  public deferForNextBatch(runId: string, expectedStatus: QueryRunStatus = "pending"): boolean {
    if (!(["pending", "paused", "retryable"] as QueryRunStatus[]).includes(expectedStatus)) return false;
    return this.transition(runId, expectedStatus, "paused");
  }

  public pausePending(jobId: string): number {
    const now = new Date().toISOString();
    const runs = this.database.prepare("SELECT id FROM query_runs WHERE job_id = ? AND status = 'pending'").all(jobId) as unknown as Array<{ id: string }>;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const update = this.database.prepare("UPDATE query_runs SET status = 'paused', requires_explicit_retry = 0, completed_at = ? WHERE id = ? AND status = 'pending'");
      for (const run of runs) {
        if (Number(update.run(now, run.id).changes) > 0) this.recordQueryRunEvent(jobId, run.id, "paused", now);
      }
      this.database.exec("COMMIT;");
      return runs.length;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public saveHits(run: QueryRun, hits: NormalizedHit[], candidateLimit = Number.MAX_SAFE_INTEGER): string[] {
    const insertHit = this.database.prepare(`
      INSERT INTO search_hits (id, job_id, provider_id, normalized_image_url, image_url, thumbnail_url, landing_page_url, title, creator, license_name, license_url, width, height, source_provider, source, rights_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, provider_id, normalized_image_url) DO NOTHING
    `);
    const getHit = this.database.prepare("SELECT id FROM search_hits WHERE job_id = ? AND provider_id = ? AND normalized_image_url = ?");
    const insertCandidate = this.database.prepare(`
      INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, landing_page_url, title, pipeline_state, rights_status, provider_rights_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)
      ON CONFLICT(job_id, normalized_image_url) DO NOTHING
    `);
    const getCandidate = this.database.prepare("SELECT id FROM candidates WHERE job_id = ? AND normalized_image_url = ?");
    const isRejectedCandidate = this.database.prepare("SELECT 1 FROM candidate_review_state WHERE candidate_id = ? AND review_state = 'rejected'");
    const hasCandidateLabel = this.database.prepare("SELECT 1 FROM candidate_labels WHERE candidate_id = ? AND label_id = ?");
    const linkHit = this.database.prepare("INSERT OR IGNORE INTO candidate_hits (candidate_id, hit_id, query_run_id) VALUES (?, ?, ?)");
    const labelCandidate = this.database.prepare("INSERT OR IGNORE INTO candidate_labels (candidate_id, job_id, label_id) VALUES (?, ?, ?)");
    const now = new Date().toISOString();
    const candidateIds = new Set<string>();
    const boundedLimit = Number.isSafeInteger(candidateLimit) ? Math.max(0, candidateLimit) : Number.MAX_SAFE_INTEGER;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      let labelCount = Number((this.database.prepare("SELECT COUNT(*) AS count FROM candidate_labels WHERE job_id = ? AND label_id = ?").get(run.jobId, run.labelId) as { count: number | bigint }).count);
      for (const hit of hits) {
        const normalizedUrl = normalizeImageUrl(hit.imageUrl);
        const hitId = `hit_${digest(`${run.jobId}:${hit.provider}:${normalizedUrl}`)}`;
        const candidateId = `candidate_${digest(`${run.jobId}:${normalizedUrl}`)}`;
        const existingCandidate = getCandidate.get(run.jobId, normalizedUrl) as { id: string } | undefined;
        const alreadyLabeled = Boolean(existingCandidate && hasCandidateLabel.get(existingCandidate.id, run.labelId));
        if (!alreadyLabeled && labelCount >= boundedLimit) continue;
        insertHit.run(hitId, run.jobId, hit.provider, normalizedUrl, hit.imageUrl, hit.thumbnailUrl, hit.landingPageUrl, hit.title, hit.creator, hit.licenseName, hit.licenseUrl, hit.width, hit.height, hit.sourceProvider, hit.source, hit.rightsStatus);
        const persistedHit = getHit.get(run.jobId, hit.provider, normalizedUrl) as { id: string };
        insertCandidate.run(candidateId, run.jobId, normalizedUrl, hit.provider, hit.imageUrl, hit.landingPageUrl, hit.title, hit.rightsStatus, hit.rightsStatus, now);
        const persistedCandidate = getCandidate.get(run.jobId, normalizedUrl) as { id: string };
        linkHit.run(persistedCandidate.id, persistedHit.id, run.id);
        if (Number(labelCandidate.run(persistedCandidate.id, run.jobId, run.labelId).changes) > 0) labelCount += 1;
        if (!isRejectedCandidate.get(persistedCandidate.id)) candidateIds.add(persistedCandidate.id);
      }
      this.database.exec("COMMIT;");
      return [...candidateIds];
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public listCandidates(jobId: string, cursor?: number, limit = 50): { items: Candidate[]; nextCursor: number | null } {
    const rows = this.database.prepare(`
      SELECT candidates.rowid AS cursor, candidates.id, candidates.job_id, candidates.provider_id, candidates.image_url, candidates.landing_page_url, candidates.title, candidates.pipeline_state, candidates.rights_status, candidates.pipeline_error, candidates.pipeline_failure_code, candidates.pipeline_warnings_json, candidates.near_duplicate_group, candidate_assets.asset_id, assets.width, assets.height, assets.mime_type,
        COALESCE((SELECT json_group_array(ordered.label_id) FROM (SELECT candidate_labels.label_id FROM candidate_labels WHERE candidate_labels.candidate_id = candidates.id ORDER BY candidate_labels.label_id) AS ordered), '[]') AS discovery_label_ids_json,
        candidate_review_state.review_state, candidate_review_state.label_ids_json, candidate_review_state.primary_label_id, candidate_review_state.rights_acknowledged, candidate_review_state.rights_basis, candidate_review_state.rights_evidence
      FROM candidates
      LEFT JOIN candidate_assets ON candidate_assets.candidate_id = candidates.id
      LEFT JOIN assets ON assets.id = candidate_assets.asset_id
      LEFT JOIN candidate_review_state ON candidate_review_state.candidate_id = candidates.id
      WHERE candidates.job_id = ? AND candidates.rowid > ? ORDER BY candidates.rowid ASC LIMIT ?
    `).all(jobId, cursor ?? 0, limit + 1) as unknown as Array<CandidateRow & { cursor: number }>;
    const page = rows.slice(0, limit);
    const provenanceByCandidate = new Map<string, CandidateProvenance[]>();
    if (page.length > 0) {
      const provenanceRows = this.database.prepare(`
        SELECT candidate_hits.candidate_id, search_hits.id AS hit_id, candidate_hits.query_run_id,
          search_hits.provider_id, query_runs.variant_name, query_runs.query_text, query_runs.page,
          search_hits.image_url, search_hits.landing_page_url, search_hits.title, search_hits.creator,
          search_hits.license_name, search_hits.license_url, search_hits.source_provider, search_hits.source,
          search_hits.rights_status
        FROM candidate_hits
        JOIN search_hits ON search_hits.id = candidate_hits.hit_id
        JOIN query_runs ON query_runs.id = candidate_hits.query_run_id
        WHERE candidate_hits.candidate_id IN (${page.map(() => "?").join(",")})
        ORDER BY candidate_hits.candidate_id, query_runs.rowid, search_hits.rowid
      `).all(...page.map((row) => row.id)) as unknown as CandidateProvenanceRow[];
      for (const provenanceRow of provenanceRows) {
        const current = provenanceByCandidate.get(provenanceRow.candidate_id) ?? [];
        current.push(toProvenance(provenanceRow));
        provenanceByCandidate.set(provenanceRow.candidate_id, current);
      }
    }
    return { items: page.map((row) => toCandidate(row, provenanceByCandidate.get(row.id) ?? [])), nextCursor: rows.length > limit ? page.at(-1)?.cursor ?? null : null };
  }

  public listRuns(jobId: string): QueryRun[] {
    return (this.database.prepare(`
      SELECT query_runs.*, COALESCE(query_runs.provider_hit_count, COUNT(DISTINCT candidate_hits.hit_id)) AS hit_count
      FROM query_runs LEFT JOIN candidate_hits ON candidate_hits.query_run_id = query_runs.id
      WHERE query_runs.job_id = ? GROUP BY query_runs.id ORDER BY query_runs.rowid ASC
    `).all(jobId) as unknown as QueryRunRow[]).map((row) => toQueryRun(row));
  }

  public listPublicRuns(jobId: string): QueryRun[] {
    return (this.database.prepare(`
      SELECT query_runs.*, COALESCE(query_runs.provider_hit_count, COUNT(DISTINCT candidate_hits.hit_id)) AS hit_count
      FROM query_runs LEFT JOIN candidate_hits ON candidate_hits.query_run_id = query_runs.id
      WHERE query_runs.job_id = ? GROUP BY query_runs.id ORDER BY query_runs.rowid ASC
    `).all(jobId) as unknown as QueryRunRow[]).map((row) => toQueryRun(row, true));
  }

  public listResumableRuns(jobId: string, providerIds: ProviderId[], limit?: number): QueryRun[] {
    if (providerIds.length === 0) return [];
    const boundedLimit = limit === undefined ? undefined : Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) return [];
    return (this.database.prepare(`
      SELECT query_runs.*, COALESCE(query_runs.provider_hit_count, COUNT(DISTINCT candidate_hits.hit_id)) AS hit_count
      FROM query_runs LEFT JOIN candidate_hits ON candidate_hits.query_run_id = query_runs.id
      WHERE query_runs.job_id = ? AND query_runs.status IN ('paused', 'retryable') AND query_runs.provider_id IN (${providerIds.map(() => "?").join(",")})
      GROUP BY query_runs.id ORDER BY query_runs.rowid ASC
      ${boundedLimit === undefined ? "" : "LIMIT ?"}
    `).all(jobId, ...providerIds, ...(boundedLimit === undefined ? [] : [boundedLimit])) as unknown as QueryRunRow[]).map((row) => toQueryRun(row));
  }

  public listResumableProviderIds(jobId: string, providerIds: ProviderId[]): ProviderId[] {
    if (providerIds.length === 0) return [];
    const rows = this.database.prepare(`
      SELECT DISTINCT provider_id FROM query_runs
      WHERE job_id = ? AND status IN ('paused', 'retryable') AND provider_id IN (${providerIds.map(() => "?").join(",")})
      ORDER BY provider_id
    `).all(jobId, ...providerIds) as unknown as Array<{ provider_id: ProviderId }>;
    return rows.map((row) => row.provider_id);
  }

  public claimResumableRuns(jobId: string, providerIds: ProviderId[], limit: number, explicitRetryProviderIds: ProviderId[] = []): QueryRun[] {
    if (providerIds.length === 0 || !Number.isSafeInteger(limit) || limit < 1) return [];
    const boundedLimit = Math.min(limit, 2000);
    const explicitRetryProviders = new Set(explicitRetryProviderIds);
    const select = this.database.prepare(`
      SELECT query_runs.*,
        COALESCE(query_runs.provider_hit_count,
          (SELECT COUNT(DISTINCT candidate_hits.hit_id) FROM candidate_hits WHERE candidate_hits.query_run_id = query_runs.id)) AS hit_count
      FROM query_runs
      WHERE query_runs.job_id = ? AND query_runs.provider_id = ?
        AND (query_runs.status = 'paused'
          OR (query_runs.status = 'retryable' AND (query_runs.requires_explicit_retry = 0 OR ? = 1)))
      ORDER BY CASE
        WHEN ? = 1 AND query_runs.status = 'retryable' AND query_runs.requires_explicit_retry = 1 THEN 0
        ELSE 1
      END, query_runs.rowid ASC LIMIT ?
    `);
    const update = this.database.prepare(`
      UPDATE query_runs SET status = 'pending', retryable = 0, requires_explicit_retry = 0, completed_at = NULL
      WHERE id = ? AND status = ?
    `);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const byProvider = providerIds.map((providerId) => {
        const explicitRetry = explicitRetryProviders.has(providerId) ? 1 : 0;
        return select.all(jobId, providerId, explicitRetry, explicitRetry, boundedLimit) as unknown as QueryRunRow[];
      });
      const selected: QueryRunRow[] = [];
      for (let providerRank = 0; selected.length < boundedLimit; providerRank += 1) {
        let found = false;
        for (const rows of byProvider) {
          const row = rows[providerRank];
          if (!row) continue;
          found = true;
          selected.push(row);
          if (selected.length >= boundedLimit) break;
        }
        if (!found) break;
      }
      const claimed: QueryRun[] = [];
      for (const row of selected) {
        if (Number(update.run(row.id, row.status).changes) === 0) continue;
        this.recordQueryRunEvent(jobId, row.id, "pending", now);
        claimed.push({ ...toQueryRun(row), status: "pending", retryable: false, requiresExplicitRetry: false, completedAt: null, durationMs: null });
      }
      this.database.exec("COMMIT;");
      return claimed;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public claimScheduledRuns(jobId: string, runs: QueryRun[]): QueryRun[] {
    if (runs.length === 0) return [];
    const now = new Date().toISOString();
    const update = this.database.prepare(`
      UPDATE query_runs SET status = 'pending', retryable = 0, requires_explicit_retry = 0, completed_at = NULL
      WHERE id = ? AND job_id = ? AND status = ? AND status IN ('paused', 'retryable')
    `);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const claimed: QueryRun[] = [];
      for (const run of runs) {
        if (Number(update.run(run.id, jobId, run.status).changes) === 0) continue;
        this.recordQueryRunEvent(jobId, run.id, "pending", now);
        claimed.push({ ...run, status: "pending", retryable: false, requiresExplicitRetry: false, completedAt: null, durationMs: null });
      }
      this.database.exec("COMMIT;");
      return claimed;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public releaseRunsForRetry(jobId: string, runIds: string[], errorSummary: string): number {
    if (runIds.length === 0) return 0;
    const now = new Date().toISOString();
    const update = this.database.prepare(`
      UPDATE query_runs SET status = 'retryable', retryable = 1, requires_explicit_retry = 0, error_summary = ?, completed_at = NULL
      WHERE id = ? AND job_id = ? AND status IN ('pending', 'running')
    `);
    let released = 0;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      for (const runId of runIds) {
        if (Number(update.run(errorSummary, runId, jobId).changes) === 0) continue;
        released += 1;
        this.recordQueryRunEvent(jobId, runId, "retryable", now);
      }
      this.database.exec("COMMIT;");
      return released;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public retryFailedRuns(jobId: string, providerIds: ProviderId[]): number {
    if (providerIds.length === 0) return 0;
    const runs = this.database.prepare(`
      SELECT id FROM query_runs
      WHERE job_id = ? AND status = 'failed' AND provider_id IN (${providerIds.map(() => "?").join(",")})
      ORDER BY rowid
    `).all(jobId, ...providerIds) as unknown as Array<{ id: string }>;
    if (runs.length === 0) return 0;
    const now = new Date().toISOString();
    const update = this.database.prepare("UPDATE query_runs SET status = 'retryable', retryable = 1, requires_explicit_retry = 1, completed_at = NULL WHERE id = ? AND status = 'failed'");
    let retried = 0;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      for (const run of runs) {
        if (Number(update.run(run.id).changes) === 0) continue;
        retried += 1;
        this.recordQueryRunEvent(jobId, run.id, "retryable", now);
      }
      this.database.exec("COMMIT;");
      return retried;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Replays completed discovery queries so failed downloads can regain fresh provider URLs/signatures. */
  public retryRunsForDownloadFailures(jobId: string, providerIds: ProviderId[]): number {
    if (providerIds.length === 0) return 0;
    const runs = this.database.prepare(`
      SELECT DISTINCT query_runs.id
      FROM query_runs
      JOIN candidate_hits ON candidate_hits.query_run_id = query_runs.id
      JOIN candidates ON candidates.id = candidate_hits.candidate_id
      WHERE query_runs.job_id = ?
        AND query_runs.status = 'completed'
        AND query_runs.provider_id IN (${providerIds.map(() => "?").join(",")})
        AND candidates.pipeline_state = 'discovered'
        AND candidates.pipeline_error = 'RETRYABLE_DOWNLOAD'
        AND NOT EXISTS (
          SELECT 1 FROM candidate_review_state
          WHERE candidate_review_state.candidate_id = candidates.id
            AND candidate_review_state.review_state = 'rejected'
        )
      ORDER BY query_runs.rowid
    `).all(jobId, ...providerIds) as unknown as Array<{ id: string }>;
    if (runs.length === 0) return 0;
    const now = new Date().toISOString();
    const update = this.database.prepare("UPDATE query_runs SET status = 'retryable', retryable = 1, requires_explicit_retry = 0, completed_at = NULL WHERE id = ? AND status = 'completed'");
    let retried = 0;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      for (const run of runs) {
        if (Number(update.run(run.id).changes) === 0) continue;
        retried += 1;
        this.recordQueryRunEvent(jobId, run.id, "retryable", now);
      }
      this.database.exec("COMMIT;");
      return retried;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public listRetryableDownloadCandidateIds(jobId: string, providerIds: ProviderId[]): string[] {
    if (providerIds.length === 0) return [];
    return (this.database.prepare(`
      SELECT id
      FROM candidates
      WHERE job_id = ?
        AND provider_id IN (${providerIds.map(() => "?").join(",")})
        AND pipeline_state = 'discovered'
        AND pipeline_error = 'RETRYABLE_DOWNLOAD'
        AND NOT EXISTS (
          SELECT 1 FROM candidate_review_state
          WHERE candidate_review_state.candidate_id = candidates.id
            AND candidate_review_state.review_state = 'rejected'
        )
      ORDER BY rowid ASC
    `).all(jobId, ...providerIds) as unknown as Array<{ id: string }>).map((candidate) => candidate.id);
  }

  public runHasRetryableDownloadCandidate(runId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM candidate_hits
      JOIN candidates ON candidates.id = candidate_hits.candidate_id
      WHERE candidate_hits.query_run_id = ?
        AND candidates.pipeline_state = 'discovered'
        AND candidates.pipeline_error = 'RETRYABLE_DOWNLOAD'
        AND NOT EXISTS (
          SELECT 1 FROM candidate_review_state
          WHERE candidate_review_state.candidate_id = candidates.id
            AND candidate_review_state.review_state = 'rejected'
        )
      LIMIT 1
    `).get(runId));
  }

  public listRetryableRuns(jobId: string, providerIds: ProviderId[]): QueryRun[] {
    return this.listResumableRuns(jobId, providerIds).filter((run) => run.status === "retryable");
  }

  public previousRequestCount(run: Pick<QueryRun, "jobId" | "labelId" | "providerId" | "variantName" | "query" | "page">): number | null {
    const row = this.database.prepare(`
      SELECT request_count FROM query_runs
      WHERE job_id = ? AND label_id = ? AND provider_id = ? AND variant_name = ? AND query_text = ?
        AND page < ? AND request_count IS NOT NULL
      ORDER BY page DESC, rowid DESC LIMIT 1
    `).get(run.jobId, run.labelId, run.providerId, run.variantName, run.query, run.page) as { request_count: number | bigint } | undefined;
    return row ? Number(row.request_count) : null;
  }

  public previousPageExhausted(run: Pick<QueryRun, "jobId" | "labelId" | "providerId" | "variantName" | "query" | "page">): boolean {
    if (run.page <= 1) return false;
    const row = this.database.prepare(`
      SELECT query_runs.status, query_runs.request_count,
        COALESCE(query_runs.provider_hit_count, COUNT(DISTINCT candidate_hits.hit_id)) AS hit_count
      FROM query_runs LEFT JOIN candidate_hits ON candidate_hits.query_run_id = query_runs.id
      WHERE query_runs.job_id = ? AND query_runs.label_id = ? AND query_runs.provider_id = ?
        AND query_runs.variant_name = ? AND query_runs.query_text = ? AND query_runs.page = ?
      GROUP BY query_runs.id ORDER BY query_runs.rowid DESC LIMIT 1
    `).get(run.jobId, run.labelId, run.providerId, run.variantName, run.query, run.page - 1) as {
      status: QueryRunStatus;
      request_count: number | bigint | null;
      hit_count: number | bigint;
    } | undefined;
    return row?.status === "completed" && Number(row.hit_count) === 0;
  }

  public labelProgress(jobId: string): Array<{ labelId: string; candidateCount: number }> {
    return this.database.prepare(`
      SELECT targets.label_id AS labelId, COUNT(candidate_labels.candidate_id) AS candidateCount
      FROM label_targets AS targets LEFT JOIN candidate_labels ON candidate_labels.job_id = targets.job_id AND candidate_labels.label_id = targets.label_id
      WHERE targets.job_id = ? GROUP BY targets.label_id ORDER BY targets.rowid ASC
    `).all(jobId) as unknown as Array<{ labelId: string; candidateCount: number }>;
  }

  public candidateCount(jobId: string, labelId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM candidate_labels WHERE job_id = ? AND label_id = ?").get(jobId, labelId) as { count: number | bigint };
    return Number(row.count);
  }

  public listEvents(jobId: string, cursor?: number): SearchEvent[] {
    return this.database.prepare(`
      SELECT cursor, type, query_run_id, status, review_candidate_id, review_action, created_at FROM job_events WHERE job_id = ? AND cursor > ? ORDER BY cursor ASC
    `).all(jobId, cursor ?? 0).map((row) => {
      const event = row as { cursor: number | bigint; type: "query_run" | "review"; query_run_id: string | null; status: QueryRunStatus | "unreviewed" | "selected" | "rejected" | null; review_candidate_id: string | null; review_action: import("../../shared/contracts.js").ReviewAction | null; created_at: string };
      return { cursor: Number(event.cursor), type: event.type, runId: event.query_run_id, status: event.status, candidateId: event.review_candidate_id, action: event.review_action, createdAt: event.created_at };
    });
  }

  public allWorkSettled(jobId: string): boolean { return !this.hasActiveRuns(jobId); }

  public claimCandidate(candidateId: string): { id: string; jobId: string; providerId: ProviderId; imageUrl: string; thumbnailUrl: string | null } | undefined {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const thumbnailSelect = this.hasSearchHitThumbnails ? `(SELECT search_hits.thumbnail_url
            FROM candidate_hits
            JOIN search_hits ON search_hits.id = candidate_hits.hit_id
            WHERE candidate_hits.candidate_id = candidates.id
              AND search_hits.provider_id = candidates.provider_id
              AND search_hits.thumbnail_url IS NOT NULL
            ORDER BY candidate_hits.rowid ASC, search_hits.rowid ASC
            LIMIT 1)` : "NULL";
      const row = this.database.prepare(`
        SELECT candidates.id, candidates.job_id, candidates.provider_id, candidates.image_url,
          ${thumbnailSelect} AS thumbnail_url
        FROM candidates
        WHERE candidates.id = ? AND candidates.pipeline_state = 'discovered'
          AND NOT EXISTS (
            SELECT 1 FROM candidate_review_state
            WHERE candidate_review_state.candidate_id = candidates.id
              AND candidate_review_state.review_state = 'rejected'
          )
      `).get(candidateId) as { id: string; job_id: string; provider_id: ProviderId; image_url: string; thumbnail_url: string | null } | undefined;
      if (row) this.database.prepare("UPDATE candidates SET pipeline_state = 'fetching', pipeline_error = NULL, pipeline_failure_code = NULL WHERE id = ?").run(candidateId);
      this.database.exec("COMMIT;");
      return row ? { id: row.id, jobId: row.job_id, providerId: row.provider_id, imageUrl: row.image_url, thumbnailUrl: row.thumbnail_url } : undefined;
    } catch (error) { this.database.exec("ROLLBACK;"); throw error; }
  }

  public materializationTargets(candidateIds: string[]): CandidateMaterializationTarget[] {
    if (candidateIds.length === 0) return [];
    const providerByCandidate = new Map<string, ProviderId>();
    const uniqueIds = [...new Set(candidateIds)];
    const chunkSize = 500;
    for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
      const chunk = uniqueIds.slice(offset, offset + chunkSize);
      const rows = this.database.prepare(`
        SELECT candidates.id, candidates.provider_id
        FROM candidates
        WHERE candidates.id IN (${chunk.map(() => "?").join(",")})
          AND NOT EXISTS (
            SELECT 1 FROM candidate_review_state
            WHERE candidate_review_state.candidate_id = candidates.id
              AND candidate_review_state.review_state = 'rejected'
          )
      `).all(...chunk) as unknown as Array<{ id: string; provider_id: ProviderId }>;
      for (const row of rows) providerByCandidate.set(row.id, row.provider_id);
    }
    return candidateIds.flatMap((candidateId) => {
      const providerId = providerByCandidate.get(candidateId);
      return providerId === undefined ? [] : [{ candidateId, providerId }];
    });
  }

  public markCandidateProcessed(candidateId: string, assetId: string, warnings: string[]): void {
    this.database.prepare("UPDATE candidates SET pipeline_state = 'processed', pipeline_error = NULL, pipeline_failure_code = NULL, pipeline_warnings_json = ? WHERE id = ? AND EXISTS (SELECT 1 FROM candidate_assets WHERE candidate_id = ? AND asset_id = ?)")
      .run(JSON.stringify(warnings), candidateId, candidateId, assetId);
  }

  public markCandidateFailure(candidateId: string, state: "discovered" | "invalid" | "quarantined", error: string, failureCode?: RetryableDownloadFailureCode | null): void {
    this.database.prepare("UPDATE candidates SET pipeline_state = ?, pipeline_error = ?, pipeline_failure_code = ? WHERE id = ?")
      .run(state, error, isRetryableDownloadFailureCode(failureCode) ? failureCode : null, candidateId);
  }

  public getThumbnail(assetId: string): { normalizedSha256: string } | undefined {
    const row = this.database.prepare("SELECT normalized_sha256, source_sha256 FROM assets WHERE id = ?").get(assetId) as { normalized_sha256: string | null; source_sha256: string } | undefined;
    return row ? { normalizedSha256: row.normalized_sha256 ?? row.source_sha256 } : undefined;
  }

  public listCandidatesRequiringCacheRebuild(): string[] {
    return (this.database.prepare(`
      SELECT candidates.id
      FROM candidates
      WHERE candidates.pipeline_state = 'discovered'
        AND candidates.pipeline_error IN ('CACHE_REBUILD_REQUIRED', 'DOWNLOAD_INTERRUPTED')
        AND NOT EXISTS (
          SELECT 1 FROM candidate_review_state
          WHERE candidate_review_state.candidate_id = candidates.id
            AND candidate_review_state.review_state = 'rejected'
        )
      ORDER BY candidates.rowid ASC
    `).all() as unknown as Array<{ id: string }>).map((candidate) => candidate.id);
  }

  private recordQueryRunEvent(jobId: string, runId: string, status: QueryRunStatus, now: string): void {
    this.database.prepare("INSERT INTO job_events (job_id, type, query_run_id, status, created_at) VALUES (?, 'query_run', ?, ?, ?)")
      .run(jobId, runId, status, now);
  }

  private transition(
    runId: string,
    expectedStatus: QueryRunStatus,
    nextStatus: QueryRunStatus,
    errorSummary: string | null = null,
    retryable = false,
    providerHitCount?: number,
    requiresExplicitRetry = false
  ): boolean {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const run = this.database.prepare("SELECT job_id FROM query_runs WHERE id = ? AND status = ?").get(runId, expectedStatus) as { job_id: string } | undefined;
      if (!run) {
        this.database.exec("COMMIT;");
        return false;
      }
      if (nextStatus === "running") {
        this.database.prepare("UPDATE query_runs SET status = 'running', retryable = 0, requires_explicit_retry = 0, started_at = ? WHERE id = ?").run(now, runId);
      } else {
        this.database.prepare("UPDATE query_runs SET status = ?, retryable = ?, requires_explicit_retry = ?, error_summary = ?, provider_hit_count = COALESCE(?, provider_hit_count), completed_at = ? WHERE id = ?")
          .run(nextStatus, retryable ? 1 : 0, nextStatus === "retryable" && requiresExplicitRetry ? 1 : 0, errorSummary, providerHitCount ?? null, now, runId);
      }
      this.recordQueryRunEvent(run.job_id, runId, nextStatus, now);
      this.database.exec("COMMIT;");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }
}
