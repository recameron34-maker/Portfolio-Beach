/**
 * The Node inflater for `readWorkbook` (`@pb/xlsx/node`). Kept out of the main entry so a
 * browser bundle never sees zlib; the browser passes a DecompressionStream wrapper instead (see
 * the README).
 */
import { inflateRaw } from 'node:zlib';
import type { InflateRaw } from './zip.js';

/**
 * Inflates a raw deflate stream with zlib. When the archive declares the size, zlib is told to
 * stop there (`maxOutputLength`), so a stream that inflates past what it declares is refused
 * before it fills memory.
 */
export const nodeInflateRaw: InflateRaw = (data, uncompressedSize) =>
  new Promise((resolve, reject) => {
    const options = { maxOutputLength: Math.max(1, uncompressedSize) };
    inflateRaw(data, options, (error, result) => {
      if (error) reject(error);
      else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
    });
  });
