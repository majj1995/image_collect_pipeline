import type { ReviewAction, ReviewInput, ReviewState, RightsBasis, TaskType } from "../../shared/contracts.js";
import type { AppDatabase } from "../database.js";
import { isSafeRightsEvidence } from "../services/rights-policy.js";

interface StateRow { candidate_id: string; review_state: ReviewState["reviewState"]; label_ids_json: string; primary_label_id: string | null; rights_acknowledged: number; rights_basis: RightsBasis; rights_evidence: string | null; warning_overrides_json: string; }
interface CandidateRow {
  id: string;
  pipeline_state: string;
  asset_id: string | null;
  width: number | bigint | null;
  height: number | bigint | null;
  near_duplicate_group: string | null;
  rights_status: NonNullable<ReviewState["rightsStatus"]>;
  provider_rights_status: NonNullable<ReviewState["rightsStatus"]>;
}

export class ReviewValidationError extends Error {
  public constructor(public readonly code: "CANDIDATE_NOT_FOUND" | "LABEL_NOT_FOUND" | "CANDIDATE_NOT_EXPORTABLE" | "INVALID_LABELS" | "INVALID_DUPLICATE_GROUP" | "TAXONOMY_LABEL_CONFLICT") { super(code); }
}

const asState = (row: StateRow): ReviewState => ({
  candidateId: row.candidate_id, reviewState: row.review_state, labelIds: JSON.parse(row.label_ids_json) as string[], primaryLabelId: row.primary_label_id,
  rightsAcknowledged: Boolean(row.rights_acknowledged), rightsBasis: row.rights_basis, rightsEvidence: isSafeRightsEvidence(row.rights_evidence) ? row.rights_evidence : null, warningOverrides: JSON.parse(row.warning_overrides_json) as string[]
});

function rightsStatusFor(basis: RightsBasis | undefined, evidence: string | null | undefined, providerStatus: NonNullable<ReviewState["rightsStatus"]>): NonNullable<ReviewState["rightsStatus"]> {
  if (!evidence) return providerStatus;
  if (basis === "verified_cc0" || basis === "cc0") return "cc0";
  if (basis === "verified_pdm" || basis === "pdm") return "pdm";
  if (basis === "user_owned") return "user_owned";
  if (basis === "licensed") return "verified";
  return providerStatus;
}

export class ReviewsRepository {
  public constructor(private readonly database: AppDatabase) {}

