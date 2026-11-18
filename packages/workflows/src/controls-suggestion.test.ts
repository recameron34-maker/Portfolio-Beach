import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CalcError, SUGGESTION_BASES } from '@pb/calc';
import type { SuggestionBasis } from '@pb/calc';
import {
  NO_SUGGESTION_REASONS,
  SUGGESTION_BUSY_REFUSAL,
  SUGGESTION_CHANGED_REFUSAL,
  SUGGESTION_DEAL_TYPES,
  SUGGESTION_KEY_PREFIX,
  SUGGESTION_SOURCE_KINDS,
  SUGGESTIONS_OFF_REFUSAL,
  SuggestionConfigError,
  derivationStep,
  keepSuggestionKeys,
  readSources,
  readStatement,
  referenceOnHand,
  sameSuggestion,
  selectSuggestion,
  sourceReviewersOf,
  suggestionBar,
  suggestionCommandRecord,
  suggestionDraftKeys,
  suggestionReading,
  suggestionSettings,
  withSuggestionKeys,
} from './controls-suggestion.js';
import { SUPERSEDED_REASONS, attempt, valuationSuggestionMachine } from './index.js';
import type {
  DerivationInput,
  MarkOnRecord,
  PriorSuggestion,
  QuarterOnRecord,
  ReferenceOnHand,
  ReportOnHand,
  Selection,
  SourcedFigure,
  StatementLine,
  StatementOnHand,
  SuggestionPosition,
  SuggestionSettings,
  SuggestionSources,
} from './controls-suggestion.js';

/*
 * The valuation suggestions as pure rules (docs/08 section 12, docs/18 section 14). The figures
 * are the worked examples of docs/08 section 12, so every expected value here can be checked by
 * hand; the arithmetic itself is pinned by the golden fixtures of packages/calc.
 */

const DOC = '70000000-0000-4000-8000-000000000001';
const REPORT_DOC = '70000000-0000-4000-8000-000000000002';
const REVIEWER = '10000000-0000-4000-8000-000000000003';
const MARK = '80000000-0000-4000-8000-000000000001';
const QUARTER = '90000000-0000-4000-8000-000000000001';
const Q1 = '2025-03-31';
const Q2 = '2025-06-30';

const SETTINGS: SuggestionSettings = {
  sourceOrder: ['capital_account_balance', 'sponsor_equity_value', 'held_multiple'],
  tieToleranceByUnit: { USD_K: '2500', USD_M: '25000', USD_B: '25000000' },
  contributionsTolerancePct: '0.02',
  rollForwardToleranceUsd: '1',
  varianceFlag: '0.1',
  periodEndToleranceDays: 7,
};

const definitions = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../config/definitions.json'), 'utf8'),
  ) as Record<string, unknown>;

/** A statement line read from page one of the statement, in US$ millions. */
const line = (value: string, unit = 'USD_M'): StatementLine => ({
  value,
  unit,
  source: { kind: 'document', id: DOC, page: 1 },
  edited: false,
});

/** Worked example 1: our own account in US$ millions. */
const statement = (over: Partial<StatementOnHand> = {}): StatementOnHand => ({
  beginningBalance: line('18.42'),
  contributionsInPeriod: line('2.00'),
  distributionsInPeriod: line('0.35'),
  netGainLoss: line('0.87'),
  endingBalance: line('20.94'),
  contributionsToDate: line('12.40'),
  share: null,
  ...over,
});

const fromReport = (value: string, page = 3): SourcedFigure => ({
  value,
  source: { kind: 'document', id: REPORT_DOC, page },
  edited: false,
});

/** Worked example 4: the report states an enterprise value for the new quarter. */
const report = (over: Partial<ReportOnHand> = {}): ReportOnHand => ({
  ev: fromReport('428050000.00'),
  netDebt: fromReport('146300000.00', 4),
  ebitda: fromReport('43900000.00'),
  ...over,
});

const quarter: QuarterOnRecord = {
  id: QUARTER,
  periodEnd: Q1,
  ev: '413000000.00',
  netDebt: '150000000.00',
  ebitdaLtm: '41300000.00',
};

/** Worked example 4's reference: the previous quarter's Locked mark and that quarter's figures. */
const reference = (over: Partial<ReferenceOnHand> = {}): ReferenceOnHand => ({
  mark: {
    valuationId: MARK,
    value: '7310450.25',
    periodEnd: Q1,
    reportsFor: Q1,
    previousQuarter: true,
    ageQuarters: 1,
  },
  flowsSince: false,
  quarter,
  ...over,
});

const sources = (over: Partial<SuggestionSources> = {}): SuggestionSources => ({
  periodEnd: Q2,
  statement: null,
  report: null,
  reference: reference(),
  recordContributions: '12400000.00',
  ...over,
});

const position = (over: Partial<SuggestionPosition> = {}): SuggestionPosition => ({
  dealType: 'deal_type.co_invest_equity',
  currency: 'USD',
  isActive: true,
  entryDate: '2023-02-15',
  exitDate: null,
  ...over,
});

const locked = (periodEnd: string, fairValue = '7310450.25', state = 'Locked'): MarkOnRecord => ({
  id: MARK,
  periodEnd,
  state,
  fairValue,
});

