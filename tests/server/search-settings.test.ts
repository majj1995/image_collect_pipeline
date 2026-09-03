import { afterEach, describe, expect, it } from "vitest";
import type { ImageSearchProvider, ProviderSearchRequest } from "../../src/server/providers/types.js";
import { createSpeakerJob, createTestApp, makeBilingualProfiles, waitForJob } from "../helpers/server.js";

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("search locale and safe-search settings", () => {
  it("applies locale/country while relaxing safe search only for an explicit moderation risk", async () => {
    const requests: ProviderSearchRequest[] = [];
    const provider: ImageSearchProvider = {
      id: "fake", displayName: "Recorder", configured: true, maxResults: 100, rightsPolicy: "open",
      async search(request) { requests.push(request); return []; }
    };
    const app = await createTestApp({ providers: [provider], assetService: false }); apps.push(app);
    const settings = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect((await app.inject({ method: "PUT", url: "/api/settings", payload: {
      ...settings,
      defaultLocale: "en-US",
      defaultCountry: "GB",
      safeSearch: false
    } })).statusCode).toBe(200);

    const taxonomyJob = await createSpeakerJob(app);
    await app.inject({ method: "POST", url: `/api/jobs/${taxonomyJob.id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, String(taxonomyJob.id), "reviewing");
    const taxonomyRequests = requests.splice(0);
    expect(taxonomyRequests).toHaveLength(5);
    expect(taxonomyRequests.every((request) => request.locale === "en-GB" && request.safeSearch)).toBe(true);

    const ordinaryModeration = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "普通审核", taskType: "content_moderation", exportMode: "internal_research", labelPaths: ["审核>风险"],
      labelSearchProfiles: makeBilingualProfiles(["审核>风险"])
    } });
    await app.inject({ method: "POST", url: `/api/jobs/${ordinaryModeration.json().id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, ordinaryModeration.json().id, "reviewing");
    expect(requests.splice(0).every((request) => request.safeSearch)).toBe(true);

    const explicitModeration = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "成人内容审核", taskType: "content_moderation", exportMode: "internal_research", labelPaths: ["审核>成人内容"],
      labelSearchProfiles: makeBilingualProfiles(["审核>成人内容"]),
      allowedRiskCategories: ["adult_content"]
    } });
    expect(explicitModeration.statusCode).toBe(201);
    await app.inject({ method: "POST", url: `/api/jobs/${explicitModeration.json().id}/search`, payload: { providerIds: ["fake"] } });
    await waitForJob(app, explicitModeration.json().id, "reviewing");
    expect(requests.splice(0).every((request) => request.locale === "en-GB" && !request.safeSearch)).toBe(true);
  });

  it("rejects non-allowlisted risk categories", async () => {
    const app = await createTestApp(); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "unsafe", taskType: "content_moderation", exportMode: "internal_research", labelPaths: ["审核>风险"],
      labelSearchProfiles: makeBilingualProfiles(["审核>风险"]),
      allowedRiskCategories: ["arbitrary_private_network_content"]
    } });
    expect(response.statusCode).toBe(400);
  });

  it("rejects the risk-category field entirely for taxonomy jobs, including an empty array", async () => {
    const app = await createTestApp(); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      name: "taxonomy must stay strict", taskType: "advertiser_product_taxonomy", exportMode: "internal_research", labelPaths: ["电商>音箱"],
      labelSearchProfiles: makeBilingualProfiles(["电商>音箱"]),
      allowedRiskCategories: []
    } });
    expect(response.statusCode).toBe(400);
  });
});
