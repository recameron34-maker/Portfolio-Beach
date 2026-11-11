import { beforeEach, describe, expect, it } from 'vitest';
import {
  capitalNoticeControlDetail,
  capitalNoticePage,
  wireInstructionDetail,
} from '@pb/contracts';
import type { CapitalNoticeControlDetail } from '@pb/contracts';
import { getKey } from '../keys.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { AS_OF, IDS, USERS, WALL_MEMBERS, buildWorld, problemOf, send } from '../test-fixtures.js';
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

    // Every reader of the notice sees the settled detail. The register's row, even masked, goes
    // to the register's readers only (D1-05): the alerts tell the rest one is on file.
    const asViewer = await read(USERS.viewer.externalId);
    expect(asViewer).toMatchObject({
      state: 'Reconciled',
      settledAmount: '2500.00',
      ticket: { state: 'Funded', wireInstruction: null },
      activeWireInstruction: null,
    });
    expect(asViewer.alerts).not.toContain('unverified_instruction');
    expect(JSON.stringify(asViewer)).not.toMatch(
      /accountNumber|routingCode|7788990011|Meridian Clearing|\*{4}/,
    );
    expect(await read(USERS.ops.externalId)).toMatchObject({
      ticket: { state: 'Funded', wireInstruction: { id: IDS.wire.Proposed, version: 4 } },
      activeWireInstruction: { id: IDS.wire.Proposed },
    });
    const page = capitalNoticePage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/capital-notices?limit=200')).json,
    );
    expect(page.items.find((r) => r.id === id)?.state).toBe('Reconciled');
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('keeps the register rows from roles the register refuses, before and after a change; the alerts, the hold and the release check stay (D1-05)', async () => {
    const { f } = setup();
    const read = async (who: string): Promise<CapitalNoticeControlDetail> =>
      detailOf(await send(f, who, 'GET', noticePath));
    const outside = [USERS.viewer, USERS.deal];
    const inside = [USERS.ops, USERS.head, USERS.all];
    const check = async (): Promise<void> => {
      for (const who of outside) {
        const detail = await read(who.externalId);
        expect(detail.activeWireInstruction, who.externalId).toBeNull();
        expect(detail.ticket?.wireInstruction ?? null).toBeNull();
        // A Verified instruction is on file: the alert that says none is absent.
        expect(detail.alerts).toEqual(['wire_changed', 'urgency_language']);
        expect(detail.wireChangeHold).toEqual({ until: '2025-07-30', holdDays: 30 });
        expect(detail.ticket?.release.blockers).toEqual(['changed_within_hold']);
        expect(JSON.stringify(detail)).not.toMatch(/Harbor Street Bank|\*{4}/);
      }
      for (const who of inside)
        expect((await read(who.externalId)).activeWireInstruction).toMatchObject({
          id: IDS.wire.Verified,
          bankDetailsMasked: 'Harbor Street Bank ****5566',
        });
    };
    // As recorded, then rebuilt from the session once a command touched the controls.
    await check();
    expect(
      (await send(f, USERS.ops.externalId, 'POST', commandPath, { command: 'review' })).status,
    ).toBe(200);
    await check();
  });

  it('inside the hold window after a verified change, the release takes a third person: not the proposer of the change, not the person whose callback verified it (W2-3)', async () => {
    const { f } = setup();
    const run = (who: string, body: unknown): Promise<Answer> =>
      send(f, who, 'POST', commandPath, body);
    const release = async (who: string) =>
      detailOf(await send(f, who, 'GET', noticePath)).ticket?.release;
    // Operations reviews; the second operations person drafts the ticket; the approver's
    // callback verifies the changed version that operations proposed.
    expect((await run(USERS.ops.externalId, { command: 'review' })).status).toBe(200);
    expect((await run(USERS.ops2.externalId, { command: 'draftTicket' })).status).toBe(200);
    const verified = await send(f, USERS.head.externalId, 'POST', wireCommand(IDS.wire.Proposed), {
      command: 'verify',
      callbackNumberSource: 'fund_administrator',
      callbackResult: 'confirmed',
    });
    expect(verified.status).toBe(200);
    // The hold on the pending change lifted; the people who made the change still cannot release.
    expect(await release(USERS.ops.externalId)).toEqual({
      allowed: false,
      blockers: ['verifier_within_hold'],
    });
    expect(await release(USERS.head.externalId)).toEqual({
      allowed: false,
      blockers: ['verifier_within_hold'],
    });
    expect(await release(USERS.ops2.externalId)).toEqual({
      allowed: false,
      blockers: ['same_person'],
    });
    expect(await release(USERS.all.externalId)).toEqual({ allowed: true, blockers: [] });
    expect(
      detailOf(await send(f, USERS.all.externalId, 'GET', noticePath)).wireChangeHold,
    ).toBeNull();

    const proposer = await run(USERS.ops.externalId, { command: 'approveTicket' });
    expect(proposer.status).toBe(422);
    expect(problemOf(proposer)).toEqual({
      code: 'workflow-precondition',
      detail:
        'capital_notice: the wire instruction changed recently: the person who proposed the change cannot approve the release, a third person must (SEC-12.3)',
    });
    const verifier = await run(USERS.head.externalId, { command: 'approveTicket' });
    expect(verifier.status).toBe(422);
    expect(problemOf(verifier)).toEqual({
      code: 'workflow-precondition',
      detail:
        'capital_notice: the wire instruction changed recently: the person who verified the change cannot approve the release, a third person must (SEC-12.3)',
    });
    const third = detailOf(await run(USERS.all.externalId, { command: 'approveTicket' }));
    expect(third.state).toBe('TicketApproved');
    expect(third.ticket).toMatchObject({
      state: 'Approved',
      approvedBy: { id: USERS.all.userId },
      wireInstruction: { id: IDS.wire.Proposed, version: 4 },
    });
  });

  it('a version verified before the hold window asks for dual control only', async () => {
    const { f } = setup();
    // The second fund's active version was proposed by operations and verified by the second
    // operations person in 2024: outside the window, so that verifier may release today.
    const reviewed = `/api/v1/capital-notices/${IDS.notice.Reviewed}`;
    const ticket = detailOf(
      await send(f, USERS.ops.externalId, 'POST', `${reviewed}/commands`, {
        command: 'draftTicket',
      }),
    ).ticket;
    expect(ticket?.release).toEqual({ allowed: false, blockers: ['same_person'] });
    expect(detailOf(await send(f, USERS.ops2.externalId, 'GET', reviewed)).ticket?.release).toEqual(
      { allowed: true, blockers: [] },
    );
    expect(
      detailOf(
        await send(f, USERS.ops2.externalId, 'POST', `${reviewed}/commands`, {
          command: 'approveTicket',
        }),
      ).state,
    ).toBe('TicketApproved');
  });

  it('the reconciliation books the amount the ticket was approved and funded for, and the notes name the difference (W2-2)', async () => {
    const { f } = setup();
    const run = (who: string, body: unknown): Promise<Answer> =>
      send(f, who, 'POST', commandPath, body);
    expect((await run(USERS.ops.externalId, { command: 'review' })).status).toBe(200);
    // The ticket is drafted for less than the notice asks (2,500.00).
    const drafted = detailOf(
      await run(USERS.ops.externalId, {
        command: 'draftTicket',
        amount: '2000.00',
        fundingDate: AS_OF,
      }),
    );
    expect(drafted.ticket?.amount).toBe('2000.00');
    expect(drafted.notes).not.toContain('Funded amount differs from the notice amount.');
    expect(
      (
        await send(f, USERS.ops2.externalId, 'POST', wireCommand(IDS.wire.Proposed), {
          command: 'verify',
          callbackNumberSource: 'sponsor_website',
          callbackResult: 'confirmed',
        })
      ).status,
    ).toBe(200);
    const approved = detailOf(await run(USERS.head.externalId, { command: 'approveTicket' }));
    // An Approved ticket has not left the account yet: no note.
    expect(approved.notes).toEqual(['No cash flow has been recorded for this notice.']);
    const funded = detailOf(await run(USERS.ops.externalId, { command: 'confirmFunding' }));
    expect(funded.notes).toEqual([
      'No cash flow has been recorded for this notice.',
      'Funded amount differs from the notice amount.',
    ]);
    const reconciled = detailOf(await run(USERS.ops.externalId, { command: 'reconcile' }));
    expect(reconciled.cashFlows).toEqual([
      {
        date: AS_OF,
        flowType: 'flow_type.contribution',
        amount: '-2000.00',
        status: 'record_status.approved',
      },
    ]);
    expect(reconciled.settledAmount).toBe('2000.00');
    expect(reconciled.amount).toBe('2500.00');
    expect(reconciled.notes).toEqual(['Funded amount differs from the notice amount.']);
    // Every reader of the notice sees the note.
    expect(detailOf(await send(f, USERS.viewer.externalId, 'GET', noticePath)).notes).toEqual([
      'Funded amount differs from the notice amount.',
    ]);
  });

  /**
   * The test world with the walled position inside the first fund and urgency language on its
   * notice, both as its wall members recorded them: operations can open neither.
   */
  const walledNotice = `/api/v1/capital-notices/${IDS.notice.walled}`;
  function walledFundSetup(): { f: typeof fetch; state: PreviewState } {
    const world = buildWorld();
    const patch = (path: string, change: (body: Record<string, unknown>) => unknown): void => {
      for (const credential of WALL_MEMBERS) {
        const response = world.fixtures.responses[getKey(credential, path)];
        if (response === undefined) throw new Error(`no recording of ${path} for ${credential}`);
        const hash = `patched:${credential}:${path}`;
        const recorded = JSON.parse(world.fixtures.bodies[response.body] ?? '{}') as Record<
          string,
          unknown
        >;
        world.fixtures.bodies[hash] = JSON.stringify(change(recorded));
        response.body = hash;
      }
    };
    patch(`/api/v1/investments/${IDS.walled}`, (body) => ({ ...body, sponsorFundId: IDS.fund }));
    patch(walledNotice, (body) => ({ ...body, alerts: ['urgency_language'] }));
    const state = createPreviewState();
    return { f: createPreviewFetch(world.fixtures, never, { env, state }), state };
  }
  const proposeForFund = (f: typeof fetch): Promise<Answer> =>
    send(f, USERS.ops.externalId, 'POST', '/api/v1/wire-instructions', {
      sponsorFundId: IDS.fund,
      counterpartyName: 'Test Fund IV',
      bankDetails: {
        bankName: 'Meridian Clearing',
        accountName: 'Test Fund IV',
        accountNumber: '7788990011',
        routingCode: '021000021',
      },
    });

  it('a new fund-level version flags a walled notice the proposer cannot open, and the flags it carried stand (D1-01)', async () => {
    const { f, state } = walledFundSetup();
    expect((await send(f, USERS.ops.externalId, 'GET', walledNotice)).status).toBe(404);
    expect((await proposeForFund(f)).status).toBe(201);
    const flagged = detailOf(await send(f, USERS.head.externalId, 'GET', walledNotice));
    expect(flagged.state).toBe('Extracted');
    expect(flagged.alerts).toEqual([
      'wire_changed',
      'urgency_language',
      'due_within_two_business_days',
    ]);
    expect(
      state.audit
        .filter((e) => e.reason === WIRE_CHANGED_REASON)
        .map((e) => [e.action, e.entityId]),
    ).toEqual([['capital_notice.wire_change_flag', IDS.notice.walled]]);
    expect((await send(f, USERS.ops.externalId, 'GET', walledNotice)).status).toBe(404);
  });

  it('a new fund-level version returns the approved ticket of a walled notice to draft: 201, never a conflict (D1-01)', async () => {
    const { f, state } = walledFundSetup();
    const run = (who: string, body: unknown): Promise<Answer> =>
      send(f, who, 'POST', `${walledNotice}/commands`, body);

    // Inside the wall: review, draft, the callback on the changed version, a third person approves.
    expect((await run(USERS.all.externalId, { command: 'review' })).status).toBe(200);
    expect((await run(USERS.all.externalId, { command: 'draftTicket' })).status).toBe(200);
    expect(
      (
        await send(f, USERS.ops2.externalId, 'POST', wireCommand(IDS.wire.Proposed), {
          command: 'verify',
          callbackNumberSource: 'sponsor_website',
          callbackResult: 'confirmed',
        })
      ).status,
    ).toBe(200);
    expect(detailOf(await run(USERS.head.externalId, { command: 'approveTicket' })).state).toBe(
      'TicketApproved',
    );
    expect((await send(f, USERS.ops.externalId, 'GET', walledNotice)).status).toBe(404);

    // Operations, outside the wall, proposes a new version for the fund.
    expect((await proposeForFund(f)).status).toBe(201);
    const back = detailOf(await send(f, USERS.head.externalId, 'GET', walledNotice));
    expect(back.state).toBe('TicketDrafted');
    expect(back.ticket).toMatchObject({
      state: 'Drafted',
      approvedBy: null,
      approvedAt: null,
      wireInstruction: null,
    });
    expect(back.alerts).toEqual([
      'wire_changed',
      'urgency_language',
      'due_within_two_business_days',
    ]);
    // One event for the walled notice, through the machine's wireChanged row; the fund's other
    // open notice carried the flag already and is left as it was.
    expect(
      state.audit
        .filter((e) => e.reason === WIRE_CHANGED_REASON)
        .map((e) => [e.action, e.entityId, e.from, e.to]),
    ).toEqual([
      ['capital_notice.wireChanged', IDS.notice.walled, 'TicketApproved', 'TicketDrafted'],
    ]);
    expect((await send(f, USERS.ops.externalId, 'GET', walledNotice)).status).toBe(404);
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