  public apply(jobId: string, input: ReviewInput, taskType: TaskType): ReviewState[] {
    const uniqueIds = [...new Set(input.candidateIds)];
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      let candidates = this.database.prepare(`SELECT c.id, c.pipeline_state, c.rights_status, c.provider_rights_status, c.near_duplicate_group, ca.asset_id, a.width, a.height FROM candidates c LEFT JOIN candidate_assets ca ON ca.candidate_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id WHERE c.job_id = ? AND c.id IN (${uniqueIds.map(() => "?").join(",")})`).all(jobId, ...uniqueIds) as unknown as CandidateRow[];
      if (candidates.length !== uniqueIds.length) throw new ReviewValidationError("CANDIDATE_NOT_FOUND");
      const labels = input.labelIds ? [...new Set(input.labelIds)] : undefined;
      if (labels) {
        const found = this.database.prepare(`SELECT label_id FROM label_targets WHERE job_id = ? AND label_id IN (${labels.map(() => "?").join(",")})`).all(jobId, ...labels) as Array<{ label_id: string }>;
        if (found.length !== labels.length) throw new ReviewValidationError("LABEL_NOT_FOUND");
      }
      if (input.primaryLabelId && labels && !labels.includes(input.primaryLabelId)) throw new ReviewValidationError("INVALID_LABELS");
      if (input.action === "keep_highest_resolution") {
        const groupId = candidates[0]?.near_duplicate_group;
        if (!groupId || candidates.some((candidate) => candidate.near_duplicate_group !== groupId)) throw new ReviewValidationError("INVALID_DUPLICATE_GROUP");
        const completeGroup = this.database.prepare("SELECT c.id, c.pipeline_state, c.rights_status, c.provider_rights_status, c.near_duplicate_group, ca.asset_id, a.width, a.height FROM candidates c LEFT JOIN candidate_assets ca ON ca.candidate_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id WHERE c.job_id = ? AND c.near_duplicate_group = ? ORDER BY c.id")
          .all(jobId, groupId) as unknown as CandidateRow[];
        const requestedIds = [...uniqueIds].sort();
        if (completeGroup.length !== requestedIds.length || completeGroup.some((candidate, index) => candidate.id !== requestedIds[index])) throw new ReviewValidationError("INVALID_DUPLICATE_GROUP");
        const deterministic = completeGroup.filter((candidate) => candidate.pipeline_state === "processed" && candidate.asset_id && candidate.width !== null && candidate.height !== null)
          .sort((left, right) => Number(right.width) * Number(right.height) - Number(left.width) * Number(left.height) || left.id.localeCompare(right.id))[0];
        if (!deterministic || input.primaryCandidateId !== deterministic.id) throw new ReviewValidationError("INVALID_DUPLICATE_GROUP");
        candidates = [deterministic, ...completeGroup.filter((candidate) => candidate.id !== deterministic.id)];
      }
      const now = new Date().toISOString();
      const states: ReviewState[] = [];
      for (const candidate of candidates) {
        const prior = this.readOrCreate(jobId, candidate.id, now);
        const transitionAction = input.action === "keep_highest_resolution" ? (candidate.id === input.primaryCandidateId ? "select" : "reject") : input.action;
        const next = this.transition(prior, candidate, transitionAction, labels, input.primaryLabelId, input.rightsAcknowledged, input.rightsBasis, input.rightsEvidence, input.warningCode, taskType);
        const nextRightsStatus = input.action === "set_rights_evidence" ? rightsStatusFor(input.rightsBasis, input.rightsEvidence, candidate.provider_rights_status) : candidate.rights_status;
        this.database.prepare("UPDATE candidates SET rights_status = ? WHERE id = ?").run(nextRightsStatus, candidate.id);
        if (transitionAction === "restore") {
          this.database.prepare(`
            UPDATE candidates
            SET pipeline_error = 'DOWNLOAD_INTERRUPTED', pipeline_failure_code = NULL
            WHERE id = ? AND pipeline_state = 'discovered' AND pipeline_error IS NULL
              AND NOT EXISTS (SELECT 1 FROM candidate_assets WHERE candidate_id = ?)
          `).run(candidate.id, candidate.id);
        }
        next.rightsStatus = nextRightsStatus;
        this.database.prepare(`UPDATE candidate_review_state SET review_state = ?, label_ids_json = ?, primary_label_id = ?, rights_acknowledged = ?, rights_basis = ?, rights_evidence = ?, warning_overrides_json = ?, updated_at = ? WHERE candidate_id = ?`)
          .run(next.reviewState, JSON.stringify(next.labelIds), next.primaryLabelId, next.rightsAcknowledged ? 1 : 0, next.rightsBasis, next.rightsEvidence, JSON.stringify(next.warningOverrides), now, candidate.id);
        this.database.prepare("INSERT INTO review_events (job_id, candidate_id, action, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(jobId, candidate.id, input.action, JSON.stringify({ labelIds: next.labelIds, primaryLabelId: next.primaryLabelId, rightsAcknowledged: next.rightsAcknowledged, rightsBasis: next.rightsBasis, rightsEvidence: next.rightsEvidence, rightsStatus: nextRightsStatus, warningCode: input.warningCode ?? null }), now);
        this.database.prepare("INSERT INTO job_events (job_id, type, query_run_id, status, review_candidate_id, review_action, created_at) VALUES (?, 'review', ?, ?, ?, ?, ?)")
          .run(jobId, null, next.reviewState, candidate.id, input.action, now);
        states.push(next);
      }
      this.recomputeSelectedCounts(jobId, taskType);
      this.database.exec("COMMIT;");
      return states;
    } catch (error) { this.database.exec("ROLLBACK;"); throw error; }
  }

  public list(jobId: string): ReviewState[] {
    return (this.database.prepare("SELECT candidate_id, review_state, label_ids_json, primary_label_id, rights_acknowledged, rights_basis, rights_evidence, warning_overrides_json FROM candidate_review_state WHERE job_id = ? ORDER BY candidate_id").all(jobId) as unknown as StateRow[]).map(asState);
  }

