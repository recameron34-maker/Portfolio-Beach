import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CalcError,
  D,
  addDays,
  addMonths,
  capitalizePik,
  compareIso,
  daysBetween,
  dpi,
  entrySnapshot,
  fromDayNumber,
  holdingPeriodYears,
  indexLevelAt,
  moic,
  multipleDelta,
  growthSinceEntry,
  npv,
  paidIn,
  parseIso,
  priorReportTieOut,
  qtdGainLoss,
  quarterOf,
  rvpi,
  summarizeFlows,
  takahashiAlexander,
  toDayNumber,
  toDecimalString,
  toSignedFlows,
  tvpi,
  unfunded,
  unitSanityFlag,
  valueChange,
  xirr,
  yearOf,
  yieldToMaturity,
  yoyGrowth,
} from './index.js';
import type { CashFlow, TypedCashFlow } from './index.js';

/** Unit and property tests for behavior the golden fixtures do not pin down. */

describe('decimal input discipline', () => {
  it('rejects JS numbers for money', () => {
    expect(() => D(1 as unknown as string)).toThrow(CalcError);
  });
  it('rejects non-finite values', () => {
    expect(() => D('Infinity')).toThrow(CalcError);
    expect(() => D('abc')).toThrow();
  });
});

describe('dates', () => {
  it('round-trips day numbers across leap years', () => {
    fc.assert(
      fc.property(fc.integer({ min: -20000, max: 40000 }), (n) => {
        expect(toDayNumber(fromDayNumber(n))).toBe(n);
      }),
    );
  });
  it('rejects invalid dates', () => {
    expect(() => parseIso('2023-02-29')).toThrow(CalcError);
    expect(() => parseIso('2023-13-01')).toThrow(CalcError);
    expect(() => parseIso('23-01-01')).toThrow(CalcError);
  });
  it('clamps month arithmetic to the end of the month', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
    expect(addMonths('2024-12-15', 1)).toBe('2025-01-15');
  });
  it('computes day differences, quarters and years', () => {
    expect(daysBetween('2020-01-01', '2021-01-01')).toBe(366);
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(quarterOf('2024-05-15')).toBe(2);
    expect(yearOf('2024-05-15')).toBe(2024);
    expect(compareIso('2024-01-01', '2024-01-02')).toBeLessThan(0);
  });
});

const flowArb = (n: { min: number; max: number }): fc.Arbitrary<CashFlow[]> =>
  fc
    .array(
      fc.record({
        day: fc.integer({ min: 0, max: 3650 }),
        amount: fc.integer({ min: 1, max: 5_000_000 }),
      }),
      { minLength: n.min, maxLength: n.max },
    )
    .map((items) => {
      // First flow is always a contribution on day 0; later ones are distributions.
      const flows: CashFlow[] = [{ date: '2015-01-01', amount: '-1000000' }];
      for (const it of items)
        flows.push({ date: addDays('2015-01-01', it.day + 1), amount: String(it.amount) });
      return flows;
    });

