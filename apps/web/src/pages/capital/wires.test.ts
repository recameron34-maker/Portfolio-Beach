import { describe, expect, it } from 'vitest';
import {
  capitalNoticeAlert,
  releaseBlocker,
  tradeTicketState,
  wireInstructionState,
} from '@pb/contracts';
import { ID } from '../../test/fixtures.js';
import { noticeRows, ticketRows, wireRows, WIRE_ID } from '../../test/fixtures-capital.js';
import {
  ALERT_WORDS,
  BLOCKER_WORDS,
  blockerLabel,
  filterTickets,
  isTicketState,
  nothingToRelease,
  RELEASE_ALLOWED,
  ticketNoticeLabel,
} from './tickets.js';
import { ticketTone, wireTone } from '../../lib/states.js';
import {
  callbackBody,
  callbackWords,
  counterpartyFilter,
  counterpartyNames,
  dayOf,
  EMPTY_CALLBACK_FORM,
  EMPTY_PROPOSE_FORM,
  filterWires,
  isWireState,
  kindLabel,
  parsedProposeBody,
  proposeProblems,
  SECOND_PERSON_RULE,
} from './wires.js';
import type { ProposeForm } from './wires.js';

const EM_DASH = String.fromCharCode(0x2014);

const validForm: ProposeForm = {
  ...EMPTY_PROPOSE_FORM,
  kind: 'sponsor_fund',
  counterpartyId: '00000000-0000-4000-8000-000000000611',
  counterpartyName: ' Silverline Partners Fund II ',
  bankName: 'Harbor Street Bank',
  accountName: 'Silverline Partners Fund II',
  accountNumber: '4455667799',
  routingCode: '021000021',
};

describe('wire register helpers', () => {
  it('filters the register by state and counterparty and lists the names once', () => {
    const rows = wireRows();
    expect(filterWires(rows, { state: '', counterparty: '' })).toHaveLength(4);
    expect(filterWires(rows, { state: 'Proposed', counterparty: '' }).map((w) => w.id)).toEqual([
      WIRE_ID.proposed,
    ]);
    expect(
      filterWires(rows, { state: '', counterparty: 'Summit Services Co' }).map((w) => w.version),
    ).toEqual([2, 1]);
    expect(
      filterWires(rows, { state: 'Verified', counterparty: 'Summit Services Co' }),
    ).toHaveLength(1);
    expect(counterpartyNames(rows)).toEqual(['Silverline Partners Fund II', 'Summit Services Co']);
    for (const s of wireInstructionState.options) expect(isWireState(s)).toBe(true);
    expect(isWireState('Pending')).toBe(false);
  });

  it('names the kind, the day, the callback and the query of a counterparty', () => {
    expect(callbackWords(null)).toBe('-');
    expect(callbackWords(wireRows()[3]!.callback)).toBe(
      'Mina Halvorsen: confirmed (fund administrator)',
    );
    expect(kindLabel('investment')).toBe('Investment');
    expect(kindLabel('sponsor_fund')).toBe('Sponsor fund');
    expect(dayOf('2025-07-10T09:00:00.000Z')).toBe('2025-07-10');
    expect(counterpartyFilter({ kind: 'investment', id: ID.inv3, name: 'x' })).toEqual({
      investmentId: ID.inv3,
    });
    expect(counterpartyFilter({ kind: 'sponsor_fund', id: ID.sponsor1, name: 'x' })).toEqual({
      sponsorFundId: ID.sponsor1,
    });
  });

  it('judges the propose form by the contract: every required field, digits only, trimmed body', () => {
    const empty = proposeProblems(EMPTY_PROPOSE_FORM);
    expect(Object.keys(empty).sort()).toEqual([
      'accountName',
      'accountNumber',
      'bankName',
      'counterpartyId',
      'counterpartyName',
      'routingCode',
    ]);
    expect(empty.accountNumber).toBe('Digits only, 6 to 20 of them.');
    expect(parsedProposeBody(EMPTY_PROPOSE_FORM)).toBeNull();

    expect(proposeProblems(validForm)).toEqual({});
    expect(parsedProposeBody(validForm)).toEqual({
      sponsorFundId: '00000000-0000-4000-8000-000000000611',
      counterpartyName: 'Silverline Partners Fund II',
      bankDetails: {
        bankName: 'Harbor Street Bank',
        accountName: 'Silverline Partners Fund II',
        accountNumber: '4455667799',
        routingCode: '021000021',
      },
    });
    expect(proposeProblems({ ...validForm, accountNumber: 'AB12' })).toEqual({
      accountNumber: 'Digits only, 6 to 20 of them.',
    });
    expect(proposeProblems({ ...validForm, routingCode: '12345' })).toEqual({
      routingCode: 'Digits only, 6 to 20 of them.',
    });
    const investment = parsedProposeBody({
      ...validForm,
      kind: 'investment',
      counterpartyId: ID.inv1,
      reference: ' Capital account 44 ',
      sourceNote: 'Typed from the closing set',
    });
    expect(investment).toMatchObject({
      investmentId: ID.inv1,
      bankDetails: { reference: 'Capital account 44' },
      sourceNote: 'Typed from the closing set',
    });
    expect(investment).not.toHaveProperty('sponsorFundId');
  });

  it('builds verify for a confirmed callback and reject, with a reason, for one that did not confirm', () => {
    expect(callbackBody(EMPTY_CALLBACK_FORM)).toBeNull();
    expect(callbackBody({ numberSource: 'known_contact', result: '', reason: '' })).toBeNull();
    expect(
      callbackBody({ numberSource: 'known_contact', result: 'confirmed', reason: '' }),
    ).toEqual({
      command: 'verify',
      callbackNumberSource: 'known_contact',
      callbackResult: 'confirmed',
    });
    expect(
      callbackBody({ numberSource: 'known_contact', result: 'not_confirmed', reason: 'ab' }),
    ).toBeNull();
    expect(
      callbackBody({
        numberSource: 'known_contact',
        result: 'not_confirmed',
        reason: ' no answer ',
      }),
    ).toEqual({
      command: 'reject',
      callbackNumberSource: 'known_contact',
      callbackResult: 'not_confirmed',
      reason: 'no answer',
    });
    expect(SECOND_PERSON_RULE).toContain('SEC-12.2');
  });
});

