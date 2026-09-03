# 下载占位恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让失败素材可被可靠重试、使用缩略图安全兜底，并在 UI 中准确区分来源拒绝、限流、网络和普通上游失败。

**Architecture:** `RETRYABLE_DOWNLOAD` 继续承担状态机语义，新增独立、白名单化的 `pipeline_failure_code` 承担诊断语义。素材服务统一执行安全下载、失败分类、来源级调度和缩略图兜底；搜索服务按提供方 URL 稳定性选择直接重排候选或重放发现查询；React 卡片只消费安全分类并处理本地缩略图错误。

**Tech Stack:** TypeScript 7、Fastify 5、SQLite、React 19、Vitest 4、Testing Library、Playwright

**Spec:** `docs/superpowers/specs/2026-09-01-download-placeholder-recovery-design.md`

## Global Constraints

- `pipeline_error = 'RETRYABLE_DOWNLOAD'` 必须继续作为所有人工可重试下载失败的状态值。
- 对外失败分类只能是 `FORBIDDEN | RATE_LIMITED | NETWORK | GENERIC | null`；不得保存或展示原始 URL、响应体、上游异常消息或任意 HTTP 状态文本。
- 主图和缩略图必须走同一套 DNS/SSRF、重定向、25 MB 上限、像素上限和媒体格式校验。
- ARTIC 最大下载并发必须为 1，相邻远程下载开始时间至少间隔 1000ms；不得降低其他提供方的全局并发能力。
- Snap Ads 与 TikTok Ads 必须继续通过查询重放刷新短期签名 URL；其他提供方优先直接重排既有失败候选。
- 已有 `pipeline_failure_code IS NULL` 的历史 `RETRYABLE_DOWNLOAD` 候选仍必须可重试。
- 不新增依赖，不改动与本次问题无关的双语查询和任务创建行为。

---

### Task 1: 安全失败分类与持久化

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/client/api.ts`
- Modify: `src/server/database.ts`
- Modify: `src/server/services/safe-url.ts`
- Modify: `src/server/repositories/search.ts`
- Modify: `src/server/services/asset-service.ts`
- Test: `tests/unit/safe-url.test.ts`
- Test: `tests/server/assets.test.ts`

**Interfaces:**
- Produces: `retryableDownloadFailureCodes`, `RetryableDownloadFailureCode`, `isRetryableDownloadFailureCode(value)` in shared contracts.
- Produces: `RemotePolicyError.failureCode: RetryableDownloadFailureCode | null`.
- Produces: `Candidate.pipelineFailureCode?: RetryableDownloadFailureCode | null` and a matching API schema field.
- Produces: `SearchRepository.markCandidateFailure(candidateId, state, error, failureCode?)`.

- [ ] **Step 1: Write failing classification and persistence tests**

Add table-driven assertions that 401/403 map to `FORBIDDEN`, 429 maps to `RATE_LIMITED`, timeout/transport rejection and 502/503/504 map to `NETWORK`, and other non-OK responses map to `GENERIC`. Assert `RemotePolicyError.code === 'DOWNLOAD_FAILED'`, the safe `failureCode`, and absence of response body/URL in serialized candidate data. Add a repository/service test that a final retryable failure stores `pipeline_error='RETRYABLE_DOWNLOAD'` plus the safe code and that a later successful claim clears both fields.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/unit/safe-url.test.ts tests/server/assets.test.ts`

Expected: FAIL because `failureCode`, `pipeline_failure_code`, and `pipelineFailureCode` do not exist.

- [ ] **Step 3: Implement the minimal classification contract**

Define the shared tuple and guard exactly as:

```ts
export const retryableDownloadFailureCodes = ["FORBIDDEN", "RATE_LIMITED", "NETWORK", "GENERIC"] as const;
export type RetryableDownloadFailureCode = typeof retryableDownloadFailureCodes[number];
export function isRetryableDownloadFailureCode(value: unknown): value is RetryableDownloadFailureCode {
  return typeof value === "string" && retryableDownloadFailureCodes.includes(value as RetryableDownloadFailureCode);
}
```

Extend `RemotePolicyError` with nullable `failureCode`. Classify only from numeric response status or controlled transport/deadline branches. Keep unsafe redirects/addresses and size failures on their existing terminal codes.

Add nullable `pipeline_failure_code` to new and existing databases. Select it in candidate reads, whitelist through `isRetryableDownloadFailureCode`, clear it during claim/success/invalid/quarantine/recovery/cache rebuild, and expose it as `pipelineFailureCode` through the candidate contract and client schema.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run tests/unit/safe-url.test.ts tests/server/assets.test.ts`

Expected: PASS, including existing unsafe URL, redirect, body cancellation, image validation and persistence tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts.ts src/client/api.ts src/server/database.ts src/server/services/safe-url.ts src/server/repositories/search.ts src/server/services/asset-service.ts tests/unit/safe-url.test.ts tests/server/assets.test.ts
git commit -m "fix: classify retryable image download failures"
```

