# Free Image Provider Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before any completion claim. Independent adapter batches may run in parallel only when they edit disjoint files.

**Goal:** Expand the local collection tool into a free-only catalog of official image query/download channels, expose their setup state in the UI, and let the user choose which sources each search consumes.

**Architecture:** Preserve the existing normalized provider contract and SQLite workflow. Add scalable provider metadata, keep paid legacy IDs readable but out of the default registry, implement each official API as an isolated adapter, and make the client consume provider status dynamically instead of hardcoding IDs or labels.

**Tech Stack:** TypeScript, Fastify, React, Zod, Vitest, Testing Library, Playwright, existing safe downloader and SQLite orchestration.

**Spec:** `docs/superpowers/specs/2026-08-31-free-provider-expansion-design.md`

## Global constraints

- A provider enters the production registry only if it has an official API or official searchable metadata service and exposes a downloadable image URL.
- Do not scrape HTML, bypass login, or synthesize support for sources that only return an ad snapshot page.
- Never return or persist provider credential values. Query-string credentials may be sent to the provider endpoint but must never enter normalized hit URLs or errors.
- Preserve `brave` and `dataforseo` IDs and adapters for old database/export compatibility, but do not instantiate them in free-only defaults.
- All adapters must cap counts, bound pagination, propagate abort signals, normalize malformed fields defensively, and isolate failures with `ProviderError`.
- Real-network smoke checks use tiny result counts and never require a paid request.

---

### Task 1: Scalable Provider Contracts and Free-Only Registry

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/server/providers/types.ts`
- Modify: `src/server/providers/registry.ts`
- Modify: `src/server/providers/{openverse,baidu,brave,serpapi,dataforseo,fake}.ts`
- Modify: `src/server/config.ts`
- Modify: `src/server/routes/providers.ts`
- Modify: `src/client/api.ts`
- Test: `tests/unit/start-search-contract.test.ts`
- Test: `tests/server/providers.test.ts`
- Test: `tests/server/provider-adapters.test.ts`

- [ ] Write failing tests for every new provider ID, a 32-source request ceiling, partial contractual declarations restricted to known IDs, metadata returned without secret values, and Brave/DataForSEO absence from the default free registry.
- [ ] Run focused tests and confirm they fail for missing IDs/metadata.
- [ ] Add IDs: `wikimedia`, `met`, `cleveland`, `artic`, `loc`, `nasa`, `internet_archive`, `open_food_facts`, `smithsonian`, `rijksmuseum`, `bing_ads`, `snap_ads`, `europeana`, `pexels`, `pixabay`, `unsplash`, `flickr`, `harvard_art_museums`, `dpla`, `tiktok_ads` while retaining all legacy IDs.
- [ ] Add provider metadata fields: credential mode/variables, source category, free-tier copy, official docs URL, and default selection.
- [ ] Move enablement and provider route serialization to metadata-driven behavior; eliminate the hardcoded route credential map.
- [ ] Extend configuration with the required free-key and TikTok credentials.
- [ ] Replace duplicated client-side provider enums with the shared schema.
- [ ] Run focused tests and typecheck.

### Task 2: One-Request Keyless and Public Collection Adapters

**Files:**
- Create: `src/server/providers/wikimedia.ts`
- Create: `src/server/providers/cleveland.ts`
- Create: `src/server/providers/artic.ts`
- Create: `src/server/providers/loc.ts`
- Create: `src/server/providers/open-food-facts.ts`
- Create: `src/server/providers/smithsonian.ts`
- Create: `tests/server/keyless-provider-adapters.test.ts`
- Create: `tests/fixtures/providers/{wikimedia,cleveland,artic,loc,open-food-facts,smithsonian}.json`

- [ ] Add official-response fixtures and failing request/normalization tests, including Wikimedia bitmap filtering, LOC protocol-relative URLs, AIC IIIF URL construction, and Smithsonian media fallbacks.
- [ ] Confirm focused tests fail because adapters do not exist.
- [ ] Implement capped, paginated adapters using official endpoints and descriptive User-Agent headers where required.
- [ ] Confirm each adapter produces at least one credential-free `NormalizedHit` and never copies API credentials into public fields.
- [ ] Run focused tests and typecheck.

### Task 3: Two-Stage Keyless Adapters

**Files:**
- Create: `src/server/providers/met.ts`
- Create: `src/server/providers/nasa.ts`
- Create: `src/server/providers/internet-archive.ts`
- Create: `src/server/providers/rijksmuseum.ts`
- Create: `tests/server/two-stage-provider-adapters.test.ts`
- Create: `tests/fixtures/providers/{met-search,met-object,nasa-search,nasa-asset,archive-search,archive-metadata,rijks-search,rijks-object,rijks-visual,rijks-digital}.json`

- [ ] Write failing multi-response fetch tests that record every URL and model missing-image/detail failures.
- [ ] Confirm focused tests fail for missing adapters.
- [ ] Implement bounded detail fetching: local ID slicing for Met, `~orig` selection for NASA, original JPEG/PNG selection for Internet Archive, and JSON-LD relationship traversal for Rijksmuseum.
- [ ] Skip individual malformed/missing records without failing successful siblings; fail the provider only when its root query fails.
- [ ] Run focused tests and typecheck.

### Task 4: Anonymous Advertising APIs

**Files:**
- Create: `src/server/providers/bing-ads.ts`
- Create: `src/server/providers/snap-ads.ts`
- Create: `tests/server/ad-library-provider-adapters.test.ts`
- Create: `tests/fixtures/providers/{bing-ads,snap-ads}.json`

- [ ] Write failing tests for Bing `top/skip/searchText`, `AssetJson` parsing and image-only filtering.
- [ ] Write failing tests for Snap public POST search, cursor/next-link handling, and tolerant parsing of thumbnail/media download fields.
- [ ] Implement both adapters with strict count caps and no authentication material.
- [ ] Run focused tests and typecheck.

### Task 5: Free-Key Image APIs

**Files:**
- Create: `src/server/providers/europeana.ts`
- Create: `src/server/providers/pexels.ts`
- Create: `src/server/providers/pixabay.ts`
- Create: `src/server/providers/unsplash.ts`
- Create: `src/server/providers/flickr.ts`
- Create: `src/server/providers/harvard-art-museums.ts`
- Create: `src/server/providers/dpla.ts`
- Create: `tests/server/free-key-provider-adapters.test.ts`
- Create: `tests/fixtures/providers/{europeana,pexels,pixabay,unsplash,flickr,harvard-art-museums,dpla}.json`

- [ ] Write a table-driven failing suite asserting exact endpoints, header/query authentication, pagination, and normalized image/landing/creator/dimension fields.
- [ ] Confirm the tests fail before implementation.
- [ ] Implement adapters and treat missing keys as disabled through registry configuration rather than leaking an empty-key network call.
- [ ] Add provider-specific result fallbacks: Europeana shown-by/preview, Pexels original/large, Pixabay large/web, Unsplash full/regular, Flickr original/large/c, Harvard base image/primary, DPLA hasView/object.
- [ ] Run focused tests and typecheck.

### Task 6: TikTok Approved Free API

**Files:**
- Create: `src/server/providers/tiktok-ads.ts`
- Create: `tests/server/tiktok-provider-adapter.test.ts`
- Create: `tests/fixtures/providers/{tiktok-token,tiktok-ads}.json`

- [ ] Write failing tests for client-token exchange, token caching without public leakage, image-ad query body, search-id pagination, and `image_urls` normalization.
- [ ] Implement short-lived client-token caching with abort support and a safety margin before expiry.
- [ ] Keep the provider disabled until both client key and secret are configured.
- [ ] Run focused tests and typecheck.

### Task 7: Integrate All Free Providers

**Files:**
- Modify: `src/server/providers/registry.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Test: `tests/server/provider-adapters.test.ts`
- Test: `tests/server/providers.test.ts`

