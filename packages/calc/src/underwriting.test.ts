import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CalcError,
  D,
  PLAN_METRICS,
  PLAN_METRIC_REASONS,
  PLAN_STATUSES,
  addDays,
  daysBetween,
  favourablePct,
  planAt,
  planHeadline,
  planMetrics,
  planStatus,
  planVariance,
} from './index.js';
import type { PlanFigures, PlanMetric, PlanMetricRow, PlanStatus } from './index.js';

/**
 * Property and unit tests for the comparison against the underwritten base case (docs/08 section
 * 11). Golden fixtures 27 and 28 pin the worked examples; these pin the rules that hold for every
 * input.
 */

const TOLERANCE = '0.05';

/** Dollars and cents as the record stores them. */
const money = (min: number, max: number): fc.Arbitrary<string> =>
  fc
    .tuple(fc.integer({ min, max }), fc.integer({ min: 0, max: 99 }))
    .map(([dollars, cents]) =>
      dollars < 0
        ? `-${-dollars}.${String(cents).padStart(2, '0')}`
        : `${dollars}.${String(cents).padStart(2, '0')}`,
    );

const point = (
  periodEnd: string,
  revenueLtm: string | null,
  ebitdaLtm: string | null,
  netDebt: string | null,
): PlanFigures => ({ periodEnd, revenueLtm, ebitdaLtm, netDebt });

/** Two plan points some days apart, a day strictly between them, and every figure on record. */
const span = fc
  .tuple(
    fc.integer({ min: 0, max: 3000 }),
    fc.integer({ min: 2, max: 2200 }),
    fc.integer({ min: 1, max: 2199 }),
    fc.tuple(money(1, 4_000_000_000), money(1, 900_000_000), money(-200_000_000, 3_000_000_000)),
    fc.tuple(money(1, 4_000_000_000), money(1, 900_000_000), money(-200_000_000, 3_000_000_000)),
  )
  .map(([start, length, offset, a, b]) => {
    const d0 = addDays('2015-01-01', start);
    const d1 = addDays(d0, length);
    return {
      d0,
      d1,
      between: addDays(d0, 1 + (offset % (length - 1))),
      points: [point(d0, a[0], a[1], a[2]), point(d1, b[0], b[1], b[2])],
    };
  });

const FIELD: Record<PlanMetric, 'ebitdaLtm' | 'revenueLtm' | 'netDebt'> = {
  ebitda: 'ebitdaLtm',
  revenue: 'revenueLtm',
  net_debt: 'netDebt',
};

const rank = (status: PlanStatus | null): number =>
  status === null ? Number.NaN : PLAN_STATUSES.length - 1 - PLAN_STATUSES.indexOf(status);

const rowOf = (rows: readonly PlanMetricRow[], metric: PlanMetric): PlanMetricRow => {
  const row = rows.find((r) => r.metric === metric);
  if (row === undefined) throw new Error(`no row for ${metric}`);
  return row;
};

const WORKED = [
  point('2023-12-31', '200000000.00', '40000000.00', '150000000.00'),
  point('2024-12-31', '236600000.00', '47320000.00', '142680000.00'),
];

describe('the names (docs/08 section 11)', () => {
  it('answers EBITDA first, lists the statuses best first and the reasons in the order decided', () => {
    expect(PLAN_METRICS).toEqual(['ebitda', 'revenue', 'net_debt']);
    expect(PLAN_STATUSES).toEqual(['ahead', 'on_plan', 'behind']);
    expect(PLAN_METRIC_REASONS).toEqual([
      'no_current_quarter',
      'before_plan_start',
      'past_plan_end',
      'missing_plan_figure',
      'missing_actual',
      'non_positive_plan',
    ]);
  });
});

