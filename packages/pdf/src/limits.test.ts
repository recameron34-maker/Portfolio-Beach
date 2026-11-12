import { describe, expect, it } from 'vitest';
import { READ_LIMITS, resolveLimits } from './limits.js';

describe('READ_LIMITS', () => {
  it('holds the defaults of decision 0012 and is frozen', () => {
    expect(READ_LIMITS).toEqual({
      maxBytes: 20 * 1024 * 1024,
      maxObjects: 100_000,
      maxPages: 500,
      maxStreamBytes: 16 * 1024 * 1024,
      maxTotalStreamBytes: 64 * 1024 * 1024,
      maxOperators: 2_000_000,
      maxDepth: 64,
    });
    expect(Object.isFrozen(READ_LIMITS)).toBe(true);
  });

  it('resolves a partial override onto the defaults', () => {
    expect(resolveLimits(undefined)).toEqual(READ_LIMITS);
    expect(resolveLimits({ maxPages: 3 })).toEqual({ ...READ_LIMITS, maxPages: 3 });
  });
});
