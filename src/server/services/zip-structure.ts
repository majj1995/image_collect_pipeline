import { open, type FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const EOCD_MINIMUM_SIZE = 22;
const MAXIMUM_COMMENT_SIZE = 0xffff;
const MAXIMUM_EOCD_SEARCH = EOCD_MINIMUM_SIZE + MAXIMUM_COMMENT_SIZE;
const UTF8_FILENAME_FLAG = 0x0800;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const invalidZip = (): Error => new Error("INVALID_ZIP_STRUCTURE");

interface CentralDirectoryLocation {
  entryCount: number;
  offset: number;
  size: number;
  boundary: number;
}

const asSafeNumber = (value: bigint): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalidZip();
  return number;
};

const readExactly = async (file: FileHandle, position: number, length: number): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw invalidZip();
    offset += bytesRead;
  }
  return buffer;
};

const findEndOfCentralDirectory = (tail: Buffer, tailOffset: number): { offset: number; record: Buffer } => {
  for (let offset = tail.length - EOCD_MINIMUM_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + EOCD_MINIMUM_SIZE + commentLength !== tail.length) continue;
    return { offset: tailOffset + offset, record: tail.subarray(offset, offset + EOCD_MINIMUM_SIZE) };
  }
  throw invalidZip();
};

const readZip64CentralDirectory = async (file: FileHandle, eocdOffset: number): Promise<CentralDirectoryLocation> => {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0) throw invalidZip();
  const locator = await readExactly(file, locatorOffset, 20);
  if (locator.readUInt32LE(0) !== ZIP64_EOCD_LOCATOR_SIGNATURE || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw invalidZip();
  const zip64Offset = asSafeNumber(locator.readBigUInt64LE(8));
  if (zip64Offset + 56 > locatorOffset) throw invalidZip();
  const record = await readExactly(file, zip64Offset, 56);
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw invalidZip();
  const recordSize = asSafeNumber(record.readBigUInt64LE(4));
  if (recordSize < 44 || zip64Offset + 12 + recordSize !== locatorOffset) throw invalidZip();
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) throw invalidZip();
  const entriesOnDisk = asSafeNumber(record.readBigUInt64LE(24));
  const entryCount = asSafeNumber(record.readBigUInt64LE(32));
  if (entriesOnDisk !== entryCount) throw invalidZip();
  return {
    entryCount,
    offset: asSafeNumber(record.readBigUInt64LE(48)),
    size: asSafeNumber(record.readBigUInt64LE(40)),
    boundary: zip64Offset
  };
};

/**
 * Validates the terminal ZIP records without loading file payloads into memory.
 * Entry contents are intentionally left to the archive's streaming verifier.
 */
export const assertValidZipStructure = async (path: string, expectedEntryNames: ReadonlySet<string>): Promise<void> => {
  const expectedNames = new Set(expectedEntryNames);
  const expectedEntryCount = expectedNames.size;
  if (!Number.isSafeInteger(expectedEntryCount) || expectedEntryCount < 0) throw invalidZip();
  for (const name of expectedNames) {
    const encoded = Buffer.from(name, "utf8");
    if (!name || name.includes("\0") || encoded.length > 0xffff || utf8Decoder.decode(encoded) !== name) throw invalidZip();
  }
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size < EOCD_MINIMUM_SIZE) throw invalidZip();
    const tailLength = Math.min(size, MAXIMUM_EOCD_SEARCH);
    const tailOffset = size - tailLength;
    const tail = await readExactly(file, tailOffset, tailLength);
    const eocd = findEndOfCentralDirectory(tail, tailOffset);

    const diskNumber = eocd.record.readUInt16LE(4);
    const centralDirectoryDisk = eocd.record.readUInt16LE(6);
    const entriesOnDisk = eocd.record.readUInt16LE(8);
    const totalEntries = eocd.record.readUInt16LE(10);
    const classicCentralDirectorySize = eocd.record.readUInt32LE(12);
    const classicCentralDirectoryOffset = eocd.record.readUInt32LE(16);
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) throw invalidZip();
    const isZip64 = totalEntries === 0xffff || classicCentralDirectorySize === 0xffffffff || classicCentralDirectoryOffset === 0xffffffff;
    const location = isZip64
      ? await readZip64CentralDirectory(file, eocd.offset)
      : { entryCount: totalEntries, offset: classicCentralDirectoryOffset, size: classicCentralDirectorySize, boundary: eocd.offset };
    if (location.entryCount !== expectedEntryCount) throw invalidZip();
    if (totalEntries !== 0xffff && totalEntries !== location.entryCount) throw invalidZip();
    if (classicCentralDirectorySize !== 0xffffffff && classicCentralDirectorySize !== location.size) throw invalidZip();
    if (classicCentralDirectoryOffset !== 0xffffffff && classicCentralDirectoryOffset !== location.offset) throw invalidZip();

    const centralDirectoryEnd = location.offset + location.size;
    if (!Number.isSafeInteger(centralDirectoryEnd) || centralDirectoryEnd !== location.boundary) throw invalidZip();
    let position = location.offset;
    const seenNames = new Set<string>();
    for (let entry = 0; entry < location.entryCount; entry += 1) {
      if (position + 46 > centralDirectoryEnd) throw invalidZip();
      const header = await readExactly(file, position, 46);
      if (header.readUInt32LE(0) !== CENTRAL_FILE_HEADER_SIGNATURE || header.readUInt16LE(34) !== 0) throw invalidZip();
      const filenameLength = header.readUInt16LE(28);
      const filenameBytes = await readExactly(file, position + 46, filenameLength);
      if ((header.readUInt16LE(8) & UTF8_FILENAME_FLAG) === 0 && filenameBytes.some((byte) => byte >= 0x80)) throw invalidZip();
      let filename: string;
      try { filename = utf8Decoder.decode(filenameBytes); } catch { throw invalidZip(); }
      if (!expectedNames.has(filename) || seenNames.has(filename) || !Buffer.from(filename, "utf8").equals(filenameBytes)) throw invalidZip();
      seenNames.add(filename);
      const variableLength = filenameLength + header.readUInt16LE(30) + header.readUInt16LE(32);
      position += 46 + variableLength;
      if (position > centralDirectoryEnd) throw invalidZip();
    }
    if (position !== centralDirectoryEnd || seenNames.size !== expectedNames.size) throw invalidZip();
  } finally {
    await file.close();
  }
};