  private readOrCreate(jobId: string, candidateId: string, now: string): ReviewState {
    const existing = this.database.prepare("SELECT candidate_id, review_state, label_ids_json, primary_label_id, rights_acknowledged, rights_basis, rights_evidence, warning_overrides_json FROM candidate_review_state WHERE candidate_id = ?").get(candidateId) as unknown as StateRow | undefined;
    if (existing) return asState(existing);
    const state: ReviewState = { candidateId, reviewState: "unreviewed", labelIds: [], primaryLabelId: null, rightsAcknowledged: false, rightsBasis: "unknown", rightsEvidence: null, warningOverrides: [] };
    this.database.prepare("INSERT INTO candidate_review_state (candidate_id, job_id, review_state, label_ids_json, primary_label_id, rights_acknowledged, rights_basis, rights_evidence, warning_overrides_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(candidateId, jobId, state.reviewState, "[]", null, 0, "unknown", null, "[]", now);
    return state;
  }

  private transition(prior: ReviewState, candidate: CandidateRow, action: ReviewAction, suppliedLabels: string[] | undefined, suppliedPrimary: string | undefined, rightsAcknowledged: boolean | undefined, rightsBasis: RightsBasis | undefined, rightsEvidence: string | null | undefined, warningCode: string | undefined, taskType: TaskType): ReviewState {
    const next: ReviewState = { ...prior, labelIds: [...prior.labelIds], warningOverrides: [...prior.warningOverrides] };
    if (action === "select") {
      if (candidate.pipeline_state !== "processed" || !candidate.asset_id) throw new ReviewValidationError("CANDIDATE_NOT_EXPORTABLE");
      if (suppliedLabels) { next.labelIds = suppliedLabels; next.primaryLabelId = suppliedPrimary ?? (taskType === "advertiser_product_taxonomy" && suppliedLabels.length === 1 ? suppliedLabels[0]! : null); }
      next.reviewState = "selected";
      if (rightsAcknowledged === true) next.rightsAcknowledged = true;
    } else if (action === "reject") next.reviewState = "rejected";
    else if (action === "restore") next.reviewState = "unreviewed";
    else if (action === "acknowledge_rights") next.rightsAcknowledged = rightsAcknowledged ?? true;
    else if (action === "set_rights_evidence") { if (["verified_cc0", "verified_pdm", "cc0", "pdm", "user_owned", "licensed"].includes(rightsBasis ?? "unknown") && !rightsEvidence) throw new ReviewValidationError("INVALID_LABELS"); next.rightsBasis = rightsBasis ?? "unknown"; next.rightsEvidence = rightsEvidence ?? null; }
    else if (action === "override_warning") { if (!warningCode) throw new ReviewValidationError("INVALID_LABELS"); if (!next.warningOverrides.includes(warningCode)) next.warningOverrides.push(warningCode); }
    else {
      if (!suppliedLabels?.length) throw new ReviewValidationError("INVALID_LABELS");
      next.labelIds = suppliedLabels;
      next.primaryLabelId = suppliedPrimary ?? (taskType === "advertiser_product_taxonomy" && suppliedLabels.length === 1 ? suppliedLabels[0]! : null);
    }
    if (taskType === "advertiser_product_taxonomy") {
      if (next.labelIds.length > 1) throw new ReviewValidationError("TAXONOMY_LABEL_CONFLICT");
      if (action === "move_label" || action === "set_labels") {
        if (next.labelIds.length !== 1) throw new ReviewValidationError("INVALID_LABELS");
      }
      if (next.reviewState === "selected" && next.labelIds.length !== 1) throw new ReviewValidationError("INVALID_LABELS");
      if (next.labelIds.length === 1) next.primaryLabelId = next.labelIds[0]!;
    } else {
      if ((next.reviewState === "selected" || action === "set_labels" || action === "move_label") && (!next.labelIds.length || !next.primaryLabelId || !next.labelIds.includes(next.primaryLabelId))) throw new ReviewValidationError("INVALID_LABELS");
    }
    return next;
  }

  private recomputeSelectedCounts(jobId: string, taskType: TaskType): void {
    this.database.prepare("UPDATE label_targets SET selected_count = 0 WHERE job_id = ?").run(jobId);
    const rows = this.database.prepare("SELECT label_ids_json, primary_label_id FROM candidate_review_state WHERE job_id = ? AND review_state = 'selected'").all(jobId) as Array<{ label_ids_json: string; primary_label_id: string | null }>;
    const counts = new Map<string, number>();
    for (const row of rows) for (const labelId of taskType === "advertiser_product_taxonomy" ? [row.primary_label_id].filter((v): v is string => Boolean(v)) : JSON.parse(row.label_ids_json) as string[]) counts.set(labelId, (counts.get(labelId) ?? 0) + 1);
    const update = this.database.prepare("UPDATE label_targets SET selected_count = ? WHERE job_id = ? AND label_id = ?");
    for (const [labelId, count] of counts) update.run(count, jobId, labelId);
  }
}
