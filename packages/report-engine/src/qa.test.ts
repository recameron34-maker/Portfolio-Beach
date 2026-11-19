import { describe, expect, it } from 'vitest';
import { QA_RULES, STALE_FOOTNOTE, moversKey, qaPassed, rankMovers, runReportQa } from './qa.js';
import type { QaFinding, QaLine, QaRule, QaSnapshot } from './qa.js';

/*
 * Report QA (docs/08 section 7, fixture 25): one package snapshot per rule, passing and failing,
 * and each scenario of docs/14 the gate must catch. Every amount is worked by hand in the comment
 * beside it.
 */

const SETTINGS = { toleranceUsd: '1', moversCount: 2 };
const PERIOD = '2025-06-30';
const PRIOR = '2025-03-31';

/** 100 + 10 - 5 + 15 = 120: a line that rolls forward. */
const line = (ref: string, over: Partial<QaLine> = {}): QaLine => ({
  ref,
  enteredInPeriod: false,
  beginNav: '100',
  contributions: '10',
  distributions: '5',
  gainLoss: '15',
  endNav: '120',
  endNavPeriodEnd: PERIOD,
  recordedQuarterStartNav: '100',
  latestFigureDate: PERIOD,
  ...over,
});

/** Three clean lines: A up 20%, B up 50%, C down 10%. Movers of two: B then A. */
const clean = (over: Partial<QaSnapshot> = {}): QaSnapshot => {
  const lines = [
    line('INV-A'),
    // 200 + 0 - 0 + 100 = 300
    line('INV-B', {
      beginNav: '200',
      contributions: '0',
      distributions: '0',
      gainLoss: '100',
      endNav: '300',
      recordedQuarterStartNav: '200',
    }),
    // 50 + 0 - 0 - 5 = 45
    line('INV-C', {
      beginNav: '50',
      contributions: '0',
      distributions: '0',
      gainLoss: '-5',
      endNav: '45',
      recordedQuarterStartNav: '50',
    }),
  ];
  return {
    periodEnd: PERIOD,
    asOf: '2025-08-09',
    status: 'final',
    basis: 'gross',
    lines,
    movers: ['INV-B', 'INV-A'],
    commentary: [{ ref: 'INV-B', moversKey: moversKey(['INV-B', 'INV-A']) }],
    footnotes: [],
    clientLines: [{ clientRef: 'CLIENT-1', ref: 'INV-A', ownershipPct: '0.25', nav: '30' }],
    priorRelease: {
      endNav: { 'INV-A': '100', 'INV-B': '200', 'INV-C': '50' },
      explanations: {},
    },
    ...over,
  };
};

const failed = (findings: readonly QaFinding[]): string[] =>
  findings.filter((f) => !f.passed).map((f) => `${f.rule} ${f.entityRef}`);
const of = (findings: readonly QaFinding[], rule: QaRule, entityRef: string): QaFinding => {
  const found = findings.find((f) => f.rule === rule && f.entityRef === entityRef);
  if (found === undefined) throw new Error(`no finding ${rule} ${entityRef}`);
  return found;
};
const withLine = (
  ref: string,
  over: Partial<QaLine>,
  rest: Partial<QaSnapshot> = {},
): QaSnapshot => {
  const base = clean(rest);
  return { ...base, lines: base.lines.map((l) => (l.ref === ref ? { ...l, ...over } : l)) };
};

