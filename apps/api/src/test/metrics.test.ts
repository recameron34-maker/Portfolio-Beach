import { describe, expect, it } from 'vitest';
import { addDays } from '@pb/calc';
import {
  latestQuarterEndOnOrBefore,
  lockedNavSeries,
  pooledPositionMetrics,
} from '../portfolio/metrics.js';
import type { FlowRow, ValuationRow } from '../portfolio/metrics.js';
import { NOTHING_POOLED } from './pools.js';

const mark = (periodEnd: string, fairValue: string, state = 'Locked'): ValuationRow => ({
  periodEnd,
  version: 1,
  state,
  fairValue,
  method: 'valuation_method.sponsor_mark',
});

const flow = (flowDate: string, flowType: string, amount: string): FlowRow => ({
  flowDate,
  flowType: `flow_type.${flowType}`,
  amount,
});

const RULE = { quarters: 8, toleranceDays: 7 };

describe('pooledPositionMetrics: one answer for every pooled view', () => {
  it('gives a set with no position null figures and the insufficient_flows flag, never 0', () => {
    expect(pooledPositionMetrics([], '2025-06-30')).toEqual(NOTHING_POOLED);
  });

  it('keeps the real zero NAV of a realized set and the null NAV of an unmarked active one', () => {
    const flows = [
      flow('2020-01-15', 'contribution', '-100'),
      flow('2023-06-30', 'distribution', '150'),
    ];
    const realized = pooledPositionMetrics(
      [{ flows, valuations: [], isActive: false }],
      '2025-06-30',
    );
    expect(realized.count).toBe(1);
    expect(realized.nav).toBe('0');
    expect(realized.invested).toBe('100');
    expect(realized.grossMoic).toBe('1.5');
    const unmarked = pooledPositionMetrics(
      [{ flows: flows.slice(0, 1), valuations: [], isActive: true }],
      '2025-06-30',
    );
    expect(unmarked.count).toBe(1);
    expect(unmarked.nav).toBeNull();
    expect(unmarked.rvpi).toBeNull();
    expect(unmarked.tvpi).toBeNull();
  });
});

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
