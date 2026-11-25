import { describe, expect, it } from 'vitest';
import { attempt } from './machine.js';
import { reportingPackageMachine } from './machines.js';
import type { ReportingPackageCommand, ReportingPackageState } from './machines.js';
import { packageCommandRecord, packageStepIsInvestorRelations } from './controls-package.js';

const STARTER = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const THIRD = '10000000-0000-4000-8000-000000000003';
const APPROVER = '10000000-0000-4000-8000-000000000004';

describe('packageCommandRecord: who prepared a package, as the machine reads it', () => {
  it('names whoever started it, everyone who ran a generation once each, and whoever submitted it', () => {
    expect(
      packageCommandRecord({
        preparedBy: STARTER,
        runs: [{ by: THIRD }, { by: SECOND }, { by: THIRD }],
        submittedBy: SECOND,
      }),
    ).toEqual({ preparedBy: STARTER, generatedBy: [SECOND, THIRD], submittedBy: SECOND });
    // A Draft: nobody generated it and nobody submitted it.
    expect(packageCommandRecord({ preparedBy: STARTER, runs: [], submittedBy: null })).toEqual({
      preparedBy: STARTER,
      generatedBy: [],
      submittedBy: null,
    });
  });

  it('gives the machine a record it refuses each of those people on, and nobody else', () => {
    const record = packageCommandRecord({
      preparedBy: STARTER,
      runs: [{ by: SECOND }],
      submittedBy: THIRD,
    });
    const ok = (state: ReportingPackageState, command: ReportingPackageCommand, actorId: string) =>
      attempt(reportingPackageMachine, state, command, {
        actorId,
        actorRoles: ['approver'],
        reason: 'Agreed with the client',
        record: { ...record },
      }).ok;
    expect([STARTER, SECOND, THIRD, APPROVER].map((who) => ok('InReview', 'approve', who))).toEqual(
      [false, false, false, true],
    );
    // Nobody has submitted a package whose checks failed: the submitter rule is approve's alone.
    expect(
      [STARTER, SECOND, THIRD, APPROVER].map((who) => ok('QAFailed', 'overrideQa', who)),
    ).toEqual([false, false, true, true]);
  });
});

describe('packageStepIsInvestorRelations: the steps a person takes as investor relations alone', () => {
  const is = (
    state: ReportingPackageState,
    command: ReportingPackageCommand,
    roles: string[],
  ): boolean => packageStepIsInvestorRelations(state, command, roles);

  it('is every step the table gives to investor relations, whatever second role the person holds', () => {
    for (const second of ['approver', 'operations', 'deal_team', 'auditor']) {
      const roles = ['investor_relations', second];
      expect(is('Draft', 'generate', roles), second).toBe(true);
      expect(is('QAFailed', 'regenerate', roles), second).toBe(true);
      expect(is('QAPassed', 'submit', roles), second).toBe(true);
    }
    expect(is('Draft', 'generate', ['investor_relations'])).toBe(true);
  });

  it('is not a step the person may take under another role of the table', () => {
    // An approver overrides and approves for every client.
    expect(is('QAFailed', 'overrideQa', ['investor_relations', 'approver'])).toBe(false);
    expect(is('InReview', 'approve', ['investor_relations', 'approver'])).toBe(false);
    // Operations release for every client; investor relations for their own.
    expect(is('Approved', 'release', ['investor_relations', 'operations'])).toBe(false);
    expect(is('Approved', 'release', ['operations'])).toBe(false);
    expect(is('Approved', 'release', ['investor_relations', 'approver'])).toBe(true);
    expect(is('Approved', 'release', ['investor_relations'])).toBe(true);
  });

  it('leaves to the machine a command the table refuses and a person who holds none of its roles', () => {
    expect(is('Released', 'generate', ['investor_relations'])).toBe(false);
    expect(is('Draft', 'submit', ['investor_relations', 'approver'])).toBe(false);
    expect(is('Draft', 'generate', ['approver', 'operations'])).toBe(false);
    expect(is('Generated', 'qaPass', ['investor_relations'])).toBe(false);
  });
});
