import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import type { FastifyInstance } from "fastify";
import { createTestApp, makeTempDataDir } from "./server.js";
import { makePng } from "./assets.js";

export async function createExportReadyApp(options: { dataDir?: string; onExportGenerationStart?: () => void; testBeforeExportTransaction?: () => void; contractualStorageRights?: boolean } = {}): Promise<FastifyInstance> {
  const dataDir = options.dataDir ?? await makeTempDataDir();
  const app = await createTestApp({ dataDir, assetService: false, contractualStorageRights: options.contractualStorageRights ?? true, onExportGenerationStart: options.onExportGenerationStart, testBeforeExportTransaction: options.testBeforeExportTransaction });
  app.addHook("onClose", async () => { await rm(dataDir, { recursive: true, force: true }); });
  const db = (app as FastifyInstance & { database?: import("../../src/server/database.js").AppDatabase }).database!;
  db.prepare("INSERT INTO jobs VALUES ('job-1', 'Export job', 'advertiser_product_taxonomy', 'internal_research', 'reviewing', '{}', 'now', 'now')").run();
  db.prepare("INSERT INTO taxonomy_nodes VALUES ('job-1', 'L1', NULL, 'Speakers', '[\"Speakers\"]')").run();
  db.prepare("INSERT INTO taxonomy_nodes VALUES ('job-1', 'L2', NULL, 'Headphones', '[\"Headphones\"]')").run();
  db.prepare("INSERT INTO label_targets (job_id, label_id, product, config_json) VALUES ('job-1', 'L1', 'Speaker', '{}')").run();
  db.prepare("INSERT INTO label_targets (job_id, label_id, product, config_json) VALUES ('job-1', 'L2', 'Headphone', '{}')").run();
  db.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, landing_page_url, pipeline_state, rights_status, created_at) VALUES ('candidate-1', 'job-1', 'https://image.example/a', 'fake', 'https://image.example/a?productId=42&width=800&signature=no&AWSAccessKeyId=aws-secret&x-oss-signature=oss-secret#private', 'https://shop.example/item?productId=42&token=secret&client_token=client-secret&oauth_nonce=oauth-secret&GoogleAccessId=google-secret#private', 'processed', 'unknown', 'now')").run();
  db.prepare("INSERT INTO candidate_labels VALUES ('candidate-1', 'job-1', 'L1')").run();
  db.prepare("INSERT INTO query_runs (id, job_id, label_id, provider_id, variant_name, query_text, status, created_at) VALUES ('run-1', 'job-1', 'L1', 'fake', 'seed', 'speaker', 'completed', 'now')").run();
  db.prepare("INSERT INTO search_hits (id, job_id, provider_id, normalized_image_url, image_url, landing_page_url, rights_status) VALUES ('hit-1', 'job-1', 'fake', 'https://source.example/item', 'https://alice:pw@source.example/item?JWT=super-secret&expires=999', 'file:///Users/alice/private-cookie.txt', 'unknown')").run();
  db.prepare("INSERT INTO candidate_hits VALUES ('candidate-1', 'hit-1', 'run-1')").run();
  const bytes = await makePng({ width: 800, height: 600 }); const hash = createHash("sha256").update(bytes).digest("hex");
  db.prepare("INSERT INTO assets VALUES ('asset-1', ?, ?, ?, '0000000000000000', 800, 600, 4, 'image/png', 'thumb', 'now')").run(hash, hash, hash);
  db.prepare("INSERT INTO candidate_assets VALUES ('candidate-1', 'asset-1', 'now')").run();
  db.prepare("INSERT INTO candidates (id, job_id, normalized_image_url, provider_id, image_url, pipeline_state, rights_status, created_at) VALUES ('candidate-2', 'job-1', 'https://image.example/b', 'fake', 'https://image.example/b', 'processed', 'unknown', 'now')").run();
  db.prepare("INSERT INTO candidate_labels VALUES ('candidate-2', 'job-1', 'L1')").run();
  db.prepare("INSERT INTO candidate_assets VALUES ('candidate-2', 'asset-1', 'now')").run();
  db.prepare("INSERT INTO search_hits (id, job_id, provider_id, normalized_image_url, image_url, rights_status) VALUES ('hit-2', 'job-1', 'fake', 'https://source.example/other', 'https://source.example/other?session=secret', 'unknown')").run();
  db.prepare("INSERT INTO candidate_hits VALUES ('candidate-2', 'hit-2', 'run-1')").run();
  await mkdir(join(dataDir, "cache", "assets", hash.slice(0, 2)), { recursive: true });
  await writeFile(join(dataDir, "cache", "assets", hash.slice(0, 2), hash), bytes);
  return app;
}

export async function waitAndReadZip(app: FastifyInstance, exportId: string) {
  let response;
  for (let i = 0; i < 100; i += 1) { response = await app.inject({ method: "GET", url: `/api/exports/${exportId}` }); if (response.json().status !== "generating") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  if (!response || response.json().status !== "ready") throw new Error(`Export was not ready: ${response?.body}`);
  const downloaded = await app.inject({ method: "GET", url: `/api/exports/${exportId}/download` });
  if (downloaded.statusCode !== 200) throw new Error(`Could not download export: ${downloaded.body}`);
  const contents = unzipSync(Buffer.from(downloaded.rawPayload)); const rawFiles = Object.keys(contents).sort();
  const firstSegment = rawFiles[0]?.split("/", 1)[0] ?? null;
  const rootDirectory = firstSegment && rawFiles.every((name) => name.startsWith(`${firstSegment}/`)) ? firstSegment : null;
  const files = rootDirectory ? rawFiles.map((name) => name.slice(rootDirectory.length + 1)) : rawFiles;
  const archivedName = (name: string) => rootDirectory ? `${rootDirectory}/${name}` : name;
  return { rootDirectory, rawFiles, files, bytes: (name: string) => Buffer.from(contents[archivedName(name)]!), text: (name: string) => strFromU8(contents[archivedName(name)]!), allText: () => files.filter((name) => !name.startsWith("images/")).map((name) => strFromU8(contents[archivedName(name)]!)).join("\n") };
}
