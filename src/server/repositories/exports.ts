import type { AppDatabase } from "../database.js";

export type ExportStatus = "generating" | "ready" | "failed";
export interface ExportRecord { id: string; jobId: string; status: ExportStatus; snapshot: unknown; preflight: unknown; zipPath: string | null; zipSha256: string | null; errorCode: string | null; createdAt: string; completedAt: string | null; }
interface Row { id: string; job_id: string; status: ExportStatus; snapshot_json: string; preflight_json: string; zip_path: string | null; zip_sha256: string | null; error_code: string | null; created_at: string; completed_at: string | null; }
const asExport = (row: Row): ExportRecord => ({ id: row.id, jobId: row.job_id, status: row.status, snapshot: JSON.parse(row.snapshot_json), preflight: JSON.parse(row.preflight_json), zipPath: row.zip_path, zipSha256: row.zip_sha256, errorCode: row.error_code, createdAt: row.created_at, completedAt: row.completed_at });

export class ExportsRepository {
  public constructor(private readonly database: AppDatabase) {}
  public get(id: string): ExportRecord | undefined { const row = this.database.prepare("SELECT * FROM exports WHERE id = ?").get(id) as unknown as Row | undefined; return row && asExport(row); }
  public getBySnapshot(jobId: string, snapshotJson: string): ExportRecord | undefined { const row = this.database.prepare("SELECT * FROM exports WHERE job_id = ? AND snapshot_json = ? ORDER BY created_at DESC LIMIT 1").get(jobId, snapshotJson) as unknown as Row | undefined; return row && asExport(row); }
  /** Caller owns the BEGIN IMMEDIATE transaction so snapshot reads and create are atomic. */
  public createOrGetInTransaction(id: string, jobId: string, snapshotJson: string, snapshotHash: string, preflight: unknown): { record: ExportRecord; created: boolean } {
    const now = new Date().toISOString(); const preflightJson = JSON.stringify(preflight);
    const result = this.database.prepare("INSERT OR IGNORE INTO exports (id, job_id, status, snapshot_json, snapshot_hash, preflight_json, created_at) VALUES (?, ?, 'generating', ?, ?, ?, ?)").run(id, jobId, snapshotJson, snapshotHash, preflightJson, now);
    let row = this.database.prepare("SELECT * FROM exports WHERE job_id = ? AND snapshot_hash = ?").get(jobId, snapshotHash) as unknown as Row;
    let created = Number(result.changes) > 0;
    if (!created && row.status === "failed" && row.error_code === "EXPORT_INTERRUPTED") {
      const reset = this.database.prepare(`
        UPDATE exports SET status = 'generating', preflight_json = ?, zip_path = NULL, zip_sha256 = NULL,
          error_code = NULL, completed_at = NULL
        WHERE id = ? AND status = 'failed' AND error_code = 'EXPORT_INTERRUPTED'
      `).run(preflightJson, row.id);
      created = Number(reset.changes) > 0;
      row = this.database.prepare("SELECT * FROM exports WHERE id = ?").get(row.id) as unknown as Row;
    }
    return { record: asExport(row), created };
  }
  public ready(id: string, path: string, sha256: string): void { this.database.prepare("UPDATE exports SET status = 'ready', zip_path = ?, zip_sha256 = ?, completed_at = ?, error_code = NULL WHERE id = ?").run(path, sha256, new Date().toISOString(), id); }
  public fail(id: string, code: string): void { this.database.prepare("UPDATE exports SET status = 'failed', error_code = ?, completed_at = ? WHERE id = ?").run(code, new Date().toISOString(), id); }
}