describe('xirr properties', () => {
  it('is invariant to scaling all flows by a positive constant', () => {
    fc.assert(
      fc.property(flowArb({ min: 1, max: 4 }), fc.integer({ min: 2, max: 1000 }), (flows, k) => {
        const a = xirr(flows);
        const b = xirr(flows.map((f) => ({ date: f.date, amount: D(f.amount).times(k) })));
        if (a.value === null || b.value === null) {
          expect(a.reason).toBe(b.reason);
          return;
        }
        expect(a.value.minus(b.value).abs().lt('1e-9')).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
  it('has NPV within tolerance at the solved rate', () => {
    fc.assert(
      fc.property(flowArb({ min: 1, max: 4 }), (flows) => {
        const r = xirr(flows);
        if (r.value === null) return;
        expect(npv(flows, r.value).abs().lte('1e-8')).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
  it('returns insufficient_flows for fewer than two flows', () => {
    expect(xirr([]).reason).toBe('insufficient_flows');
    expect(xirr([{ date: '2020-01-01', amount: '-1' }]).reason).toBe('insufficient_flows');
  });
  it('returns no_root when flows change sign but no rate in the bracket clears NPV', () => {
    // A huge inflow before the outflow: NPV stays positive for every rate above -99.99%.
    const r = xirr([
      { date: '2020-01-01', amount: '1000000' },
      { date: '2020-01-02', amount: '-1' },
    ]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('no_root');
  });
  it('returns no_root when the only root lies above the 100x bracket', () => {
    // 1 to 1000 in 31 days annualizes to a rate far above 10,000%, outside [-0.9999, 100].
    const r = xirr([
      { date: '2020-01-01', amount: '-1' },
      { date: '2020-02-01', amount: '1000' },
    ]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('no_root');
    expect(r.shortPeriod).toBe(true);
  });
  it('falls back to bisection when Newton leaves the bracket', () => {
    // From a guess of 99 the Newton step on a 50x return jumps below -99.99%, so bisection takes over.
    const flows = [
      { date: '2020-01-01', amount: '-100' },
      { date: '2021-01-01', amount: '5000' },
    ];
    const r = xirr(flows, { initialGuess: '99' });
    expect(r.value).not.toBeNull();
    expect(npv(flows, r.value!).abs().lte('1e-8')).toBe(true);
    const direct = xirr(flows);
    expect(r.value!.minus(direct.value!).abs().lt('1e-9')).toBe(true);
  });
  it('supports the 365.25 day count and a custom guess', () => {
    const flows = [
      { date: '2020-01-01', amount: '-100' },
      { date: '2024-01-01', amount: '200' },
    ];
    // 1461 days is exactly 4 years on 365.25 but 4.0027 years on 365, so the 365.25 rate is higher.
    const a = xirr(flows, { dayCountBasis: 365.25, initialGuess: '0.2' });
    const b = xirr(flows);
    expect(a.value!.gt(b.value!)).toBe(true);
    expect(a.value!.minus(D('2').pow('0.25').minus(1)).abs().lt('1e-12')).toBe(true);
  });
  it('npv of no flows is zero', () => {
    expect(npv([], D('0.1')).isZero()).toBe(true);
  });
  it('treats a zero-amount flow as neither sign', () => {
    const r = xirr([
      { date: '2020-01-01', amount: '-100' },
      { date: '2020-06-01', amount: '0' },
      { date: '2022-01-01', amount: '150' },
    ]);
    expect(r.value).not.toBeNull();
  });
});

describe('multiples', () => {
  it('TVPI equals DPI plus RVPI', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (pi, dist, nav) => {
          const t = tvpi(String(dist), String(nav), String(pi))!;
          const sum = dpi(String(dist), String(pi))!.plus(rvpi(String(nav), String(pi))!);
          expect(t.minus(sum).abs().lt('1e-25')).toBe(true);
        },
      ),
    );
  });
  it('value change rebuilds the current value from the prior one', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 900_000_000 }),
        fc.integer({ min: 0, max: 900_000_000 }),
        fc.integer({ min: 0, max: 99 }),
        (prior, current, cents) => {
          const now = `${current}.${String(cents).padStart(2, '0')}`;
          const was = String(prior);
          const change = valueChange(now, was)!;
          const rebuilt = D(was).times(change.plus(1));
          // Exact up to rounding at 34 significant digits, relative to the values involved.
          const bound = D(now).plus(was).times('1e-30');
          expect(rebuilt.minus(now).abs().lte(bound)).toBe(true);
          // Up when the value rose, down when it fell, zero when it held.
          expect(change.comparedTo('0')).toBe(D(now).comparedTo(was));
        },
      ),
    );
  });
  it('value change is the same at any scale', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 2, max: 10_000 }),
        (prior, current, k) => {
          const base = valueChange(String(current), String(prior))!;
          const scaled = valueChange(String(current * k), String(prior * k))!;
          expect(scaled.minus(base).abs().lt('1e-30')).toBe(true);
        },
      ),
    );
  });
  it('renders results as the contract decimal string, ten places half up, no exponent', () => {
    expect(toDecimalString(null)).toBeNull();
    expect(toDecimalString(D('0'))).toBe('0');
    expect(toDecimalString(D('100'))).toBe('100');
    expect(toDecimalString(D('10.5000'))).toBe('10.5');
    expect(toDecimalString(D('-0.08'))).toBe('-0.08');
    expect(toDecimalString(valueChange('1', '3'))).toBe('-0.6666666667');
    expect(toDecimalString(D('1').div(3))).toBe('0.3333333333');
    expect(toDecimalString(D('12345678901234567890123.45'))).toBe('12345678901234567890123.45');
    expect(toDecimalString(D('0.00000000004'))).toBe('0');
  });
  it('value change is null without both values or against a zero base', () => {
    expect(valueChange('100', '0')).toBeNull();
    expect(valueChange('0', '0')).toBeNull();
    expect(valueChange(null, '100')).toBeNull();
    expect(valueChange('100', null)).toBeNull();
    expect(valueChange('100', '100')!.isZero()).toBe(true);
    expect(valueChange('0', '100')!.eq('-1')).toBe(true);
    expect(() => valueChange('100', 'abc')).toThrow();
  });
  it('returns null when paid-in is zero', () => {
    expect(paidIn('0')).toBeNull();
    expect(dpi('10', '0')).toBeNull();
    expect(rvpi('10', '0')).toBeNull();
    expect(tvpi('10', '5', '0')).toBeNull();
    expect(moic('10', '5', '0')).toBeNull();
    expect(moic('10', '5', '-5')!.eq('3')).toBe(true);
  });
  it('unfunded is null without a commitment and holding period null without a contribution', () => {
    expect(unfunded(null, '10')).toBeNull();
    expect(unfunded('100', '-60')!.eq('40')).toBe(true);
    expect(holdingPeriodYears(null, '2024-01-01')).toBeNull();
    expect(holdingPeriodYears('2020-01-01', '2021-01-01')!.eq(D('366').div(365))).toBe(true);
  });
  it('summarizes typed flows and converts them to signed flows', () => {
    const flows: TypedCashFlow[] = [
      { date: '2020-03-01', kind: 'contribution', amount: '-100' },
      { date: '2020-01-01', kind: 'contribution', amount: '50' },
      { date: '2021-01-01', kind: 'distribution', amount: '30' },
      { date: '2021-06-01', kind: 'recallable', amount: '10' },
      { date: '2021-06-01', kind: 'interest', amount: '5' },
      { date: '2021-07-01', kind: 'principal', amount: '20' },
      { date: '2021-08-01', kind: 'fee', amount: '-2' },
      { date: '2021-09-01', kind: 'expense', amount: '1' },
    ];
    const s = summarizeFlows(flows);
    expect(s.contributions.eq('150')).toBe(true);
    expect(s.distributions.eq('65')).toBe(true);
    expect(s.recallable.eq('10')).toBe(true);
    expect(s.feesAndExpenses.eq('3')).toBe(true);
    expect(s.firstContributionDate).toBe('2020-01-01');
    const signed = toSignedFlows(flows);
    expect(signed.map((f) => D(f.amount).toString())).toEqual([
      '-100',
      '-50',
      '30',
      '10',
      '5',
      '20',
      '-2',
      '-1',
    ]);
    const empty = summarizeFlows([]);
    expect(empty.firstContributionDate).toBeNull();
  });
});

