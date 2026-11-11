import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  D,
  NOT_CALCULABLE_BAND,
  VALUE_CREATION_REASONS,
  ZERO,
  bandKeyOf,
  entryCohortBands,
  moic,
  pooledReturns,
  toDecimalString,
  turnBands,
  valueCreationRollup,
  xirr,
} from './index.js';
import type { CohortBand, Decimal, RollupPosition, ValueCreationReason } from './index.js';

/**
 * Property and unit tests for the roll-up of the value creation views (docs/08 section 8): the
 * portfolio sums, the cohorts with their pooled metrics and the invested-weighted EBITDA growth,
 * over position rows as they travel. Golden fixture 23 pins the worked example; these pin what
 * holds for any set of rows, which is what makes a filtered view exact.
 */

const AS_OF = '2025-06-30';
const BANDS = {
  byEntryMultiple: entryCohortBands(['8', '10', '12']),
  byEntryLeverage: entryCohortBands(['4', '6']),
};
const keysOf = (bands: readonly CohortBand[]): string[] => bands.map((b) => b.key);

const cents = (min: number, max: number): fc.Arbitrary<Decimal> =>
  fc.integer({ min: min * 100, max: max * 100 }).map((c) => D(String(c)).div(100));
/** A part of a gain as it travels: up to ten places. */
const part = fc
  .tuple(fc.integer({ min: -90_000_000, max: 90_000_000 }), fc.integer({ min: 0, max: 9999 }))
  .map(([whole, frac]) => D(String(whole)).plus(D(String(frac)).div('1e10')));
const day = (from: number, to: number): fc.Arbitrary<string> =>
  fc
    .integer({ min: from, max: to })
    .map((n) => new Date(Date.UTC(2015, 0, 1) + n * 86_400_000).toISOString().slice(0, 10));

const s = (d: Decimal): string => toDecimalString(d)!;

/** One position row as the response carries it, with flows that agree with its own totals. */
const position: fc.Arbitrary<RollupPosition> = fc
  .record({
    invested: cents(1, 60_000_000),
    distributed: fc.option(cents(1, 80_000_000), { nil: null }),
    fee: fc.option(cents(1, 50_000), { nil: null }),
    mark: fc.option(cents(0, 90_000_000), { nil: null, freq: 9 }),
    isActive: fc.boolean(),
    parts: fc.option(fc.tuple(part, part, part), { nil: null, freq: 4 }),
    withRevenue: fc.boolean(),
    revenue: part,
    reason: fc.constantFrom<ValueCreationReason>(
      ...VALUE_CREATION_REASONS.filter((r) => r !== 'no_gain'),
    ),
    growth: fc.option(
      fc.integer({ min: -9000, max: 30_000 }).map((bp) => D(String(bp)).div(10_000)),
      { nil: null, freq: 5 },
    ),
    contributed: day(0, 2000),
    received: day(2001, 3800),
    multipleBand: fc.constantFrom(...keysOf(BANDS.byEntryMultiple)),
    leverageBand: fc.constantFrom(...keysOf(BANDS.byEntryLeverage)),
  })
  .map((r): RollupPosition => {
    // A realized position holds nothing; a held one has its mark, or none yet.
    const nav = r.isActive ? r.mark : ZERO;
    const distributions = r.distributed ?? ZERO;
    const gain = nav === null ? null : distributions.plus(nav).minus(r.invested);
    const split = gain === null ? null : r.parts;
    const flows = [{ date: r.contributed, amount: s(r.invested.neg()) }];
    if (r.fee !== null) flows.push({ date: r.contributed, amount: s(r.fee.neg()) });
    if (r.distributed !== null) flows.push({ date: r.received, amount: s(r.distributed) });
    return {
      isActive: r.isActive,
      invested: s(r.invested),
      nav: nav === null ? null : s(nav),
      distributions: s(distributions),
      gain: gain === null ? null : s(gain),
      gainByDriver:
        split === null || gain === null
          ? null
          : {
              ebitdaGrowth: s(split[0]),
              multipleExpansion: s(split[1]),
              debtPaydown: s(split[2]),
              other: s(gain.minus(split[0]).minus(split[1]).minus(split[2])),
              revenueGrowth: r.withRevenue ? s(r.revenue) : null,
              marginChange: r.withRevenue ? s(split[0].minus(r.revenue)) : null,
            },
      gainNotCalculable: gain === null ? 'no_gain' : split === null ? r.reason : null,
      growth: { ebitdaGrowth: r.growth === null ? null : s(r.growth) },
      flows,
      entryMultipleBand: r.multipleBand,
      entryLeverageBand: r.leverageBand,
    };
  });

