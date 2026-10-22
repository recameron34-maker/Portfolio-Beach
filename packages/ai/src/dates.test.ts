import { describe, expect, it } from 'vitest';
import { parseMonthDayYear } from './dates.js';

describe('date text helpers', () => {
  it('parses "Month D, YYYY" into an ISO date and refuses an impossible day', () => {
    expect(parseMonthDayYear('for the quarter ended June 30, 2025 the company')).toBe('2025-06-30');
    expect(parseMonthDayYear('as of March 31 2025')).toBe('2025-03-31');
    expect(parseMonthDayYear('as of february 30, 2025')).toBeNull();
    expect(parseMonthDayYear('no date here')).toBeNull();
  });
});
