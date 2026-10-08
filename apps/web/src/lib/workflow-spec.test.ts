import { describe, expect, it } from 'vitest';
import { MACHINES, dealStageMachine, extractionRunMachine, valuationMachine } from '@pb/workflows';
import { commandLabel, humanizeState } from './states.js';
import { ruleOf, stepRows } from './workflow-spec.js';

const EM_DASH = String.fromCharCode(0x2014);

describe('a workflow as a table of steps', () => {
  it('folds the steps that differ only in where they start into one row', () => {
    const rows = stepRows(dealStageMachine);
    const pass = rows.filter((r) => r.step === 'Pass');
    expect(pass).toHaveLength(1);
    expect(pass[0]?.from).toEqual([
      'Sourced',
      'Screening',
      'Prescreen',
      'Diligence',
      'IC',
      'Approved',
      'Closing',
    ]);
    expect(pass[0]?.who).toBe('Deal team or approver');
  });

  it('names each rule in the words of the transition table, and a step without one as null', () => {
    const rows = stepRows(dealStageMachine);
    const step = (from: string, to: string) => rows.find((r) => r.from[0] === from && r.to === to);
    expect(step('IC', 'Approved')?.rule).toBe('An IC decision record is required.');
    expect(step('Diligence', 'IC')?.rule).toBe(
      'Required diligence tasks are open; an Approver may override with a reason.',
    );
    expect(step('Passed', 'Screening')?.rule).toBe('A reason is required.');
    expect(step('Sourced', 'Screening')?.rule).toBeNull();
  });

  it('lists every check of a combined rule, not just the first that fails', () => {
    const close = stepRows(dealStageMachine).find((r) => r.to === 'Closed');
    expect(close?.rule).toBe(
      'The closing checklist is incomplete. Allocations do not tie to the closing commitment (M22).',
    );
  });

  it('shows a note where the rule depends on what has already happened', () => {
    const retry = stepRows(extractionRunMachine).find((r) => r.step === 'Schedule retry');
    expect(retry?.rule).toBe(
      'A schema failure retries once and a transient one three times; after that the run fails.',
    );
  });

  it('adds a step note after its rule', () => {
    const reopen = valuationMachine.transitions.find((t) => t.command === 'reopen');
    expect(reopen && ruleOf(reopen)).toBe(
      'A reason is required. Creates a new Draft version and alerts prior approvers.',
    );
  });

  it('covers every transition of every machine once, in plain words', () => {
    for (const machine of Object.values(MACHINES)) {
      const rows = stepRows(machine);
      expect(
        rows.reduce((n, r) => n + r.from.length, 0),
        machine.name,
      ).toBe(machine.transitions.length);
      const text = JSON.stringify(rows);
      expect(text, machine.name).not.toContain(EM_DASH);
      expect(text, machine.name).not.toMatch(/_/);
    }
  });
});

describe('state and command names in words', () => {
  it('keeps IC and QA in capitals', () => {
    expect(humanizeState('IC')).toBe('IC');
    expect(humanizeState('QAFailed')).toBe('QA failed');
    expect(humanizeState('InReview')).toBe('In review');
    expect(commandLabel('qaFail')).toBe('QA fail');
    expect(commandLabel('overrideQa')).toBe('Override QA');
  });

  it('starts every label with a capital', () => {
    expect(humanizeState('validated')).toBe('Validated');
    expect(humanizeState('DealTeamApproved')).toBe('Deal team approved');
  });
});
