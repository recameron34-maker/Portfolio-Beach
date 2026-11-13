import { describe, expect, it } from 'vitest';
import { PLAN_METRIC_REASONS, PLAN_PATH_REASONS, PLAN_PROGRESS_REASONS } from '@pb/calc';
import { MISSING } from '../../lib/format.js';
import {
  byLine,
  caseActions,
  comparableVersions,
  draftLabel,
  driverRows,
  formatPoints,
  formatSignedMoic,
  formatSignedPct,
  irrReasonText,
  irrTile,
  METRIC_REASON_TEXT,
  metricTile,
  moicTile,
  OWN_FIGURES,
  PATH_REASON_TEXT,
  planChart,
  PROGRESS_REASON_TEXT,
  progressNotes,
  sourcePlace,
  STALE_CASE,
  versionLabels,
  YIELD_NOTE,
  yieldTiles,
} from './underwriting.js';
import type { CaseActions, PlanMetricRow, PlanProgress, PlanReturns } from './underwriting.js';
import { formatSignedMoneyM, formatSignedTurns } from '../analytics/value-creation.js';
import {
  caseFixture,
  draftFixture,
  loanCaseFixture,
  readFixture,
  reunderwriteFixture,
  UW_PERSON,
  withKinds,
} from './underwriting.fixtures.js';

const comparison = (inputs: Parameters<typeof readFixture>[0] = {}) => {
  const read = readFixture(inputs);
  if (read.comparison === null) throw new Error('the fixture has no comparison');
  return read.comparison;
};
const metric = (name: PlanMetricRow['metric'], rows: readonly PlanMetricRow[]): PlanMetricRow => {
  const row = rows.find((r) => r.metric === name);
  if (row === undefined) throw new Error(`no ${name} row`);
  return row;
};
const returnsOf = (overrides: Partial<PlanReturns> = {}): PlanReturns => ({
  ...comparison().returns,
  ...overrides,
});

describe('base case card: figures in words', () => {
  it('signs a percent, a gap in points and a gap in MOIC, and keeps the placeholder for none', () => {
    expect(formatSignedPct('0.0082')).toBe('+0.8%');
    expect(formatSignedPct('-0.0719523373')).toBe('-7.2%');
    expect(formatSignedPct('0')).toBe('0.0%');
    // A figure that rounds to nothing claims no direction.
    expect(formatSignedPct('0.0004')).toBe('0.0%');
    expect(formatSignedPct('-0.0004')).toBe('0.0%');
    // One rule for every signed figure on the card: the drivers table follows it too.
    expect(formatSignedMoneyM('40000')).toBe('$0.0M');
    expect(formatSignedMoneyM('-40000')).toBe('$0.0M');
    expect(formatSignedMoneyM('5000000')).toBe('+$5.0M');
    expect(formatSignedMoneyM('-1300000')).toBe('-$1.3M');
    expect(formatSignedMoneyM(null)).toBe(MISSING);
    expect(formatSignedTurns('0.04')).toBe('0.0x');
    expect(formatSignedTurns('1')).toBe('+1.0x');
    expect(formatSignedTurns('-0.2')).toBe('-0.2x');
    expect(formatPoints('-0.0002')).toBe('0.0 points');
    expect(formatSignedMoic('0.004')).toBe('0.00x');
    expect(formatSignedPct(null)).toBe(MISSING);
    expect(formatPoints('-0.0598245749')).toBe('-6.0 points');
    expect(formatPoints('0.031')).toBe('+3.1 points');
    expect(formatPoints(null)).toBe(MISSING);
    expect(formatSignedMoic('-0.14')).toBe('-0.14x');
    expect(formatSignedMoic('0.2')).toBe('+0.20x');
    expect(formatSignedMoic(null)).toBe(MISSING);
  });

  it('words every reason the calculation library can give', () => {
    for (const reason of PLAN_METRIC_REASONS) expect(METRIC_REASON_TEXT[reason]).toMatch(/\.$/);
    for (const reason of PLAN_PROGRESS_REASONS) expect(PROGRESS_REASON_TEXT[reason]).toMatch(/\.$/);
    for (const reason of PLAN_PATH_REASONS) expect(PATH_REASON_TEXT[reason]).toMatch(/\.$/);
    expect(METRIC_REASON_TEXT).toEqual({
      no_current_quarter: 'No approved quarter to compare.',
      before_plan_start: 'Before the plan starts.',
      past_plan_end: 'After the plan ends.',
      missing_plan_figure: 'The plan has no figure here.',
      missing_actual: 'No approved figure this quarter.',
      non_positive_plan: 'The plan figure is zero or less.',
    });
    expect(PROGRESS_REASON_TEXT.no_entry_snapshot).toBe('No entry snapshot recorded.');
    expect(PROGRESS_REASON_TEXT.entry_snapshot_forward_dated).toBe(
      'The entry snapshot is dated after the as-of date.',
    );
    expect(PROGRESS_REASON_TEXT.missing_figures).toBe(
      'A figure is missing at entry or in this quarter.',
    );
    expect(PROGRESS_REASON_TEXT.non_positive_ebitda).toBe('EBITDA is zero or less.');
    expect(irrReasonText('short_period')).toBe('Held under a year, so the IRR is not judged.');
    expect(irrReasonText('no_valuation')).toBe('No locked valuation yet.');
    for (const flag of ['multiple_irr', 'no_root', 'same_sign', 'no_convergence'] as const)
      expect(irrReasonText(flag)).toBe('The cash flows give no single IRR.');
  });
});

