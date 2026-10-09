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