describe('trade ticket helpers', () => {
  it('tones every wire and ticket state in a word (docs/18 sections 3 and 11)', () => {
    for (const s of wireInstructionState.options) expect(typeof wireTone(s)).toBe('string');
    for (const s of tradeTicketState.options) expect(typeof ticketTone(s)).toBe('string');
    expect(wireTone('Proposed')).toBe('watch');
    expect(wireTone('Verified')).toBe('good');
    expect(wireTone('Rejected')).toBe('bad');
    expect(wireTone('Superseded')).toBe('neutral');
    expect(wireTone('Unknown')).toBe('neutral');
    expect(ticketTone('Drafted')).toBe('watch');
    expect(ticketTone('Approved')).toBe('brand');
    expect(ticketTone('Funded')).toBe('good');
    expect(ticketTone('Withdrawn')).toBe('neutral');
  });

  it('words every blocker and alert plainly, with no em dash', () => {
    for (const b of releaseBlocker.options) {
      expect(BLOCKER_WORDS[b]).toMatch(/SEC-12\.[23]\)\.$/);
      expect(BLOCKER_WORDS[b]).not.toContain(EM_DASH);
      expect(blockerLabel(b)).not.toContain('_');
    }
    expect(blockerLabel('changed_within_hold')).toBe('Changed within hold');
    for (const a of capitalNoticeAlert.options) {
      expect(ALERT_WORDS[a].label.length).toBeGreaterThan(0);
      expect(ALERT_WORDS[a].sentence).not.toContain(EM_DASH);
    }
    expect(RELEASE_ALLOWED).not.toContain(EM_DASH);
    expect(nothingToRelease('Funded')).toBe(true);
    expect(nothingToRelease('Withdrawn')).toBe(true);
    expect(nothingToRelease('Drafted')).toBe(false);
    expect(nothingToRelease('Approved')).toBe(false);
    for (const s of tradeTicketState.options) expect(isTicketState(s)).toBe(true);
    expect(isTicketState('Released')).toBe(false);
  });

  it('filters tickets by state and names the notice each one pays', () => {
    const rows = ticketRows();
    expect(filterTickets(rows, { state: '' })).toHaveLength(3);
    expect(filterTickets(rows, { state: 'Funded' }).map((t) => t.state)).toEqual(['Funded']);
    const notices = new Map(noticeRows().map((n) => [n.id, n]));
    expect(ticketNoticeLabel(rows[0]!, notices)).toBe('Capital call: Silverline Staffing Holdings');
    expect(ticketNoticeLabel(rows[0]!, new Map())).toBe('Notice 00000000');
  });
});
