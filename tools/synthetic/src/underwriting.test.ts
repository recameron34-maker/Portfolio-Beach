import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { addMonths, daysBetween } from '@pb/calc';
import { loadSyntheticDataset, withUserContext } from '@pb/db';
import { createTestDb } from '@pb/db/testing';
import definitions from '../../../config/definitions.json' with { type: 'json' };
import { generateDataset } from './generate.js';
import type { GeneratedDataset } from './generate.js';
import { investedCost } from './lookthrough-extract.js';
import { QUARTERLY_REPORTING_DEAL_TYPES } from './preview-book.js';
import { DATA_SCENARIOS } from './profiles.js';
import { underwritingTolerances } from './settings.js';
import {
  UNDERWRITING_CREDIT_DEAL_TYPE,
  UNDERWRITING_EXISTING_SCENARIOS,
  UNDERWRITING_GROWTH_SHIFT,
  UNDERWRITING_IRR_SHIFT,
  UNDERWRITING_LOSS_RATE,
  UNDERWRITING_MIN_HELD_DAYS,
  UNDERWRITING_NONE_EVERY,
  UNDERWRITING_PLAN_YEARS,
  UNDERWRITING_SCENARIOS,
  irrOfMoic,
  seededComparison,
  underwritingInputsOf,
  underwrittenYieldOf,
} from './underwriting.js';
import type { UnderwritingCaseRow } from './underwriting.js';
import { verifyDataset } from './verify.js';

/**
 * The SHA-256 of the dataset as it was generated before the base cases existed (seed 42), taken
 * on the commit before they were added. A change to the generator that is meant to move a seeded
 * value changes these on purpose; the base cases themselves must never be the reason.
 */
const BEFORE_BASE_CASES = {
  small: '3a25fe22d770fa084dd1354fec2f1ebafe28c163868235b1e0b15db72111ea85',
  default: '5310a10134a9738e04cd89566a2925dc54fe00343029439a7b50e9769ab9f06d',
} as const;

/**
 * The SHA-256 of the equity and continuation vehicle cases (seed 42) as they were generated on
 * the commit before the loans got theirs. The loans draw from a stream of their own and follow
 * the equity cases in the list, so adding them must never be the reason these change.
 */
const BEFORE_LOAN_CASES = {
  small: '54e5573dbbfb6fe3c230c97afa44de9033046cc1d4e0134ae2194e5a49438020',
  default: '9b9eee0d75f20e7eb3d014764e4cf64b14c726f15427826990e7995eaa24acb5',
} as const;

const tolerances = underwritingTolerances();
const small = generateDataset({ profile: 'small', seed: 42 });
const full = generateDataset({ profile: 'default', seed: 42 });

const casesOf = (d: GeneratedDataset, investmentId: string): UnderwritingCaseRow[] =>
  d.underwritingCases.filter((c) => c.investmentId === investmentId);
const scenarioCases = (d: GeneratedDataset, scenario: string): UnderwritingCaseRow[] => {
  const ids = d.scenarios[scenario] ?? [];
  expect(ids, scenario).toHaveLength(1);
  return casesOf(d, ids[0] ?? '');
};
const investmentOf = (d: GeneratedDataset, id: string) => d.investments.find((i) => i.id === id)!;
const snapshotOf = (d: GeneratedDataset, investmentId: string) =>
  d.quarterlyPerformance.find((q) => q.investmentId === investmentId && q.isEntrySnapshot);
const taggedIds = (d: GeneratedDataset, scenarios: readonly string[]): Set<string> =>
  new Set(scenarios.flatMap((s) => d.scenarios[s] ?? []));
/** Positions that can carry a case: equity or CV, with an approved entry snapshot of positive EBITDA and equity value. */
const eligible = (d: GeneratedDataset) =>
  d.investments.filter((i) => {
    const s = snapshotOf(d, i.id);
    return (
      QUARTERLY_REPORTING_DEAL_TYPES.includes(i.dealType) &&
      s?.status === 'record_status.approved' &&
      Number(s.ebitdaLtm) > 0 &&
      Number(s.ev) - Number(s.netDebt) > 0
    );
  });

