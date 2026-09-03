# Query Continuation Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every search query combination continue on its own next page, broaden exhausted singleton profiles with an explicit term-only query, and tell the user when an asynchronous search round adds no candidates.

**Architecture:** Derive the next discovery drafts from existing `query_runs` and add backward-compatible columns for raw provider hit counts and explicit-retry ownership. For each provider, schedule eligible next pages first and otherwise advance through deterministic base and supplemental waves. Track one client-side continuation round by candidate IDs so terminal zero-addition rounds are visible without changing the API response contract. Persist task-scoped source selection in the local browser and require an explicitly configured contact-bearing identity before enabling Wikimedia, then apply provider-scoped download pacing/cooldown with cancellation-safe reservations.

**Tech Stack:** TypeScript, Fastify, SQLite, React, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-09-02-query-continuation-pagination-design.md`

## Global Constraints

- Pagination identity is exactly `label + provider + variantName + query`; page is appended only for run deduplication.
- A completed non-empty short page advances; an empty page and `canRequestPage` rejection stop that combination.
- Provider scheduling priority is next page, then untried base query, then untried supplemental query.
- Singleton supplemental queries contain only the explicit term plus explicit required/excluded constraints.
- Ordinary Continue sends `retryFailedProviderIds: []`; only the dedicated provider retry action sends terminal provider IDs.
- Rejected candidates are excluded from every retryable-download recovery query.
- Preserve all pre-existing uncommitted changes in the working tree.

---

### Task 1: Query planner singleton fallback

**Files:**
- Modify: `tests/unit/query-planner.test.ts`
- Modify: `src/shared/query-planner.ts`

**Interfaces:**
- Consumes: `SearchProfileTarget`
- Produces: `planSupplementalSearchProfileQueries(profile): QueryVariant[]`, including one `term_only` variant for a one-term/one-style profile

- [x] **Step 1: Write the failing singleton test**

```ts
expect(planSupplementalSearchProfileQueries({
  terms: ["electric toothbrush"],
  styles: ["ecommerce advertisement"],
  requiredTerms: ["product"],
  excludedTerms: ["review photo"]
})).toEqual([{
  name: "term_only",
  query: 'electric toothbrush product -"review photo"',
  excludedTerms: ["review photo"]
}]);
```

- [x] **Step 2: Run `npm test -- tests/unit/query-planner.test.ts` and verify the new assertion fails because supplemental output is empty.**
- [x] **Step 3: Extend `QueryVariantName` with `term_only` and prepend the primary term-only supplemental variant while deduplicating it from base/cross-product queries.**
- [x] **Step 4: Re-run the unit test and verify it passes.**

### Task 2: Per-query continuation scheduler and recovery isolation

**Files:**
- Modify: `tests/server/search-replenishment.test.ts`
- Modify: `tests/server/search-scheduling-regressions.test.ts`
- Modify: `tests/server/search-retry.test.ts`
- Modify: `src/server/services/search-service.ts`
- Modify: `src/server/repositories/search.ts`

**Interfaces:**
- Consumes: existing `QueryRun[]`, `PlannedLabel[]`, selected providers and `canRequestPage(page,count)`
- Produces: fresh `QueryRunDraft[]` whose page is independent for every query-combination key

- [x] **Step 1: Add failing fake-provider tests** covering literal observations:
  - two queries where only the non-empty short page advances to page 2;
  - page 1 empty returns exhausted and never creates page 2;
  - `canRequestPage(2, count) === false` prevents page 2;
  - repeated continuation creates no duplicate `(label,provider,variant,query,page)` keys;
  - a terminally failed base query does not block an untried supplemental query;
  - a rejected `RETRYABLE_DOWNLOAD` candidate is absent from stable and signed-URL recovery.
- [x] **Step 2: Run the focused server tests and verify they fail on the provider-wide `lastPage`, full-page threshold, global supplemental gate, and rejected recovery behavior.**
- [x] **Step 3: Replace provider-wide page planning with query-specific draft planning:**

```ts
const combinationKey = (run: Pick<QueryRunDraft, "labelId" | "providerId" | "variantName" | "query">) =>
  [run.labelId, run.providerId, run.variantName, run.query].join("\0");