describe('suggestionSettings: the settings of config/definitions.json', () => {
  it('reads the repository file: the order of sources, the tolerances and the flag', () => {
    expect(suggestionSettings(definitions())).toEqual({
      sourceOrder: ['capital_account_balance', 'sponsor_equity_value', 'held_multiple'],
      tieToleranceByUnit: { USD_K: '2500', USD_M: '25000', USD_B: '25000000' },
      contributionsTolerancePct: '0.02',
      rollForwardToleranceUsd: '1',
      varianceFlag: '0.1',
      periodEndToleranceDays: 7,
    });
  });

  it('takes a decimal string as well as a number, and any order of the three bases', () => {
    const settings = suggestionSettings({
      ...definitions(),
      rollForwardToleranceUsd: '0.50',
      valuationSuggestions: {
        sourceOrder: ['held_multiple', 'capital_account_balance', 'sponsor_equity_value'],
        tieToleranceByUnit: { USD_K: '2500', USD_M: 25000, USD_B: 1e21 },
        contributionsTolerancePct: 0,
      },
    });
    expect(settings.sourceOrder).toEqual([
      'held_multiple',
      'capital_account_balance',
      'sponsor_equity_value',
    ]);
    expect(settings.rollForwardToleranceUsd).toBe('0.50');
    expect(settings.contributionsTolerancePct).toBe('0');
    // A number too large for plain digits in JSON still arrives as plain digits.
    expect(settings.tieToleranceByUnit.USD_B).toBe('1000000000000000000000');
  });

  it('refuses a missing or unusable key by name, never with a default', () => {
    const base = definitions();
    const own = base.valuationSuggestions as Record<string, unknown>;
    const withOwn = (patch: Record<string, unknown>): Record<string, unknown> => ({
      ...base,
      valuationSuggestions: { ...own, ...patch },
    });
    const cases: [unknown, string][] = [
      [null, 'valuationSuggestions.sourceOrder'],
      ['definitions', 'valuationSuggestions.sourceOrder'],
      [{ ...base, valuationSuggestions: undefined }, 'valuationSuggestions.sourceOrder'],
      [{ ...base, valuationSuggestions: [] }, 'valuationSuggestions.sourceOrder'],
      [withOwn({ sourceOrder: 'capital_account_balance' }), 'valuationSuggestions.sourceOrder'],
      [
        withOwn({ sourceOrder: ['capital_account_balance', 'held_multiple'] }),
        'valuationSuggestions.sourceOrder',
      ],
      [
        withOwn({
          sourceOrder: ['capital_account_balance', 'capital_account_balance', 'held_multiple'],
        }),
        'valuationSuggestions.sourceOrder',
      ],
      [
        withOwn({ sourceOrder: ['capital_account_balance', 'held_multiple', 'market_multiple'] }),
        'valuationSuggestions.sourceOrder',
      ],
      [
        withOwn({ sourceOrder: [...SUGGESTION_BASES, 'capital_account_balance'] }),
        'valuationSuggestions.sourceOrder',
      ],
      [withOwn({ tieToleranceByUnit: undefined }), 'valuationSuggestions.tieToleranceByUnit.USD_K'],
      [
        withOwn({ tieToleranceByUnit: { USD_K: 2500, USD_B: 25000000 } }),
        'valuationSuggestions.tieToleranceByUnit.USD_M',
      ],
      [
        withOwn({ tieToleranceByUnit: { USD_K: 2500, USD_M: 25000, USD_B: -1 } }),
        'valuationSuggestions.tieToleranceByUnit.USD_B',
      ],
      [
        withOwn({ tieToleranceByUnit: { USD_K: 'a lot', USD_M: 25000, USD_B: 25000000 } }),
        'valuationSuggestions.tieToleranceByUnit.USD_K',
      ],
      [
        withOwn({ contributionsTolerancePct: undefined }),
        'valuationSuggestions.contributionsTolerancePct',
      ],
      [
        withOwn({ contributionsTolerancePct: '-0.02' }),
        'valuationSuggestions.contributionsTolerancePct',
      ],
      [
        withOwn({ contributionsTolerancePct: Number.NaN }),
        'valuationSuggestions.contributionsTolerancePct',
      ],
      [{ ...base, rollForwardToleranceUsd: undefined }, 'rollForwardToleranceUsd'],
      [{ ...base, valuationVarianceFlag: true }, 'valuationVarianceFlag'],
      [{ ...base, priorYearPeriodEndToleranceDays: undefined }, 'priorYearPeriodEndToleranceDays'],
      [{ ...base, priorYearPeriodEndToleranceDays: 7.5 }, 'priorYearPeriodEndToleranceDays'],
      [{ ...base, priorYearPeriodEndToleranceDays: -1 }, 'priorYearPeriodEndToleranceDays'],
    ];
    for (const [given, key] of cases) {
      let thrown: unknown = null;
      try {
        suggestionSettings(given);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, key).toBeInstanceOf(SuggestionConfigError);
      expect((thrown as SuggestionConfigError).key, JSON.stringify(given)?.slice(0, 80)).toBe(key);
      expect((thrown as Error).message).toBe(`config/definitions.json is missing a usable ${key}`);
    }
  });
});

describe('suggestionBar: when no suggestion applies', () => {
  it('lists the reasons in the order they are decided', () => {
    expect(NO_SUGGESTION_REASONS).toEqual([
      'fund_commitment',
      'private_credit',
      'not_usd',
      'not_held',
      'mark_locked',
      'dismissed',
      'on_valuation',
    ]);
    expect(SUGGESTION_DEAL_TYPES).toEqual([
      'deal_type.co_invest_equity',
      'deal_type.cv_single_asset',
      'deal_type.cv_multi_asset',
    ]);
  });

  it('passes an equity co-investment or a continuation vehicle held in dollars with no mark for the quarter', () => {
    for (const dealType of SUGGESTION_DEAL_TYPES)
      expect(suggestionBar(position({ dealType }), Q2, [locked(Q1)], 7)).toBeNull();
    expect(suggestionBar(position(), Q2, [], 7)).toBeNull();
  });

  it('bars a statement with no position and a primary fund position as our account in a fund', () => {
    expect(suggestionBar(null, Q2, [], 7)).toBe('fund_commitment');
    expect(suggestionBar(position({ dealType: 'deal_type.primary_fund' }), Q2, [], 7)).toBe(
      'fund_commitment',
    );
  });

  it('gives the first reason that applies', () => {
    const everything = position({
      dealType: 'deal_type.private_credit',
      currency: 'EUR',
      isActive: false,
    });
    const marked = [locked(Q2)];
    expect(suggestionBar(everything, Q2, marked, 7)).toBe('private_credit');
    expect(
      suggestionBar({ ...everything, dealType: 'deal_type.primary_fund' }, Q2, marked, 7),
    ).toBe('fund_commitment');
    expect(
      suggestionBar({ ...everything, dealType: 'deal_type.cv_single_asset' }, Q2, marked, 7),
    ).toBe('not_usd');
    expect(suggestionBar(position({ isActive: false }), Q2, marked, 7)).toBe('not_held');
    expect(suggestionBar(position(), Q2, marked, 7)).toBe('mark_locked');
  });

  it('counts a position as held from its entry date until the day before it exits', () => {
    expect(suggestionBar(position({ entryDate: Q2 }), Q2, [], 7)).toBeNull();
    expect(suggestionBar(position({ entryDate: '2025-07-01' }), Q2, [], 7)).toBe('not_held');
    expect(suggestionBar(position({ exitDate: '2025-07-01' }), Q2, [], 7)).toBeNull();
    expect(suggestionBar(position({ exitDate: Q2 }), Q2, [], 7)).toBe('not_held');
    expect(suggestionBar(position({ exitDate: '2025-05-15' }), Q2, [], 7)).toBe('not_held');
  });

  it('bars a quarter with a Locked mark for it or for a later one, as the valuation workflow counts marks', () => {
    // Three days early still reports for the quarter.
    expect(suggestionBar(position(), Q2, [locked('2025-06-27')], 7)).toBe('mark_locked');
    expect(suggestionBar(position(), Q2, [locked('2025-09-30')], 7)).toBe('mark_locked');
    expect(suggestionBar(position(), Q2, [locked(Q2, '1', 'Draft')], 7)).toBeNull();
    expect(suggestionBar(position(), Q2, [locked(Q2, '1', 'Reopened')], 7)).toBeNull();
    expect(suggestionBar(position(), Q2, [locked('2025-04-03')], 7)).toBeNull();
  });
});

