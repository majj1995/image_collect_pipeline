# Multimodal Training Data Expansion Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web tool that aggregates multiple image-search APIs, lets a user curate advertising and moderation datasets, and exports selected images with traceable metadata as a ZIP.

**Architecture:** A React/Vite client talks to a local Fastify server. The server owns credentials, SQLite state, provider adapters, bounded background work, image safety checks, review state, rights gates, and ZIP generation; providers normalize into one shared contract so any source can fail independently.

**Tech Stack:** Node.js 24+, TypeScript, React, Vite, Fastify, `node:sqlite`, Zod, Sharp, Archiver, Vitest, Testing Library, Playwright, plain CSS, Lucide React.

**Spec:** `docs/superpowers/specs/2026-08-29-multimodal-training-data-expansion-pipeline-design.md`

## Global Constraints

- Run locally as a single-user application and bind to `127.0.0.1` by default.
- Keep every provider credential on the server; never return a credential value to the client, logs, or ZIP files.
- Support `advertiser_product_taxonomy` with exactly one leaf label per exported asset and `content_moderation` with multiple labels.
- Support strict-compliance and internal-research export modes; user acknowledgement cannot override a provider contract that forbids storage or training.
- Search only through documented APIs. Do not scrape image-search HTML or bypass login, paywalls, anti-bot controls, or hotlink protection.
- Accept static JPEG, PNG, and WebP; reject SVG, animation, disguised HTML, files above 25 MB, images above 100 MP, and images with either side below 128 px.
- Treat dimensions below 512 px on either side as a warning rather than a blocker.
- Preserve full provenance while never placing credentials, cookies, local absolute paths, or signed authentication parameters in an export.
- Build the usable collection workbench first; do not add collaboration, cloud deployment, training execution, bounding boxes, or automatic final labels.

---

## Planned File Structure

```text
package.json                         scripts and dependencies
tsconfig.json                        browser/shared TypeScript config
tsconfig.server.json                 server build config
vite.config.ts                       Vite config and /api proxy
vitest.config.ts                     unit/integration test config
playwright.config.ts                 end-to-end config
index.html                           Vite entry document
src/shared/contracts.ts              Zod API schemas and inferred types
src/shared/taxonomy.ts               label parsing and stable IDs
src/shared/query-planner.ts           transparent query generation
src/server/config.ts                 environment and safe defaults
src/server/database.ts               SQLite connection and migrations
src/server/app.ts                    Fastify composition root
src/server/index.ts                  local process entry point
src/server/providers/types.ts        provider interface
src/server/providers/registry.ts     configuration and provider discovery
src/server/providers/openverse.ts    keyless/open provider
src/server/providers/brave.ts        Brave Images adapter
src/server/providers/baidu.ts        Baidu Qianfan adapter
src/server/providers/serpapi.ts      SerpApi Google Images adapter
src/server/providers/dataforseo.ts   DataForSEO Google Images adapter
src/server/providers/fake.ts         deterministic test adapter
src/server/repositories/jobs.ts      jobs and taxonomy persistence
src/server/repositories/search.ts    query runs, hits, candidates, provenance
src/server/repositories/reviews.ts   review events and current state
src/server/repositories/exports.ts   export snapshots and files
src/server/services/search-service.ts provider orchestration
src/server/services/safe-url.ts      SSRF and redirect validation
src/server/services/asset-service.ts download, inspect, hash, thumbnail
src/server/services/rights-policy.ts export eligibility
src/server/services/export-service.ts dataset folder and ZIP generation
src/server/routes/providers.ts       provider status endpoints
src/server/routes/jobs.ts            jobs, search, candidates, reviews
src/server/routes/exports.ts         preflight, generation, download
src/client/main.tsx                  React entry point
src/client/App.tsx                   router and global composition
src/client/api.ts                    typed API client
src/client/styles.css                complete visual system and responsive UI
src/client/components/AppShell.tsx   compact application shell
src/client/components/StatusBadge.tsx shared status primitive
src/client/pages/JobsPage.tsx        task home
src/client/pages/WorkbenchPage.tsx   collection workspace composition
src/client/pages/SettingsPage.tsx    provider and local policy status
src/client/features/jobs/CreateJobDialog.tsx task and label setup
src/client/features/workbench/LabelQueue.tsx taxonomy progress rail
src/client/features/workbench/CandidateGrid.tsx candidate gallery
src/client/features/workbench/CandidateCard.tsx image review card
src/client/features/workbench/CandidateDrawer.tsx provenance/details
src/client/features/workbench/ExportDialog.tsx rights preflight and export
tests/fixtures/providers/*.json       provider response contracts
tests/fixtures/images/*               deterministic static image fixtures
tests/helpers/server.ts               Fastify, temp-dir, and persistence helpers
tests/helpers/providers.ts            provider fetch fixtures and fake providers
tests/helpers/assets.ts               generated images, DNS, and redirect fixtures
tests/helpers/domain.ts               candidate and rights-policy factories
tests/helpers/archive.ts              ZIP inspection helpers
tests/helpers/client.tsx              routed React harness and typed API mock
tests/unit/*.test.ts                  pure unit tests
tests/server/*.test.ts                Fastify and repository tests
tests/client/*.test.tsx               component interaction tests
tests/e2e/collection-flow.spec.ts     final browser workflow
README.md                             setup, credentials, and usage
```

### Task 1: Project Foundation and Shared Contracts

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `index.html`
- Create: `src/shared/contracts.ts`
- Create: `src/server/config.ts`, `src/server/app.ts`, `src/server/index.ts`
- Create: `src/client/main.tsx`, `src/client/App.tsx`, `src/client/styles.css`
- Test: `tests/unit/contracts.test.ts`, `tests/server/health.test.ts`

**Interfaces:**
- Produces: `TaskType`, `ExportMode`, `ProviderId`, `Job`, `LabelTarget`, `Candidate`, `ProviderStatus`, `createApp(options)` and `loadConfig(env)`.
- Consumes: no earlier task.

- [ ] **Step 1: Add dependency manifests and test configuration**

Create the root scripts and dependency set:

```json
{
  "name": "multimodal-data-expansion-pipeline",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "concurrently -k \"vite\" \"tsx watch src/server/index.ts\"",
    "build": "vite build && tsc -p tsconfig.server.json",
    "start": "node dist/server/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.server.json"
  }
}
```

