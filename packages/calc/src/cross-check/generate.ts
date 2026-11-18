/**
 * Writes random calculation cases with this library's results so the independent Python
 * implementation (apps/worker-py/calc_check) can recompute and compare them (docs/08, SEC-9.6).
 * Randomness comes from a seeded generator so a mismatch can always be reproduced.
 *
 * Usage: node dist/cross-check/generate.js <out.json> [seed] [casesPerKind]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CALC_VERSION } from '../version.js';
import { D, toDecimalString } from '../decimal.js';
import type { Decimal } from '../decimal.js';
import { addDays, daysBetween } from '../dates.js';
import { xirr } from '../irr.js';
import { dpi, rvpi, totalGain, tvpi, valueChange } from '../multiples.js';
import { yieldToMaturity } from '../credit.js';
import type { PaymentFrequency } from '../credit.js';
import { valueCreationAttribution } from '../attribution.js';
import { gainByDriver, indexedLevel, sinceEntryMeasures, valueCreationBridge } from '../bridge.js';
import type { BridgePoint } from '../bridge.js';
import { bandIndexOf, entryCohortBands, turnBands, weightedAverage } from '../cohorts.js';
import { dealFit, median } from '../fit.js';
import type { FitInputs, FitThresholds } from '../fit.js';
import { valueCreationRollup } from '../rollup.js';
import { planHeadline, planMetrics, underwritingComparison } from '../underwriting.js';
import type {
  PlanFigures,
  UnderwritingCase,
  UnderwritingInputs,
  UnderwritingTolerances,
} from '../underwriting.js';
import type { RollupPosition } from '../rollup.js';
import {
  heldMultipleMark,
  impliedStakeMark,
  markComparison,
  sourceCrossCheck,
  statementMark,
  statementTieTolerance,
} from '../suggestion.js';
import type { StatementLines, TieTolerances } from '../suggestion.js';
import { toDollars } from '../units.js';
import { VALUE_CREATION_REASONS } from '../terms.js';
import { directAlpha, ksPme } from '../pme.js';
import type { CashFlow, IndexPoint } from '../index.js';

/** mulberry32: small, fast, deterministic. Not for anything security related. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const str = (d: Decimal | null): string | null => (d === null ? null : d.toString());

interface Case {
  id: number;
  kind: string;
  tolerance: string;
  input: unknown;
  result: unknown;
}

function run(seed: number, perKind: number): Case[] {
  const rnd = prng(seed);
  const int = (min: number, max: number): number => Math.floor(rnd() * (max - min + 1)) + min;
  const cases: Case[] = [];
  let id = 0;

  for (let i = 0; i < perKind; i++) {
    const flows: CashFlow[] = [{ date: '2016-01-01', amount: String(-int(100_000, 5_000_000)) }];
    const n = int(1, 6);
    for (let j = 0; j < n; j++) {
      const sign = rnd() < 0.3 ? -1 : 1;
      flows.push({
        date: addDays('2016-01-01', int(1, 3650)),
        amount: String(sign * int(10_000, 4_000_000)),
      });
    }
    const r = xirr(flows);
    cases.push({
      id: id++,
      kind: 'xirr',
      tolerance: '1e-9',
      input: { flows },
      result: { value: str(r.value), reason: r.reason ?? null },
    });
  }

  for (let i = 0; i < perKind; i++) {
    const contributions = String(int(1, 10_000_000));
    const distributions = String(int(0, 20_000_000));
    const nav = String(int(0, 20_000_000));
    cases.push({
      id: id++,
      kind: 'multiples',
      tolerance: '1e-20',
      input: { contributions, distributions, nav },
      result: {
        dpi: str(dpi(distributions, contributions)),
        rvpi: str(rvpi(nav, contributions)),
        tvpi: str(tvpi(distributions, nav, contributions)),
      },
    });
  }

  const frequencies: PaymentFrequency[] = ['monthly', 'quarterly', 'semiannual', 'annual'];
  for (let i = 0; i < perKind; i++) {
    const input = {
      asOf: '2025-03-31',
      fairValue: String(int(80, 105)),
      par: '100',
      cashCoupon: D(String(int(300, 1200)))
        .div(10000)
        .toString(),
      pikCoupon: D(String(int(0, 400)))
        .div(10000)
        .toString(),
      maturity: addDays('2025-03-31', int(90, 2500)),
      frequency: frequencies[int(0, 3)] ?? 'quarterly',
    };
    const r = yieldToMaturity(input);
    cases.push({
      id: id++,
      kind: 'ytm',
      tolerance: '1e-9',
      input,
      result: { value: str(r.value), parAtMaturity: str(r.parAtMaturity) },
    });
  }

  for (let i = 0; i < perKind; i++) {
    const point = (): { revenue: string; ebitda: string; ev: string; netDebt: string } => {
      const revenue = int(50, 1000);
      const ebitda = rnd() < 0.1 ? 0 : int(5, Math.floor(revenue / 2));
      return {
        revenue: String(revenue),
        ebitda: String(ebitda),
        ev: String(ebitda * int(6, 14)),
        netDebt: String(int(0, ebitda * 5)),
      };
    };
    const input = { entry: point(), current: point() };
    const r = valueCreationAttribution(input.entry, input.current);
    cases.push({
      id: id++,
      kind: 'attribution',
      tolerance: '1e-20',
      input,
      result:
        r === null
          ? { total: null }
          : {
              revenueGrowth: str(r.revenueGrowth),
              marginChange: str(r.marginChange),
              multipleChange: str(r.multipleChange),
              netDebtChange: str(r.netDebtChange),
              total: str(r.total),
            },
    });
  }

  for (let i = 0; i < perKind; i++) {
    const index: IndexPoint[] = [];
    let level = D('100');
    for (let q = 0; q <= 20; q++) {
      index.push({ date: addDays('2018-12-31', q * 91), level: level.toFixed(4) });
      level = level.times(D(String(int(90, 112))).div(100));
    }
    const flows: CashFlow[] = [{ date: '2018-12-31', amount: String(-int(500_000, 2_000_000)) }];
    for (let j = 0; j < int(1, 5); j++) {
      const sign = rnd() < 0.4 ? -1 : 1;
      flows.push({
        date: addDays('2018-12-31', int(1, 1800)),
        amount: String(sign * int(50_000, 900_000)),
      });
    }
    const input = {
      flows,
      nav: String(int(0, 3_000_000)),
      navDate: addDays('2018-12-31', 20 * 91),
      index,
    };
    const ks = ksPme(input);
    const da = directAlpha(input);
    cases.push({
      id: id++,
      kind: 'pme',
      tolerance: '1e-9',
      input,
      result: { ksPme: str(ks), directAlpha: str(da.value) },
    });
  }

  // Last, so the kinds above keep drawing the same random numbers for a given seed.
  const cents = (): string => String(int(0, 99)).padStart(2, '0');
  for (let i = 0; i < perKind; i++) {
    const prior = rnd() < 0.1 ? '0' : `${int(1, 50_000_000)}.${cents()}`;
    const current = `${int(0, 80_000_000)}.${cents()}`;
    cases.push({
      id: id++,
      kind: 'value_change',
      tolerance: '1e-20',
      input: { current, prior },
      result: { value: str(valueChange(current, prior)) },
    });
  }

  // The value creation analytics (docs/08 section 8), after every earlier kind for the same reason.
  const amount = (min: number, max: number): string => `${int(min, max)}.${cents()}`;
  for (let i = 0; i < perKind; i++) {
    const point = (): BridgePoint => {
      const ebitda = rnd() < 0.08 ? -int(0, 5_000_000) : int(100_000, 900_000_000);
      const ev = Math.abs(ebitda) * int(4, 18) + int(0, 999);
      const withRevenue = rnd() < 0.8;
      return {
        ebitda: `${ebitda}.${cents()}`,
        ev: `${ev}.${cents()}`,
        // Up to 110% of EV, so some entries have an equity value at or below zero (no stake).
        netDebt: `${Math.floor(ev * (int(-10, 110) / 100))}.${cents()}`,
        ...(withRevenue ? { revenue: amount(0, 4_000_000_000) } : {}),
      };
    };
    const input = {
      entry: point(),
      current: point(),
      distributions: amount(0, 60_000_000),
      nav: amount(0, 90_000_000),
      invested: rnd() < 0.05 ? '0' : amount(1, 60_000_000),
    };
    const r = valueCreationBridge(input.entry, input.current);
    const gain = totalGain(input.distributions, input.nav, input.invested);
    const b = r.value;
    const ours = b === null ? null : gainByDriver(gain, input.invested, b);
    const split = ours?.value ?? null;
    cases.push({
      id: id++,
      kind: 'bridge',
      tolerance: '1e-18',
      input,
      result: {
        reason: r.reason ?? null,
        bridge:
          b === null
            ? null
            : {
                equityAtEntry: str(b.equityAtEntry),
                equityCurrent: str(b.equityCurrent),
                ebitdaGrowth: str(b.ebitdaGrowth),
                multipleExpansion: str(b.multipleExpansion),
                debtPaydown: str(b.debtPaydown),
                total: str(b.total),
                revenueGrowth: str(b.revenueGrowth),
                marginChange: str(b.marginChange),
                shares:
                  b.shares === null
                    ? null
                    : {
                        ebitdaGrowth: str(b.shares.ebitdaGrowth),
                        multipleExpansion: str(b.shares.multipleExpansion),
                        debtPaydown: str(b.shares.debtPaydown),
                      },
              },
        gain: str(gain),
        splitReason: ours?.reason ?? null,
        split:
          split === null
            ? null
            : {
                stake: str(split.stake),
                ebitdaGrowth: str(split.ebitdaGrowth),
                multipleExpansion: str(split.multipleExpansion),
                debtPaydown: str(split.debtPaydown),
                other: str(split.other),
                revenueGrowth: str(split.revenueGrowth),
                marginChange: str(split.marginChange),
              },
      },
    });
  }

  for (let i = 0; i < perKind; i++) {
    const figure = (min: number, max: number): string | null =>
      rnd() < 0.1 ? null : `${int(min, max)}.${cents()}`;
    const figures = (): { ebitda: string | null; ev: string | null; netDebt: string | null } => ({
      ebitda: figure(-20_000_000, 900_000_000),
      ev: figure(0, 9_000_000_000),
      netDebt: figure(-500_000_000, 6_000_000_000),
    });
    const input = { entry: figures(), current: figures() };
    const m = sinceEntryMeasures(input.entry, input.current);
    cases.push({
      id: id++,
      kind: 'since_entry',
      tolerance: '1e-20',
      input,
      result: {
        ebitdaGrowth: str(m.ebitdaGrowth),
        evGrowth: str(m.evGrowth),
        equityValueGrowth: str(m.equityValueGrowth),
        multipleChange: str(m.multipleChange),
        netLeverageChange: str(m.netLeverageChange),
        netDebtChange: str(m.netDebtChange),
        ebitdaIndex: str(indexedLevel(input.current.ebitda, input.entry.ebitda)),
        evIndex: str(indexedLevel(input.current.ev, input.entry.ev)),
      },
    });
  }

  for (let i = 0; i < perKind; i++) {
    const edges: string[] = [];
    let edge = int(10, 80);
    for (let j = int(1, 6); j > 0; j--) {
      edges.push(D(String(edge)).div(10).toString());
      edge += int(1, 40);
    }
    const values = Array.from({ length: 6 }, () =>
      rnd() < 0.3
        ? (edges[int(0, edges.length - 1)] ?? '0')
        : D(String(int(-200, 2500)))
            .div(100)
            .toString(),
    );
    const weighted = Array.from({ length: int(0, 5) }, () => ({
      weight: rnd() < 0.1 ? '0' : amount(1, 50_000_000),
      value: D(String(int(-9000, 30_000)))
        .div(10_000)
        .toString(),
    }));
    cases.push({
      id: id++,
      kind: 'bands',
      tolerance: '1e-20',
      input: { edges, values, weighted },
      result: {
        labels: turnBands(edges).map((b) => b.label),
        indexes: values.map((v) => bandIndexOf(v, edges)),
        weightedAverage: str(weightedAverage(weighted)),
      },
    });
  }

  // The roll-up of the value creation views over rows as they travel, last for the same reason.
  const asOf = '2025-06-30';
  const edges = { multiple: ['8', '10', '12'], leverage: ['4', '6'] };
  const bands = {
    byEntryMultiple: entryCohortBands(edges.multiple),
    byEntryLeverage: entryCohortBands(edges.leverage),
  };
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error('nothing to pick from');
    return item;
  };
  /** A part of a gain as it travels: up to ten places. */
  const part = (): Decimal =>
    D(String(int(-40_000_000, 40_000_000))).plus(D(String(int(0, 99_999))).div('1e10'));
  const wire = (d: Decimal): string => {
    const text = toDecimalString(d);
    if (text === null) throw new Error('unreachable: a value was given');
    return text;
  };
  for (let i = 0; i < perKind; i++) {
    const positions: RollupPosition[] = [];
    for (let n = int(0, 6); n > 0; n--) {
      const invested = D(amount(1, 60_000_000));
      const contributed = addDays('2016-01-01', int(0, 2000));
      const flows = [{ date: contributed, amount: wire(invested.neg()) }];
      if (rnd() < 0.3) flows.push({ date: contributed, amount: `-${amount(1, 90_000)}` });
      let distributions = D('0');
      if (rnd() < 0.6) {
        distributions = D(amount(1, 70_000_000));
        flows.push({ date: addDays(contributed, int(30, 1300)), amount: wire(distributions) });
      }
      const isActive = rnd() < 0.7;
      const mark = rnd() < 0.1 ? null : D(amount(0, 90_000_000));
      const nav = isActive ? mark : D('0');
      const gain = nav === null ? null : distributions.plus(nav).minus(invested);
      const split = gain !== null && rnd() < 0.8 ? [part(), part(), part()] : null;
      const [ebitda, multiple, debt] = split ?? [];
      const revenue = rnd() < 0.6 ? part() : null;
      positions.push({
        isActive,
        invested: wire(invested),
        nav: nav === null ? null : wire(nav),
        distributions: wire(distributions),
        gain: gain === null ? null : wire(gain),
        gainByDriver:
          gain === null || ebitda === undefined || multiple === undefined || debt === undefined
            ? null
            : {
                ebitdaGrowth: wire(ebitda),
                multipleExpansion: wire(multiple),
                debtPaydown: wire(debt),
                other: wire(gain.minus(ebitda).minus(multiple).minus(debt)),
                revenueGrowth: revenue === null ? null : wire(revenue),
                marginChange: revenue === null ? null : wire(ebitda.minus(revenue)),
              },
        gainNotCalculable:
          gain === null
            ? 'no_gain'
            : split === null
              ? pick(VALUE_CREATION_REASONS.filter((r) => r !== 'no_gain'))
              : null,
        growth: {
          ebitdaGrowth:
            rnd() < 0.15
              ? null
              : wire(
                  D(String(int(-9000, 30_000)))
                    .div(10_000)
                    .plus(D(String(int(0, 999_999))).div('1e10')),
                ),
        },
        flows,
        entryMultipleBand: pick(bands.byEntryMultiple).key,
        entryLeverageBand: pick(bands.byEntryLeverage).key,
      });
    }
    cases.push({
      id: id++,
      kind: 'rollup',
      tolerance: '1e-9',
      input: { asOf, edges, positions },
      result: valueCreationRollup(positions, bands, asOf),
    });
  }

  // Deal fit measures, last again: scores at and around every threshold, and missing inputs.
  const fitThresholds: FitThresholds = {
    tierScores: {
      'sponsor_tier.core': '100',
      'sponsor_tier.active': '70',
      'sponsor_tier.new': '40',
      'sponsor_tier.watch': '15',
    },
    trackRecord: { zeroAtMoic: '1.0', fullAtMoic: '2.5' },
    fundRelationship: { fund: '100', otherFund: '60', none: '0' },
    caps: { sector: '0.25', sponsor: '0.2', geography: '0.7' },
    size: { low: '0.5', high: '1.5', limit: '3' },
  };
  const tiers = [...Object.keys(fitThresholds.tierScores), 'sponsor_tier.unscored', null];
  const share = (cap: number): string | null =>
    rnd() < 0.12
      ? null
      : D(String(int(0, Math.round(cap * 14_000))))
          .div(10_000)
          .toString();
  for (let i = 0; i < perKind; i++) {
    const positions = Array.from({ length: int(0, 7) }, () => amount(250_000, 60_000_000));
    const typical = median(positions);
    const inputs: FitInputs = {
      sponsorTier: pick(tiers),
      sponsorMoic:
        rnd() < 0.12
          ? null
          : D(String(int(0, 4000)))
              .div(1000)
              .toString(),
      commitment: pick(['fund', 'otherFund', 'none'] as const),
      sectorShare: share(0.25),
      sponsorShare: share(0.2),
      geographyShare: share(0.7),
      targetCommitment: rnd() < 0.12 ? null : amount(0, 150_000_000),
      medianPosition: typical === null ? null : typical.toString(),
    };
    cases.push({
      id: id++,
      kind: 'fit',
      tolerance: '1e-10',
      input: { thresholds: fitThresholds, inputs, positions },
      result: {
        scores: Object.fromEntries(
          dealFit(inputs, fitThresholds).map((m) => [m.key, str(m.score)]),
        ),
        median: str(typical),
      },
    });
  }

  // The quarter against the underwritten plan (docs/08 section 11, rules 1 to 3), last again:
  // dates on, between and outside the plan dates, missing figures, a plan in net cash, and
  // actuals on and a cent either side of the tolerance.
  const onPlanTolerance = '0.05';
  const maybe = (value: string, missing: number): string | null => (rnd() < missing ? null : value);
  for (let i = 0; i < perKind; i++) {
    const points: PlanFigures[] = [];
    let date = addDays('2019-01-01', int(0, 1500));
    for (let n = int(0, 5); n > 0; n--) {
      points.push({
        periodEnd: date,
        revenueLtm: maybe(amount(1_000_000, 4_000_000_000), 0.1),
        ebitdaLtm: maybe(amount(100_000, 900_000_000), 0.1),
        netDebt: maybe(amount(-200_000_000, 3_000_000_000), 0.1),
      });
      date = addDays(date, int(30, 500));
    }
    const first = points[0]?.periodEnd ?? '2021-06-30';
    const on = points.length > 0 && rnd() < 0.35 ? pick(points) : null;
    const edge = (planned: PlanFigures['netDebt']): string | null => {
      if (planned === null) return maybe(amount(-50_000_000, 4_000_000_000), 0.1);
      const factor = pick(['0.95', '1.05', '0.9', '1.1', '1']);
      const nudge = pick(['-0.01', '0', '0', '0.01']);
      return D(planned).times(factor).plus(nudge).toFixed(2);
    };
    const quarter: PlanFigures | null =
      rnd() < 0.05
        ? null
        : on !== null
          ? {
              periodEnd: on.periodEnd,
              revenueLtm: edge(on.revenueLtm),
              ebitdaLtm: edge(on.ebitdaLtm),
              netDebt: edge(on.netDebt),
            }
          : {
              periodEnd: addDays(first, int(-200, 2200)),
              revenueLtm: maybe(amount(-50_000_000, 4_000_000_000), 0.08),
              ebitdaLtm: maybe(amount(-50_000_000, 900_000_000), 0.08),
              netDebt: maybe(amount(-200_000_000, 3_000_000_000), 0.08),
            };
    const metrics = planMetrics(points, quarter, onPlanTolerance);
    cases.push({
      id: id++,
      kind: 'plan',
      tolerance: '1e-18',
      input: { points, quarter, onPlanTolerance },
      result: { metrics, headline: planHeadline(metrics) },
    });
  }

  // The whole comparison against the base case (docs/08 section 11, rules 4 to 6), last again:
  // equity cases and loans, held and realized, with every reason a caller can send or a plan can
  // give, a path before and after the planned exit, and planned drivers either side of zero.
  const tolerances: UnderwritingTolerances = { onPlanTolerance, irrTolerance: '0.02' };
  const rate = (minBp: number, maxBp: number): string =>
    D(String(int(minBp, maxBp)))
      .div(10_000)
      .toString();
  for (let i = 0; i < perKind; i++) {
    const entryDate = addDays('2017-01-01', int(0, 1800));
    const points: PlanFigures[] = [];
    let date = rnd() < 0.7 ? entryDate : addDays(entryDate, int(1, 400));
    for (let n = int(0, 5); n > 0; n--) {
      points.push({
        periodEnd: date,
        revenueLtm: maybe(amount(1_000_000, 4_000_000_000), 0.08),
        ebitdaLtm: maybe(amount(-5_000_000, 900_000_000), 0.08),
        netDebt: maybe(amount(-200_000_000, 3_000_000_000), 0.08),
      });
      date = addDays(date, int(120, 700));
    }
    const lastPlanDate = points[points.length - 1]?.periodEnd ?? addDays(entryDate, int(300, 2200));
    const isLoan = rnd() < 0.25;
    const base: UnderwritingCase = {
      form: isLoan ? 'credit' : 'equity',
      plannedExitDate: rnd() < 0.85 ? lastPlanDate : addDays(lastPlanDate, int(1, 300)),
      exitMultiple: isLoan ? null : rate(40_000, 180_000),
      grossMoic: rate(5_000, 40_000),
      grossIrr: rate(-2_000, 6_000),
      points: isLoan ? [] : points,
    };

    const entry: UnderwritingInputs['entry'] =
      isLoan || rnd() < 0.1
        ? null
        : {
            periodEnd: entryDate,
            ebitdaLtm: maybe(amount(-2_000_000, 900_000_000), 0.06),
            ev: maybe(amount(1_000_000, 9_000_000_000), 0.06),
            netDebt: maybe(amount(-200_000_000, 3_000_000_000), 0.06),
          };
    const figures = (periodEnd: string): PlanFigures => ({
      periodEnd,
      revenueLtm: maybe(amount(-50_000_000, 4_000_000_000), 0.08),
      ebitdaLtm: maybe(amount(-50_000_000, 900_000_000), 0.08),
      netDebt: maybe(amount(-200_000_000, 3_000_000_000), 0.08),
    });
    // The current quarter: on a plan date, between the first and the last, or anywhere at all.
    const firstPoint = points[0];
    const where = rnd();
    const currentDate =
      firstPoint === undefined || where < 0.25
        ? addDays(entryDate, int(-100, 2600))
        : where < 0.5
          ? pick(points).periodEnd
          : addDays(firstPoint.periodEnd, int(0, daysBetween(firstPoint.periodEnd, lastPlanDate)));
    const current = isLoan || rnd() < 0.08 ? null : figures(currentDate);
    const quarters: PlanFigures[] = [];
    if (!isLoan)
      for (let q = int(0, 6), at = int(0, 4); q > 0; q--, at += int(1, 4))
        quarters.push(figures(addDays(entryDate, at * 91)));
    if (current !== null && rnd() < 0.5) quarters.push(current);

    let bridge: UnderwritingInputs['bridge'] = null;
    let bridgeNotCalculable: UnderwritingInputs['bridgeNotCalculable'] = null;
    if (isLoan) bridge = null;
    else if (entry === null)
      bridgeNotCalculable = pick(['no_entry_snapshot', 'entry_snapshot_forward_dated'] as const);
    else if (current === null) bridgeNotCalculable = 'no_current_quarter';
    else if (rnd() < 0.15)
      bridgeNotCalculable = pick(['missing_figures', 'non_positive_ebitda'] as const);
    else {
      const [growth, multiple, paydown] = [part(), part(), part()];
      bridge = {
        ebitdaGrowth: wire(growth),
        multipleExpansion: wire(multiple),
        debtPaydown: wire(paydown),
        total: wire(growth.plus(multiple).plus(paydown)),
      };
    }

    const flows: { date: string; amount: string }[] = [];
    let invested = D('0');
    let distributions = D('0');
    // Half the positions are read well inside the plan, the rest up to seven years in.
    const horizon = rnd() < 0.5 ? int(30, 700) : int(30, 2600);
    if (rnd() >= 0.06) {
      const first = amount(100_000, 60_000_000);
      invested = D(first);
      flows.push({ date: entryDate, amount: `-${first}` });
      for (let n = int(0, 4); n > 0; n--) {
        const day = int(1, horizon);
        const value = amount(1, 30_000_000);
        if (rnd() < 0.3) {
          invested = invested.plus(value);
          flows.push({ date: addDays(entryDate, day), amount: `-${value}` });
        } else {
          distributions = distributions.plus(value);
          flows.push({ date: addDays(entryDate, day), amount: value });
        }
      }
    }
    const flagged = rnd() < 0.12;
    const inputs: UnderwritingInputs = {
      asOf: addDays(entryDate, horizon),
      isActive: rnd() < 0.8,
      entry,
      current,
      quarters,
      bridge,
      bridgeNotCalculable,
      flows,
      invested: flows.length === 0 ? null : wire(invested),
      distributions: flows.length === 0 ? null : wire(distributions),
      grossMoic: rnd() < 0.1 ? null : rate(0, 45_000),
      grossIrr: flagged ? null : rate(-6_000, 9_000),
      irrFlag: flagged
        ? pick(['no_valuation', 'multiple_irr', 'insufficient_flows'] as const)
        : rnd() < 0.1
          ? 'short_period'
          : null,
      yieldToMaturity: isLoan && rnd() < 0.85 ? rate(300, 2_500) : null,
    };
    cases.push({
      id: id++,
      kind: 'underwriting',
      tolerance: '1e-18',
      input: { case: base, inputs, tolerances },
      result: underwritingComparison(base, inputs, tolerances),
    });
  }

  // The mark a capital account statement gives (docs/08 section 12, rule 12.1), last again:
  // lines printed in each unit and in two, lines on, inside and beyond the tie tolerance, a line
  // not stated, a share in and out of range, and contributions on and around their tolerance.
  const tieSettings: TieTolerances = {
    rollForwardToleranceUsd: '1',
    tieToleranceByUnit: { USD_K: '2500', USD_M: '25000', USD_B: '25000000' },
  };
  const contributionsTolerancePct = '0.02';
  const moneyUnits = ['USD', 'USD_K', 'USD_M', 'USD_B'] as const;
  /** A figure as a statement prints it in a unit: cents in dollars, whole thousands, two places above. */
  const printed = (unit: string, min: number, max: number): string => {
    if (unit === 'USD') return amount(min * 1_000_000, max * 1_000_000);
    if (unit === 'USD_K') return String(int(min * 1_000, max * 1_000));
    if (unit === 'USD_M') return amount(min, max);
    return D(String(int(min * 10, max * 10)))
      .div(10_000)
      .toString();
  };
  for (let i = 0; i < perKind; i++) {
    const unit = pick(moneyUnits);
    const unitOf = (): string => (rnd() < 0.08 ? pick(moneyUnits) : unit);
    const read: [string, string][] = [];
    const line = (value: string, missing: number): string | null => {
      if (rnd() < missing) return null;
      const lineUnit = unitOf();
      read.push([value, lineUnit]);
      return toDollars(value, lineUnit).toFixed();
    };
    const begin = printed(unit, 1, 900);
    const paidIn = printed(unit, 0, 90);
    const paidOut = printed(unit, 0, 90);
    const gain = printed(unit, -90, 90);
    const beginningBalance = line(begin, 0.08);
    const contributionsInPeriod = line(paidIn, 0.08);
    const distributionsInPeriod = line(paidOut, 0.08);
    const netGainLoss = line(gain, 0.08);
    // The ending balance the four lines give, in dollars, moved by nothing, by an amount on or
    // around a tolerance, or by a lot; sometimes not stated, zero or below zero.
    const sum = toDollars(begin, unit)
      .plus(toDollars(paidIn, unit))
      .minus(toDollars(paidOut, unit))
      .plus(toDollars(gain, unit));
    const off = pick([
      '0',
      '0',
      '0',
      '1',
      '1.01',
      '2500',
      '2500.01',
      '25000',
      '25000.01',
      '-20000',
    ]);
    let endingBalance: string | null = sum.plus(off).toFixed(2);
    const how = rnd();
    if (how < 0.05) endingBalance = null;
    else if (how < 0.1) endingBalance = pick(['0.00', '-500000.00']);
    const units = read.map(([, lineUnit]) => lineUnit);
    if (endingBalance !== null) units.push(unit);
    const record = rnd() < 0.08 ? '0' : amount(100_000, 900_000_000);
    const contributionsToDate =
      rnd() < 0.15
        ? null
        : D(record === '0' ? amount(1, 900_000_000) : record)
            .times(pick(['1', '1.02', '0.98', '1.5', '0.5', '4']))
            .plus(pick(['-0.01', '0', '0', '0.01']))
            .toFixed(2);
    const part = rnd();
    const share =
      part < 0.5
        ? null
        : part < 0.85
          ? D(String(int(1, 10_000)))
              .div(10_000)
              .toString()
          : pick(['0', '-0.25', '1.0001', '1']);
    const lines: StatementLines = {
      beginningBalance,
      contributionsInPeriod,
      distributionsInPeriod,
      netGainLoss,
      endingBalance,
      contributionsToDate,
      share,
    };
    const tieToleranceUsd = statementTieTolerance(units, tieSettings);
    cases.push({
      id: id++,
      kind: 'statement_mark',
      tolerance: '0',
      input: { lines, units, record, settings: { ...tieSettings, contributionsTolerancePct } },
      result: {
        tieToleranceUsd: wire(tieToleranceUsd),
        mark: statementMark(lines, record, { tieToleranceUsd, contributionsTolerancePct }),
      },
    });
  }

  // The mark a sponsor's report gives (rules 12.2 and 12.3), last again: with an enterprise
  // value for the new quarter and without one, and every reason either rule can give.
  for (let i = 0; i < perKind; i++) {
    const referenceMark = rnd() < 0.06 ? null : rnd() < 0.04 ? '0.00' : amount(1, 900_000_000);
    const flowsSinceReferenceMark = rnd() < 0.08;
    const reference =
      rnd() < 0.06
        ? null
        : {
            ev: maybe(amount(1_000_000, 9_000_000_000), 0.06),
            netDebt: maybe(amount(-500_000_000, 6_000_000_000), 0.06),
            ebitda: maybe(amount(-20_000_000, 900_000_000), 0.08),
          };
    const ev = maybe(amount(1_000_000, 9_000_000_000), 0.45);
    const current = {
      netDebt: maybe(amount(-500_000_000, 6_000_000_000), 0.08),
      ebitda: maybe(amount(-20_000_000, 900_000_000), 0.08),
    };
    const input = {
      referenceMark,
      flowsSinceReferenceMark,
      reference,
      current: { ev, ...current },
    };
    cases.push({
      id: id++,
      kind: 'report_mark',
      tolerance: '0',
      input,
      result:
        ev === null
          ? heldMultipleMark({ referenceMark, flowsSinceReferenceMark, reference, current })
          : impliedStakeMark({
              referenceMark,
              flowsSinceReferenceMark,
              reference,
              current: { ev, netDebt: current.netDebt },
            }),
    });
  }

  // A value beside the mark on record and beside another source (rules 12.4 and 12.5), last
  // again: changes on and around the variance flag, a statement that starts on, near and off the
  // record, and every missing figure.
  const varianceFlag = '0.1';
  const beside = (base: string): string =>
    D(base)
      .times(pick(['1.1', '0.9', '1.05', '1.25', '1', '0.4']))
      .plus(pick(['-0.01', '0', '0', '0.01']))
      .toFixed(2);
  for (let i = 0; i < perKind; i++) {
    const mark = rnd() < 0.04 ? '0.00' : amount(100, 900_000_000);
    const suggested = rnd() < 0.08 ? null : mark === '0.00' ? amount(1, 900_000_000) : beside(mark);
    const tieToleranceUsd = pick(['1', '2500', '25000']);
    const statement =
      rnd() < 0.5
        ? null
        : {
            beginningBalance: maybe(
              D(mark)
                .plus(pick(['0', '0', tieToleranceUsd, `-${tieToleranceUsd}`, '0.01', '900000']))
                .plus(pick(['0', '0', '0.01', '-0.01']))
                .toFixed(2),
              0.1,
            ),
            contributionsInPeriod: maybe(amount(0, 90_000_000), 0.1),
            distributionsInPeriod: maybe(amount(0, 90_000_000), 0.1),
            tieToleranceUsd,
          };
    const comparison = {
      suggested,
      current: rnd() < 0.08 ? null : mark,
      currentIsPreviousQuarter: rnd() < 0.75,
      statement,
    };
    const other = rnd() < 0.08 || suggested === null ? null : beside(suggested);
    cases.push({
      id: id++,
      kind: 'mark_comparison',
      tolerance: '0',
      input: { comparison, other, varianceFlag },
      result: {
        comparison: markComparison({ ...comparison, varianceFlag }),
        crossCheck: sourceCrossCheck(other, suggested, varianceFlag),
      },
    });
  }
  return cases;
}

const [, , outPath, seedArg, perKindArg] = process.argv;
if (!outPath) {
  process.stderr.write('usage: generate.js <out.json> [seed] [casesPerKind]\n');
  process.exit(2);
}
const seed = Number(seedArg ?? '42');
const perKind = Number(perKindArg ?? '40');
const cases = run(seed, perKind);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ calcVersion: CALC_VERSION, seed, cases }, null, 1));
process.stdout.write(`cross-check: wrote ${cases.length} cases to ${outPath} (seed ${seed})\n`);
