import { describe, expect, it } from 'vitest';
import { isQuarterEnd } from '@pb/calc';
import { API_PREFIX, REPORT_PACKAGE_STATES, ROUTES } from '@pb/contracts';
import type { ReportPackageRow, ReportPackageState } from '@pb/contracts';
import { QA_RULES, STALE_FOOTNOTE } from '@pb/report-engine';
import { reportingPackageMachine } from '@pb/workflows';
import definitions from '../../../../../../config/definitions.json';
import { MISSING } from '../../../lib/format.js';
import {
  CLIENT,
  CLIENT_ID,
  PKG_ID,
  PKG_PERIOD,
  PKG_PRIOR_PERIOD,
  packageRowFixture,
  packageRows,
} from '../../../test/fixtures-packages.js';
import {
  basisOnRecord,
  checksSummary,
  clientChoices,
  EMPTY_START_FORM,
  entityWords,
  filterPackages,
  findingValue,
  FOOTNOTE_WORDS,
  footnoteWords,
  gateSteps,
  isPackageBasis,
  isPackageLabel,
  isPackageState,
  NEXT_STEP_WORDS,
  PACKAGE_QUARTER_CHOICES,
  PACKAGE_STATES,
  packageWords,
  parsedStartBody,
  parsePackagesSearch,
  personCommands,
  positionNames,
  positionWords,
  quarterChoices,
  RULE_WORDS,
  ruleWords,
  START_ROLES,
  startBody,
  startFormFor,
  startProblems,
  startStanding,
} from './packages.js';
import type { StartForm } from './packages.js';

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
    expect(footnoteWords(STALE_FOOTNOTE, { endNavMarkDate: '2025-06-30' })).toBe(
      'Carried at the mark of Jun 30, 2025, rolled forward for cash flows since.',
    );
    // The day the mark is dated: the sponsor's own close, a few days before the quarter end.
    expect(footnoteWords(STALE_FOOTNOTE, { endNavMarkDate: '2025-03-28' })).toBe(
      'Carried at the mark of Mar 28, 2025, rolled forward for cash flows since.',
    );
  });

  it('does not invent the date of a mark it was not given', () => {
    for (const line of [undefined, { endNavMarkDate: null }])
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

  it('says who may not override the failed checks or approve: whoever prepared the package', () => {
    // Starting a package, generating it and submitting it are a preparer's steps (SEC-5.6).
    expect(NEXT_STEP_WORDS.QAFailed).toBe(
      'Investor relations regenerates the package once the record is fixed, or an approver who did not start or generate it overrides the failed checks with a reason.',
    );
    expect(NEXT_STEP_WORDS.InReview).toBe(
      'An approver who did not start, generate or submit the package approves it. There is no way back from here: a correction is a new version, started once this one is released.',
    );
  });
});

describe('who may start a package', () => {
  it("is the role list of the contract's own start route, read and not copied", () => {
    const route = ROUTES.find(
      (r) => r.method === 'POST' && r.path === `${API_PREFIX}/report-packages`,
    );
    expect(route?.roles.length).toBeGreaterThan(0);
    // The same list: a role added to the route is offered the button with no change here.
    expect(START_ROLES).toBe(route?.roles);
  });
});

