import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CONTRIBUTIONS_UNCHECKED_REASONS,
  CalcError,
  D,
  SUGGESTION_BASES,
  SUGGESTION_METHODS,
  SUGGESTION_REASONS,
  addDays,
  alignedQuarterEnd,
  atOrAboveVarianceFlag,
  hasFlowBetween,
  heldMultipleMark,
  impliedStakeMark,
  latestLockedBefore,
  lockedForOrAfter,
  lockedNear,
  markComparison,
  previousQuarterEnd,
  quartersBetween,
  sourceCrossCheck,
  statementMark,
  statementTieTolerance,
} from './index.js';
import type {
  HeldMultipleInput,
  MarkComparisonInput,
  StakeMarkInput,
  StatementLines,
  StatementTolerances,
  TieTolerances,
} from './index.js';

/**
 * Property and unit tests for the valuation suggestions (docs/08 section 12). Golden fixtures 29
 * and 30 pin the worked examples; these pin the rules that hold for every input.
 */

const TOLERANCES: StatementTolerances = {
  tieToleranceUsd: '25000',
  contributionsTolerancePct: '0.02',
};
const TIE: TieTolerances = {
  rollForwardToleranceUsd: '1',
  tieToleranceByUnit: { USD_K: '2500', USD_M: '25000', USD_B: '25000000' },
};
const FLAG = '0.1';

/** Dollars and cents as the record stores them. */
const money = (min: number, max: number): fc.Arbitrary<string> =>
  fc
    .tuple(fc.integer({ min, max }), fc.integer({ min: 0, max: 99 }))
    .map(([dollars, cents]) =>
      dollars < 0
        ? `-${-dollars}.${String(cents).padStart(2, '0')}`
        : `${dollars}.${String(cents).padStart(2, '0')}`,
    );

/** A share of the vehicle above 0 and at most 1, to four places. */
const share = fc.integer({ min: 1, max: 10_000 }).map((n) => D(String(n)).div(10_000).toString());

const lines = (over: Partial<StatementLines> = {}): StatementLines => ({
  beginningBalance: '18420000.00',
  contributionsInPeriod: '2000000.00',
  distributionsInPeriod: '350000.00',
  netGainLoss: '870000.00',
  endingBalance: '20940000.00',
  contributionsToDate: '12400000.00',
  share: null,
  ...over,
});

const stake = (over: Partial<StakeMarkInput> = {}): StakeMarkInput => ({
  referenceMark: '7310450.25',
  flowsSinceReferenceMark: false,
  reference: { ev: '413000000.00', netDebt: '150000000.00' },
  current: { ev: '428050000.00', netDebt: '146300000.00' },
  ...over,
});

const held = (over: Partial<HeldMultipleInput> = {}): HeldMultipleInput => ({
  referenceMark: '7310450.25',
  flowsSinceReferenceMark: false,
  reference: { ev: '413000000.00', netDebt: '150000000.00', ebitda: '41300000.00' },
  current: { ebitda: '43900000.00', netDebt: '146300000.00' },
  ...over,
});

const comparison = (over: Partial<MarkComparisonInput> = {}): MarkComparisonInput => ({
  suggested: '20940000.00',
  current: '18420000.00',
  currentIsPreviousQuarter: true,
  varianceFlag: FLAG,
  statement: null,
  ...over,
});

const refused = (run: () => unknown, code: string): void => {
  let thrown: unknown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CalcError);
  expect((thrown as CalcError).code).toBe(code);
};