Install runtime dependencies `@fastify/static`, `archiver`, `fastify`, `file-type`, `ipaddr.js`, `lucide-react`, `react`, `react-dom`, `react-router-dom`, `sharp`, and `zod`; install development dependencies `@playwright/test`, `@testing-library/jest-dom`, `@testing-library/react`, `@testing-library/user-event`, `@types/archiver`, `@types/node`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `concurrently`, `fflate`, `jsdom`, `tsx`, `typescript`, `vite`, and `vitest`.

- [ ] **Step 2: Write failing contract and health tests**

```ts
import { describe, expect, it } from "vitest";
import { createJobInputSchema } from "../../src/shared/contracts.js";

describe("createJobInputSchema", () => {
  it("accepts a taxonomy task and rejects an empty label list", () => {
    expect(createJobInputSchema.parse({
      name: "音箱广告扩充",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商快销>3C及电器>影音电器>音箱"]
    }).labelPaths).toHaveLength(1);
    expect(() => createJobInputSchema.parse({
      name: "empty",
      taskType: "content_moderation",
      exportMode: "strict_compliance",
      labelPaths: []
    })).toThrow();
  });
});
```

```ts
import { expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";

it("reports a local healthy server without exposing secrets", async () => {
  const app = await createApp({ dataDir: ":memory:", env: {} });
  const response = await app.inject({ method: "GET", url: "/api/health" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, service: "素材扩展台" });
  expect(response.body).not.toContain("API_KEY");
  await app.close();
});
```

- [ ] **Step 3: Run the focused tests and confirm failure**

Run: `npm test -- tests/unit/contracts.test.ts tests/server/health.test.ts`  
Expected: FAIL because the shared contracts and `createApp` do not exist.

- [ ] **Step 4: Implement schemas, configuration, and the smallest app shell**

Define exact enums and typed records in `contracts.ts`:

```ts
export const taskTypeSchema = z.enum(["advertiser_product_taxonomy", "content_moderation"]);
export const exportModeSchema = z.enum(["strict_compliance", "internal_research"]);
export const providerIdSchema = z.enum(["openverse", "baidu", "brave", "serpapi", "dataforseo", "fake"]);
export const createJobInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  taskType: taskTypeSchema,
  exportMode: exportModeSchema,
  labelPaths: z.array(z.string().trim().min(1)).min(1).max(500),
  styles: z.array(z.string().trim().min(1)).default(["电商广告", "商品展示"]),
  requiredTerms: z.array(z.string().trim().min(1)).default([]),
  excludedTerms: z.array(z.string().trim().min(1)).default([]),
  targetCount: z.number().int().min(1).max(1000).default(30),
  candidateCount: z.number().int().min(1).max(1000).default(100)
});
```

Compose Fastify with `/api/health`, build a minimal React router, and proxy `/api` to `http://127.0.0.1:8787` in Vite.

- [ ] **Step 5: Verify foundation**

Run: `npm test -- tests/unit/contracts.test.ts tests/server/health.test.ts && npm run typecheck`  
Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 6: Commit foundation**

```bash
git add package.json package-lock.json tsconfig*.json vite.config.ts vitest.config.ts playwright.config.ts index.html src tests/unit/contracts.test.ts tests/server/health.test.ts
git commit -m "feat: scaffold local data expansion app"
```

### Task 2: Taxonomy, Query Planning, SQLite Jobs, and Job APIs

**Files:**
- Create: `src/shared/taxonomy.ts`, `src/shared/query-planner.ts`
- Create: `src/server/database.ts`, `src/server/repositories/jobs.ts`, `src/server/routes/jobs.ts`
- Create: `tests/helpers/server.ts`
- Modify: `src/server/app.ts`, `src/shared/contracts.ts`
- Test: `tests/unit/taxonomy.test.ts`, `tests/unit/query-planner.test.ts`, `tests/server/jobs.test.ts`

**Interfaces:**
- Consumes: `createJobInputSchema`, `TaskType`, `ExportMode` from Task 1.
- Produces: `parseLabelPaths(lines): ParsedTaxonomy`, `createLabelId(path): string`, `planQueries(target): QueryVariant[]`, `JobsRepository`, `createTestApp(options)`, and job CRUD endpoints.

- [ ] **Step 1: Write failing taxonomy and planner tests**

```ts
it("normalizes separators and produces a stable leaf id", () => {
  const parsed = parseLabelPaths([
    "电商快销 / 3C及电器 / 影音电器 / 音箱",
    "电商快销>3C及电器>影音电器>耳机"
  ]);
  expect(parsed.errors).toEqual([]);
  expect(parsed.leaves[0].path).toEqual(["电商快销", "3C及电器", "影音电器", "音箱"]);
  expect(parsed.leaves[0].id).toMatch(/^L[A-F0-9]{10}$/);
  expect(createLabelId(parsed.leaves[0].path)).toBe(parsed.leaves[0].id);
});

it("creates Chinese and English ad queries with exclusions", () => {
  const variants = planQueries({
    labelPath: ["电商快销", "3C及电器", "影音电器", "音箱"],
    product: "音箱",
    aliases: ["蓝牙音响"],
    styles: ["极简白底"],
    requiredTerms: ["促销价"],
    excludedTerms: ["买家秀"]
  });
  expect(variants.map((item) => item.query).join(" ")).toContain("音箱 电商海报");
  expect(variants.map((item) => item.query).join(" ")).toContain("product ad");
  expect(variants.every((item) => item.excludedTerms.includes("买家秀"))).toBe(true);
});
```

- [ ] **Step 2: Write failing job API persistence test**

