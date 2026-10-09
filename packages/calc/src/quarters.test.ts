import { describe, expect, it } from 'vitest';
import {
  addDays,
  alignedQuarterEnd,
  containingQuarterEnd,
  daysBetween,
  latestQuarterEndOnOrBefore,
  lockedNear,
  nextQuarterEnd,
} from './index.js';

describe('latestQuarterEndOnOrBefore', () => {
  it('returns the date itself on a quarter end and the previous quarter end otherwise', () => {
    expect(latestQuarterEndOnOrBefore('2025-06-30')).toBe('2025-06-30');
    expect(latestQuarterEndOnOrBefore('2025-06-27')).toBe('2025-03-31');
    expect(latestQuarterEndOnOrBefore('2025-05-15')).toBe('2025-03-31');
    expect(latestQuarterEndOnOrBefore('2025-01-01')).toBe('2024-12-31');
    expect(latestQuarterEndOnOrBefore('2024-12-31')).toBe('2024-12-31');
    expect(latestQuarterEndOnOrBefore('2025-10-01')).toBe('2025-09-30');
  });

  it('holds on every quarter boundary, leap days and century years included', () => {
    for (const year of [1900, 2000, 2023, 2024, 2025, 2100]) {
      const ends = [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`];
      ends.forEach((end, i) => {
        const before = i === 0 ? `${year - 1}-12-31` : ends[i - 1]!;
        expect(latestQuarterEndOnOrBefore(end)).toBe(end);
        expect(latestQuarterEndOnOrBefore(addDays(end, 1))).toBe(end);
        expect(latestQuarterEndOnOrBefore(addDays(end, -1))).toBe(before);
      });
    }
    expect(latestQuarterEndOnOrBefore('2024-02-29')).toBe('2023-12-31');
    expect(latestQuarterEndOnOrBefore('2000-02-29')).toBe('1999-12-31');
    expect(latestQuarterEndOnOrBefore('1900-03-01')).toBe('1899-12-31');
  });

  it('agrees with a month-day table on every day of four boundary windows', () => {
    // An independent oracle: the latest of 12-31, 09-30, 06-30 and 03-31 not after the month-day.
    const oracle = (iso: string): string => {
      const year = Number(iso.slice(0, 4));
      const monthDay = iso.slice(5);
      const end = ['12-31', '09-30', '06-30', '03-31'].find((md) => md <= monthDay);
      return end === undefined ? `${year - 1}-12-31` : `${iso.slice(0, 4)}-${end}`;
    };
    const windows: [string, string][] = [
      ['1899-12-01', '1900-04-30'],
      ['1999-12-01', '2001-01-31'],
      ['2023-12-01', '2026-01-31'],
      ['2099-12-01', '2100-04-30'],
    ];
    let days = 0;
    for (const [from, to] of windows) {
      for (let d = from; d <= to; d = addDays(d, 1)) {
        expect(latestQuarterEndOnOrBefore(d), d).toBe(oracle(d));
        days += 1;
      }
    }
    expect(days).toBeGreaterThan(1500);
  });
});

describe('alignedQuarterEnd', () => {
  it('folds a period end within the tolerance to the nearest calendar quarter end', () => {
    expect(alignedQuarterEnd('2025-06-30', 7)).toBe('2025-06-30');
    expect(alignedQuarterEnd('2025-06-27', 7)).toBe('2025-06-30');
    expect(alignedQuarterEnd('2025-03-28', 7)).toBe('2025-03-31');
    expect(alignedQuarterEnd('2025-07-03', 7)).toBe('2025-06-30');
    expect(alignedQuarterEnd('2024-12-28', 7)).toBe('2024-12-31');
    expect(alignedQuarterEnd('2025-01-02', 7)).toBe('2024-12-31');
  });

  it('keeps a period end further from any quarter end as reported', () => {
    expect(alignedQuarterEnd('2025-06-20', 7)).toBe('2025-06-20');
    expect(alignedQuarterEnd('2025-05-15', 7)).toBe('2025-05-15');
    expect(alignedQuarterEnd('2025-06-27', 0)).toBe('2025-06-27');
  });

  it('moves a date only onto a quarter end, and never further than the tolerance', () => {
    let moved = 0;
    for (let d = '2023-12-01'; d <= '2026-01-31'; d = addDays(d, 1)) {
      const aligned = alignedQuarterEnd(d, 7);
      if (aligned === d) continue;
      moved += 1;
      expect(latestQuarterEndOnOrBefore(aligned), d).toBe(aligned);
      expect(Math.abs(daysBetween(d, aligned)), d).toBeLessThanOrEqual(7);
    }
    // 8 quarter ends in the window, each drawing up to 7 days on either side.
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(9 * 14);
  });
});

const mark = (periodEnd: string, fairValue: string, state = 'Locked') => ({
  periodEnd,
  state,
  fairValue,
});

describe('lockedNear: the Locked mark that counts for a quarter end', () => {
  it('takes the latest Locked mark that reports for the quarter, early or late', () => {
    const marks = [mark('2025-03-24', '1'), mark('2025-03-28', '2')];
    expect(lockedNear(marks, '2025-03-31', 7)?.fairValue).toBe('2');
    // A sponsor closing a few days late reports for the same quarter, as alignedQuarterEnd says.
    expect(lockedNear([...marks, mark('2025-04-03', '3')], '2025-03-31', 7)?.fairValue).toBe('3');
    // Exactly the tolerance away on either side still counts; one day more does not.
    expect(lockedNear([mark('2025-03-24', '1')], '2025-03-31', 7)?.fairValue).toBe('1');
    expect(lockedNear([mark('2025-04-07', '1')], '2025-03-31', 7)?.fairValue).toBe('1');
    expect(lockedNear([mark('2025-03-23', '1')], '2025-03-31', 7)).toBeNull();
    expect(lockedNear([mark('2025-04-08', '1')], '2025-03-31', 7)).toBeNull();
  });

  it('agrees with alignedQuarterEnd on every date around a quarter end', () => {
    for (let offset = -20; offset <= 20; offset += 1) {
      const periodEnd = addDays('2025-06-30', offset);
      const counted = lockedNear([mark(periodEnd, '1')], '2025-06-30', 7) !== null;
      expect(counted, periodEnd).toBe(alignedQuarterEnd(periodEnd, 7) === '2025-06-30');
    }
  });

  it('ignores every state but Locked and keeps the first of equal period ends', () => {
    expect(lockedNear([mark('2025-03-31', '9', 'Draft')], '2025-03-31', 7)).toBeNull();
    const twice = [mark('2025-03-31', 'first'), mark('2025-03-31', 'second')];
    expect(lockedNear(twice, '2025-03-31', 7)?.fairValue).toBe('first');
  });
});

describe('containingQuarterEnd and nextQuarterEnd', () => {
  it('names the end of the quarter a date falls in, and of the quarter after it', () => {
    expect(containingQuarterEnd('2025-02-10')).toBe('2025-03-31');
    expect(containingQuarterEnd('2025-03-31')).toBe('2025-03-31');
    expect(containingQuarterEnd('2024-12-01')).toBe('2024-12-31');
    expect(nextQuarterEnd('2025-02-10')).toBe('2025-06-30');
    expect(nextQuarterEnd('2025-03-31')).toBe('2025-06-30');
    expect(nextQuarterEnd('2024-11-30')).toBe('2025-03-31');
    expect(nextQuarterEnd('2024-08-31')).toBe('2024-12-31');
  });

  it('steps from quarter end to quarter end without drifting', () => {
    let q = '2020-03-31';
    for (let i = 0; i < 24; i++) {
      const next = nextQuarterEnd(q);
      expect(latestQuarterEndOnOrBefore(next)).toBe(next);
      expect(daysBetween(q, next)).toBeGreaterThanOrEqual(90);
      expect(daysBetween(q, next)).toBeLessThanOrEqual(92);
      q = next;
    }
    expect(q).toBe('2026-03-31');
  });
});
