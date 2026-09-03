import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ZipArchive } from "archiver";
import { Unzip, UnzipInflate } from "fflate";
import sharp from "sharp";
import type { CandidateProvenance, TaskType } from "../../shared/contracts.js";
import { containsUnsafePublicMetadata, sanitizePublicHttpUrl, sanitizePublicSource, sanitizePublicText } from "../../shared/public-url.js";
import type { AppDatabase } from "../database.js";
import { ExportsRepository, type ExportRecord } from "../repositories/exports.js";
import { evaluateExportEligibility, isSafeRightsEvidence, type ExportCandidate } from "./rights-policy.js";
import { assertValidZipStructure } from "./zip-structure.js";
import type { ProviderRegistry } from "../providers/registry.js";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const fixedDate = new Date("1980-01-01T00:00:00.000Z");
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`; }
  return JSON.stringify(value);
};
const slug = (value: string, fallback = "label") => { const v = value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase(); return v || fallback; };
const countBy = (values: string[]): Record<string, number> => values.sort().reduce<Record<string, number>>((counts, value) => { counts[value] = (counts[value] ?? 0) + 1; return counts; }, {});
const assertSafeMetadata = (files: Map<string, Buffer>): void => { for (const [path, bytes] of files) if (!path.startsWith("images/") && containsUnsafePublicMetadata(bytes.toString("utf8"))) throw new Error("UNSAFE_EXPORT_METADATA"); };
const sha256File = async (path: string): Promise<string> => new Promise((resolvePromise, reject) => {
  const hash = createHash("sha256"); const input = createReadStream(path);
  input.on("data", (chunk) => hash.update(chunk)); input.on("error", reject); input.on("end", () => resolvePromise(hash.digest("hex")));
});

interface ReviewAudit { candidateId: string; rightsAcknowledged: boolean; rightsBasis: string; rightsEvidence: string | null; warningOverrides: string[]; }
interface SnapshotItem { assetId: string; normalizedSha256: string; sourceSha256: string; width: number; height: number; mimeType: string; selectedCandidateIds: string[]; sourceCandidateIds: string[]; canonicalCandidateId: string; labelIds: string[]; primaryLabelId: string; warnings: string[]; reviewAudit: ReviewAudit[]; provenance: CandidateProvenance[]; labelConfig: Record<string, unknown>[]; }
interface Snapshot { jobId: string; datasetSlug: string; taskType: TaskType; exportMode: string; contractualRightsDeclarations: Record<string, boolean>; items: SnapshotItem[]; acquisition: { queryRuns: number; providerCounts: Record<string, number> }; }
interface StagedFile { path: string; sha256: string; }
export interface Preflight { selected: number; uniqueAssets: number; ready: number; blockers: Record<string, string[]>; warnings: Record<string, string[]>; }
export interface ExportServiceOptions {
  onGenerationStart?: () => void;
  testBeforeCreateTransaction?: () => void;
  pathOperations?: PathOperations;
  sha256File?: (path: string) => Promise<string>;
}

export interface PathOperations {
  resolve(...paths: string[]): string;
  basename(path: string): string;
  relative(from: string, to: string): string;
}

const defaultPathOperations: PathOperations = { resolve, basename, relative };

export function isExpectedExportDownloadPath(
  dataDir: string,
  zipPath: string,
  exportId: string,
  pathOperations: PathOperations = defaultPathOperations
): boolean {
  const expectedName = `${exportId}.zip`;
  if (pathOperations.basename(expectedName) !== expectedName) return false;
  const exportRoot = pathOperations.resolve(dataDir, "exports");
  return pathOperations.relative(exportRoot, pathOperations.resolve(zipPath)) === expectedName;
}

export class ExportService {
  private readonly running = new Set<Promise<void>>();
  public constructor(private readonly database: AppDatabase, private readonly exports: ExportsRepository, private readonly dataDir: string, private readonly providers: ProviderRegistry, private readonly readContractualDeclarations: () => Record<string, boolean> = () => ({}), private readonly options: ExportServiceOptions = {}) {}
  public async close(): Promise<void> { await Promise.allSettled([...this.running]); }
  public preflight(jobId: string): { preflight: Preflight; snapshot: Snapshot | null } {
    const job = this.database.prepare("SELECT name, task_type, export_mode FROM jobs WHERE id = ?").get(jobId) as { name: string; task_type: TaskType; export_mode: "strict_compliance" | "internal_research" } | undefined;
    if (!job) throw new Error("JOB_NOT_FOUND");
    const contractualDeclarations = this.readContractualDeclarations();
    const selected = this.database.prepare(`SELECT c.id, c.provider_id, c.pipeline_state, c.rights_status, c.pipeline_warnings_json, ca.asset_id, a.source_sha256, a.normalized_sha256, a.width, a.height, a.mime_type, r.label_ids_json, r.primary_label_id, r.rights_acknowledged, r.rights_basis, r.rights_evidence, r.warning_overrides_json FROM candidate_review_state r JOIN candidates c ON c.id = r.candidate_id LEFT JOIN candidate_assets ca ON ca.candidate_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id WHERE r.job_id = ? AND r.review_state = 'selected' ORDER BY c.id`).all(jobId) as Array<Record<string, string | number | null>>;
    const blockers: Record<string, string[]> = {}; const warnings: Record<string, string[]> = {}; const blockedAssetIds = new Set<string>(); const group = (to: Record<string, string[]>, code: string, id: string) => { (to[code] ??= []).push(id); };
    const items = new Map<string, SnapshotItem>();
    for (const row of selected) {
      const candidateId = String(row.id); const assetId = row.asset_id ? String(row.asset_id) : null;
      const path = assetId && row.normalized_sha256 ? this.assetPath(String(row.normalized_sha256)) : null;
      let assetPresent = Boolean(path && existsSync(path)); let assetChanged = false;
      if (assetPresent && path) {
        try { assetChanged = sha256(readFileSync(path)) !== String(row.normalized_sha256); }
        catch { assetPresent = false; }
      }
      const policies = assetId ? this.assetProviderPolicies(jobId, assetId, contractualDeclarations) : [this.providerPolicy(String(row.provider_id), contractualDeclarations)];
      const safeEvidence = isSafeRightsEvidence(row.rights_evidence as string | null) ? row.rights_evidence as string : null;
      const candidate: ExportCandidate = { id: candidateId, rightsStatus: (row.rights_status as ExportCandidate["rightsStatus"]) ?? "unknown", rightsBasis: row.rights_basis as ExportCandidate["rightsBasis"], rightsEvidence: safeEvidence, acknowledged: Boolean(row.rights_acknowledged), providerPolicy: policies[0]!.policy, providerPolicies: policies, pipelineState: row.pipeline_state as ExportCandidate["pipelineState"], labelIds: JSON.parse(String(row.label_ids_json)) as string[], assetPresent, assetChanged };
      const eligibility = evaluateExportEligibility(candidate, { mode: job.export_mode, contractualStorageRights: policies.every((policy) => policy.contractualDeclared), taskType: job.task_type });
      if (!eligibility.eligible) { group(blockers, eligibility.blockerCode!, candidateId); if (assetId) blockedAssetIds.add(assetId); }
      for (const warning of eligibility.warnings) group(warnings, warning, candidateId);
      if (!assetId || !row.normalized_sha256 || !row.source_sha256 || !row.primary_label_id) continue;
      const item = items.get(assetId) ?? { assetId, normalizedSha256: String(row.normalized_sha256), sourceSha256: String(row.source_sha256), width: Number(row.width), height: Number(row.height), mimeType: String(row.mime_type), selectedCandidateIds: [], sourceCandidateIds: [], canonicalCandidateId: candidateId, labelIds: [], primaryLabelId: String(row.primary_label_id), warnings: JSON.parse(String(row.pipeline_warnings_json)) as string[], reviewAudit: [], provenance: [], labelConfig: [] };
      item.selectedCandidateIds.push(candidateId); item.labelIds = [...new Set([...item.labelIds, ...candidate.labelIds])].sort();
      item.reviewAudit.push({ candidateId, rightsAcknowledged: Boolean(row.rights_acknowledged), rightsBasis: String(row.rights_basis), rightsEvidence: safeEvidence, warningOverrides: JSON.parse(String(row.warning_overrides_json)) as string[] });
      if (candidateId < item.canonicalCandidateId) item.canonicalCandidateId = candidateId;
      if (job.task_type === "advertiser_product_taxonomy" && item.primaryLabelId !== String(row.primary_label_id)) { group(blockers, "LABEL_CONFLICT", assetId); blockedAssetIds.add(assetId); }
      if (job.task_type === "content_moderation" && String(row.primary_label_id) < item.primaryLabelId) item.primaryLabelId = String(row.primary_label_id);
      items.set(assetId, item);
    }
    const ordered = [...items.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
    for (const item of ordered) { item.selectedCandidateIds.sort(); item.canonicalCandidateId = item.selectedCandidateIds[0]!; item.sourceCandidateIds = this.assetCandidateIds(jobId, item.assetId); item.provenance = this.provenanceForAsset(jobId, item.assetId); item.labelConfig = this.labelConfig(jobId, item.labelIds); }
    const preflight: Preflight = { selected: selected.length, uniqueAssets: ordered.length, ready: ordered.filter((item) => !blockedAssetIds.has(item.assetId)).length, blockers, warnings };
    const providerCounts: Record<string, number> = {}; for (const item of ordered) for (const entry of item.provenance) if (entry.provider) providerCounts[entry.provider] = (providerCounts[entry.provider] ?? 0) + 1;
    const queryRuns = Number((this.database.prepare("SELECT COUNT(*) AS count FROM query_runs WHERE job_id = ?").get(jobId) as { count: number | bigint }).count);
    return { preflight, snapshot: selected.length ? { jobId, datasetSlug: slug(job.name, "dataset"), taskType: job.task_type, exportMode: job.export_mode, contractualRightsDeclarations: contractualDeclarations, items: ordered, acquisition: { queryRuns, providerCounts } } : null };
  }
  public create(jobId: string): { record?: ExportRecord; preflight: Preflight; code?: "JOB_NOT_FOUND" | "NO_SELECTED_ITEMS" | "PREFLIGHT_BLOCKED" } {
    this.options.testBeforeCreateTransaction?.();
    this.database.exec("BEGIN IMMEDIATE;");
    let created = false; let record: ExportRecord | undefined; let snapshot: Snapshot | null = null; let preflight!: Preflight;
    try {
      ({ preflight, snapshot } = this.preflight(jobId));
      if (!snapshot) { this.database.exec("COMMIT;"); return { preflight, code: "NO_SELECTED_ITEMS" }; }
      if (Object.keys(preflight.blockers).length) { this.database.exec("COMMIT;"); return { preflight, code: "PREFLIGHT_BLOCKED" }; }
      const snapshotJson = stableJson(snapshot); const snapshotHash = sha256(snapshotJson); const id = `export_${snapshotHash.slice(0, 24)}`;
      ({ record, created } = this.exports.createOrGetInTransaction(id, jobId, snapshotJson, snapshotHash, preflight));
      this.database.exec("COMMIT;");
    } catch (error) { this.database.exec("ROLLBACK;"); if (error instanceof Error && error.message === "JOB_NOT_FOUND") return { preflight: { selected: 0, uniqueAssets: 0, ready: 0, blockers: {}, warnings: {} }, code: "JOB_NOT_FOUND" }; throw error; }
    if (created && record && snapshot) { let running!: Promise<void>; running = this.generate(record, snapshot).finally(() => this.running.delete(running)); this.running.add(running); }
    return { record, preflight };
  }
  public async download(id: string): Promise<{ path: string; name: string } | undefined> {
    const record = this.exports.get(id); if (!record || record.status !== "ready" || !record.zipPath || !record.zipSha256) return undefined;
    const pathOperations = this.options.pathOperations ?? defaultPathOperations;
    const path = pathOperations.resolve(record.zipPath);
    if (!isExpectedExportDownloadPath(this.dataDir, path, id, pathOperations)) return undefined;
    try { if (await (this.options.sha256File ?? sha256File)(path) !== record.zipSha256) return undefined; return { path, name: `${id}.zip` }; } catch { return undefined; }
  }
  public get(id: string): ExportRecord | undefined { return this.exports.get(id); }
  private assetPath(hash: string): string { return join(this.dataDir, "cache", "assets", hash.slice(0, 2), hash); }
  private providerPolicy(providerId: string, declarations: Record<string, boolean>): { policy: "open" | "discovery_only" | "contractual"; contractualDeclared: boolean } { const policy = this.providers.rightsPolicy(providerId as import("../../shared/contracts.js").ProviderId); return { policy, contractualDeclared: Boolean(declarations[providerId]) }; }
  private assetProviderPolicies(jobId: string, assetId: string, declarations: Record<string, boolean>) {
    const ids = this.database.prepare(`
      SELECT DISTINCT provider_id FROM (
        SELECT c.provider_id
        FROM candidate_assets ca
        JOIN candidates c ON c.id = ca.candidate_id
        WHERE ca.asset_id = ? AND c.job_id = ?
        UNION ALL
        SELECT h.provider_id
        FROM candidate_assets ca
        JOIN candidates c ON c.id = ca.candidate_id
        JOIN candidate_hits ch ON ch.candidate_id = c.id
        JOIN search_hits h ON h.id = ch.hit_id
        WHERE ca.asset_id = ? AND c.job_id = ?
      )
      ORDER BY provider_id
    `).all(assetId, jobId, assetId, jobId) as Array<{ provider_id: string }>;
    return ids.map((row) => this.providerPolicy(row.provider_id, declarations));
  }
  private assetCandidateIds(jobId: string, assetId: string): string[] { return (this.database.prepare("SELECT c.id FROM candidate_assets ca JOIN candidates c ON c.id = ca.candidate_id WHERE ca.asset_id = ? AND c.job_id = ? ORDER BY c.id").all(assetId, jobId) as Array<{ id: string }>).map((row) => row.id); }
  private labelConfig(jobId: string, labelIds: string[]): Record<string, unknown>[] { return labelIds.slice().sort().map((id) => { const row = this.database.prepare("SELECT product, config_json FROM label_targets WHERE job_id = ? AND label_id = ?").get(jobId, id) as { product: string; config_json: string } | undefined; return { labelId: id, product: row?.product ?? null, config: row ? JSON.parse(row.config_json) : null }; }); }
  private provenanceForAsset(jobId: string, assetId: string): CandidateProvenance[] {
    const rows = this.database.prepare(`
      SELECT h.id AS hit_id, ch.query_run_id, h.provider_id, qr.variant_name, qr.query_text, qr.page,
        h.image_url, h.landing_page_url, h.title, h.creator, h.license_name, h.license_url,
        h.source_provider, h.source, h.rights_status
      FROM candidate_assets ca
      JOIN candidates c ON c.id = ca.candidate_id
      JOIN candidate_hits ch ON ch.candidate_id = c.id
      JOIN search_hits h ON h.id = ch.hit_id
      JOIN query_runs qr ON qr.id = ch.query_run_id
      WHERE ca.asset_id = ? AND c.job_id = ?
      ORDER BY h.provider_id, ch.query_run_id, h.id, c.id
    `).all(assetId, jobId) as Array<{
      hit_id: string; query_run_id: string; provider_id: CandidateProvenance["provider"];
      variant_name: string; query_text: string; page: number | bigint; image_url: string;
      landing_page_url: string | null; title: string | null; creator: string | null;
      license_name: string | null; license_url: string | null; source_provider: string | null;
      source: string | null; rights_status: CandidateProvenance["rightsStatus"];
    }>;
    const seen = new Set<string>();
    return rows.map((row): CandidateProvenance => ({
      hitId: row.hit_id,
      queryRunId: row.query_run_id,
      provider: row.provider_id,
      variantName: sanitizePublicText(row.variant_name) ?? "[redacted]",
      query: sanitizePublicText(row.query_text) ?? "[redacted]",
      page: Number(row.page),
      imageUrl: sanitizePublicHttpUrl(row.image_url),
      landingPageUrl: sanitizePublicHttpUrl(row.landing_page_url),
      title: sanitizePublicText(row.title),
      creator: sanitizePublicText(row.creator),
      licenseName: sanitizePublicText(row.license_name),
      licenseUrl: sanitizePublicHttpUrl(row.license_url),
      sourceProvider: sanitizePublicSource(row.source_provider),
      source: sanitizePublicSource(row.source),
      rightsStatus: row.rights_status
    })).filter((row) => {
      const key = stableJson(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  private async generate(record: ExportRecord, snapshot: Snapshot): Promise<void> {
    this.options.onGenerationStart?.();
    const root = resolve(this.dataDir, "exports"); const temporary = join(root, `.tmp-${record.id}-${process.pid}-${randomUUID()}`); const stagedRoot = join(temporary, "files"); const finalPath = join(root, `${record.id}.zip`); const archivePath = join(temporary, `${record.id}.zip`); const archiveRoot = `${snapshot.datasetSlug}_${record.id}`;
    try {
      await rm(temporary, { recursive: true, force: true }); await mkdir(stagedRoot, { recursive: true }); await mkdir(root, { recursive: true });
      const files = new Map<string, StagedFile>(); const manifest: Array<Record<string, unknown>> = [];
      for (const item of snapshot.items) {
        const sourcePath = this.assetPath(item.normalizedSha256);
        let sourceHash: string; try { sourceHash = await sha256File(sourcePath); } catch { throw new Error("ASSET_MISSING"); }
        if (sourceHash !== item.normalizedSha256) throw new Error("ASSET_CHANGED");
        const decoded = sharp(sourcePath, { limitInputPixels: 100_000_000, failOn: "error" }).rotate().toColorspace("srgb");
        const inputMetadata = await decoded.clone().metadata(); const stats = inputMetadata.hasAlpha ? await decoded.clone().stats() : null; const alphaChannel = stats?.channels[3];
        const alpha = Boolean(inputMetadata.hasAlpha && (!alphaChannel || alphaChannel.min < 255));
        const label = this.database.prepare("SELECT display_name FROM taxonomy_nodes WHERE job_id = ? AND label_id = ?").get(snapshot.jobId, item.primaryLabelId) as { display_name: string } | undefined; if (!label) throw new Error("LABEL_CONFLICT");
        const relativePath = `images/${item.primaryLabelId}__${slug(label.display_name)}/${item.canonicalCandidateId}_${item.normalizedSha256.slice(0, 8)}.${alpha ? "png" : "jpg"}`;
        const imagePath = this.stagedPath(stagedRoot, relativePath); await mkdir(dirname(imagePath), { recursive: true });
        const info = alpha
          ? await decoded.png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(imagePath)
          : await decoded.removeAlpha().jpeg({ quality: 90, mozjpeg: false }).toFile(imagePath);
        if (info.width * info.height > 100_000_000) throw new Error("ASSET_CHANGED");
        const exportSha256 = await sha256File(imagePath); files.set(relativePath, { path: imagePath, sha256: exportSha256 });
        manifest.push({ assetId: item.assetId, candidateId: item.canonicalCandidateId, selectedCandidateIds: item.selectedCandidateIds, sourceCandidateIds: item.sourceCandidateIds, path: relativePath, sourceSha256: item.sourceSha256, normalizedSha256: item.normalizedSha256, exportSha256, width: info.width, height: info.height, mimeType: alpha ? "image/png" : "image/jpeg", labelIds: item.labelIds, primaryLabelId: item.primaryLabelId, labelTargets: item.labelConfig, provenance: item.provenance, reviewAudit: item.reviewAudit, rights: item.reviewAudit, pipelineWarnings: item.warnings, transform: { orientation: "applied", colorspace: "srgb", metadata: "stripped", format: alpha ? "png" : "jpeg" } });
      }
      const taxonomy = this.database.prepare("SELECT label_id AS id, parent_id AS parentId, display_name AS displayName, path_json AS pathJson FROM taxonomy_nodes WHERE job_id = ? ORDER BY label_id").all(snapshot.jobId).map((r) => { const row = r as { id: string; parentId: string | null; displayName: string; pathJson: string }; return { id: row.id, parentId: row.parentId, displayName: row.displayName, path: JSON.parse(row.pathJson) }; });
      const sourceStats = countBy(manifest.flatMap((row) => (row.provenance as Array<{ provider: string }>).map((entry) => entry.provider)));
      const licenseStats = countBy(manifest.flatMap((row) => (row.provenance as Array<{ licenseName: string | null }>).map((entry) => entry.licenseName ?? "unknown")));
      const rightsStats = countBy(manifest.flatMap((row) => (row.reviewAudit as ReviewAudit[]).map((entry) => entry.rightsBasis)));
      const metadata = new Map<string, Buffer>([
        ["README.md", Buffer.from("# Local dataset export\n\nRights acknowledgements are not copyright licenses.\n")],
        ["dataset.json", Buffer.from(`${stableJson({ applicationVersion: "1", exportId: record.id, exportMode: snapshot.exportMode, policyVersion: "1", taskType: snapshot.taskType, contractualRightsDeclarations: snapshot.contractualRightsDeclarations, total: manifest.length, sourceCount: new Set(manifest.flatMap((row) => (row.sourceCandidateIds as string[]))).size, sourceStats, licenseStats, rightsStats })}\n`)],
        ["taxonomy.json", Buffer.from(`${stableJson(taxonomy)}\n`)],
        ["manifest.jsonl", Buffer.from(`${manifest.sort((a, b) => String(a.path).localeCompare(String(b.path))).map((row) => stableJson(row)).join("\n")}\n`)],
        ["reports/acquisition_summary.json", Buffer.from(`${stableJson({ selectedCandidates: manifest.reduce((sum, row) => sum + (row.selectedCandidateIds as string[]).length, 0), sourceCandidates: manifest.reduce((sum, row) => sum + (row.sourceCandidateIds as string[]).length, 0), uniqueAssets: manifest.length, providerCounts: snapshot.acquisition.providerCounts, queryRuns: snapshot.acquisition.queryRuns })}\n`)]
      ]);
      assertSafeMetadata(metadata);
      for (const [relativePath, bytes] of metadata) {
        const path = this.stagedPath(stagedRoot, relativePath); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); files.set(relativePath, { path, sha256: sha256(bytes) });
      }
      const checksums = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => `${file.sha256}  ${path}`).join("\n") + "\n";
      const checksumPath = this.stagedPath(stagedRoot, "checksums.sha256"); await writeFile(checksumPath, checksums); files.set("checksums.sha256", { path: checksumPath, sha256: sha256(checksums) });
      await this.writeArchive(archivePath, archiveRoot, files); await this.verifyArchive(archivePath, archiveRoot, files, manifest.length);
      const archiveSha256 = await sha256File(archivePath); await rename(archivePath, finalPath); await rm(temporary, { recursive: true, force: true }); this.exports.ready(record.id, finalPath, archiveSha256);
    } catch (error) { this.exports.fail(record.id, error instanceof Error && /^(ASSET_MISSING|ASSET_CHANGED|LABEL_CONFLICT)$/.test(error.message) ? error.message : "EXPORT_GENERATION_FAILED"); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  private stagedPath(root: string, relativePath: string): string {
    const resolvedRoot = resolve(root); const path = resolve(resolvedRoot, relativePath);
    if (!path.startsWith(`${resolvedRoot}${sep}`)) throw new Error("EXPORT_GENERATION_FAILED");
    return path;
  }
  private async writeArchive(path: string, rootDirectory: string, files: Map<string, StagedFile>): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(path, { flags: "wx" }); const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on("close", resolvePromise); output.on("error", reject); archive.on("error", reject); archive.pipe(output);
      for (const [name, file] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) archive.file(file.path, { name: `${rootDirectory}/${name}`, date: fixedDate, mode: 0o100644 });
      void archive.finalize().catch(reject);
    });
  }
  private async verifyArchive(path: string, rootDirectory: string, files: Map<string, StagedFile>, imageCount: number): Promise<void> {
    const expected = new Map([...files].map(([name, file]) => [`${rootDirectory}/${name}`, file.sha256]));
    if ([...files.keys()].filter((name) => name.startsWith("images/")).length !== imageCount) throw new Error("EXPORT_GENERATION_FAILED");
    await assertValidZipStructure(path, new Set(expected.keys()));
    await new Promise<void>((resolvePromise, reject) => {
      const input = createReadStream(path); const seen = new Set<string>(); let inputEnded = false; let pendingFiles = 0; let settled = false;
      const fail = (error: unknown) => { if (settled) return; settled = true; input.destroy(); reject(error instanceof Error ? error : new Error("EXPORT_GENERATION_FAILED")); };
      const finish = () => {
        if (settled || !inputEnded || pendingFiles !== 0) return;
        settled = true;
        if (seen.size !== expected.size || [...expected.keys()].some((name) => !seen.has(name))) reject(new Error("EXPORT_GENERATION_FAILED"));
        else resolvePromise();
      };
      const unzip = new Unzip((file) => {
        const expectedHash = expected.get(file.name);
        if (!expectedHash || seen.has(file.name)) { file.terminate(); fail(new Error("EXPORT_GENERATION_FAILED")); return; }
        seen.add(file.name); pendingFiles += 1; const hash = createHash("sha256");
        file.ondata = (error, chunk, final) => {
          if (error) { fail(error); return; }
          hash.update(chunk);
          if (!final) return;
          if (hash.digest("hex") !== expectedHash) { fail(new Error("EXPORT_GENERATION_FAILED")); return; }
          pendingFiles -= 1; finish();
        };
        try { file.start(); } catch (error) { fail(error); }
      });
      unzip.register(UnzipInflate);
      input.on("data", (chunk) => { if (!settled) try { unzip.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, false); } catch (error) { fail(error); } });
      input.on("error", fail);
      input.on("end", () => {
        if (settled) return;
        try { unzip.push(new Uint8Array(), true); inputEnded = true; finish(); } catch (error) { fail(error); }
      });
    });
  }
}