describe('referenceOnHand: the mark a suggestion is set against', () => {
  const marks = [locked(Q1), { ...locked('2024-12-31', '6900000.00'), id: 'older' }];

  it('finds the latest Locked mark of an earlier quarter and that quarter figures', () => {
    expect(
      referenceOnHand({
        periodEnd: Q2,
        marks,
        flowDates: ['2025-03-31', '2025-07-01'],
        quarters: [quarter, { ...quarter, id: 'q4', periodEnd: '2024-12-31' }],
        toleranceDays: 7,
      }),
    ).toEqual(reference());
  });

  it('has nothing without a Locked mark of an earlier quarter', () => {
    expect(
      referenceOnHand({
        periodEnd: Q2,
        marks: [locked(Q2), locked(Q1, '1', 'Draft')],
        flowDates: ['2025-05-01'],
        quarters: [quarter],
        toleranceDays: 7,
      }),
    ).toEqual({ mark: null, flowsSince: false, quarter: null });
  });

  it('sees cash that moved after the mark and on or before the quarter end', () => {
    const at = (flowDates: string[]): boolean =>
      referenceOnHand({ periodEnd: Q2, marks, flowDates, quarters: [quarter], toleranceDays: 7 })
        .flowsSince;
    expect(at([])).toBe(false);
    expect(at([Q1])).toBe(false);
    expect(at(['2025-04-01'])).toBe(true);
    expect(at([Q2])).toBe(true);
    expect(at(['2025-07-01'])).toBe(false);
  });

  it('matches a mark dated a few days early to its quarter, and an older mark to its own figures', () => {
    const early = referenceOnHand({
      periodEnd: Q2,
      marks: [locked('2025-03-28')],
      flowDates: ['2025-03-30'],
      quarters: [{ ...quarter, periodEnd: '2025-04-02' }],
      toleranceDays: 7,
    });
    expect(early.mark).toMatchObject({
      periodEnd: '2025-03-28',
      reportsFor: Q1,
      previousQuarter: true,
      ageQuarters: 1,
    });
    // The flow is after the mark's own date, and the figures are those that report for March.
    expect(early.flowsSince).toBe(true);
    expect(early.quarter?.periodEnd).toBe('2025-04-02');

    const old = referenceOnHand({
      periodEnd: Q2,
      marks: [marks[1]!],
      flowDates: [],
      quarters: [quarter],
      toleranceDays: 7,
    });
    expect(old.mark).toMatchObject({
      valuationId: 'older',
      reportsFor: '2024-12-31',
      previousQuarter: false,
      ageQuarters: 2,
    });
    // No figures for December: March's are never used in their place.
    expect(old.quarter).toBeNull();
  });

  it('takes the later of two rows that report for the mark quarter', () => {
    const found = referenceOnHand({
      periodEnd: Q2,
      marks,
      flowDates: [],
      quarters: [
        { ...quarter, id: 'early', periodEnd: '2025-03-28' },
        { ...quarter, id: 'late', periodEnd: '2025-04-02' },
        { ...quarter, id: 'mid', periodEnd: Q1 },
      ],
      toleranceDays: 7,
    });
    expect(found.quarter?.id).toBe('late');
  });
});

