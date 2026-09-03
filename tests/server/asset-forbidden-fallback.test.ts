import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetService } from "../../src/server/services/asset-service.js";
import { createDatabase, type AppDatabase } from "../../src/server/database.js";
import { SearchRepository } from "../../src/server/repositories/search.js";
import { makePng, publicOnlyResolver } from "../helpers/assets.js";

const databases: AppDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("forbidden image download recovery", () => {
  it.each([401, 403] as const)("falls back immediately to the persisted thumbnail after HTTP %i", async (status) => {
    const { dataDir, database, searches } = await makeAssetFixture();
    const primaryUrl = "https://img.zcool.example/original.png";
    const thumbnailUrl = "https://img.zcool.example/thumbnail.png";
    const candidateId = seedCandidateHit(database, searches, primaryUrl, thumbnailUrl);
    const thumbnail = await makePng({ width: 800, height: 800 });
    const requested: string[] = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadRetryAttempts: 3,
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        return url === thumbnailUrl
          ? new Response(thumbnail, { headers: { "content-type": "image/png" } })
          : new Response("upstream denied hotlink", { status });
      }
    });

    await service.materializeCandidate(candidateId);

    expect(requested).toEqual([primaryUrl, thumbnailUrl]);
    expect(database.prepare("SELECT pipeline_state, pipeline_error, pipeline_failure_code FROM candidates WHERE id = ?").get(candidateId)).toEqual({
      pipeline_state: "processed",
      pipeline_error: null,
      pipeline_failure_code: null
    });
  });

  it("records one safe FORBIDDEN failure when no thumbnail is available", async () => {
    const { dataDir, database, searches } = await makeAssetFixture();
    const primaryUrl = "https://img.zcool.example/original.png?token=do-not-expose";
    const candidateId = seedCandidateHit(database, searches, primaryUrl, null);
    const requested: string[] = [];
    const service = new AssetService({
      database,
      searches,
      dataDir,
      resolver: publicOnlyResolver,
      downloadRetryAttempts: 3,
      fetch: async (input) => {
        requested.push(String(input));
        return new Response("upstream response body must stay private", { status: 403 });
      }
    });

    await service.materializeCandidate(candidateId);

    expect(requested).toEqual([primaryUrl]);
    expect(database.prepare("SELECT pipeline_state, pipeline_error, pipeline_failure_code FROM candidates WHERE id = ?").get(candidateId)).toEqual({
      pipeline_state: "discovered",
      pipeline_error: "RETRYABLE_DOWNLOAD",
      pipeline_failure_code: "FORBIDDEN"
    });
    const serializedCandidate = JSON.stringify(searches.listCandidates("job").items[0]);
    expect(serializedCandidate).not.toContain("do-not-expose");
    expect(serializedCandidate).not.toContain("upstream response body must stay private");
  });
});

async function makeAssetFixture(): Promise<{ dataDir: string; database: AppDatabase; searches: SearchRepository }> {
  const dataDir = await mkdtemp(join(tmpdir(), "asset-forbidden-fallback-test-"));
  directories.push(dataDir);
  const database = createDatabase(dataDir);
  databases.push(database);
  return { dataDir, database, searches: new SearchRepository(database) };
}

function seedCandidateHit(
  database: AppDatabase,
  searches: SearchRepository,
  imageUrl: string,
  thumbnailUrl: string | null
): string {
  database.prepare("INSERT INTO jobs VALUES ('job', 'job', 'advertiser_product_taxonomy', 'internal_research', 'draft', '{}', 'now', 'now')").run();
  database.prepare("INSERT INTO taxonomy_nodes VALUES ('job', 'label', NULL, 'Camera', '[\"Camera\"]')").run();
  database.prepare("INSERT INTO label_targets (job_id, label_id, product, config_json) VALUES ('job', 'label', 'Camera', '{}')").run();
  const run = searches.createRuns("job", [{ labelId: "label", providerId: "baidu", variantName: "base", query: "监控摄像头广告" }])[0]!;
  return searches.saveHits(run, [{
    provider: "baidu",
    rank: 1,
    imageUrl,
    thumbnailUrl,
    landingPageUrl: "https://www.zcool.example/camera-ad",
    title: "Camera advertisement",
    creator: null,
    licenseName: null,
    licenseUrl: null,
    width: 800,
    height: 800,
    sourceProvider: "baidu",
    source: "fixture",
    rightsStatus: "unknown"
  }], 1)[0]!;
}