```ts
it("creates a job with an immutable taxonomy snapshot", async () => {
  const app = await createTestApp();
  const created = await app.inject({
    method: "POST",
    url: "/api/jobs",
    payload: {
      name: "音箱任务",
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      labelPaths: ["电商快销>3C及电器>影音电器>音箱"]
    }
  });
  expect(created.statusCode).toBe(201);
  const body = created.json();
  expect(body.labels[0].product).toBe("音箱");
  const reloaded = await app.inject({ method: "GET", url: `/api/jobs/${body.id}` });
  expect(reloaded.json().labels).toEqual(body.labels);
  await app.close();
});
```

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- tests/unit/taxonomy.test.ts tests/unit/query-planner.test.ts tests/server/jobs.test.ts`  
Expected: FAIL because parsing, planning, persistence, and routes are absent.

- [ ] **Step 4: Implement taxonomy and query functions**

Use SHA-256 over the normalized path to create stable IDs:

```ts
export function createLabelId(path: string[]): string {
  const digest = createHash("sha256").update(path.join("\u001f")).digest("hex").slice(0, 10).toUpperCase();
  return `L${digest}`;
}

export function normalizePath(input: string): string[] {
  return input.normalize("NFKC").split(/\s*(?:>|\/|\t)\s*/u).map((part) => part.trim()).filter(Boolean);
}
```

Return line-specific errors for empty segments and duplicate normalized paths. `planQueries` must return four variants named `exact_ad`, `parent_disambiguated`, `style_required`, and `english_ad`.

- [ ] **Step 5: Implement SQLite schema and repository**

Create the database with WAL enabled for file-backed runs and the core tables:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, task_type TEXT NOT NULL,
  export_mode TEXT NOT NULL, status TEXT NOT NULL,
  settings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS taxonomy_nodes (
  job_id TEXT NOT NULL, label_id TEXT NOT NULL, parent_id TEXT,
  display_name TEXT NOT NULL, path_json TEXT NOT NULL,
  PRIMARY KEY (job_id, label_id), FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS label_targets (
  job_id TEXT NOT NULL, label_id TEXT NOT NULL, product TEXT NOT NULL,
  config_json TEXT NOT NULL, selected_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, label_id), FOREIGN KEY (job_id, label_id) REFERENCES taxonomy_nodes(job_id, label_id)
);
```

Wrap job creation and taxonomy insertion in one transaction. Register `GET /api/jobs`, `POST /api/jobs`, `GET /api/jobs/:jobId`, and `PATCH /api/jobs/:jobId`.

Also register `POST /api/jobs/:jobId/copy` to create a new job from the immutable configuration while clearing candidates/reviews, and `DELETE /api/jobs/:jobId` to delete only that job's database rows and content-addressed files that have no remaining references. The delete response is `204`; the UI must require a named confirmation before calling it.

Create `tests/helpers/server.ts` with `createTestApp(options)` that opens an isolated temporary database unless `dataDir` is supplied, registers optional provider overrides, and closes/removes only the temporary directory that it created. Also export `createSpeakerJob(app)`, `waitForJob(app, jobId, status)`, `makeTempDataDir()`, `seedInterruptedRunAndSelectedCandidate`, `readRunStatus`, `readReviewState`, and `assignLabels` for later server tests.

- [ ] **Step 6: Verify jobs and planners**

Run: `npm test -- tests/unit/taxonomy.test.ts tests/unit/query-planner.test.ts tests/server/jobs.test.ts && npm run typecheck`  
Expected: PASS; the job reload exactly matches its taxonomy snapshot.

- [ ] **Step 7: Commit taxonomy and jobs**

```bash
git add src/shared src/server/database.ts src/server/repositories/jobs.ts src/server/routes/jobs.ts src/server/app.ts tests
git commit -m "feat: add taxonomy jobs and query planning"
```

### Task 3: Provider Registry, Openverse, Search Orchestration, and Candidate Discovery

**Files:**
- Create: `src/server/providers/types.ts`, `src/server/providers/registry.ts`, `src/server/providers/openverse.ts`, `src/server/providers/fake.ts`
- Create: `src/server/repositories/search.ts`, `src/server/services/search-service.ts`, `src/server/routes/providers.ts`
- Create: `tests/helpers/providers.ts`
- Modify: `src/server/database.ts`, `src/server/routes/jobs.ts`, `src/server/app.ts`, `src/shared/contracts.ts`
- Test: `tests/fixtures/providers/openverse.json`, `tests/server/providers.test.ts`, `tests/server/search-flow.test.ts`

**Interfaces:**
- Consumes: `planQueries`, job label targets, shared `ProviderId`.
- Produces: `ImageSearchProvider.search(request, signal): Promise<NormalizedHit[]>`, `ProviderRegistry`, `SearchService.startJobSearch(jobId, input)`, `fixtureFetch`, `recordingFixtureFetch`, `successfulFakeProvider`, `failingFakeProvider`, `/api/providers`, `/api/jobs/:jobId/search`, and candidate listing.

- [ ] **Step 1: Write failing provider normalization test**

```ts
it("normalizes Openverse provenance and license data", async () => {
  const provider = new OpenverseProvider({ fetch: fixtureFetch("openverse.json") });
  const results = await provider.search({ query: "音箱 product ad", count: 20, locale: "zh-CN", safeSearch: true }, AbortSignal.timeout(1000));
  expect(results[0]).toMatchObject({
    provider: "openverse",
    imageUrl: "https://images.example.test/speaker.jpg",
    landingPageUrl: "https://source.example.test/speaker",
    licenseName: "cc0",
    rightsStatus: "provider_claimed"
  });
});
```

- [ ] **Step 2: Write failing multi-source flow test**

```ts
it("keeps successful candidates when another provider fails", async () => {
  const app = await createTestApp({ providers: [successfulFakeProvider("fake", 3), failingFakeProvider("openverse", 429)] });
  const job = await createSpeakerJob(app);
  const started = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/search`, payload: { providerIds: ["fake", "openverse"] } });
  expect(started.statusCode).toBe(202);
  await waitForJob(app, job.id, "reviewing");
  const candidates = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/candidates` });
  expect(candidates.json().items).toHaveLength(3);
  expect(candidates.json().providerRuns.some((run: { status: string }) => run.status === "failed")).toBe(true);
  await app.close();
});
```

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- tests/server/providers.test.ts tests/server/search-flow.test.ts`  
Expected: FAIL because provider types, registry, search tables, and orchestration do not exist.

- [ ] **Step 4: Implement provider contract and Openverse adapter**

```ts
export interface ImageSearchProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly rightsPolicy: "open" | "discovery_only" | "contractual";
  readonly configured: boolean;
  readonly maxResults: number;
  search(request: ProviderSearchRequest, signal: AbortSignal): Promise<NormalizedHit[]>;
}
```

Call `https://api.openverse.org/v1/images/` with `q`, `page_size`, `page`, and `mature=false`. Map `thumbnail`, `url`, `foreign_landing_url`, `title`, `creator`, `license`, `license_url`, `width`, `height`, `provider`, and `source`. Treat `cc0` and `pdm` as `provider_claimed`; all other licenses remain visible but are not strict-export eligible without verification.