describe('readSources and selectSuggestion: which source gives the suggestion', () => {
  /** A statement whose ending balance is worked example 7's 7,810,000.00. */
  const nearReport = statement({ endingBalance: line('7.81'), netGainLoss: null });

  it('has nothing to suggest when no source is on hand', () => {
    expect(readSources(sources(), SETTINGS)).toEqual({ readings: [], statement: null });
    expect(selectSuggestion(sources(), SETTINGS)).toBeNull();
  });

  it('reads a statement by rule 12.1, in dollars, with the inputs its value rests on', () => {
    const selection = selectSuggestion(sources({ statement: statement() }), SETTINGS);
    expect(selection).toEqual({
      basis: 'capital_account_balance',
      method: 'valuation_method.sponsor_mark',
      value: '20940000',
      reason: null,
      inputs: [
        {
          key: 'ending_capital_balance',
          value: '20940000',
          periodEnd: Q2,
          source: { kind: 'document', id: DOC, page: 1 },
          edited: false,
        },
      ],
      crossChecks: [],
    });
  });

  it('keeps the share of a whole-vehicle statement and a figure typed by the reviewer among the inputs', () => {
    const typed: StatementLine = {
      value: '83.76',
      unit: 'USD_M',
      source: { kind: 'reviewer', id: REVIEWER, page: null },
      edited: true,
    };
    const share: SourcedFigure = {
      value: '0.25',
      source: { kind: 'document', id: DOC, page: 1 },
      edited: false,
    };
    const selection = selectSuggestion(
      sources({ statement: statement({ endingBalance: typed, share }) }),
      SETTINGS,
    );
    expect(selection?.value).toBe('20940000');
    expect(selection?.inputs).toEqual([
      {
        key: 'ending_capital_balance',
        value: '83760000',
        periodEnd: Q2,
        source: { kind: 'reviewer', id: REVIEWER, page: null },
        edited: true,
      },
      {
        key: 'investor_share_pct',
        value: '0.25',
        periodEnd: Q2,
        source: { kind: 'document', id: DOC, page: 1 },
        edited: false,
      },
    ]);
  });

  it('reads a report that states an enterprise value by rule 12.2 and never by rule 12.3', () => {
    const { readings } = readSources(sources({ report: report() }), SETTINGS);
    expect(readings.map((r) => r.basis)).toEqual(['sponsor_equity_value']);
    expect(readings[0]).toEqual({
      basis: 'sponsor_equity_value',
      method: 'valuation_method.report_indication',
      value: '7831632.54',
      reason: null,
      inputs: [
        {
          key: 'reference_mark',
          value: '7310450.25',
          periodEnd: Q1,
          source: { kind: 'valuation', id: MARK, page: null },
          edited: false,
        },
        {
          key: 'reference_enterprise_value',
          value: '413000000.00',
          periodEnd: Q1,
          source: { kind: 'record', id: QUARTER, page: null },
          edited: false,
        },
        {
          key: 'reference_net_debt',
          value: '150000000.00',
          periodEnd: Q1,
          source: { kind: 'record', id: QUARTER, page: null },
          edited: false,
        },
        {
          key: 'enterprise_value',
          value: '428050000.00',
          periodEnd: Q2,
          source: { kind: 'document', id: REPORT_DOC, page: 3 },
          edited: false,
        },
        {
          key: 'net_debt',
          value: '146300000.00',
          periodEnd: Q2,
          source: { kind: 'document', id: REPORT_DOC, page: 4 },
          edited: false,
        },
      ],
    });
  });

  it('reads a report with no enterprise value by rule 12.3 and never by rule 12.2', () => {
    const { readings } = readSources(sources({ report: report({ ev: null }) }), SETTINGS);
    expect(readings.map((r) => r.basis)).toEqual(['held_multiple']);
    expect(readings[0]).toMatchObject({
      method: 'valuation_method.report_indication',
      value: '8136003',
      reason: null,
    });
    expect(readings[0]?.inputs.map((input) => input.key)).toEqual([
      'reference_mark',
      'reference_enterprise_value',
      'reference_net_debt',
      'reference_ebitda_ltm',
      'ebitda_ltm',
      'net_debt',
    ]);
  });

  it('lists only the inputs that are on hand', () => {
    const noMark = readSources(
      sources({
        report: report({ netDebt: null }),
        reference: reference({ mark: null, quarter: null }),
      }),
      SETTINGS,
    ).readings[0];
    expect(noMark).toMatchObject({ value: null, reason: 'no_reference_mark' });
    expect(noMark?.inputs.map((input) => input.key)).toEqual(['enterprise_value']);
    const noFigures = readSources(
      sources({
        report: report({ ev: null, ebitda: null }),
        reference: reference({ quarter: null }),
      }),
      SETTINGS,
    ).readings[0];
    expect(noFigures).toMatchObject({ value: null, reason: 'no_reference_figures' });
    expect(noFigures?.inputs.map((input) => input.key)).toEqual(['reference_mark', 'net_debt']);
    const noEbitda = readSources(
      sources({
        report: report({ ev: null }),
        reference: reference({ quarter: { ...quarter, ebitdaLtm: null } }),
      }),
      SETTINGS,
    ).readings[0];
    expect(noEbitda).toMatchObject({ value: null, reason: 'no_ebitda' });
    expect(noEbitda?.inputs.map((input) => input.key)).toEqual([
      'reference_mark',
      'reference_enterprise_value',
      'reference_net_debt',
      'ebitda_ltm',
      'net_debt',
    ]);
  });

  it('takes the statement first and sets the report beside it, never blended (worked example 7)', () => {
    const selection = selectSuggestion(
      sources({ statement: nearReport, report: report() }),
      SETTINGS,
    );
    expect(selection).toMatchObject({ basis: 'capital_account_balance', value: '7810000' });
    expect(selection?.crossChecks).toEqual([
      {
        basis: 'sponsor_equity_value',
        value: '7831632.54',
        reason: null,
        difference: '21632.54',
        differencePct: '0.0027698515',
        differs: false,
      },
    ]);
  });

  it('falls to the report when the statement has no value, and says why beside it', () => {
    const selection = selectSuggestion(
      sources({ statement: statement({ endingBalance: null }), report: report() }),
      SETTINGS,
    );
    expect(selection).toMatchObject({ basis: 'sponsor_equity_value', value: '7831632.54' });
    expect(selection?.crossChecks).toEqual([
      {
        basis: 'capital_account_balance',
        value: null,
        reason: 'no_ending_balance',
        difference: null,
        differencePct: null,
        differs: false,
      },
    ]);
    // With no enterprise value in the report either, the multiple held is the next source.
    expect(
      selectSuggestion(
        sources({ statement: statement({ endingBalance: null }), report: report({ ev: null }) }),
        SETTINGS,
      ),
    ).toMatchObject({ basis: 'held_multiple', value: '8136003' });
  });

  it('gives the reason of the first source on hand when none has a value', () => {
    const none = sources({
      statement: statement({ endingBalance: line('0.00') }),
      report: report(),
      reference: reference({ mark: null, quarter: null }),
    });
    expect(selectSuggestion(none, SETTINGS)).toMatchObject({
      basis: 'capital_account_balance',
      value: null,
      reason: 'non_positive_balance',
      crossChecks: [
        { basis: 'sponsor_equity_value', value: null, reason: 'no_reference_mark', differs: false },
      ],
    });
    expect(selectSuggestion({ ...none, statement: null }, SETTINGS)).toMatchObject({
      basis: 'sponsor_equity_value',
      value: null,
      reason: 'no_reference_mark',
      crossChecks: [],
    });
  });

  it('follows the order config gives, reversed as well', () => {
    const reversed: SuggestionSettings = {
      ...SETTINGS,
      sourceOrder: ['held_multiple', 'sponsor_equity_value', 'capital_account_balance'],
    };
    const both = sources({ statement: nearReport, report: report() });
    expect(selectSuggestion(both, reversed)).toMatchObject({
      basis: 'sponsor_equity_value',
      value: '7831632.54',
      crossChecks: [
        {
          basis: 'capital_account_balance',
          value: '7810000',
          difference: '-21632.54',
          differencePct: '-0.0027622006',
          differs: false,
        },
      ],
    });
    expect(
      selectSuggestion(sources({ statement: nearReport, report: report({ ev: null }) }), reversed),
    ).toMatchObject({ basis: 'held_multiple', value: '8136003' });
    // A first source with no value still yields to the next one.
    expect(
      selectSuggestion(
        sources({ statement: nearReport, report: report({ netDebt: null }) }),
        reversed,
      ),
    ).toMatchObject({
      basis: 'capital_account_balance',
      value: '7810000',
      crossChecks: [{ basis: 'sponsor_equity_value', value: null, reason: 'no_net_debt' }],
    });
  });

  it('takes, in every order, the first source on hand that has a value', () => {
    const orders: SuggestionBasis[][] = [];
    for (const a of SUGGESTION_BASES)
      for (const b of SUGGESTION_BASES)
        for (const c of SUGGESTION_BASES) if (new Set([a, b, c]).size === 3) orders.push([a, b, c]);
    expect(orders).toHaveLength(6);
    const situations: SuggestionSources[] = [
      sources({ statement: nearReport, report: report() }),
      sources({ statement: nearReport, report: report({ ev: null }) }),
      sources({ statement: statement({ endingBalance: null }), report: report() }),
      sources({ statement: nearReport, report: report({ netDebt: null }) }),
      sources({ statement: nearReport }),
      sources({ report: report({ ev: null, ebitda: null }) }),
    ];
    for (const sourceOrder of orders)
      for (const given of situations) {
        const settings = { ...SETTINGS, sourceOrder };
        const { readings } = readSources(given, settings);
        // The readings are those on hand, in the order config gives.
        expect(readings.map((r) => r.basis)).toEqual(
          sourceOrder.filter((basis) => readings.some((r) => r.basis === basis)),
        );
        const selection = selectSuggestion(given, settings)!;
        const expected = readings.find((r) => r.value !== null) ?? readings[0]!;
        expect(selection.basis).toBe(expected.basis);
        expect(selection.value).toBe(expected.value);
        expect(selection.crossChecks.map((check) => check.basis)).toEqual(
          readings.filter((r) => r.basis !== selection.basis).map((r) => r.basis),
        );
        // Never both report rules at once.
        expect(
          readings.filter((r) => r.basis !== 'capital_account_balance').length,
        ).toBeLessThanOrEqual(1);
      }
  });

  it('judges the tie-out by the coarsest unit the balance lines were read in', () => {
    expect(readStatement(null, Q2, '0', SETTINGS)).toBeNull();
    expect(readStatement(statement(), Q2, '12400000.00', SETTINGS)).toMatchObject({
      tieToleranceUsd: '25000',
      mark: { value: '20940000', ties: true, tieDifference: '0', ownAccount: true },
    });
    // Worked example 2: 50,000 apart does not tie in millions.
    expect(
      readStatement(statement({ netGainLoss: line('0.92') }), Q2, '0', SETTINGS)?.mark,
    ).toMatchObject({ value: '20940000', ties: false, tieDifference: '-50000' });
    // The same statement in dollars is judged to the dollar.
    const dollars = statement({
      beginningBalance: line('18420000.00', 'USD'),
      contributionsInPeriod: line('2000000.00', 'USD'),
      distributionsInPeriod: line('350000.00', 'USD'),
      netGainLoss: line('870001.01', 'USD'),
      endingBalance: line('20940000.00', 'USD'),
      contributionsToDate: line('12.40'),
    });
    expect(readStatement(dollars, Q2, '0', SETTINGS)).toMatchObject({
      tieToleranceUsd: '1',
      mark: { ties: false, tieDifference: '-1.01' },
    });
    // A line in a unit that is not money is refused, never read as dollars.
    expect(() =>
      readStatement(statement({ endingBalance: line('20.94', 'EUR_M') }), Q2, '0', SETTINGS),
    ).toThrow(CalcError);
  });

  it('refuses a period end that is not a calendar quarter end', () => {
    expect(() => selectSuggestion(sources({ periodEnd: '2025-06-27' }), SETTINGS)).toThrow(
      CalcError,
    );
  });
});