const positions = fc.array(position, { minLength: 0, maxLength: 9 });
const num = (v: string | null): Decimal => (v === null ? ZERO : D(v));
const sum = (
  rows: readonly RollupPosition[],
  pick: (p: RollupPosition) => string | null,
): Decimal => rows.reduce((acc, p) => acc.plus(num(pick(p))), ZERO);

describe('valueCreationRollup: the portfolio (docs/08 section 8)', () => {
  it('sums the parts over the positions that are split, and the parts are the gain exactly', () => {
    fc.assert(
      fc.property(positions, (rows) => {
        const { portfolio } = valueCreationRollup(rows, BANDS, AS_OF);
        const included = rows.filter((p) => p.gainByDriver !== null);
        expect(portfolio.positions).toBe(included.length);
        if (included.length === 0) {
          expect(portfolio.gain).toBeNull();
          expect(portfolio.gainByDriver).toBeNull();
          expect(portfolio.invested).toBeNull();
          expect(portfolio.totalValue).toBeNull();
          return;
        }
        const g = portfolio.gainByDriver!;
        // No tolerance anywhere: the strings carry every place that was summed.
        expect(portfolio.gain).toBe(s(sum(included, (p) => p.gain)));
        expect(g.ebitdaGrowth).toBe(s(sum(included, (p) => p.gainByDriver!.ebitdaGrowth)));
        expect(g.other).toBe(s(sum(included, (p) => p.gainByDriver!.other)));
        expect(
          D(g.ebitdaGrowth)
            .plus(g.multipleExpansion)
            .plus(g.debtPaydown)
            .plus(g.other)
            .eq(portfolio.gain!),
        ).toBe(true);
        expect(D(portfolio.invested!).plus(portfolio.gain!).eq(portfolio.totalValue!)).toBe(true);
        expect(D(portfolio.nav!).plus(portfolio.distributions!).eq(portfolio.totalValue!)).toBe(
          true,
        );
        // Revenue and margin are a total only when every summed position carries them.
        const every = included.every((p) => p.gainByDriver!.revenueGrowth !== null);
        expect(g.revenueGrowth === null).toBe(!every);
        expect(g.marginChange === null).toBe(!every);
        if (every) expect(D(g.revenueGrowth!).plus(g.marginChange!).eq(g.ebitdaGrowth)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('counts every position once: split, or not split with its reason, in the listed order', () => {
    fc.assert(
      fc.property(positions, (rows) => {
        const { portfolio } = valueCreationRollup(rows, BANDS, AS_OF);
        const counted = portfolio.notCalculable.reduce((n, r) => n + r.count, 0);
        expect(portfolio.positions + counted).toBe(rows.length);
        for (const { reason, count } of portfolio.notCalculable)
          expect(count).toBe(rows.filter((p) => p.gainNotCalculable === reason).length);
        const order = portfolio.notCalculable.map((r) => VALUE_CREATION_REASONS.indexOf(r.reason));
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(portfolio.notCalculable.every((r) => r.count > 0)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('adds up over any split of the rows, which is what makes a filtered view exact', () => {
    fc.assert(
      fc.property(
        positions,
        fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }),
        (rows, side) => {
          const whole = valueCreationRollup(rows, BANDS, AS_OF).portfolio;
          const a = valueCreationRollup(
            rows.filter((_p, i) => side[i]),
            BANDS,
            AS_OF,
          ).portfolio;
          const b = valueCreationRollup(
            rows.filter((_p, i) => !side[i]),
            BANDS,
            AS_OF,
          ).portfolio;
          expect(whole.positions).toBe(a.positions + b.positions);
          for (const key of ['invested', 'nav', 'distributions', 'totalValue', 'gain'] as const)
            expect(num(whole[key]).eq(num(a[key]).plus(num(b[key]))), key).toBe(true);
          for (const key of ['ebitdaGrowth', 'multipleExpansion', 'debtPaydown', 'other'] as const)
            expect(
              num(whole.gainByDriver?.[key] ?? null).eq(
                num(a.gainByDriver?.[key] ?? null).plus(num(b.gainByDriver?.[key] ?? null)),
              ),
              key,
            ).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('valueCreationRollup: the cohorts (docs/08 section 8)', () => {
  it('puts every position in exactly one cohort of each entry metric, and lists every band', () => {
    fc.assert(
      fc.property(positions, (rows) => {
        const { cohorts } = valueCreationRollup(rows, BANDS, AS_OF);
        for (const [list, bands, keyOf] of [
          [
            cohorts.byEntryMultiple,
            BANDS.byEntryMultiple,
            (p: RollupPosition) => p.entryMultipleBand,
          ],
          [
            cohorts.byEntryLeverage,
            BANDS.byEntryLeverage,
            (p: RollupPosition) => p.entryLeverageBand,
          ],
        ] as const) {
          expect(list.map((c) => [c.key, c.label, c.lower, c.upper])).toEqual(
            bands.map((b) => [b.key, b.label, b.lower, b.upper]),
          );
          expect(list.reduce((n, c) => n + c.count, 0)).toBe(rows.length);
          for (const cohort of list) {
            const members = rows.filter((p) => keyOf(p) === cohort.key);
            expect(cohort.count).toBe(members.length);
            if (members.length === 0) {
              expect(cohort.invested).toBeNull();
              expect(cohort.grossMoic).toBeNull();
              expect(cohort.irrFlag).toBe('insufficient_flows');
              continue;
            }
            expect(cohort.invested).toBe(s(sum(members, (p) => p.invested)));
            expect(cohort.distributions).toBe(s(sum(members, (p) => p.distributions)));
            // One held position without a mark leaves the cohort's NAV, MOIC and IRR unknown.
            const unmarked = members.some((p) => p.isActive && p.nav === null);
            expect(cohort.nav === null).toBe(unmarked);
            expect(cohort.grossMoic === null).toBe(unmarked);
            if (unmarked) {
              expect(cohort.grossIrr).toBeNull();
              expect(cohort.irrFlag).toBe('no_valuation');
            } else {
              expect(cohort.nav).toBe(s(sum(members, (p) => p.nav)));
              expect(cohort.grossMoic).toBe(
                toDecimalString(moic(cohort.distributions!, cohort.nav!, cohort.invested!)),
              );
            }
            const weighted = members.filter((p) => p.growth.ebitdaGrowth !== null);
            expect(cohort.ebitdaGrowthPositions).toBe(weighted.length);
            expect(cohort.ebitdaGrowth === null).toBe(weighted.length === 0);
          }
        }
      }),
      { numRuns: 50 },
    );
  });

  it('pools the IRR over the flows of the cohort, ending in its NAV on the as-of date', () => {
    fc.assert(
      fc.property(fc.array(position, { minLength: 1, maxLength: 4 }), (rows) => {
        fc.pre(rows.every((p) => !p.isActive || p.nav !== null));
        const same = rows.map((p) => ({ ...p, entryMultipleBand: 'band_1' }));
        const cohort = valueCreationRollup(same, BANDS, AS_OF).cohorts.byEntryMultiple[1]!;
        const flows = same.flatMap((p) => [...p.flows]);
        const nav = sum(same, (p) => p.nav);
        if (!nav.isZero()) flows.push({ date: AS_OF, amount: nav.toFixed(2) });
        const irr = xirr(flows);
        expect(cohort.grossIrr).toBe(toDecimalString(irr.value));
        if (irr.value === null) expect(cohort.irrFlag).toBe(irr.reason);
        else expect(cohort.irrFlag).toBe(irr.shortPeriod ? 'short_period' : null);
      }),
      { numRuns: 60 },
    );
  });

  it('weights EBITDA growth by invested capital over the positions that have both', () => {
    const row = (invested: string, growth: string | null, band: string): RollupPosition => ({
      isActive: false,
      invested,
      nav: '0',
      distributions: '0',
      gain: null,
      gainByDriver: null,
      gainNotCalculable: 'no_current_quarter',
      growth: { ebitdaGrowth: growth },
      flows: [{ date: '2020-01-31', amount: `-${invested}` }],
      entryMultipleBand: band,
      entryLeverageBand: NOT_CALCULABLE_BAND,
    });
    const { cohorts } = valueCreationRollup(
      [row('10', '0.25', 'band_0'), row('30', '-0.05', 'band_0'), row('60', null, 'band_0')],
      BANDS,
      AS_OF,
    );
    // (10 x 0.25 + 30 x -0.05) / 40 = 0.025; the position with no growth is not weighed in.
    expect(cohorts.byEntryMultiple[0]!.ebitdaGrowth).toBe('0.025');
    expect(cohorts.byEntryMultiple[0]!.ebitdaGrowthPositions).toBe(2);
    expect(cohorts.byEntryMultiple[0]!.count).toBe(3);
    expect(cohorts.byEntryLeverage[cohorts.byEntryLeverage.length - 1]!.count).toBe(3);
  });
});

describe('entryCohortBands and bandKeyOf (docs/08 section 8)', () => {
  it('lists the bands of the edges, lowest first, then the cohort with no entry figure', () => {
    expect(entryCohortBands(['8', '10.5'])).toEqual([
      { key: 'band_0', label: 'Under 8.0x', lower: null, upper: '8' },
      { key: 'band_1', label: '8.0x to 10.5x', lower: '8', upper: '10.5' },
      { key: 'band_2', label: '10.5x and over', lower: '10.5', upper: null },
      { key: NOT_CALCULABLE_BAND, label: 'Not calculable', lower: null, upper: null },
    ]);
    expect(entryCohortBands(['8', '10.5']).length).toBe(turnBands(['8', '10.5']).length + 1);
  });

  it('keys a figure by its band, and a missing figure by the cohort that says so', () => {
    expect(bandKeyOf('7.99', ['8', '10'])).toBe('band_0');
    expect(bandKeyOf('8', ['8', '10'])).toBe('band_1');
    expect(bandKeyOf(D('25'), ['8', '10'])).toBe('band_2');
    expect(bandKeyOf(null, ['8', '10'])).toBe(NOT_CALCULABLE_BAND);
  });
});

describe('pooledReturns (docs/08 sections 2 and 3)', () => {
  const flows = [
    { date: '2021-06-30', amount: '-2000000' },
    { date: '2023-06-30', amount: '200000' },
  ];
  const pool = { count: 2, contributions: '2000000', distributions: '200000', flows };

  it('pools the multiples over the sums and the IRR over the flows ending in the NAV', () => {
    const r = pooledReturns({ ...pool, nav: '2220000', asOf: '2023-06-30' });
    expect(r.grossMoic?.toString()).toBe('1.21');
    expect(r.dpi?.toString()).toBe('0.1');
    expect(r.rvpi?.toString()).toBe('1.11');
    expect(r.tvpi?.toString()).toBe('1.21');
    // (1 + r)^2 = 2,420,000 / 2,000,000 over 730 days.
    expect(toDecimalString(r.grossIrr)).toBe('0.1');
    expect(r.irrFlag).toBeNull();
  });

  it('has no NAV, MOIC or IRR while the NAV is not calculable, and no figure for an empty pool', () => {
    const unmarked = pooledReturns({ ...pool, nav: null, asOf: '2023-06-30' });
    expect(unmarked.invested?.toString()).toBe('2000000');
    expect(unmarked.dpi?.toString()).toBe('0.1');
    expect([unmarked.nav, unmarked.rvpi, unmarked.tvpi, unmarked.grossMoic]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(unmarked.grossIrr).toBeNull();
    expect(unmarked.irrFlag).toBe('no_valuation');
    expect(
      pooledReturns({
        count: 0,
        contributions: '0',
        distributions: '0',
        nav: '0',
        flows: [],
        asOf: '2023-06-30',
      }),
    ).toEqual({
      count: 0,
      invested: null,
      distributions: null,
      nav: null,
      dpi: null,
      rvpi: null,
      tvpi: null,
      grossMoic: null,
      grossIrr: null,
      irrFlag: 'insufficient_flows',
    });
  });

  it('adds no terminal flow for a NAV of zero, flags a short period and names why an IRR is missing', () => {
    const realized = pooledReturns({
      count: 1,
      contributions: '500000',
      distributions: '720000',
      nav: '0',
      flows: [
        { date: '2020-06-30', amount: '-500000' },
        { date: '2022-06-30', amount: '720000' },
      ],
      asOf: '2025-06-30',
    });
    expect(toDecimalString(realized.grossIrr)).toBe('0.2');
    const short = pooledReturns({
      count: 1,
      contributions: '100',
      distributions: '0',
      nav: '110',
      flows: [{ date: '2025-01-01', amount: '-100' }],
      asOf: '2025-06-30',
    });
    expect(short.grossIrr).not.toBeNull();
    expect(short.irrFlag).toBe('short_period');
    const nothingPaid = pooledReturns({
      count: 1,
      contributions: '0',
      distributions: '0',
      nav: '50',
      flows: [],
      asOf: '2025-06-30',
    });
    expect(nothingPaid.invested).toBeNull();
    expect(nothingPaid.distributions).toBeNull();
    expect(nothingPaid.grossMoic).toBeNull();
    expect(nothingPaid.irrFlag).toBe('insufficient_flows');
  });
});