describe('the names of a suggestion', () => {
  it('lists the bases in the default order of the sources, each with its method', () => {
    expect(SUGGESTION_BASES).toEqual([
      'capital_account_balance',
      'sponsor_equity_value',
      'held_multiple',
    ]);
    expect(SUGGESTION_METHODS).toEqual({
      capital_account_balance: 'valuation_method.sponsor_mark',
      sponsor_equity_value: 'valuation_method.report_indication',
      held_multiple: 'valuation_method.report_indication',
    });
  });

  it('lists the reasons in the order they are decided, with no repeat', () => {
    expect(SUGGESTION_REASONS).toEqual([
      'no_ending_balance',
      'non_positive_balance',
      'share_out_of_range',
      'no_reference_mark',
      'flows_since_reference_mark',
      'no_reference_figures',
      'non_positive_reference_equity',
      'no_ebitda',
      'non_positive_ebitda',
      'no_net_debt',
      'non_positive_equity',
      'value_not_positive',
    ]);
    expect(new Set(SUGGESTION_REASONS).size).toBe(SUGGESTION_REASONS.length);
    expect(CONTRIBUTIONS_UNCHECKED_REASONS).toEqual([
      'contributions_not_stated',
      'share_out_of_range',
      'no_recorded_contributions',
    ]);
  });
});

describe('statementMark: the mark a capital account statement gives (rule 12.1)', () => {
  it('answers the method and whether the lines were read as our own account', () => {
    const own = statementMark(lines(), '12400000.00', TOLERANCES);
    expect(own).toMatchObject({
      basis: 'capital_account_balance',
      method: 'valuation_method.sponsor_mark',
      value: '20940000',
      reason: null,
      ownAccount: true,
    });
    expect(statementMark(lines({ share: '1' }), '12400000.00', TOLERANCES).ownAccount).toBe(false);
  });

  it('refuses a tolerance or a record below zero, and a JS number', () => {
    refused(
      () => statementMark(lines(), '0', { ...TOLERANCES, tieToleranceUsd: '-1' }),
      'invalid_suggestion_input',
    );
    refused(
      () => statementMark(lines(), '0', { ...TOLERANCES, contributionsTolerancePct: '-0.01' }),
      'invalid_suggestion_input',
    );
    refused(() => statementMark(lines(), '-0.01', TOLERANCES), 'invalid_suggestion_input');
    refused(
      () => statementMark(lines({ endingBalance: 20940000 as unknown as string }), '0', TOLERANCES),
      'number_input',
    );
  });

  it('never moves the value with the other lines, and ties exactly within the tolerance', () => {
    fc.assert(
      fc.property(
        money(1, 900_000_000),
        money(0, 900_000_000),
        money(0, 90_000_000),
        money(0, 90_000_000),
        money(-90_000_000, 90_000_000),
        fc.option(money(0, 900_000_000), { nil: null }),
        (ending, beginning, contributions, distributions, gain, toDate) => {
          const alone = statementMark(
            lines({
              endingBalance: ending,
              beginningBalance: null,
              contributionsInPeriod: null,
              distributionsInPeriod: null,
              netGainLoss: null,
              contributionsToDate: null,
            }),
            '0',
            TOLERANCES,
          );
          const full = statementMark(
            lines({
              endingBalance: ending,
              beginningBalance: beginning,
              contributionsInPeriod: contributions,
              distributionsInPeriod: distributions,
              netGainLoss: gain,
              contributionsToDate: toDate,
            }),
            '12400000.00',
            TOLERANCES,
          );
          expect(full.value).toBe(alone.value);
          expect(full.value).toBe(D(ending).toString());
          expect(alone.ties).toBeNull();
          const apart = D(ending)
            .minus(D(beginning).plus(contributions).minus(distributions).plus(gain))
            .abs();
          expect(full.ties).toBe(apart.lte('25000'));
          expect(D(full.tieDifference!).abs().eq(apart)).toBe(true);
        },
      ),
    );
  });

  it('is linear in our share, to the cent, and never above the balance', () => {
    fc.assert(
      fc.property(
        money(1, 900_000_000),
        fc.integer({ min: 1, max: 2_500 }),
        fc.integer({ min: 2, max: 4 }),
        (ending, tenThousandths, k) => {
          const at = (n: number): string | null =>
            statementMark(
              lines({ endingBalance: ending, share: D(String(n)).div(10_000).toString() }),
              '0',
              TOLERANCES,
            ).value;
          const one = at(tenThousandths);
          const many = at(tenThousandths * k);
          // A share of a balance of a cent or more is above zero unless it is under half a cent.
          if (one === null || many === null) {
            expect(D(ending).times(tenThousandths).div(10_000).lt('0.005')).toBe(one === null);
            return;
          }
          // Each value is within half a cent of the exact figure, so k values are within
          // k halves of a cent of the one at k times the share, and that one within a half.
          expect(
            D(many)
              .minus(D(one).times(k))
              .abs()
              .lte(D('0.005').times(k + 1)),
          ).toBe(true);
          expect(D(many).lte(D(ending))).toBe(true);
          expect(at(10_000)).toBe(D(ending).toString());
        },
      ),
    );
  });

  it('gives a value above zero or a reason, never both and never neither', () => {
    fc.assert(
      fc.property(
        fc.option(money(-1_000_000, 900_000_000), { nil: null }),
        fc.option(
          fc.integer({ min: -5_000, max: 15_000 }).map((n) => D(String(n)).div(10_000).toString()),
          { nil: null },
        ),
        (ending, part) => {
          const mark = statementMark(
            lines({ endingBalance: ending, share: part }),
            '0',
            TOLERANCES,
          );
          expect(mark.value === null).toBe(mark.reason !== null);
          if (mark.value !== null) expect(D(mark.value).gt(0)).toBe(true);
          const outOfRange = part !== null && (D(part).lte(0) || D(part).gt(1));
          if (ending === null) expect(mark.reason).toBe('no_ending_balance');
          else if (D(ending).lte(0)) expect(mark.reason).toBe('non_positive_balance');
          else if (outOfRange) expect(mark.reason).toBe('share_out_of_range');
          expect(mark.ours.beginningBalance === null).toBe(outOfRange);
        },
      ),
    );
  });

  it('sets our part of the contributions to date against the record, and says when it cannot', () => {
    fc.assert(
      fc.property(
        fc.option(money(0, 900_000_000), { nil: null }),
        share,
        money(0, 900_000_000),
        (toDate, part, record) => {
          const check = statementMark(
            lines({ contributionsToDate: toDate, share: part }),
            record,
            TOLERANCES,
          ).contributionsCheck;
          expect(check.record).toBe(D(record).toString());
          if (toDate === null) {
            expect(check).toMatchObject({
              statement: null,
              notChecked: 'contributions_not_stated',
            });
            return;
          }
          const ours = D(check.statement!);
          expect(ours.minus(D(toDate).times(part)).abs().lte('0.005')).toBe(true);
          if (D(record).isZero()) {
            expect(check).toMatchObject({ differs: null, notChecked: 'no_recorded_contributions' });
            return;
          }
          expect(check.notChecked).toBeNull();
          expect(D(check.difference!).eq(ours.minus(record))).toBe(true);
          // Judged on the percent as it travels, so the answer can be checked from it.
          expect(check.differs).toBe(D(check.differencePct!).abs().gt('0.02'));
          expect(
            D(check.differencePct!).times(record).minus(check.difference!).abs().lte('0.1'),
          ).toBe(true);
        },
      ),
    );
  });
});

