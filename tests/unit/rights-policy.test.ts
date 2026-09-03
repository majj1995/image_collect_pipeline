import { describe, expect, it } from "vitest";
import { makeCandidate, makeContext } from "../helpers/domain.js";
import { evaluateExportEligibility } from "../../src/server/services/rights-policy.js";

describe("evaluateExportEligibility", () => {
  it.each([
    ["strict_compliance", "unknown", false, "RIGHTS_UNVERIFIED"],
    ["internal_research", "unknown", false, "ACKNOWLEDGEMENT_REQUIRED"],
    ["internal_research", "unknown", true, null],
    ["internal_research", "unknown", true, null]
  ] as const)("evaluates %s / %s / acknowledged=%s", (mode, rightsStatus, acknowledged, blocker) => {
    expect(evaluateExportEligibility(makeCandidate({ rightsStatus, acknowledged, rightsBasis: blocker === null ? "licensed" : "unknown" }), makeContext({ mode })).blockerCode).toBe(blocker);
  });

  it("never allows acknowledgement to override a provider contract blocker", () => {
    const result = evaluateExportEligibility(makeCandidate({ acknowledged: true, providerPolicy: "contractual" }), makeContext({ contractualStorageRights: false }));
    expect(result.blockerCode).toBe("PROVIDER_STORAGE_RIGHTS_REQUIRED");
  });

  it("requires acknowledgement for internal discovery-only provenance even with evidence", () => {
    expect(evaluateExportEligibility(makeCandidate({ rightsBasis: "licensed", acknowledged: false }), makeContext()).blockerCode).toBe("ACKNOWLEDGEMENT_REQUIRED");
    expect(evaluateExportEligibility(makeCandidate({ rightsBasis: "licensed", acknowledged: true }), makeContext()).eligible).toBe(true);
  });

  it("applies the strictest registered provenance policy", () => {
    const verifiedOpen = makeCandidate({ rightsStatus: "verified", rightsBasis: "licensed", rightsEvidence: "https://e.test/receipt-7", providerPolicies: [{ policy: "open", contractualDeclared: false }] });
    expect(evaluateExportEligibility(verifiedOpen, makeContext({ mode: "strict_compliance" })).eligible).toBe(true);
    expect(evaluateExportEligibility({ ...verifiedOpen, providerPolicies: [{ policy: "discovery_only", contractualDeclared: false }] }, makeContext({ mode: "strict_compliance" })).blockerCode).toBe("RIGHTS_UNVERIFIED");
    expect(evaluateExportEligibility({ ...verifiedOpen, acknowledged: true, providerPolicies: [{ policy: "contractual", contractualDeclared: false }] }, makeContext()).blockerCode).toBe("PROVIDER_STORAGE_RIGHTS_REQUIRED");
  });

  it.each(["verified_cc0", "verified_pdm", "user_owned", "licensed"] as const)("requires a safe evidence reference for strict %s", (rightsBasis) => {
    const rightsStatus = rightsBasis === "verified_cc0" ? "cc0" : rightsBasis === "verified_pdm" ? "pdm" : rightsBasis === "user_owned" ? "user_owned" : "verified";
    const candidate = makeCandidate({ rightsStatus, rightsBasis, rightsEvidence: null, providerPolicies: [{ policy: "open", contractualDeclared: false }] });
    expect(evaluateExportEligibility(candidate, makeContext({ mode: "strict_compliance" })).blockerCode).toBe("RIGHTS_UNVERIFIED");
    expect(evaluateExportEligibility({ ...candidate, rightsEvidence: "https://e.test/evidence/42" }, makeContext({ mode: "strict_compliance" })).eligible).toBe(true);
  });

  it("does not let evidence alone upgrade an unknown provider-derived status", () => {
    const candidate = makeCandidate({ rightsStatus: "unknown", rightsBasis: "licensed", rightsEvidence: "https://e.test/evidence/42", providerPolicies: [{ policy: "open", contractualDeclared: false }] });
    expect(evaluateExportEligibility(candidate, makeContext({ mode: "strict_compliance" })).blockerCode).toBe("RIGHTS_UNVERIFIED");
  });
});
