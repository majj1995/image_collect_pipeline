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