describe('statementTieTolerance: how far apart the lines of a statement may be', () => {
  it('follows the coarsest unit a line was read in', () => {
    expect(statementTieTolerance([], TIE).toString()).toBe('1');
    expect(statementTieTolerance(['USD', 'USD'], TIE).toString()).toBe('1');
    expect(statementTieTolerance(['USD', 'USD_K'], TIE).toString()).toBe('2500');
    expect(statementTieTolerance(['USD_K', 'USD_M', 'USD'], TIE).toString()).toBe('25000');
    expect(statementTieTolerance(['USD_M', 'USD_B', 'USD_K'], TIE).toString()).toBe('25000000');
  });

  it('refuses a unit it does not know, a unit config gives no tolerance for and one below zero', () => {
    refused(() => statementTieTolerance(['EUR_M'], TIE), 'unknown_unit');
    refused(
      () => statementTieTolerance(['USD_M'], { ...TIE, tieToleranceByUnit: { USD_K: '2500' } }),
      'missing_tie_tolerance',
    );
    refused(
      () => statementTieTolerance(['USD_K'], { ...TIE, tieToleranceByUnit: { USD_K: '-1' } }),
      'invalid_suggestion_input',
    );
    refused(
      () => statementTieTolerance(['USD'], { ...TIE, rollForwardToleranceUsd: '-1' }),
      'invalid_suggestion_input',
    );
    // A name every object carries is not a unit config gave a tolerance for.
    refused(() => statementTieTolerance(['toString'], TIE), 'unknown_unit');
  });
});

