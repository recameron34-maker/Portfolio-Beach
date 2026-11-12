import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixedClock, Principal } from '@pb/adapters';
import { D, addDays } from '@pb/calc';
import {
  capitalNoticeControlDetail,
  investmentDetail,
  problemDetails,
  tradeTicketPage,
  wireInstructionDetail,
  wireInstructionPage,
} from '@pb/contracts';
import type { CapitalNoticeControlDetail, WireInstructionDetail } from '@pb/contracts';
import type { Tx } from '@pb/db';
import { WiresService } from '../capital/wires.service.js';
import { ProblemError } from '../common/problem.js';
import { systemStep } from '../common/system-step.js';
import { DbService } from '../db/db.service.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

/*
 * The Phase 3 review findings on capital activity and the wire register (decision 0013, wave 4):
 * one test per finding, each written against the behaviour the finding describes and failing
 * before its fix. Every test works its own counterparty so the order does not matter.
 */
describe('capital activity and the wire register: review fixes (SEC-5.3, SEC-12, docs/18 sections 3 and 11)', () => {
  const PROBLEM = 'https://portfolio-beach.example/problems/';
  const APPROVED = 'record_status.approved';
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const principalOf = (externalId: string): Principal => {
    const u = user(externalId);
    return {
      userId: u.id,
      externalId: u.externalId,
      displayName: u.displayName,
      roles: [...u.roles],
      clientIds: [...u.clientIds],
    };
  };
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const tagged = (tag: string) => h.dataset.capitalNotices.find((n) => n.scenarioTag === tag)!;
  const investment = (id: string) => h.dataset.investments.find((i) => i.id === id)!;
  const fundName = (fundId: string) => h.dataset.sponsorFunds.find((f) => f.id === fundId)!.name;
  const activeSeeded = (fundId: string) =>
    h.dataset.wireInstructions!.find((w) => w.sponsorFundId === fundId && w.active)!;
  const wireChangeFund = (): string =>
    investment(tagged('wire_change').investmentId!).sponsorFundId!;
  const walledFund = (): string => investment(walledId()).sponsorFundId!;
  /**
   * Counterparties the seed gives one active Verified instruction and nothing else, each with a
   * position anyone can see: the n-th is one test's own, so no test changes another's register.
   */
  const spareFund = (n: number): { fundId: string; investmentId: string; vehicleId: string } => {
    const taken = new Set([wireChangeFund(), walledFund()]);
    const spare = h.dataset
      .wireInstructions!.filter((w) => w.active && w.sponsorFundId !== null)
      .map((w) => w.sponsorFundId!)
      .filter((fundId) => !taken.has(fundId))
      .sort()
      .flatMap((fundId) => {
        const inv = h.dataset.investments.find(
          (i) => i.sponsorFundId === fundId && i.id !== walledId(),
        );
        return inv === undefined
          ? []
          : [{ fundId, investmentId: inv.id, vehicleId: inv.vehicleId }];
      });
    const picked = spare[n];
    if (picked === undefined) throw new Error(`the seed has no spare counterparty number ${n}`);
    return picked;
  };

  const get = (who: string, path: string, requestId = 'req-fix-get') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const control = async (who: string, id: string): Promise<CapitalNoticeControlDetail> =>
    capitalNoticeControlDetail.parse(
      (await get(who, `/api/v1/capital-notices/${id}`).expect(200)).body,
    );
  const command = (who: string, id: string, body: object, requestId = 'req-fix-command') =>
    h
      .http()
      .post(`/api/v1/capital-notices/${id}/commands`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const ok = async (
    who: string,
    id: string,
    body: object,
    requestId?: string,
  ): Promise<CapitalNoticeControlDetail> =>
    capitalNoticeControlDetail.parse((await command(who, id, body, requestId).expect(200)).body);
  const refused = async (who: string, id: string, body: object, status: number, code: string) => {
    const problem = problemDetails.parse((await command(who, id, body).expect(status)).body);
    expect(problem.type, JSON.stringify(body)).toBe(`${PROBLEM}${code}`);
    return problem;
  };
  const wirePropose = (who: string, body: object, requestId = 'req-fix-propose') =>
    h
      .http()
      .post('/api/v1/wire-instructions')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const wireCommand = (who: string, id: string, body: object, requestId = 'req-fix-wire') =>
    h
      .http()
      .post(`/api/v1/wire-instructions/${id}/commands`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const wireDetail = async (who: string, id: string): Promise<WireInstructionDetail> =>
    wireInstructionDetail.parse(
      (await get(who, `/api/v1/wire-instructions/${id}`).expect(200)).body,
    );
  const proposeFor = async (
    fundId: string,
    accountNumber: string,
  ): Promise<WireInstructionDetail> =>
    wireInstructionDetail.parse(
      (
        await wirePropose('ops.one', {
          sponsorFundId: fundId,
          counterpartyName: fundName(fundId),
          bankDetails: {
            bankName: 'Meridian Clearing',
            accountName: 'Synthetic counterparty',
            accountNumber,
            routingCode: '021000021',
          },
        }).expect(201)
      ).body,
    );
  const verifyBody = {
    command: 'verify',
    callbackNumberSource: 'sponsor_website',
    callbackResult: 'confirmed',
  };
  const sqlRows = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> =>
    h.runtime.db.query<T>(text, params);
  const auditRows = (
    action: string,
    requestId: string,
  ): Promise<{ entity_id: string; reason: string | null; details: Record<string, unknown> }[]> =>
    sqlRows(
      'select entity_id, reason, details from audit.event where action = $1 and request_id = $2 order by id',
      [action, requestId],
    );
  const insertNotice = async (fields: {
    vehicleId: string;
    investmentId: string;
    amount: string;
    state: string;
    dueDate?: string;
  }): Promise<string> => {
    const [row] = await sqlRows<{ id: string }>(
      `insert into mon.capital_notice
         (notice_type, vehicle_id, investment_id, issue_date, due_date, amount, state)
       values ('notice_type.capital_call', $1, $2, $3, $4, $5, $6::mon.capital_notice_state)
       returning id`,
      [
        fields.vehicleId,
        fields.investmentId,
        addDays(h.dataset.asOf, -3),
        fields.dueDate ?? h.dataset.asOf,
        fields.amount,
        fields.state,
      ],
    );
    return row!.id;
  };
  /** A ticket prepared by ops.one and approved by head.one against an instruction version. */
  const insertApprovedTicket = async (noticeId: string, wireId: string): Promise<string> => {
    const [row] = await sqlRows<{ id: string }>(
      `insert into mon.trade_ticket
         (capital_notice_id, wire_instruction_id, amount, funding_date, prepared_by, approved_by, approved_at, state)
       values ($1, $2, '100000.00', $3, $4, $5, now(), 'Approved')
       returning id`,
      [noticeId, wireId, h.dataset.asOf, user('ops.one').id, user('head.one').id],
    );
    return row!.id;
  };
  const noticeRow = async (id: string) =>
    (
      await sqlRows<{ state: string; wire_change_flag: boolean; updated_by: string | null }>(
        'select state::text as state, wire_change_flag, updated_by from mon.capital_notice where id = $1',
        [id],
      )
    )[0]!;
  const ticketRow = async (id: string) =>
    (
      await sqlRows<{
        state: string;
        approved_by: string | null;
        wire_instruction_id: string | null;
        updated_by: string | null;
      }>(
        'select state::text as state, approved_by, wire_instruction_id, updated_by from mon.trade_ticket where id = $1',
        [id],
      )
    )[0]!;

  it("D1-05: the notice detail keeps the register's rows from roles the register refuses; the alerts, the hold and the release check stay", async () => {
    const wc = tagged('wire_change');
    const asOps = await control('ops.one', wc.id);
    expect(asOps.activeWireInstruction).toMatchObject({ version: 1, state: 'Verified' });
    const masked = asOps.activeWireInstruction!.bankDetailsMasked;
    // The register's readers (operations, approver, auditor) still get the masked row.
    for (const who of ['head.one', 'audit.one'])
      expect((await control(who, wc.id)).activeWireInstruction?.id).toBe(
        asOps.activeWireInstruction!.id,
      );

    const funded = h.dataset.tradeTickets!.find(
      (t) =>
        t.state === 'Funded' &&
        h.dataset.capitalNotices.find((n) => n.id === t.capitalNoticeId)!.investmentId !==
          walledId(),
    )!;
    const settledAsOps = await control('ops.one', funded.capitalNoticeId);
    expect(settledAsOps.ticket!.wireInstruction).toMatchObject({ id: funded.wireInstructionId });

    for (const who of ['viewer.one', 'deal.one']) {
      // The register itself refuses these roles (wires.controller.ts, the read_register policy).
      await get(who, '/api/v1/wire-instructions').expect(403);
      const open = await control(who, wc.id);
      expect(open.activeWireInstruction, who).toBeNull();
      expect(JSON.stringify(open), who).not.toContain(masked);
      // What the notice needs its readers to know stays: the alerts, the hold, the release check.
      expect(open.alerts).toEqual(asOps.alerts);
      expect(open.wireChangeHold).toEqual(asOps.wireChangeHold);
      expect(open.notes).toEqual(asOps.notes);
      expect(open.ticket).toMatchObject({
        id: asOps.ticket!.id,
        state: 'Drafted',
        wireInstruction: null,
        release: { allowed: false, blockers: ['changed_within_hold'] },
      });

      const settled = await control(who, funded.capitalNoticeId);
      expect(settled.activeWireInstruction, who).toBeNull();
      expect(settled.ticket, who).toMatchObject({ id: funded.id, state: 'Funded' });
      expect(settled.ticket!.wireInstruction, who).toBeNull();
      expect(settled.alerts).toEqual(settledAsOps.alerts);
      expect(JSON.stringify(settled)).not.toContain(
        settledAsOps.ticket!.wireInstruction!.bankDetailsMasked,
      );
    }
    // The ticket list is read by the deal team too: the same rule on every row.
    const dealTickets = tradeTicketPage.parse(
      (await get('deal.one', '/api/v1/trade-tickets?limit=200').expect(200)).body,
    ).items;
    expect(dealTickets.length).toBeGreaterThan(1);
    for (const t of dealTickets) expect(t.wireInstruction).toBeNull();
    const auditorTickets = tradeTicketPage.parse(
      (await get('audit.one', '/api/v1/trade-tickets?limit=200').expect(200)).body,
    ).items;
    expect(auditorTickets.find((t) => t.id === funded.id)!.wireInstruction).not.toBeNull();
  });

  it("D1-01: systemStep is re-entrant: a nested step leaves the enclosing one in force and the caller's roles return at the end", async () => {
    const principal = principalOf('ops.one');
    const rolesNow = async (tx: Tx): Promise<string | null> =>
      (
        await tx.execute<{ roles: string | null }>(
          sql`select current_setting('app.roles', true) as roles`,
        )
      ).rows[0]?.roles ?? null;
    await h.app.get(DbService).run(principal, 'req-fix-step', async (tx) => {
      expect(await rolesNow(tx)).toBe('operations');
      await systemStep(tx, principal, async () => {
        expect(await rolesNow(tx)).toBe('service');
        const inner = await systemStep(tx, principal, async () => rolesNow(tx));
        expect(inner).toBe('service');
        // The nested step ended; the enclosing one has not.
        expect(await rolesNow(tx)).toBe('service');
      });
      expect(await rolesNow(tx)).toBe('operations');
      // A step that fails on its own account gives the roles back too.
      await expect(
        systemStep(tx, principal, async () => {
          await Promise.resolve();
          throw new Error('refused inside the step');
        }),
      ).rejects.toThrow('refused inside the step');
      expect(await rolesNow(tx)).toBe('operations');
    });

    // A statement the database refuses inside a step surfaces as itself: the restore that cannot
    // run on the aborted transaction never takes its place.
    const messages: string[] = [];
    try {
      await h.app.get(DbService).run(principal, 'req-fix-step-sql', (tx) =>
        systemStep(tx, principal, async () => {
          await tx.execute(sql`select 1 / 0`);
        }),
      );
    } catch (error) {
      for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
    }
    expect(messages.join(' | ')).toMatch(/division by zero/);
    expect(messages.join(' | ')).not.toMatch(/aborted/);
  });

  it('D1-01: a new fund-level version sweeps walled notices too: approved tickets return to draft, every open notice is flagged, one audit event each', async () => {
    const fund = walledFund();
    const walled = investment(walledId());
    const open = h.dataset.investments.find((i) => i.sponsorFundId === fund && i.id !== walled.id)!;
    const active = activeSeeded(fund);
    const approvedWalled = await insertNotice({
      vehicleId: walled.vehicleId,
      investmentId: walled.id,
      amount: '100000.00',
      state: 'TicketApproved',
    });
    const walledTicket = await insertApprovedTicket(approvedWalled, active.id);
    const reviewedWalled = await insertNotice({
      vehicleId: walled.vehicleId,
      investmentId: walled.id,
      amount: '120000.00',
      state: 'Reviewed',
    });
    const approvedOpen = await insertNotice({
      vehicleId: open.vehicleId,
      investmentId: open.id,
      amount: '100000.00',
      state: 'TicketApproved',
    });
    const openTicket = await insertApprovedTicket(approvedOpen, active.id);
    // The proposer is not on the wall: the walled notices do not exist for them.
    await get('ops.one', `/api/v1/capital-notices/${approvedWalled}`).expect(404);
    await get('ops.one', `/api/v1/capital-notices/${reviewedWalled}`).expect(404);
    expect((await noticeRow(reviewedWalled)).wire_change_flag).toBe(false);

    const created = wireInstructionDetail.parse(
      (
        await wirePropose(
          'ops.one',
          {
            sponsorFundId: fund,
            counterpartyName: fundName(fund),
            bankDetails: {
              bankName: 'Meridian Clearing',
              accountName: 'Synthetic counterparty',
              accountNumber: '3344556677',
              routingCode: '021000021',
            },
          },
          'req-fix-sweep',
        ).expect(201)
      ).body,
    );
    expect(created).toMatchObject({ version: 2, state: 'Proposed' });

    // Both approved tickets are back in draft, the walled one included, and every notice is flagged.
    for (const [noticeId, ticketId] of [
      [approvedWalled, walledTicket],
      [approvedOpen, openTicket],
    ] as const) {
      expect(await noticeRow(noticeId)).toEqual({
        state: 'TicketDrafted',
        wire_change_flag: true,
        updated_by: user('ops.one').id,
      });
      expect(await ticketRow(ticketId)).toEqual({
        state: 'Drafted',
        approved_by: null,
        wire_instruction_id: null,
        updated_by: user('ops.one').id,
      });
    }
    expect(await noticeRow(reviewedWalled)).toEqual({
      state: 'Reviewed',
      wire_change_flag: true,
      updated_by: user('ops.one').id,
    });

    // One audit event per notice, and no event for a flag the row does not carry.
    const changed = await auditRows('capital_notice.wireChanged', 'req-fix-sweep');
    expect(changed.map((e) => e.entity_id).sort()).toEqual([approvedWalled, approvedOpen].sort());
    for (const e of changed)
      expect(e.details).toMatchObject({
        state: { before: 'TicketApproved', after: 'TicketDrafted' },
        wireChangeFlag: { before: false, after: true },
        ticket: {
          before: { state: 'Approved', wireInstructionId: active.id },
          after: { state: 'Drafted', approvedBy: null, wireInstructionId: null },
        },
      });
    const flagged = await auditRows('capital_notice.wire_change_flag', 'req-fix-sweep');
    expect(flagged.filter((e) => e.entity_id === reviewedWalled).length).toBe(1);
    expect(flagged.some((e) => [approvedWalled, approvedOpen].includes(e.entity_id))).toBe(false);
    for (const e of flagged) {
      expect(e.details).toMatchObject({
        wireChangeFlag: { before: false, after: true },
        wireInstructionId: created.id,
      });
      expect((await noticeRow(e.entity_id)).wire_change_flag, e.entity_id).toBe(true);
    }

    // The wall still holds for the proposer; a wall member sees the notice back in draft.
    await get('ops.one', `/api/v1/capital-notices/${approvedWalled}`).expect(404);
    const asMember = await control('deal.three', approvedWalled);
    expect(asMember.state).toBe('TicketDrafted');
    expect(asMember.alerts).toContain('wire_changed');
    expect(asMember.ticket).toMatchObject({ state: 'Drafted', approvedBy: null });
  });

  it('W2-2: the reconciliation books the amount the ticket was approved and funded for; the audit event and the notes name the difference', async () => {
    const { investmentId, vehicleId } = spareFund(0);
    const investedOf = async (): Promise<string | null> =>
      investmentDetail.parse(
        (
          await get('ops.one', `/api/v1/investments/${investmentId}?asOf=${h.dataset.asOf}`).expect(
            200,
          )
        ).body,
      ).invested;
    const invested0 = await investedOf();
    const id = await insertNotice({
      vehicleId,
      investmentId,
      amount: '300000.00',
      state: 'Reviewed',
    });
    const drafted = await ok('ops.one', id, { command: 'draftTicket', amount: '250000.00' });
    expect(drafted.amount).toBe('300000.00');
    expect(drafted.ticket).toMatchObject({ amount: '250000.00', state: 'Drafted' });
    expect(drafted.notes).not.toContain('Funded amount differs from the notice amount.');
    expect((await ok('head.one', id, { command: 'approveTicket' })).state).toBe('TicketApproved');
    const funded = await ok('ops.one', id, { command: 'confirmFunding' });
    expect(funded.state).toBe('Funded');

    const done = await ok(
      'ops.one',
      id,
      { command: 'reconcile', reason: 'Wire confirmed by the bank' },
      'req-fix-reconcile',
    );
    expect(done.state).toBe('Reconciled');
    expect(done.cashFlows).toEqual([
      {
        date: h.dataset.asOf,
        flowType: 'flow_type.contribution',
        amount: '-250000.00',
        status: APPROVED,
      },
    ]);
    expect(done.settledAmount).toBe('250000.00');
    expect(done.amount).toBe('300000.00');
    // The difference is said in words from the moment the ticket is funded.
    expect(funded.notes).toEqual([
      'No cash flow has been recorded for this notice.',
      'Funded amount differs from the notice amount.',
    ]);
    expect(done.notes).toEqual(['Funded amount differs from the notice amount.']);
    const [flowRow] = await sqlRows<{ amount: string }>(
      'select amount::text as amount from mon.cash_flow where source_notice_id = $1',
      [id],
    );
    expect(flowRow).toEqual({ amount: '-250000.00' });
    const [event] = await auditRows('capital_notice.reconcile', 'req-fix-reconcile');
    expect(event!.details).toMatchObject({
      state: { before: 'Funded', after: 'Reconciled' },
      cashFlow: {
        flowType: 'flow_type.contribution',
        amount: '-250000',
        noticeAmount: '300000.00',
        ticketAmount: '250000.00',
      },
    });
    // The position's invested capital grew by what was funded, not by what the notice asked.
    expect(
      D((await investedOf())!)
        .minus(invested0 ?? '0')
        .equals(D('250000')),
    ).toBe(true);

    // A ticket for the notice amount reads as before: no note, one amount in the event.
    const same = await insertNotice({
      vehicleId,
      investmentId,
      amount: '80000.00',
      state: 'Reviewed',
    });
    await ok('ops.one', same, { command: 'draftTicket' });
    await ok('head.one', same, { command: 'approveTicket' });
    await ok('ops.one', same, { command: 'confirmFunding' });
    const plain = await ok('ops.one', same, { command: 'reconcile' }, 'req-fix-reconcile-same');
    expect(plain.notes).toEqual([]);
    expect(plain.settledAmount).toBe('80000.00');
    const [plainEvent] = await auditRows('capital_notice.reconcile', 'req-fix-reconcile-same');
    const cashFlow = plainEvent!.details.cashFlow as Record<string, unknown>;
    expect(cashFlow.amount).toBe('-80000');
    expect('noticeAmount' in cashFlow).toBe(false);
    expect('ticketAmount' in cashFlow).toBe(false);
  });

  it('W2-3: inside the hold window after a verified change, the release needs a third person: not the proposer of the change, not the person whose callback verified it', async () => {
    const wc = tagged('wire_change');
    const fund = wireChangeFund();
    const clock = h.runtime.adapters.clock as FixedClock;
    const started = clock.now();
    const fresh = (): Promise<string> =>
      insertNotice({
        vehicleId: wc.vehicleId,
        investmentId: wc.investmentId!,
        amount: '100000.00',
        state: 'Reviewed',
        dueDate: addDays(h.dataset.asOf, 45),
      });
    // The seeded change: version 2, proposed today by ops.one, waiting for its callback.
    const v2 = wireInstructionPage
      .parse(
        (
          await get(
            'ops.one',
            `/api/v1/wire-instructions?sponsorFundId=${fund}&state=Proposed`,
          ).expect(200)
        ).body,
      )
      .items.find((r) => r.version === 2)!;
    expect(v2.proposedBy.id).toBe(user('ops.one').id);
    expect(v2.proposedAt.slice(0, 10)).toBe(h.dataset.asOf);
    await wireCommand('ops.two', v2.id, verifyBody).expect(200);

    try {
      // Prepared by the proposer of the change: the verifier is the second person, not the third.
      const first = await fresh();
      await ok('ops.one', first, { command: 'draftTicket' });
      const byVerifier = await refused(
        'ops.two',
        first,
        { command: 'approveTicket' },
        422,
        'workflow-precondition',
      );
      expect(byVerifier.detail).toContain('verified');
      expect(byVerifier.detail).toContain('third person');
      expect(byVerifier.detail).toContain('SEC-12.3');
      expect((await control('ops.two', first)).ticket!.release).toEqual({
        allowed: false,
        blockers: ['verifier_within_hold'],
      });
      expect((await control('ops.one', first)).ticket!.release).toEqual({
        allowed: false,
        blockers: ['same_person', 'verifier_within_hold'],
      });
      expect((await control('head.one', first)).ticket!.release).toEqual({
        allowed: true,
        blockers: [],
      });
      // The verified change is the active instruction: nothing is pending, the notice shows no hold.
      expect((await control('head.one', first)).wireChangeHold).toBeNull();
      expect((await control('ops.two', first)).state).toBe('TicketDrafted');
      // A third person releases it.
      expect((await ok('head.one', first, { command: 'approveTicket' })).state).toBe(
        'TicketApproved',
      );

      // Prepared by the verifier: the proposer of the change cannot be the approver either.
      const second = await fresh();
      await ok('ops.two', second, { command: 'draftTicket' });
      const byProposer = await refused(
        'ops.one',
        second,
        { command: 'approveTicket' },
        422,
        'workflow-precondition',
      );
      expect(byProposer.detail).toContain('proposed');
      expect(byProposer.detail).toContain('third person');
      expect((await control('ops.one', second)).ticket!.release).toEqual({
        allowed: false,
        blockers: ['verifier_within_hold'],
      });

      // The window runs wireChangeHoldDays (30) from the day the change was proposed.
      const third = await fresh();
      await ok('ops.one', third, { command: 'draftTicket' });
      clock.set(`${addDays(h.dataset.asOf, 29)}T12:00:00Z`);
      await refused('ops.two', third, { command: 'approveTicket' }, 422, 'workflow-precondition');
      clock.set(`${addDays(h.dataset.asOf, 30)}T12:00:00Z`);
      expect((await control('ops.two', third)).ticket!.release).toEqual({
        allowed: true,
        blockers: [],
      });
      // Outside the window the existing rule stands: a person other than the preparer.
      expect((await ok('ops.two', third, { command: 'approveTicket' })).state).toBe(
        'TicketApproved',
      );
      expect((await ok('ops.one', second, { command: 'approveTicket' })).state).toBe(
        'TicketApproved',
      );
    } finally {
      clock.set(started);
    }
  });

  it('W2-4: an older Proposed version is not verified over a newer Verified one: 422, reject it instead', async () => {
    const { fundId } = spareFund(1);
    const v1 = activeSeeded(fundId);
    const v2 = await proposeFor(fundId, '2000000002');
    const v3 = await proposeFor(fundId, '3000000003');
    expect([v2.version, v3.version]).toEqual([2, 3]);
    await wireCommand('ops.two', v3.id, verifyBody).expect(200);
    expect((await wireDetail('ops.one', v1.id)).state).toBe('Superseded');

    const res = await wireCommand('ops.two', v2.id, verifyBody, 'req-fix-older').expect(422);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}workflow-precondition`);
    expect(problem.detail).toContain('newer version');
    expect(problem.detail).toContain('reject');
    // Nothing moved: the newer version is still the one active instruction.
    expect(await wireDetail('ops.one', v3.id)).toMatchObject({ state: 'Verified', active: true });
    expect(await wireDetail('ops.one', v2.id)).toMatchObject({ state: 'Proposed', active: false });
    expect((await auditRows('wire_instruction.supersede', 'req-fix-older')).length).toBe(0);
    expect((await auditRows('wire_instruction.verify', 'req-fix-older')).length).toBe(0);

    const rejected = wireInstructionDetail.parse(
      (
        await wireCommand('ops.two', v2.id, {
          command: 'reject',
          reason: 'Overtaken by version 3',
        }).expect(200)
      ).body,
    );
    expect(rejected.state).toBe('Rejected');
    const active = wireInstructionPage
      .parse(
        (await get('ops.one', `/api/v1/wire-instructions?sponsorFundId=${fundId}`).expect(200))
          .body,
      )
      .items.filter((r) => r.active);
    expect(active.map((r) => r.id)).toEqual([v3.id]);
  });

  it('W2-5: a failed callback is recorded with its number source or not at all, and the register row shows it', async () => {
    const { fundId } = spareFund(2);
    const v2 = await proposeFor(fundId, '5000000005');
    for (const body of [
      { command: 'reject', callbackResult: 'not_confirmed', reason: 'the number did not answer' },
      { command: 'reject', callbackNumberSource: 'known_contact', reason: 'no result given' },
    ]) {
      const res = await wireCommand('ops.two', v2.id, body).expect(400);
      const problem = problemDetails.parse(res.body);
      expect(problem.type).toBe(`${PROBLEM}validation`);
      expect(problem.errors!.map((e) => e.path).join(' ')).toMatch(
        /callbackNumberSource|callbackResult/,
      );
    }
    // The service refuses the same body should a caller reach it past the contract.
    let bypass: unknown;
    try {
      await h.app.get(WiresService).command(principalOf('ops.two'), 'req-fix-bypass', v2.id, {
        command: 'reject',
        callbackResult: 'not_confirmed',
        reason: 'the number did not answer',
      });
    } catch (error) {
      bypass = error;
    }
    expect(bypass).toBeInstanceOf(ProblemError);
    expect((bypass as ProblemError).getStatus()).toBe(422);
    expect((bypass as ProblemError).message).toContain('source of the number');
    expect(await wireDetail('ops.one', v2.id)).toMatchObject({ state: 'Proposed', callback: null });

    await wireCommand('ops.two', v2.id, {
      command: 'reject',
      callbackNumberSource: 'known_contact',
      callbackResult: 'not_confirmed',
      reason: 'the contact did not recognise the account',
    }).expect(200);
    // The list row, as an auditor reads the register: the failed callback is on it.
    const row = wireInstructionPage
      .parse(
        (await get('audit.one', `/api/v1/wire-instructions?sponsorFundId=${fundId}`).expect(200))
          .body,
      )
      .items.find((r) => r.id === v2.id)!;
    expect(row.state).toBe('Rejected');
    expect(row.callback).toEqual({
      by: { id: user('ops.two').id, name: user('ops.two').displayName },
      at: h.runtime.adapters.clock.now(),
      numberSource: 'known_contact',
      result: 'not_confirmed',
    });
  });
});
