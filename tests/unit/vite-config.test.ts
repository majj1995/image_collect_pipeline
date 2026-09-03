import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config.js";

describe("Vite development server", () => {
  it("binds only to the local loopback address", () => {
    expect(viteConfig.server?.host).toBe("127.0.0.1");
  });

  it("isolates browser assets from compiled server modules", () => {
    expect(viteConfig.build?.outDir).toBe("dist/client");
  });
});
