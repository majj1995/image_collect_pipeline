import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppDatabase } from "../../src/server/database.js";
import { ExportsRepository, type ExportRecord } from "../../src/server/repositories/exports.js";
import type { ProviderRegistry } from "../../src/server/providers/registry.js";
import { ExportService, isExpectedExportDownloadPath, type ExportServiceOptions } from "../../src/server/services/export-service.js";

describe("export download path validation", () => {
  it("accepts only the canonical Windows export archive path", () => {
    const dataDir = "C:\\pipeline\\.data";
    const exportId = "export_0123456789abcdef01234567";
    const expected = win32.join(dataDir, "exports", `${exportId}.zip`);
    expect(isExpectedExportDownloadPath(dataDir, expected, exportId, win32)).toBe(true);
    expect(isExpectedExportDownloadPath("C:\\PIPELINE\\.DATA", expected, exportId, win32)).toBe(true);
    expect(isExpectedExportDownloadPath("\\\\SERVER\\Share\\data", "\\\\server\\share\\data\\exports\\export_0123456789abcdef01234567.zip", exportId, win32)).toBe(true);
    expect(isExpectedExportDownloadPath(dataDir, win32.join(dataDir, "exports-other", `${exportId}.zip`), exportId, win32)).toBe(false);
    expect(isExpectedExportDownloadPath(dataDir, win32.join(dataDir, "exports", "other.zip"), exportId, win32)).toBe(false);
    expect(isExpectedExportDownloadPath(dataDir, win32.join(dataDir, "outside.zip"), "..\\outside", win32)).toBe(false);
  });

  it("uses the Windows path guard in the real download call chain", async () => {
    const exportId = "export_0123456789abcdef01234567";
    const zipPath = `c:\\pipeline\\.data\\exports\\${exportId}.zip`;
    const zipSha256 = "expected-sha256";
    const record: ExportRecord = {
      id: exportId, jobId: "job-1", status: "ready", snapshot: {}, preflight: {}, zipPath, zipSha256,
      errorCode: null, createdAt: "now", completedAt: "now"
    };
    let hashedPath: string | undefined;
    const repository = { get: () => record } as unknown as ExportsRepository;
    const options = {
      pathOperations: win32,
      sha256File: async (path: string) => { hashedPath = path; return zipSha256; }
    } satisfies ExportServiceOptions;
    const service = new ExportService(
      {} as AppDatabase,
      repository,
      "C:\\PIPELINE\\.DATA",
      {} as ProviderRegistry,
      () => ({}),
      options
    );

    await expect(service.download(exportId)).resolves.toEqual({ path: win32.resolve(zipPath), name: `${exportId}.zip` });
    expect(hashedPath).toBe(win32.resolve(zipPath));
  });
});
