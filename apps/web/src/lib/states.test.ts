import { describe, expect, it } from 'vitest';
import { capitalNoticeMachine, valuationMachine } from '@pb/workflows';
import {
  commandLabel,
  commandOptions,
  dueLabel,
  dueTone,
  humanizeState,
  noticeTone,
  rolesLabel,
  valuationTone,
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
