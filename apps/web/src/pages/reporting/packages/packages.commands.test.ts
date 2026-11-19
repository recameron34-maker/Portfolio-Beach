import { describe, expect, it } from 'vitest';
import { reportPackageCommandBody } from '@pb/contracts';
import type { ReportPackageDetail } from '@pb/contracts';
import {
  generatedDetailFixture,
  overriddenDetailFixture,
  packageContentFixture,
  packageDetailFixture,
  PKG_PERSON,
} from '../../../test/fixtures-packages.js';
import {
  commandResultWords,
  EXPLANATION_PROBLEM,
  explanationProblem,
  openFailures,
  overrideSubject,
  regenerateBody,
  tieOutWords,
  unexplainedTieOuts,
} from './packages.js';

/** An identifier a page must never show: a rule code, or a uuid. */
const IDENTIFIER = /QA-[A-Z]+-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A package whose prior quarter was released: INV-0001 began 400,000.00 above the released end
 * NAV and INV-0002 100,000.00 below it, so both tie-outs fail until each is explained.
 */
function tieOutBreak(explanations: Record<string, string> = {}): ReportPackageDetail {
  const content = packageContentFixture({
    status: 'preliminary',
    priorRelease: {
      endNav: { 'INV-0001': '11500000', 'INV-0002': '4300000' },
      explanations,
    },
  });
  return generatedDetailFixture(
    { label: 'preliminary', tieOutExplanations: explanations },
    content,
  );
}

describe('the tie-outs a regeneration asks about', () => {
  it('are the positions whose tie-out failed with no explanation on record', () => {
    const gaps = unexplainedTieOuts(tieOutBreak());
    expect(gaps.map((g) => g.entityRef)).toEqual(['INV-0001', 'INV-0002']);
    // Each carries what the check compared: the last released end NAV and this begin NAV.
    expect(gaps.map((g) => [g.expected, g.actual])).toEqual([
      ['11500000', '11900000'],
      ['4300000', '4200000'],
    ]);
  });

  it('leave out a position that is explained, and one whose tie-out passed', () => {
    const explained = tieOutBreak({ 'INV-0001': 'The March mark was restated after the release.' });
    expect(unexplainedTieOuts(explained).map((g) => g.entityRef)).toEqual(['INV-0002']);
    expect(
      unexplainedTieOuts(
        tieOutBreak({
          'INV-0001': 'The March mark was restated after the release.',
          'INV-0002': 'A late distribution was booked to the prior quarter.',
        }),
      ),
    ).toEqual([]);
    // An explanation of blanks is no explanation.
    expect(
      unexplainedTieOuts({ ...tieOutBreak(), tieOutExplanations: { 'INV-0001': '   ' } }).map(
        (g) => g.entityRef,
      ),
    ).toEqual(['INV-0001', 'INV-0002']);
  });

  it('are none when no package was released before, when nothing failed and on a draft', () => {
    // The label check failed here, not a tie-out: there is nothing to explain.
    expect(generatedDetailFixture().qa.failed).toBe(1);
    expect(unexplainedTieOuts(generatedDetailFixture())).toEqual([]);
    expect(unexplainedTieOuts(packageDetailFixture())).toEqual([]);
  });
});

describe('what a failed tie-out compared', () => {
  it('says both figures to the cent', () => {
    expect(tieOutWords({ expected: '4300000', actual: '4200000' })).toBe(
      'Last released $4,300,000.00, begin NAV $4,200,000.00.',
    );
    expect(tieOutWords(unexplainedTieOuts(tieOutBreak())[0]!)).toBe(
      'Last released $11,500,000.00, begin NAV $11,900,000.00.',
    );
  });

  it('says a side that is not there in words, never as a figure', () => {
    expect(tieOutWords({ expected: null, actual: '4200000' })).toBe(
      'Not in the last released package, begin NAV $4,200,000.00.',
    );
    expect(tieOutWords({ expected: '4300000', actual: null })).toBe(
      'Last released $4,300,000.00, no begin NAV in this package.',
    );
    expect(tieOutWords({ expected: null, actual: null })).toBe(
      'Not in the last released package, no begin NAV in this package.',
    );
  });
});

