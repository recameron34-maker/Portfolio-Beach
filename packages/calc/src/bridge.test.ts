import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CalcError,
  D,
  RESULT_PLACES,
  ZERO,
  bandIndexOf,
  entryStake,
  equityValue,
  evToEbitda,
  gainByDriver,
  growthSinceEntry,
  indexedLevel,
  moic,
  multipleDelta,
  netDebtToEbitda,
  sinceEntryMeasures,
  totalGain,
  turnBands,
  valueCreationAttribution,
  valueCreationBridge,
  weightedAverage,
} from './index.js';
import type { BridgePoint, Decimal, ValueCreationBridge } from './index.js';

/**
 * Property and unit tests for the value creation analytics (docs/08 section 8): the EBITDA bridge,
 * the growth measures since entry, our gain by driver and the entry metric bands. The golden
 * fixtures 19 to 22 pin the worked examples; these pin the rules that hold for every input.
 */

/** Dollars and cents as the record stores them: a decimal string with two places. */
const money = (min: number, max: number): fc.Arbitrary<string> =>
  fc
    .tuple(fc.integer({ min, max }), fc.integer({ min: 0, max: 99 }))
    .map(([dollars, cents]) =>
      dollars < 0
        ? `-${-dollars}.${String(cents).padStart(2, '0')}`
        : `${dollars}.${String(cents).padStart(2, '0')}`,
    );

/** A company's figures at one date, every one on record. */
interface Company {
  ebitda: string;
  ev: string;
  netDebt: string;
  revenue: string;
}

/** A company at one date: positive EBITDA, an EV of 2 to 40 turns of it, net debt from net cash to 90% of EV. */
const companyPoint: fc.Arbitrary<Company> = fc
  .tuple(
    money(100_000, 2_000_000_000),
    fc.integer({ min: 200, max: 4000 }),
    fc.integer({ min: -20, max: 90 }),
    fc.integer({ min: 150, max: 2000 }),
    fc.integer({ min: 0, max: 99 }),
  )
  .map(([ebitda, multipleBp, debtPct, revenuePct, cents]) => {
    const e = D(ebitda);
    const ev = e.times(multipleBp).div(100).toDecimalPlaces(2);
    return {
      ebitda,
      ev: ev.toFixed(2),
      netDebt: ev
        .times(debtPct)
        .div(100)
        .plus(D(String(cents)).div(100))
        .toFixed(2),
      revenue: e.times(revenuePct).div(100).toFixed(2),
    };
  });

const sumOf = (...parts: Decimal[]): Decimal => parts.reduce((a, b) => a.plus(b), ZERO);
const within = (a: Decimal, b: Decimal, tolerance: string): boolean =>
  a.minus(b).abs().lte(D(tolerance));

const bridgeOf = (entry: BridgePoint, current: BridgePoint): ValueCreationBridge => {
  const r = valueCreationBridge(entry, current);
  if (r.value === null) throw new Error(`no bridge: ${r.reason}`);
  return r.value;
};

