import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../../src/server/database.js";
import { createExportReadyApp } from "../helpers/archive.js";

const apps: Awaited<ReturnType<typeof createExportReadyApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("candidate read contract", () => {
  it("returns local asset metadata and discovery labels without exposing signed source URLs", async () => {
    const app = await createExportReadyApp();
    apps.push(app);
    const database = (app as typeof app & { database: AppDatabase }).database;
    database.prepare("INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, page, status, created_at) VALUES ('run-2', 'job-1', 'L1', 'brave', 'style AccessKeyId=variant-access-secret', '智能音箱 Access Key ID: query-access-secret; 电商海报', 2, 'completed', 'later')").run();
    database.prepare(`
      INSERT INTO search_hits (
        id, job_id, provider_id, normalized_image_url, image_url, landing_page_url,
        title, creator, license_name, license_url, source_provider, source, rights_status
      ) VALUES (
        'hit-3', 'job-1', 'brave', 'https://cdn.example/speaker',
        'https://cdn.example/speaker?width=1200&token=image-secret',
        'https://ads.example/campaign?id=42&signature=landing-secret',
        '暑期音箱促销 AccessKeySecret=title-access-secret', '品牌旗舰店 SecretAccessKey=creator-secret; verified', 'Licensed secret=license-secret',
        'https://rights.example/licenses/42?access_token=rights-secret',
        'Access Key ID: provider-access-secret; Brave Images', '/home/alice/provider-private.json', 'provider_claimed'
      )
    `).run();
    database.prepare("INSERT INTO candidate_hits VALUES ('candidate-1', 'hit-3', 'run-2')").run();
    database.prepare("UPDATE candidates SET title = ? WHERE id = 'candidate-1'").run("规范标题 /private/var/folders/candidate.db; token=canonical-secret\u0000");
    await app.inject({ method: "POST", url: "/api/jobs/job-1/reviews", payload: { candidateIds: ["candidate-1"], action: "set_rights_evidence", rightsBasis: "licensed", rightsEvidence: "https://e.test/receipt/42" } });
    database.prepare("UPDATE candidate_review_state SET rights_evidence = 'https://e.test/evidence?AccessKeyId=legacy-evidence-secret#/private/var/db' WHERE candidate_id = 'candidate-1'").run();

    const response = await app.inject({ method: "GET", url: "/api/jobs/job-1/candidates" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      id: "candidate-1",
      width: 800,
      height: 600,
      mimeType: "image/png",
      discoveryLabelIds: ["L1"],
      imageUrl: "https://image.example/a?productId=42&width=800",
      landingPageUrl: "https://shop.example/item?productId=42",
      title: "规范标题 [REDACTED]; [REDACTED]",
      rightsEvidence: null,
      provenance: expect.arrayContaining([
        expect.objectContaining({
          hitId: "hit-1",
          queryRunId: "run-1",
          provider: "fake",
          variantName: "seed",
          query: "speaker",
          page: 1,
          imageUrl: null,
          landingPageUrl: null
        }),
        expect.objectContaining({
          hitId: "hit-3",
          queryRunId: "run-2",
          provider: "brave",
          variantName: "style [REDACTED]",
          query: "智能音箱 [REDACTED]; 电商海报",
          page: 2,
          imageUrl: "https://cdn.example/speaker?width=1200",
          landingPageUrl: "https://ads.example/campaign?id=42",
          title: "暑期音箱促销 [REDACTED]",
          creator: "品牌旗舰店 [REDACTED]; verified",
          licenseName: "Licensed [REDACTED]",
          licenseUrl: "https://rights.example/licenses/42",
          sourceProvider: "[REDACTED]; Brave Images",
          source: "[REDACTED]",
          rightsStatus: "provider_claimed"
        })
      ])
    });
    expect(response.body).not.toMatch(/signature|accesskey|accessid|client[_-]?token|oauth|super-secret|alice:pw|\/private\/|\/home\/|image-secret|landing-secret|rights-secret|source-secret|provider-secret|access-secret|variant-secret|query-secret|title-secret|creator-secret|license-secret|canonical-secret|legacy-evidence-secret|\u0000/i);
  });
});