describe('base case card: the tiles', () => {
  it('sets each company figure against plan with both amounts and its status', () => {
    const rows = comparison().metrics;
    expect(metricTile(metric('ebitda', rows))).toEqual({
      label: 'EBITDA against plan',
      value: '-7.1%',
      hint: '$65.0M against a plan of $70.0M',
      status: 'behind',
    });
    expect(metricTile(metric('revenue', rows))).toEqual({
      label: 'Revenue against plan',
      value: '+6.7%',
      hint: '$320.0M against a plan of $300.0M',
      status: 'ahead',
    });
    // More debt than planned, inside the tolerance: the percent is the plain one, the status the favourable side's.
    expect(metricTile(metric('net_debt', rows))).toEqual({
      label: 'Net debt against plan',
      value: '+1.7%',
      hint: '$120.0M against a plan of $118.0M',
      status: 'on_plan',
    });
  });

  it('shows the placeholder with the reason for a figure that is not calculable, never a zero', () => {
    // No approved quarter on or before the as-of date.
    const none = comparison({
      inputs: {
        current: null,
        quarters: [],
        bridge: null,
        bridgeNotCalculable: 'no_current_quarter',
      },
    });
    expect(metricTile(metric('ebitda', none.metrics))).toEqual({
      label: 'EBITDA against plan',
      value: MISSING,
      hint: 'No approved quarter to compare.',
      status: null,
    });
    // The quarter lacks EBITDA.
    const gap = comparison({
      inputs: {
        current: {
          periodEnd: '2023-06-30',
          revenueLtm: '320000000.00',
          ebitdaLtm: null,
          netDebt: '120000000.00',
        },
      },
    });
    expect(metricTile(metric('ebitda', gap.metrics)).hint).toBe('No approved figure this quarter.');
    // A plan in net cash: the variance in money stands, the percent does not.
    const netCash = comparison({
      versions: [
        caseFixture({
          points: caseFixture().points.map((p) => ({ ...p, netDebt: '-8000000.00' })),
        }),
      ],
    });
    expect(metricTile(metric('net_debt', netCash.metrics))).toEqual({
      label: 'Net debt against plan',
      value: MISSING,
      hint: '$120.0M against a plan of -$8.0M. The plan figure is zero or less.',
      status: null,
    });
  });

  it('judges the gross IRR in points, and leaves a flagged IRR unjudged with its reason', () => {
    expect(irrTile(returnsOf(), '0.20000000')).toEqual({
      label: 'Gross IRR against plan',
      value: '-6.0 points',
      hint: '14.0% against 20.0% underwritten',
      status: 'behind',
    });
    expect(irrTile(returnsOf({ irrFlag: 'short_period', irrStatus: null }), '0.2')).toEqual({
      label: 'Gross IRR against plan',
      value: 'NM',
      hint: 'Held under a year, so the IRR is not judged.',
      status: null,
    });
    expect(
      irrTile(
        returnsOf({ irrFlag: 'no_valuation', grossIrr: null, irrGap: null, irrStatus: null }),
        '0.2',
      ),
    ).toEqual({
      label: 'Gross IRR against plan',
      value: MISSING,
      hint: 'No locked valuation yet.',
      status: null,
    });
    expect(irrTile(returnsOf({ irrFlag: 'same_sign', irrStatus: null }), '0.2').hint).toBe(
      'The cash flows give no single IRR.',
    );
  });

  it('sets the gross MOIC against the underwritten path while held and the exit target once realized', () => {
    expect(moicTile(returnsOf(), '2.500000')).toEqual({
      label: 'Gross MOIC',
      value: '1.30x',
      hint: '-0.14x against 1.44x on the underwritten path; 2.50x at exit',
      status: null,
    });
    expect(
      moicTile(
        returnsOf({ moicOnPath: null, moicGap: null, pathNotCalculable: 'past_plan_end' }),
        '2.5',
      ).hint,
    ).toBe('No figure on the underwritten path: After the plan ends. Underwritten 2.50x at exit.');
    expect(
      moicTile(
        returnsOf({ moicOnPath: null, moicGap: null, pathNotCalculable: 'no_invested_capital' }),
        '2.5',
      ).hint,
    ).toBe(
      'No figure on the underwritten path: Nothing invested by this date. Underwritten 2.50x at exit.',
    );
    // No Locked valuation yet: the MOIC is the placeholder, and the tile says why before the path.
    expect(
      moicTile(
        returnsOf({ grossMoic: null, moicGap: null, irrFlag: 'no_valuation', moicOnPath: '1.44' }),
        '2.5',
      ),
    ).toEqual({
      label: 'Gross MOIC',
      value: MISSING,
      hint: 'No locked valuation yet. 1.44x on the underwritten path; 2.50x at exit',
      status: null,
    });
    // Missing for any other cause, the tile still says the figure is not calculable.
    expect(
      moicTile(returnsOf({ grossMoic: null, moicGap: null, moicOnPath: '1.44' }), '2.5').hint,
    ).toBe('Not calculable this quarter. 1.44x on the underwritten path; 2.50x at exit');
    // Nothing invested is already the reason the path gives.
    expect(
      moicTile(
        returnsOf({
          grossMoic: null,
          moicOnPath: null,
          moicGap: null,
          pathNotCalculable: 'no_invested_capital',
        }),
        '2.5',
      ).hint,
    ).toBe(
      'No figure on the underwritten path: Nothing invested by this date. Underwritten 2.50x at exit.',
    );
    // Realized: the calculation library's own answer for a position no longer held.
    const realized = comparison({ inputs: { isActive: false, grossMoic: '2.1' } }).returns;
    expect(moicTile(realized, '2.500000')).toEqual({
      label: 'Gross MOIC',
      value: '2.10x',
      hint: '-0.40x against 2.50x underwritten at exit',
      status: null,
    });
  });

  it('judges a loan on its IRR alone, and sets its MOIC against the path to its repayment', () => {
    const loan = comparison({ form: 'credit' });
    // Rule 6: nothing of a company plan travels with a loan.
    expect([loan.quarter, loan.metrics, loan.headline, loan.series, loan.valueCreation]).toEqual([
      null,
      [],
      null,
      [],
      null,
    ]);
    expect(irrTile(loan.returns, '0.10000000')).toEqual({
      label: 'Gross IRR against plan',
      value: '-4.9 points',
      hint: '5.1% against 10.0% underwritten',
      status: 'behind',
    });
    expect(moicTile(loan.returns, '1.500000', 'repayment')).toEqual({
      label: 'Gross MOIC',
      value: '1.10x',
      hint: '-0.10x against 1.20x on the underwritten path; 1.50x at repayment',
      status: null,
    });
    // Marked at par the same loan is on its path exactly: no gap, and no sign on nothing.
    const atPar = comparison({
      form: 'credit',
      inputs: { grossMoic: '1.2', grossIrr: '0.1' },
    }).returns;
    expect(irrTile(atPar, '0.1')).toMatchObject({ value: '0.0 points', status: 'on_plan' });
    expect(moicTile(atPar, '1.5', 'repayment').hint).toBe(
      '0.00x against 1.20x on the underwritten path; 1.50x at repayment',
    );
    // Repaid: its final MOIC against the one underwritten at repayment.
    const repaid = comparison({
      form: 'credit',
      inputs: { isActive: false, grossMoic: '1.45' },
    }).returns;
    expect(moicTile(repaid, '1.5', 'repayment').hint).toBe(
      '-0.05x against 1.50x underwritten at repayment',
    );
  });

  it("shows a loan's yields to two decimals with no status, and says why one is missing", () => {
    const loan = comparison({ form: 'credit' });
    expect(yieldTiles(loan.yieldToMaturity, loanCaseFixture())).toEqual([
      {
        label: 'Yield to maturity',
        value: '14.37%',
        hint: 'On the fair value of the latest approved credit quarter',
        status: null,
      },
      {
        label: 'Underwritten yield',
        value: '11.50%',
        hint: 'Annual yield, as underwritten at entry',
        status: null,
      },
      {
        label: 'Underwritten loss rate',
        value: '1.50%',
        hint: 'Expected loss a year',
        status: null,
      },
    ]);
    // Past maturity, or with no priced quarter: the placeholder and its reason, never a zero.
    const [ytm, , lossRate] = yieldTiles(null, loanCaseFixture({ annualLossRate: null }));
    expect(ytm).toMatchObject({ value: MISSING, hint: 'Not calculable this quarter.' });
    expect(lossRate).toMatchObject({ value: MISSING, hint: 'None was underwritten.' });
    // A loss rate of nothing is a figure, and it is shown.
    expect(yieldTiles('0.1', loanCaseFixture({ annualLossRate: '0.00000000' }))[2]).toMatchObject({
      value: '0.00%',
      hint: 'Expected loss a year',
    });
    // The yield is priced on the credit quarter's fair value, which a Locked mark of ours leaves as it is.
    expect(YIELD_NOTE).toBe(
      'Yield to maturity is priced on the fair value of the latest approved credit quarter, which our own mark does not change. It rises when that fair value falls, so it is not judged.',
    );
  });
});

