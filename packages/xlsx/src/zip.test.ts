import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32.js';
import { WorkbookError } from './errors.js';
import { nodeInflateRaw } from './node.js';
import {
  readZipDirectory,
  readZipEntry,
  writeZip,
  ZIP_METHOD_DEFLATE,
  ZIP_METHOD_STORED,
} from './zip.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const text = (data: Uint8Array): string => decoder.decode(data);
const deflated = (data: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(data));

const view = (data: Uint8Array): DataView =>
  new DataView(data.buffer, data.byteOffset, data.byteLength);
const directoryOffset = (archive: Uint8Array): number =>
  view(archive).getUint32(archive.length - 22 + 16, true);

async function refusal(run: () => unknown): Promise<WorkbookError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkbookError);
    return error as WorkbookError;
  }
  throw new Error('expected a WorkbookError');
}

describe('writeZip and readZipDirectory', () => {
  it('round-trips stored entries in order with the sizes and checksum the directory declares', async () => {
    const archive = writeZip([
      { name: 'first.txt', data: bytes('hello') },
      { name: 'dir/second.xml', data: bytes('<a/>') },
      { name: 'empty', data: new Uint8Array(0) },
    ]);
    const directory = readZipDirectory(archive);
    expect([...directory.keys()]).toEqual(['first.txt', 'dir/second.xml', 'empty']);
    const first = directory.get('first.txt')!;
    expect(first.method).toBe(ZIP_METHOD_STORED);
    expect(first.compressedSize).toBe(5);
    expect(first.uncompressedSize).toBe(5);
    expect(first.crc).toBe(crc32(bytes('hello')));
    expect(text(await readZipEntry(archive, first, nodeInflateRaw, 1024))).toBe('hello');
    expect(
      text(await readZipEntry(archive, directory.get('dir/second.xml')!, nodeInflateRaw, 1024)),
    ).toBe('<a/>');
    expect(
      (await readZipEntry(archive, directory.get('empty')!, nodeInflateRaw, 1024)).length,
    ).toBe(0);
  });

  it('writes the same bytes for the same entries and fixes every timestamp to 1980-01-01', () => {
    const entries = [{ name: 'a', data: bytes('one') }];
    const archive = writeZip(entries);
    expect(writeZip(entries)).toEqual(archive);
    const local = view(archive);
    expect(local.getUint16(10, true)).toBe(0);
    expect(local.getUint16(12, true)).toBe(0x0021);
    const central = directoryOffset(archive);
    expect(local.getUint16(central + 12, true)).toBe(0);
    expect(local.getUint16(central + 14, true)).toBe(0x0021);
  });

  it('reads a deflated entry (method 8) through the injected inflater and checks it', async () => {
    const data = bytes('deflate me '.repeat(100));
    const archive = writeZip([{ name: 'd.txt', data, deflated: deflated(data) }]);
    const entry = readZipDirectory(archive).get('d.txt')!;
    expect(entry.method).toBe(ZIP_METHOD_DEFLATE);
    expect(entry.compressedSize).toBeLessThan(data.length);
    expect(entry.uncompressedSize).toBe(data.length);
    expect(await readZipEntry(archive, entry, nodeInflateRaw, 1 << 20)).toEqual(data);
  });

  it('refuses an inflater result that does not match what the archive declares', async () => {
    const data = bytes('declared');
    const archive = writeZip([{ name: 'd', data, deflated: deflated(data) }]);
    const entry = readZipDirectory(archive).get('d')!;
    const short = await refusal(() =>
      readZipEntry(archive, entry, () => Promise.resolve(bytes('decl')), 1024),
    );
    expect(short.code).toBe('corrupt');
    expect(short.message).toBe('d holds 4 bytes where the archive declares 8');
    const wrong = await refusal(() =>
      readZipEntry(archive, entry, () => Promise.resolve(bytes('declareX')), 1024),
    );
    expect(wrong.code).toBe('corrupt');
    expect(wrong.message).toBe('d fails its checksum');
    const failing = await refusal(() =>
      readZipEntry(archive, entry, () => Promise.reject(new Error('bad stream')), 1024),
    );
    expect(failing.code).toBe('corrupt');
    expect(failing.message).toBe('d could not be decompressed');
    expect((failing.cause as Error).message).toBe('bad stream');
  });

  it('refuses a stored entry whose bytes were changed', async () => {
    const archive = writeZip([{ name: 's', data: bytes('intact') }]);
    const entry = readZipDirectory(archive).get('s')!;
    archive[30 + 1 + 2] = 0x58;
    const error = await refusal(() => readZipEntry(archive, entry, nodeInflateRaw, 1024));
    expect(error.code).toBe('corrupt');
  });

  it('refuses a declared size over the limit before inflating anything', async () => {
    const data = bytes('twelve bytes');
    const archive = writeZip([{ name: 'big', data, deflated: deflated(data) }]);
    const entry = readZipDirectory(archive).get('big')!;
    let inflated = false;
    const error = await refusal(() =>
      readZipEntry(
        archive,
        entry,
        (d, size) => {
          inflated = true;
          return nodeInflateRaw(d, size);
        },
        11,
      ),
    );
    expect(error.code).toBe('too_large');
    expect(error.message).toBe('big declares 12 bytes, more than the 11 the reader accepts');
    expect(inflated).toBe(false);
  });

  it('refuses bytes that are not a zip archive', async () => {
    expect((await refusal(() => readZipDirectory(new Uint8Array([1, 2, 3])))).code).toBe('not_zip');
    const noise = new Uint8Array(100).fill(0x41);
    const error = await refusal(() => readZipDirectory(noise));
    expect(error.code).toBe('not_zip');
    expect(error.message).toBe('The file is not a zip archive, so not an .xlsx workbook');
  });

  it('names an encrypted workbook (an OLE container) for what it is', async () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const error = await refusal(() => readZipDirectory(ole));
    expect(error.code).toBe('encrypted');
  });

  it('refuses an encrypted entry, an unsupported method, zip64 and a duplicated name', async () => {
    const make = (): Uint8Array =>
      writeZip([
        { name: 'a', data: bytes('1') },
        { name: 'b', data: bytes('2') },
      ]);
    const encrypted = make();
    view(encrypted).setUint16(directoryOffset(encrypted) + 8, 0x0801, true);
    const entry = readZipDirectory(encrypted).get('a')!;
    expect((await refusal(() => readZipEntry(encrypted, entry, nodeInflateRaw, 1024))).code).toBe(
      'encrypted',
    );

    const bzip = make();
    view(bzip).setUint16(directoryOffset(bzip) + 10, 12, true);
    const bzipEntry = readZipDirectory(bzip).get('a')!;
    const unsupported = await refusal(() => readZipEntry(bzip, bzipEntry, nodeInflateRaw, 1024));
    expect(unsupported.code).toBe('unsupported');
    expect(unsupported.message).toBe(
      'a uses zip compression method 12, which the reader does not support',
    );

    const zip64 = make();
    view(zip64).setUint16(zip64.length - 22 + 10, 0xffff, true);
    expect((await refusal(() => readZipDirectory(zip64))).code).toBe('unsupported');

    const duplicate = make();
    const second = directoryOffset(duplicate) + 46 + 1;
    duplicate[second + 46] = 0x61;
    const error = await refusal(() => readZipDirectory(duplicate));
    expect(error.code).toBe('corrupt');
    expect(error.message).toBe('The zip archive holds two entries named a');
  });

  it('refuses a directory that lies outside the file', async () => {
    const archive = writeZip([{ name: 'a', data: bytes('1') }]);
    view(archive).setUint32(archive.length - 22 + 16, archive.length, true);
    expect((await refusal(() => readZipDirectory(archive))).code).toBe('corrupt');
  });

  it('the writer refuses two entries of the same name', async () => {
    const error = await refusal(() =>
      writeZip([
        { name: 'a', data: bytes('1') },
        { name: 'a', data: bytes('2') },
      ]),
    );
    expect(error.code).toBe('invalid_input');
  });
});
