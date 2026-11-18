import { describe, expect, it } from 'vitest';
import { isQuarterEnd } from '@pb/calc';
import { REPORT_PACKAGE_STATES } from '@pb/contracts';
import type { ReportPackageRow, ReportPackageState } from '@pb/contracts';
import { QA_RULES, STALE_FOOTNOTE } from '@pb/report-engine';
import { reportingPackageMachine } from '@pb/workflows';
import definitions from '../../../../../../config/definitions.json';
import { MISSING } from '../../../lib/format.js';
import {
  checksSummary,
  entityWords,
  findingValue,
  FOOTNOTE_WORDS,
  footnoteWords,
  gateSteps,
  NEXT_STEP_WORDS,
  PACKAGE_QUARTER_CHOICES,
  PACKAGE_STATES,
  personCommands,
  positionNames,
  positionWords,
  quarterChoices,
  RULE_WORDS,
  ruleWords,
} from './packages.js';

const qa = (
  runNo: number | null,
  findings: number,
  failed: number,
  overridden: number,
): ReportPackageRow['qa'] => ({ runNo, findings, failed, overridden });

const NOT_RUN = qa(null, 0, 0, 0);

/** An identifier a page must never show: a rule code, or a uuid. */
const IDENTIFIER = /QA-[A-Z]+-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('the words for a check', () => {
  it('names every rule of the engine in plain words, each once', () => {
    expect(Object.keys(RULE_WORDS).sort()).toEqual([...QA_RULES].sort());
    expect(QA_RULES.map((rule) => RULE_WORDS[rule].name)).toEqual([
      'End NAV on record',
      'Stale mark footnoted',
      'Nothing dated after the as-of date',
      'Quarter starts from the prior locked mark',
      'NAV roll-forward',
      'Gain or loss sign',
      'Ties to the last released package',
      'Movers list',
      'Preliminary or final, gross or net',
      'Client share of NAV',
    ]);
    const names = QA_RULES.map((rule) => RULE_WORDS[rule].name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).not.toMatch(IDENTIFIER);
  });

  it('gives a rule the page does not know a name that is not its code', () => {
    expect(ruleWords('QA-RF-01')).toBe(RULE_WORDS['QA-RF-01']);
    const unknown = ruleWords('QA-NEW-09');
    expect(unknown.name).toBe('Another check');
    expect(unknown.name).not.toMatch(IDENTIFIER);
  });

  it('shows what a check expected and found in the words of its kind', () => {
    // Money to the cent: a tie-out is read to the cent, not to a tenth of a million.
    expect(findingValue('QA-RF-01', '12450950.25')).toBe('$12,450,950.25');
    expect(findingValue('QA-QTD-01', '0')).toBe('$0.00');
    expect(findingValue('QA-SIGN-01', '-125000.5')).toBe('-$125,000.50');
    expect(findingValue('QA-CLI-01', '814999.9')).toBe('$814,999.90');
    expect(findingValue('QA-TIE-01', '4200000')).toBe('$4,200,000.00');
    expect(findingValue('QA-RDY-01', '8310000')).toBe('$8,310,000.00');
    // Dates as dates.
    expect(findingValue('QA-STALE-01', '2025-06-30')).toBe('Jun 30, 2025');
    expect(findingValue('QA-ASOF-01', '2025-09-30')).toBe('Sep 30, 2025');
    // Labels as words.
    expect(findingValue('QA-LBL-01', 'preliminary')).toBe('Preliminary');
    expect(findingValue('QA-LBL-01', 'final')).toBe('Final');
    expect(findingValue('QA-LBL-01', 'gross')).toBe('Gross');
    expect(findingValue('QA-LBL-01', 'net')).toBe('Net');
  });

  it('lists the movers by position, in the order the check gives, and says when there are none', () => {
    const names = positionNames([
      { investmentNumber: 'INV-0002', companyName: 'Harbor Freight Systems' },
    ]);
    expect(findingValue('QA-MOV-01', 'INV-0002, INV-0001', names)).toBe(
      'INV-0002 Harbor Freight Systems, INV-0001',
    );
    // A commentary blurb records the list it was written against with another separator.
    expect(findingValue('QA-MOV-01', 'INV-0002|INV-0001', names)).toBe(
      'INV-0002 Harbor Freight Systems, INV-0001',
    );
    expect(findingValue('QA-MOV-01', '')).toBe('None');
  });

  it('never shows nothing as zero, and never a figure it cannot read', () => {
    for (const rule of QA_RULES) expect(findingValue(rule, null), rule).toBe(MISSING);
    expect(findingValue('QA-RF-01', 'abc')).toBe(MISSING);
    expect(findingValue('QA-STALE-01', 'not a date')).toBe(MISSING);
    expect(findingValue('QA-LBL-01', '')).toBe(MISSING);
    // A rule the page does not know has no kind to word its values by.
    expect(findingValue('QA-NEW-09', '42')).toBe('42');
    expect(findingValue('QA-NEW-09', null)).toBe(MISSING);
  });
});