In `tests/helpers/providers.ts`, load JSON from `tests/fixtures/providers`, return a `Response` from `fixtureFetch(name)`, collect cloned `Request` objects in `recordingFixtureFetch(calls)`, and expose deterministic successful/failing `ImageSearchProvider` instances that receive an explicit built-in `ProviderId` from the caller.

- [ ] **Step 5: Implement query-run, hit, and candidate persistence**

Add tables `query_runs`, `search_hits`, `candidates`, `candidate_hits`, and `candidate_labels`. Generate a hit identity from `provider + normalized image URL`; generate a candidate identity from normalized image URL until content hashes become available. Preserve every query-run relationship in `candidate_hits`.

Implement fair scheduling by running the first query variant for every label before the second variant. Use a bounded promise pool of four provider requests and record provider-local failures without rejecting the overall run.

- [ ] **Step 6: Register provider and search routes**

Return only safe status data:

```ts
{
  id: provider.id,
  displayName: provider.displayName,
  configured: provider.configured,
  enabled: provider.configured || provider.id === "openverse",
  rightsPolicy: provider.rightsPolicy,
  maxResults: provider.maxResults
}
```

`POST /api/jobs/:jobId/search` returns `202`; `GET /api/jobs/:jobId/candidates` returns paginated candidates, label progress, and provider-run summaries.

Register `POST /api/jobs/:jobId/pause` to mark pending query runs paused without deleting results, and `GET /api/jobs/:jobId/events` to return a stable cursor-ordered union of query-run and review events for lightweight polling.

- [ ] **Step 7: Verify search discovery**

Run: `npm test -- tests/server/providers.test.ts tests/server/search-flow.test.ts && npm run typecheck`  
Expected: PASS; a failed provider does not remove candidates from successful runs.

- [ ] **Step 8: Commit provider core**

```bash
git add src/server/providers src/server/repositories/search.ts src/server/services/search-service.ts src/server/routes src/server/database.ts src/shared/contracts.ts tests
git commit -m "feat: add provider registry and image discovery"
```

### Task 4: Brave, Baidu, SerpApi, and DataForSEO Adapters

**Files:**
- Create: `src/server/providers/brave.ts`, `src/server/providers/baidu.ts`, `src/server/providers/serpapi.ts`, `src/server/providers/dataforseo.ts`
- Create: `tests/fixtures/providers/brave.json`, `tests/fixtures/providers/baidu.json`, `tests/fixtures/providers/serpapi.json`, `tests/fixtures/providers/dataforseo.json`
- Modify: `src/server/providers/registry.ts`, `src/server/config.ts`
- Test: `tests/server/provider-adapters.test.ts`

**Interfaces:**
- Consumes: `ImageSearchProvider`, `NormalizedHit`, `ProviderSearchRequest` from Task 3.
- Produces: four adapter classes with identical normalized output and no credential leakage.

- [ ] **Step 1: Write failing response-contract tests for all four providers**

```ts
const adapterCases = [
  ["brave", (fetch: typeof globalThis.fetch) => new BraveProvider({ apiKey: "test-secret", fetch }), "https://api.search.brave.com/res/v1/images/search"],
  ["baidu", (fetch: typeof globalThis.fetch) => new BaiduProvider({ apiKey: "test-secret", fetch }), "https://qianfan.baidubce.com/v2/ai_search/web_search"],
  ["serpapi", (fetch: typeof globalThis.fetch) => new SerpApiProvider({ apiKey: "test-secret", fetch }), "https://serpapi.com/search.json"],
  ["dataforseo", (fetch: typeof globalThis.fetch) => new DataForSeoProvider({ login: "test-user", password: "test-secret", fetch }), "https://api.dataforseo.com/v3/serp/google/images/live/advanced"]
] as const;

it.each(adapterCases)("normalizes %s results and uses the documented endpoint", async (_id, factory, endpoint) => {
  const calls: Request[] = [];
  const provider = factory(recordingFixtureFetch(calls));
  const hits = await provider.search({ query: "speaker commercial poster", count: 40, locale: "zh-CN", safeSearch: true }, AbortSignal.timeout(1000));
  expect(calls[0].url.startsWith(endpoint)).toBe(true);
  expect(hits[0]).toMatchObject({ imageUrl: expect.stringMatching(/^https:/), landingPageUrl: expect.stringMatching(/^https:/) });
  expect(JSON.stringify(hits)).not.toMatch(/secret|password|api[_-]?key/i);
});
```

- [ ] **Step 2: Run adapter tests and confirm failure**

Run: `npm test -- tests/server/provider-adapters.test.ts`  
Expected: FAIL because the four adapters do not exist.

- [ ] **Step 3: Implement Brave and SerpApi adapters**

Brave uses `GET https://api.search.brave.com/res/v1/images/search`, header `X-Subscription-Token`, parameters `q`, `count` capped at 200, `country`, `search_lang`, and `safesearch`. SerpApi uses `GET https://serpapi.com/search.json`, parameters `engine=google_images`, `q`, `api_key`, `hl`, `gl`, and `safe=active`.

Map Brave `results` and SerpApi `images_results` defensively. Missing dimensions stay `null`; a missing original image URL drops the hit rather than fabricating a URL.

- [ ] **Step 4: Implement Baidu and DataForSEO adapters**

Baidu uses `POST https://qianfan.baidubce.com/v2/ai_search/web_search` with Bearer API key and this body shape: `{ messages: [{ role: "user", content: truncateBaiduQuery(query) }], search_source: "baidu_search_v2", resource_type_filter: [{ type: "image", top_k: Math.min(count, 30) }], safe_search: safeSearch }`. Implement `truncateBaiduQuery` to keep the documented 72-unit limit by counting ASCII code points as one unit and non-ASCII code points as two, without splitting a code point. DataForSEO uses Basic authentication and `POST https://api.dataforseo.com/v3/serp/google/images/live/advanced` with a one-item array containing `keyword`, `language_code`, `location_code`, and `depth` capped at 200.

