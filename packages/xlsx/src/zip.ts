/**
 * The smallest zip layer an .xlsx needs (PKWARE APPNOTE 6.3.x, the parts Excel writes):
 * - the reader walks the end of central directory record and the central directory, then reads
 *   one entry at a time through its local file header; methods 0 (stored) and 8 (deflate) only,
 *   with inflate injected so the same code runs under Node (zlib) and in a browser
 *   (DecompressionStream);
 * - the writer emits stored entries only, with every timestamp fixed to 1980-01-01 00:00 (the
 *   earliest MS-DOS date), so the same input always gives the same bytes and nothing reads the
 *   wall clock.
 * Anything else (zip64, multi-disk archives, encryption, other methods) is refused with a plain
 * message rather than guessed at.
 */
import { concatBytes, decodeUtf8, encodeUtf8, viewOf } from './bytes.js';
import { crc32 } from './crc32.js';
import { WorkbookError } from './errors.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** The zip64 end of central directory locator: 20 bytes that sit right before the end record. */
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LOCATOR_LENGTH = 20;
const END_RECORD_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8_NAMES = 0x0800;
const VERSION_2_0 = 20;
/** 1980-01-01 in MS-DOS date form: year 0 since 1980 (bits 9 to 15), month 1 (bits 5 to 8), day 1. */
const DOS_DATE_1980_01_01 = (1 << 5) | 1;
const DOS_TIME_MIDNIGHT = 0;
/** The first bytes of an OLE compound file, which is what an encrypted workbook (or a .xls) is. */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export const ZIP_METHOD_STORED = 0;
export const ZIP_METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Inflates one raw deflate stream (no zlib or gzip wrapper). `uncompressedSize` is the size the
 * archive declares, so an implementation that can cap its output (Node's zlib) refuses a stream
 * that grows past it; the reader checks the size and the checksum afterwards in any case.
 */
export type InflateRaw = (data: Uint8Array, uncompressedSize: number) => Promise<Uint8Array>;

function isOleContainer(bytes: Uint8Array): boolean {
  return OLE_SIGNATURE.every((b, i) => bytes[i] === b);
}

function findEndRecord(bytes: Uint8Array, view: DataView): number {
  const last = bytes.length - END_RECORD_LENGTH;
  const first = Math.max(0, last - MAX_COMMENT_LENGTH);
  for (let i = last; i >= first; i -= 1) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  return -1;
}

/** Lists the entries of a zip archive by name, from its central directory. */
export function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  if (isOleContainer(bytes)) {
    throw new WorkbookError(
      'The file is an encrypted workbook or an old binary Excel file; save it as an unencrypted .xlsx',
      'encrypted',
    );
  }
  if (bytes.length < END_RECORD_LENGTH) {
    throw new WorkbookError('The file is not a zip archive, so not an .xlsx workbook', 'not_zip');
  }
  const view = viewOf(bytes);
  const end = findEndRecord(bytes, view);
  if (end < 0) {
    throw new WorkbookError('The file is not a zip archive, so not an .xlsx workbook', 'not_zip');
  }
  const diskNumber = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const entryCount = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new WorkbookError(
      'The file is a zip64 archive, which the reader does not support',
      'unsupported',
    );
  }
  if (diskNumber !== 0 || directoryDisk !== 0) {
    throw new WorkbookError(
      'The file is a multi-part zip archive, which the reader does not support',
      'unsupported',
    );
  }
  if (
    end >= ZIP64_LOCATOR_LENGTH &&
    view.getUint32(end - ZIP64_LOCATOR_LENGTH, true) === ZIP64_LOCATOR
  ) {
    throw new WorkbookError(
      'The file is a zip64 archive, which the reader does not support',
      'unsupported',
    );
  }
  if (directoryOffset + directorySize > end) {
    throw new WorkbookError(
      'The zip archive is damaged: its central directory lies outside the file',
      'corrupt',
    );
  }
  const entries = new Map<string, ZipEntry>();
  let position = directoryOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (
      position + CENTRAL_HEADER_LENGTH > end ||
      view.getUint32(position, true) !== CENTRAL_HEADER
    ) {
      throw new WorkbookError(
        'The zip archive is damaged: a central directory entry is missing',
        'corrupt',
      );
    }
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const crc = view.getUint32(position + 16, true);
    const compressedSize = view.getUint32(position + 20, true);
    const uncompressedSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localHeaderOffset = view.getUint32(position + 42, true);
    const nameStart = position + CENTRAL_HEADER_LENGTH;
    if (nameStart + nameLength > end) {
      throw new WorkbookError(
        'The zip archive is damaged: an entry name runs past the directory',
        'corrupt',
      );
    }
    const name = decodeUtf8(bytes.subarray(nameStart, nameStart + nameLength), 'A zip entry name');
    if (entries.has(name)) {
      throw new WorkbookError(`The zip archive holds two entries named ${name}`, 'corrupt');
    }
    entries.set(name, {
      name,
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    position = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Reads and checks one entry. A declared size over `maxBytes` is refused before anything is
 * inflated; the inflated bytes must match the declared size and checksum.
 */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  inflateRaw: InflateRaw,
  maxBytes: number,
): Promise<Uint8Array> {
  if (entry.flags & FLAG_ENCRYPTED) {
    throw new WorkbookError(`The file is encrypted (${entry.name} cannot be read)`, 'encrypted');
  }
  if (entry.method !== ZIP_METHOD_STORED && entry.method !== ZIP_METHOD_DEFLATE) {
    throw new WorkbookError(
      `${entry.name} uses zip compression method ${entry.method}, which the reader does not support`,
      'unsupported',
    );
  }
  if (entry.uncompressedSize > maxBytes) {
    throw new WorkbookError(
      `${entry.name} declares ${entry.uncompressedSize} bytes, more than the ${maxBytes} the reader accepts`,
      'too_large',
    );
  }
  const view = viewOf(bytes);
  const header = entry.localHeaderOffset;
  if (
    header + LOCAL_HEADER_LENGTH > bytes.length ||
    view.getUint32(header, true) !== LOCAL_HEADER
  ) {
    throw new WorkbookError(
      `The zip archive is damaged: ${entry.name} has no local header`,
      'corrupt',
    );
  }
  const nameLength = view.getUint16(header + 26, true);
  const extraLength = view.getUint16(header + 28, true);
  const start = header + LOCAL_HEADER_LENGTH + nameLength + extraLength;
  const stop = start + entry.compressedSize;
  if (stop > bytes.length) {
    throw new WorkbookError(
      `The zip archive is damaged: ${entry.name} runs past the end of the file`,
      'corrupt',
    );
  }
  const stored = bytes.subarray(start, stop);
  let data: Uint8Array;
  if (entry.method === ZIP_METHOD_STORED) {
    data = stored;
  } else {
    try {
      data = await inflateRaw(stored, entry.uncompressedSize);
    } catch (cause) {
      throw new WorkbookError(`${entry.name} could not be decompressed`, 'corrupt', { cause });
    }
  }
  if (data.length !== entry.uncompressedSize) {
    throw new WorkbookError(
      `${entry.name} holds ${data.length} bytes where the archive declares ${entry.uncompressedSize}`,
      'corrupt',
    );
  }
  if (crc32(data) !== entry.crc) {
    throw new WorkbookError(`${entry.name} fails its checksum`, 'corrupt');
  }
  return data;
}

export interface ZipWriteEntry {
  name: string;
  data: Uint8Array;
  /**
   * The same data already deflated (raw, no wrapper), written with method 8. The workbook writer
   * never sets it (it stores); tests use it to prove the reader inflates.
   */
  deflated?: Uint8Array;
}

function localHeader(
  entry: ZipWriteEntry,
  name: Uint8Array,
  stored: Uint8Array,
  crc: number,
): Uint8Array {
  const out = new Uint8Array(LOCAL_HEADER_LENGTH);
  const view = viewOf(out);
  view.setUint32(0, LOCAL_HEADER, true);
  view.setUint16(4, VERSION_2_0, true);
  view.setUint16(6, FLAG_UTF8_NAMES, true);
  view.setUint16(8, entry.deflated ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORED, true);
  view.setUint16(10, DOS_TIME_MIDNIGHT, true);
  view.setUint16(12, DOS_DATE_1980_01_01, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, stored.length, true);
  view.setUint32(22, entry.data.length, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true);
  return out;
}

function centralHeader(
  entry: ZipWriteEntry,
  name: Uint8Array,
  stored: Uint8Array,
  crc: number,
  offset: number,
): Uint8Array {
  const out = new Uint8Array(CENTRAL_HEADER_LENGTH);
  const view = viewOf(out);
  view.setUint32(0, CENTRAL_HEADER, true);
  view.setUint16(4, VERSION_2_0, true);
  view.setUint16(6, VERSION_2_0, true);
  view.setUint16(8, FLAG_UTF8_NAMES, true);
  view.setUint16(10, entry.deflated ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORED, true);
  view.setUint16(12, DOS_TIME_MIDNIGHT, true);
  view.setUint16(14, DOS_DATE_1980_01_01, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, stored.length, true);
  view.setUint32(24, entry.data.length, true);
  view.setUint16(28, name.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  return out;
}

/** Writes a zip archive with the entries in the order given. Deterministic: no clock, no randomness. */
export function writeZip(entries: readonly ZipWriteEntry[]): Uint8Array {
  if (entries.length > 0xfffe) {
    throw new WorkbookError(`A zip archive cannot hold ${entries.length} entries`, 'invalid_input');
  }
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new WorkbookError(
        `A zip archive cannot hold two entries named ${entry.name}`,
        'invalid_input',
      );
    }
    seen.add(entry.name);
    const name = encodeUtf8(entry.name);
    const stored = entry.deflated ?? entry.data;
    const crc = crc32(entry.data);
    const header = localHeader(entry, name, stored, crc);
    directory.push(centralHeader(entry, name, stored, crc, offset), name);
    parts.push(header, name, stored);
    offset += header.length + name.length + stored.length;
  }
  const directoryBytes = concatBytes(directory);
  const end = new Uint8Array(END_RECORD_LENGTH);
  const view = viewOf(end);
  view.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, directoryBytes.length, true);
  view.setUint32(16, offset, true);
  view.setUint16(20, 0, true);
  return concatBytes([...parts, directoryBytes, end]);
}
