import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const e2eDataDir = join(tmpdir(), `multimodal-data-expansion-e2e-${process.pid}`);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: `NODE_ENV=test ALLOW_TEST_FIXTURES=1 DATA_DIR=${e2eDataDir} node --env-file-if-exists=.env --import tsx src/server/index.ts`,
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "npx vite --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
