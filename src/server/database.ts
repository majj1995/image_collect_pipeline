import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AppDatabase = DatabaseSync;

export interface RecoveryReport {
  recoveredCandidateIds: string[];
  interruptedExportIds: string[];
}

export function createDatabase(dataDir: string): AppDatabase {
  const databasePath = dataDir === ":memory:" ? ":memory:" : resolve(dataDir, "pipeline.sqlite");
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  if (databasePath !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL;");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, task_type TEXT NOT NULL,
      export_mode TEXT NOT NULL, status TEXT NOT NULL,
      settings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS taxonomy_nodes (
      job_id TEXT NOT NULL, label_id TEXT NOT NULL, parent_id TEXT,
      display_name TEXT NOT NULL, path_json TEXT NOT NULL,
      PRIMARY KEY (job_id, label_id), FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS label_targets (
      job_id TEXT NOT NULL, label_id TEXT NOT NULL, product TEXT NOT NULL,
      config_json TEXT NOT NULL, selected_count INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_id, label_id), FOREIGN KEY (job_id, label_id) REFERENCES taxonomy_nodes(job_id, label_id)
    );
    CREATE TABLE IF NOT EXISTS query_runs (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, label_id TEXT NOT NULL, provider_id TEXT NOT NULL,
      variant_name TEXT NOT NULL, query_text TEXT NOT NULL, page INTEGER NOT NULL DEFAULT 1, request_count INTEGER, provider_hit_count INTEGER, status TEXT NOT NULL,
      error_summary TEXT, retryable INTEGER NOT NULL DEFAULT 0, requires_explicit_retry INTEGER NOT NULL DEFAULT 0,
      started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY (job_id, label_id) REFERENCES label_targets(job_id, label_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS query_runs_job_status ON query_runs(job_id, status);
    CREATE TABLE IF NOT EXISTS search_hits (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, provider_id TEXT NOT NULL,
      normalized_image_url TEXT NOT NULL, image_url TEXT NOT NULL, thumbnail_url TEXT,
      landing_page_url TEXT, title TEXT, creator TEXT, license_name TEXT, license_url TEXT,
      width INTEGER, height INTEGER, source_provider TEXT, source TEXT, rights_status TEXT NOT NULL,
      UNIQUE(job_id, provider_id, normalized_image_url),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, normalized_image_url TEXT NOT NULL,
      provider_id TEXT NOT NULL, image_url TEXT NOT NULL, landing_page_url TEXT, title TEXT,
      pipeline_state TEXT NOT NULL, rights_status TEXT NOT NULL, provider_rights_status TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL,
      pipeline_error TEXT, pipeline_failure_code TEXT, pipeline_warnings_json TEXT NOT NULL DEFAULT '[]', near_duplicate_group TEXT,
      UNIQUE(job_id, normalized_image_url), FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS candidate_hits (
      candidate_id TEXT NOT NULL, hit_id TEXT NOT NULL, query_run_id TEXT NOT NULL,
      PRIMARY KEY (candidate_id, hit_id, query_run_id),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (hit_id) REFERENCES search_hits(id) ON DELETE CASCADE,
      FOREIGN KEY (query_run_id) REFERENCES query_runs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS candidate_labels (
      candidate_id TEXT NOT NULL, job_id TEXT NOT NULL, label_id TEXT NOT NULL,
      PRIMARY KEY (candidate_id, label_id),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id, label_id) REFERENCES label_targets(job_id, label_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL UNIQUE, normalized_sha256 TEXT NOT NULL UNIQUE, pixel_sha256 TEXT NOT NULL UNIQUE,
      dhash TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, channels INTEGER NOT NULL,
      mime_type TEXT NOT NULL, thumbnail_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidate_assets (
      candidate_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS candidate_assets_asset ON candidate_assets(asset_id);
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_settings (
      name TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache_cleanup_queue (
      source_sha256 TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS job_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, type TEXT NOT NULL,
      query_run_id TEXT, status TEXT, review_candidate_id TEXT, review_action TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (query_run_id) REFERENCES query_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS job_events_job_cursor ON job_events(job_id, cursor);
    CREATE TABLE IF NOT EXISTS review_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
      action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS review_events_job_candidate ON review_events(job_id, candidate_id, id);
    CREATE TABLE IF NOT EXISTS candidate_review_state (
      candidate_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, review_state TEXT NOT NULL DEFAULT 'unreviewed',
      label_ids_json TEXT NOT NULL DEFAULT '[]', primary_label_id TEXT, rights_acknowledged INTEGER NOT NULL DEFAULT 0,
      rights_basis TEXT NOT NULL DEFAULT 'unknown', rights_evidence TEXT, warning_overrides_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS candidate_review_state_job ON candidate_review_state(job_id, review_state);
    CREATE TABLE IF NOT EXISTS exports (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      snapshot_hash TEXT, preflight_json TEXT NOT NULL, zip_path TEXT, zip_sha256 TEXT, error_code TEXT,
      created_at TEXT NOT NULL, completed_at TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS exports_job_created ON exports(job_id, created_at);
  `);
  const columns = database.prepare("PRAGMA table_info(candidates)").all() as unknown as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("pipeline_error")) database.exec("ALTER TABLE candidates ADD COLUMN pipeline_error TEXT;");
  if (!names.has("pipeline_failure_code")) database.exec("ALTER TABLE candidates ADD COLUMN pipeline_failure_code TEXT;");
  if (!names.has("pipeline_warnings_json")) database.exec("ALTER TABLE candidates ADD COLUMN pipeline_warnings_json TEXT NOT NULL DEFAULT '[]';");
  if (!names.has("near_duplicate_group")) database.exec("ALTER TABLE candidates ADD COLUMN near_duplicate_group TEXT;");
  if (!names.has("provider_rights_status")) { database.exec("ALTER TABLE candidates ADD COLUMN provider_rights_status TEXT NOT NULL DEFAULT 'unknown';"); database.exec("UPDATE candidates SET provider_rights_status = rights_status WHERE provider_rights_status = 'unknown';"); }
  const queryRunColumns = database.prepare("PRAGMA table_info(query_runs)").all() as unknown as Array<{ name: string }>;
  if (!queryRunColumns.some((column) => column.name === "retryable")) database.exec("ALTER TABLE query_runs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;");
  if (!queryRunColumns.some((column) => column.name === "requires_explicit_retry")) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec("ALTER TABLE query_runs ADD COLUMN requires_explicit_retry INTEGER NOT NULL DEFAULT 0;");
      database.exec(`
        UPDATE query_runs SET requires_explicit_retry = 1
        WHERE status = 'retryable'
          AND (error_summary LIKE '提供方暂时不可用%' OR error_summary LIKE '提供方请求过于频繁%')
      `);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
  if (!queryRunColumns.some((column) => column.name === "page")) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec("ALTER TABLE query_runs ADD COLUMN page INTEGER NOT NULL DEFAULT 1;");
      database.exec("UPDATE query_runs SET page = 1;");
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
  if (!queryRunColumns.some((column) => column.name === "request_count")) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec("ALTER TABLE query_runs ADD COLUMN request_count INTEGER;");
      database.exec("UPDATE query_runs SET request_count = 100;");
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
  if (!queryRunColumns.some((column) => column.name === "provider_hit_count")) {
    database.exec("ALTER TABLE query_runs ADD COLUMN provider_hit_count INTEGER;");
  }
  const eventColumns = database.prepare("PRAGMA table_info(job_events)").all() as unknown as Array<{ name: string }>;
  if (!eventColumns.some((column) => column.name === "review_candidate_id")) database.exec("ALTER TABLE job_events ADD COLUMN review_candidate_id TEXT;");
  if (!eventColumns.some((column) => column.name === "review_action")) database.exec("ALTER TABLE job_events ADD COLUMN review_action TEXT;");
  const reviewColumns = database.prepare("PRAGMA table_info(candidate_review_state)").all() as unknown as Array<{ name: string }>;
  if (!reviewColumns.some((column) => column.name === "rights_basis")) database.exec("ALTER TABLE candidate_review_state ADD COLUMN rights_basis TEXT NOT NULL DEFAULT 'unknown';");
  if (!reviewColumns.some((column) => column.name === "rights_evidence")) database.exec("ALTER TABLE candidate_review_state ADD COLUMN rights_evidence TEXT;");
  const exportColumns = database.prepare("PRAGMA table_info(exports)").all() as unknown as Array<{ name: string }>;
  if (!exportColumns.some((column) => column.name === "snapshot_hash")) database.exec("ALTER TABLE exports ADD COLUMN snapshot_hash TEXT;");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS exports_job_snapshot_hash ON exports(job_id, snapshot_hash);");
  runNormalizedCacheMigration(database, dataDir, databasePath);
  return database;
}

export function recoverInterruptedWork(database: AppDatabase): RecoveryReport {
  const now = new Date().toISOString();
  let candidates: Array<{ id: string }> = [];
  let exports: Array<{ id: string }> = [];
  database.exec("BEGIN IMMEDIATE;");
  try {
    const runs = database.prepare("SELECT id, job_id, status FROM query_runs WHERE status IN ('pending', 'running') ORDER BY rowid").all() as unknown as Array<{ id: string; job_id: string; status: "pending" | "running" }>;
    candidates = database.prepare("SELECT id FROM candidates WHERE pipeline_state = 'fetching' ORDER BY rowid").all() as unknown as Array<{ id: string }>;
    exports = database.prepare("SELECT id FROM exports WHERE status = 'generating' ORDER BY rowid").all() as unknown as Array<{ id: string }>;
    const updateRun = database.prepare("UPDATE query_runs SET status = 'retryable', retryable = 1, requires_explicit_retry = 0, error_summary = ?, completed_at = NULL WHERE id = ? AND status = ?");
    const insertEvent = database.prepare("INSERT INTO job_events (job_id, type, query_run_id, status, created_at) VALUES (?, 'query_run', ?, 'retryable', ?)");
    for (const run of runs) {
      const summary = run.status === "running" ? "搜索因本地服务重启而中断，可继续重试。" : "待执行搜索因本地服务重启而暂停，可继续重试。";
      if (Number(updateRun.run(summary, run.id, run.status).changes) > 0) insertEvent.run(run.job_id, run.id, now);
    }
    database.prepare("UPDATE candidates SET pipeline_state = 'discovered', pipeline_error = 'DOWNLOAD_INTERRUPTED', pipeline_failure_code = NULL WHERE pipeline_state = 'fetching'").run();
    database.prepare("UPDATE exports SET status = 'failed', error_code = 'EXPORT_INTERRUPTED', completed_at = ? WHERE status = 'generating'").run(now);
    database.prepare(`
      UPDATE jobs SET status = 'reviewing', updated_at = ?
      WHERE status = 'collecting'
        AND NOT EXISTS (SELECT 1 FROM query_runs WHERE query_runs.job_id = jobs.id AND query_runs.status IN ('pending', 'running'))
    `).run(now);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return { recoveredCandidateIds: candidates.map((candidate) => candidate.id), interruptedExportIds: exports.map((entry) => entry.id) };
}

const NORMALIZED_CACHE_MIGRATION = "normalized_cache_v2";

function runNormalizedCacheMigration(database: AppDatabase, dataDir: string, databasePath: string): void {
  const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(NORMALIZED_CACHE_MIGRATION);
  if (!applied) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      const assetColumns = database.prepare("PRAGMA table_info(assets)").all() as unknown as Array<{ name: string }>;
      if (!assetColumns.some((column) => column.name === "normalized_sha256")) database.exec("ALTER TABLE assets ADD COLUMN normalized_sha256 TEXT;");
      database.exec("CREATE UNIQUE INDEX IF NOT EXISTS assets_normalized_sha256 ON assets(normalized_sha256);");
      const legacyAssets = database.prepare("SELECT id, source_sha256 FROM assets WHERE normalized_sha256 IS NULL OR normalized_sha256 = source_sha256").all() as unknown as Array<{ id: string; source_sha256: string }>;
      const linkedCandidates = database.prepare(`SELECT DISTINCT candidate_id FROM candidate_assets WHERE asset_id IN (SELECT id FROM assets WHERE normalized_sha256 IS NULL OR normalized_sha256 = source_sha256)`).all() as unknown as Array<{ candidate_id: string }>;
      const enqueueCleanup = database.prepare("INSERT OR IGNORE INTO cache_cleanup_queue (source_sha256) VALUES (?)");
      for (const asset of legacyAssets) if (/^[a-f0-9]{64}$/.test(asset.source_sha256)) enqueueCleanup.run(asset.source_sha256);
      database.exec("DELETE FROM candidate_assets WHERE asset_id IN (SELECT id FROM assets WHERE normalized_sha256 IS NULL OR normalized_sha256 = source_sha256);");
      database.exec("DELETE FROM assets WHERE normalized_sha256 IS NULL OR normalized_sha256 = source_sha256;");
      const resetCandidate = database.prepare("UPDATE candidates SET pipeline_state = 'discovered', pipeline_error = 'CACHE_REBUILD_REQUIRED', pipeline_failure_code = NULL, pipeline_warnings_json = '[]', near_duplicate_group = NULL WHERE id = ?");
      for (const candidate of linkedCandidates) resetCandidate.run(candidate.candidate_id);
      database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(NORMALIZED_CACHE_MIGRATION, new Date().toISOString());
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
  if (databasePath !== ":memory:") processCacheCleanupQueue(database, dataDir);
}

function processCacheCleanupQueue(database: AppDatabase, dataDir: string): void {
  const hashes = database.prepare("SELECT source_sha256 FROM cache_cleanup_queue ORDER BY source_sha256").all() as unknown as Array<{ source_sha256: string }>;
  for (const row of hashes) {
    if (!/^[a-f0-9]{64}$/.test(row.source_sha256)) throw new Error("Invalid cache cleanup entry.");
    removeLegacyAssetFiles(dataDir, [row]);
    database.prepare("DELETE FROM cache_cleanup_queue WHERE source_sha256 = ?").run(row.source_sha256);
  }
}

function removeLegacyAssetFiles(dataDir: string, assets: Array<{ source_sha256: string }>): void {
  const cacheRoot = resolve(dataDir, "cache");
  const assetsRoot = resolve(cacheRoot, "assets");
  const thumbnailsRoot = resolve(cacheRoot, "thumbnails");
  for (const asset of assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.source_sha256)) continue;
    const sourcePath = resolve(assetsRoot, asset.source_sha256.slice(0, 2), asset.source_sha256);
    const thumbnailPath = resolve(thumbnailsRoot, `${asset.source_sha256}.webp`);
    for (const path of [sourcePath, thumbnailPath]) {
      const root = path === sourcePath ? assetsRoot : thumbnailsRoot;
      if (!path.startsWith(`${root}${sep}`)) continue;
      try { unlinkSync(path); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