describe('suggestionReading: what is shown beside a suggestion', () => {
  /** Worked example 1: the statement against the previous quarter's mark of 18,420,000.00. */
  const exampleOne = sources({
    statement: statement(),
    reference: reference({ mark: { ...reference().mark!, value: '18420000.00' } }),
  });

  it('sets a statement-based suggestion against the mark on record, with its checks', () => {
    const stored = selectSuggestion(exampleOne, SETTINGS)!;
    const view = suggestionReading(stored, exampleOne, SETTINGS);
    expect(view.currentMark).toEqual({
      valuationId: MARK,
      value: '18420000.00',
      periodEnd: Q1,
      reportsFor: Q1,
      previousQuarter: true,
      ageQuarters: 1,
    });
    expect(view.comparison).toEqual({
      change: '2520000',
      changePct: '0.1368078176',
      variance: true,
      netOfFlows: '870000',
      netOfFlowsPct: '0.0472312704',
      beginningBalance: '18420000',
    });
    expect(view.checks).toEqual({
      ties: true,
      tieDifference: '0',
      tieToleranceUsd: '25000',
      ownAccount: true,
      contributionsCheck: {
        statement: '12400000',
        record: '12400000',
        difference: '0',
        differencePct: '0',
        differs: false,
        notChecked: null,
      },
    });
    expect(view.crossChecks).toEqual([]);
    expect(view.flags).toEqual({
      variance: true,
      ties: true,
      contributionsDiffer: false,
      sourcesDiffer: false,
      editedByReviewer: false,
    });
  });

  it('raises each badge from its own check and changes no value', () => {
    const given = sources({
      // Worked examples 2 and 8: lines 50,000 apart, contributions to date of 30.00.
      statement: statement({ netGainLoss: line('0.92'), contributionsToDate: line('30.00') }),
      report: report(),
    });
    const stored = selectSuggestion(given, SETTINGS)!;
    expect(stored.value).toBe('20940000');
    const view = suggestionReading(
      { ...stored, inputs: stored.inputs.map((input) => ({ ...input, edited: true })) },
      given,
      SETTINGS,
    );
    // The mark on record is far from the statement, and so is the report's indication.
    expect(view.flags).toEqual({
      variance: true,
      ties: false,
      contributionsDiffer: true,
      sourcesDiffer: true,
      editedByReviewer: true,
    });
    expect(view.checks?.contributionsCheck).toMatchObject({
      difference: '17600000',
      differencePct: '1.4193548387',
      differs: true,
    });
    expect(view.crossChecks).toMatchObject([
      { basis: 'sponsor_equity_value', value: '7831632.54', differs: true },
    ]);
    // The statement starts 11 million off the record, so there is no net of flows.
    expect(view.comparison).toMatchObject({ netOfFlows: null, beginningBalance: '18420000' });
  });

  it('has no checks for a report-based suggestion, and shows the statement beside it', () => {
    const given = sources({ statement: statement({ endingBalance: null }), report: report() });
    const stored = selectSuggestion(given, SETTINGS)!;
    const view = suggestionReading(stored, given, SETTINGS);
    expect(view.checks).toBeNull();
    expect(view.comparison).toEqual({
      change: '521182.29',
      changePct: '0.0712927757',
      variance: false,
      netOfFlows: null,
      netOfFlowsPct: null,
      beginningBalance: null,
    });
    expect(view.crossChecks).toMatchObject([
      { basis: 'capital_account_balance', value: null, reason: 'no_ending_balance' },
    ]);
    expect(view.flags).toEqual({
      variance: false,
      ties: null,
      contributionsDiffer: false,
      sourcesDiffer: false,
      editedByReviewer: false,
    });
  });

  it('shows no change against a mark that is missing or older than the previous quarter flag', () => {
    const noMark = sources({
      statement: statement(),
      reference: { mark: null, flowsSince: false, quarter: null },
    });
    const stored = selectSuggestion(noMark, SETTINGS)!;
    expect(suggestionReading(stored, noMark, SETTINGS)).toMatchObject({
      currentMark: null,
      comparison: { change: null, changePct: null, variance: false, netOfFlows: null },
    });
    const old = sources({
      statement: statement(),
      reference: reference({
        mark: {
          ...reference().mark!,
          value: '18420000.00',
          periodEnd: '2024-12-31',
          reportsFor: '2024-12-31',
          previousQuarter: false,
          ageQuarters: 2,
        },
        quarter: null,
      }),
    });
    expect(suggestionReading(stored, old, SETTINGS).comparison).toMatchObject({
      change: '2520000',
      changePct: '0.1368078176',
      variance: false,
      netOfFlows: null,
    });
  });

  it('reads a suggestion with no value: its reason stands and nothing is compared', () => {
    const given = sources({ statement: statement({ endingBalance: null }) });
    const stored = selectSuggestion(given, SETTINGS)!;
    expect(stored).toMatchObject({ value: null, reason: 'no_ending_balance', inputs: [] });
    expect(suggestionReading(stored, given, SETTINGS)).toMatchObject({
      comparison: { change: null, variance: false },
      checks: { ties: null, tieDifference: null },
      flags: { variance: false, ties: null, sourcesDiffer: false },
    });
  });
});

