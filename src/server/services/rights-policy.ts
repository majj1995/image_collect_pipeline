import type { ExportMode, TaskType } from "../../shared/contracts.js";

export type EligibilityCode = "RIGHTS_UNVERIFIED" | "ACKNOWLEDGEMENT_REQUIRED" | "PROVIDER_STORAGE_RIGHTS_REQUIRED" | "LABEL_CONFLICT" | "ASSET_MISSING" | "ASSET_CHANGED" | "QUARANTINED";
export interface ExportContext { mode: ExportMode; contractualStorageRights: boolean; taskType: TaskType; }
export interface ExportCandidate {
  id: string;
  rightsStatus: "unknown" | "provider_claimed" | "verified" | "user_owned" | "cc0" | "pdm";
  acknowledged: boolean;
  providerPolicy: "open" | "discovery_only" | "contractual";
  pipelineState: "discovered" | "fetching" | "fetched" | "processed" | "invalid" | "quarantined";
  labelIds: string[];
  rightsBasis?: "unknown" | "verified_cc0" | "verified_pdm" | "cc0" | "pdm" | "user_owned" | "licensed";
  rightsEvidence?: string | null;
  providerPolicies?: Array<{ policy: "open" | "discovery_only" | "contractual"; contractualDeclared: boolean }>;
  assetPresent?: boolean;
  assetChanged?: boolean;
}
export interface Eligibility { eligible: boolean; blockerCode: EligibilityCode | null; warnings: string[]; }

export function isSafeRightsEvidence(value: string | null | undefined): value is string {
  if (!value || value.length > 300) return false;
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}

export function evaluateExportEligibility(candidate: ExportCandidate, context: ExportContext): Eligibility {
  const warnings: string[] = [];
  if (candidate.pipelineState === "quarantined") return { eligible: false, blockerCode: "QUARANTINED", warnings };
  if (candidate.pipelineState !== "processed" || candidate.assetPresent === false) return { eligible: false, blockerCode: "ASSET_MISSING", warnings };
  if (candidate.assetChanged) return { eligible: false, blockerCode: "ASSET_CHANGED", warnings };
  const policies = candidate.providerPolicies?.length ? candidate.providerPolicies : [{ policy: candidate.providerPolicy, contractualDeclared: context.contractualStorageRights }];
  if (policies.some((item) => item.policy === "contractual" && !item.contractualDeclared)) return { eligible: false, blockerCode: "PROVIDER_STORAGE_RIGHTS_REQUIRED", warnings };
  const matchingStatus = (candidate.rightsBasis === "verified_cc0" || candidate.rightsBasis === "cc0") ? candidate.rightsStatus === "cc0"
    : (candidate.rightsBasis === "verified_pdm" || candidate.rightsBasis === "pdm") ? candidate.rightsStatus === "pdm"
      : candidate.rightsBasis === "user_owned" ? candidate.rightsStatus === "user_owned"
        : candidate.rightsBasis === "licensed" ? candidate.rightsStatus === "verified" : false;
  const verified = matchingStatus && isSafeRightsEvidence(candidate.rightsEvidence);
  const discoveryOnly = policies.some((item) => item.policy === "discovery_only");
  if (context.mode === "strict_compliance" && (discoveryOnly || !verified)) return { eligible: false, blockerCode: "RIGHTS_UNVERIFIED", warnings };
  if (context.mode === "internal_research" && (discoveryOnly || !verified) && !candidate.acknowledged) return { eligible: false, blockerCode: "ACKNOWLEDGEMENT_REQUIRED", warnings };
  if (!verified) warnings.push("RIGHTS_UNVERIFIED");
  return { eligible: true, blockerCode: null, warnings };
}
