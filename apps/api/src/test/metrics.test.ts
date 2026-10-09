import { describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import { lockedNavSeries, pooledPositionMetrics, positionMetrics } from '../portfolio/metrics.js';
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
    // Without the NAV, MOIC and IRR would be invented (CLAUDE.md rule 10): none, and the flag says why.
    expect(unmarked.grossMoic).toBeNull();
    expect(unmarked.grossIrr).toBeNull();
    expect(unmarked.irrFlag).toBe('no_valuation');
  });

  it('leaves the whole pool not calculable while one held position has no Locked mark', () => {
    const marked = {
      flows: [flow('2020-01-15', 'contribution', '-100')],
      valuations: [mark('2025-06-30', '180')],
      isActive: true,
    };
    const unmarked = {
      flows: [flow('2024-01-15', 'contribution', '-10'), flow('2024-07-30', 'distribution', '2')],
      valuations: [mark('2025-06-30', '9', 'Draft')],
      isActive: true,
    };
    const alone = pooledPositionMetrics([marked], '2025-06-30');
    expect(alone.nav).toBe('180');
    expect(alone.grossMoic).toBe('1.8');
    expect(alone.grossIrr).not.toBeNull();
    const pool = pooledPositionMetrics([marked, unmarked], '2025-06-30');
    // Counting the unmarked position as 0 would understate NAV by its value and invent MOIC.
    expect(pool.nav).toBeNull();
    expect(pool.tvpi).toBeNull();
    expect(pool.grossMoic).toBeNull();
    expect(pool.grossIrr).toBeNull();
    expect(pool.irrFlag).toBe('no_valuation');
    // What needs no NAV still shows.
    expect(pool.invested).toBe('110');
    expect(pool.dpi).toBe(D('2').div('110').toFixed(10).replace(/0+$/, ''));
  });
});

describe('positionMetrics: a held position without a Locked mark', () => {
  it('shows no NAV, MOIC or IRR, never a figure as if NAV were 0', () => {
    const m = positionMetrics(
      [
        flow('2023-01-15', 'contribution', '-10000000'),
        flow('2024-07-30', 'distribution', '2000000'),
      ],
      [mark('2025-06-30', '9000000', 'Draft')],
      '2025-06-30',
      true,
    );
    expect(m.invested).toBe('10000000');
    expect(m.distributions).toBe('2000000');
    expect(m.nav).toBeNull();
    expect(m.grossMoic).toBeNull();
    expect(m.grossIrr).toBeNull();
    expect(m.irrFlag).toBe('no_valuation');
  });
});

describe('lockedNavSeries: the NAV date rule at every quarter end', () => {
  /** A position held from entry until exit, with its valuation versions. */
  const held = (
    valuations: ValuationRow[],
    entryDate = '2020-01-15',
    exitDate: string | null = null,
  ) => ({ valuations, entryDate, exitDate });

  it('folds marks a few days off the quarter end into that quarter end', () => {
    const shifted = held([mark('2025-03-28', '10'), mark('2025-06-27', '11')]);
    const calendar = held([mark('2025-03-31', '20.5'), mark('2025-06-30', '21')]);
    expect(lockedNavSeries([shifted, calendar], '2025-06-30', RULE)).toEqual([
      { periodEnd: '2025-03-31', value: '30.5' },
      { periodEnd: '2025-06-30', value: '32' },
    ]);
  });

  it('carries a held position at its latest Locked mark, as the NAV tile does, never dropping it', () => {
    // A sponsor that missed Q2 (stale) and one that reported Q1 a few days late (2025-04-03).
    const stale = held([mark('2025-03-31', '46')]);
    const late = held([mark('2025-04-03', '5')]);
    const current = held([mark('2025-03-31', '10'), mark('2025-06-30', '12')]);
    expect(lockedNavSeries([stale, late, current], '2025-06-30', RULE)).toEqual([
      { periodEnd: '2025-03-31', value: '61' },
      { periodEnd: '2025-06-30', value: '63' },
    ]);
  });

  it('leaves a quarter not calculable while a position held then has no Locked mark at all', () => {
    const marked = held([mark('2025-03-31', '10'), mark('2025-06-30', '12')]);
    // Entered in February, first marked at June 30: at March 31 it was held with no mark.
    const newDeal = held([mark('2025-06-30', '7')], '2025-02-10');
    expect(lockedNavSeries([marked, newDeal], '2025-06-30', RULE)).toEqual([
      { periodEnd: '2025-03-31', value: null },
      { periodEnd: '2025-06-30', value: '19' },
    ]);
  });

  it('counts a position only at the quarter ends it was held at', () => {
    const exited = held(
      [mark('2024-12-31', '50'), mark('2025-03-31', '55')],
      '2020-01-15',
      '2025-05-10',
    );
    const entered = held([mark('2025-06-30', '8')], '2025-04-20');
    const steady = held([
      mark('2024-12-31', '1'),
      mark('2025-03-31', '2'),
      mark('2025-06-30', '3'),
    ]);
    expect(lockedNavSeries([exited, entered, steady], '2025-06-30', RULE)).toEqual([
      { periodEnd: '2024-12-31', value: '51' },
      { periodEnd: '2025-03-31', value: '57' },
      { periodEnd: '2025-06-30', value: '11' },
    ]);
  });

  it('counts Locked marks on or before the as-of date only, and ends at its last quarter end', () => {
    const set = held([
      mark('2025-03-31', '1', 'Draft'),
      mark('2025-03-31', '2', 'Reopened'),
      mark('2025-03-31', '3'),
      // Reports for 2025-06-30, but is dated after the as-of date.
      mark('2025-07-02', '4'),
    ]);
    expect(lockedNavSeries([set], '2025-07-01', RULE)).toEqual([
      { periodEnd: '2025-03-31', value: '3' },
      { periodEnd: '2025-06-30', value: '3' },
    ]);
    // Before the first quarter end a mark reports for, there is no point at all.
    expect(lockedNavSeries([held([mark('2025-06-27', '8')])], '2025-06-28', RULE)).toEqual([]);
  });

  it('takes the later of two marks that report for the same quarter, and a mark off any quarter end from the next one', () => {
    expect(
      lockedNavSeries(
        [held([mark('2025-06-27', '10'), mark('2025-06-30', '12')])],
        '2025-06-30',
        RULE,
      ),
    ).toEqual([{ periodEnd: '2025-06-30', value: '12' }]);
    expect(lockedNavSeries([held([mark('2025-05-15', '7')])], '2025-09-30', RULE)).toEqual([
      { periodEnd: '2025-06-30', value: '7' },
      { periodEnd: '2025-09-30', value: '7' },
    ]);
  });

  it('keeps the latest configured number of points, oldest first', () => {
    const set = held(
      ['2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30'].map((d, i) =>
        mark(d, String(i + 1)),
      ),
    );
    expect(lockedNavSeries([set], '2025-06-30', { quarters: 2, toleranceDays: 7 })).toEqual([
      { periodEnd: '2025-03-31', value: '3' },
      { periodEnd: '2025-06-30', value: '4' },
    ]);
    expect(lockedNavSeries([set], '2025-06-30', { quarters: 0, toleranceDays: 7 })).toEqual([]);
  });
});
