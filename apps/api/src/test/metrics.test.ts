import { describe, expect, it } from 'vitest';
import { latestQuarterEndOnOrBefore, lockedNavSeries } from '../portfolio/metrics.js';
import type { ValuationRow } from '../portfolio/metrics.js';

const mark = (periodEnd: string, fairValue: string, state = 'Locked'): ValuationRow => ({
  periodEnd,
  version: 1,
  state,
  fairValue,
  method: 'valuation_method.sponsor_mark',
});

const RULE = { quarters: 8, toleranceDays: 7 };

describe('latestQuarterEndOnOrBefore', () => {
  it('returns the date itself on a quarter end and the previous quarter end otherwise', () => {
    expect(latestQuarterEndOnOrBefore('2025-06-30')).toBe('2025-06-30');
    expect(latestQuarterEndOnOrBefore('2025-06-27')).toBe('2025-03-31');
    expect(latestQuarterEndOnOrBefore('2025-05-15')).toBe('2025-03-31');
    expect(latestQuarterEndOnOrBefore('2025-01-01')).toBe('2024-12-31');
    expect(latestQuarterEndOnOrBefore('2024-12-31')).toBe('2024-12-31');
  });
});

describe('lockedNavSeries: the one NAV series rule', () => {
  it('folds marks a few days off the calendar quarter end into that quarter end', () => {
    const shifted = [mark('2025-03-28', '10'), mark('2025-06-27', '11')];
    const calendar = [mark('2025-03-31', '20.5'), mark('2025-06-30', '21')];
    const late = [mark('2025-04-03', '5')];
    expect(lockedNavSeries([shifted, calendar, late], '2025-06-30', RULE)).toEqual([
      { periodEnd: '2025-03-31', value: '35.5' },
      { periodEnd: '2025-06-30', value: '32' },
    ]);
  });

  it('keeps a mark further than the tolerance from any quarter end on its own date', () => {
    expect(
      lockedNavSeries([[mark('2025-05-15', '7'), mark('2025-06-27', '8')]], '2025-06-30', {
        quarters: 8,
        toleranceDays: 2,
      }),
    ).toEqual([
      { periodEnd: '2025-05-15', value: '7' },
      { periodEnd: '2025-06-27', value: '8' },
    ]);
  });

  it('never drops a mark: one whose quarter has not ended by the as-of date keeps its own date', () => {
    expect(lockedNavSeries([[mark('2025-06-27', '8')]], '2025-06-28', RULE)).toEqual([
      { periodEnd: '2025-06-27', value: '8' },
    ]);
  });

  it('counts Locked marks on or before the as-of date only', () => {
    const set = [
      mark('2025-03-31', '1', 'Draft'),
      mark('2025-03-31', '2', 'Reopened'),
      mark('2025-03-31', '3'),
      // Within the tolerance of 2025-06-30, but reported after the as-of date.
      mark('2025-07-02', '4'),
    ];
    expect(lockedNavSeries([set], '2025-07-01', RULE)).toEqual([
      { periodEnd: '2025-03-31', value: '3' },
    ]);
  });

  it('counts a position once per point: the later of two marks that fold together', () => {
    expect(
      lockedNavSeries([[mark('2025-06-27', '10'), mark('2025-06-30', '12')]], '2025-06-30', RULE),
    ).toEqual([{ periodEnd: '2025-06-30', value: '12' }]);
  });

  it('keeps the latest configured number of points, oldest first', () => {
    const set = ['2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30'].map((d, i) =>
      mark(d, String(i + 1)),
    );
    expect(lockedNavSeries([set], '2025-06-30', { quarters: 2, toleranceDays: 7 })).toEqual([
      { periodEnd: '2025-03-31', value: '3' },
      { periodEnd: '2025-06-30', value: '4' },
    ]);
    expect(lockedNavSeries([set], '2025-06-30', { quarters: 0, toleranceDays: 7 })).toEqual([]);
  });
});