Throw typed provider errors with status, `retryable`, and a Chinese user message. Never include request headers or raw credential-bearing URLs in the error.

- [ ] **Step 5: Add configuration and registry discovery**

`loadConfig` reads the seven credential variables from the spec. Instantiate every adapter but set `configured=false` when required values are absent. `/api/providers` must still list disabled providers so the UI can explain how to enable them.

- [ ] **Step 6: Verify every adapter**

Run: `npm test -- tests/server/provider-adapters.test.ts tests/server/providers.test.ts && npm run typecheck`  
Expected: PASS; all fixtures normalize and secret scans remain empty.

- [ ] **Step 7: Commit provider adapters**

```bash
git add src/server/providers src/server/config.ts tests/fixtures/providers tests/server/provider-adapters.test.ts
git commit -m "feat: integrate multiple image search APIs"
```

### Task 5: Safe Materialization, Image Inspection, and Deduplication

**Files:**
- Create: `src/server/services/safe-url.ts`, `src/server/services/asset-service.ts`
- Create: `tests/helpers/assets.ts`
- Modify: `src/server/database.ts`, `src/server/repositories/search.ts`, `src/server/services/search-service.ts`, `src/server/routes/jobs.ts`, `src/shared/contracts.ts`
- Test: `tests/unit/safe-url.test.ts`, `tests/server/assets.test.ts`, `tests/fixtures/images/README.md`

**Interfaces:**
- Consumes: discovered `Candidate` and `NormalizedHit` from Task 3.
- Produces: `assertSafeRemoteUrl(url, resolver)`, `materializeCandidate(candidateId)`, `computeDHash(buffer)`, `publicOnlyResolver`, `redirectingFetch`, `makePng`, asset metadata, thumbnails, and duplicate groups.

- [ ] **Step 1: Write failing SSRF tests**

```ts
it.each([
  "http://127.0.0.1/image.jpg",
  "http://169.254.169.254/latest/meta-data",
  "http://[::1]/image.png",
  "file:///etc/passwd"
])("blocks unsafe URL %s", async (url) => {
  await expect(assertSafeRemoteUrl(url, publicOnlyResolver)).rejects.toMatchObject({ code: "UNSAFE_REMOTE_URL" });
});

it("revalidates a redirect target", async () => {
  await expect(fetchImageWithPolicy("https://public.example/image", {
    fetch: redirectingFetch("http://10.0.0.2/private.jpg"), resolver: publicOnlyResolver
  })).rejects.toMatchObject({ code: "UNSAFE_REDIRECT" });
});
```

- [ ] **Step 2: Write failing image and dedupe tests**

```ts
it("rejects HTML disguised as JPEG and groups equal pixels", async () => {
  await expect(inspectImage(Buffer.from("<html>not an image</html>"))).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  const first = await makePng({ width: 800, height: 800, color: "#2559d6", metadata: false });
  const second = await makePng({ width: 800, height: 800, color: "#2559d6", metadata: true });
  const a = await inspectImage(first);
  const b = await inspectImage(second);
  expect(a.pixelSha256).toBe(b.pixelSha256);
  expect(a.dHash).toBe(b.dHash);
});
```

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- tests/unit/safe-url.test.ts tests/server/assets.test.ts`  
Expected: FAIL because URL and asset services do not exist.

- [ ] **Step 4: Implement safe downloading**

Use `new URL`, `dns.promises.lookup({ all: true })`, and `ipaddr.js` to reject loopback, private, link-local, multicast, unspecified, reserved, and carrier-grade NAT ranges. Re-run the check for each redirect, cap redirects at three, use a 20-second total abort signal, reject `content-length > 25_000_000`, and stop streaming after 25 MB even when the header is absent.

- [ ] **Step 5: Implement inspection and storage**

Use `file-type` before Sharp. Read metadata with `limitInputPixels: 100_000_000`; reject animation and unsupported formats. Create a normalized sRGB image, remove metadata, compute source SHA-256, pixel SHA-256, an 8x8 dHash, and a 480 px thumbnail. Store files by content hash under `.data/cache/assets/<sha-prefix>/<sha>` and `.data/cache/thumbnails/<sha>.webp`.

Create `tests/helpers/assets.ts`: `publicOnlyResolver` returns a fixed public documentation address for public hostnames, `redirectingFetch(target)` returns a 302 response, and `makePng(options)` uses Sharp to generate deterministic pixels with optional metadata.

Add `assets` and `candidate_assets` tables. Merge exact or normalized-pixel duplicates, set a near-duplicate group when Hamming distance is at most eight, and retain every provenance record.

- [ ] **Step 6: Connect bounded materialization to search**

After discovery, enqueue candidate downloads with concurrency four. Candidate listing must stream discovered items immediately and update `pipelineState` through `fetching`, `processed`, `invalid`, or `quarantined`. Expose thumbnails through `/api/media/:assetId/thumbnail`; never expose arbitrary filesystem paths.

- [ ] **Step 7: Verify asset pipeline**

Run: `npm test -- tests/unit/safe-url.test.ts tests/server/assets.test.ts tests/server/search-flow.test.ts && npm run typecheck`  
Expected: PASS; private addresses, disguised files, oversize images, and exact duplicates behave as specified.

- [ ] **Step 8: Commit asset safety**

```bash
git add src/server/services src/server/database.ts src/server/repositories/search.ts src/server/routes/jobs.ts src/shared/contracts.ts tests
git commit -m "feat: safely materialize and deduplicate images"
```

### Task 6: Reviews, Rights Gates, and Deterministic ZIP Export

**Files:**
- Create: `src/server/repositories/reviews.ts`, `src/server/repositories/exports.ts`
- Create: `src/server/services/rights-policy.ts`, `src/server/services/export-service.ts`, `src/server/routes/exports.ts`
- Create: `tests/helpers/domain.ts`, `tests/helpers/archive.ts`
- Modify: `src/server/database.ts`, `src/server/routes/jobs.ts`, `src/server/app.ts`, `src/shared/contracts.ts`
- Test: `tests/unit/rights-policy.test.ts`, `tests/server/reviews.test.ts`, `tests/server/export.test.ts`

**Interfaces:**
- Consumes: processed candidates/assets, job type, export mode, provider rights policy.
- Produces: `evaluateExportEligibility(candidate, context): Eligibility`, `makeCandidate`, `makeContext`, `createExportReadyApp`, `waitAndReadZip`, review event API, export preflight, ZIP generation, and download API.

- [ ] **Step 1: Write failing rights-policy tests**

```ts
const makeContext = (overrides: Partial<ExportContext> = {}): ExportContext => ({
  mode: "internal_research", contractualStorageRights: true, taskType: "advertiser_product_taxonomy", ...overrides
});
const makeCandidate = (overrides: Partial<ExportCandidate> = {}): ExportCandidate => ({
  id: "candidate-1", rightsStatus: "unknown", acknowledged: false,
  providerPolicy: "discovery_only", pipelineState: "processed", labelIds: ["L1"], ...overrides
});

