import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { nodeInflateRaw } from './node.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('nodeInflateRaw', () => {
  it('inflates a raw deflate stream to a plain Uint8Array', async () => {
    const data = bytes('hello hello hello');
    const result = await nodeInflateRaw(new Uint8Array(deflateRawSync(data)), data.length);
    expect(result).toEqual(data);
    expect(Object.getPrototypeOf(result)).toBe(Uint8Array.prototype);
  });

  it('inflates an empty stream', async () => {
    const result = await nodeInflateRaw(new Uint8Array(deflateRawSync(new Uint8Array(0))), 0);
    expect(result.length).toBe(0);
  });

  it('refuses a stream that inflates past the size the archive declares', async () => {
    const data = bytes('x'.repeat(10_000));
    await expect(nodeInflateRaw(new Uint8Array(deflateRawSync(data)), 100)).rejects.toThrow();
  });

  it('refuses bytes that are not a deflate stream', async () => {
    await expect(nodeInflateRaw(bytes('not deflate at all'), 100)).rejects.toThrow();
  });
});