describe('an explanation of a tie-out', () => {
  it('is optional, and 3 to 500 characters when given', () => {
    expect(explanationProblem('')).toBeNull();
    expect(explanationProblem('   ')).toBeNull();
    expect(explanationProblem('ab')).toBe(EXPLANATION_PROBLEM);
    expect(explanationProblem('  ab  ')).toBe(EXPLANATION_PROBLEM);
    expect(explanationProblem('abc')).toBeNull();
    expect(explanationProblem('x'.repeat(500))).toBeNull();
    expect(explanationProblem('x'.repeat(501))).toBe(EXPLANATION_PROBLEM);
    expect(EXPLANATION_PROBLEM).toBe('Give 3 to 500 characters, or leave the box empty.');
  });

  it('goes into the command by position, trimmed, and an empty box is left out', () => {
    const body = regenerateBody({
      'INV-0001': '  The March mark was restated after the release.  ',
      'INV-0002': '   ',
    });
    expect(body).toEqual({
      command: 'regenerate',
      explanations: { 'INV-0001': 'The March mark was restated after the release.' },
    });
    expect(reportPackageCommandBody.safeParse(body).success).toBe(true);
  });

  it('sends a plain regenerate when every box is empty, and nothing while one is too short', () => {
    expect(regenerateBody({})).toEqual({ command: 'regenerate' });
    expect(regenerateBody({ 'INV-0001': '', 'INV-0002': ' ' })).toEqual({ command: 'regenerate' });
    expect(regenerateBody({ 'INV-0001': 'ab', 'INV-0002': 'A full explanation.' })).toBeNull();
    expect(regenerateBody({ 'INV-0001': 'x'.repeat(501) })).toBeNull();
  });
});

describe('the override of the failed checks', () => {
  it('counts the failed checks no approver has overridden yet', () => {
    expect(openFailures(generatedDetailFixture().findings)).toBe(1);
    expect(openFailures(tieOutBreak().findings)).toBe(2);
    expect(openFailures(overriddenDetailFixture().findings)).toBe(0);
    expect(openFailures([])).toBe(0);
  });

  it('says what the reason is recorded against, and under whose name', () => {
    expect(overrideSubject(3)).toBe(
      'The reason is recorded against all 3 failed checks of this run, with your name.',
    );
    expect(overrideSubject(1)).toBe(
      'The reason is recorded against the 1 failed check of this run, with your name.',
    );
  });
});

describe('the result of a command in words', () => {
  it('says what a generation found and where the package stands', () => {
    expect(commandResultWords('generate', generatedDetailFixture())).toBe(
      'Client Alpha Pension, Q2 2025, gross, version 1 is now QA failed: 1 of 26 checks failed in run 1',
    );
    const passed = generatedDetailFixture(
      { label: 'preliminary' },
      packageContentFixture({ status: 'preliminary' }),
    );
    expect(commandResultWords('regenerate', { ...passed, qa: { ...passed.qa, runNo: 2 } })).toBe(
      'Client Alpha Pension, Q2 2025, gross, version 1 is now QA passed: all 26 checks passed in run 2',
    );
  });

  it('says how many failed checks an override covered', () => {
    expect(commandResultWords('overrideQa', overriddenDetailFixture())).toBe(
      'Client Alpha Pension, Q2 2025, gross, version 1 is now QA passed: 1 failed check overridden',
    );
  });

  it('says where the package stands after every other step, with no id in it', () => {
    const at = (state: ReportPackageDetail['state']): ReportPackageDetail =>
      overriddenDetailFixture({ state, reviewer: PKG_PERSON.approver });
    expect(commandResultWords('submit', at('InReview'))).toBe(
      'Client Alpha Pension, Q2 2025, gross, version 1 is now In review',
    );
    expect(commandResultWords('approve', at('Approved'))).toBe(
      'Client Alpha Pension, Q2 2025, gross, version 1 is now Approved',
    );
    expect(commandResultWords('release', at('Released'))).toBe(
      'Client Alpha Pension, Q2 2025, gross, version 1 is now Released',
    );
    for (const command of ['generate', 'overrideQa', 'submit', 'approve', 'release'] as const)
      expect(commandResultWords(command, at('QAPassed'))).not.toMatch(IDENTIFIER);
  });
});