describe('base case card: the chart and the drivers', () => {
  it('lists every date once, with a gap where a quarter or a plan figure is missing', () => {
    const series = comparison().series.find((s) => s.metric === 'ebitda');
    if (series === undefined) throw new Error('no EBITDA series');
    expect(planChart(series, comparison().series)).toEqual({
      x: ['Jun 2021', 'Dec 2022', 'Mar 2023', 'Jun 2023', 'Dec 2023', 'Jun 2026'],
      // Days from the first plan date: the quarter is day 730 of the 1,826 to the planned exit.
      at: [0, 549, 639, 730, 914, 1826],
      actual: [null, 60000000, null, 65000000, null, null],
      // March 2023 is an approved quarter with no EBITDA: a gap. The other dates without an
      // actual are plan dates no quarter ends on, where the actual line has no point to miss.
      actualAbsent: [true, false, false, false, true, true],
      plan: [40000000, 66380000, 68180000, 70000000, 73680000, 80000000],
    });
    // A plan dated off the quarter ends (a January year end): the date between two quarters is
    // not a missing quarter, so the actual line runs over it.
    const offQuarter = planChart({
      metric: 'ebitda',
      points: [
        { periodEnd: '2022-12-31', actual: '10', plan: '9', interpolated: true },
        { periodEnd: '2023-01-31', actual: null, plan: '12', interpolated: false },
        { periodEnd: '2023-03-31', actual: '11', plan: '12.5', interpolated: true },
      ],
    });
    expect(offQuarter.actual).toEqual([10, null, 11]);
    expect(offQuarter.actualAbsent).toEqual([false, true, false]);
    // A quarter that ends on a plan date and lacks this figure is still a gap: another metric
    // has an approved figure on that date.
    const onPlanDate = {
      metric: 'ebitda' as const,
      points: [
        { periodEnd: '2022-12-31', actual: '10', plan: '9', interpolated: false },
        { periodEnd: '2023-12-31', actual: null, plan: '12', interpolated: false },
      ],
    };
    const revenue = {
      metric: 'revenue' as const,
      points: [
        { periodEnd: '2022-12-31', actual: '50', plan: '45', interpolated: false },
        { periodEnd: '2023-12-31', actual: '60', plan: '55', interpolated: false },
      ],
    };
    expect(planChart(onPlanDate, [onPlanDate, revenue]).actualAbsent).toEqual([false, false]);
    // Two dates in one month are told apart by the day.
    const sameMonth = planChart({
      metric: 'ebitda',
      points: [
        { periodEnd: '2023-06-15', actual: null, plan: '1', interpolated: false },
        { periodEnd: '2023-06-30', actual: '2', plan: '3', interpolated: true },
      ],
    });
    expect(sameMonth.x).toEqual(['Jun 15, 2023', 'Jun 30, 2023']);
    expect(sameMonth.at).toEqual([0, 15]);
  });

  it('sets what was earned against what was planned, driver by driver, with the time passed', () => {
    const progress = comparison().valueCreation;
    if (progress === null) throw new Error('no value creation');
    expect(driverRows(progress)).toEqual([
      {
        key: 'ebitdaGrowth',
        label: 'EBITDA growth',
        planned: '+$400.0M',
        earned: '+$250.0M',
        progress: '62.5%',
      },
      {
        key: 'multipleExpansion',
        label: 'Multiple expansion',
        planned: '+$80.0M',
        earned: '+$65.0M',
        progress: '81.3%',
      },
      {
        key: 'debtPaydown',
        label: 'Debt paydown',
        planned: '+$50.0M',
        earned: '+$30.0M',
        progress: '60.0%',
      },
      { key: 'total', label: 'Total', planned: '+$530.0M', earned: '+$345.0M', progress: '65.1%' },
    ]);
    // 730 of 1,826 days.
    expect(progressNotes(progress)).toEqual(['40% of the planned time has passed.']);
  });

  it('says why there is no progress, for the whole and for a driver planned at zero or less', () => {
    const noBridge = comparison({
      inputs: { bridge: null, bridgeNotCalculable: 'non_positive_ebitda' },
    }).valueCreation;
    if (noBridge === null) throw new Error('no value creation');
    expect(driverRows(noBridge).map((r) => [r.planned, r.earned, r.progress])).toEqual([
      ['+$400.0M', MISSING, MISSING],
      ['+$80.0M', MISSING, MISSING],
      ['+$50.0M', MISSING, MISSING],
      ['+$530.0M', MISSING, MISSING],
    ]);
    expect(progressNotes(noBridge)).toEqual([
      '40% of the planned time has passed.',
      'Progress is not calculable: EBITDA is zero or less.',
    ]);
    const flat: PlanProgress = {
      planned: { ebitdaGrowth: '400', multipleExpansion: '0', debtPaydown: '-5', total: '395' },
      actual: { ebitdaGrowth: '100', multipleExpansion: '10', debtPaydown: '1', total: '111' },
      progress: {
        ebitdaGrowth: '0.25',
        multipleExpansion: null,
        debtPaydown: null,
        total: '0.281',
      },
      timePassed: null,
      notCalculable: null,
    };
    expect(progressNotes(flat)).toEqual([
      'No progress for multiple expansion and debt paydown: The plan figure is zero or less.',
    ]);
  });
});

