import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CalcError,
  D,
  allInCoupon,
  bandIndexOf,
  capitalizePik,
  cashOnCash,
  currentYield,
  directAlpha,
  dscr,
  ebitdaMargin,
  entryCohortBands,
  entrySnapshot,
  entryStake,
  evToEbitda,
  gainByDriver,
  indexedLevel,
  interestCoverage,
  ksPme,
  latestPeriod,
  leverageThroughTranche,
  loanToValue,
  navRollForward,
  netDebtToEbitda,
  parRollForward,
  sameQuarterPriorYear,
  sinceEntryMeasures,
  takahashiAlexander,
  toDollars,
  totalGain,
  turnBands,
  unfunded,
  valueChange,
  valueCreationAttribution,
  valueCreationBridge,
  valueCreationRollup,
  weightedAverage,
  xirr,
  yieldToMaturity,
} from './index.js';
import type {
  BridgePoint,
  CashFlow,
  Decimal,
  IndexPoint,
  OperatingFigures,
  PaymentFrequency,
  PeriodRow,
  RollupPosition,
} from './index.js';

/**
 * Golden-file tests (docs/08 section 9). The same fixture files are run by the Python cross-check
 * in apps/worker-py, so a value is only ever trusted when two implementations agree on it.
 */

interface Fixture {
  id: string;
  function: string;
  note: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  tolerance: string;
}

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');
const fixtures: Fixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')) as Fixture);

function expectClose(actual: Decimal | null, expected: unknown, tolerance: string): void {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  const want = expected as string;
  expect(actual, `expected ${want} but got null`).not.toBeNull();
  const diff = actual!.minus(D(want)).abs();
  expect(diff.lte(D(tolerance)), `expected ${want}, got ${actual!.toString()}`).toBe(true);
}

const flowsOf = (v: unknown): CashFlow[] => v as CashFlow[];

