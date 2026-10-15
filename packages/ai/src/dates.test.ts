import { describe, expect, it } from 'vitest';
import { isCalendarDate, isQuarterEnd, parseMonthDayYear } from './dates.js';

describe('date text helpers', () => {
  it('knows a real calendar date', () => {
    expect(isCalendarDate('2025-06-30')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2025-02-29')).toBe(false);
    expect(isCalendarDate('2025-13-01')).toBe(false);
    expect(isCalendarDate('2025-6-30')).toBe(false);
    expect(isCalendarDate('0000-01-01')).toBe(false);
  });

  it('knows a quarter end', () => {
    for (const d of ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31']) {
      expect(isQuarterEnd(d)).toBe(true);
    }
    for (const d of ['2025-06-29', '2025-07-31', '2025-01-31', 'not a date']) {
      expect(isQuarterEnd(d)).toBe(false);
    }
  });

  it('parses "Month D, YYYY" into an ISO date and refuses an impossible day', () => {
    expect(parseMonthDayYear('for the quarter ended June 30, 2025 the company')).toBe('2025-06-30');
    expect(parseMonthDayYear('as of March 31 2025')).toBe('2025-03-31');
    expect(parseMonthDayYear('as of february 30, 2025')).toBeNull();
    expect(parseMonthDayYear('no date here')).toBeNull();
  });
});