describe('impliedStakeMark: our last Locked mark scaled by the sponsor equity value (rule 12.2)', () => {
  it('answers the method of an indication from the sponsor report', () => {
    expect(impliedStakeMark(stake())).toEqual({
      basis: 'sponsor_equity_value',
      method: 'valuation_method.report_indication',
      value: '7831632.54',
      reason: null,
      referenceEquity: '263000000',
      equity: '281750000',
    });
  });

  it('gives back the reference mark when the equity value has not changed', () => {
    fc.assert(
      fc.property(
        money(1, 900_000_000),
        money(1, 900_000_000),
        money(-200_000_000, 900_000_000),
        money(-200_000_000, 900_000_000),
        (mark, equity, debtThen, debtNow) => {
          const result = impliedStakeMark(
            stake({
              referenceMark: mark,
              reference: { ev: D(equity).plus(debtThen).toFixed(2), netDebt: debtThen },
              current: { ev: D(equity).plus(debtNow).toFixed(2), netDebt: debtNow },
            }),
          );
          expect(result.value).toBe(D(mark).toString());
          expect(result.referenceEquity).toBe(result.equity);
        },
      ),
    );
  });

  it('scales with the reference mark, to the cent', () => {
    fc.assert(
      fc.property(
        money(1, 900_000_000),
        fc.integer({ min: 2, max: 9 }),
        money(1, 900_000_000),
        money(1, 900_000_000),
        (mark, k, equityThen, equityNow) => {
          const at = (m0: string): string | null =>
            impliedStakeMark(
              stake({
                referenceMark: m0,
                reference: { ev: equityThen, netDebt: '0.00' },
                current: { ev: equityNow, netDebt: '0.00' },
              }),
            ).value;
          const one = at(mark);
          const many = at(D(mark).times(k).toFixed(2));
          if (one === null || many === null) {
            // Only a figure under half a cent has no value here.
            expect(D(mark).times(equityNow).div(equityThen).lt('0.005')).toBe(one === null);
            return;
          }
          expect(
            D(many)
              .minus(D(one).times(k))
              .abs()
              .lte(D('0.005').times(k + 1)),
          ).toBe(true);
        },
      ),
    );
  });

  it('is within half a cent of the exact figure, and above zero or with a reason', () => {
    fc.assert(
      fc.property(
        fc.option(money(0, 900_000_000), { nil: null }),
        fc.boolean(),
        fc.option(
          fc.record({
            ev: fc.option(money(0, 9_000_000_000), { nil: null }),
            netDebt: fc.option(money(-500_000_000, 9_000_000_000), { nil: null }),
          }),
          { nil: null },
        ),
        money(0, 9_000_000_000),
        fc.option(money(-500_000_000, 9_000_000_000), { nil: null }),
        (mark, flows, reference, ev, netDebt) => {
          const result = impliedStakeMark({
            referenceMark: mark,
            flowsSinceReferenceMark: flows,
            reference,
            current: { ev, netDebt },
          });
          expect(result.value === null).toBe(result.reason !== null);
          if (result.value === null) return;
          expect(D(result.value).gt(0)).toBe(true);
          const exact = D(mark!).times(D(result.equity!)).div(D(result.referenceEquity!));
          expect(D(result.value).minus(exact).abs().lte('0.005')).toBe(true);
        },
      ),
    );
  });
});

