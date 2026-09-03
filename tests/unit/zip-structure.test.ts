import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { assertValidZipStructure } from "../../src/server/services/zip-structure.js";

const withArchive = async (bytes: Uint8Array, test: (path: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "zip-structure-"));
  const path = join(directory, "archive.zip");
  try {
    await writeFile(path, bytes);
    await test(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const standardArchive = (): Buffer => Buffer.from(zipSync({ "a.txt": strToU8("alpha") }));

const emptyZip64Archive = (): Buffer => {
  const archive = Buffer.alloc(98);
  archive.writeUInt32LE(0x06064b50, 0);
  archive.writeBigUInt64LE(44n, 4);
  archive.writeUInt16LE(45, 12);
  archive.writeUInt16LE(45, 14);
  archive.writeBigUInt64LE(0n, 24);
  archive.writeBigUInt64LE(0n, 32);
  archive.writeBigUInt64LE(0n, 40);
  archive.writeBigUInt64LE(0n, 48);
  archive.writeUInt32LE(0x07064b50, 56);
  archive.writeBigUInt64LE(0n, 64);
  archive.writeUInt32LE(1, 72);
  archive.writeUInt32LE(0x06054b50, 76);
  archive.writeUInt16LE(0xffff, 84);
  archive.writeUInt16LE(0xffff, 86);
  archive.writeUInt32LE(0xffffffff, 88);
  archive.writeUInt32LE(0xffffffff, 92);
  return archive;
};

describe("ZIP structure validation", () => {
  it("accepts a standard ZIP whose EOCD and central directory describe every expected entry", async () => {
    const archive = zipSync({ "a.txt": strToU8("alpha"), "nested/b.txt": strToU8("beta") });

    await withArchive(archive, async (path) => {
      await expect(assertValidZipStructure(path, new Set(["a.txt", "nested/b.txt"]))).resolves.toBeUndefined();
    });
  });

  it("rejects a ZIP whose terminal EOCD is truncated", async () => {
    const archive = standardArchive();
    await withArchive(archive.subarray(0, archive.length - 1), async (path) => {
      await expect(assertValidZipStructure(path, new Set(["a.txt"]))).rejects.toThrow("INVALID_ZIP_STRUCTURE");
    });
  });

  it("rejects a central directory whose declared bounds cross the EOCD", async () => {
    const archive = standardArchive();
    const eocdOffset = archive.length - 22;
    archive.writeUInt32LE(archive.readUInt32LE(eocdOffset + 12) + 1, eocdOffset + 12);
    await withArchive(archive, async (path) => {
      await expect(assertValidZipStructure(path, new Set(["a.txt"]))).rejects.toThrow("INVALID_ZIP_STRUCTURE");
    });
  });

  it("rejects an invalid central file-header signature", async () => {
    const archive = standardArchive();
    const eocdOffset = archive.length - 22;
    const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
    archive.writeUInt32LE(0xdeadbeef, centralDirectoryOffset);
    await withArchive(archive, async (path) => {
      await expect(assertValidZipStructure(path, new Set(["a.txt"]))).rejects.toThrow("INVALID_ZIP_STRUCTURE");
    });
  });

  it("rejects a central-directory filename that no longer matches the expected archive name", async () => {
    const archive = standardArchive();
    const eocdOffset = archive.length - 22;
    const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
    archive.write("b.txt", centralDirectoryOffset + 46, "utf8");
    await withArchive(archive, async (path) => {
      await expect(assertValidZipStructure(path, new Set(["a.txt"]))).rejects.toThrow("INVALID_ZIP_STRUCTURE");
    });
  });

  it("rejects duplicate central-directory filenames even when the expected count is unchanged", async () => {
    const archive = Buffer.from(zipSync({ "a.txt": strToU8("alpha"), "b.txt": strToU8("beta") }));
    const eocdOffset = archive.length - 22;
    const firstHeaderOffset = archive.readUInt32LE(eocdOffset + 16);
    const secondHeaderOffset = firstHeaderOffset + 46
      + archive.readUInt16LE(firstHeaderOffset + 28)
      + archive.readUInt16LE(firstHeaderOffset + 30)
      + archive.readUInt16LE(firstHeaderOffset + 32);
    archive.write("a.txt", secondHeaderOffset + 46, "utf8");
    await withArchive(archive, async (path) => {
      await expect(assertValidZipStructure(path, new Set(["a.txt", "b.txt"]))).rejects.toThrow("INVALID_ZIP_STRUCTURE");
    });
  });

  it("rejects a non-UTF-8 central-directory filename", async () => {
    const archive = standardArchive();
    const eocdOffset = archive.length - 22;
    const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
    archive[centralDirectoryOffset + 46] = 0xff;
    await withArchive(archive, async (path) => {
      await expect(assertValidZipStructure(path, new Set(["a.txt"]))).rejects.toThrow("INVALID_ZIP_STRUCTURE");
    });
  });

  it("rejects a declared entry count that exceeds the central directory records", async () => {
    const archive = standardArchive();
    const eocdOffset = archive.length - 22;
    archive.writeUInt16LE(2, eocdOffset + 8);
    archive.writeUInt16LE(2, eocdOffset + 10);
    await withArchive(archive, async (path) => {
      await expect(assertValidZipStructure(path, new Set(["a.txt", "b.txt"]))).rejects.toThrow("INVALID_ZIP_STRUCTURE");
    });
  });

  it("rejects a valid archive when its entry count differs from the caller's expected count", async () => {
    await withArchive(standardArchive(), async (path) => {
      await expect(assertValidZipStructure(path, new Set(["a.txt", "missing.txt"]))).rejects.toThrow("INVALID_ZIP_STRUCTURE");
    });
  });

  it("accepts a single-disk ZIP64 archive through its locator and ZIP64 EOCD", async () => {
    await withArchive(emptyZip64Archive(), async (path) => {
      await expect(assertValidZipStructure(path, new Set())).resolves.toBeUndefined();
    });
  });
});