describe('sameSuggestion: the same basis, value and inputs', () => {
  const stored = selectSuggestion(sources({ report: report() }), SETTINGS)!;

  it('holds for the same figures wherever they came from and however they are written', () => {
    expect(sameSuggestion(stored, stored)).toBe(true);
    expect(
      sameSuggestion(stored, {
        ...stored,
        value: '7831632.540',
        inputs: [...stored.inputs].reverse().map((input) => ({
          ...input,
          value: `${input.value}0`,
          source: { kind: 'reviewer' as const, id: REVIEWER, page: null },
          edited: true,
        })),
      }),
    ).toBe(true);
  });

  it('fails on another basis, value, reason, input figure, input period or set of inputs', () => {
    const first = stored.inputs[0]!;
    const others: Partial<Selection>[] = [
      { basis: 'held_multiple' },
      { value: '7831632.55' },
      { value: null, reason: 'no_net_debt' },
      { inputs: [{ ...first, value: '7310450.26' }, ...stored.inputs.slice(1)] },
      { inputs: [{ ...first, periodEnd: '2024-12-31' }, ...stored.inputs.slice(1)] },
      { inputs: stored.inputs.slice(1) },
      { inputs: [...stored.inputs.slice(1), { ...first, key: 'ebitda_ltm' }] },
    ];
    for (const other of others) {
      expect(sameSuggestion(stored, { ...stored, ...other }), JSON.stringify(other)).toBe(false);
      expect(sameSuggestion({ ...stored, ...other }, stored), JSON.stringify(other)).toBe(false);
    }
    // Two suggestions with no value are the same only for the same reason.
    const none = { ...stored, value: null, reason: 'no_net_debt' as const };
    expect(sameSuggestion(none, { ...none })).toBe(true);
    expect(sameSuggestion(none, { ...none, reason: 'non_positive_equity' })).toBe(false);
  });
});

