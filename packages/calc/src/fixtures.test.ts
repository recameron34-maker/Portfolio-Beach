import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CalcError,
  D,
  allInCoupon,
  capitalizePik,
  cashOnCash,
  currentYield,
  directAlpha,
  dscr,
  ebitdaMargin,
  entrySnapshot,
  evToEbitda,
  interestCoverage,
  ksPme,
  latestPeriod,
  leverageThroughTranche,
  loanToValue,
  navRollForward,
  netDebtToEbitda,
  parRollForward,
  sameQuarterPriorYear,
  takahashiAlexander,
  toDollars,
  unfunded,
  valueCreationAttribution,
  xirr,
  yieldToMaturity,
} from './index.js';
import type { CashFlow, Decimal, IndexPoint, PaymentFrequency, PeriodRow } from './index.js';

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
