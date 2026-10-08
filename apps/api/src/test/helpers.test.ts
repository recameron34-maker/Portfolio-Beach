import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { fmtDate } from '../common/dates.js';
import { ProblemError } from '../common/problem.js';
import { lockedNear } from '../portfolio/marks.js';
import type { ValuationRow } from '../portfolio/metrics.js';

/* The shared helpers every service imports instead of keeping its own copy (CLAUDE.md rule 7). */

const mark = (periodEnd: string, fairValue: string, state = 'Locked'): ValuationRow => ({
  periodEnd,
  version: 1,
  state,
  fairValue,
  method: 'valuation_method.sponsor_mark',
});

describe('lockedNear: the Locked mark that counts for a quarter end', () => {
  it('takes the latest Locked mark up to the tolerance before the target, never after it', () => {
    const marks = [mark('2025-03-24', '1'), mark('2025-03-28', '2'), mark('2025-04-01', '3')];
    expect(lockedNear(marks, '2025-03-31', 7)?.fairValue).toBe('2');
    // Exactly the tolerance away still counts; one day more does not.
    expect(lockedNear([mark('2025-03-24', '1')], '2025-03-31', 7)?.fairValue).toBe('1');
    expect(lockedNear([mark('2025-03-23', '1')], '2025-03-31', 7)).toBeNull();
    expect(lockedNear([mark('2025-04-01', '3')], '2025-03-31', 7)).toBeNull();
  });

  it('ignores every state but Locked and keeps the first of equal period ends', () => {
    expect(lockedNear([mark('2025-03-31', '9', 'Draft')], '2025-03-31', 7)).toBeNull();
    const twice = [mark('2025-03-31', 'first'), mark('2025-03-31', 'second')];
    expect(lockedNear(twice, '2025-03-31', 7)?.fairValue).toBe('first');
  });
});

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
