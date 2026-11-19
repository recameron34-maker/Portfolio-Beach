import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CalcError,
  D,
  PLAN_METRICS,
  PLAN_METRIC_REASONS,
  PLAN_PATH_REASONS,
  PLAN_PROGRESS_REASONS,
  PLAN_STATUSES,
  UNDERWRITING_FORMS,
  VALUE_CREATION_REASONS,
  addDays,
  daysBetween,
  favourablePct,
  moic,
  pathValue,
  planAt,
  planHeadline,
  planMetrics,
  planStatus,
  planVariance,
  toDecimalString,
  underwritingComparison,
  valueCreationBridge,
  xirr,
} from './index.js';
import type {
  CashFlow,
  PlanFigures,
  PlanMetric,
  PlanMetricRow,
  PlanStatus,
  UnderwritingCase,
  UnderwritingInputs,
  UnderwritingTolerances,
} from './index.js';

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

  it('keeps the reasons of the actual bridge in step with the value creation views', () => {
    expect(UNDERWRITING_FORMS).toEqual(['equity', 'credit']);
    expect(PLAN_PROGRESS_REASONS.slice(0, 5)).toEqual(VALUE_CREATION_REASONS.slice(0, 5));
    expect(PLAN_PROGRESS_REASONS.slice(5)).toEqual(['missing_plan_figure']);
    expect(PLAN_PATH_REASONS).toEqual(['past_plan_end', 'no_invested_capital']);
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

/* ---- Rules 4 to 6 and the comparison as it travels ---- */

const TOLERANCES: UnderwritingTolerances = { onPlanTolerance: TOLERANCE, irrTolerance: '0.02' };

const ENTRY = {
  periodEnd: '2021-06-30',
  revenueLtm: '200000000.00',
  ebitdaLtm: '40000000.00',
  ev: '400000000.00',
  netDebt: '150000000.00',
};

const PLAN = [
  point('2021-06-30', '200000000.00', '40000000.00', '150000000.00'),
  point('2023-06-30', '250000000.00', '56000000.00', '130000000.00'),
  point('2026-06-30', '320000000.00', '80000000.00', '100000000.00'),
];

const EQUITY: UnderwritingCase = {
  form: 'equity',
  plannedExitDate: '2026-06-30',
  exitMultiple: '11.0',
  grossMoic: '2.5',
  grossIrr: '0.2',
  points: PLAN,
};

const LOAN: UnderwritingCase = {
  form: 'credit',
  plannedExitDate: '2026-06-30',
  exitMultiple: null,
  grossMoic: '1.5',
  grossIrr: '0.1',
  points: [],
};

const QUARTER = point('2024-06-30', '260000000.00', '65000000.00', '120000000.00');

/** Worked example 2 with the position of worked example 3 a year on. */
const INPUTS: UnderwritingInputs = {
  asOf: '2024-06-30',
  isActive: true,
  entry: ENTRY,
  current: QUARTER,
  quarters: [point('2023-06-30', '240000000.00', '55000000.00', '130000000.00'), QUARTER],
  bridge: {
    ebitdaGrowth: '250000000',
    multipleExpansion: '65000000',
    debtPaydown: '30000000',
    total: '345000000',
  },
  bridgeNotCalculable: null,
  flows: [
    { date: '2021-06-30', amount: '-10000000' },
    { date: '2023-06-30', amount: '2000000' },
  ],
  invested: '10000000',
  distributions: '2000000',
  grossMoic: '2.45',
  grossIrr: '0.360867922',
  irrFlag: null,
  yieldToMaturity: null,
};

const LOAN_INPUTS: UnderwritingInputs = {
  ...INPUTS,
  asOf: '2023-06-30',
  entry: null,
  current: null,
  quarters: [],
  bridge: null,
  flows: [
    { date: '2021-06-30', amount: '-10000000' },
    { date: '2022-06-30', amount: '1000000' },
    { date: '2023-06-30', amount: '1000000' },
  ],
  distributions: '2000000',
  grossMoic: '1.1',
  grossIrr: '0.0512492197',
  yieldToMaturity: '0.14320',
};

const compare = (
  inputs: Partial<UnderwritingInputs> = {},
  base: Partial<UnderwritingCase> = {},
): ReturnType<typeof underwritingComparison> =>
  underwritingComparison({ ...EQUITY, ...base }, { ...INPUTS, ...inputs }, TOLERANCES);

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof CalcError) return error.code;
    throw error;
  }
  throw new Error('nothing was refused');
};

