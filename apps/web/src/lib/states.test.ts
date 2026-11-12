import { describe, expect, it } from 'vitest';
import { documentReviewStatus, expectedDocumentStatus, extractionRunState } from '@pb/contracts';
import {
  capitalNoticeMachine,
  closingMachine,
  dealChangeRequestMachine,
  dealStageMachine,
  stagingMachine,
  valuationMachine,
  wireInstructionMachine,
} from '@pb/workflows';
import {
  changeRequestTone,
  closingTone,
  commandLabel,
  commandOptions,
  dueLabel,
  dueTone,
  expectedStatusTone,
  humanizeState,
  noticeTone,
  reviewStatusTone,
  rolesLabel,
  runStateTone,
  runStateWord,
  stageTone,
  stagingTone,
  ticketTone,
  valuationTone,
  wireTone,
} from './states.js';

describe('state words', () => {
  it('turns machine states and commands into plain words', () => {
    expect(humanizeState('OpsPrepared')).toBe('Ops prepared');
    expect(humanizeState('Locked')).toBe('Locked');
    expect(commandLabel('dealTeamApprove')).toBe('Deal team approve');
    expect(commandLabel('lock')).toBe('Lock');
    expect(rolesLabel(['approver', 'deal_team'])).toBe('approver or deal team');
  });

  it('gives every state a tone the Badge can say in a word', () => {
    for (const s of valuationMachine.states) expect(typeof valuationTone(s)).toBe('string');
    for (const s of capitalNoticeMachine.states) expect(typeof noticeTone(s)).toBe('string');
    expect(valuationTone('Locked')).toBe('good');
    expect(valuationTone('Draft')).toBe('neutral');
    expect(noticeTone('Reconciled')).toBe('good');
    expect(noticeTone('Extracted')).toBe('watch');
    expect(noticeTone('Received')).toBe('neutral');
    expect(noticeTone('TicketApproved')).toBe('brand');
    expect(noticeTone('Unknown')).toBe('neutral');
    expect(humanizeState('TicketDrafted')).toBe('Ticket drafted');
    for (const s of stagingMachine.states) expect(typeof stagingTone(s)).toBe('string');
    expect(stagingTone('flagged')).toBe('watch');
    expect(stagingTone('rejected')).toBe('bad');
    expect(stagingTone('promoted')).toBe('good');
    expect(stagingTone('validated')).toBe('neutral');
    expect(stagingTone('new')).toBe('neutral');
    expect(humanizeState('validated')).toBe('Validated');
  });

  it('tones the document hub states once for every page (docs/18 sections 6 and 7)', () => {
    for (const s of documentReviewStatus.options) expect(typeof reviewStatusTone(s)).toBe('string');
    expect(reviewStatusTone('Classified')).toBe('good');
    expect(reviewStatusTone('NeedsReview')).toBe('watch');
    expect(reviewStatusTone('Duplicate')).toBe('neutral');
    expect(reviewStatusTone('Received')).toBe('neutral');
    for (const s of expectedDocumentStatus.options)
      expect(typeof expectedStatusTone(s)).toBe('string');
    expect(expectedStatusTone('received')).toBe('good');
    expect(expectedStatusTone('late')).toBe('watch');
    expect(expectedStatusTone('missing')).toBe('bad');
    expect(expectedStatusTone('expected')).toBe('neutral');
    for (const s of extractionRunState.options) expect(typeof runStateTone(s)).toBe('string');
    expect(runStateTone('Succeeded')).toBe('good');
    expect(runStateTone('Failed')).toBe('bad');
    expect(runStateTone('NeedsRetry')).toBe('watch');
    // In flight on the service's side: neutral on the hub, the extraction page, the board and the deal tab alike.
    expect(runStateTone('Queued')).toBe('neutral');
    expect(runStateTone('Running')).toBe('neutral');
    expect(runStateWord('NeedsRetry')).toBe('Needs retry');
    expect(runStateWord('Succeeded')).toBe('Succeeded');
  });

  it('tones the Phase 3 controls once for every page (docs/18 sections 4, 8, 11 and 12, SEC-12)', () => {
    for (const s of wireInstructionMachine.states) expect(typeof wireTone(s)).toBe('string');
    expect(wireTone('Proposed')).toBe('watch');
    expect(wireTone('Verified')).toBe('good');
    expect(wireTone('Rejected')).toBe('bad');
    expect(wireTone('Superseded')).toBe('neutral');
    expect(ticketTone('Drafted')).toBe('watch');
    expect(ticketTone('Approved')).toBe('brand');
    expect(ticketTone('Funded')).toBe('good');
    expect(ticketTone('Withdrawn')).toBe('neutral');
    for (const s of dealChangeRequestMachine.states)
      expect(typeof changeRequestTone(s)).toBe('string');
    expect(changeRequestTone('Submitted')).toBe('watch');
    expect(changeRequestTone('Routed')).toBe('brand');
    expect(changeRequestTone('InProgress')).toBe('brand');
    expect(changeRequestTone('Applied')).toBe('good');
    expect(changeRequestTone('Rejected')).toBe('bad');
    for (const s of dealStageMachine.states) expect(typeof stageTone(s)).toBe('string');
    expect(stageTone('Sourced')).toBe('neutral');
    expect(stageTone('Diligence')).toBe('brand');
    expect(stageTone('IC')).toBe('watch');
    expect(stageTone('Approved')).toBe('good');
    expect(stageTone('Closing')).toBe('brand');
    expect(stageTone('Closed')).toBe('good');
    expect(stageTone('Passed')).toBe('neutral');
    for (const s of closingMachine.states) expect(typeof closingTone(s)).toBe('string');
    expect(closingTone('Open')).toBe('watch');
    expect(closingTone('OpsConfirmed')).toBe('good');
    // A value no map lists reads neutral rather than throwing.
    expect(wireTone('Unknown')).toBe('neutral');
    expect(stageTone('Unknown')).toBe('neutral');
    expect(humanizeState('InProgress')).toBe('In progress');
    expect(humanizeState('OpsConfirmed')).toBe('Ops confirmed');
  });

  it('grades due dates against the configured alert window', () => {
    expect(dueTone(-3, [3, 1, 0])).toBe('bad');
    expect(dueTone(0, [3, 1, 0])).toBe('watch');
    expect(dueTone(3, [3, 1, 0])).toBe('watch');
    expect(dueTone(4, [3, 1, 0])).toBe('neutral');
    expect(dueLabel(-1)).toBe('Overdue by 1 day');
    expect(dueLabel(-7)).toBe('Overdue by 7 days');
    expect(dueLabel(0)).toBe('Due today');
    expect(dueLabel(1)).toBe('Due tomorrow');
    expect(dueLabel(12)).toBe('Due in 12 days');
  });
});

