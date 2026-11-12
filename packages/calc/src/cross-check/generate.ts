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
import { addDays } from '../dates.js';
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
import type { RollupPosition } from '../rollup.js';
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