/** Our flows on a position: a first funding, then a follow-on or money back on later days. */
const positionFlows = fc
  .tuple(
    fc.integer({ min: 0, max: 2500 }),
    money(100_000, 60_000_000),
    fc.array(fc.tuple(fc.integer({ min: 1, max: 2400 }), fc.boolean(), money(1, 30_000_000)), {
      maxLength: 5,
    }),
    fc.integer({ min: 0, max: 400 }),
  )
  .map(([start, first, later, tail]) => {
    const funded = addDays('2015-01-01', start);
    const flows: CashFlow[] = [{ date: funded, amount: `-${first}` }];
    let invested = D(first);
    let distributions = D('0');
    let last = 0;
    for (const [day, followOn, amount] of later) {
      last = Math.max(last, day);
      if (followOn) invested = invested.plus(amount);
      else distributions = distributions.plus(amount);
      flows.push({ date: addDays(funded, day), amount: followOn ? `-${amount}` : amount });
    }
    return {
      flows,
      asOf: addDays(funded, last + tail),
      invested: invested.toFixed(2),
      distributions: distributions.toFixed(2),
    };
  });

/** An underwritten IRR from -30.00% to 60.00%. */
const underwrittenRate = fc
  .integer({ min: -3000, max: 6000 })
  .map((bp) => D(String(bp)).div(10000));