describe('operating and period helpers', () => {
  it('handles null inputs', () => {
    expect(yoyGrowth(null, '1')).toBeNull();
    expect(yoyGrowth('1', null)).toBeNull();
    expect(yoyGrowth('120', '100')!.eq('0.2')).toBe(true);
    expect(growthSinceEntry(null, '1')).toBeNull();
    expect(growthSinceEntry('1', '0')).toBeNull();
    expect(growthSinceEntry('150', '100')!.eq('0.5')).toBe(true);
    expect(multipleDelta(null, D('1'))).toBeNull();
    expect(multipleDelta(D('12'), D('10'))!.eq('2')).toBe(true);
  });
  it('throws when more than one entry snapshot is flagged', () => {
    expect(() =>
      entrySnapshot([
        { periodEnd: '2020-12-31', status: 'approved', isEntrySnapshot: true },
        { periodEnd: '2021-12-31', status: 'approved', isEntrySnapshot: true },
      ]),
    ).toThrow(CalcError);
    expect(entrySnapshot([])).toBeNull();
  });
  it('unit sanity flags values outside bounds', () => {
    const bounds = { min: '1000000', max: '50000000000' };
    expect(unitSanityFlag('12500', bounds)).toBe(true);
    expect(unitSanityFlag('12500000', bounds)).toBe(false);
  });
});