// Per provider: collect completed non-empty combinations whose next page is allowed.
// If none exist, collect untried base page-one drafts; if still none, collect untried supplemental page-one drafts.
// A pending/running/retryable/paused/failed latest run blocks only its own combination.
```

- [x] **Step 4: Plan fresh discovery even when resumable runs or materialization work exist, bounded by `MAX_SEARCH_RUNS_PER_START - resumableRuns.length`.**
- [x] **Step 5: Add `candidate_review_state` predicates so `retryRunsForDownloadFailures`, `listRetryableDownloadCandidateIds`, and `runHasRetryableDownloadCandidate` ignore `review_state='rejected'`.**
- [x] **Step 6: Re-run the focused server tests and keep existing retry/download regression tests green.**

### Task 3: Ordinary Continue semantics and zero-addition feedback

**Files:**
- Modify: `tests/client/workbench.test.tsx`
- Modify: `src/client/pages/WorkbenchPage.tsx`

**Interfaces:**
- Consumes: `startSearch(...): {status:"collecting"|"exhausted"}` and authoritative candidate pages
- Produces: ordinary Continue request with an empty retry list and one terminal zero-addition notice

- [x] **Step 1: Add failing UI tests** asserting:
  - ordinary Continue sends `{ providerIds: selectedProviderIds, retryFailedProviderIds: [] }` even when a selected provider has terminal failures;
  - `collecting → running → completed` with unchanged candidate IDs shows `本轮未新增素材；已选来源或查询可能已耗尽，请增加来源或调整条件。`;
  - the existing synchronous exhausted notice remains a separate branch.
- [x] **Step 2: Run `npm test -- tests/client/workbench.test.tsx` and verify the new tests fail for the current auto-retry and missing round tracker.**
- [x] **Step 3: Store the baseline candidate-ID set in a lifecycle/sequence-scoped ref only after a collecting response. When authoritative loading reaches a non-active terminal snapshot, clear the tracker and set the zero-addition notice only if no ID was added.**
- [x] **Step 4: Clear the tracker on job/lifecycle changes, pause, synchronous exhausted, and a new continuation request. Keep dedicated `retryFailedProvider` unchanged.**
- [x] **Step 5: Re-run the workbench tests and verify both notices and polling termination.**

### Task 4: Verification and real-task acceptance

**Files:**
- No production files

**Interfaces:**
- Consumes: completed Tasks 1–3
- Produces: fresh automated and local browser evidence

- [x] **Step 1: Run focused query-planner, replenishment, scheduling, retry/download and workbench tests.**
- [x] **Step 2: Run `npm test`, rerunning the loopback proxy test outside the sandbox if local bind is denied.**
- [x] **Step 3: Run `npm run typecheck` and `npm run build`.**
- [x] **Step 4: Restart the local application and use the in-app browser on the electric-toothbrush task. Verify Continue creates term-only runs, terminal Bing is not implicitly retried, no page-one run is duplicated, and the UI either displays new candidates or the explicit zero-addition notice.**

### Acceptance follow-up fixes

- [x] Persist task-scoped source selections and close the route-switch cross-task write window.
- [x] Persist raw provider hit counts and explicit provider-retry ownership with legacy migration coverage.
- [x] Prioritize explicit retries within the 2,000-run cap without losing cross-provider fairness.
- [x] Require an explicit contact-bearing Wikimedia identity, then add serial pacing, `Retry-After` handling, provider-wide exponential cooldown and cancellation-safe reservation rollback.
- [x] Re-run real task continuation through Wikimedia pages 1–3 and Baidu's supplemental Chinese query.
- [x] Expose explicit-only retry ownership to the workbench and add the dedicated retry entry for provider-originated retryable failures.
- [x] Enforce rejected-candidate exclusion through enqueue, target, claim and startup recovery, then requeue safely when a skipped candidate is restored.
- [x] Make provider download-slot waiting abort-aware without leaking concurrency reservations.
- [x] Unify the 2,000-run scheduler with cross-provider round-robin, prioritize already-created/fresh continuations, and prevent explicit or paused backlogs from starving legal next-page work.
- [x] Preserve historical raw provider hit counts when a resumed run completes without another provider request.