describe('commandOptions', () => {
  it('lists the table rows from a state and marks which the actor may issue', () => {
    const fromDraft = commandOptions(valuationMachine, 'Draft', ['operations']);
    expect(fromDraft.map((o) => o.command)).toEqual(['prepare']);
    expect(fromDraft[0]?.allowed).toBe(true);
    const viewer = commandOptions(valuationMachine, 'DealTeamApproved', ['viewer']);
    expect(viewer).toEqual([
      expect.objectContaining({
        command: 'lock',
        to: 'Locked',
        allowed: false,
        needsReason: false,
      }),
    ]);
    const approver = commandOptions(valuationMachine, 'DealTeamApproved', ['approver']);
    expect(approver[0]?.allowed).toBe(true);
  });

  it('flags the commands whose table row requires a reason', () => {
    const ops = commandOptions(valuationMachine, 'OpsPrepared', ['operations']);
    expect(ops.find((o) => o.command === 'sendBack')?.needsReason).toBe(true);
    expect(commandOptions(valuationMachine, 'Locked', ['approver'])[0]?.needsReason).toBe(true);
    expect(commandOptions(capitalNoticeMachine, 'Reviewed', ['operations'])[0]?.needsReason).toBe(
      false,
    );
  });

  it('returns nothing from a terminal state', () => {
    expect(commandOptions(valuationMachine, 'Reopened', ['operations', 'approver'])).toEqual([]);
    expect(commandOptions(capitalNoticeMachine, 'Reconciled', ['operations'])).toEqual([]);
  });
});
