import { describe, expect, it } from 'vitest';
import type { QaFindingRow, ReportPackageLine } from '@pb/contracts';
import { MISSING } from '../../../lib/format.js';
import {
  generatedDetailFixture,
  packageContentFixture,
  packageDetailFixture,
  CLIENT_ID,
  PKG_PERIOD,
  PKG_PERSON,
  PKG_PRIOR_PERIOD,
} from '../../../test/fixtures-packages.js';
import {
  beginNavCell,
  changeLogRows,
  clientShareRows,
  endNavCell,
  explanationRows,
  findingResult,
  gainLossCell,
  generatedBy,
  markCell,
  NEW_THIS_QUARTER,
  NO_END_MARK,
  NO_START_MARK,
  overridesOf,
  RESULT_WORDS,
  splitFindings,
} from './packages.js';

/** An identifier a page must never show: a rule code, or a uuid. */
const IDENTIFIER = /QA-[A-Z]+-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const [held, stale, entered] = packageContentFixture().lines as [
  ReportPackageLine,
  ReportPackageLine,
  ReportPackageLine,
];

const line = (overrides: Partial<ReportPackageLine>): ReportPackageLine => ({
  ...held,
  ...overrides,
});

const override = (at: string, reason = 'The stale mark is disclosed in the cover letter.') => ({
  reason,
  approver: PKG_PERSON.approver,
  at,
});

describe('the result of a check', () => {
  const findings = generatedDetailFixture().findings;
  const failed = findings.filter((f) => !f.passed);

  it('is failed, overridden or passed, in words', () => {
    expect(failed).toHaveLength(1);
    expect(findingResult(failed[0]!)).toBe('failed');
    expect(findingResult({ ...failed[0]!, override: override('2025-08-16T09:00:00.000Z') })).toBe(
      'overridden',
    );
    expect(findingResult(findings.find((f) => f.passed)!)).toBe('passed');
    expect(RESULT_WORDS).toEqual({
      failed: 'Failed',
      overridden: 'Overridden',
      passed: 'Passed',
    });
  });

  it('keeps the checks that did not pass apart from those that did, each in the order sent', () => {
    const split = splitFindings(findings);
    expect(split.notPassed).toEqual(failed);
    expect(split.passed).toHaveLength(findings.length - 1);
    expect(split.passed).toEqual(findings.filter((f) => f.passed));
    // An overridden check still did not pass: it stays with the failures.
    const overridden = findings.map((f) =>
      f.passed ? f : { ...f, override: override('2025-08-16T09:00:00.000Z') },
    );
    expect(splitFindings(overridden).notPassed).toHaveLength(1);
    expect(splitFindings([])).toEqual({ notPassed: [], passed: [] });
  });
});

describe('the override of a run', () => {
  const base = generatedDetailFixture().findings[0]!;
  const finding = (id: number, patch: Partial<QaFindingRow>): QaFindingRow => ({
    ...base,
    id: `00000000-0000-4000-8000-${String(970_000 + id).padStart(12, '0')}`,
    ...patch,
  });

  it('is said once for every check it covers, with who, when and why', () => {
    const at = '2025-08-16T09:00:00.000Z';
    const out = overridesOf([
      finding(1, { override: override(at) }),
      finding(2, { override: override(at) }),
      finding(3, { override: override(at) }),
      finding(4, { passed: true }),
    ]);
    expect(out).toEqual([
      {
        reason: 'The stale mark is disclosed in the cover letter.',
        approver: 'Morgan Lindqvist',
        at,
        checks: 3,
      },
    ]);
    expect(JSON.stringify(out)).not.toMatch(IDENTIFIER);
  });

  it('keeps two overrides apart when the time or the reason differs', () => {
    const out = overridesOf([
      finding(1, { override: override('2025-08-16T09:00:00.000Z') }),
      finding(2, { override: override('2025-08-17T10:30:00.000Z', 'Agreed with the client.') }),
    ]);
    expect(out.map((o) => [o.reason, o.checks])).toEqual([
      ['The stale mark is disclosed in the cover letter.', 1],
      ['Agreed with the client.', 1],
    ]);
  });

  it('is nothing while no check was overridden', () => {
    expect(overridesOf(generatedDetailFixture().findings)).toEqual([]);
    expect(overridesOf([])).toEqual([]);
  });
});

