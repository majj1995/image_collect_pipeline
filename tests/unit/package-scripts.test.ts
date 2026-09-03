import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("local runtime scripts", () => {
  it("loads the optional local env file in development and serves the built SPA in production", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.dev).toContain("--env-file-if-exists=.env");
    expect(packageJson.scripts.start).toContain("--env-file-if-exists=.env");
    expect(packageJson.scripts.start).toContain("--serve-static");
  });
});