describe('derivationStep: what an approval does to the suggestions of a quarter', () => {
  const fromReportOnly = selectSuggestion(sources({ report: report() }), SETTINGS)!;
  const withStatement = selectSuggestion(
    sources({ statement: statement(), report: report() }),
    SETTINGS,
  )!;
  const prior = (
    selection: Selection,
    state: PriorSuggestion['state'],
    valuationState: PriorSuggestion['valuationState'] = null,
  ): PriorSuggestion => ({
    id: `${state}-${selection.basis}`,
    state,
    basis: selection.basis,
    value: selection.value,
    reason: selection.reason,
    inputs: selection.inputs,
    valuationState,
  });
  const step = (over: Partial<DerivationInput>) =>
    derivationStep({
      bar: null,
      selection: null,
      open: null,
      decided: [],
      sourceOrder: SETTINGS.sourceOrder,
      mode: 'approval',
      ...over,
    });

  it('lists the reasons a suggestion is superseded for', () => {
    expect(SUPERSEDED_REASONS).toEqual([
      'better_source',
      'figures_changed',
      'mark_locked',
      'position_closed',
    ]);
  });

  it('writes nothing while a bar applies, and closes the Open suggestion with its reason', () => {
    const open = prior(fromReportOnly, 'Open');
    for (const bar of ['fund_commitment', 'private_credit', 'not_usd', 'not_held'] as const) {
      expect(step({ bar, selection: withStatement })).toEqual({ action: 'none', because: bar });
      expect(step({ bar, selection: withStatement, open })).toEqual({
        action: 'close',
        supersede: { id: open.id, reason: 'position_closed' },
        because: bar,
      });
    }
    expect(step({ bar: 'mark_locked', selection: withStatement })).toEqual({
      action: 'none',
      because: 'mark_locked',
    });
    expect(step({ bar: 'mark_locked', selection: withStatement, open, mode: 'refresh' })).toEqual({
      action: 'close',
      supersede: { id: open.id, reason: 'mark_locked' },
      because: 'mark_locked',
    });
  });

  it('has nothing to do with no source on hand, and closes an Open suggestion left without one', () => {
    expect(step({})).toEqual({ action: 'none', because: 'nothing_on_hand' });
    const open = prior(fromReportOnly, 'Open');
    expect(step({ open })).toEqual({
      action: 'close',
      supersede: { id: open.id, reason: 'figures_changed' },
      because: 'nothing_on_hand',
    });
  });

  it('opens a suggestion on an approval and never on a refresh', () => {
    expect(step({ selection: fromReportOnly })).toEqual({
      action: 'open',
      selection: fromReportOnly,
    });
    expect(step({ selection: fromReportOnly, mode: 'refresh' })).toEqual({
      action: 'none',
      because: 'none_open',
    });
    // A suggestion with no value is opened as well: it says why there is none.
    const none = selectSuggestion(
      sources({ statement: statement({ endingBalance: null }) }),
      SETTINGS,
    )!;
    expect(step({ selection: none })).toEqual({ action: 'open', selection: none });
  });

  it('leaves an Open suggestion that says the same, on an approval and on a refresh', () => {
    const open = prior(withStatement, 'Open');
    for (const mode of ['approval', 'refresh'] as const)
      expect(step({ selection: withStatement, open, mode })).toEqual({
        action: 'none',
        because: 'unchanged',
      });
  });

  it('runs the example sequence both ways', () => {
    // The report first: a suggestion by rule 12.2. Then the statement supersedes it.
    const first = step({ selection: fromReportOnly });
    expect(first).toMatchObject({ action: 'open', selection: { basis: 'sponsor_equity_value' } });
    const open = prior(fromReportOnly, 'Open');
    expect(step({ selection: withStatement, open })).toEqual({
      action: 'replace',
      supersede: { id: open.id, reason: 'better_source' },
      selection: withStatement,
    });
    expect(withStatement.crossChecks).toMatchObject([
      { basis: 'sponsor_equity_value', value: '7831632.54' },
    ]);
    // The statement first: rule 12.1 at once. The report then changes only the cross-check.
    const statementOnly = selectSuggestion(sources({ statement: statement() }), SETTINGS)!;
    expect(step({ selection: statementOnly })).toMatchObject({
      action: 'open',
      selection: { basis: 'capital_account_balance', crossChecks: [] },
    });
    expect(step({ selection: withStatement, open: prior(statementOnly, 'Open') })).toEqual({
      action: 'none',
      because: 'unchanged',
    });
  });

  it('replaces an Open suggestion whose figures changed: the later of two statements counts', () => {
    const open = prior(withStatement, 'Open');
    const later = selectSuggestion(
      sources({ statement: statement({ endingBalance: line('21.10') }), report: report() }),
      SETTINGS,
    )!;
    for (const mode of ['approval', 'refresh'] as const)
      expect(step({ selection: later, open, mode })).toEqual({
        action: 'replace',
        supersede: { id: open.id, reason: 'figures_changed' },
        selection: later,
      });
    // A later statement with no value falls to the report: the figures changed, the source is no better.
    expect(step({ selection: fromReportOnly, open })).toEqual({
      action: 'replace',
      supersede: { id: open.id, reason: 'figures_changed' },
      selection: fromReportOnly,
    });
    // What makes a source better is the order config gives.
    expect(
      step({
        selection: fromReportOnly,
        open,
        sourceOrder: ['held_multiple', 'sponsor_equity_value', 'capital_account_balance'],
      }),
    ).toMatchObject({ action: 'replace', supersede: { reason: 'better_source' } });
  });

  it('does not raise again what was dismissed', () => {
    const dismissed = prior(fromReportOnly, 'Dismissed');
    expect(step({ selection: fromReportOnly, decided: [dismissed] })).toEqual({
      action: 'none',
      because: 'dismissed',
    });
    // Another value from the same source is a new suggestion.
    expect(step({ selection: withStatement, decided: [dismissed] })).toEqual({
      action: 'open',
      selection: withStatement,
    });
    // An Open suggestion that no longer says what the sources do is closed, and the dismissed one stays dismissed.
    const open = prior(withStatement, 'Open');
    expect(step({ selection: fromReportOnly, open, decided: [dismissed] })).toEqual({
      action: 'close',
      supersede: { id: open.id, reason: 'figures_changed' },
      because: 'dismissed',
    });
  });

  it('does not raise again what is on a valuation in progress or Locked', () => {
    for (const state of ['Draft', 'OpsPrepared', 'DealTeamApproved', 'Locked'] as const)
      expect(
        step({ selection: withStatement, decided: [prior(withStatement, 'Accepted', state)] }),
        state,
      ).toEqual({ action: 'none', because: 'on_valuation' });
    // A version that was reopened no longer carries it, and a superseded suggestion never did.
    for (const decided of [
      [prior(withStatement, 'Accepted', 'Reopened')],
      [prior(withStatement, 'Accepted', null)],
      [prior(withStatement, 'Superseded')],
    ])
      expect(step({ selection: withStatement, decided })).toEqual({
        action: 'open',
        selection: withStatement,
      });
    // Dismissed is the reason given when both apply.
    expect(
      step({
        selection: withStatement,
        decided: [prior(withStatement, 'Accepted', 'Draft'), prior(withStatement, 'Dismissed')],
      }),
    ).toEqual({ action: 'none', because: 'dismissed' });
  });
});

describe('the keys of a draft valuation opened from a suggestion', () => {
  const selection = selectSuggestion(
    sources({ statement: statement(), report: report() }),
    SETTINGS,
  )!;
  const accepted = {
    id: 'a0000000-0000-4000-8000-000000000001',
    basis: selection.basis,
    value: '20940000.00',
    periodEnd: Q2,
    documentId: DOC,
    page: 1,
    runId: 'b0000000-0000-4000-8000-000000000001',
    inputs: selection.inputs,
    crossChecks: selection.crossChecks,
  };

  it('are flat names to text, with nothing for a missing figure', () => {
    expect(SUGGESTION_KEY_PREFIX).toBe('suggestion.');
    expect(suggestionDraftKeys(accepted)).toEqual({
      'suggestion.id': accepted.id,
      'suggestion.basis': 'capital_account_balance',
      'suggestion.value': '20940000.00',
      'suggestion.periodEnd': Q2,
      'suggestion.documentId': DOC,
      'suggestion.page': '1',
      'suggestion.runId': accepted.runId,
      'suggestion.input.ending_capital_balance': '20940000',
      'suggestion.crossCheck.sponsor_equity_value': '7831632.54',
    });
    expect(
      suggestionDraftKeys({
        ...accepted,
        documentId: null,
        page: null,
        crossChecks: [{ basis: 'sponsor_equity_value', value: null }],
      }),
    ).toEqual({
      'suggestion.id': accepted.id,
      'suggestion.basis': 'capital_account_balance',
      'suggestion.value': '20940000.00',
      'suggestion.periodEnd': Q2,
      'suggestion.runId': accepted.runId,
      'suggestion.input.ending_capital_balance': '20940000',
    });
  });

  it('replace the keys an earlier suggestion left and keep every other input', () => {
    const before = {
      basis: 'LTM EBITDA',
      multiple: 11.5,
      'suggestion.id': 'earlier',
      'suggestion.input.enterprise_value': '428050000.00',
      'suggestion.crossCheck.capital_account_balance': '7810000',
    };
    expect(withSuggestionKeys(before, suggestionDraftKeys(accepted))).toEqual({
      basis: 'LTM EBITDA',
      multiple: 11.5,
      ...suggestionDraftKeys(accepted),
    });
    expect(withSuggestionKeys({}, {})).toEqual({});
  });

  it('survive an edit of the draft whatever the edit sends for them', () => {
    const stored = { note: 'as received', ...suggestionDraftKeys(accepted) };
    // An edit that tries to change one, drop the rest and add its own keeps them all as stored.
    expect(
      keepSuggestionKeys(stored, {
        note: 'checked with the sponsor',
        multiple: 12,
        'suggestion.value': '1.00',
        'suggestion.other': 'added by hand',
      }),
    ).toEqual({
      note: 'checked with the sponsor',
      multiple: 12,
      ...suggestionDraftKeys(accepted),
    });
    // Clearing the inputs clears only what a person typed.
    expect(keepSuggestionKeys(stored, {})).toEqual(suggestionDraftKeys(accepted));
    // A draft that carries no suggestion takes no suggestion key from an edit either.
    expect(keepSuggestionKeys({ note: 'x' }, { 'suggestion.id': 'typed', note: 'y' })).toEqual({
      note: 'y',
    });
  });
});