describe('heldMultipleMark: the earlier multiple held (rule 12.3)', () => {
  it('answers the enterprise value it holds the multiple at', () => {
    expect(heldMultipleMark(held())).toEqual({
      basis: 'held_multiple',
      method: 'valuation_method.report_indication',
      value: '8136003',
      reason: null,
      referenceEquity: '263000000',
      impliedEv: '439000000',
      equity: '292700000',
    });
  });

  it('is rule 12.2 at the enterprise value the held multiple gives', () => {
    fc.assert(
      fc.property(
        money(1, 900_000_000),
        fc.integer({ min: 1, max: 900_000_000 }),
        fc.integer({ min: 4, max: 20 }),
        money(-200_000_000, 900_000_000),
        fc.integer({ min: 1, max: 900_000_000 }),
        money(-200_000_000, 900_000_000),
        (mark, ebitdaThen, multiple, debtThen, ebitdaNow, debtNow) => {
          // A whole multiple, so the enterprise value it gives is exact and rule 12.2 can be asked.
          const evThen = D(String(ebitdaThen)).times(multiple).toFixed(2);
          const evNow = D(String(ebitdaNow)).times(multiple).toFixed(2);
          const byMultiple = heldMultipleMark({
            referenceMark: mark,
            flowsSinceReferenceMark: false,
            reference: { ev: evThen, netDebt: debtThen, ebitda: `${ebitdaThen}.00` },
            current: { ebitda: `${ebitdaNow}.00`, netDebt: debtNow },
          });
          const byValue = impliedStakeMark({
            referenceMark: mark,
            flowsSinceReferenceMark: false,
            reference: { ev: evThen, netDebt: debtThen },
            current: { ev: evNow, netDebt: debtNow },
          });
          expect(byMultiple.value).toBe(byValue.value);
          expect(byMultiple.reason).toBe(byValue.reason);
          expect(byMultiple.referenceEquity).toBe(byValue.referenceEquity);
          if (byMultiple.reason === null) {
            expect(byMultiple.impliedEv).toBe(D(evNow).toString());
            expect(byMultiple.equity).toBe(byValue.equity);
          }
        },
      ),
    );
  });

  it('gives a value above zero or a reason, with the EBITDA reasons before the new net debt', () => {
    const figure = (min: number, max: number): fc.Arbitrary<string | null> =>
      fc.option(money(min, max), { nil: null });
    fc.assert(
      fc.property(
        figure(0, 900_000_000),
        fc.boolean(),
        figure(1, 9_000_000_000),
        figure(-500_000_000, 900_000_000),
        figure(-5_000_000, 900_000_000),
        figure(-5_000_000, 900_000_000),
        figure(-500_000_000, 9_000_000_000),
        (mark, flows, ev, netDebt, ebitdaThen, ebitdaNow, debtNow) => {
          const result = heldMultipleMark({
            referenceMark: mark,
            flowsSinceReferenceMark: flows,
            reference: { ev, netDebt, ebitda: ebitdaThen },
            current: { ebitda: ebitdaNow, netDebt: debtNow },
          });
          expect(result.value === null).toBe(result.reason !== null);
          if (result.value !== null) expect(D(result.value).gt(0)).toBe(true);
          const first = impliedStakeMark({
            referenceMark: mark,
            flowsSinceReferenceMark: flows,
            reference: { ev, netDebt },
            current: { ev: '1.00', netDebt: '0.00' },
          });
          const early = [
            'no_reference_mark',
            'flows_since_reference_mark',
            'no_reference_figures',
            'non_positive_reference_equity',
          ];
          if (first.reason !== null && early.includes(first.reason)) {
            expect(result.reason).toBe(first.reason);
            return;
          }
          if (ebitdaThen === null || ebitdaNow === null) expect(result.reason).toBe('no_ebitda');
          else if (D(ebitdaThen).lte(0) || D(ebitdaNow).lte(0))
            expect(result.reason).toBe('non_positive_ebitda');
          else if (debtNow === null) expect(result.reason).toBe('no_net_debt');
        },
      ),
    );
  });
});