describe('base case card: the versions', () => {
  it('names the entry case, a correction and a re-underwriting, and tells look-alikes apart', () => {
    const versions = withKinds([
      caseFixture({ state: 'Superseded' }),
      caseFixture({ version: 2, revisionReason: 'A typing error in net debt' }),
      reunderwriteFixture({ version: 3 }),
      reunderwriteFixture({ version: 4, state: 'Draft', confirmedBy: null, confirmedAt: null }),
    ]);
    expect(versions.map((v) => v.kind)).toEqual([
      'entry',
      'correction',
      'reunderwrite',
      'correction',
    ]);
    expect([...versionLabels(versions)]).toEqual([
      [1, 'Entry case (superseded)'],
      [2, 'Corrected'],
      [3, 'Re-underwritten Mar 31, 2023'],
      [4, 'Re-underwritten Mar 31, 2023, corrected'],
    ]);
    expect(comparableVersions(versions).map((v) => v.version)).toEqual([1, 2, 3]);
    // Two corrections that were both superseded read the same, so their numbers tell them apart.
    const twice = withKinds([
      caseFixture({ state: 'Superseded' }),
      caseFixture({ version: 2, state: 'Superseded' }),
      caseFixture({ version: 3, state: 'Superseded' }),
      caseFixture({ version: 4 }),
    ]);
    expect([...versionLabels(twice).values()]).toEqual([
      'Entry case (superseded)',
      'Corrected (superseded), version 2',
      'Corrected (superseded), version 3',
      'Corrected',
    ]);
  });

  it('heads a Draft by what confirming it would make it', () => {
    expect(draftLabel(draftFixture())).toBe('Draft base case');
    expect(draftLabel({ kind: 'correction', caseDate: '2021-06-30' })).toBe(
      'Draft correction of the case dated Jun 30, 2021',
    );
    expect(draftLabel({ kind: 'reunderwrite', caseDate: '2023-03-31' })).toBe(
      'Draft re-underwriting dated Mar 31, 2023',
    );
  });

  it('says who entered and confirmed a case, and where in its source the figures are', () => {
    expect(byLine({ name: 'Blake Okafor' }, '2021-07-06T10:00:00.000Z')).toBe(
      'Blake Okafor, Jul 6, 2021',
    );
    expect(byLine(null, null)).toBe(MISSING);
    expect(sourcePlace(reunderwriteFixture().source)).toBe('page 12, Base case!B14');
    expect(sourcePlace(caseFixture().source)).toBeNull();
  });
});