describe('sourceReviewersOf: who stood behind the suggestions on a valuation', () => {
  it('is the union over the Accepted suggestions, each person once', () => {
    expect(
      sourceReviewersOf([
        { state: 'Accepted', sourceReviewerIds: ['b', 'a'] },
        { state: 'Accepted', sourceReviewerIds: ['a', 'c'] },
        { state: 'Dismissed', sourceReviewerIds: ['d'] },
        { state: 'Superseded', sourceReviewerIds: ['e'] },
        { state: 'Open', sourceReviewerIds: ['f'] },
      ]),
    ).toEqual(['a', 'b', 'c']);
    expect(sourceReviewersOf([])).toEqual([]);
  });
});

describe('what the suggestion machine reads (docs/18 section 14)', () => {
  const SYSTEM = '00000000-0000-4000-8000-000000000000';
  const OPS = '10000000-0000-4000-8000-000000000003';
  const decide = (
    command: 'accept' | 'applyToDraft',
    value: string | null,
    states: string[],
  ): boolean =>
    attempt(valuationSuggestionMachine, 'Open', command, {
      actorId: OPS,
      actorRoles: ['operations'],
      record: {
        ...suggestionCommandRecord(
          value,
          states.map((state) => ({ state })),
        ),
      },
    }).ok;

  it('opens a draft valuation only while no version of the quarter is in progress', () => {
    expect(suggestionCommandRecord('20940000', [])).toEqual({
      hasValue: true,
      versionInProgress: false,
      draftOpen: false,
    });
    expect(decide('accept', '20940000', [])).toBe(true);
    expect(decide('applyToDraft', '20940000', [])).toBe(false);
    // A version that was reopened is history: its successor is what counts.
    expect(decide('accept', '20940000', ['Reopened'])).toBe(true);
    for (const state of ['Draft', 'OpsPrepared', 'DealTeamApproved'])
      expect(decide('accept', '20940000', ['Reopened', state]), state).toBe(false);
  });

  it('puts the value on the Draft of the quarter, and on no version past Draft', () => {
    expect(
      suggestionCommandRecord('20940000', [{ state: 'Reopened' }, { state: 'Draft' }]),
    ).toEqual({ hasValue: true, versionInProgress: true, draftOpen: true });
    expect(decide('applyToDraft', '20940000', ['Draft'])).toBe(true);
    for (const state of ['OpsPrepared', 'DealTeamApproved', 'Locked', 'Reopened']) {
      expect(decide('applyToDraft', '20940000', [state]), state).toBe(false);
      expect(suggestionCommandRecord('1', [{ state }]).draftOpen, state).toBe(false);
    }
  });

  it('decides nothing for a suggestion with no value', () => {
    expect(suggestionCommandRecord(null, [{ state: 'Draft' }]).hasValue).toBe(false);
    expect(decide('accept', null, [])).toBe(false);
    expect(decide('applyToDraft', null, ['Draft'])).toBe(false);
  });

  it('supersedes, as the system actor, for every reason a derivation gives', () => {
    const fromReport = selectSuggestion(sources({ report: report() }), SETTINGS)!;
    const fromStatement = selectSuggestion(
      sources({ statement: statement(), report: report() }),
      SETTINGS,
    )!;
    const open: PriorSuggestion = {
      id: 'open',
      state: 'Open',
      basis: fromReport.basis,
      value: fromReport.value,
      reason: fromReport.reason,
      inputs: fromReport.inputs,
      valuationState: null,
    };
    const base: DerivationInput = {
      bar: null,
      selection: fromStatement,
      open,
      decided: [],
      sourceOrder: SETTINGS.sourceOrder,
      mode: 'approval',
    };
    const steps = [
      derivationStep(base),
      derivationStep({ ...base, sourceOrder: [...SETTINGS.sourceOrder].reverse() }),
      derivationStep({ ...base, bar: 'mark_locked' }),
      derivationStep({ ...base, bar: 'not_held' }),
      derivationStep({ ...base, selection: null }),
    ];
    const reasons = steps.map((step) =>
      step.action === 'close' || step.action === 'replace' ? step.supersede.reason : null,
    );
    expect(reasons).toEqual([
      'better_source',
      'figures_changed',
      'mark_locked',
      'position_closed',
      'figures_changed',
    ]);
    expect(new Set(reasons)).toEqual(new Set(SUPERSEDED_REASONS));
    for (const supersededReason of reasons)
      expect(
        attempt(valuationSuggestionMachine, 'Open', 'supersede', {
          actorId: SYSTEM,
          actorRoles: ['service'],
          record: { supersededReason },
        }),
        String(supersededReason),
      ).toEqual({ ok: true, to: 'Superseded' });
  });
});

describe('the refusals and the names both sides share', () => {
  it('are worded once', () => {
    expect(SUGGESTION_CHANGED_REFUSAL).toBe(
      'The figures behind this suggestion changed. It has been replaced or closed.',
    );
    expect(SUGGESTION_BUSY_REFUSAL).toBe(
      'Another approval for this position and quarter is in progress. Try again.',
    );
    expect(SUGGESTIONS_OFF_REFUSAL).toBe(
      'Suggestions are switched off. Open ones can be read and dismissed.',
    );
    expect(SUGGESTION_SOURCE_KINDS).toEqual(['document', 'reviewer', 'record', 'valuation']);
  });
});
