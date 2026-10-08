import { describe, expect, it } from 'vitest';
import { daysBetween, formatHoldingPeriod } from './dates.js';
import { MISSING } from './format.js';

describe('daysBetween', () => {
  it('counts whole days without a time zone', () => {
    expect(daysBetween('2025-01-01', '2025-01-02')).toBe(1);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2025-06-30', '2025-06-30')).toBe(0);
    expect(daysBetween('2025-06-30', '2025-06-29')).toBe(-1);
  });

  it('is null for a malformed date', () => {
    expect(daysBetween('2025-6-30', '2025-06-30')).toBeNull();
  });
});

describe('formatHoldingPeriod', () => {
  it('shows years with one decimal from entry to exit', () => {
    expect(formatHoldingPeriod('2018-09-01', '2020-09-01')).toBe('2.0 years');
    expect(formatHoldingPeriod('2016-11-06', '2020-07-06')).toBe('3.7 years');
    expect(formatHoldingPeriod('2017-08-07', '2023-08-07')).toBe('6.0 years');
  });

  it('shows the missing placeholder rather than inventing a period', () => {
    expect(formatHoldingPeriod('2018-09-01', null)).toBe(MISSING);
    expect(formatHoldingPeriod(null, '2020-09-01')).toBe(MISSING);
    expect(formatHoldingPeriod('2020-09-01', '2018-09-01')).toBe(MISSING);
  });
});
