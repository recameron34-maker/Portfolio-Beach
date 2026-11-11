import { describe, expect, it } from 'vitest';
import {
  capitalNoticeAlert,
  releaseBlocker,
  tradeTicketState,
  wireInstructionCommandBody,
  wireInstructionState,
} from '@pb/contracts';
import { olderThanVerified } from '@pb/workflows';
import { ID } from '../../test/fixtures.js';
import { noticeRows, ticketRows, wireRows, WIRE_ID } from '../../test/fixtures-capital.js';
import {
  ALERT_WORDS,
  BLOCKER_WORDS,
  blockerLabel,
  filterTickets,
  instructionWithheld,
  isTicketState,
  nothingToRelease,
  REGISTER_RESTRICTED,
  RELEASE_ALLOWED,
  ticketNoticeLabel,
} from './tickets.js';
import { ticketTone, wireTone } from '../../lib/states.js';
import {
  callbackBody,
  CALLBACK_RESULTS,
  callbackWords,
  counterpartyFilter,
  counterpartyNames,
  dayOf,
  EMPTY_CALLBACK_FORM,
  EMPTY_PROPOSE_FORM,
  filterWires,
  isWireState,
  kindLabel,
  maskedParts,
  NUMBER_SOURCES,
  OLDER_VERSION_RULE,
  parsedProposeBody,
  proposeProblems,
  SECOND_PERSON_RULE,
  withdrawBody,
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

  it('never builds a reject that names a callback result without its number source, or the reverse (W2-5)', () => {
    const reasons = ['', 'ab', 'The contact did not recognise the account'];
    for (const numberSource of ['', ...NUMBER_SOURCES] as const) {
      for (const result of ['', ...CALLBACK_RESULTS] as const) {
        for (const reason of reasons) {
          const body = callbackBody({ numberSource, result, reason });
          if (body === null) continue;
          // What the page sends is what the contract takes: the pair together, whole.
          expect(wireInstructionCommandBody.safeParse(body).success).toBe(true);
          expect(body.callbackNumberSource).toBe(numberSource);
          expect(body.callbackResult).toBe(result);
        }
      }
    }
    // A withdrawal names neither: the version is rejected without a callback.
    expect(wireInstructionCommandBody.safeParse(withdrawBody('Typed in error')).success).toBe(true);
    expect(withdrawBody(' Typed in error ')).toEqual({
      command: 'reject',
      reason: 'Typed in error',
    });
    // The contract refuses either half alone, so a body built any other way would be a 400.
    for (const half of [
      { callbackResult: 'not_confirmed' },
      { callbackNumberSource: 'known_contact' },
    ])
      expect(
        wireInstructionCommandBody.safeParse({ command: 'reject', reason: 'no answer', ...half })
          .success,
      ).toBe(false);
  });

  it('reads the bank name and the last four digits out of the masked form, or nothing when it is not one', () => {
    expect(maskedParts('Harbor Street Bank ****4821')).toEqual({
      bankName: 'Harbor Street Bank',
      lastFour: '4821',
    });
    expect(maskedParts('First **** National ****0007')).toEqual({
      bankName: 'First **** National',
      lastFour: '0007',
    });
    for (const other of ['Harbor Street Bank', '****4821', 'Bank ****48211', 'Bank ***4821', ''])
      expect(maskedParts(other)).toBeNull();
  });

  it('knows a Proposed version that is older than a Verified one of the same counterparty (W2-4)', () => {
    const rows = wireRows();
    const proposed = rows.find((w) => w.id === WIRE_ID.proposed)!;
    // Version 2 of the fund against its Verified version 1: the newest, so it may be verified.
    expect(olderThanVerified(proposed, rows)).toBe(false);
    const newer = { ...rows.find((w) => w.id === WIRE_ID.verified)!, id: 'x', version: 3 };
    expect(olderThanVerified(proposed, [...rows, newer])).toBe(true);
    // A newer version that was rejected, or one of another counterparty, does not count.
    expect(olderThanVerified(proposed, [...rows, { ...newer, state: 'Rejected' }])).toBe(false);
    expect(
      olderThanVerified(proposed, [
        ...rows,
        { ...newer, counterparty: { kind: 'investment', id: ID.inv3, name: 'x' } },
      ]),
    ).toBe(false);
    expect(OLDER_VERSION_RULE).toBe(
      'A newer version of this counterparty is already Verified; reject this older version instead (SEC-12.2)',
    );
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

  it('knows when the version a ticket was approved against is withheld from the reader (D1-05)', () => {
    const [drafted, approved, funded] = ticketRows();
    // Not approved yet: no version exists, nothing is withheld.
    expect(instructionWithheld(drafted!)).toBe(false);
    expect(instructionWithheld(approved!)).toBe(false);
    // Approved or funded with no version in the answer: the reader is outside the register.
    expect(instructionWithheld({ ...approved!, wireInstruction: null })).toBe(true);
    expect(instructionWithheld({ ...funded!, wireInstruction: null })).toBe(true);
    expect(REGISTER_RESTRICTED).toBe('Restricted to the wire register');
  });
});