- [ ] Add a failing default-registry test covering the exact production catalog, anonymous enablement, free-key disablement, and no paid legacy providers.
- [ ] Register all new adapters with injected fetch and configuration.
- [ ] Document every environment variable, application link, free-mode limitation, and intentionally excluded source (Meta live images, ABO/Open Images live search).
- [ ] Run registry, route, configuration and adapter tests.

### Task 8: Provider Selection and Free-Mode UI

**Files:**
- Modify: `src/client/pages/WorkbenchPage.tsx`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/styles.css`
- Modify: `tests/helpers/client.tsx`
- Modify: `tests/client/workbench.test.tsx`
- Modify: `tests/client/settings-page.test.tsx`

- [ ] Write failing interaction tests for default source selection, selecting only no-key providers, preserving selected sources during search, disabled unconfigured sources, and dynamic provider labels in failure cards.
- [ ] Write failing settings tests for credential mode, source category, free tier and official application links.
- [ ] Implement an accessible source selector next to search controls with group actions and a clear selected count.
- [ ] Remove the hardcoded provider display-name record and use status metadata returned by the backend.
- [ ] Update the settings table for the expanded catalog without adding any secret input.
- [ ] Verify keyboard behavior, focus, narrow/mobile layout and no overflow.

### Task 9: Live Smoke Tests, Full Verification, Review and Handoff

**Files:**
- Create: `scripts/smoke-free-providers.ts` only if a reusable bounded smoke harness is needed
- Modify: tests/docs only for verified defects

- [ ] Run fixture/unit/integration suite: `npm test`.
- [ ] Run `npm run typecheck` and `npm run build`.
- [ ] Run tiny real-network searches for every anonymous provider through the user's local proxy; verify at least one image URL download when the API returns results, and record API-side empty/429 responses without hiding them.
- [ ] Start the app in the isolated worktree and perform browser QA of source selection, search, preview, filtering and ZIP download on desktop and mobile.
- [ ] Run `npm run test:e2e`.
- [ ] Request a final code review, fix all Critical/Important findings, and rerun the complete verification commands from a clean state.
- [ ] Integrate the verified branch into the user's local working branch, restart the project, and confirm `http://127.0.0.1:5173/` is ready for final acceptance.