describe('markComparison: a value beside the mark on record (rule 12.4)', () => {
  it('adds the change back to the mark, and flags by the percent as it travels', () => {
    fc.assert(
      fc.property(
        money(1, 900_000_000),
        money(0, 900_000_000),
        fc.boolean(),
        (suggested, current, previous) => {
          const result = markComparison(
            comparison({ suggested, current, currentIsPreviousQuarter: previous }),
          );
          expect(D(current).plus(result.change!).eq(suggested)).toBe(true);
          if (D(current).isZero()) {
            expect(result.changePct).toBeNull();
            expect(result.variance).toBe(false);
            return;
          }
          expect(result.variance).toBe(previous && D(result.changePct!).abs().gte(FLAG));
          expect(result.variance).toBe(previous && atOrAboveVarianceFlag(result.changePct, FLAG));
          expect(result.netOfFlows).toBeNull();
          expect(result.beginningBalance).toBeNull();
        },
      ),
    );
  });

  it('works the net of flows out only from a statement that starts where the record does', () => {
    fc.assert(
      fc.property(
        money(1, 900_000_000),
        money(1, 900_000_000),
        fc.integer({ min: -3_000_000, max: 3_000_000 }),
        money(0, 90_000_000),
        money(0, 90_000_000),
        fc.boolean(),
        (suggested, current, centsOff, contributions, distributions, previous) => {
          const begin = D(current).plus(D(String(centsOff)).div(100));
          const result = markComparison(
            comparison({
              suggested,
              current,
              currentIsPreviousQuarter: previous,
              statement: {
                beginningBalance: begin.toFixed(2),
                contributionsInPeriod: contributions,
                distributionsInPeriod: distributions,
                tieToleranceUsd: '25000',
              },
            }),
          );
          expect(result.beginningBalance).toBe(begin.toString());
          const starts = previous && Math.abs(centsOff) <= 2_500_000;
          expect(result.netOfFlows === null).toBe(!starts);
          if (result.netOfFlows === null) {
            expect(result.netOfFlowsPct).toBeNull();
            return;
          }
          // The change less the contributions plus the distributions, and that over the mark.
          expect(
            D(result.netOfFlows).eq(D(result.change!).minus(contributions).plus(distributions)),
          ).toBe(true);
          expect(
            D(result.netOfFlowsPct!).times(current).minus(result.netOfFlows).abs().lte('0.1'),
          ).toBe(true);
        },
      ),
    );
  });

  it('refuses a flag or a tolerance below zero whatever the figures', () => {
    refused(
      () => markComparison(comparison({ suggested: null, varianceFlag: '-0.1' })),
      'invalid_suggestion_input',
    );
    refused(
      () =>
        markComparison(
          comparison({
            current: null,
            statement: {
              beginningBalance: null,
              contributionsInPeriod: null,
              distributionsInPeriod: null,
              tieToleranceUsd: '-1',
            },
          }),
        ),
      'invalid_suggestion_input',
    );
    refused(() => atOrAboveVarianceFlag('0.2', '-0.1'), 'invalid_suggestion_input');
  });

  it('flags nothing without a percent', () => {
    expect(atOrAboveVarianceFlag(null, FLAG)).toBe(false);
    expect(atOrAboveVarianceFlag('0.1', FLAG)).toBe(true);
    expect(atOrAboveVarianceFlag('-0.2059', FLAG)).toBe(true);
    expect(atOrAboveVarianceFlag('0.0999', FLAG)).toBe(false);
    // A flag of zero flags every change, and no change at all.
    expect(atOrAboveVarianceFlag('0', '0')).toBe(true);
  });
});