describe('planAt (rule 1)', () => {
  it('reads the point itself on its date and a straight line by days between two', () => {
    const on = planAt(WORKED, 'revenue', '2024-12-31');
    expect([on.value?.toString(), on.interpolated, on.reason]).toEqual([
      '236600000',
      false,
      undefined,
    ]);
    const between = planAt(WORKED, 'ebitda', '2024-06-30');
    expect([between.value?.toString(), between.interpolated]).toEqual(['43640000', true]);
    // 2024 is a leap year: day 182 of 366.
    expect(daysBetween('2023-12-31', '2024-06-30')).toBe(182);
    expect(daysBetween('2023-12-31', '2024-12-31')).toBe(366);
  });

  it('lies between its two neighbours, and is the neighbour on its date', () => {
    fc.assert(
      fc.property(span, fc.constantFrom(...PLAN_METRICS), ({ d0, d1, between, points }, metric) => {
        const [p0, p1] = points as [PlanFigures, PlanFigures];
        const v0 = D(p0[FIELD[metric]]!);
        const v1 = D(p1[FIELD[metric]]!);
        const low = v0.lt(v1) ? v0 : v1;
        const high = v0.lt(v1) ? v1 : v0;
        const plan = planAt(points, metric, between);
        expect(plan.reason).toBeUndefined();
        expect(plan.interpolated).toBe(true);
        expect(plan.value!.gte(low) && plan.value!.lte(high), plan.value!.toString()).toBe(true);
        expect(plan.value!.decimalPlaces()).toBeLessThanOrEqual(10);
        // The line itself, within the place it is held to.
        const line = v0.plus(v1.minus(v0).times(daysBetween(d0, between)).div(daysBetween(d0, d1)));
        expect(plan.value!.minus(line).abs().lte('5e-11')).toBe(true);
        for (const [date, value] of [
          [d0, v0],
          [d1, v1],
        ] as const) {
          const at = planAt(points, metric, date);
          expect(at.interpolated).toBe(false);
          expect(at.value!.eq(value)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('does not depend on the order the points arrive in', () => {
    fc.assert(
      fc.property(span, fc.constantFrom(...PLAN_METRICS), ({ between, points }, metric) => {
        const a = planAt(points, metric, between);
        const b = planAt([...points].reverse(), metric, between);
        expect(b.value!.eq(a.value!)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('has no figure outside the plan, and never reaches past a neighbour that lacks one', () => {
    const plan = [
      ...WORKED,
      point('2025-12-31', '270000000.00', '55000000.00', null),
      point('2026-12-31', '300000000.00', null, '120000000.00'),
    ];
    const reasonOf = (metric: PlanMetric, date: string): unknown => {
      const figure = planAt(plan, metric, date);
      expect(figure.value === null, `${metric} ${date}`).toBe(figure.reason !== undefined);
      if (figure.value === null) expect(figure.interpolated).toBe(false);
      return figure.reason ?? figure.value.toString();
    };
    expect(reasonOf('ebitda', '2023-12-30')).toBe('before_plan_start');
    expect(reasonOf('ebitda', '2027-01-01')).toBe('past_plan_end');
    // On a date whose point lacks the figure, and beside one.
    expect(reasonOf('net_debt', '2025-12-31')).toBe('missing_plan_figure');
    expect(reasonOf('net_debt', '2025-06-30')).toBe('missing_plan_figure');
    expect(reasonOf('net_debt', '2026-06-30')).toBe('missing_plan_figure');
    expect(reasonOf('ebitda', '2026-06-30')).toBe('missing_plan_figure');
    expect(reasonOf('ebitda', '2026-12-31')).toBe('missing_plan_figure');
    expect(reasonOf('net_debt', '2026-12-31')).toBe('120000000');
    expect(reasonOf('revenue', '2026-12-31')).toBe('300000000');
    expect(planAt([], 'revenue', '2024-06-30').reason).toBe('missing_plan_figure');
  });

  it('refuses two plan points on one date, and a date that is not on the calendar', () => {
    const twice = [...WORKED, point('2024-12-31', '1.00', '1.00', '1.00')];
    expect(() => planAt(twice, 'ebitda', '2024-06-30')).toThrow(CalcError);
    try {
      planAt(twice, 'ebitda', '2024-06-30');
    } catch (error) {
      expect((error as CalcError).code).toBe('duplicate_plan_date');
    }
    expect(() => planAt(WORKED, 'ebitda', '2024-02-30')).toThrow(CalcError);
  });
});

describe('planVariance (rule 2)', () => {
  it('is the actual less the plan, and that over the plan', () => {
    const plan = planAt(WORKED, 'ebitda', '2024-06-30');
    const v = planVariance('40500000.00', plan);
    expect([v.variance?.toString(), v.variancePct?.toString(), v.reason]).toEqual([
      '-3140000',
      '-0.0719523373',
      null,
    ]);
  });

  it('says why there is no percent, and keeps the variance in money over a plan of zero or less', () => {
    const none = planVariance('1', planAt(WORKED, 'ebitda', '2020-01-01'));
    expect([none.variance, none.variancePct, none.reason]).toEqual([
      null,
      null,
      'before_plan_start',
    ]);
    const noActual = planVariance(null, planAt(WORKED, 'ebitda', '2024-06-30'));
    expect([noActual.variance, noActual.variancePct, noActual.reason]).toEqual([
      null,
      null,
      'missing_actual',
    ]);
    for (const planned of ['0', '-5000000.00']) {
      const netCash = planVariance('-8000000.00', { value: D(planned), interpolated: false });
      expect(netCash.variance!.eq(D('-8000000').minus(planned))).toBe(true);
      expect([netCash.variancePct, netCash.reason]).toEqual([null, 'non_positive_plan']);
    }
  });

  it('never answers a negative zero', () => {
    const plan = planAt(WORKED, 'ebitda', '2024-12-31');
    const v = planVariance('47319999.9999', plan);
    expect(v.variancePct!.toString()).toBe('0');
    expect(v.variancePct!.isNegative()).toBe(false);
  });

  it('is unchanged when the actual and the plan are scaled together', () => {
    fc.assert(
      fc.property(
        span,
        fc.tuple(money(-50_000_000, 4_000_000_000), money(-50_000_000, 900_000_000)),
        fc.integer({ min: 2, max: 5000 }),
        ({ d0, d1, between, points }, [revenue, ebitda], k) => {
          const scale = (v: PlanFigures['netDebt']): string => D(v!).times(k).toFixed(2);
          const scaled = points.map((p) =>
            point(p.periodEnd, scale(p.revenueLtm), scale(p.ebitdaLtm), scale(p.netDebt)),
          );
          const quarter = (date: string): PlanFigures => point(date, revenue, ebitda, revenue);
          const scaledQuarter = (date: string): PlanFigures =>
            point(date, scale(revenue), scale(ebitda), scale(revenue));
          // On a plan date the plan is the sponsor's own figure, so the percent is the same to the
          // last place and so is the status.
          for (const date of [d0, d1]) {
            const plain = planMetrics(points, quarter(date), TOLERANCE);
            const times = planMetrics(scaled, scaledQuarter(date), TOLERANCE);
            plain.forEach((row, i) => {
              const other = times[i]!;
              expect(other.variancePct).toBe(row.variancePct);
              expect(other.status).toBe(row.status);
              expect(other.notCalculable).toBe(row.notCalculable);
              if (row.variance !== null)
                expect(D(other.variance!).eq(D(row.variance).times(k))).toBe(true);
            });
          }
          // Between two, each plan is held to ten places, so the percents agree within that:
          // one part in ten billion of the percent, for a plan figure of a dollar or more.
          const plain = planMetrics(points, quarter(between), TOLERANCE);
          const times = planMetrics(scaled, scaledQuarter(between), TOLERANCE);
          plain.forEach((row, i) => {
            const other = times[i]!;
            if (row.plan === null || D(row.plan).lt(1)) return;
            expect(other.notCalculable).toBe(row.notCalculable);
            if (row.variancePct === null) return;
            const size = D(row.variancePct).abs();
            const gap = D(other.variancePct!).minus(row.variancePct).abs();
            expect(gap.lte(D('1e-9').times(size.gt(1) ? size : 1)), row.metric).toBe(true);
            if (size.minus(TOLERANCE).abs().gt('1e-9')) expect(other.status).toBe(row.status);
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('planStatus (rule 3)', () => {
  it('is ahead above the tolerance, behind below its negative, and on plan on either edge', () => {
    expect(planStatus('0.0500000001', TOLERANCE)).toBe('ahead');
    expect(planStatus('0.05', TOLERANCE)).toBe('on_plan');
    expect(planStatus('0', TOLERANCE)).toBe('on_plan');
    expect(planStatus('-0.05', TOLERANCE)).toBe('on_plan');
    expect(planStatus('-0.0500000001', TOLERANCE)).toBe('behind');
    // A tolerance of nothing: only the plan itself is on plan.
    expect(planStatus('0', '0')).toBe('on_plan');
    expect(planStatus(D('0').neg(), '0')).toBe('on_plan');
    expect(planStatus('0.0000000001', '0')).toBe('ahead');
    expect(planStatus('-0.0000000001', '0')).toBe('behind');
  });

  it('refuses a tolerance below zero, whatever the figures', () => {
    for (const run of [
      (): unknown => planStatus('0', '-0.01'),
      (): unknown => planMetrics(WORKED, null, '-0.01'),
    ]) {
      expect(run).toThrow(CalcError);
      try {
        run();
      } catch (error) {
        expect((error as CalcError).code).toBe('invalid_plan_tolerance');
      }
    }
  });

  it('reads net debt the other way round: less than plan is the favourable side', () => {
    expect(favourablePct('net_debt', D('0.1')).toString()).toBe('-0.1');
    expect(favourablePct('ebitda', D('0.1')).toString()).toBe('0.1');
    expect(favourablePct('revenue', D('-0.1')).toString()).toBe('-0.1');
  });

  it('never lowers the status of a higher EBITDA, nor raises that of a higher net debt', () => {
    fc.assert(
      fc.property(
        span,
        fc.tuple(money(-900_000_000, 1_800_000_000), money(-900_000_000, 1_800_000_000)),
        fc.tuple(money(-200_000_000, 3_000_000_000), money(-200_000_000, 3_000_000_000)),
        fc.boolean(),
        ({ d1, between, points }, ebitdas, debts, onDate) => {
          const date = onDate ? d1 : between;
          const [lowE, highE] = D(ebitdas[0]).lte(ebitdas[1]) ? ebitdas : [ebitdas[1], ebitdas[0]];
          const [lowD, highD] = D(debts[0]).lte(debts[1]) ? debts : [debts[1], debts[0]];
          const lower = planMetrics(points, point(date, null, lowE, lowD), TOLERANCE);
          const higher = planMetrics(points, point(date, null, highE, highD), TOLERANCE);
          expect(rank(rowOf(higher, 'ebitda').status)).toBeGreaterThanOrEqual(
            rank(rowOf(lower, 'ebitda').status),
          );
          const debtLower = rowOf(lower, 'net_debt').status;
          const debtHigher = rowOf(higher, 'net_debt').status;
          // A plan in net cash has no percent and so no status, for either quarter.
          expect(debtLower === null).toBe(debtHigher === null);
          if (debtLower !== null) expect(rank(debtHigher)).toBeLessThanOrEqual(rank(debtLower));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('planMetrics (rules 1 to 3 over one quarter)', () => {
  it('answers a row for each metric, in order, with a status or the reason it has none', () => {
    fc.assert(
      fc.property(
        span,
        fc.integer({ min: -400, max: 2600 }),
        fc.tuple(
          fc.option(money(-50_000_000, 4_000_000_000), { nil: null }),
          fc.option(money(-50_000_000, 900_000_000), { nil: null }),
          fc.option(money(-200_000_000, 3_000_000_000), { nil: null }),
        ),
        ({ d0, points }, offset, [revenue, ebitda, netDebt]) => {
          const quarter = point(addDays(d0, offset), revenue, ebitda, netDebt);
          const rows = planMetrics(points, quarter, TOLERANCE);
          expect(rows.map((r) => r.metric)).toEqual(PLAN_METRICS);
          for (const row of rows) {
            // A status exactly when there is a percent, and a reason exactly when there is none.
            expect(row.status === null).toBe(row.variancePct === null);
            expect(row.notCalculable === null).toBe(row.variancePct !== null);
            if (row.variance !== null) {
              // The variance received is the actual received less the plan received.
              expect(D(row.variance).eq(D(row.actual!).minus(row.plan!))).toBe(true);
            }
            if (row.plan === null) expect(row.interpolated).toBe(false);
          }
          expect(planHeadline(rows)).toBe(rowOf(rows, 'ebitda').status);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('has no headline without the EBITDA row', () => {
    expect(planHeadline([])).toBeNull();
  });
});