describe('base case card: who may do what', () => {
  const NOTHING: CaseActions = {
    record: false,
    revise: false,
    editDraft: false,
    withdrawDraft: false,
    confirm: null,
    retire: false,
  };
  const ME = UW_PERSON.approver.id;
  const READERS = ['viewer', 'operations', 'investor_relations', 'auditor', 'platform_admin'];
  const confirmed = caseFixture();
  const draft = draftFixture();
  const mine = draftFixture({ enteredBy: { id: ME, name: 'Morgan Lindqvist' } });
  const act = (
    roles: readonly string[],
    state: { draft?: typeof draft; shown?: typeof confirmed; standing?: boolean },
  ): CaseActions =>
    caseActions({
      roles,
      userId: ME,
      draft: state.draft,
      shown: state.shown,
      standing: state.standing ?? state.shown?.state === 'Confirmed',
    });

  it('lets the deal team record a first case, and revise the Confirmed case shown', () => {
    expect(act(['deal_team'], {})).toEqual({ ...NOTHING, record: true });
    expect(act(['deal_team'], { shown: confirmed })).toEqual({ ...NOTHING, revise: true });
    // A superseded case is on show while another stands: nothing is recorded from it.
    expect(
      act(['deal_team'], { shown: caseFixture({ state: 'Superseded' }), standing: true }),
    ).toEqual(NOTHING);
    // One Draft per position: while one waits, no other is recorded.
    expect(act(['deal_team'], { draft, shown: confirmed })).toMatchObject({
      record: false,
      revise: false,
    });
  });

  it('lets the deal team edit and withdraw a Draft, and a second person confirm it', () => {
    expect(act(['deal_team'], { draft })).toEqual({
      ...NOTHING,
      editDraft: true,
      withdrawDraft: true,
      confirm: 'offer',
    });
    // The person who last changed the figures is told so in place of the button.
    expect(act(['deal_team'], { draft: mine })).toEqual({
      ...NOTHING,
      editDraft: true,
      withdrawDraft: true,
      confirm: 'own_figures',
    });
    // An approver confirms and retires, and neither records nor edits.
    expect(act(['approver'], { draft })).toEqual({ ...NOTHING, confirm: 'offer' });
    expect(act(['approver'], { draft: mine }).confirm).toBe('own_figures');
    expect(act(['approver'], { shown: confirmed })).toEqual({ ...NOTHING, retire: true });
    expect(act(['approver'], { draft, shown: confirmed })).toEqual({
      ...NOTHING,
      confirm: 'offer',
      retire: true,
    });
    expect(act(['deal_team', 'approver'], { shown: confirmed })).toEqual({
      ...NOTHING,
      revise: true,
      retire: true,
    });
    // Without a known identity nobody is taken for the person who entered the figures.
    expect(
      caseActions({ roles: ['deal_team'], userId: null, draft, shown: undefined, standing: false })
        .confirm,
    ).toBe('offer');
  });

  it('leaves every other role reading, whatever stands', () => {
    for (const role of READERS)
      for (const state of [
        {},
        { draft },
        { draft: mine },
        { shown: confirmed },
        { draft, shown: confirmed },
      ])
        expect(act([role], state), role).toEqual(NOTHING);
    expect(act([], { draft, shown: confirmed })).toEqual(NOTHING);
  });

  it('words the two sentences the actions need', () => {
    expect(OWN_FIGURES).toBe('You entered these figures. A second person confirms them.');
    expect(STALE_CASE).toBe('This base case changed since you opened it. Open it again.');
  });
});
