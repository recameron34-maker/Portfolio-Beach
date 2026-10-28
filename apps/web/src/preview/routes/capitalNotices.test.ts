import { beforeEach, describe, expect, it } from 'vitest';
import {
  capitalNoticeControlDetail,
  capitalNoticePage,
  wireInstructionDetail,
} from '@pb/contracts';
import type { CapitalNoticeControlDetail } from '@pb/contracts';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { AS_OF, IDS, USERS, buildWorld, problemOf, send } from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';
import { WIRE_CHANGED_REASON } from './capitalNotices.js';

/**
 * Journey 4 of docs/12 (docs/04 M16, docs/18 section 3, SEC-12) simulated end to end through the
 * shim over the wire_change notice: operations reviews, the ticket panel shows the Drafted ticket
 * and the alerts, approval is held by the changed instruction until a second person's callback
 * verifies it, the approver approves, operations confirms funding and reconciles; a new version
 * proposed after approval returns the ticket to draft, a rejected one lifts the hold.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const id = IDS.notice.wireChange;
const noticePath = `/api/v1/capital-notices/${id}`;
const commandPath = `${noticePath}/commands`;
const wireCommand = (wireId: string): string => `/api/v1/wire-instructions/${wireId}/commands`;

let ids = 0;
const env = {
  newId: (): string => `52000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

function setup(): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  return { f: createPreviewFetch(buildWorld().fixtures, never, { env, state }), state };
}

const detailOf = (answer: Answer): CapitalNoticeControlDetail =>
  capitalNoticeControlDetail.parse(answer.json);

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('journey 4 over the simulated controls', () => {
  it('review, draft, the hold, the callback by a second person, dual control, funding, reconciliation', async () => {
    const { f, state } = setup();
    const run = (who: string, body: unknown): Promise<Answer> =>
      send(f, who, 'POST', commandPath, body);
    const read = async (who: string): Promise<CapitalNoticeControlDetail> =>
      detailOf(await send(f, who, 'GET', noticePath));

    // The detail before anything moves: the recorded controls, the ticket judged for the reader.
    const before = await read(USERS.ops.externalId);
    expect(before.ticket).toMatchObject({
      id: IDS.ticket.drafted,
      state: 'Drafted',
      release: { allowed: false, blockers: ['changed_within_hold', 'same_person'] },
    });
    expect((await read(USERS.head.externalId)).ticket?.release).toEqual({
      allowed: false,
      blockers: ['changed_within_hold'],
    });
    expect(before.activeWireInstruction).toMatchObject({ id: IDS.wire.Verified, version: 2 });
    expect(before.alerts).toEqual(['wire_changed', 'urgency_language']);
    expect(before.wireChangeHold).toEqual({ until: '2025-07-30', holdDays: 30 });

    // review is operations' step; the route guard refuses the roles outside the command route.
    expect(problemOf(await run(USERS.head.externalId, { command: 'review' })).code).toBe(
      'forbidden',
    );
    for (const who of [USERS.viewer, USERS.deal])
      expect((await run(who.externalId, { command: 'review' })).status).toBe(403);
    expect((await run(USERS.ops.externalId, { command: 'review', shout: true })).status).toBe(400);
    const reviewed = detailOf(await run(USERS.ops.externalId, { command: 'review' }));
    expect(reviewed.state).toBe('Reviewed');
    expect(reviewed.alerts).toEqual(['wire_changed', 'urgency_language']);

    // The notice already carries a ticket: draftTicket re-drafts it, never a second one.
    const drafted = detailOf(
      await run(USERS.ops.externalId, { command: 'draftTicket', fundingDate: AS_OF }),
    );
    expect(drafted.state).toBe('TicketDrafted');
    expect(drafted.ticket).toMatchObject({
      id: IDS.ticket.drafted,
      state: 'Drafted',
      fundingDate: AS_OF,
      amount: '2500.00',
      preparedAt: env.now(),
      preparedBy: { id: USERS.ops.userId },
    });
    expect(
      [...(state.tickets?.values() ?? [])].filter((t) => t.capitalNoticeId === id),
    ).toHaveLength(1);

    // Dual control and the hold (SEC-12.3).
    const samePerson = await run(USERS.ops.externalId, { command: 'approveTicket' });
    expect(samePerson.status).toBe(422);
    expect(problemOf(samePerson).detail).toContain('preparer cannot approve');
    const held = await run(USERS.head.externalId, { command: 'approveTicket' });
    expect(held.status).toBe(422);
    expect(problemOf(held).detail).toContain('changed recently');
    expect(problemOf(held).detail).toContain('SEC-12.3');

    // The callback by a second person (SEC-12.2) verifies the changed instruction and lifts the hold.
    const verify = {
      command: 'verify',
      callbackNumberSource: 'sponsor_website',
      callbackResult: 'confirmed',
    };
    const own = await send(f, USERS.ops.externalId, 'POST', wireCommand(IDS.wire.Proposed), verify);
    expect(own.status).toBe(422);
    expect(problemOf(own).detail).toContain('SEC-12.2');
    const verified = await send(
      f,
      USERS.ops2.externalId,
      'POST',
      wireCommand(IDS.wire.Proposed),
      verify,
    );
    expect(verified.status).toBe(200);
    expect(wireInstructionDetail.parse(verified.json)).toMatchObject({
      state: 'Verified',
      active: true,
      callback: { by: { id: USERS.ops2.userId }, result: 'confirmed' },
    });
    const afterCallback = await read(USERS.head.externalId);
    expect(afterCallback.activeWireInstruction).toMatchObject({
      id: IDS.wire.Proposed,
      version: 4,
      state: 'Verified',
      active: true,
    });
    expect(afterCallback.wireChangeHold).toBeNull();
    expect(afterCallback.notes).toEqual(['No cash flow has been recorded for this notice.']);
    expect(afterCallback.ticket?.release).toEqual({ allowed: true, blockers: [] });
    expect(afterCallback.alerts).toEqual(['wire_changed', 'urgency_language']);

    expect((await run(USERS.ops.externalId, { command: 'approveTicket' })).status).toBe(422);
    const approved = detailOf(await run(USERS.head.externalId, { command: 'approveTicket' }));
    expect(approved.state).toBe('TicketApproved');
    expect(approved.ticket).toMatchObject({
      state: 'Approved',
      approvedAt: env.now(),
      approvedBy: { id: USERS.head.userId },
      wireInstruction: { id: IDS.wire.Proposed, version: 4, state: 'Verified' },
      release: { allowed: true, blockers: [] },
    });

    // A new version proposed while the ticket is approved returns it to draft and flags the notice.
    const proposed = await send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', {
      sponsorFundId: IDS.fund,
      counterpartyName: 'Test Fund IV',
      bankDetails: {
        bankName: 'Meridian Clearing',
        accountName: 'Test Fund IV',
        accountNumber: '7788990011',
        routingCode: '021000021',
      },
      sourceNote: 'A second letter, typed in',
    });
    expect(proposed.status).toBe(201);
    const v5 = wireInstructionDetail.parse(proposed.json);
    expect(v5.version).toBe(5);
    const back = await read(USERS.head.externalId);
    expect(back.state).toBe('TicketDrafted');
    expect(back.ticket).toMatchObject({
      state: 'Drafted',
      approvedBy: null,
      approvedAt: null,
      wireInstruction: null,
      release: { allowed: false, blockers: ['changed_within_hold'] },
    });
    expect(back.wireChangeHold).toEqual({ until: '2025-07-31', holdDays: 30 });
    expect(back.alerts).toContain('wire_changed');
    const sweep = state.audit.find((e) => e.action === 'capital_notice.wireChanged');
    expect(sweep).toMatchObject({ entityId: id, reason: WIRE_CHANGED_REASON });
    expect((await run(USERS.head.externalId, { command: 'approveTicket' })).status).toBe(422);

    // A change the callback refused is not a change: the active version stands, the hold lifts.
    const rejected = await send(f, USERS.ops2.externalId, 'POST', wireCommand(v5.id), {
      command: 'reject',
      callbackNumberSource: 'known_contact',
      callbackResult: 'not_confirmed',
      reason: 'the sponsor did not recognise the new account',
    });
    expect(rejected.status).toBe(200);
    expect((await read(USERS.head.externalId)).wireChangeHold).toBeNull();
    expect(detailOf(await run(USERS.head.externalId, { command: 'approveTicket' })).state).toBe(
      'TicketApproved',
    );

    // A person records a wire change with a reason (the service path names its own).
    const noReason = await run(USERS.ops.externalId, { command: 'wireChanged' });
    expect(noReason.status).toBe(422);
    expect(problemOf(noReason).detail).toContain('reason');
    expect(
      (await run(USERS.head.externalId, { command: 'wireChanged', reason: 'approvers do not' }))
        .status,
    ).toBe(403);
    const manual = detailOf(
      await run(USERS.ops.externalId, {
        command: 'wireChanged',
        reason: 'The sponsor phoned about a new account',
      }),
    );
    expect(manual.state).toBe('TicketDrafted');
    expect(manual.ticket?.state).toBe('Drafted');
    expect(detailOf(await run(USERS.head.externalId, { command: 'approveTicket' })).state).toBe(
      'TicketApproved',
    );

    // Funding is operations' confirmation against the Approved ticket.
    expect((await run(USERS.head.externalId, { command: 'confirmFunding' })).status).toBe(403);
    const funded = detailOf(await run(USERS.ops.externalId, { command: 'confirmFunding' }));
    expect(funded.state).toBe('Funded');
    expect(funded.ticket).toMatchObject({
      state: 'Funded',
      release: { allowed: false, blockers: [] },
    });
    expect(funded.alerts).toEqual(['wire_changed', 'urgency_language']);

    // Reconciliation writes the one approved cash flow, sourced to the notice.
    expect((await run(USERS.head.externalId, { command: 'reconcile' })).status).toBe(403);
    const reconciled = detailOf(
      await run(USERS.ops.externalId, {
        command: 'reconcile',
        reason: 'Wire confirmed by the bank',
      }),
    );
    expect(reconciled.state).toBe('Reconciled');
    expect(reconciled.cashFlows).toEqual([
      {
        date: AS_OF,
        flowType: 'flow_type.contribution',
        amount: '-2500.00',
        status: 'record_status.approved',
      },
    ]);
    expect(reconciled.settledAmount).toBe('2500.00');
    expect(reconciled.notes).toEqual([]);
    expect((await run(USERS.ops.externalId, { command: 'reconcile' })).status).toBe(409);
    expect((await run(USERS.ops.externalId, { command: 'review' })).status).toBe(409);

    // Every reader of the notice sees the settled detail and the register's state, masked.
    const asViewer = await read(USERS.viewer.externalId);
    expect(asViewer).toMatchObject({
      state: 'Reconciled',
      settledAmount: '2500.00',
      ticket: { state: 'Funded' },
      activeWireInstruction: { id: IDS.wire.Proposed },
    });
    expect(JSON.stringify(asViewer)).not.toMatch(/accountNumber|routingCode|7788990011/);
    const page = capitalNoticePage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/capital-notices?limit=200')).json,
    );
    expect(page.items.find((r) => r.id === id)?.state).toBe('Reconciled');
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('answers 404 for a notice outside the wall, 412 for a stale If-Match, and keeps an untouched detail as recorded', async () => {
    const { f } = setup();
    const hidden = await send(
      f,
      USERS.ops.externalId,
      'POST',
      `/api/v1/capital-notices/${IDS.notice.walled}/commands`,
      { command: 'review' },
    );
    expect(hidden.status).toBe(404);
    const stale = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commandPath,
      { command: 'review' },
      { 'if-match': '"7"' },
    );
    expect(stale.status).toBe(412);
    // Nothing moved: the recorded detail is served as recorded.
    const untouched = detailOf(await send(f, USERS.viewer.externalId, 'GET', noticePath));
    expect(untouched).toMatchObject({ state: 'Extracted', rowVersion: 1 });
  });
});