### Task 2: 缩略图兜底与 ARTIC 下载节流

**Files:**
- Modify: `src/server/providers/types.ts`
- Modify: `src/server/providers/artic.ts`
- Modify: `src/server/providers/registry.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/repositories/search.ts`
- Modify: `src/server/services/asset-service.ts`
- Modify: `src/server/services/search-service.ts`
- Test: `tests/server/assets.test.ts`
- Test: `tests/server/keyless-provider-adapters.test.ts`
- Test: `tests/server/materialization-scheduling.test.ts`

**Interfaces:**
- Consumes: `RemotePolicyError.failureCode` and `RetryableDownloadFailureCode` from Task 1.
- Produces: `ProviderDownloadPolicy { maxConcurrency: number; minimumIntervalMs: number }` and optional `ImageSearchProvider.downloadPolicy`.
- Produces: `ProviderRegistry.downloadPolicy(providerId)`.
- Produces: `SearchRepository.claimCandidate(candidateId): { id; jobId; providerId; imageUrl; thumbnailUrl } | undefined`.
- Produces: `CandidateMaterializationTarget { candidateId; providerId }` and a provider-aware SearchService materialization queue.

- [ ] **Step 1: Write failing fallback and scheduler tests**

Add an asset integration test where the primary URL returns 503 for the configured attempts and a distinct persisted provider thumbnail returns a valid PNG; expect `processed`, primary requests before the thumbnail request, and cleared failure fields. Add a security test proving an unsafe primary URL is quarantined without fetching its thumbnail. Add two concurrent ARTIC candidates with a fake clock/sleep and gated fetch; assert remote fetch concurrency never exceeds one and every consecutive remote attempt reserves a 1000ms interval. Assert the ARTIC adapter publishes `{ maxConcurrency: 1, minimumIntervalMs: 1000 }`. Add a SearchService scheduling test whose queue begins with multiple ARTIC targets followed by another provider; assert only one ARTIC materialization is active while the other provider starts in a remaining global slot, proving no head-of-line blocking.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/server/assets.test.ts tests/server/keyless-provider-adapters.test.ts tests/server/materialization-scheduling.test.ts`

Expected: FAIL because claim does not return thumbnail/provider data and no provider download policy exists.

- [ ] **Step 3: Implement thumbnail lookup and provider scheduler**

In `claimCandidate`, select a thumbnail by joining `candidate_hits` to `search_hits`, requiring the same `provider_id` as the candidate, preferring the earliest linked hit, and returning null when none exists. Do not copy the URL into `candidates`. Add a repository mapping from candidate IDs to canonical `{ candidateId, providerId }` targets so SearchService does not query one row at a time.

Make the SearchService materialization queue provider-aware. Preserve the global limit of four, maintain active counts by provider, and scan for the first target whose provider is below its policy concurrency; a blocked ARTIC item at the front must not prevent a later non-ARTIC target from starting. On completion, decrement the provider count before draining again.

Also wrap each remote fetch attempt in an AssetService provider scheduler. The scheduler maintains per-provider active count, FIFO waiters, and the next reserved start timestamp. It reserves start times before awaiting sleep so concurrent callers cannot choose the same slot. Because SearchService allows only one active task for ARTIC, interval waits occupy at most one global slot while other providers keep progressing. Apply the same ARTIC policy through `ProviderRegistry`; use the existing global materialization concurrency for providers without a policy.

After retryable primary download failures, attempt a distinct thumbnail once. Unsafe URL/redirect and invalid/oversized media remain terminal and do not fall through from the primary URL. The thumbnail must use the same safe fetch and inspection path.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run tests/server/assets.test.ts tests/server/keyless-provider-adapters.test.ts tests/server/materialization-scheduling.test.ts tests/unit/safe-url.test.ts`

Expected: PASS, with fallback and ARTIC pacing assertions.

- [ ] **Step 5: Commit**

```bash
git add src/server/providers/types.ts src/server/providers/artic.ts src/server/providers/registry.ts src/server/app.ts src/server/repositories/search.ts src/server/services/asset-service.ts src/server/services/search-service.ts tests/server/assets.test.ts tests/server/keyless-provider-adapters.test.ts tests/server/materialization-scheduling.test.ts
git commit -m "fix: add safe thumbnail fallback and provider pacing"
```

### Task 3: 直接重试稳定地址并保留签名 URL 重放

**Files:**
- Modify: `src/server/providers/types.ts`
- Modify: `src/server/providers/snap-ads.ts`
- Modify: `src/server/providers/tiktok-ads.ts`
- Modify: `src/server/repositories/search.ts`
- Modify: `src/server/services/search-service.ts`
- Test: `tests/server/transient-download-url.test.ts`