describe('the corrected version of a released package', () => {
  const released = packageRowFixture({
    id: PKG_ID.released,
    basis: 'gross',
    label: 'final',
    state: 'Released',
  });

  it('reads the package to correct from the address, and drops anything that is not an id', () => {
    expect(parsePackagesSearch({ correct: PKG_ID.released })).toEqual({ correct: PKG_ID.released });
    for (const search of [{}, { correct: 'not-an-id' }, { correct: 7 }, { correct: '' }])
      expect(parsePackagesSearch(search), JSON.stringify(search)).toEqual({});
    // Nothing else of the address is kept.
    expect(parsePackagesSearch({ correct: PKG_ID.released, state: 'Released' })).toEqual({
      correct: PKG_ID.released,
    });
  });

  it('fills the start form with its client, quarter and basis, and leaves the label and the reason to the person', () => {
    expect(startFormFor([released], PKG_ID.released)).toEqual({
      ...EMPTY_START_FORM,
      clientId: released.client.id,
      periodEnd: released.periodEnd,
      basis: 'gross',
    });
  });

  it('fills nothing for a package that is not released, not listed or not named', () => {
    const draft = packageRowFixture({ id: PKG_ID.draft });
    expect(startFormFor([draft], PKG_ID.draft)).toBeNull();
    expect(startFormFor([released], PKG_ID.draft)).toBeNull();
    expect(startFormFor([released], undefined)).toBeNull();
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

describe('the list of packages', () => {
  const rows = packageRows();

  it('filters by client and by state over the one read, keeping the order it came in', () => {
    expect(filterPackages(rows, { clientId: '', state: '' })).toEqual(rows);
    expect(filterPackages(rows, { clientId: CLIENT_ID.beta, state: '' }).map((r) => r.id)).toEqual([
      PKG_ID.inReview,
    ]);
    expect(filterPackages(rows, { clientId: CLIENT_ID.alpha, state: '' }).map((r) => r.id)).toEqual(
      [PKG_ID.failed, PKG_ID.draft, PKG_ID.approved, PKG_ID.released],
    );
    expect(filterPackages(rows, { clientId: '', state: 'Released' }).map((r) => r.id)).toEqual([
      PKG_ID.released,
    ]);
    expect(filterPackages(rows, { clientId: CLIENT_ID.beta, state: 'Released' })).toEqual([]);
  });

  it('offers each client on the list once, by name', () => {
    expect(clientChoices(rows)).toEqual([CLIENT.alpha, CLIENT.beta]);
    expect(clientChoices([...rows].reverse())).toEqual([CLIENT.alpha, CLIENT.beta]);
    expect(clientChoices([])).toEqual([]);
  });

  it('knows a state, a basis and a label from any other text', () => {
    expect(isPackageState('QAFailed')).toBe(true);
    expect(isPackageState('Locked')).toBe(false);
    expect(isPackageBasis('net')).toBe(true);
    expect(isPackageBasis('net_of_fees_and_carry')).toBe(false);
    expect(isPackageLabel('final')).toBe(true);
    expect(isPackageLabel('')).toBe(false);
  });

  it('says a package in one line, with no id in it', () => {
    const words = packageWords(rows[3]!);
    expect(words).toBe('Client Alpha Pension, Q1 2025, gross, version 2');
    expect(words).not.toMatch(IDENTIFIER);
  });
});

describe('starting a package', () => {
  const rows = packageRows();
  const form = (overrides: Partial<StartForm> = {}): StartForm => ({
    clientId: CLIENT_ID.beta,
    periodEnd: PKG_PRIOR_PERIOD,
    basis: 'net',
    label: 'preliminary',
    correctionReason: '',
    ...overrides,
  });

  it('reads whether a client, quarter and basis have no package, one in progress or a released one', () => {
    expect(startStanding(rows, form())).toEqual({ kind: 'first' });
    // The same client and quarter on the other basis is another package.
    expect(
      startStanding(rows, form({ clientId: CLIENT_ID.alpha, periodEnd: PKG_PERIOD, basis: 'net' })),
    ).toEqual({ kind: 'inProgress', row: rows[1] });
    expect(startStanding(rows, form({ periodEnd: PKG_PERIOD }))).toEqual({
      kind: 'inProgress',
      row: rows[2],
    });
    // The latest version decides: version 2 is still on its way, whatever version 1 is.
    expect(startStanding(rows, form({ clientId: CLIENT_ID.alpha, basis: 'gross' }))).toEqual({
      kind: 'inProgress',
      row: rows[3],
    });
    const released = packageRowFixture({ id: PKG_ID.released, state: 'Released' });
    expect(
      startStanding([released], form({ clientId: CLIENT_ID.alpha, periodEnd: PKG_PERIOD })),
    ).toEqual({ kind: 'correction', row: released });
    // The order of the list does not matter.
    expect(
      startStanding([rows[4]!, rows[3]!], form({ clientId: CLIENT_ID.alpha, basis: 'gross' })),
    ).toEqual({ kind: 'inProgress', row: rows[3] });
    expect(startStanding(rows, { clientId: '', periodEnd: '', basis: '' })).toEqual({
      kind: 'first',
    });
  });

  it('sends the four choices and no as-of date: the API reads its own', () => {
    const body = startBody(form({ correctionReason: 'not sent for a first version' }), {
      kind: 'first',
    });
    expect(body).toEqual({
      clientId: CLIENT_ID.beta,
      periodEnd: PKG_PRIOR_PERIOD,
      basis: 'net',
      label: 'preliminary',
    });
    expect(parsedStartBody(form(), { kind: 'first' })).toEqual(body);
  });

  it('asks for every choice in plain words before anything is sent', () => {
    expect(startProblems(EMPTY_START_FORM, { kind: 'first' })).toEqual({
      clientId: 'Choose the client.',
      periodEnd: 'Choose the quarter.',
      basis: 'Choose gross or net.',
      label: 'Choose preliminary or final.',
    });
    expect(parsedStartBody(EMPTY_START_FORM, { kind: 'first' })).toBeNull();
    expect(startProblems(form(), { kind: 'first' })).toEqual({});
    expect(startProblems(form({ label: '' }), { kind: 'first' })).toEqual({
      label: 'Choose preliminary or final.',
    });
    // A date that is not a date never leaves the page either.
    expect(startProblems(form({ periodEnd: 'Q2' }), { kind: 'first' })).toEqual({
      periodEnd: 'Choose the quarter.',
    });
  });

  it('needs a reason for a new version of a released package, trimmed, and only then', () => {
    const standing = { kind: 'correction', row: rows[4]! } as const;
    const why = 'Say why the released package is being corrected, in 3 to 500 characters.';
    expect(startProblems(form(), standing)).toEqual({ correctionReason: why });
    expect(startProblems(form({ correctionReason: '  ab ' }), standing)).toEqual({
      correctionReason: why,
    });
    expect(startProblems(form({ correctionReason: 'x'.repeat(501) }), standing)).toEqual({
      correctionReason: why,
    });
    expect(parsedStartBody(form(), standing)).toBeNull();
    const reason = '  The June mark of one position was restated.  ';
    expect(startProblems(form({ correctionReason: reason }), standing)).toEqual({});
    expect(parsedStartBody(form({ correctionReason: reason }), standing)).toEqual({
      clientId: CLIENT_ID.beta,
      periodEnd: PKG_PRIOR_PERIOD,
      basis: 'net',
      label: 'preliminary',
      correctionReason: 'The June mark of one position was restated.',
    });
  });

  it('sends nothing while a package for the three is still in progress', () => {
    const standing = { kind: 'inProgress', row: rows[1]! } as const;
    expect(parsedStartBody(form(), standing)).toBeNull();
    // That is the form's to say in one place, not a fault of any one field.
    expect(startProblems(form(), standing)).toEqual({});
  });

  it("knows whether a basis is on the client's record, as a bare word or a taxonomy code", () => {
    expect(basisOnRecord(['gross', 'net'], 'net')).toBe(true);
    expect(basisOnRecord(['net'], 'gross')).toBe(false);
    expect(basisOnRecord(['reporting_basis.gross'], 'gross')).toBe(true);
    expect(basisOnRecord(['reporting_basis.gross'], 'net')).toBe(false);
    // Net of fees and carry is a basis of its own, not net.
    expect(basisOnRecord(['net_of_fees_and_carry'], 'net')).toBe(false);
    expect(basisOnRecord([], 'gross')).toBe(false);
  });
});
