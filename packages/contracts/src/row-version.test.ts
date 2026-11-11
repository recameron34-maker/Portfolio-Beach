import { describe, expect, it } from 'vitest';
import {
  IF_MATCH_CASES,
  IF_MATCH_ISSUE,
  INVALID_IF_MATCH_DETAIL,
  STALE_ROW_VERSION_CODE,
  isFreshRow,
  parseIfMatch,
  rowVersionEtag,
  staleRowVersionDetail,
} from './row-version.js';

describe('If-Match (docs/17 section 3)', () => {
  it.each(IF_MATCH_CASES.map((c) => [c.name, c] as const))('reads %s', (_name, c) => {
    const parsed = parseIfMatch(c.header);
    if (c.expected === 'invalid') expect(parsed).toEqual({ ok: false });
    else
      expect(parsed).toEqual({
        ok: true,
        versions: c.expected === 'any' ? undefined : c.expected,
      });
  });

  it('covers every kind of answer, and names each case once', () => {
    const kinds = new Set(
      IF_MATCH_CASES.map((c) => (Array.isArray(c.expected) ? 'versions' : c.expected)),
    );
    expect(kinds).toEqual(new Set(['any', 'invalid', 'versions']));
    expect(new Set(IF_MATCH_CASES.map((c) => c.name)).size).toBe(IF_MATCH_CASES.length);
  });

  it('reads null, as Headers.get reports an absent header, as no header', () => {
    expect(parseIfMatch(null)).toEqual({ ok: true, versions: undefined });
  });

  it('lets a command run on the row version named, or when none is named', () => {
    expect(isFreshRow(undefined, 4)).toBe(true);
    expect(isFreshRow([4], 4)).toBe(true);
    expect(isFreshRow([1, 4], 4)).toBe(true);
    expect(isFreshRow([3], 4)).toBe(false);
    expect(isFreshRow([], 4)).toBe(false);
  });

  it('words the two refusals and tags an answer with the row version', () => {
    expect(INVALID_IF_MATCH_DETAIL).toBe('Invalid If-Match');
    expect(IF_MATCH_ISSUE).toEqual({
      path: 'If-Match',
      message: 'Expected the row version as an entity tag',
    });
    expect(STALE_ROW_VERSION_CODE).toBe('stale-row-version');
    expect(staleRowVersionDetail('valuation', 4)).toBe(
      'valuation: the record changed since it was read (it is now at row version 4); open it again',
    );
    expect(rowVersionEtag(4)).toBe('"4"');
    // An entity tag reads back as the row version it was made from.
    expect(parseIfMatch(rowVersionEtag(12))).toEqual({ ok: true, versions: [12] });
  });
});