**Interfaces:**
- Produces: optional `ImageSearchProvider.refreshDownloadUrlOnRetry` with default `false`.
- Produces: `SearchRepository.listRetryableDownloadCandidateIds(jobId, providerIds): string[]`.
- Consumes: existing `retryRunsForDownloadFailures(jobId, providerIds)` only for providers whose `refreshDownloadUrlOnRetry === true`.

- [ ] **Step 1: Write failing stable and transient recovery tests**

Add a stable provider integration case: first search discovers one candidate whose download exhausts with 503; after switching the fake fetch to a valid PNG, call the same search endpoint again and expect the existing candidate to become `processed` without a second provider discovery request. Keep the existing Snap signed-URL test and assert it still performs a second provider search, registers the fresh signed URL, and processes the same public candidate without persisting the signature.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/server/transient-download-url.test.ts`

Expected: stable-provider case FAILS because current retry only replays completed queries.

- [ ] **Step 3: Implement provider-aware recovery selection**

Mark Snap Ads and TikTok Ads with `refreshDownloadUrlOnRetry = true`. During `startJobSearch`, partition selected providers into stable and refresh-required groups. Enqueue existing `RETRYABLE_DOWNLOAD` candidate IDs for stable providers before planning runs; call `retryRunsForDownloadFailures` only for refresh-required providers. Keep generic historical failures eligible by querying on `pipeline_error`, not `pipeline_failure_code`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run tests/server/transient-download-url.test.ts tests/server/search-flow.test.ts tests/server/recovery.test.ts`

Expected: PASS; stable candidates retry directly and signed providers still replay exactly the original query.

- [ ] **Step 5: Commit**

```bash
git add src/server/providers/types.ts src/server/providers/snap-ads.ts src/server/providers/tiktok-ads.ts src/server/repositories/search.ts src/server/services/search-service.ts tests/server/transient-download-url.test.ts
git commit -m "fix: retry unfinished stable downloads directly"
```

### Task 4: 真实下载提示与本地缩略图回退

**Files:**
- Modify: `src/client/features/workbench/CandidateCard.tsx`
- Test: `tests/client/workbench.test.tsx`

**Interfaces:**
- Consumes: `Candidate.pipelineFailureCode` from Task 1.
- Produces fixed copy mapping: `FORBIDDEN → 下载被来源拒绝 / 该来源当前拒绝图片下载，请更换来源后继续搜索`; `RATE_LIMITED → 下载受限 / 来源请求过于频繁，请稍后继续搜索`; `NETWORK → 下载未完成 / 网络连接异常，请稍后继续搜索`; `GENERIC|null → 下载未完成 / 来源暂时无法提供图片，请稍后继续搜索`.

- [ ] **Step 1: Write failing rendering and image-error tests**

Convert the existing retryable-download test to table cases for all four safe codes plus null. For every case assert exact fixed copy, no automatic polling after five seconds, and an enabled top-level “继续搜索” button. Add a processed candidate case, fire the local thumbnail `error` event, and assert the `<img>` is removed and replaced by `本地缩略图不可用 / 请刷新任务或继续搜索重新生成` while review controls remain usable.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/client/workbench.test.tsx`

Expected: FAIL because the card ignores `pipelineFailureCode` and has no image error state.

- [ ] **Step 3: Implement fixed copy and image fallback**

Keep the existing placeholder DOM and CSS classes. Map only the shared whitelist values; unknown or null values use the generic copy. Track the failed `assetId` in component state, remove the broken image after `onError`, and retry automatically only when the candidate receives a different `assetId`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run tests/client/workbench.test.tsx`

Expected: PASS, including current polling, sensitive-image and review interactions.

- [ ] **Step 5: Commit**

```bash
git add src/client/features/workbench/CandidateCard.tsx tests/client/workbench.test.tsx
git commit -m "fix: explain unfinished downloads accurately"
```

### Task 5: 全量验证与本地浏览器验收

**Files:**
- Modify only when a verification failure demonstrates a regression in a file changed by Tasks 1-4.

**Interfaces:**
- Consumes all prior tasks; produces no new runtime API.

- [ ] **Step 1: Run static and automated verification**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Expected: all commands exit 0. If the proxy dispatcher test needs a loopback listener, rerun that test with the existing approved elevated Vitest prefix.

- [ ] **Step 2: Inspect stored failure recovery safely**

Against a temporary/test database, verify a 403 result is returned as `pipelineError='RETRYABLE_DOWNLOAD'` and `pipelineFailureCode='FORBIDDEN'`, a stable retry can reach `processed`, and no signed query token or raw upstream error appears in candidate JSON.

- [ ] **Step 3: Browser validation**

Use the in-app browser against `http://127.0.0.1:5173/`. Verify desktop and narrow viewport flows: unfinished cards show source-specific fixed copy, no broken image remains after a thumbnail failure, “继续搜索” remains available, and existing search/review controls still work. Check console errors and failed local API requests.

- [ ] **Step 4: Review final diff**

Run: `git diff --check`

Run a whole-change code review focused on retry races, SSRF bypasses, persistence compatibility and front-end terminal-state polling.