describe.each([
  ['small', small],
  ['default', full],
] as const)('the underwritten base cases, %s profile (docs/14 section 12)', (profile, d) => {
  it('moved no existing value: without them the dataset is byte for byte what it was before', () => {
    const { underwritingCases: _cases, scenarios, ...rest } = d;
    const before = {
      ...rest,
      scenarios: Object.fromEntries(
        Object.entries(scenarios).filter(([tag]) => !tag.startsWith('underwriting_')),
      ),
    };
    expect(createHash('sha256').update(JSON.stringify(before)).digest('hex')).toBe(
      BEFORE_BASE_CASES[profile],
    );
    // The tags sit in the scenario log only: no investment carries one.
    for (const i of d.investments)
      expect(i.scenarioTags.filter((t) => t.startsWith('underwriting_'))).toEqual([]);
  });

  it('the loans moved no equity case: those are what they were, and come first', () => {
    const equity = d.underwritingCases.filter((c) => c.form === 'equity');
    expect(createHash('sha256').update(JSON.stringify(equity)).digest('hex')).toBe(
      BEFORE_LOAN_CASES[profile],
    );
    expect(d.underwritingCases.slice(0, equity.length)).toEqual(equity);
  });

  it('passes the dataset check and carries every scenario on one position', () => {
    expect(verifyDataset(d).problems).toEqual([]);
    for (const scenario of UNDERWRITING_SCENARIOS) {
      expect(DATA_SCENARIOS, scenario).toContain(scenario);
      expect(d.scenarios[scenario], scenario).toHaveLength(1);
    }
    // One position, one scenario: none carries two, and none of them is behind a wall.
    const ids = UNDERWRITING_SCENARIOS.map((s) => d.scenarios[s]?.[0]);
    expect(new Set(ids).size).toBe(UNDERWRITING_SCENARIOS.length);
    const walled = new Set(d.walls.flatMap((w) => w.records.map((r) => r.entityId)));
    for (const id of ids) expect(walled.has(id ?? '')).toBe(false);
  });

  it('gives four eligible positions in five an equity case, always the four existing scenario positions', () => {
    const hosts = eligible(d);
    const withCase = hosts.filter((i) => casesOf(d, i.id).length > 0);
    const forced = taggedIds(d, UNDERWRITING_EXISTING_SCENARIOS);
    expect(forced.size).toBe(UNDERWRITING_EXISTING_SCENARIOS.length);
    for (const id of forced) {
      const versions = casesOf(d, id);
      expect(versions.map((c) => [c.version, c.state])).toEqual([[1, 'Confirmed']]);
    }
    // Every fifth eligible position has none, unless it is one of the four.
    hosts.forEach((i, position) => {
      const none = position % UNDERWRITING_NONE_EVERY === UNDERWRITING_NONE_EVERY - 1;
      expect(casesOf(d, i.id).length > 0, i.investmentNumber).toBe(!none || forced.has(i.id));
    });
    expect(withCase.length / hosts.length).toBeGreaterThanOrEqual(0.8);
    expect(withCase.length / hosts.length).toBeLessThan(0.9);
    // A held position with no case is there for the card with nothing recorded.
    expect(hosts.some((i) => i.isActive && casesOf(d, i.id).length === 0)).toBe(true);
    // An equity case sits on an eligible equity or continuation vehicle position, a loan's case
    // on a private credit position, and no other position carries one.
    for (const c of d.underwritingCases) {
      const { dealType } = investmentOf(d, c.investmentId);
      if (c.form === 'equity') {
        expect(QUARTERLY_REPORTING_DEAL_TYPES).toContain(dealType);
        expect(hosts.some((i) => i.id === c.investmentId)).toBe(true);
        expect([c.underwrittenYield, c.annualLossRate]).toEqual([null, null]);
      } else expect(dealType).toBe(UNDERWRITING_CREDIT_DEAL_TYPE);
    }
  });

  it('gives every loan the case it was underwritten on: its yield from its terms, a loss rate, and the IRR and MOIC they leave', () => {
    const loans = d.investments.filter((i) => i.dealType === UNDERWRITING_CREDIT_DEAL_TYPE);
    expect(loans.length).toBeGreaterThan(0);
    const user = (externalId: string) => d.users.find((u) => u.externalId === externalId)!.id;
    for (const loan of loans) {
      const terms = d.creditTerms.find((t) => t.investmentId === loan.id)!;
      const versions = casesOf(d, loan.id);
      expect(
        versions.map((c) => [c.version, c.form, c.state]),
        loan.investmentNumber,
      ).toEqual([[1, 'credit', 'Confirmed']]);
      const c = versions[0]!;
      // Dated at our entry; the expected repayment is the maturity of the loan.
      expect([c.caseDate, c.plannedExitDate]).toEqual([loan.entryDate, terms.maturityDate]);
      expect([c.exitMultiple, c.points]).toEqual([null, []]);
      const years = daysBetween(loan.entryDate, terms.maturityDate) / 365;
      const underwritten = Number(c.underwrittenYield);
      const lossRate = Number(c.annualLossRate);
      // The cash coupon, the PIK coupon and the discount spread over the years to maturity.
      expect(underwritten).toBeCloseTo(
        Number(terms.cashCoupon) + Number(terms.pikCoupon) + Number(terms.oid) / years,
        4,
      );
      expect(underwritten).toBe(underwrittenYieldOf(terms, years));
      expect(lossRate).toBeGreaterThanOrEqual(UNDERWRITING_LOSS_RATE.min);
      expect(lossRate).toBeLessThanOrEqual(UNDERWRITING_LOSS_RATE.max);
      expect(Number(c.grossIrr)).toBeCloseTo(underwritten - lossRate, 4);
      expect(Number(c.grossMoic)).toBeCloseTo(1 + Number(c.grossIrr) * years, 4);
      for (const figure of [c.underwrittenYield, c.annualLossRate, c.grossIrr, c.grossMoic])
        expect(figure).toMatch(/^\d+\.\d{4}$/);
      expect([c.enteredBy, c.confirmedBy]).toEqual([user('deal.one'), user('deal.two')]);
      expect(c.sourceNote).toMatch(/held in the deal folder$/);
      expect([c.note, c.revisionReason, c.withdrawnReason]).toEqual([null, null, null]);
    }
    // No loan is behind a wall in the seed, so the two people above are the ordinary pair.
    const walled = new Set(d.walls.flatMap((w) => w.records.map((r) => r.entityId)));
    expect(loans.some((loan) => walled.has(loan.id))).toBe(false);
    // The loss rates are drawn loan by loan, not one figure for all.
    if (loans.length > 1)
      expect(
        new Set(loans.map((loan) => casesOf(d, loan.id)[0]?.annualLossRate)).size,
      ).toBeGreaterThan(1);
  });

  it('builds an ordinary case at entry: the snapshot, then its anniversaries for four to six years inside the documented bands', () => {
    const scenario = taggedIds(d, UNDERWRITING_SCENARIOS);
    const ordinary = d.underwritingCases.filter(
      (c) => c.form === 'equity' && !scenario.has(c.investmentId),
    );
    expect(ordinary.length).toBeGreaterThan(4);
    const within = (value: number, low: number, high: number, slack: number): boolean =>
      value >= low - slack && value <= high + slack;
    for (const c of ordinary) {
      const investment = investmentOf(d, c.investmentId);
      const snapshot = snapshotOf(d, c.investmentId)!;
      const name = investment.investmentNumber;
      expect([c.version, c.state, c.caseDate], name).toEqual([
        1,
        'Confirmed',
        investment.entryDate,
      ]);
      // Point 0 is the entry snapshot as it is on record.
      expect(c.points[0], name).toMatchObject({
        periodEnd: snapshot.periodEnd,
        revenueLtm: snapshot.revenueLtm,
        ebitdaLtm: snapshot.ebitdaLtm,
        netDebt: snapshot.netDebt,
      });
      const years = c.points.length - 1;
      expect(years, name).toBeGreaterThanOrEqual(UNDERWRITING_PLAN_YEARS.min);
      expect(years, name).toBeLessThanOrEqual(UNDERWRITING_PLAN_YEARS.max);
      c.points.forEach((p, year) =>
        expect(p.periodEnd, name).toBe(addMonths(snapshot.periodEnd, 12 * year)),
      );
      expect(c.plannedExitDate, name).toBe(c.points[years]?.periodEnd);
      for (let year = 1; year <= years; year++) {
        const [before, now] = [c.points[year - 1]!, c.points[year]!];
        const growth = Number(now.revenueLtm) / Number(before.revenueLtm) - 1;
        const margin = (p: typeof now): number => Number(p.ebitdaLtm) / Number(p.revenueLtm);
        const paydown = 1 - Number(now.netDebt) / Number(before.netDebt);
        expect(within(growth, 0.04, 0.12, 1e-6), `${name} revenue growth ${growth}`).toBe(true);
        expect(
          within(margin(now) - margin(before), 0, 0.015, 1e-6),
          `${name} margin step ${margin(now) - margin(before)}`,
        ).toBe(true);
        expect(within(paydown, 0.04, 0.1, 1e-6), `${name} paydown ${paydown}`).toBe(true);
      }
      // The exit multiple within a turn of the entry multiple; the MOIC from the exit equity
      // over the entry equity; the IRR the MOIC stands for from our entry to the planned exit.
      const entryMultiple = Number(snapshot.ev) / Number(snapshot.ebitdaLtm);
      expect(Math.abs(Number(c.exitMultiple) - entryMultiple), name).toBeLessThanOrEqual(1.006);
      const exit = c.points[years]!;
      const moic =
        (Number(c.exitMultiple) * Number(exit.ebitdaLtm) - Number(exit.netDebt)) /
        (Number(snapshot.ev) - Number(snapshot.netDebt));
      expect(c.grossMoic, name).toBe(moic.toFixed(4));
      expect(c.grossIrr, name).toBe(
        irrOfMoic(Number(c.grossMoic), investment.entryDate, c.plannedExitDate),
      );
      expect(c.sourceNote, name).toBe('Sponsor base case model at entry, held in the deal folder');
      expect([c.note, c.revisionReason, c.withdrawnReason], name).toEqual([null, null, null]);
    }
  });

  it('has two people on every confirmed case, inside the wall of a walled position, at times taken from the dataset', () => {
    const user = (externalId: string) => d.users.find((u) => u.externalId === externalId)!.id;
    const walled = taggedIds(d, ['walled_deal']);
    for (const c of d.underwritingCases) {
      const investment = investmentOf(d, c.investmentId);
      expect(c.confirmedBy).not.toBe(c.enteredBy);
      if (walled.has(c.investmentId)) {
        // deal.one and deal.two are outside the wall: its members recorded and confirmed it.
        expect([c.enteredBy, c.confirmedBy]).toEqual([user('deal.three'), user('head.one')]);
      } else {
        expect([user('deal.one'), user('deal.two')]).toContain(c.enteredBy);
        expect([user('deal.one'), user('deal.two'), null]).toContain(c.confirmedBy);
      }
      expect(c.enteredAt).toMatch(/^\d{4}-\d{2}-\d{2}T10:00:00Z$/);
      expect(c.enteredAt >= `${investment.entryDate}T00:00:00Z`).toBe(true);
      expect(c.enteredAt <= `${d.asOf}T23:59:59Z`).toBe(true);
      if (c.confirmedAt !== null) {
        expect(c.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T15:00:00Z$/);
        expect(c.confirmedAt > c.enteredAt).toBe(true);
        expect(c.confirmedAt <= `${d.asOf}T23:59:59Z`).toBe(true);
      }
    }
    expect(d.underwritingCases.some((c) => walled.has(c.investmentId))).toBe(true);
  });

  it('underwriting_ahead, underwriting_on_plan and underwriting_behind read as tagged, by the shift the plan was given', () => {
    for (const [scenario, status, sign] of [
      ['underwriting_ahead', 'ahead', -1],
      ['underwriting_on_plan', 'on_plan', 0],
      ['underwriting_behind', 'behind', 1],
    ] as const) {
      const [c, ...others] = scenarioCases(d, scenario);
      expect(others, scenario).toEqual([]);
      const investment = investmentOf(d, c!.investmentId);
      expect(investment.isActive, scenario).toBe(true);
      const inputs = underwritingInputsOf(d, investment);
      const comparison = seededComparison(d, c!, tolerances);
      expect([comparison.headline, comparison.returns.irrStatus], scenario).toEqual([
        status,
        status,
      ]);
      // Held two years or more, and the plan reaches past the as-of date.
      const held = daysBetween(inputs.entry!.periodEnd, inputs.current!.periodEnd);
      expect(held, scenario).toBeGreaterThanOrEqual(UNDERWRITING_MIN_HELD_DAYS);
      expect(c!.plannedExitDate > d.asOf, scenario).toBe(true);
      // The plan's EBITDA grows at the position's own annualised rate, shifted, at the entry margin.
      const own =
        Math.pow(Number(inputs.current!.ebitdaLtm) / Number(inputs.entry!.ebitdaLtm), 365 / held) -
        1;
      const [p0, p1] = [c!.points[0]!, c!.points[1]!];
      expect(Number(p1.ebitdaLtm) / Number(p0.ebitdaLtm) - 1, scenario).toBeCloseTo(
        own + sign * UNDERWRITING_GROWTH_SHIFT,
        6,
      );
      expect(Number(p1.ebitdaLtm) / Number(p1.revenueLtm), scenario).toBeCloseTo(
        Number(p0.ebitdaLtm) / Number(p0.revenueLtm),
        6,
      );
      // The underwritten IRR is the gross IRR, shifted; the IRR gap is the shift the other way.
      expect(Number(c!.grossIrr), scenario).toBeCloseTo(
        Number(comparison.returns.grossIrr) + sign * UNDERWRITING_IRR_SHIFT,
        4,
      );
      expect(Number(comparison.returns.irrGap), scenario).toBeCloseTo(
        -sign * UNDERWRITING_IRR_SHIFT,
        4,
      );
      // Its MOIC is the one that IRR stands for from our entry to the planned exit.
      expect(c!.grossIrr, scenario).toBe(
        irrOfMoic(Number(c!.grossMoic), investment.entryDate, c!.plannedExitDate),
      );
    }
  });

  it('underwriting_past_exit, underwriting_gap and underwriting_net_cash show their reason at the current quarter', () => {
    const [ended] = scenarioCases(d, 'underwriting_past_exit');
    const past = seededComparison(d, ended!, tolerances);
    expect(investmentOf(d, ended!.investmentId).isActive).toBe(true);
    expect(ended!.plannedExitDate < past.quarter!).toBe(true);
    expect(past.metrics.map((m) => m.notCalculable)).toEqual([
      'past_plan_end',
      'past_plan_end',
      'past_plan_end',
    ]);
    expect([past.headline, past.returns.pathNotCalculable]).toEqual([null, 'past_plan_end']);
    // The IRR is still judged: it needs no plan date.
    expect(past.returns.irrStatus).not.toBeNull();

    const [gapped] = scenarioCases(d, 'underwriting_gap');
    const gap = seededComparison(d, gapped!, tolerances);
    const missing = gapped!.points.filter((p) => p.netDebt === null);
    expect(missing).toHaveLength(1);
    // A point between the first and the last: the entry figures and the exit stay whole.
    const at = gapped!.points.indexOf(missing[0]!);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(gapped!.points.length - 1);
    expect(gap.metrics.find((m) => m.metric === 'net_debt')).toMatchObject({
      plan: null,
      status: null,
      notCalculable: 'missing_plan_figure',
    });
    expect(gap.metrics.find((m) => m.metric === 'ebitda')?.status).not.toBeNull();
    expect(gap.valueCreation?.planned).not.toBeNull();

    const [cash] = scenarioCases(d, 'underwriting_net_cash');
    const netCash = seededComparison(d, cash!, tolerances);
    const netDebt = netCash.metrics.find((m) => m.metric === 'net_debt')!;
    expect(netDebt.notCalculable).toBe('non_positive_plan');
    expect(Number(netDebt.plan)).toBeLessThan(0);
    // The variance in money is still there; only the percent and the status have no base.
    expect(netDebt.variance).not.toBeNull();
    expect([netDebt.variancePct, netDebt.status]).toEqual([null, null]);
    expect(Number(cash!.points[0]!.netDebt)).toBeGreaterThan(0);
    expect(Number(cash!.points[cash!.points.length - 1]!.netDebt)).toBeLessThan(0);
  });

  it('underwriting_reunderwritten, underwriting_corrected, underwriting_draft and underwriting_withdrawn hold the versions they name', () => {
    const [entry, later, ...more] = scenarioCases(d, 'underwriting_reunderwritten');
    expect(more).toEqual([]);
    expect([entry!.version, entry!.state, later!.version, later!.state]).toEqual([
      1,
      'Confirmed',
      2,
      'Confirmed',
    ]);
    expect(later!.caseDate > entry!.caseDate).toBe(true);
    expect(later!.plannedExitDate > later!.caseDate).toBe(true);
    expect(later!.revisionReason).toMatch(/^Re-underwritten/);
    // It starts from the approved quarter on its own date, as that quarter is on record.
    const quarter = d.quarterlyPerformance.find(
      (q) =>
        q.investmentId === later!.investmentId &&
        !q.isEntrySnapshot &&
        q.periodEnd === later!.caseDate,
    )!;
    expect(later!.points[0]).toMatchObject({
      periodEnd: quarter.periodEnd,
      revenueLtm: quarter.revenueLtm,
      ebitdaLtm: quarter.ebitdaLtm,
      netDebt: quarter.netDebt,
    });
    // Both compare: the entry case and the pick.
    expect(seededComparison(d, entry!, tolerances).quarter).toBe(
      seededComparison(d, later!, tolerances).quarter,
    );

    const [wrong, right, ...extra] = scenarioCases(d, 'underwriting_corrected');
    expect(extra).toEqual([]);
    expect([wrong!.state, right!.state, right!.version]).toEqual(['Superseded', 'Confirmed', 2]);
    expect(right!.caseDate).toBe(wrong!.caseDate);
    expect(Number(wrong!.exitMultiple) - Number(right!.exitMultiple)).toBeCloseTo(3, 6);
    expect(right!.revisionReason).toBe(
      `The exit multiple was entered as ${wrong!.exitMultiple}; the sponsor model shows ${right!.exitMultiple}`,
    );
    // The same plan under new ids, and the two people swapped: each version has a second person.
    expect(right!.points.map(({ id: _id, ...p }) => p)).toEqual(
      wrong!.points.map(({ id: _id, ...p }) => p),
    );
    expect(right!.points.map((p) => p.id)).not.toEqual(wrong!.points.map((p) => p.id));
    expect([right!.enteredBy, right!.confirmedBy]).toEqual([wrong!.confirmedBy, wrong!.enteredBy]);
    expect(right!.enteredAt > wrong!.confirmedAt!).toBe(true);

    const drafts = scenarioCases(d, 'underwriting_draft');
    expect(drafts.map((c) => [c.version, c.state, c.confirmedBy, c.confirmedAt])).toEqual([
      [1, 'Draft', null, null],
    ]);
    // Entered by deal.one last week with its source, so deal.two can confirm it as it stands.
    expect(drafts[0]!.enteredBy).toBe(d.users.find((u) => u.externalId === 'deal.one')!.id);
    expect(drafts[0]!.sourceNote).not.toBeNull();
    expect(daysBetween(drafts[0]!.enteredAt.slice(0, 10), d.asOf)).toBe(6);

    const retired = scenarioCases(d, 'underwriting_withdrawn');
    expect(retired.map((c) => [c.version, c.state])).toEqual([[1, 'Withdrawn']]);
    expect(retired[0]!.confirmedBy).not.toBeNull();
    expect(retired[0]!.withdrawnReason).toBe(
      'Confirmed against the model of another company; to be entered again',
    );
  });

  it('keeps ids unique and every case of a position in version order', () => {
    const ids = [
      ...d.underwritingCases.map((c) => c.id),
      ...d.underwritingCases.flatMap((c) => c.points.map((p) => p.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    const everyId = new Set([
      ...d.investments.map((i) => i.id),
      ...d.quarterlyPerformance.map((q) => q.id),
      ...d.valuations.map((v) => v.id),
    ]);
    for (const id of ids) expect(everyId.has(id)).toBe(false);
    const seen = new Map<string, number>();
    for (const c of d.underwritingCases) {
      expect(c.version).toBe((seen.get(c.investmentId) ?? 0) + 1);
      seen.set(c.investmentId, c.version);
    }
  });
});

describe('the base cases beside the four existing scenarios (small profile)', () => {
  const only = (scenario: string): UnderwritingCaseRow => scenarioCases(small, scenario)[0]!;

  it('forward_entry_snapshot: the plan starts after the as-of date, so nothing is compared yet', () => {
    const c = only('forward_entry_snapshot');
    expect(c.points[0]!.periodEnd > small.asOf).toBe(true);
    expect(c.caseDate < small.asOf).toBe(true);
    const comparison = seededComparison(small, c, tolerances);
    expect(comparison.metrics.map((m) => m.notCalculable)).toEqual([
      'before_plan_start',
      'before_plan_start',
      'before_plan_start',
    ]);
    expect(comparison.valueCreation?.notCalculable).toBe('entry_snapshot_forward_dated');
  });

  it('negative_ebitda: the company has no bridge, and the card says so', () => {
    const comparison = seededComparison(small, only('negative_ebitda'), tolerances);
    expect(comparison.valueCreation).toMatchObject({
      actual: null,
      progress: null,
      notCalculable: 'non_positive_ebitda',
    });
  });

  it("period_end_shift: the current quarter is the sponsor's own period end, three days before the quarter end", () => {
    const comparison = seededComparison(small, only('period_end_shift'), tolerances);
    expect(comparison.quarter).toBe('2025-06-27');
  });
});

describe('what the comparison of a seeded position is worked out from', () => {
  it('reads the entry snapshot, the current quarter, the flows and the returns as the position has them', () => {
    const [id] = small.scenarios.underwriting_ahead ?? [];
    const investment = investmentOf(small, id ?? '');
    const inputs = underwritingInputsOf(small, investment);
    const snapshot = snapshotOf(small, investment.id)!;
    expect(inputs.asOf).toBe(small.asOf);
    expect(inputs.isActive).toBe(true);
    expect(inputs.entry).toEqual({
      periodEnd: snapshot.periodEnd,
      ebitdaLtm: snapshot.ebitdaLtm,
      ev: snapshot.ev,
      netDebt: snapshot.netDebt,
    });
    expect(inputs.current?.periodEnd).toBe(small.asOf);
    // The approved quarters, never the snapshot and never one after the as-of date.
    const quarters = small.quarterlyPerformance.filter(
      (q) => q.investmentId === investment.id && !q.isEntrySnapshot,
    );
    expect(inputs.quarters.map((q) => q.periodEnd).sort()).toEqual(
      quarters.map((q) => q.periodEnd).sort(),
    );
    expect(inputs.bridge).not.toBeNull();
    expect(inputs.bridgeNotCalculable).toBeNull();
    // Invested capital as the look-through extract computes it, and flows signed from our side.
    expect(Number(inputs.invested)).toBe(Number(investedCost(small, investment.id, small.asOf)));
    expect(Number(inputs.flows[0]?.amount)).toBeLessThan(0);
    expect(inputs.flows).toHaveLength(
      small.cashFlows.filter((f) => f.investmentId === investment.id).length,
    );
    expect([inputs.irrFlag, inputs.yieldToMaturity]).toEqual([null, null]);
    expect(Number(inputs.grossMoic)).toBeGreaterThan(0);
  });

  it('a realized position holds nothing: its returns close on its own flows and its quarters stop at the exit', () => {
    const investment = small.investments.find(
      (i) =>
        !i.isActive &&
        casesOf(small, i.id).length > 0 &&
        !(small.scenarios.multiple_irr ?? []).includes(i.id),
    )!;
    const inputs = underwritingInputsOf(small, investment);
    expect(inputs.isActive).toBe(false);
    expect(inputs.current!.periodEnd <= investment.exitDate!).toBe(true);
    expect(inputs.irrFlag).toBeNull();
    const comparison = seededComparison(small, casesOf(small, investment.id)[0]!, tolerances);
    // Realized: the MOIC is set against the underwritten MOIC at exit, with no path.
    expect([comparison.returns.moicOnPath, comparison.returns.pathNotCalculable]).toEqual([
      null,
      null,
    ]);
    expect(comparison.returns.moicGap).not.toBeNull();
  });

  it('a loan is read on its returns and its yield to maturity alone', () => {
    const loans = small.investments.filter((i) => i.dealType === UNDERWRITING_CREDIT_DEAL_TYPE);
    const maturityOf = (id: string): string =>
      small.creditTerms.find((t) => t.investmentId === id)!.maturityDate;
    const running = loans.find((i) => i.isActive && maturityOf(i.id) > small.asOf)!;
    const matured = loans.find((i) => maturityOf(i.id) <= small.asOf)!;
    expect([running, matured].every((i) => i !== undefined)).toBe(true);

    const inputs = underwritingInputsOf(small, running);
    // No company quarter and no bridge: a loan has neither, and the comparison asks for neither.
    expect([inputs.entry, inputs.current, inputs.quarters, inputs.bridge]).toEqual([
      null,
      null,
      [],
      null,
    ]);
    expect(Number(inputs.invested)).toBe(Number(investedCost(small, running.id, small.asOf)));
    expect(inputs.irrFlag).toBeNull();
    // Priced on the latest approved credit row: a loan marked above par yields under its coupons.
    const ytm = Number(inputs.yieldToMaturity);
    expect(ytm).toBeGreaterThan(0);
    expect(ytm).toBeLessThan(0.5);

    const comparison = seededComparison(small, casesOf(small, running.id)[0]!, tolerances);
    expect([
      comparison.quarter,
      comparison.metrics,
      comparison.headline,
      comparison.series,
      comparison.valueCreation,
    ]).toEqual([null, [], null, [], null]);
    expect(Number(comparison.yieldToMaturity)).toBeCloseTo(ytm, 9);
    const { returns } = comparison;
    expect(Number(returns.irrGap)).toBeCloseTo(
      Number(returns.grossIrr) - Number(casesOf(small, running.id)[0]!.grossIrr),
      9,
    );
    expect(['ahead', 'on_plan', 'behind']).toContain(returns.irrStatus);
    expect(returns.moicOnPath).not.toBeNull();
    expect(returns.pathNotCalculable).toBeNull();

    // Past its maturity a loan has no yield to maturity, and no path to set its MOIC against.
    expect(underwritingInputsOf(small, matured).yieldToMaturity).toBeNull();
    const late = seededComparison(small, casesOf(small, matured.id)[0]!, tolerances);
    expect([late.yieldToMaturity, late.returns.moicOnPath, late.returns.pathNotCalculable]).toEqual(
      [null, null, 'past_plan_end'],
    );
    expect(late.returns.irrStatus).not.toBeNull();
  });

  it('a forward-dated snapshot is no entry, and a position with no Locked mark has no IRR', () => {
    const [forward] = small.scenarios.forward_entry_snapshot ?? [];
    const inputs = underwritingInputsOf(small, investmentOf(small, forward ?? ''));
    expect([inputs.entry, inputs.bridge, inputs.bridgeNotCalculable]).toEqual([
      null,
      null,
      'entry_snapshot_forward_dated',
    ]);
    const [held] = small.scenarios.underwriting_ahead ?? [];
    const unmarked = {
      ...small,
      valuations: small.valuations.filter((v) => v.investmentId !== held),
    };
    const bare = underwritingInputsOf(unmarked, investmentOf(small, held ?? ''));
    expect([bare.grossMoic, bare.grossIrr, bare.irrFlag]).toEqual([null, null, 'no_valuation']);
  });
});

describe('the base cases in the database (migration 0021)', () => {
  it('loads every version to the state the dataset names, with its points, and hides the walled case outside the wall', async () => {
    const handle = await createTestDb();
    try {
      const counts = await loadSyntheticDataset(handle, small);
      expect(counts.underwritingCases).toBe(small.underwritingCases.length);
      expect(counts.underwritingCasePoints).toBe(
        small.underwritingCases.reduce((n, c) => n + c.points.length, 0),
      );
      // Loading the same dataset again changes nothing.
      await loadSyntheticDataset(handle, small);
      const stored = await handle.query<{
        id: string;
        state: string;
        version: number;
        entered_at: string;
        confirmed_by: string | null;
        confirmed_at: string | null;
        points: number;
      }>(
        `select c.id, c.state::text as state, c.version,
           to_char(c.entered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as entered_at,
           c.confirmed_by,
           to_char(c.confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as confirmed_at,
           (select count(*)::int from mon.underwriting_case_point p where p.case_id = c.id) as points
         from mon.underwriting_case c`,
      );
      expect(new Map(stored.map((r) => [r.id, r]))).toEqual(
        new Map(
          small.underwritingCases.map((c) => [
            c.id,
            {
              id: c.id,
              state: c.state,
              version: c.version,
              entered_at: c.enteredAt,
              confirmed_by: c.confirmedBy,
              confirmed_at: c.confirmedAt,
              points: c.points.length,
            },
          ]),
        ),
      );
      // Money to the cent, the multiple and the returns as the dataset wrote them.
      const [ahead] = scenarioCases(small, 'underwriting_ahead');
      const figures = await handle.query<{ m: string; moic: string; irr: string; exit: string }>(
        `select exit_multiple::text as m, gross_moic::text as moic, gross_irr::text as irr,
           (select p.ebitda_ltm::text from mon.underwriting_case_point p
             where p.case_id = c.id and p.period_end = c.planned_exit_date) as exit
         from mon.underwriting_case c where c.id = '${ahead!.id}'`,
      );
      expect(Number(figures[0]?.m)).toBe(Number(ahead!.exitMultiple));
      expect(Number(figures[0]?.moic)).toBe(Number(ahead!.grossMoic));
      expect(Number(figures[0]?.irr)).toBe(Number(ahead!.grossIrr));
      expect(figures[0]?.exit).toBe(ahead!.points[ahead!.points.length - 1]!.ebitdaLtm);

      const [walledId] = small.scenarios.walled_deal ?? [];
      const seen = async (externalId: string): Promise<number> => {
        const user = small.users.find((u) => u.externalId === externalId)!;
        return withUserContext(handle.db, { userId: user.id, roles: user.roles }, async (tx) => {
          const r = await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from mon.underwriting_case c join mon.underwriting_case_point p on p.case_id = c.id where c.investment_id = ${walledId}`,
          );
          return r.rows[0]?.n ?? -1;
        });
      };
      const walledPoints = casesOf(small, walledId ?? '').reduce((n, c) => n + c.points.length, 0);
      expect(walledPoints).toBeGreaterThan(0);
      expect(await seen('deal.one')).toBe(0);
      expect(await seen('viewer.one')).toBe(0);
      expect(await seen('deal.three')).toBe(walledPoints);
      expect(await seen('head.one')).toBe(walledPoints);
    } finally {
      await handle.close();
    }
  });
});

describe('the dataset check on the base cases', () => {
  const clone = (): GeneratedDataset => JSON.parse(JSON.stringify(small)) as GeneratedDataset;
  const problems = (d: GeneratedDataset): string => verifyDataset(d).problems.join('\n');
  const first = (d: GeneratedDataset, scenario: string): UnderwritingCaseRow =>
    d.underwritingCases.find((c) => c.investmentId === d.scenarios[scenario]?.[0])!;

  it('reports the rules of the table when a dataset breaks them', () => {
    const selfConfirmed = clone();
    const a = first(selfConfirmed, 'underwriting_ahead');
    a.confirmedBy = a.enteredBy;
    expect(problems(selfConfirmed)).toMatch(/confirmed by the person who entered it/);

    const noSource = clone();
    first(noSource, 'underwriting_ahead').sourceNote = ' ';
    expect(problems(noSource)).toMatch(/no source outside a Draft/);

    const shortPlan = clone();
    first(shortPlan, 'underwriting_behind').points.pop();
    expect(problems(shortPlan)).toMatch(/the last on the planned exit/);

    const twoDrafts = clone();
    const draft = first(twoDrafts, 'underwriting_draft');
    twoDrafts.underwritingCases.push({ ...draft, id: draft.id.replace(/^./, 'f'), version: 2 });
    expect(problems(twoDrafts)).toMatch(/more than one Draft/);

    const orphan = clone();
    const corrected = orphan.scenarios.underwriting_corrected?.[0];
    orphan.underwritingCases = orphan.underwritingCases.filter(
      (c) => !(c.investmentId === corrected && c.version === 2),
    );
    expect(problems(orphan)).toMatch(/Superseded with no later confirmed version/);

    const backdated = clone();
    const later = backdated.underwritingCases.find(
      (c) =>
        c.investmentId === backdated.scenarios.underwriting_reunderwritten?.[0] && c.version === 2,
    )!;
    later.caseDate = '2000-01-01';
    expect(problems(backdated)).toMatch(/neither a confirmed case's nor later than all of them/);

    const outsider = clone();
    const walled = outsider.underwritingCases.find(
      (c) => c.investmentId === outsider.scenarios.walled_deal?.[0],
    )!;
    walled.enteredBy = outsider.users.find((u) => u.externalId === 'deal.one')!.id;
    expect(problems(outsider)).toMatch(/outside the wall of its position/);

    const future = clone();
    first(future, 'underwriting_draft').enteredAt = '2030-01-01T10:00:00Z';
    expect(problems(future)).toMatch(/entered after the as-of date/);

    const loan = clone();
    const credit = loan.investments.find((i) => i.dealType === 'deal_type.private_credit')!;
    loan.underwritingCases.push({
      ...first(loan, 'underwriting_ahead'),
      id: 'f'.repeat(8) + '-0000-4000-8000-000000000000',
      investmentId: credit.id,
    });
    expect(problems(loan)).toMatch(/does not fit the position's deal type/);

    // A loan's own rules: a loss rate is a share, a loan has no exit multiple, and its
    // underwritten IRR is one the comparison can read.
    const ofLoan = (d: GeneratedDataset) => d.underwritingCases.find((c) => c.form === 'credit')!;
    const lossy = clone();
    ofLoan(lossy).annualLossRate = '1.5000';
    expect(problems(lossy)).toMatch(/a loss rate outside 0 to 1/);
    const multiple = clone();
    ofLoan(multiple).exitMultiple = '9.00';
    expect(problems(multiple)).toMatch(/a loan case has a yield, no exit multiple/);
    const wiped = clone();
    ofLoan(wiped).grossIrr = '-1.0000';
    expect(problems(wiped)).toMatch(/base case version 1: an underwritten IRR is above -100%/);
  });

  it('reports a scenario that no longer reads as it is tagged', () => {
    const notAhead = clone();
    const c = first(notAhead, 'underwriting_ahead');
    c.grossIrr = (Number(c.grossIrr) + 0.2).toFixed(4);
    expect(problems(notAhead)).toMatch(
      /scenario underwriting_ahead: EBITDA reads ahead and the IRR behind against plan/,
    );

    const whole = clone();
    for (const p of first(whole, 'underwriting_gap').points) p.netDebt ??= '1.00';
    expect(problems(whole)).toMatch(/scenario underwriting_gap/);

    const confirmed = clone();
    const draft = first(confirmed, 'underwriting_draft');
    draft.state = 'Withdrawn';
    draft.withdrawnReason = 'Entered in error';
    expect(problems(confirmed)).toMatch(/scenario underwriting_draft/);

    const missing = clone();
    delete missing.scenarios.underwriting_net_cash;
    expect(problems(missing)).toMatch(/scenario underwriting_net_cash is missing/);
  });

  it('judges with the tolerances it is given, which come from config and have no default in code', () => {
    const file = (definitions as { underwriting: Record<string, unknown> }).underwriting;
    expect(tolerances).toEqual({
      onPlanTolerance: String(file.onPlanTolerance),
      irrTolerance: String(file.irrTolerance),
    });
    // With a tolerance wider than the shift, nothing is ahead or behind any more.
    const wide = verifyDataset(small, 'config/local/denylist.txt', {
      onPlanTolerance: '5',
      irrTolerance: '0.5',
    }).problems.join('\n');
    expect(wide).toMatch(/scenario underwriting_ahead/);
    expect(wide).toMatch(/scenario underwriting_behind/);
    expect(wide).not.toMatch(/scenario underwriting_on_plan/);
    for (const source of [{}, { underwriting: {} }, { underwriting: { onPlanTolerance: 0.05 } }])
      expect(() => underwritingTolerances(source)).toThrow(
        /config\/definitions\.json: underwriting\./,
      );
    expect(() =>
      underwritingTolerances({ underwriting: { onPlanTolerance: -0.1, irrTolerance: 0.02 } }),
    ).toThrow(/underwriting\.onPlanTolerance must be a number at or above zero/);
    expect(
      underwritingTolerances({ underwriting: { onPlanTolerance: 0.1, irrTolerance: 0 } }),
    ).toEqual({ onPlanTolerance: '0.1', irrTolerance: '0' });
  });
});

describe('a dataset short of positions', () => {
  /**
   * The seeds of the small profile, 1 to 20, whose dataset passed its whole check before the base
   * cases were added, less seed 14: ten positions can carry a case there and four of them are
   * taken by the older scenarios, which leaves six for ten scenarios.
   */
  const FITS: ReadonlySet<number> = new Set([2, 5, 6, 7, 8, 9, 10, 11, 15, 17, 18, 19, 20]);

  it('fits its scenarios on ordinary seeds, taking a position left without a case when the others run out, and leaves out what still does not fit', () => {
    /** The seeds whose dataset carries all ten scenarios. */
    const complete: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const d = generateDataset({ profile: 'small', seed });
      const absent = UNDERWRITING_SCENARIOS.filter((s) => d.scenarios[s] === undefined);
      const problems = verifyDataset(d).problems;
      const reported = problems.filter((p) => p.includes('underwriting'));
      // Nothing is wrong with the cases that are there; only the absent scenarios are reported.
      expect(reported, `seed ${String(seed)}`).toEqual(
        absent.map((s) => `scenario ${s} is missing`),
      );
      for (const s of UNDERWRITING_SCENARIOS)
        expect(d.scenarios[s]?.length ?? 1, `seed ${String(seed)} ${s}`).toBe(1);
      // The generator command refuses a dataset that fails its check, so these must pass whole.
      if (FITS.has(seed)) expect(problems, `seed ${String(seed)}`).toEqual([]);
      if (absent.length === 0) complete.push(seed);
    }
    expect(complete.length).toBeGreaterThanOrEqual(FITS.size);
  });

  it('asks the positions left without a case only when the others run out: a scenario position still holds its scenario alone', () => {
    // Seed 7 of the small profile has too few positions with an ordinary case for ten scenarios.
    const d = generateDataset({ profile: 'small', seed: 7 });
    expect(verifyDataset(d).problems).toEqual([]);
    const tagged = UNDERWRITING_SCENARIOS.map((s) => d.scenarios[s]?.[0]);
    expect(new Set(tagged).size).toBe(UNDERWRITING_SCENARIOS.length);
    const [draft] = d.scenarios.underwriting_draft ?? [];
    expect(d.underwritingCases.filter((c) => c.investmentId === draft).map((c) => c.state)).toEqual(
      ['Draft'],
    );
    const [withdrawn] = d.scenarios.underwriting_withdrawn ?? [];
    expect(
      d.underwritingCases.filter((c) => c.investmentId === withdrawn).map((c) => c.state),
    ).toEqual(['Withdrawn']);
  });

  it('builds the same cases for the same seed, and others for another', () => {
    const again = generateDataset({ profile: 'small', seed: 42 });
    expect(again.underwritingCases).toEqual(small.underwritingCases);
    const other = generateDataset({ profile: 'small', seed: 43 });
    expect(other.underwritingCases.map((c) => c.id)).not.toEqual(
      small.underwritingCases.map((c) => c.id),
    );
  });

  it('builds on an earlier as-of date without a case entered or confirmed after it', () => {
    const earlier = generateDataset({ profile: 'small', seed: 42, asOf: '2024-12-31' });
    expect(earlier.underwritingCases.length).toBeGreaterThan(0);
    for (const c of earlier.underwritingCases) {
      expect(c.enteredAt <= '2024-12-31T23:59:59Z').toBe(true);
      expect(c.confirmedAt === null || c.confirmedAt <= '2024-12-31T23:59:59Z').toBe(true);
    }
    expect(verifyDataset(earlier).problems.filter((p) => p.includes('base case'))).toEqual([]);
  });
});