describe('valueCreationBridge (docs/08 section 8)', () => {
  it('splits the change in equity value into three drivers that sum to it exactly', () => {
    fc.assert(
      fc.property(companyPoint, companyPoint, (entry, current) => {
        const b = bridgeOf(entry, current);
        expect(b.equityAtEntry.eq(D(entry.ev).minus(entry.netDebt))).toBe(true);
        expect(b.equityCurrent.eq(D(current.ev).minus(current.netDebt))).toBe(true);
        expect(b.total.eq(b.equityCurrent.minus(b.equityAtEntry))).toBe(true);
        // No tolerance: the parts are the whole to the last place.
        expect(sumOf(b.ebitdaGrowth, b.multipleExpansion, b.debtPaydown).eq(b.total)).toBe(true);
        // Debt paydown is positive exactly when net debt fell.
        expect(b.debtPaydown.eq(D(entry.netDebt).minus(current.netDebt))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('gives each driver a share of the total, and the shares sum to one', () => {
    fc.assert(
      fc.property(companyPoint, companyPoint, (entry, current) => {
        const b = bridgeOf(entry, current);
        if (b.total.isZero()) {
          expect(b.shares).toBeNull();
          return;
        }
        const s = b.shares!;
        expect(s.ebitdaGrowth.eq(b.ebitdaGrowth.div(b.total))).toBe(true);
        expect(s.multipleExpansion.eq(b.multipleExpansion.div(b.total))).toBe(true);
        expect(s.debtPaydown.eq(b.debtPaydown.div(b.total))).toBe(true);
        const sum = sumOf(s.ebitdaGrowth, s.multipleExpansion, s.debtPaydown);
        // Three rounded quotients: one unit in the last place each, scaled by the largest share.
        const scale = [s.ebitdaGrowth, s.multipleExpansion, s.debtPaydown].reduce(
          (m, x) => (x.abs().gt(m) ? x.abs() : m),
          D('1'),
        );
        expect(sum.minus(1).abs().lte(scale.times('1e-30'))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('is the four-driver attribution with revenue and margin taken together (one rule)', () => {
    fc.assert(
      fc.property(companyPoint, companyPoint, (entry, current) => {
        const b = bridgeOf(entry, current);
        const four = valueCreationAttribution(entry, current);
        expect(four).not.toBeNull();
        const a = four!;
        // The attribution rounds its intermediate ratios, so the two agree to far below a cent.
        const tol = '1e-12';
        expect(within(b.ebitdaGrowth, a.revenueGrowth.plus(a.marginChange), tol)).toBe(true);
        expect(within(b.multipleExpansion, a.multipleChange, tol)).toBe(true);
        expect(within(b.debtPaydown, a.netDebtChange, tol)).toBe(true);
        expect(within(b.total, a.total, tol)).toBe(true);
        expect(b.revenueGrowth).not.toBeNull();
        expect(b.marginChange).not.toBeNull();
        expect(within(b.revenueGrowth!, a.revenueGrowth, tol)).toBe(true);
        expect(within(b.marginChange!, a.marginChange, tol)).toBe(true);
        // Inside the bridge the two revenue-side parts are EBITDA growth exactly.
        expect(b.revenueGrowth!.plus(b.marginChange!).eq(b.ebitdaGrowth)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('leaves the shares unchanged when the whole company is scaled', () => {
    fc.assert(
      fc.property(
        companyPoint,
        companyPoint,
        fc.integer({ min: 2, max: 1000 }),
        (entry, current, k) => {
          const scale = (p: Company): Company => ({
            ebitda: D(p.ebitda).times(k).toFixed(2),
            ev: D(p.ev).times(k).toFixed(2),
            netDebt: D(p.netDebt).times(k).toFixed(2),
            revenue: D(p.revenue).times(k).toFixed(2),
          });
          const a = bridgeOf(entry, current);
          const b = bridgeOf(scale(entry), scale(current));
          expect(b.total.eq(a.total.times(k))).toBe(true);
          if (a.shares === null) {
            expect(b.shares).toBeNull();
            return;
          }
          for (const key of ['ebitdaGrowth', 'multipleExpansion', 'debtPaydown'] as const) {
            const tol = a.shares[key].abs().plus(1).times('1e-18').toString();
            expect(within(b.shares![key], a.shares[key], tol)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('has no bridge, and says why, when an EBITDA is not positive', () => {
    const good: BridgePoint = { ebitda: '40', ev: '400', netDebt: '150', revenue: '200' };
    for (const ebitda of ['0', '-0.01', '-25']) {
      expect(valueCreationBridge({ ...good, ebitda }, good)).toEqual({
        value: null,
        reason: 'non_positive_ebitda',
      });
      expect(valueCreationBridge(good, { ...good, ebitda })).toEqual({
        value: null,
        reason: 'non_positive_ebitda',
      });
    }
    expect(valueCreationBridge(good, good).reason).toBeUndefined();
  });

  it('opens EBITDA growth into revenue and margin only when both revenues are positive', () => {
    const entry: BridgePoint = { ebitda: '40', ev: '400', netDebt: '150', revenue: '200' };
    const current: BridgePoint = { ebitda: '65', ev: '715', netDebt: '120', revenue: '260' };
    const full = bridgeOf(entry, current);
    expect(full.revenueGrowth?.toString()).toBe('120');
    expect(full.marginChange?.toString()).toBe('130');
    const without = (p: BridgePoint): BridgePoint => ({
      ebitda: p.ebitda,
      ev: p.ev,
      netDebt: p.netDebt,
    });
    for (const [e, c] of [
      [without(entry), current],
      [entry, without(current)],
      [{ ...entry, revenue: null }, current],
      [entry, { ...current, revenue: '0' }],
      [{ ...entry, revenue: '-1' }, current],
    ] as const) {
      const b = bridgeOf(e, c);
      expect(b.revenueGrowth).toBeNull();
      expect(b.marginChange).toBeNull();
      // The three drivers do not depend on revenue.
      expect(b.ebitdaGrowth.eq(full.ebitdaGrowth)).toBe(true);
      expect(b.multipleExpansion.eq(full.multipleExpansion)).toBe(true);
      expect(b.debtPaydown.eq(full.debtPaydown)).toBe(true);
    }
  });

  it('rejects JS numbers, like every money input', () => {
    const good: BridgePoint = { ebitda: '40', ev: '400', netDebt: '150' };
    expect(() => valueCreationBridge({ ...good, ev: 400 as unknown as string }, good)).toThrow(
      CalcError,
    );
  });
});

describe('totalGain and gainByDriver (docs/08 section 8)', () => {
  it('is distributions plus NAV less invested, and ties to MOIC', () => {
    fc.assert(
      fc.property(
        money(1, 2_000_000_000),
        money(0, 2_000_000_000),
        money(0, 2_000_000_000),
        (invested, distributions, nav) => {
          const gain = totalGain(distributions, nav, invested);
          expect(gain).not.toBeNull();
          expect(gain!.eq(D(distributions).plus(nav).minus(invested))).toBe(true);
          const multiple = moic(distributions, nav, invested)!;
          // gain = (MOIC - 1) x invested, to the rounding of the one division in MOIC.
          expect(within(multiple.minus(1).times(invested), gain!, '1e-15')).toBe(true);
          expect(gain!.isNegative()).toBe(multiple.lt(1));
        },
      ),
    );
    expect(totalGain('5', '5', '0')).toBeNull();
    expect(totalGain('5', '5', '-4')?.toString()).toBe('6');
  });

  it('sets our gain against the company drivers at our entry stake; the four parts are the gain exactly', () => {
    fc.assert(
      fc.property(
        companyPoint,
        companyPoint,
        money(1, 2_000_000_000),
        money(-2_000_000_000, 2_000_000_000),
        (entry, current, invested, gain) => {
          const b = bridgeOf(entry, current);
          const r = gainByDriver(gain, invested, b);
          if (b.equityAtEntry.lte(0)) {
            expect(r).toEqual({ value: null, reason: 'non_positive_entry_equity' });
            expect(entryStake(invested, b.equityAtEntry)).toBeNull();
            return;
          }
          expect(r.reason).toBeUndefined();
          const s = r.value!;
          // Any stake, any gain, any company total (zero included): no tolerance.
          expect(
            sumOf(s.ebitdaGrowth, s.multipleExpansion, s.debtPaydown, s.other).eq(D(gain)),
          ).toBe(true);
          expect(s.stake.eq(D(invested).div(b.equityAtEntry))).toBe(true);
          expect(s.stake.eq(entryStake(invested, b.equityAtEntry)!)).toBe(true);
          // Each driver part is the stake times the company's driver, held to the result places.
          const half = D('0.5e-10');
          const share = (driver: Decimal): Decimal =>
            D(invested).times(driver).div(b.equityAtEntry);
          expect(s.ebitdaGrowth.minus(share(b.ebitdaGrowth)).abs().lte(half)).toBe(true);
          expect(s.multipleExpansion.minus(share(b.multipleExpansion)).abs().lte(half)).toBe(true);
          expect(s.debtPaydown.minus(share(b.debtPaydown)).abs().lte(half)).toBe(true);
          for (const part of [s.ebitdaGrowth, s.multipleExpansion, s.debtPaydown, s.other])
            expect(part.decimalPlaces()).toBeLessThanOrEqual(RESULT_PLACES);
          // The revenue and margin parts open the EBITDA part exactly.
          expect(s.revenueGrowth).not.toBeNull();
          expect(s.revenueGrowth!.plus(s.marginChange!).eq(s.ebitdaGrowth)).toBe(true);
          // The remainder is what the company's change at our stake does not explain.
          const explained = sumOf(s.ebitdaGrowth, s.multipleExpansion, s.debtPaydown);
          expect(s.other.eq(D(gain).minus(explained))).toBe(true);
          expect(explained.minus(share(b.total)).abs().lte(half.times(3))).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('scales the driver parts linearly with the stake, and moves the remainder by the same amount', () => {
    fc.assert(
      fc.property(
        companyPoint,
        companyPoint,
        money(1, 20_000_000),
        money(-2_000_000_000, 2_000_000_000),
        fc.integer({ min: 2, max: 100 }),
        (entry, current, invested, gain, k) => {
          const b = bridgeOf(entry, current);
          fc.pre(b.equityAtEntry.gt(0));
          const one = gainByDriver(gain, invested, b).value!;
          const many = gainByDriver(gain, D(invested).times(k), b).value!;
          expect(many.stake.minus(one.stake.times(k)).abs().lte(one.stake.times('1e-30'))).toBe(
            true,
          );
          // One rounding at the tenth place on each side: k halves and one more.
          const tol = D('0.5e-10').times(k + 1);
          for (const key of ['ebitdaGrowth', 'multipleExpansion', 'debtPaydown'] as const)
            expect(many[key].minus(one[key].times(k)).abs().lte(tol), key).toBe(true);
          expect(many.revenueGrowth!.minus(one.revenueGrowth!.times(k)).abs().lte(tol)).toBe(true);
          // The gain is the same, so what the drivers gain the remainder gives up.
          const drivers = (s: typeof one): Decimal =>
            sumOf(s.ebitdaGrowth, s.multipleExpansion, s.debtPaydown);
          expect(many.other.plus(drivers(many)).eq(one.other.plus(drivers(one)))).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('says why nothing is split: no gain, nothing invested, or an entry equity value that is not positive', () => {
    const bridge = bridgeOf(
      { ebitda: '40', ev: '400', netDebt: '150' },
      { ebitda: '65', ev: '715', netDebt: '120' },
    );
    expect(gainByDriver(null, '100', bridge)).toEqual({ value: null, reason: 'no_gain' });
    expect(gainByDriver('100', null, bridge)).toEqual({ value: null, reason: 'no_gain' });
    expect(gainByDriver('100', '0', bridge)).toEqual({ value: null, reason: 'no_gain' });
    for (const netDebt of ['400', '400.01', '900']) {
      const under = bridgeOf(
        { ebitda: '40', ev: '400', netDebt },
        { ebitda: '65', ev: '715', netDebt: '120' },
      );
      expect(gainByDriver('100', '10', under)).toEqual({
        value: null,
        reason: 'non_positive_entry_equity',
      });
    }
    expect(entryStake('10', '250')?.toString()).toBe('0.04');
    expect(entryStake('10', '0')).toBeNull();
    expect(entryStake('10', '-1')).toBeNull();
    expect(entryStake('0', '250')).toBeNull();
    expect(entryStake(null, '250')).toBeNull();
    expect(entryStake('10', null)).toBeNull();
    // A stake of 10 in 250 of entry equity: 4% of each driver, and the rest of the gain.
    const split = gainByDriver('20', '10', bridge).value!;
    expect(split.stake.toString()).toBe('0.04');
    expect(split.ebitdaGrowth.toString()).toBe('10');
    expect(split.multipleExpansion.toString()).toBe('2.6');
    expect(split.debtPaydown.toString()).toBe('1.2');
    expect(split.other.toString()).toBe('6.2');
    // No revenue on the bridge, so no revenue and margin parts of the gain either.
    expect(split.revenueGrowth).toBeNull();
    expect(split.marginChange).toBeNull();
    // A company whose equity value did not move is no special case: the drivers cancel.
    const flat = bridgeOf(
      { ebitda: '50', ev: '500', netDebt: '200' },
      { ebitda: '55', ev: '520', netDebt: '220' },
    );
    expect(flat.total.isZero()).toBe(true);
    const level = gainByDriver('7', '30', flat).value!;
    expect(sumOf(level.ebitdaGrowth, level.multipleExpansion, level.debtPaydown).isZero()).toBe(
      true,
    );
    expect(level.other.toString()).toBe('7');
    // A gain of zero is split too: the remainder offsets the drivers.
    const none = gainByDriver('0', '10', bridge).value!;
    expect(none.other.toString()).toBe('-13.8');
  });
});

describe('sinceEntryMeasures, equityValue and indexedLevel (docs/08 section 4)', () => {
  it('uses the operating functions for every measure (one rule per ratio)', () => {
    fc.assert(
      fc.property(companyPoint, companyPoint, (entry, current) => {
        const m = sinceEntryMeasures(entry, current);
        const same = (a: Decimal | null, b: Decimal | null): boolean =>
          a === null || b === null ? a === b : a.eq(b);
        expect(same(m.ebitdaGrowth, growthSinceEntry(current.ebitda, entry.ebitda))).toBe(true);
        expect(same(m.evGrowth, growthSinceEntry(current.ev, entry.ev))).toBe(true);
        expect(
          same(
            m.equityValueGrowth,
            growthSinceEntry(
              equityValue(current.ev, current.netDebt),
              equityValue(entry.ev, entry.netDebt),
            ),
          ),
        ).toBe(true);
        expect(
          same(
            m.multipleChange,
            multipleDelta(
              evToEbitda(current.ev, current.ebitda),
              evToEbitda(entry.ev, entry.ebitda),
            ),
          ),
        ).toBe(true);
        expect(
          same(
            m.netLeverageChange,
            multipleDelta(
              netDebtToEbitda(current.netDebt, current.ebitda),
              netDebtToEbitda(entry.netDebt, entry.ebitda),
            ),
          ),
        ).toBe(true);
        expect(same(m.netDebtChange, D(current.netDebt).minus(entry.netDebt))).toBe(true);
      }),
    );
  });

  it('indexes a figure to 100 at its base, and never to a base that is not positive', () => {
    fc.assert(
      fc.property(money(1, 2_000_000_000), money(-2_000_000_000, 2_000_000_000), (base, now) => {
        const level = indexedLevel(now, base)!;
        const growth = growthSinceEntry(now, base)!;
        expect(within(level, growth.plus(1).times(100), '1e-20')).toBe(true);
        expect(indexedLevel(base, base)!.eq(100)).toBe(true);
      }),
    );
    expect(indexedLevel('5', '0')).toBeNull();
    expect(indexedLevel('5', '-2')).toBeNull();
    expect(indexedLevel(null, '2')).toBeNull();
    expect(indexedLevel('5', null)).toBeNull();
  });

  it('has an equity value only when EV and net debt are both on record', () => {
    expect(equityValue('400', '150')?.toString()).toBe('250');
    expect(equityValue('100', '150')?.toString()).toBe('-50');
    expect(equityValue(null, '150')).toBeNull();
    expect(equityValue('400', null)).toBeNull();
  });
});

describe('turnBands and bandIndexOf (docs/08 section 8)', () => {
  /** Strictly ascending edges in tenths of a turn. */
  const edges = fc
    .uniqueArray(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 8 })
    .map((tenths) => [...tenths].sort((a, b) => a - b).map((t) => D(String(t)).div(10).toString()));
  const value = fc
    .integer({ min: -5000, max: 50_000 })
    .map((hundredths) => D(String(hundredths)).div(100).toString());

  it('partitions the line: every value sits in exactly one band, the one bandIndexOf names', () => {
    fc.assert(
      fc.property(edges, value, (e, v) => {
        const bands = turnBands(e);
        expect(bands.length).toBe(e.length + 1);
        const holding = bands.filter(
          (b) => (b.lower === null || b.lower.lte(v)) && (b.upper === null || b.upper.gt(v)),
        );
        expect(holding.length).toBe(1);
        expect(holding[0]!.index).toBe(bandIndexOf(v, e));
        // Neighbours share an edge, the first band has no floor and the last no ceiling.
        expect(bands[0]!.lower).toBeNull();
        expect(bands[bands.length - 1]!.upper).toBeNull();
        for (let i = 1; i < bands.length; i += 1) {
          expect(bands[i]!.lower!.eq(bands[i - 1]!.upper!)).toBe(true);
          expect(bands[i]!.index).toBe(i);
        }
        expect(new Set(bands.map((b) => b.label)).size).toBe(bands.length);
      }),
      { numRuns: 300 },
    );
  });

  it('puts a value on an edge in the band that starts there', () => {
    fc.assert(
      fc.property(edges, (e) => {
        e.forEach((edge, i) => {
          expect(bandIndexOf(edge, e)).toBe(i + 1);
          expect(bandIndexOf(D(edge).minus('0.0001').toString(), e)).toBe(i);
        });
      }),
    );
  });

  it('refuses edges that are empty, repeated or out of order', () => {
    for (const bad of [[], ['8', '8'], ['10', '8'], ['8', '10', '9']]) {
      expect(() => turnBands(bad)).toThrow(CalcError);
      expect(() => bandIndexOf('9', bad)).toThrow(CalcError);
    }
  });

  it('writes the labels in turns, with one decimal or the places an edge carries', () => {
    expect(turnBands(['8']).map((b) => b.label)).toEqual(['Under 8.0x', '8.0x and over']);
    expect(turnBands(['3', '4.5', '6.25']).map((b) => b.label)).toEqual([
      'Under 3.0x',
      '3.0x to 4.5x',
      '4.5x to 6.25x',
      '6.25x and over',
    ]);
  });
});

describe('weightedAverage (docs/08 section 8)', () => {
  it('lies between the smallest and the largest value and scales with nothing', () => {
    const item = fc.record({
      weight: money(1, 2_000_000_000),
      value: fc
        .integer({ min: -9999, max: 99_999 })
        .map((bp) => D(String(bp)).div(10_000).toString()),
    });
    fc.assert(
      fc.property(fc.array(item, { minLength: 1, maxLength: 12 }), (items) => {
        const avg = weightedAverage(items)!;
        const values = items.map((i) => D(i.value));
        const lo = values.reduce((a, b) => (b.lt(a) ? b : a));
        const hi = values.reduce((a, b) => (b.gt(a) ? b : a));
        expect(avg.gte(lo.minus('1e-25')) && avg.lte(hi.plus('1e-25'))).toBe(true);
        const doubled = weightedAverage(
          items.map((i) => ({ ...i, weight: D(i.weight).times(2).toString() })),
        )!;
        expect(within(doubled, avg, '1e-25')).toBe(true);
      }),
    );
  });

  it('has no figure for nothing, or for weights that sum to zero', () => {
    expect(weightedAverage([])).toBeNull();
    expect(weightedAverage([{ weight: '0', value: '0.2' }])).toBeNull();
    expect(weightedAverage([{ weight: '4', value: '0.2' }])?.toString()).toBe('0.2');
  });
});
