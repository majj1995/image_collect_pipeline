import { describe, expect, it } from "vitest";
import { inspectImage } from "../../src/server/services/asset-service.js";
import { fetchImageWithPolicy } from "../../src/server/services/safe-url.js";
import { makePng, publicOnlyResolver } from "../helpers/assets.js";

describe("configurable asset policy", () => {
  it("can tighten minimum dimensions and supported formats", async () => {
    const bytes = await makePng({ width: 256, height: 256 });
    await expect(inspectImage(bytes, {
      downloadTimeoutMs: 10_000,
      maxBytes: 10_000_000,
      maxPixels: 10_000_000,
      minDimension: 512,
      supportedFormats: ["image/png"]
    })).rejects.toMatchObject({ code: "IMAGE_TOO_SMALL" });
    await expect(inspectImage(bytes, {
      downloadTimeoutMs: 10_000,
      maxBytes: 10_000_000,
      maxPixels: 10_000_000,
      minDimension: 128,
      supportedFormats: ["image/jpeg"]
    })).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  });

  it("enforces a tightened streaming byte limit even without content-length", async () => {
    await expect(fetchImageWithPolicy("https://public.example/image.png", {
      resolver: publicOnlyResolver,
      fetch: async () => new Response(Buffer.alloc(1_025), { status: 200 }),
      maxBytes: 1_024
    })).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
  });
});
