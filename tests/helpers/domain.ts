import type { ExportCandidate, ExportContext } from "../../src/server/services/rights-policy.js";

export const makeContext = (overrides: Partial<ExportContext> = {}): ExportContext => ({
  mode: "internal_research", contractualStorageRights: true, taskType: "advertiser_product_taxonomy", ...overrides
});

export const makeCandidate = (overrides: Partial<ExportCandidate> = {}): ExportCandidate => ({
  id: "candidate-1", rightsStatus: "unknown", acknowledged: false,
  providerPolicy: "discovery_only", pipelineState: "processed", labelIds: ["L1"], ...overrides
});