it.each([
  ["strict_compliance", "unknown", false, "RIGHTS_UNVERIFIED"],
  ["internal_research", "unknown", false, "ACKNOWLEDGEMENT_REQUIRED"],
  ["internal_research", "unknown", true, null],
  ["internal_research", "verified", true, null]
])("evaluates %s / %s / acknowledged=%s", (mode, rightsStatus, acknowledged, blocker) => {
  expect(evaluateExportEligibility(makeCandidate({ rightsStatus, acknowledged }), makeContext({ mode })).blockerCode).toBe(blocker);
});

it("never allows acknowledgement to override a provider contract blocker", () => {
  const result = evaluateExportEligibility(makeCandidate({ acknowledged: true, providerPolicy: "contractual" }), makeContext({ contractualStorageRights: false }));
  expect(result.blockerCode).toBe("PROVIDER_STORAGE_RIGHTS_REQUIRED");
});
```

- [ ] **Step 2: Write failing review and ZIP tests**

```ts
it("persists review state and exports one manifest row per selected image", async () => {
  const app = await createExportReadyApp();
  await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: {
    candidateIds: ["candidate-1"], action: "select", rightsAcknowledged: true
  }});
  const created = await app.inject({ method: "POST", url: "/api/jobs/job-1/exports", payload: {} });
  expect(created.statusCode).toBe(202);
  const archive = await waitAndReadZip(app, created.json().id);
  expect(archive.files.filter((name) => name.startsWith("images/"))).toHaveLength(1);
  expect(archive.text("manifest.jsonl").trim().split("\n")).toHaveLength(1);
  expect(archive.text("checksums.sha256")).toContain("images/");
  expect(archive.allText()).not.toMatch(/API_KEY|\/Users\/|Cookie/i);
});
```

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- tests/unit/rights-policy.test.ts tests/server/reviews.test.ts tests/server/export.test.ts`  
Expected: FAIL because review, rights, and export modules are absent.

- [ ] **Step 4: Implement review events and current state**

Add `review_events` and `candidate_review_state` tables. Support `select`, `reject`, `restore`, `move_label`, `set_labels`, `acknowledge_rights`, and `override_warning`. For taxonomy tasks, enforce one primary leaf label; for moderation tasks, allow multiple labels plus one primary label.

Register `POST /api/jobs/:jobId/reviews` as a batch endpoint and update label selected counts in the same transaction.

- [ ] **Step 5: Implement rights evaluation and preflight**

Return blockers and warnings separately:

```ts
export type Eligibility = {
  eligible: boolean;
  blockerCode: "RIGHTS_UNVERIFIED" | "ACKNOWLEDGEMENT_REQUIRED" | "PROVIDER_STORAGE_RIGHTS_REQUIRED" | "LABEL_CONFLICT" | "ASSET_MISSING" | "ASSET_CHANGED" | "QUARANTINED" | null;
  warnings: string[];
};
```

Strict mode accepts verified CC0/PDM, user-owned, or evidence-backed rights. Internal mode accepts unknown rights only after acknowledgement and only when provider contract storage/training rights permit it.

- [ ] **Step 6: Implement deterministic export**

Create a temporary dataset directory, safely re-encode every selected asset, and write `README.md`, `dataset.json`, `taxonomy.json`, sorted `manifest.jsonl`, `reports/acquisition_summary.json`, and `checksums.sha256`. Use `<labelId>__<ascii-slug>/<candidateId>_<sha8>.<ext>` and Archiver to stream a ZIP. Atomically rename the completed ZIP and persist its SHA-256 and snapshot membership.

Create `tests/helpers/domain.ts` with the typed factories shown in Step 1. Create `tests/helpers/archive.ts` with `createExportReadyApp()` to seed one processed candidate and `waitAndReadZip(app, exportId)` to poll the export, open the ZIP, return sorted file names, `text(path)`, and `allText()`.

- [ ] **Step 7: Verify review and export**

Run: `npm test -- tests/unit/rights-policy.test.ts tests/server/reviews.test.ts tests/server/export.test.ts && npm run typecheck`  
Expected: PASS; strict and internal modes diverge correctly, and ZIP contents are deterministic and secret-free.

- [ ] **Step 8: Commit review and export**

```bash
git add src/server/repositories src/server/services/rights-policy.ts src/server/services/export-service.ts src/server/routes src/server/database.ts src/shared/contracts.ts tests
git commit -m "feat: add rights-aware review and dataset export"
```

### Task 7: Visual Concept, Application Shell, Jobs Dashboard, and Task Creation

**Files:**
- Create: `docs/design/collection-workbench-concept.png`, `docs/design/visual-inventory.md`
- Create: `src/client/api.ts`, `src/client/components/AppShell.tsx`, `src/client/components/StatusBadge.tsx`
- Create: `src/client/pages/JobsPage.tsx`, `src/client/pages/SettingsPage.tsx`, `src/client/features/jobs/CreateJobDialog.tsx`
- Create: `tests/helpers/client.tsx`
- Modify: `src/client/App.tsx`, `src/client/styles.css`
- Test: `tests/client/jobs-page.test.tsx`, `tests/client/create-job-dialog.test.tsx`