describe('golden fixtures', () => {
  it('has at least the 16 cases docs/08 requires', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(16);
  });

  for (const fx of fixtures) {
    it(`${fx.id}: ${fx.note.slice(0, 80)}`, () => {
      const tol = fx.tolerance;
      switch (fx.function) {
        case 'xirr': {
          const r = xirr(flowsOf(fx.input.flows));
          expectClose(r.value, fx.expected.value, tol);
          expect(r.reason ?? null).toBe(fx.expected.reason);
          expect(r.shortPeriod).toBe(fx.expected.shortPeriod);
          break;
        }
        case 'xirr_and_unfunded': {
          const r = xirr(flowsOf(fx.input.flows));
          expectClose(r.value, fx.expected.irr, tol);
          expect(r.reason ?? null).toBe(fx.expected.reason);
          const u = unfunded(
            fx.input.commitment as string,
            fx.input.contributions as string,
            fx.input.recallableDistributions as string,
          );
          expectClose(u, fx.expected.unfunded, tol);
          break;
        }
        case 'value_change': {
          const cases = fx.input.cases as { current: string | null; prior: string | null }[];
          const results = fx.expected.results as (string | null)[];
          expect(results.length).toBe(cases.length);
          cases.forEach((c, i) => expectClose(valueChange(c.current, c.prior), results[i], tol));
          break;
        }
        case 'operating_ratios': {
          const cases = fx.input.cases as {
            ev: string;
            netDebt: string;
            ebitda: string;
            revenue: string;
          }[];
          const results = fx.expected.results as Record<string, string | null>[];
          cases.forEach((c, i) => {
            const e = results[i]!;
            expectClose(evToEbitda(c.ev, c.ebitda), e.evToEbitda, tol);
            expectClose(netDebtToEbitda(c.netDebt, c.ebitda), e.netDebtToEbitda, tol);
            expectClose(ebitdaMargin(c.ebitda, c.revenue), e.ebitdaMargin, tol);
          });
          break;
        }
        case 'same_quarter_prior_year': {
          const cases = fx.input.cases as { target: string; rows: { periodEnd: string }[] }[];
          const results = fx.expected.results as (string | null)[];
          cases.forEach((c, i) => {
            const rows: PeriodRow[] = c.rows.map((r) => ({
              ...r,
              status: 'approved',
              isEntrySnapshot: false,
            }));
            const found = sameQuarterPriorYear(rows, c.target, {
              toleranceDays: fx.input.toleranceDays as number,
            });
            expect(found?.periodEnd ?? null).toBe(results[i]);
          });
          break;
        }
        case 'latest_period': {
          const rows = fx.input.rows as PeriodRow[];
          expect(latestPeriod(rows, fx.input.reportingDate as string)?.periodEnd).toBe(
            fx.expected.periodEnd,
          );
          expect(entrySnapshot(rows)?.periodEnd).toBe(fx.expected.entrySnapshotPeriodEnd);
          break;
        }
        case 'to_dollars': {
          const cases = fx.input.cases as { value: string; unit: string }[];
          const results = fx.expected.results as string[];
          cases.forEach((c, i) => {
            const e = results[i]!;
            if (e.startsWith('THROWS:')) {
              expect(() => toDollars(c.value, c.unit)).toThrow(CalcError);
              try {
                toDollars(c.value, c.unit);
              } catch (err) {
                expect((err as CalcError).code).toBe(e.slice('THROWS:'.length));
              }
            } else {
              expect(toDollars(c.value, c.unit).eq(e)).toBe(true);
            }
          });
          break;
        }
        case 'nav_roll_forward': {
          const cases = fx.input.cases as Parameters<typeof navRollForward>[0][];
          const results = fx.expected.results as { passed: boolean; difference: string }[];
          cases.forEach((c, i) => {
            const r = navRollForward(c, fx.input.toleranceUsd as string);
            expect(r.passed).toBe(results[i]!.passed);
            expectClose(r.difference, results[i]!.difference, tol);
          });
          break;
        }
        case 'pme': {
          const input = {
            flows: flowsOf(fx.input.flows),
            nav: fx.input.nav as string,
            navDate: fx.input.navDate as string,
            index: fx.input.index as IndexPoint[],
          };
          expectClose(ksPme(input), fx.expected.ksPme, tol);
          const da = directAlpha(input);
          expectClose(da.value, fx.expected.directAlpha, tol);
          expectClose(da.irr.value, fx.expected.adjustedIrr, tol);
          const plain = xirr([...input.flows, { date: input.navDate, amount: input.nav }]);
          expectClose(plain.value, fx.expected.plainIrr, tol);
          break;
        }
        case 'attribution': {
          type P = Parameters<typeof valueCreationAttribution>[0];
          const r = valueCreationAttribution(fx.input.entry as P, fx.input.current as P);
          expect(r).not.toBeNull();
          for (const key of [
            'equityAtEntry',
            'equityCurrent',
            'revenueGrowth',
            'marginChange',
            'multipleChange',
            'netDebtChange',
            'total',
          ] as const) {
            expectClose(r![key], fx.expected[key], tol);
          }
          expect(
            r!.revenueGrowth
              .plus(r!.marginChange)
              .plus(r!.multipleChange)
              .plus(r!.netDebtChange)
              .eq(r!.total),
          ).toBe(true);
          const nc = fx.input.nullCase as { entry: P; current: P };
          expect(valueCreationAttribution(nc.entry, nc.current)).toBe(fx.expected.nullCase);
          break;
        }
        case 'value_creation_bridge': {
          const cases = fx.input.cases as { entry: BridgePoint; current: BridgePoint }[];
          const results = fx.expected.results as Record<string, unknown>[];
          expect(results.length).toBe(cases.length);
          cases.forEach((c, i) => {
            const e = results[i]!;
            const r = valueCreationBridge(c.entry, c.current);
            expect(r.reason ?? null).toBe(e.reason);
            if (e.reason !== null) {
              expect(r.value).toBeNull();
              return;
            }
            const b = r.value!;
            for (const key of [
              'equityAtEntry',
              'equityCurrent',
              'ebitdaGrowth',
              'multipleExpansion',
              'debtPaydown',
              'total',
              'revenueGrowth',
              'marginChange',
            ] as const) {
              expectClose(b[key], e[key], tol);
            }
            // The parts are the whole, to the last place: no tolerance here.
            expect(b.ebitdaGrowth.plus(b.multipleExpansion).plus(b.debtPaydown).eq(b.total)).toBe(
              true,
            );
            expect(b.equityCurrent.minus(b.equityAtEntry).eq(b.total)).toBe(true);
            if (b.revenueGrowth !== null && b.marginChange !== null)
              expect(b.revenueGrowth.plus(b.marginChange).eq(b.ebitdaGrowth)).toBe(true);
            const shares = e.shares as Record<string, string> | null;
            if (shares === null) expect(b.shares).toBeNull();
            else {
              expect(b.shares).not.toBeNull();
              for (const key of ['ebitdaGrowth', 'multipleExpansion', 'debtPaydown'] as const)
                expectClose(b.shares![key], shares[key], tol);
            }
          });
          break;
        }
        case 'since_entry_measures': {
          const cases = fx.input.cases as { entry: OperatingFigures; current: OperatingFigures }[];
          const results = fx.expected.results as Record<string, string | null>[];
          expect(results.length).toBe(cases.length);
          const equityOf = (p: OperatingFigures): Decimal | null =>
            p.ev === null || p.netDebt === null ? null : D(p.ev).minus(D(p.netDebt));
          cases.forEach((c, i) => {
            const e = results[i]!;
            const m = sinceEntryMeasures(c.entry, c.current);
            for (const key of [
              'ebitdaGrowth',
              'evGrowth',
              'equityValueGrowth',
              'multipleChange',
              'netLeverageChange',
              'netDebtChange',
            ] as const) {
              expectClose(m[key], e[key], tol);
            }
            expectClose(indexedLevel(c.current.ebitda, c.entry.ebitda), e.ebitdaIndex, tol);
            expectClose(indexedLevel(c.current.ev, c.entry.ev), e.evIndex, tol);
            expectClose(
              indexedLevel(equityOf(c.current), equityOf(c.entry)),
              e.equityValueIndex,
              tol,
            );
          });
          break;
        }
        case 'gain_by_driver': {
          const bridges = fx.input.bridges as Record<
            string,
            { entry: BridgePoint; current: BridgePoint }
          >;
          const cases = fx.input.cases as {
            bridge: string;
            distributions: string;
            nav: string;
            invested: string;
          }[];
          const results = fx.expected.results as Record<string, string | null>[];
          expect(results.length).toBe(cases.length);
          cases.forEach((c, i) => {
            const e = results[i]!;
            const points = bridges[c.bridge]!;
            const bridge = valueCreationBridge(points.entry, points.current).value!;
            const gain = totalGain(c.distributions, c.nav, c.invested);
            expectClose(gain, e.gain, tol);
            const r = gainByDriver(gain, c.invested, bridge);
            if ('split' in e) {
              expect(r.value).toBeNull();
              expect(r.reason).toBe(e.reason);
              return;
            }
            expect(r.reason).toBeUndefined();
            const split = r.value!;
            for (const key of [
              'stake',
              'ebitdaGrowth',
              'multipleExpansion',
              'debtPaydown',
              'other',
              'revenueGrowth',
              'marginChange',
            ] as const) {
              expectClose(split[key], e[key], tol);
            }
            expectClose(entryStake(c.invested, bridge.equityAtEntry), e.stake, tol);
            // The four parts are the gain, to the last place: no tolerance here.
            expect(
              split.ebitdaGrowth
                .plus(split.multipleExpansion)
                .plus(split.debtPaydown)
                .plus(split.other)
                .eq(gain!),
            ).toBe(true);
          });
          break;
        }
        case 'value_creation_rollup': {
          const input = fx.input as {
            asOf: string;
            edges: { multiple: string[]; leverage: string[] };
            positions: (RollupPosition & { id: string })[];
            cases: string[][];
          };
          const results = fx.expected.results as unknown[];
          expect(results.length).toBe(input.cases.length);
          const bands = {
            byEntryMultiple: entryCohortBands(input.edges.multiple),
            byEntryLeverage: entryCohortBands(input.edges.leverage),
          };
          input.cases.forEach((ids, i) => {
            const rows = input.positions.filter((p) => ids.includes(p.id));
            expect(rows.length).toBe(ids.length);
            // The figures as they travel: the golden strings, to the letter.
            expect(valueCreationRollup(rows, bands, input.asOf), `case ${i + 1}`).toEqual(
              results[i],
            );
          });
          break;
        }
        case 'entry_bands': {
          const sets = fx.input.bandSets as { edges: string[]; values: string[] }[];
          const expected = fx.expected.bandSets as (
            string | { labels: string[]; indexes: number[] }
          )[];
          expect(expected.length).toBe(sets.length);
          sets.forEach((set, i) => {
            const e = expected[i]!;
            if (typeof e === 'string') {
              const code = e.slice('THROWS:'.length);
              for (const run of [
                (): unknown => turnBands(set.edges),
                (): unknown => bandIndexOf('9', set.edges),
              ]) {
                expect(run).toThrow(CalcError);
                try {
                  run();
                } catch (err) {
                  expect((err as CalcError).code).toBe(code);
                }
              }
              return;
            }
            const bands = turnBands(set.edges);
            expect(bands.map((b) => b.label)).toEqual(e.labels);
            expect(bands.map((b) => b.index)).toEqual(e.labels.map((_, n) => n));
            expect(set.values.map((v) => bandIndexOf(v, set.edges))).toEqual(e.indexes);
          });
          const averages = fx.input.weightedAverages as { weight: string; value: string }[][];
          const wanted = fx.expected.weightedAverages as (string | null)[];
          expect(wanted.length).toBe(averages.length);
          averages.forEach((items, i) => expectClose(weightedAverage(items), wanted[i], tol));
          break;
        }
        case 'credit_yield': {
          type Terms = Parameters<typeof allInCoupon>[0];
          expectClose(allInCoupon(fx.input.terms as Terms), fx.expected.allInCoupon, tol);
          expectClose(
            allInCoupon(fx.input.floorCase as Terms),
            fx.expected.allInCouponFloored,
            tol,
          );
          const y = fx.input.ytm as Parameters<typeof yieldToMaturity>[0];
          expectClose(
            currentYield(y.cashCoupon, y.par, y.fairValue),
            fx.expected.currentYield,
            tol,
          );
          const r = yieldToMaturity(y);
          expectClose(r.value, fx.expected.ytm, tol);
          expectClose(r.parAtMaturity, fx.expected.parAtMaturity, tol);
          expect(r.flows.length).toBe(fx.expected.flowCount);
          break;
        }
        case 'pik_roll': {
          let par = D(fx.input.par as string);
          for (let q = 0; q < (fx.input.quarters as number); q++) {
            par = capitalizePik(
              par,
              fx.input.pikCoupon as string,
              fx.input.frequency as PaymentFrequency,
            );
          }
          expectClose(par, fx.expected.parAfter, tol);
          expectClose(
            cashOnCash(fx.input.cashInterestReceived as string, fx.input.averageFunded as string),
            fx.expected.cashOnCash,
            tol,
          );
          expect(
            parRollForward(fx.input.rollForward as Parameters<typeof parRollForward>[0]).passed,
          ).toBe(fx.expected.rollForwardPassed);
          break;
        }
        case 'credit_ratios': {
          const cases = fx.input.cases as Record<string, string>[];
          const results = fx.expected.results as Record<string, string | null>[];
          cases.forEach((c, i) => {
            const e = results[i]!;
            expectClose(interestCoverage(c.ebitda!, c.cashInterest!), e.interestCoverage, tol);
            expectClose(
              leverageThroughTranche(c.netDebtThroughTranche!, c.ebitda!),
              e.leverageThroughTranche,
              tol,
            );
            expectClose(loanToValue(c.netDebtThroughTranche!, c.ev!), e.ltv, tol);
            expectClose(
              dscr({
                ebitdaLtm: c.ebitda!,
                cashTaxes: c.cashTaxes!,
                maintenanceCapex: c.maintenanceCapex!,
                cashInterestLtm: c.cashInterest!,
                scheduledPrincipalLtm: c.scheduledPrincipal!,
              }),
              e.dscr,
              tol,
            );
          });
          break;
        }
        case 'takahashi_alexander': {
          const rows = takahashiAlexander(
            fx.input as unknown as Parameters<typeof takahashiAlexander>[0],
          );
          const expected = fx.expected.rows as Record<string, string | number>[];
          expect(rows.length).toBe(expected.length);
          rows.forEach((r, i) => {
            const e = expected[i]!;
            expect(r.year).toBe(e.year);
            expectClose(r.contribution, e.contribution, tol);
            expectClose(r.distribution, e.distribution, tol);
            expectClose(r.nav, e.nav, tol);
            expectClose(r.unfunded, e.unfunded, tol);
          });
          break;
        }
        default:
          throw new Error(`fixture ${fx.id} uses an unknown function ${fx.function}`);
      }
    });
  }
});