describe('the words for what a check is about', () => {
  const names = positionNames([
    { investmentNumber: 'INV-0007', companyName: 'Tidewater Analytics' },
    { investmentNumber: 'INV-0008', companyName: 'Saltmarsh Foods' },
  ]);
  const CLIENT = '0b5e7d5a-3f0e-4c69-9a55-0f5f3f1f7a10';

  it('says the whole package and the two labels in words', () => {
    expect(entityWords('QA-ASOF-01', 'package', names)).toBe('Whole package');
    expect(entityWords('QA-TIE-01', 'package', names)).toBe('Whole package');
    expect(entityWords('QA-MOV-01', 'package', names)).toBe('Whole package');
    expect(entityWords('QA-LBL-01', 'status', names)).toBe('Preliminary or final label');
    expect(entityWords('QA-LBL-01', 'basis', names)).toBe('Gross or net label');
  });

  it('shows a position by its number, with the company when the reader can list it', () => {
    expect(entityWords('QA-RF-01', 'INV-0007', names)).toBe('INV-0007 Tidewater Analytics');
    expect(entityWords('QA-RF-01', 'INV-0099', names)).toBe('INV-0099');
    expect(positionWords('INV-0008', names)).toBe('INV-0008 Saltmarsh Foods');
    expect(positionWords('INV-0008', positionNames([]))).toBe('INV-0008');
    expect(positionWords('INV-0008')).toBe('INV-0008');
  });

  it('drops the client from a client line: the page is one client already', () => {
    const words = entityWords('QA-CLI-01', `${CLIENT}:INV-0008`, names);
    expect(words).toBe('INV-0008 Saltmarsh Foods');
    expect(words).not.toMatch(IDENTIFIER);
    // Only a client line is cut at its colon.
    expect(entityWords('QA-CLI-01', 'INV-0008', names)).toBe('INV-0008 Saltmarsh Foods');
  });
});

describe('the words for a footnote', () => {
  it('has words for every footnote the engine writes', () => {
    expect(Object.keys(FOOTNOTE_WORDS)).toEqual([STALE_FOOTNOTE]);
    expect(footnoteWords(STALE_FOOTNOTE, { endNavPeriodEnd: '2025-06-30' })).toBe(
      'Carried at the mark of Jun 30, 2025, rolled forward for cash flows since.',
    );
  });

  it('does not invent the date of a mark it was not given', () => {
    for (const line of [undefined, { endNavPeriodEnd: null }])
      expect(footnoteWords(STALE_FOOTNOTE, line)).toBe(
        'Carried at an earlier mark, rolled forward for cash flows since.',
      );
  });

  it('words a footnote it does not know from its code, never as the code', () => {
    expect(footnoteWords('no_end_nav', undefined)).toBe('No end nav');
  });
});