describe('the figures of a position', () => {
  it('shows a held and marked line in millions, as every table does', () => {
    expect(beginNavCell(held)).toEqual({ text: '$11.9M' });
    expect(gainLossCell(held)).toEqual({ text: '$0.3M' });
    expect(endNavCell(held)).toEqual({ text: '$12.5M' });
    expect(markCell(held, PKG_PERIOD)).toEqual({ text: 'Quarter end' });
  });

  it('says of a line with no mark for the quarter which mark it was rolled forward from', () => {
    expect(stale.endNavPeriodEnd).toBe(PKG_PRIOR_PERIOD);
    expect(endNavCell(stale)).toEqual({ text: '$4.1M' });
    // A gain of nothing is a figure, not a missing one.
    expect(gainLossCell(stale)).toEqual({ text: '$0.0M' });
    expect(markCell(stale, PKG_PERIOD)).toEqual({ text: 'Rolled forward from Mar 31, 2025' });
  });

  it('reads the begin NAV of a position entered in the quarter as new, never as zero', () => {
    expect(beginNavCell(entered)).toEqual({ text: NEW_THIS_QUARTER });
    expect(NEW_THIS_QUARTER).toBe('New this quarter');
    expect(beginNavCell(line({ enteredInPeriod: true, beginNav: '0' }))).toEqual({
      text: NEW_THIS_QUARTER,
    });
    expect(gainLossCell(entered)).toEqual({ text: '$0.3M' });
    // A begin NAV the package stores for a new position is shown: the page hides no stored figure.
    expect(beginNavCell(line({ enteredInPeriod: true, beginNav: '2500000' }))).toEqual({
      text: '$2.5M',
    });
  });

  it('shows the placeholder, with the reason, for a held line with no locked mark at the quarter start', () => {
    const noStart = line({ beginNav: null, gainLoss: null, recordedQuarterStartNav: null });
    expect(beginNavCell(noStart)).toEqual({ text: MISSING, why: NO_START_MARK });
    expect(gainLossCell(noStart)).toEqual({ text: MISSING, why: NO_START_MARK });
    expect(NO_START_MARK).toBe('Not calculable: no locked mark at the start of the quarter');
    // The end NAV is on record all the same.
    expect(endNavCell(noStart)).toEqual({ text: '$12.5M' });
  });

  it('shows the placeholder for a line with no end NAV, never zero and never another quarter', () => {
    const noEnd = line({
      endNav: null,
      endNavPeriodEnd: null,
      endNavMarkDate: null,
      gainLoss: null,
    });
    expect(endNavCell(noEnd)).toEqual({ text: MISSING, why: NO_END_MARK });
    expect(gainLossCell(noEnd)).toEqual({ text: MISSING, why: NO_END_MARK });
    expect(markCell(noEnd, PKG_PERIOD)).toEqual({ text: MISSING, why: NO_END_MARK });
    expect(NO_END_MARK).toBe('Not calculable: no locked mark on or before the end of the quarter');
    // The begin NAV it does have is still shown.
    expect(beginNavCell(noEnd)).toEqual({ text: '$11.9M' });
  });

  it('does not guess the quarter of a mark the package did not record', () => {
    expect(markCell(line({ endNavPeriodEnd: null }), PKG_PERIOD)).toEqual({
      text: MISSING,
      why: 'The quarter of the mark is not recorded',
    });
  });

  it("says which day the quarter's own mark is dated when the sponsor closed a few days off the quarter end", () => {
    // Dated June the 27th and reporting for the quarter to June the 30th: not rolled forward.
    const early = line({ endNavPeriodEnd: PKG_PERIOD, endNavMarkDate: '2025-06-27' });
    expect(markCell(early, PKG_PERIOD)).toEqual({ text: 'Quarter mark dated Jun 27, 2025' });
    const late = line({ endNavPeriodEnd: PKG_PERIOD, endNavMarkDate: '2025-07-03' });
    expect(markCell(late, PKG_PERIOD)).toEqual({ text: 'Quarter mark dated Jul 3, 2025' });
  });

  it('names a mark that was rolled forward by the day it is dated, not by the quarter end it reports for', () => {
    const earlier = line({ ...stale, endNavMarkDate: '2025-03-28' });
    expect(earlier.endNavPeriodEnd).toBe(PKG_PRIOR_PERIOD);
    expect(markCell(earlier, PKG_PERIOD)).toEqual({ text: 'Rolled forward from Mar 28, 2025' });
  });

  it('reads a position exited at zero, which no mark stands behind, as the quarter end', () => {
    const exited = line({ endNav: '0', endNavPeriodEnd: PKG_PERIOD, endNavMarkDate: null });
    expect(markCell(exited, PKG_PERIOD)).toEqual({ text: 'Quarter end' });
  });
});

