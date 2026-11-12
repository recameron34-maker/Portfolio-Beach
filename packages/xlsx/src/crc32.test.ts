import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('crc32', () => {
  it('matches the published check values', () => {
    expect(crc32(bytes(''))).toBe(0);
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('is unsigned and sees a view at an offset as its own bytes', () => {
    const backing = bytes('xx123456789');
    expect(crc32(backing.subarray(2))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBeGreaterThanOrEqual(0);
  });
});