**Interfaces:**
- Consumes: job/provider APIs and shared schemas from Tasks 1–4.
- Produces: a polished local app shell, typed fetch client, `TestApp`, `mockApi`, dashboard, task creation flow, and accepted visual source of truth.

- [ ] **Step 1: Generate the visual concept before writing UI code**

Use ImageGen with this exact prompt and save the result at the concept path:

```text
Design a high-fidelity desktop web application screen for a local Chinese AI training-data curation tool named “素材扩展台”. Show the real working surface, not a marketing page: a restrained charcoal top bar, a narrow left taxonomy queue, a large center gallery of clean e-commerce advertising creatives, and a right provenance inspector. Use a crisp cool-white background, near-black text, cobalt-blue selected states, subtle gray rules, square-to-12px radii, compact but breathable typography, no gradients, no glassmorphism, no bento grid, no oversized hero, and no decorative analytics. The gallery should feel fast and editorial, with clear image ratios, tiny source/rights markers, and one strong blue “导出数据集” action. All visible UI copy must be simplified Chinese and legible. Native size 1600x1000.
```

Record exact colors, typography, spacing, icon style, allowed copy, container model, responsive behavior, and interaction states in `visual-inventory.md`. Because the user delegated visual decisions, accept the concept only when it matches this task's functional anatomy and has no decorative filler.

- [ ] **Step 2: Write failing dashboard and task-creation tests**

```tsx
it("creates a job from a pasted taxonomy path", async () => {
  render(<TestApp initialEntries={["/"]} />);
  await user.click(screen.getByRole("button", { name: "新建采集任务" }));
  await user.type(screen.getByLabelText("任务名称"), "音箱广告素材");
  await user.type(screen.getByLabelText("标签路径"), "电商快销>3C及电器>影音电器>音箱");
  await user.click(screen.getByRole("button", { name: "创建并进入工作台" }));
  expect(await screen.findByText("音箱广告素材")).toBeVisible();
  expect(screen.getByText("电商快销 / 3C及电器 / 影音电器 / 音箱")).toBeVisible();
});
```

- [ ] **Step 3: Run client tests and confirm failure**

Run: `npm test -- tests/client/jobs-page.test.tsx tests/client/create-job-dialog.test.tsx`  
Expected: FAIL because client pages and dialogs do not exist.

- [ ] **Step 4: Implement typed client and shell**

Provide one generic request function that parses responses through Zod and throws a Chinese `ApiError`. Build routes `/`, `/jobs/:jobId`, and `/settings`. The header contains only the “素材扩展台” mark, `采集任务`, `提供方`, and a compact connection status.

Create `tests/helpers/client.tsx` with a memory-router `TestApp`, a resettable `mockApi`, `WorkbenchTestApp`, and `ExportDialogTestApp`. Each wrapper injects typed API methods through one `ApiContext` so tests never monkey-patch `fetch` globally.

- [ ] **Step 5: Implement dashboard and creation flow**

Render tasks as an open list/table rather than a card grid. The creation dialog includes task type, export mode, task name, pasted label paths, styles, required terms, excluded terms, target count, and candidate count. Show line-level parsing errors before submission and display inherited defaults without hiding them.

- [ ] **Step 6: Verify dashboard UI**

Run: `npm test -- tests/client/jobs-page.test.tsx tests/client/create-job-dialog.test.tsx && npm run typecheck && npm run build`  
Expected: PASS; build emits the client and server without warnings that affect runtime.

- [ ] **Step 7: Commit dashboard UI**

```bash
git add docs/design src/client tests/client
git commit -m "feat: build task dashboard and creation flow"
```

### Task 8: Collection Workbench, Review Interactions, and Export UI

**Files:**
- Create: `src/client/pages/WorkbenchPage.tsx`
- Create: `src/client/features/workbench/LabelQueue.tsx`, `CandidateGrid.tsx`, `CandidateCard.tsx`, `CandidateDrawer.tsx`, `ExportDialog.tsx`
- Modify: `src/client/api.ts`, `src/client/App.tsx`, `src/client/styles.css`
- Test: `tests/client/workbench.test.tsx`, `tests/client/export-dialog.test.tsx`

**Interfaces:**
- Consumes: candidate/review/export endpoints from Tasks 3, 5, and 6 plus visual tokens from Task 7.
- Produces: the full human curation workflow and downloadable export state.

- [ ] **Step 1: Write failing workbench interaction tests**

