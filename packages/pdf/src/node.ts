/**
 * The Node inflater for `readPdf` (`@pb/pdf/node`). Kept out of the main entry so a browser
 * bundle never sees zlib; the browser passes a DecompressionStream wrapper instead (see the
 * README).
 */
import { inflateSync } from 'node:zlib';
import { PdfError } from './errors.js';
import type { Inflate } from './filters.js';

/**
 * Inflates a zlib-wrapped deflate stream (RFC 1950, what FlateDecode holds) with zlib. The
 * reader's stream limit is passed as `maxOutputLength`, so a stream that inflates past it is
 * refused (`too_large`) before it fills memory; any other zlib failure is `corrupt`.
 */
export const nodeInflate: Inflate = (data, maxOutputBytes) => {
  try {
    const result = inflateSync(data, { maxOutputLength: Math.max(1, maxOutputBytes) });
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  } catch (cause) {
    if (
      cause instanceof RangeError ||
      (typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        cause.code === 'ERR_BUFFER_TOO_LARGE')
    ) {
      throw new PdfError(
        `A stream inflates past the ${maxOutputBytes} bytes the reader accepts`,
        'too_large',
        { cause },
      );
    }
    throw new PdfError('A FlateDecode stream could not be inflated', 'corrupt', { cause });
  }
};
