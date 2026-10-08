import { describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { fmtDate } from '../common/dates.js';
import { compareDecimalDesc, compareText, sumCalculable } from '../common/order.js';
import { ProblemError } from '../common/problem.js';
import { asOfOrToday, requireUuid } from '../common/validate.js';

/* The shared helpers every service imports instead of keeping its own copy (CLAUDE.md rule 7). */

describe('fmtDate: dates in sentences', () => {
  it('writes the short month, the day without padding and the year', () => {
    expect(fmtDate('2025-03-31')).toBe('Mar 31, 2025');
    expect(fmtDate('2024-02-09')).toBe('Feb 9, 2024');
    expect(fmtDate('1999-12-01')).toBe('Dec 1, 1999');
  });
});

describe('single-key cursors share the composite cursor helpers', () => {
  it('encodes one key exactly as plain base64url and reads it back', () => {
    for (const key of ['INV-0012', '123456789', 'Kelpwood Capital Partners']) {
      const cursor = encodeCursor([key]);
      expect(cursor).toBe(Buffer.from(key, 'utf8').toString('base64url'));
      expect(decodeCursor(cursor, /^(.*)$/s)).toEqual([key]);
    }
  });

  it('answers a forged cursor with a 400 validation problem', () => {
    const forged = encodeCursor(['1; drop table x']);
    expect(() => decodeCursor(forged, /^(\d{1,19})$/)).toThrow(ProblemError);
    try {
      decodeCursor(forged, /^(\d{1,19})$/);
    } catch (error) {
      expect((error as ProblemError).getStatus()).toBe(400);
      expect((error as ProblemError).code).toBe('validation');
    }
  });
});

/** The status and code of the problem a call throws, or null when it does not throw. */
function problemOf(call: () => unknown): { status: number; code: string } | null {
  try {
    call();
    return null;
  } catch (error) {
    if (!(error instanceof ProblemError)) throw error;
    return { status: error.getStatus(), code: error.code };
  }
}

describe('the as-of date and path ids every controller reads', () => {
  const clock = { today: () => '2025-06-30' };

  it('takes a real calendar date from the query, and today from the clock when there is none', () => {
    expect(asOfOrToday({ asOf: '2024-12-31' }, clock)).toBe('2024-12-31');
    expect(asOfOrToday({}, clock)).toBe('2025-06-30');
  });

  it('answers an impossible or malformed date with a 400, never a silent fallback', () => {
    expect(problemOf(() => asOfOrToday({ asOf: '2025-02-30' }, clock))).toEqual({
      status: 400,
      code: 'validation',
    });
    expect(problemOf(() => asOfOrToday({ asOf: 'junk' }, clock))?.status).toBe(400);
  });

  it('treats a path id that is not a UUID as not found', () => {
    expect(problemOf(() => requireUuid('e48127ca-a712-4516-beb1-5fbf2b501ed5', 'Gone'))).toBeNull();
    expect(problemOf(() => requireUuid("1' or '1'='1", 'Investment not found'))).toEqual({
      status: 404,
      code: 'not-found',
    });
  });
});

describe('ordering and totals the read services share', () => {
  it('sorts text in byte order, the same in every locale', () => {
    expect(['Beach Co-Invest Fund I', 'Beach CV Opportunities I'].sort(compareText)).toEqual([
      'Beach CV Opportunities I',
      'Beach Co-Invest Fund I',
    ]);
  });

  it('puts the largest figure first and the not calculable ones last', () => {
    const values = ['12.5', null, '-3', D('40'), null, '0'];
    expect(
      [...values].sort(compareDecimalDesc).map((v) => (v === null ? null : String(v))),
    ).toEqual(['40', '12.5', '0', '-3', null, null]);
  });

  it('sums only calculable figures and answers null, never 0, when none is', () => {
    expect(sumCalculable(['1.25', null, '2.75'], (v) => v)?.toString()).toBe('4');
    expect(sumCalculable([null, null], (v) => v)).toBeNull();
    expect(sumCalculable([] as (string | null)[], (v) => v)).toBeNull();
  });
});