describe('who generated a package', () => {
  it('is whoever ran the latest generation, else the preparer', () => {
    expect(generatedBy(packageDetailFixture())).toBe('Imogen Tavares');
    const detail = generatedDetailFixture();
    expect(generatedBy(detail)).toBe('Imogen Tavares');
    const second = { ...detail.changeLog[0]!, runNo: 2, by: PKG_PERSON.operations };
    expect(generatedBy({ ...detail, changeLog: [...detail.changeLog, second] })).toBe(
      'Avery Mbeki',
    );
    // The order the runs came in does not decide which is the latest.
    expect(generatedBy({ ...detail, changeLog: [second, ...detail.changeLog] })).toBe(
      'Avery Mbeki',
    );
  });
});

describe('the client share of a package', () => {
  const share = (ref: string, ownershipPct: string, nav: string) => ({
    clientRef: CLIENT_ID.alpha,
    ref,
    ownershipPct,
    nav,
  });

  it('reads in the order of the positions table, whatever vehicle each line came with', () => {
    // Stored vehicle by vehicle: the 45% vehicle first, then the 60% one.
    const stored = [
      share('INV-0006', '0.45', '12465000'),
      share('INV-0014', '0.45', '10260000'),
      share('INV-0001', '0.6', '5220000'),
      share('INV-0008', '0.6', '21060000'),
    ];
    expect(clientShareRows(stored).map((line) => line.ref)).toEqual([
      'INV-0001',
      'INV-0006',
      'INV-0008',
      'INV-0014',
    ]);
    // Nothing is changed or added up: the same lines, as stored.
    expect([...clientShareRows(stored)].sort((a, b) => a.nav.localeCompare(b.nav))).toEqual(
      [...stored].sort((a, b) => a.nav.localeCompare(b.nav)),
    );
    expect(stored[0]!.ref).toBe('INV-0006');
  });

  it('keeps two lines of one position in the order they were stored', () => {
    const stored = [
      share('INV-0002', '0.2', '814999.9'),
      share('INV-0001', '0.2', '2490190.05'),
      share('INV-0002', '0.05', '203749.98'),
    ];
    expect(clientShareRows(stored).map((line) => `${line.ref} ${line.ownershipPct}`)).toEqual([
      'INV-0001 0.2',
      'INV-0002 0.2',
      'INV-0002 0.05',
    ]);
    expect(clientShareRows([])).toEqual([]);
  });
});

describe('the tie-out explanations of a package', () => {
  it('lists each explained position once, by position number', () => {
    expect(
      explanationRows({
        'INV-0008': 'The March mark was restated after the release.',
        'INV-0002': 'A late distribution was booked to the prior quarter.',
      }),
    ).toEqual([
      { ref: 'INV-0002', text: 'A late distribution was booked to the prior quarter.' },
      { ref: 'INV-0008', text: 'The March mark was restated after the release.' },
    ]);
    expect(explanationRows({})).toEqual([]);
  });
});

describe('the change log of a package', () => {
  it('lists the generation runs newest first, with what each counted', () => {
    const detail = generatedDetailFixture();
    const first = detail.changeLog[0]!;
    const second = {
      ...first,
      at: '2025-08-16T08:00:00.000Z',
      runNo: 2,
      findings: 26,
      failed: 0,
    };
    expect(changeLogRows([first, second])).toEqual([
      {
        runNo: 2,
        at: 'Aug 16, 2025 08:00:00 UTC',
        by: 'Imogen Tavares',
        positions: 3,
        checks: 26,
        failed: 0,
      },
      {
        runNo: 1,
        at: 'Aug 15, 2025 10:12:00 UTC',
        by: 'Imogen Tavares',
        positions: 3,
        checks: 26,
        failed: 1,
      },
    ]);
    expect(changeLogRows([])).toEqual([]);
    expect(JSON.stringify(changeLogRows([first, second]))).not.toMatch(IDENTIFIER);
  });
});