describe('report QA: the release gate', () => {
  it('passes a clean package, with a finding for every rule', () => {
    const findings = runReportQa(clean(), SETTINGS);
    expect(failed(findings)).toEqual([]);
    expect(qaPassed(findings)).toBe(true);
    expect(new Set(findings.map((f) => f.rule))).toEqual(new Set(QA_RULES));
    // Every finding says something a person can read.
    for (const f of findings) expect(f.detail.length).toBeGreaterThan(10);
  });

  it('QA-RDY-01: a position with no end NAV is not ready', () => {
    const findings = runReportQa(
      withLine('INV-A', { endNav: null, endNavPeriodEnd: null }),
      SETTINGS,
    );
    expect(of(findings, 'QA-RDY-01', 'INV-A')).toMatchObject({ passed: false, actual: null });
    expect(of(findings, 'QA-RDY-01', 'INV-B').passed).toBe(true);
    expect(qaPassed(findings)).toBe(false);
  });

  it('QA-STALE-01 (stale_valuation): an older mark needs its footnote, and the package cannot be final', () => {
    const stale = { endNavPeriodEnd: PRIOR };
    const bare = runReportQa(withLine('INV-C', stale, { status: 'preliminary' }), SETTINGS);
    expect(of(bare, 'QA-STALE-01', 'INV-C')).toMatchObject({
      passed: false,
      expected: PERIOD,
      actual: PRIOR,
    });
    const noted = runReportQa(
      withLine('INV-C', stale, {
        status: 'preliminary',
        footnotes: [{ ref: 'INV-C', code: STALE_FOOTNOTE }],
      }),
      SETTINGS,
    );
    expect(of(noted, 'QA-STALE-01', 'INV-C').passed).toBe(true);
    expect(failed(noted)).toEqual([]);
    // A footnote does not make a stale package final.
    const final = runReportQa(
      withLine('INV-C', stale, { footnotes: [{ ref: 'INV-C', code: STALE_FOOTNOTE }] }),
      SETTINGS,
    );
    expect(failed(final)).toEqual(['QA-LBL-01 status']);
    // A footnote on a line whose mark is current is not asked for, and does no harm.
    expect(
      failed(runReportQa(clean({ footnotes: [{ ref: 'INV-A', code: STALE_FOOTNOTE }] }), SETTINGS)),
    ).toEqual([]);
  });

  it('QA-ASOF-01 (forward_entry_snapshot): nothing in the package is dated after its as-of date', () => {
    const findings = runReportQa(withLine('INV-B', { latestFigureDate: '2025-09-15' }), SETTINGS);
    expect(of(findings, 'QA-ASOF-01', 'INV-B')).toMatchObject({
      passed: false,
      expected: '2025-08-09',
      actual: '2025-09-15',
    });
    expect(failed(findings)).toEqual(['QA-ASOF-01 INV-B']);
    // The as-of date itself is in; a period that ends after the as-of date is not.
    expect(
      failed(runReportQa(withLine('INV-B', { latestFigureDate: '2025-08-09' }), SETTINGS)),
    ).toEqual([]);
    const early = runReportQa(clean({ asOf: '2025-06-29' }), SETTINGS);
    expect(of(early, 'QA-ASOF-01', 'package').passed).toBe(false);
    expect(
      of(
        runReportQa(withLine('INV-A', { latestFigureDate: null }), SETTINGS),
        'QA-ASOF-01',
        'INV-A',
      ).passed,
    ).toBe(false);
  });

  it('QA-QTD-01 (qtd_ytd_basis): a quarter table starts from the end of the prior quarter', () => {
    // The table was started from the year: 80 at Dec 31 where the quarter began at 100.
    // 80 + 10 - 5 + 35 = 120 rolls forward, so only the basis rule sees it.
    const findings = runReportQa(
      withLine(
        'INV-A',
        { beginNav: '80', gainLoss: '35' },
        {
          priorRelease: {
            endNav: { 'INV-A': '80', 'INV-B': '200', 'INV-C': '50' },
            explanations: {},
          },
          movers: ['INV-A', 'INV-B'],
          commentary: [],
        },
      ),
      SETTINGS,
    );
    expect(of(findings, 'QA-QTD-01', 'INV-A')).toMatchObject({
      passed: false,
      expected: '100',
      actual: '80',
    });
    expect(of(findings, 'QA-RF-01', 'INV-A').passed).toBe(true);
    expect(failed(findings)).toEqual(['QA-QTD-01 INV-A']);
    // Inside the tolerance is the same figure.
    expect(
      failed(runReportQa(withLine('INV-A', { beginNav: '100.99', gainLoss: '14.01' }), SETTINGS)),
    ).toEqual([]);
  });

  it('QA-QTD-01 and QA-RF-01 (roll_forward_break): no starting NAV on record', () => {
    const findings = runReportQa(
      withLine('INV-A', { beginNav: null, recordedQuarterStartNav: null, gainLoss: null }),
      SETTINGS,
    );
    expect(of(findings, 'QA-QTD-01', 'INV-A')).toMatchObject({ passed: false, expected: null });
    expect(of(findings, 'QA-QTD-01', 'INV-A').detail).toContain('no Locked mark');
    expect(of(findings, 'QA-RF-01', 'INV-A').passed).toBe(false);
    expect(of(findings, 'QA-RF-01', 'INV-A').detail).toContain('begin NAV');
    expect(qaPassed(findings)).toBe(false);
  });

  it('QA-RF-01: the roll-forward holds within the tolerance and not beyond it', () => {
    // 100 + 10 - 5 + 15 = 120; 121 is one dollar out, 121.01 is more.
    expect(
      failed(runReportQa(withLine('INV-A', { endNav: '121' }, { clientLines: [] }), SETTINGS)),
    ).toEqual([]);
    const out = runReportQa(withLine('INV-A', { endNav: '121.01' }, { clientLines: [] }), SETTINGS);
    expect(of(out, 'QA-RF-01', 'INV-A')).toMatchObject({
      passed: false,
      expected: '120',
      actual: '121.01',
    });
  });

  it('a position entered in the quarter rolls forward from zero and is passed over by the basis and tie-out rules', () => {
    // 0 + 40 - 0 + 2 = 42
    const entered = line('INV-N', {
      enteredInPeriod: true,
      beginNav: null,
      recordedQuarterStartNav: null,
      contributions: '40',
      distributions: '0',
      gainLoss: '2',
      endNav: '42',
    });
    const base = clean();
    const findings = runReportQa({ ...base, lines: [...base.lines, entered] }, SETTINGS);
    expect(failed(findings)).toEqual([]);
    expect(of(findings, 'QA-RF-01', 'INV-N').passed).toBe(true);
    // It is not a mover: there is no prior value to measure a change from.
    expect(rankMovers([...base.lines, entered], 5)).toEqual(['INV-B', 'INV-A', 'INV-C']);
    // A begin NAV on a line that was entered in the quarter is a mistake.
    const wrong = runReportQa(
      { ...base, lines: [...base.lines, { ...entered, beginNav: '10' }] },
      SETTINGS,
    );
    expect(of(wrong, 'QA-QTD-01', 'INV-N').passed).toBe(false);
  });

  it('QA-SIGN-01 (sign_flip): a gain shown as a loss', () => {
    // The figures imply +15; the draft says -15.
    const findings = runReportQa(withLine('INV-A', { gainLoss: '-15' }), SETTINGS);
    expect(of(findings, 'QA-SIGN-01', 'INV-A')).toMatchObject({
      passed: false,
      expected: '15',
      actual: '-15',
    });
    // The arithmetic breaks too, and both are reported.
    expect(failed(findings)).toEqual(['QA-RF-01 INV-A', 'QA-SIGN-01 INV-A']);
    // A flat quarter has no sign to get wrong: 100 + 10 - 5 + 0.5 against an end of 105.
    expect(
      of(
        runReportQa(withLine('INV-A', { gainLoss: '-0.5', endNav: '105' }), SETTINGS),
        'QA-SIGN-01',
        'INV-A',
      ).passed,
    ).toBe(true);
    // A negative flow total is a sign error of its own.
    expect(
      of(runReportQa(withLine('INV-A', { distributions: '-5' }), SETTINGS), 'QA-SIGN-01', 'INV-A')
        .passed,
    ).toBe(false);
  });

  it('QA-TIE-01 (restatement): the begin NAV ties to the last released package, or says why not', () => {
    // The sponsor restated the prior quarter from 100 to 97 after the last package went out.
    const restated = { beginNav: '97', recordedQuarterStartNav: '97', gainLoss: '18' };
    const silent = runReportQa(
      withLine('INV-A', restated, { movers: ['INV-B', 'INV-A'] }),
      SETTINGS,
    );
    expect(of(silent, 'QA-TIE-01', 'INV-A')).toMatchObject({
      passed: false,
      expected: '100',
      actual: '97',
    });
    expect(failed(silent)).toEqual(['QA-TIE-01 INV-A']);
    const explained = runReportQa(
      withLine('INV-A', restated, {
        priorRelease: {
          endNav: { 'INV-A': '100', 'INV-B': '200', 'INV-C': '50' },
          explanations: { 'INV-A': 'Sponsor restated the March mark.' },
        },
      }),
      SETTINGS,
    );
    expect(of(explained, 'QA-TIE-01', 'INV-A').passed).toBe(true);
    expect(of(explained, 'QA-TIE-01', 'INV-A').detail).toContain('explanation');
    // A blank explanation is none.
    const blank = runReportQa(
      withLine('INV-A', restated, {
        priorRelease: {
          endNav: { 'INV-A': '100', 'INV-B': '200', 'INV-C': '50' },
          explanations: { 'INV-A': '  ' },
        },
      }),
      SETTINGS,
    );
    expect(of(blank, 'QA-TIE-01', 'INV-A').passed).toBe(false);
    // The first package has nothing to tie to; a held position the last package did not carry does.
    const first = runReportQa(clean({ priorRelease: null }), SETTINGS);
    expect(of(first, 'QA-TIE-01', 'package').passed).toBe(true);
    const absent = runReportQa(
      clean({ priorRelease: { endNav: { 'INV-A': '100', 'INV-B': '200' }, explanations: {} } }),
      SETTINGS,
    );
    expect(failed(absent)).toEqual(['QA-TIE-01 INV-C']);
  });

  it('QA-MOV-01: the movers are the movers of the figures as they now stand', () => {
    expect(rankMovers(clean().lines, 2)).toEqual(['INV-B', 'INV-A']);
    expect(rankMovers(clean().lines, 3)).toEqual(['INV-B', 'INV-A', 'INV-C']);
    // A tie on size is broken by position number.
    const tied = [line('INV-Z'), line('INV-Y')];
    expect(rankMovers(tied, 1)).toEqual(['INV-Y']);
    // A line with no value to compare, or a zero start, is not a mover.
    expect(
      rankMovers([line('INV-A', { endNav: null }), line('INV-B', { beginNav: '0' })], 2),
    ).toEqual([]);

    const stale = runReportQa(clean({ movers: ['INV-A', 'INV-B'] }), SETTINGS);
    expect(of(stale, 'QA-MOV-01', 'package')).toMatchObject({
      passed: false,
      expected: 'INV-B, INV-A',
      actual: 'INV-A, INV-B',
    });
    // A correction moved C from down 10% to down 60%: the list changes, and the blurb written
    // against the old list is flagged even after the list itself is put right.
    const corrected = withLine(
      'INV-C',
      { gainLoss: '-30', endNav: '20' },
      { movers: ['INV-C', 'INV-B'] },
    );
    const findings = runReportQa(corrected, SETTINGS);
    expect(of(findings, 'QA-MOV-01', 'package').passed).toBe(true);
    expect(of(findings, 'QA-MOV-01', 'INV-B')).toMatchObject({ passed: false });
    expect(of(findings, 'QA-MOV-01', 'INV-B').detail).toContain('superseded');
    expect(failed(findings)).toEqual(['QA-MOV-01 INV-B']);
  });

  it('QA-LBL-01: the package says preliminary or final, and gross or net', () => {
    const findings = runReportQa(clean({ status: null, basis: null }), SETTINGS);
    expect(failed(findings)).toEqual(['QA-LBL-01 status', 'QA-LBL-01 basis']);
    expect(failed(runReportQa(clean({ status: 'preliminary', basis: 'net' }), SETTINGS))).toEqual(
      [],
    );
  });

  it('QA-CLI-01 (two_clients_one_fund): a client line is its share of the position', () => {
    // Two clients hold the same position: 25% and 40% of 120 are 30 and 48.
    const two = clean({
      clientLines: [
        { clientRef: 'CLIENT-1', ref: 'INV-A', ownershipPct: '0.25', nav: '30' },
        { clientRef: 'CLIENT-2', ref: 'INV-A', ownershipPct: '0.4', nav: '48' },
      ],
    });
    expect(failed(runReportQa(two, SETTINGS))).toEqual([]);
    // The second client was given the first one's figure.
    const swapped = runReportQa(
      { ...two, clientLines: [two.clientLines[0]!, { ...two.clientLines[1]!, nav: '30' }] },
      SETTINGS,
    );
    expect(of(swapped, 'QA-CLI-01', 'CLIENT-2:INV-A')).toMatchObject({
      passed: false,
      expected: '48',
      actual: '30',
    });
    const orphan = runReportQa(
      clean({
        clientLines: [{ clientRef: 'CLIENT-1', ref: 'INV-X', ownershipPct: '0.5', nav: '1' }],
      }),
      SETTINGS,
    );
    expect(of(orphan, 'QA-CLI-01', 'CLIENT-1:INV-X').passed).toBe(false);
  });

  it('never throws on a figure it cannot read as a number: the rule fails and says so', () => {
    const findings = runReportQa(withLine('INV-A', { endNav: 'n/a' }), SETTINGS);
    expect(of(findings, 'QA-RF-01', 'INV-A').passed).toBe(false);
    expect(of(findings, 'QA-RF-01', 'INV-A').detail).toContain('not a number');
  });
});
