import { createApp } from "./app.js";
import { loadConfig, prepareEnvironmentProxy } from "./config.js";

const config = loadConfig();
const environmentProxy = prepareEnvironmentProxy(process.env);
const app = await createApp({
  dataDir: config.dataDir,
  env: process.env,
  providerFetch: environmentProxy?.fetch,
  assetServiceOptions: environmentProxy ? { fetch: environmentProxy.fetch } : undefined,
  closeExternalResources: environmentProxy ? () => environmentProxy.close() : undefined,
  staticRoot: process.argv.includes("--serve-static") ? config.staticRoot : undefined
});

await app.listen({ host: "127.0.0.1", port: 8787 });