describe('the release gate as steps', () => {
  const steps = (
    state: ReportPackageState,
    counts = NOT_RUN,
  ): { label: string; status: string }[] =>
    gateSteps({ state, qa: counts }).map(({ label, status }) => ({ label, status }));
  const statuses = (state: ReportPackageState): string[] => steps(state).map((s) => s.status);
  const labels = (state: ReportPackageState, counts = NOT_RUN): string[] =>
    steps(state, counts).map((s) => s.label);

  it('has six steps for the seven states: both QA outcomes sit on one step', () => {
    for (const state of REPORT_PACKAGE_STATES) {
      const out = gateSteps({ state, qa: NOT_RUN });
      expect(out, state).toHaveLength(6);
      expect(
        out.filter((s) => s.status === 'current'),
        state,
      ).toHaveLength(1);
      expect(new Set(out.map((s) => s.key)).size, state).toBe(6);
    }
    expect(labels('Draft')).toEqual([
      'Draft',
      'Generated',
      'QA',
      'In review',
      'Approved',
      'Released',
    ]);
  });

  it('marks every step before the current one done and the rest still to come', () => {
    expect(statuses('Draft')).toEqual([
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
    // Generated never rests; a page that is shown it still places it.
    expect(statuses('Generated')).toEqual([
      'done',
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
    for (const state of ['QAFailed', 'QAPassed'] as const)
      expect(statuses(state), state).toEqual([
        'done',
        'done',
        'current',
        'upcoming',
        'upcoming',
        'upcoming',
      ]);
    expect(statuses('InReview')).toEqual([
      'done',
      'done',
      'done',
      'current',
      'upcoming',
      'upcoming',
    ]);
    expect(statuses('Approved')).toEqual(['done', 'done', 'done', 'done', 'current', 'upcoming']);
    expect(statuses('Released')).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
  });

  it('words the QA step by its outcome, and by the override when one stands', () => {
    expect(labels('QAFailed', qa(1, 126, 3, 0))[2]).toBe('QA failed');
    expect(labels('QAPassed', qa(1, 126, 0, 0))[2]).toBe('QA passed');
    expect(labels('QAPassed', qa(1, 126, 3, 3))[2]).toBe('QA passed by override');
    // The outcome stays on the step once the package has moved on.
    for (const state of ['InReview', 'Approved', 'Released'] as const) {
      expect(labels(state, qa(2, 126, 0, 0))[2], state).toBe('QA passed');
      expect(labels(state, qa(2, 126, 3, 3))[2], state).toBe('QA passed by override');
    }
  });

  it('says what happens next from every state, and that there is no way back once the checks passed', () => {
    expect(Object.keys(NEXT_STEP_WORDS).sort()).toEqual([...REPORT_PACKAGE_STATES].sort());
    for (const state of REPORT_PACKAGE_STATES) {
      expect(NEXT_STEP_WORDS[state], state).toMatch(/^[A-Z].*\.$/);
      expect(NEXT_STEP_WORDS[state], state).not.toMatch(IDENTIFIER);
    }
    expect(NEXT_STEP_WORDS.QAPassed).toContain('no way back');
    expect(NEXT_STEP_WORDS.InReview).toContain('no way back');
    expect(NEXT_STEP_WORDS.Released).toContain('new version');
  });
});

describe('the commands a person may be offered', () => {
  const commands = (state: ReportPackageState, roles: readonly string[]): string[] =>
    personCommands(state, roles).map((o) => `${o.command}:${o.allowed ? 'yes' : 'no'}`);

  it('offers each state its next step, to the role the transition table names', () => {
    expect(commands('Draft', ['investor_relations'])).toEqual(['generate:yes']);
    expect(commands('QAFailed', ['investor_relations'])).toEqual([
      'regenerate:yes',
      'overrideQa:no',
    ]);
    expect(commands('QAFailed', ['approver'])).toEqual(['regenerate:no', 'overrideQa:yes']);
    expect(commands('QAPassed', ['investor_relations'])).toEqual(['submit:yes']);
    expect(commands('InReview', ['approver'])).toEqual(['approve:yes']);
    expect(commands('InReview', ['investor_relations'])).toEqual(['approve:no']);
    expect(commands('Approved', ['operations'])).toEqual(['release:yes']);
    expect(commands('Approved', ['investor_relations'])).toEqual(['release:yes']);
    expect(commands('Approved', ['approver'])).toEqual(['release:no']);
    expect(commands('Released', ['investor_relations'])).toEqual([]);
  });

  it('never offers the steps the system takes, and never names the service account', () => {
    // Generated only moves by the outcome of the checks, which is the system's to state.
    expect(personCommands('Generated', ['investor_relations', 'approver', 'operations'])).toEqual(
      [],
    );
    for (const state of reportingPackageMachine.states)
      for (const option of personCommands(state, ['deal_team', 'auditor'])) {
        expect(option.allowed, `${state} ${option.command}`).toBe(false);
        expect(option.roles, `${state} ${option.command}`).not.toContain('service');
        expect(option.roles.length, `${state} ${option.command}`).toBeGreaterThan(0);
        expect(['qaPass', 'qaFail']).not.toContain(option.command);
      }
    // A credential that holds only the service role is not a person at the page.
    expect(commands('Draft', ['service'])).toEqual(['generate:no']);
  });

  it('keeps what the table says of a command: where it leads and whether it needs a reason', () => {
    const [regenerate, override] = personCommands('QAFailed', ['approver']);
    expect(regenerate).toMatchObject({ to: 'Generated', needsReason: false });
    expect(regenerate?.roles).toEqual(['investor_relations']);
    expect(override).toMatchObject({ to: 'QAPassed', needsReason: true, roles: ['approver'] });
    expect(personCommands('Approved', [])[0]?.roles).toEqual(['investor_relations', 'operations']);
  });
});

describe('the checks of a package in a few words', () => {
  it('says not run, all passed, how many failed, or that the failures were overridden', () => {
    expect(checksSummary(NOT_RUN)).toBe('Not run');
    expect(checksSummary(qa(1, 126, 0, 0))).toBe('All 126 passed');
    expect(checksSummary(qa(1, 126, 3, 0))).toBe('3 of 126 failed');
    expect(checksSummary(qa(2, 126, 3, 3))).toBe('3 failed, overridden');
    expect(checksSummary(qa(1, 1, 1, 0))).toBe('1 of 1 failed');
  });

  it('counts a failure as failed until every failure of the run is overridden', () => {
    expect(checksSummary(qa(1, 126, 3, 2))).toBe('3 of 126 failed');
  });
});

describe('the quarters a package may be started for', () => {
  it('reads how many from the configuration', () => {
    expect(PACKAGE_QUARTER_CHOICES).toBe(definitions.reporting.packageQuarterChoices);
    expect(Number.isInteger(PACKAGE_QUARTER_CHOICES)).toBe(true);
    expect(PACKAGE_QUARTER_CHOICES).toBeGreaterThan(0);
  });

  it('lists the latest quarter ends on or before the as-of date, newest first', () => {
    expect(quarterChoices('2025-09-30', 4)).toEqual([
      '2025-09-30',
      '2025-06-30',
      '2025-03-31',
      '2024-12-31',
    ]);
    // A day short of the quarter end: the quarter has not ended, so it is not offered.
    expect(quarterChoices('2025-09-29', 2)).toEqual(['2025-06-30', '2025-03-31']);
    expect(quarterChoices('2024-02-29', 3)).toEqual(['2023-12-31', '2023-09-30', '2023-06-30']);
    const all = quarterChoices('2025-11-18');
    expect(all).toHaveLength(PACKAGE_QUARTER_CHOICES);
    expect(all[0]).toBe('2025-09-30');
    for (const quarter of all) expect(isQuarterEnd(quarter), quarter).toBe(true);
    expect([...all].sort().reverse()).toEqual(all);
  });

  it('offers nothing for a date it cannot read, and nothing for a count of none', () => {
    expect(quarterChoices('not a date')).toEqual([]);
    expect(quarterChoices('2025-02-30')).toEqual([]);
    expect(quarterChoices('2025-09-30', 0)).toEqual([]);
  });
});

describe('the states of a package', () => {
  it('lists them in the order of the transition table', () => {
    expect(PACKAGE_STATES).toEqual(reportingPackageMachine.states);
    expect(PACKAGE_STATES).toEqual(REPORT_PACKAGE_STATES);
  });
});