describe('sourceCrossCheck: a value beside another source (rule 12.5)', () => {
  it('adds the difference back to the suggested value, and averages nothing', () => {
    fc.assert(
      fc.property(money(1, 900_000_000), money(1, 900_000_000), (other, suggested) => {
        const result = sourceCrossCheck(other, suggested, FLAG);
        expect(D(suggested).plus(result.difference!).eq(other)).toBe(true);
        expect(result.differs).toBe(D(result.differencePct!).abs().gte(FLAG));
        // Seen from the other side the difference has the other sign.
        const back = sourceCrossCheck(suggested, other, FLAG);
        expect(D(back.difference!).eq(D(result.difference!).neg())).toBe(true);
      }),
    );
  });

  it('refuses a flag below zero', () => {
    refused(() => sourceCrossCheck(null, null, '-0.1'), 'invalid_suggestion_input');
  });
});

describe('which marks and flows count for a quarter', () => {
  const mark = (periodEnd: string, fairValue: string, state = 'Locked') => ({
    periodEnd,
    fairValue,
    state,
  });

  it('names the quarter end before a quarter end, and counts quarters between dates', () => {
    expect(previousQuarterEnd('2025-06-30')).toBe('2025-03-31');
    expect(previousQuarterEnd('2025-03-31')).toBe('2024-12-31');
    refused(() => previousQuarterEnd('2025-06-29'), 'invalid_quarter_end');
    expect(quartersBetween('2025-03-31', '2025-06-30')).toBe(1);
    expect(quartersBetween('2024-06-30', '2025-06-30')).toBe(4);
    expect(quartersBetween('2025-05-15', '2025-06-30')).toBe(0);
    expect(quartersBetween('2024-12-31', '2025-03-31')).toBe(1);
  });

  it('takes the latest Locked mark of an earlier quarter', () => {
    const marks = [
      mark('2024-12-31', '1'),
      mark('2025-03-31', '2'),
      mark('2025-06-30', '3'),
      mark('2025-03-31', '9', 'Draft'),
    ];
    expect(latestLockedBefore(marks, '2025-06-30', 7)).toEqual({
      mark: marks[1],
      reportsFor: '2025-03-31',
      previousQuarter: true,
      ageQuarters: 1,
    });
    // Two quarters old: not the previous quarter's mark.
    expect(latestLockedBefore(marks, '2025-09-30', 7)?.mark.fairValue).toBe('3');
    expect(latestLockedBefore([marks[0]!], '2025-06-30', 7)).toMatchObject({
      reportsFor: '2024-12-31',
      previousQuarter: false,
      ageQuarters: 2,
    });
    expect(latestLockedBefore(marks, '2024-12-31', 7)).toBeNull();
    expect(latestLockedBefore([mark('2025-03-31', '9', 'Draft')], '2025-06-30', 7)).toBeNull();
    refused(() => latestLockedBefore(marks, '2025-06-15', 7), 'invalid_quarter_end');
  });

  it('counts a mark dated a few days either side of a quarter end for that quarter', () => {
    // Three days early and three days late both report for March.
    for (const date of ['2025-03-28', '2025-04-03']) {
      expect(latestLockedBefore([mark(date, '1')], '2025-06-30', 7)).toMatchObject({
        reportsFor: '2025-03-31',
        previousQuarter: true,
        ageQuarters: 1,
      });
      expect(latestLockedBefore([mark(date, '1')], '2025-03-31', 7)).toBeNull();
      expect(lockedForOrAfter([mark(date, '1')], '2025-03-31', 7)).toBe(true);
      expect(lockedForOrAfter([mark(date, '1')], '2025-06-30', 7)).toBe(false);
    }
    // A mark inside the quarter and further from its end than the tolerance is of no quarter end:
    // it is earlier than the end of its own quarter, and its age there is zero.
    expect(latestLockedBefore([mark('2025-05-15', '1')], '2025-06-30', 7)).toMatchObject({
      reportsFor: '2025-05-15',
      previousQuarter: false,
      ageQuarters: 0,
    });
    expect(lockedForOrAfter([mark('2025-05-15', '1')], '2025-06-30', 7)).toBe(false);
  });

  it('keeps the first of two marks on one period end, as lockedNear does', () => {
    const marks = [mark('2025-03-31', 'v2'), mark('2025-03-31', 'v1')];
    expect(latestLockedBefore(marks, '2025-06-30', 7)?.mark.fairValue).toBe('v2');
    expect(lockedNear(marks, '2025-03-31', 7)?.fairValue).toBe('v2');
  });

  it('says a quarter is marked when a Locked mark reports for it or a later one', () => {
    const marks = [
      mark('2025-03-31', '1'),
      mark('2025-09-30', '2'),
      mark('2025-12-31', '3', 'Draft'),
    ];
    expect(lockedForOrAfter(marks, '2025-03-31', 7)).toBe(true);
    expect(lockedForOrAfter(marks, '2025-06-30', 7)).toBe(true);
    expect(lockedForOrAfter(marks, '2025-09-30', 7)).toBe(true);
    expect(lockedForOrAfter(marks, '2025-12-31', 7)).toBe(false);
    expect(lockedForOrAfter([], '2025-12-31', 7)).toBe(false);
    refused(() => lockedForOrAfter(marks, '2025-12-30', 7), 'invalid_quarter_end');
  });

  it('agrees with lockedNear on the previous quarter, and never looks at the quarter itself', () => {
    const quarterEnds = ['2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            periodEnd: fc.integer({ min: -30, max: 400 }).map((d) => addDays('2024-09-01', d)),
            state: fc.constantFrom('Locked', 'Locked', 'Draft', 'Reopened'),
          }),
          { maxLength: 8 },
        ),
        fc.constantFrom(...quarterEnds.slice(1)),
        (marks, quarterEnd) => {
          const found = latestLockedBefore(marks, quarterEnd, 7);
          const earlier = marks.filter(
            (m) => m.state === 'Locked' && alignedQuarterEnd(m.periodEnd, 7) < quarterEnd,
          );
          expect(found === null).toBe(earlier.length === 0);
          // Every Locked mark is of an earlier quarter, or marks this quarter or a later one.
          expect(lockedForOrAfter(marks, quarterEnd, 7)).toBe(
            marks.some((m) => m.state === 'Locked') &&
              marks.filter((m) => m.state === 'Locked').length > earlier.length,
          );
          if (found === null) return;
          expect(found.mark.state).toBe('Locked');
          expect(found.reportsFor < quarterEnd).toBe(true);
          expect(earlier.every((m) => m.periodEnd <= found.mark.periodEnd)).toBe(true);
          // The previous quarter's mark is the one lockedNear finds for it; a later mark that
          // reports for no quarter end (dated inside this quarter) is found in its place.
          const previous = lockedNear(marks, previousQuarterEnd(quarterEnd), 7);
          expect(found.previousQuarter).toBe(found.reportsFor === previousQuarterEnd(quarterEnd));
          if (found.previousQuarter) expect(found.mark).toBe(previous);
          else if (previous !== null) expect(found.mark.periodEnd > previous.periodEnd).toBe(true);
          expect(found.ageQuarters >= 0).toBe(true);
          expect(found.previousQuarter ? found.ageQuarters : 1).toBe(1);
        },
      ),
    );
  });

  it('sees a flow after the mark and on or before the new quarter end, and no other', () => {
    const flows = [{ date: '2025-03-31' }, { date: '2025-07-01' }];
    expect(hasFlowBetween(flows, '2025-03-31', '2025-06-30')).toBe(false);
    expect(hasFlowBetween([...flows, { date: '2025-04-01' }], '2025-03-31', '2025-06-30')).toBe(
      true,
    );
    expect(hasFlowBetween([...flows, { date: '2025-06-30' }], '2025-03-31', '2025-06-30')).toBe(
      true,
    );
    // A mark dated three days early: a flow on the quarter end itself is after it.
    expect(hasFlowBetween(flows, '2025-03-28', '2025-06-30')).toBe(true);
    expect(hasFlowBetween([], '2025-03-31', '2025-06-30')).toBe(false);
  });
});