```tsx
it("selects, rejects, filters, and opens provenance", async () => {
  render(<WorkbenchTestApp />);
  expect(await screen.findAllByRole("img", { name: /候选素材/ })).toHaveLength(4);
  await user.click(screen.getByRole("button", { name: "选择素材 1" }));
  await user.click(screen.getByRole("button", { name: "拒绝素材 2" }));
  await user.click(screen.getByRole("button", { name: "查看素材 1 详情" }));
  expect(screen.getByText("来源与授权")).toBeVisible();
  expect(screen.getByText("已选 1")).toBeVisible();
  await user.click(screen.getByLabelText("仅看未审核"));
  expect(screen.queryByAltText("候选素材 1")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Write failing export-preflight test**

```tsx
it("requires acknowledgement before internal-research export", async () => {
  render(<ExportDialogTestApp blocker="ACKNOWLEDGEMENT_REQUIRED" />);
  expect(screen.getByRole("button", { name: "生成 ZIP" })).toBeDisabled();
  await user.click(screen.getByLabelText("我已确认这些素材仅用于内部研发，并理解授权状态未知"));
  expect(screen.getByRole("button", { name: "生成 ZIP" })).toBeEnabled();
});
```

- [ ] **Step 3: Run client tests and confirm failure**

Run: `npm test -- tests/client/workbench.test.tsx tests/client/export-dialog.test.tsx`  
Expected: FAIL because workbench features do not exist.

- [ ] **Step 4: Implement workbench composition**

Build the approved three-region layout: a 260 px label rail, fluid gallery, and 380 px details drawer. The fixed top action bar includes `继续搜索`, `暂停`, `仅看未审核`, source/rights/size filters, and `导出数据集`. Keep remote images in stable aspect-ratio frames and display loading, invalid, quarantined, selected, and rejected states distinctly.

- [ ] **Step 5: Implement efficient review behavior**

Support click selection, Shift range selection, batch select/reject, duplicate-group collapse, “保留最高分辨率”, sibling-label moves, and keyboard shortcuts: `S` select, `R` reject, `J/K` next/previous, `O` source page, and `Esc` close drawer. Persist every action immediately and show optimistic state with rollback on API failure.

- [ ] **Step 6: Implement export flow**

Open preflight with counts for selected, ready, rights unknown, provider contract blockers, label conflicts, and missing assets. Internal mode provides the exact acknowledgement sentence from the test; strict mode offers no bypass. Poll export status only while generation is active, automatically start the browser download when a user-initiated export completes, and keep the server download URL visible for a manual retry.

- [ ] **Step 7: Verify workbench UI**

Run: `npm test -- tests/client/workbench.test.tsx tests/client/export-dialog.test.tsx && npm run typecheck && npm run build`  
Expected: PASS; selection, filtering, provenance, acknowledgement, and download states are rendered and interactive.

- [ ] **Step 8: Commit workbench**

```bash
git add src/client tests/client
git commit -m "feat: add image curation workbench and export UI"
```

### Task 9: Recovery, Moderation Mode, Settings, Documentation, and Full Browser Verification

**Files:**
- Modify: `src/server/config.ts`, `src/server/database.ts`, `src/server/services/search-service.ts`, `src/server/services/export-service.ts`
- Modify: `src/server/routes/providers.ts`, `src/server/routes/jobs.ts`, `src/server/routes/exports.ts`
- Create: `src/server/routes/settings.ts`
- Modify: `src/client/pages/SettingsPage.tsx`, `src/client/pages/WorkbenchPage.tsx`, `src/client/styles.css`
- Create: `tests/server/recovery.test.ts`, `tests/e2e/collection-flow.spec.ts`, `README.md`, `.env.example`, `.gitignore`
- Test: full suite plus desktop and mobile screenshots.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: restart-safe jobs, moderation-specific UX, provider settings status, reproducible setup, and final browser evidence.

- [ ] **Step 1: Write failing recovery and moderation tests**

```ts
it("recovers interrupted work without losing reviews", async () => {
  const dataDir = await makeTempDataDir();
  const first = await createTestApp({ dataDir });
  await seedInterruptedRunAndSelectedCandidate(first);
  await first.close();
  const second = await createTestApp({ dataDir });
  expect(await readRunStatus(second, "run-1")).toBe("retryable");
  expect(await readReviewState(second, "candidate-1")).toBe("selected");
  await second.close();
});

it("allows multiple labels only for moderation jobs", async () => {
  expect(await assignLabels("taxonomy-job", ["L1", "L2"])).toMatchObject({ statusCode: 409 });
  expect(await assignLabels("moderation-job", ["L1", "L2"])).toMatchObject({ statusCode: 200 });
});
```

- [ ] **Step 2: Run recovery tests and confirm failure**

Run: `npm test -- tests/server/recovery.test.ts`  
Expected: FAIL until startup recovery and multi-label enforcement are complete.

- [ ] **Step 3: Implement restart recovery and error summaries**

On startup, transactionally change `running` query runs to `retryable`, `fetching` candidates to `discovered`, and `generating` exports to `failed` with `EXPORT_INTERRUPTED`. Keep selected/rejected review rows unchanged. Add bounded exponential backoff with jitter for 429, timeout, and 5xx, and persist localized error summaries.

- [ ] **Step 4: Finish settings and moderation differences**

The settings page lists every provider, configured state, rights policy, max results, credential variable names, and a local contractual-rights switch. It never accepts or renders a secret value. Moderation workbench allows multi-label assignment, blurs sensitive thumbnails until clicked, and keeps safe search strict unless the job explicitly enables a permitted risk category.

Add a `local_settings` table keyed by setting name. Register `GET /api/settings` and `PUT /api/settings`; accepted writes are limited to default locale, country, safe-search preference, cache thresholds, and boolean contractual-rights declarations by provider ID. Reject any key containing `secret`, `token`, `password`, `credential`, or `apiKey`.

- [ ] **Step 5: Add deterministic E2E fixtures and final flow**

Enable the fake provider and a loopback fixture image endpoint only when `NODE_ENV=test` and `ALLOW_TEST_FIXTURES=1`; production startup must reject that combination outside test. The Playwright test performs:

```ts
test("creates, searches, reviews, exports, and downloads a dataset", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建采集任务" }).click();
  await page.getByLabel("任务名称").fill("音箱广告扩充");
  await page.getByLabel("标签路径").fill("电商快销>3C及电器>影音电器>音箱");
  await page.getByRole("button", { name: "创建并进入工作台" }).click();
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect(page.getByAltText(/候选素材/).first()).toBeVisible();
  await page.getByRole("button", { name: /选择素材/ }).first().click();
  await page.getByRole("button", { name: "导出数据集" }).click();
  await page.getByLabel(/我已确认这些素材仅用于内部研发/).check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "生成 ZIP" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
});
```

- [ ] **Step 6: Document setup and provider variables**

`README.md` must contain Node 24 prerequisite, `npm install`, `.env` setup, `npm run dev`, production build/start, provider capability table, dual rights-mode explanation, data directory, ZIP contents, test commands, and a concise statement that search discovery does not itself grant training rights. `.env.example` contains variable names with empty values only. `.gitignore` excludes `.env`, `.data`, `dist`, `node_modules`, Playwright artifacts, and generated ZIP files.

- [ ] **Step 7: Run complete automated verification**

Run: `npm test && npm run typecheck && npm run build && npm run test:e2e`  
Expected: every unit, integration, client, and browser test passes; build and typecheck exit zero.

- [ ] **Step 8: Perform browser and visual fidelity verification**

Start the real app, use the in-app browser first, and verify desktop at 1600x1000 plus a mobile-width viewport. Capture the current implementation screenshot, compare it with `docs/design/collection-workbench-concept.png` using image inspection, and write a fidelity ledger covering at least: copy, three-region layout, typography, cool-white/cobalt palette, image framing, spacing/container model, responsive behavior, icons, and selected/rejected states. Fix every material mismatch and confirm the real Openverse adapter returns normalized candidates when outbound network is available.

- [ ] **Step 9: Commit final verified application**

```bash
git add .
git commit -m "feat: complete local multimodal data expansion pipeline"
```