describe('value creation against plan (rule 4)', () => {
  it('plans the bridge by the one bridge rule, from the entry snapshot to the planned exit', () => {
    fc.assert(
      fc.property(
        fc.tuple(money(100_000, 900_000_000), fc.integer({ min: 300, max: 2500 })),
        fc.tuple(money(100_000, 900_000_000), fc.integer({ min: 300, max: 2500 })),
        fc.tuple(money(-200_000_000, 3_000_000_000), money(-200_000_000, 3_000_000_000)),
        ([ebitda0, multipleBp0], [ebitda1, multipleBp1], [debt0, debt1]) => {
          const entry = {
            periodEnd: '2021-06-30',
            ebitdaLtm: ebitda0,
            ev: D(ebitda0).times(multipleBp0).div(100).toFixed(2),
            netDebt: debt0,
          };
          const exitMultiple = D(String(multipleBp1)).div(100).toString();
          const answer = compare(
            { entry },
            { exitMultiple, points: [point('2026-06-30', null, ebitda1, debt1)] },
          ).valueCreation!;
          const bridge = valueCreationBridge(
            { ebitda: entry.ebitdaLtm, ev: entry.ev, netDebt: entry.netDebt },
            { ebitda: ebitda1, ev: D(ebitda1).times(exitMultiple), netDebt: debt1 },
          ).value!;
          expect(answer.notCalculable).toBeNull();
          expect(answer.planned).toEqual({
            ebitdaGrowth: toDecimalString(bridge.ebitdaGrowth),
            multipleExpansion: toDecimalString(bridge.multipleExpansion),
            debtPaydown: toDecimalString(bridge.debtPaydown),
            total: toDecimalString(bridge.total),
          });
          // The drivers are the total, within the last place each travels with.
          const planned = answer.planned!;
          const sum = D(planned.ebitdaGrowth)
            .plus(planned.multipleExpansion)
            .plus(planned.debtPaydown);
          expect(sum.minus(planned.total).abs().lte('1e-10')).toBe(true);
          // Progress is the actual over the planned figure received, and none over zero or less.
          for (const key of [
            'ebitdaGrowth',
            'multipleExpansion',
            'debtPaydown',
            'total',
          ] as const) {
            const progress = answer.progress![key];
            if (D(planned[key]).lte(0)) expect(progress).toBeNull();
            else
              expect(progress).toBe(
                toDecimalString(D(answer.actual![key]).div(planned[key]).toDecimalPlaces(10)),
              );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('says how much of the planned time has passed, and may run past the end', () => {
    expect(compare().valueCreation!.timePassed).toBe('0.6002190581');
    const late = point('2027-06-30', '330000000.00', '82000000.00', '95000000.00');
    expect(compare({ asOf: '2027-06-30', current: late }).valueCreation!.timePassed).toBe(
      toDecimalString(D('2191').div(1826).toDecimalPlaces(10)),
    );
    // A planned exit that is not after the entry snapshot has no span to measure.
    const early = { ...ENTRY, periodEnd: '2026-06-30' };
    expect(compare({ entry: early }).valueCreation!.timePassed).toBeNull();
    expect(compare({ current: null }).valueCreation!.timePassed).toBeNull();
    // A current quarter dated before the entry snapshot: none of the planned time has begun,
    // and the share is never below zero. On the snapshot's own date it is zero.
    const later = { ...ENTRY, periodEnd: '2024-09-30' };
    expect(compare({ entry: later }).valueCreation!.timePassed).toBeNull();
    const sameDay = { ...ENTRY, periodEnd: '2024-06-30' };
    expect(compare({ entry: sameDay }).valueCreation!.timePassed).toBe('0');
  });

  it('answers the side that stands and says why the other does not', () => {
    const stands = compare().valueCreation!;
    const actualOnly = (base: Partial<UnderwritingCase>, reason: string): void => {
      const answer = compare({}, base).valueCreation!;
      expect([answer.planned, answer.progress, answer.notCalculable]).toEqual([null, null, reason]);
      expect(answer.actual).toEqual(stands.actual);
    };
    // The plan's own reasons: no point on the planned exit, one without a figure, no multiple.
    actualOnly({ plannedExitDate: '2026-12-31' }, 'missing_plan_figure');
    actualOnly({ points: [] }, 'missing_plan_figure');
    actualOnly(
      { points: [point('2026-06-30', null, null, '100000000.00')] },
      'missing_plan_figure',
    );
    actualOnly({ points: [point('2026-06-30', null, '80000000.00', null)] }, 'missing_plan_figure');
    actualOnly(
      { points: [point('2026-06-30', null, '-1.00', '100000000.00')] },
      'non_positive_ebitda',
    );

    // The actual bridge's reason comes first; the planned bridge is answered where it stands.
    const noQuarter = compare({ bridge: null, bridgeNotCalculable: 'no_current_quarter' });
    expect(noQuarter.valueCreation).toEqual({
      planned: stands.planned,
      actual: null,
      progress: null,
      timePassed: stands.timePassed,
      notCalculable: 'no_current_quarter',
    });
    const forward = compare({
      entry: null,
      bridge: null,
      bridgeNotCalculable: 'entry_snapshot_forward_dated',
    }).valueCreation!;
    expect([forward.planned, forward.timePassed, forward.notCalculable]).toEqual([
      null,
      null,
      'entry_snapshot_forward_dated',
    ]);

    // An entry snapshot that lacks a figure plans nothing, whatever the caller says of the actual.
    for (const lacking of [
      { ...ENTRY, ebitdaLtm: null },
      { ...ENTRY, ev: null },
      { ...ENTRY, netDebt: null },
    ]) {
      const answer = compare({ entry: lacking }).valueCreation!;
      expect([answer.planned, answer.progress, answer.notCalculable]).toEqual([
        null,
        null,
        'missing_figures',
      ]);
    }
    const noEntry = compare({ entry: null }).valueCreation!;
    expect([noEntry.planned, noEntry.notCalculable]).toEqual([null, 'no_entry_snapshot']);
    const lossMaking = compare({ entry: { ...ENTRY, ebitdaLtm: '0.00' } }).valueCreation!;
    expect([lossMaking.planned, lossMaking.notCalculable]).toEqual([null, 'non_positive_ebitda']);
    // A reason sent beside a bridge that stands is not a reason.
    expect(compare({ bridgeNotCalculable: 'missing_figures' }).valueCreation).toEqual(stands);
  });

  it('refuses an equity position with neither a bridge nor the reason it has none', () => {
    expect(codeOf(() => compare({ bridge: null }))).toBe('invalid_underwriting_inputs');
  });
});

describe('returns against plan (rule 5)', () => {
  it('compounds every flow at the underwritten IRR to the as-of date', () => {
    const flows = [
      { date: '2021-06-30', amount: '-10000000' },
      { date: '2023-06-30', amount: '1000000' },
    ];
    expect(pathValue(flows, '0.2', '2023-06-30').toString()).toBe('13400000');
    expect(pathValue([], '0.2', '2023-06-30').toString()).toBe('0');
    expect(codeOf(() => pathValue(flows, '-1', '2023-06-30'))).toBe('invalid_underwriting_case');
  });

  it('puts the IRR on the underwritten rate, and the MOIC gap at zero, when the NAV is the path value', () => {
    fc.assert(
      fc.property(
        positionFlows,
        underwrittenRate,
        ({ flows, asOf, invested, distributions }, r) => {
          const nav = pathValue(flows, r, asOf);
          const grossMoic = toDecimalString(moic(distributions, nav, invested));
          const answer = underwritingComparison(
            { ...LOAN, plannedExitDate: asOf, grossIrr: r },
            { ...LOAN_INPUTS, asOf, flows, invested, distributions, grossMoic, grossIrr: null },
            TOLERANCES,
          ).returns;
          expect(answer.pathNotCalculable).toBeNull();
          expect(answer.moicOnPath).toBe(grossMoic);
          expect(answer.moicGap).toBe('0');
          // The path value is the terminal value at which our IRR is the underwritten one, for
          // flows that have one IRR: some time has passed, and the flows change sign once. With
          // a follow-on after money came back there may be several rates, and which of them a
          // solver reports is not this rule's to say.
          fc.pre(nav.gt(1) && daysBetween(flows[0]!.date, asOf) > 0);
          const signs = [...flows]
            .sort((a, b) => daysBetween(b.date, a.date))
            .map((f) => (D(f.amount).isNegative() ? -1 : 1));
          fc.pre(signs.every((sign, i) => i === 0 || sign >= signs[i - 1]!));
          const irr = xirr([...flows, { date: asOf, amount: nav }]).value;
          expect(irr?.minus(r).abs().lte('1e-7'), String(irr)).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('never lowers the MOIC gap for a higher NAV, nor the status for a higher IRR', () => {
    fc.assert(
      fc.property(
        positionFlows,
        underwrittenRate,
        fc.tuple(money(0, 90_000_000), money(0, 90_000_000)),
        fc.tuple(fc.integer({ min: -9000, max: 30000 }), fc.integer({ min: -9000, max: 30000 })),
        ({ flows, asOf, invested, distributions }, r, navs, irrs) => {
          const [lowNav, highNav] = D(navs[0]).lte(navs[1]) ? navs : [navs[1], navs[0]];
          const [lowIrr, highIrr] = irrs[0] <= irrs[1] ? irrs : [irrs[1], irrs[0]];
          const at = (nav: string, irrBp: number): ReturnType<typeof compare>['returns'] =>
            underwritingComparison(
              { ...LOAN, plannedExitDate: asOf, grossIrr: r },
              {
                ...LOAN_INPUTS,
                asOf,
                flows,
                invested,
                distributions,
                grossMoic: toDecimalString(moic(distributions, nav, invested)),
                grossIrr: D(String(irrBp)).div(10000),
              },
              TOLERANCES,
            ).returns;
          const lower = at(lowNav, lowIrr);
          const higher = at(highNav, highIrr);
          expect(D(higher.moicGap!).gte(lower.moicGap!)).toBe(true);
          expect(rank(higher.irrStatus)).toBeGreaterThanOrEqual(rank(lower.irrStatus));
          // The gap is the IRR received less the underwritten one, in points.
          expect(D(higher.irrGap!).eq(D(String(highIrr)).div(10000).minus(r))).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('judges the IRR gap by its own tolerance, in points, and not while the IRR is flagged', () => {
    const gap = (
      grossIrr: string | null,
      irrFlag: UnderwritingInputs['irrFlag'] = null,
    ): unknown[] => {
      const r = compare({ grossIrr, irrFlag }).returns;
      return [r.irrGap, r.irrStatus, r.irrFlag];
    };
    expect(gap('0.22')).toEqual(['0.02', 'on_plan', null]);
    expect(gap('0.2200000001')).toEqual(['0.0200000001', 'ahead', null]);
    expect(gap('0.18')).toEqual(['-0.02', 'on_plan', null]);
    expect(gap('0.1799999999')).toEqual(['-0.0200000001', 'behind', null]);
    // Held under a year: the rate is shown with its gap and is not judged.
    expect(gap('0.9', 'short_period')).toEqual(['0.7', null, 'short_period']);
    expect(gap(null, 'multiple_irr')).toEqual([null, null, 'multiple_irr']);
  });

  it('has no path after the planned exit, with nothing invested, or once realized', () => {
    const path = (inputs: Partial<UnderwritingInputs>): unknown[] => {
      const r = compare(inputs).returns;
      return [r.moicOnPath, r.moicGap, r.pathNotCalculable];
    };
    expect(path({})).toEqual(['1.6887434582', '0.7612565418', null]);
    // On the planned exit itself the path still stands; a day later it does not.
    expect(path({ asOf: '2026-06-30' })[2]).toBeNull();
    expect(path({ asOf: '2026-07-01' })).toEqual([null, null, 'past_plan_end']);
    expect(path({ invested: null })).toEqual([null, null, 'no_invested_capital']);
    expect(path({ invested: '0.00' })).toEqual([null, null, 'no_invested_capital']);
    expect(path({ distributions: null })).toEqual([null, null, 'no_invested_capital']);
    // Invested capital is a size: its sign does not move the path.
    expect(path({ invested: '-10000000' })).toEqual(path({}));
    // Without a gross MOIC the path stands and the gap does not.
    expect(path({ grossMoic: null })).toEqual(['1.6887434582', null, null]);
    // Realized: the gap is against the underwritten MOIC at exit, even after the planned exit.
    expect(path({ isActive: false, asOf: '2027-01-31' })).toEqual([null, '-0.05', null]);
    expect(path({ isActive: false, grossMoic: null })).toEqual([null, null, null]);
  });
});

describe('underwritingComparison (the comparison as it travels)', () => {
  it('carries the returns and the yield to maturity for a loan, and nothing else (rule 6)', () => {
    const loan = underwritingComparison(LOAN, LOAN_INPUTS, TOLERANCES);
    expect(loan).toEqual({
      quarter: null,
      metrics: [],
      headline: null,
      series: [],
      valueCreation: null,
      returns: {
        grossIrr: '0.0512492197',
        irrGap: '-0.0487507803',
        irrStatus: 'behind',
        irrFlag: null,
        grossMoic: '1.1',
        moicOnPath: '1.2',
        moicGap: '-0.1',
        pathNotCalculable: null,
      },
      yieldToMaturity: '0.1432',
    });
    const unpriced = underwritingComparison(
      LOAN,
      { ...LOAN_INPUTS, yieldToMaturity: null },
      TOLERANCES,
    );
    expect(unpriced.yieldToMaturity).toBeNull();
    // An equity position has no yield to maturity, whatever arrives in its place.
    expect(compare({ yieldToMaturity: '0.09' }).yieldToMaturity).toBeNull();
  });

  it('answers rule 1 to 3 for the current quarter, with EBITDA as the headline', () => {
    const answer = compare();
    expect(answer.quarter).toBe('2024-06-30');
    expect(answer.metrics).toEqual(planMetrics(PLAN, QUARTER, TOLERANCE));
    expect(answer.headline).toBe('on_plan');
    const none = compare({
      current: null,
      bridge: null,
      bridgeNotCalculable: 'no_current_quarter',
    });
    expect([none.quarter, none.headline]).toEqual([null, null]);
    expect(none.metrics.map((m) => m.notCalculable)).toEqual([
      'no_current_quarter',
      'no_current_quarter',
      'no_current_quarter',
    ]);
  });

  it('lists every plan date and every approved quarter up to the current one, once and in order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 60 }), { minLength: 0, maxLength: 6 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 60 }), { minLength: 0, maxLength: 8 }),
        fc.integer({ min: 0, max: 60 }),
        fc.boolean(),
        (planMonths, quarterMonths, currentMonth, missing) => {
          const dateOf = (month: number): string => addDays('2021-06-30', month * 30);
          const points = planMonths.map((m) =>
            point(dateOf(m), `${200 + m}000000.00`, `${40 + m}000000.00`, missing ? null : '1.00'),
          );
          const quarters = quarterMonths.map((m) =>
            point(dateOf(m), missing ? null : `${190 + m}000000.00`, `${38 + m}000000.00`, '2.00'),
          );
          const current = point(dateOf(currentMonth), '1.00', '2.00', '3.00');
          const series = compare({ current, quarters }, { points }).series;
          expect(series.map((s) => s.metric)).toEqual(PLAN_METRICS);
          const counted = quarterMonths.filter((m) => m < currentMonth);
          const dates = [...new Set([...planMonths, ...counted, currentMonth])]
            .sort((a, b) => a - b)
            .map(dateOf);
          for (const { metric, points: rows } of series) {
            expect(rows.map((r) => r.periodEnd)).toEqual(dates);
            for (const row of rows) {
              const plan = planAt(points, metric, row.periodEnd);
              expect(row.plan).toBe(toDecimalString(plan.value));
              expect(row.interpolated).toBe(plan.interpolated);
              const quarter =
                row.periodEnd === current.periodEnd
                  ? current
                  : quarters.find(
                      (q) => q.periodEnd === row.periodEnd && q.periodEnd < current.periodEnd,
                    );
              const actual = quarter?.[FIELD[metric]] ?? null;
              // An actual is the quarter's own figure, or nothing: never read off a line.
              expect(row.actual).toBe(actual === null ? null : toDecimalString(D(actual)));
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('holds the plan dates alone when there is no current quarter', () => {
    const series = compare({
      current: null,
      bridge: null,
      bridgeNotCalculable: 'no_current_quarter',
    }).series;
    for (const { points: rows } of series) {
      expect(rows.map((r) => r.periodEnd)).toEqual(PLAN.map((p) => p.periodEnd));
      expect(rows.every((r) => r.actual === null && !r.interpolated)).toBe(true);
    }
  });

  it('refuses a case or a tolerance the record could not hold, and two rows on one date', () => {
    expect(codeOf(() => compare({}, { grossIrr: '-1' }))).toBe('invalid_underwriting_case');
    expect(codeOf(() => compare({}, { grossMoic: '0' }))).toBe('invalid_underwriting_case');
    expect(codeOf(() => compare({}, { exitMultiple: null }))).toBe('invalid_underwriting_case');
    expect(codeOf(() => compare({}, { exitMultiple: '0' }))).toBe('invalid_underwriting_case');
    expect(
      codeOf(() => underwritingComparison({ ...LOAN, grossMoic: '-1' }, LOAN_INPUTS, TOLERANCES)),
    ).toBe('invalid_underwriting_case');
    for (const tolerances of [
      { ...TOLERANCES, onPlanTolerance: '-0.05' },
      { ...TOLERANCES, irrTolerance: '-0.02' },
    ]) {
      expect(codeOf(() => underwritingComparison(EQUITY, INPUTS, tolerances))).toBe(
        'invalid_plan_tolerance',
      );
      expect(codeOf(() => underwritingComparison(LOAN, LOAN_INPUTS, tolerances))).toBe(
        'invalid_plan_tolerance',
      );
    }
    const twice = [...PLAN, point('2026-06-30', '1.00', '1.00', '1.00')];
    expect(
      codeOf(() =>
        compare(
          { current: null, bridge: null, bridgeNotCalculable: 'no_current_quarter' },
          { points: twice },
        ),
      ),
    ).toBe('duplicate_plan_date');
    const early = point('2023-06-30', '1.00', '1.00', '1.00');
    expect(codeOf(() => compare({ quarters: [early, early] }))).toBe('duplicate_quarter_date');
    // The current quarter is itself: a row on its date in the list is the same quarter.
    expect(compare({ quarters: [QUARTER, QUARTER] }).series[0]!.points.at(-2)!.periodEnd).toBe(
      '2024-06-30',
    );
  });
});
