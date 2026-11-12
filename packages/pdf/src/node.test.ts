import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PdfError } from './errors.js';
import { nodeInflate } from './node.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('nodeInflate', () => {
  it('inflates a zlib stream to a plain Uint8Array', async () => {
    const data = bytes('hello hello hello');
    const result = await nodeInflate(new Uint8Array(deflateSync(data)), data.length);
    expect(result).toEqual(data);
    expect(Object.getPrototypeOf(result)).toBe(Uint8Array.prototype);
  });

  it('inflates an empty stream', async () => {
    const result = await nodeInflate(new Uint8Array(deflateSync(new Uint8Array(0))), 0);
    expect(result.length).toBe(0);
  });

  it('refuses a stream that inflates past the cap with too_large', () => {
    const data = bytes('x'.repeat(10_000));
    try {
      void nodeInflate(new Uint8Array(deflateSync(data)), 100);
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
      expect((error as PdfError).code).toBe('too_large');
      return;
    }
    throw new Error('expected a refusal');
  });

  it('accepts a stream that inflates to exactly the cap', () => {
    const data = bytes('y'.repeat(100));
    expect(nodeInflate(new Uint8Array(deflateSync(data)), 100)).toEqual(data);
  });

  it('refuses bytes that are not a zlib stream with corrupt', () => {
    try {
      void nodeInflate(bytes('not deflate at all'), 100);
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
      expect((error as PdfError).code).toBe('corrupt');
      return;
    }
    throw new Error('expected a refusal');
  });
});