describe('report QA math', () => {
  it('QTD gain/loss and prior-report tie-out', () => {
    expect(
      qtdGainLoss({
        endNav: '120',
        beginNavOfQuarter: '100',
        contributionsQtd: '30',
        distributionsQtd: '15',
      }).eq('5'),
    ).toBe(true);
    expect(priorReportTieOut('100', '100', null).passed).toBe(true);
    const broken = priorReportTieOut('105', '100', null);
    expect(broken.passed).toBe(false);
    expect(broken.explained).toBe(false);
    const explained = priorReportTieOut('105', '100', 'Restated by the sponsor in Q2');
    expect(explained.passed).toBe(true);
    expect(explained.explained).toBe(true);
    expect(priorReportTieOut('105', '100', '   ').passed).toBe(false);
  });
});

describe('pme helpers', () => {
  it('carries the last index level forward and throws before the series starts', () => {
    const series = [
      { date: '2020-01-01', level: '100' },
      { date: '2020-07-01', level: '110' },
    ];
    expect(indexLevelAt(series, '2020-03-01').eq('100')).toBe(true);
    expect(indexLevelAt(series, '2021-01-01').eq('110')).toBe(true);
    expect(() => indexLevelAt(series, '2019-12-31')).toThrow(CalcError);
  });
});

describe('liquidity model', () => {
  it('accepts a per-year contribution schedule and caps distributions at NAV', () => {
    const rows = takahashiAlexander({
      commitment: '100',
      rateOfContribution: ['0.5', '0.5'],
      life: 2,
      bow: '1',
      growth: '0',
      yield: '0',
      years: 4,
    });
    expect(rows.length).toBe(4);
    // Year 2: curve = (2/2)^1 = 1, so the whole grown NAV distributes.
    expect(rows[1]!.distribution.eq(rows[0]!.nav)).toBe(true);
    // Years beyond the schedule reuse the last rate; beyond the fund life the whole grown NAV
    // distributes, so year-end NAV is just that year's contribution.
    expect(rows[3]!.distribution.eq(rows[2]!.nav)).toBe(true);
    expect(rows[3]!.nav.eq(rows[3]!.contribution)).toBe(true);
    expect(() =>
      takahashiAlexander({
        commitment: '1',
        rateOfContribution: '0.1',
        life: 0,
        bow: '1',
        growth: '0',
        yield: '0',
        years: 1,
      }),
    ).toThrow(CalcError);
  });
});

describe('credit', () => {
  it('par never falls when PIK is capitalized', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 0, max: 2000 }),
        (par, bps) => {
          const after = capitalizePik(String(par), D(String(bps)).div(10000), 'quarterly');
          expect(after.gte(String(par))).toBe(true);
        },
      ),
    );
  });
  it('yield to maturity is null when maturity has passed or fair value is not positive', () => {
    const base = {
      asOf: '2025-01-15',
      fairValue: '98',
      par: '100',
      cashCoupon: '0.09',
      maturity: '2024-01-15',
      frequency: 'quarterly' as const,
    };
    expect(yieldToMaturity(base).value).toBeNull();
    expect(yieldToMaturity({ ...base, maturity: '2028-01-15', fairValue: '0' }).value).toBeNull();
  });
  it('applies scheduled principal, caps it at par, and defaults PIK to zero', () => {
    const r = yieldToMaturity({
      asOf: '2025-01-15',
      fairValue: '100',
      par: '100',
      cashCoupon: '0.10',
      maturity: '2027-01-15',
      frequency: 'annual',
      scheduledPrincipal: [
        { date: '2026-01-15', amount: '40' },
        { date: '2027-01-15', amount: '90' },
      ],
    });
    // 2026: 10 interest + 40 principal; 2027: 6 interest + 60 remaining par (90 capped at 60).
    expect(r.flows.map((f) => D(f.amount).toString())).toEqual(['-100', '50', '66']);
    expect(r.parAtMaturity!.isZero()).toBe(true);
    expect(r.value).not.toBeNull();
    const monthly = yieldToMaturity({
      asOf: '2025-01-15',
      fairValue: '100',
      par: '100',
      cashCoupon: '0.12',
      maturity: '2025-04-15',
      frequency: 'monthly',
    });
    expect(monthly.flows.length).toBe(4);
    const semi = yieldToMaturity({
      asOf: '2025-01-15',
      fairValue: '100',
      par: '100',
      cashCoupon: '0.12',
      maturity: '2026-01-15',
      frequency: 'semiannual',
    });
    expect(semi.flows.length).toBe(3);
  });
});
