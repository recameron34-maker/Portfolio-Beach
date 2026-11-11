import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@pb/calc';
import {
  closingDetail,
  documentPage,
  investmentDetail,
  opportunityDetail,
  problemDetails,
} from '@pb/contracts';
import type { ClosingDetail, OpportunityDetail } from '@pb/contracts';
import type { Response } from 'supertest';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const CO_INVEST = 'deal_type.co_invest_equity';
const COMMITMENT = '15000000.00';
const CONFIRMED_MESSAGE =
  /the closing is confirmed; change the close date or ask operations to reopen it/;

/*
 * The controls around a deal that does not walk the straight line (docs/18 sections 4 and 12): a
 * deal passed and reopened, a closing confirmed and then changed, a tie-out with a received amount
 * missing, a position that already exists, a walled deal that converts. Every test walks its own
 * deal from Sourced, so the tests do not depend on one another or on the seeded pipeline.
 */
describe('pipeline and closing controls (docs/18 sections 4 and 12): reopened deals, a confirmed closing, the tie-out and the wall', () => {
  let h: Harness;
  let hubDocumentId: string;

  beforeAll(async () => {
    h = await startHarness();
    await h
      .http()
      .post('/api/v1/documents/index')
      .set('authorization', h.as('ops.one'))
      .set('x-request-id', 'req-pc-index')
      .expect(200);
    const docs = documentPage.parse(
      (
        await h
          .http()
          .get('/api/v1/documents?limit=200')
          .set('authorization', h.as('viewer.one'))
          .expect(200)
      ).body,
    );
    hubDocumentId = docs.items[0]!.id;
  });
  afterAll(async () => {
    await h.close();
  });

  const get = (who: string, path: string) =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', 'req-pc-get');
  const post = (who: string, path: string, body: object, requestId = 'req-pc-post') =>
    h.http().post(path).set('authorization', h.as(who)).set('x-request-id', requestId).send(body);
  const expectProblem = (res: Response, status: number, code: string): string => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}${code}`);
    return problem.detail ?? '';
  };
  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const audits = (action: string, requestId: string) =>
    h.runtime.db.query<{
      details: Record<string, unknown>;
      reason: string | null;
      actor_id: string;
    }>(
      'select details, reason, actor_id from audit.event where action = $1 and request_id = $2 order by id',
      [action, requestId],
    );

  const detail = async (who: string, id: string): Promise<OpportunityDetail> =>
    opportunityDetail.parse((await get(who, `/api/v1/opportunities/${id}`).expect(200)).body);
  const command = (who: string, id: string, body: object, requestId = 'req-pc-command') =>
    post(who, `/api/v1/opportunities/${id}/commands`, body, requestId);
  const advance = async (
    who: string,
    id: string,
    extra: object = {},
    requestId = 'req-pc-advance',
  ): Promise<OpportunityDetail> =>
    opportunityDetail.parse(
      (await command(who, id, { command: 'advance', ...extra }, requestId).expect(200)).body,
    );
  const closing = async (who: string, closingId: string): Promise<ClosingDetail> =>
    closingDetail.parse((await get(who, `/api/v1/closings/${closingId}`).expect(200)).body);
  const closingCommand = (
    who: string,
    closingId: string,
    body: object,
    requestId = 'req-pc-closing',
  ) => post(who, `/api/v1/closings/${closingId}/commands`, body, requestId);
  const itemCommand = (who: string, closingId: string, code: string, body: object) =>
    post(who, `/api/v1/closings/${closingId}/items/${code}/commands`, body);
  const putAllocations = (who: string, id: string, allocations: object[]) =>
    h
      .http()
      .put(`/api/v1/opportunities/${id}/allocations`)
      .set('authorization', h.as(who))
      .set('x-request-id', 'req-pc-allocations')
      .send({ allocations });
  const decide = (who: string, id: string, decisionDate: string, decision = 'approved') =>
    post(who, `/api/v1/opportunities/${id}/ic-decisions`, {
      decisionDate,
      decision,
      amount: COMMITMENT,
      conditions: [],
    });

  /** People who walk a deal: the deal team member, the approver and the operations user. */
  interface Cast {
    team: string;
    approver: string;
    ops: string;
  }
  const CAST: Cast = { team: 'deal.one', approver: 'head.one', ops: 'ops.one' };

  /** A new deal at Sourced; the label keeps the deal and its company apart from every other test's. */
  const create = async (label: string, cast: Cast = CAST): Promise<OpportunityDetail> => {
    const fund = h.dataset.sponsorFunds.find((f) => f.strategy !== 'strategy.credit')!;
    return opportunityDetail.parse(
      (
        await post(cast.team, '/api/v1/opportunities', {
          name: `Project ${label}`,
          companyName: `${label} Holdings Co`,
          sponsorId: fund.sponsorId,
          sponsorFundId: fund.id,
          dealType: CO_INVEST,
          receivedDate: h.dataset.asOf,
          targetCommitment: COMMITMENT,
        }).expect(201)
      ).body,
    );
  };
  /** Sourced to IC: the template tasks required for IC are completed on the way. */
  const toIc = async (id: string, cast: Cast = CAST): Promise<OpportunityDetail> => {
    await advance(cast.team, id);
    await advance(cast.team, id);
    const diligence = await advance(cast.team, id);
    expect(diligence.stage).toBe('Diligence');
    for (const task of diligence.diligenceTasks.filter(
      (t) => t.requiredForIc && t.status === 'open',
    ))
      await post(cast.team, `/api/v1/opportunities/${id}/diligence-tasks/${task.id}/commands`, {
        command: 'complete',
      }).expect(200);
    const ic = await advance(cast.team, id);
    expect(ic.stage).toBe('IC');
    return ic;
  };
  /** Sourced to Approved, the decision dated the day before the as-of date. */
  const toApproved = async (id: string, cast: Cast = CAST): Promise<OpportunityDetail> => {
    await toIc(id, cast);
    await decide(cast.approver, id, addDays(h.dataset.asOf, -1)).expect(201);
    const approved = await advance(cast.approver, id);
    expect(approved.stage).toBe('Approved');
    return approved;
  };
  /** Sourced to Closing with the closing opened for the as-of date and the commitment. */
  const toClosing = async (
    id: string,
    cast: Cast = CAST,
  ): Promise<{ opportunity: OpportunityDetail; closingId: string }> => {
    await toApproved(id, cast);
    const opportunity = await advance(cast.team, id, {
      closeDate: h.dataset.asOf,
      commitmentAmount: COMMITMENT,
    });
    expect(opportunity.stage).toBe('Closing');
    return { opportunity, closingId: opportunity.closing!.id };
  };
  /** Every required item received with the hub document. */
  const receiveRequired = async (closingId: string, who = CAST.ops): Promise<void> => {
    const before = await closing(who, closingId);
    for (const item of before.items.filter((i) => i.required && i.status === 'open'))
      await itemCommand(who, closingId, item.itemCode, {
        command: 'receive',
        documentId: hubDocumentId,
      }).expect(200);
  };
  /** One vehicle line, requested and received in full, so the lines tie to the amount. */
  const allocateInFull = (id: string, amount: string, who = CAST.team) =>
    putAllocations(who, id, [
      { vehicleId: h.dataset.vehicles[0]!.id, requested: amount, received: amount },
    ]).expect(200);
  /** Sourced to a closing confirmed by operations. */
  const toConfirmed = async (
    id: string,
    cast: Cast = CAST,
  ): Promise<{ closingId: string; confirmed: ClosingDetail }> => {
    const { closingId } = await toClosing(id, cast);
    await receiveRequired(closingId, cast.ops);
    await allocateInFull(id, COMMITMENT, cast.team);
    const confirmed = closingDetail.parse(
      (await closingCommand(cast.ops, closingId, { command: 'confirm' }).expect(200)).body,
    );
    expect(confirmed.state).toBe('OpsConfirmed');
    return { closingId, confirmed };
  };
  /** Passed, reopened and walked back to IC: Screening, Prescreen, Diligence (the tasks stay as they were), IC. */
  const passAndReturnToIc = async (id: string): Promise<OpportunityDetail> => {
    await command(CAST.team, id, {
      command: 'pass',
      passReasonCode: 'pass_reason.other',
      note: 'The sponsor withdrew the allocation',
    }).expect(200);
    const reopened = opportunityDetail.parse(
      (
        await command(CAST.team, id, {
          command: 'reopen',
          reason: 'the sponsor came back with the allocation',
        }).expect(200)
      ).body,
    );
    expect(reopened.stage).toBe('Screening');
    await advance(CAST.team, id);
    await advance(CAST.team, id);
    const ic = await advance(CAST.team, id);
    expect(ic.stage).toBe('IC');
    return ic;
  };
  const closingRow = async (closingId: string) =>
    (
      await h.runtime.db.query<{
        close_date: string;
        commitment_amount: string;
        state: string;
        reopen_reason: string | null;
        ops_confirmed_by: string | null;
        ops_confirmed_at: string | null;
        updated_by: string | null;
      }>(
        "select to_char(close_date, 'YYYY-MM-DD') as close_date, commitment_amount::text as commitment_amount, state::text as state, reopen_reason, ops_confirmed_by, ops_confirmed_at::text as ops_confirmed_at, updated_by from deal.closing where id = $1",
        [closingId],
      )
    )[0]!;

  describe('a deal that was passed and reopened', () => {
    it('needs a new IC decision: one recorded before the pass no longer opens Approved, and the tasks done before it are counted as carried over', async () => {
      const id = (await create('Tidewater')).id;
      const approved = await toApproved(id);
      expect(approved.gates.icDecision.ok).toBe(true);
      expect(approved.gates.diligence).toEqual({ requiredOpen: 0, ok: true, carriedOver: 0 });
      const required = approved.diligenceTasks.filter((t) => t.requiredForIc).length;
      expect(required).toBeGreaterThan(0);

      const ic = await passAndReturnToIc(id);
      // The decision of the first round is still on record, and no longer the gate's.
      expect(ic.icDecisions).toHaveLength(1);
      expect(ic.icDecisions[0]!.decision).toBe('approved');
      expect(ic.gates.icDecision.ok).toBe(false);
      // The work was done, so the tasks stay done; the gate says they predate the reopen.
      expect(ic.gates.diligence).toEqual({ requiredOpen: 0, ok: true, carriedOver: required });
      expect(
        expectProblem(
          await command(CAST.approver, id, { command: 'advance' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/IC decision record is required/);
      expect((await detail(CAST.team, id)).stage).toBe('IC');

      // A decision of this round opens the gate again; a declined one does not.
      await decide(CAST.approver, id, h.dataset.asOf, 'declined').expect(201);
      expectProblem(
        await command(CAST.approver, id, { command: 'advance' }),
        422,
        'workflow-precondition',
      );
      const decided = opportunityDetail.parse(
        (await decide(CAST.approver, id, addDays(h.dataset.asOf, 1)).expect(201)).body,
      );
      expect(decided.icDecisions).toHaveLength(3);
      expect(decided.gates.icDecision.ok).toBe(true);
      expect((await advance(CAST.approver, id)).stage).toBe('Approved');
    });

    it('shows no IC decision as the gate between the reopen and the next IC, whatever was recorded before the pass', async () => {
      const id = (await create('Saltmarsh')).id;
      await toApproved(id);
      await command(CAST.team, id, {
        command: 'pass',
        passReasonCode: 'pass_reason.other',
      }).expect(200);
      const reopened = opportunityDetail.parse(
        (
          await command(CAST.team, id, {
            command: 'reopen',
            reason: 'reopened to look again',
          }).expect(200)
        ).body,
      );
      expect(reopened.stage).toBe('Screening');
      expect(reopened.gates.icDecision.ok).toBe(false);
    });

    it('reaching Closing again rewrites the closing as the deal team, returns it to Open and needs confirmation again before Closed', async () => {
      const id = (await create('Longshore')).id;
      const { closingId, confirmed } = await toConfirmed(id);
      expect((await detail(CAST.team, id)).gates.closing.ok).toBe(true);
      const receivedBefore = confirmed.items.filter((i) => i.status === 'received').length;
      expect(receivedBefore).toBeGreaterThan(0);

      await passAndReturnToIc(id);
      await decide(CAST.approver, id, h.dataset.asOf).expect(201);
      await advance(CAST.approver, id);

      // The deal team opens the closing again with a new date and a new commitment.
      const newDate = addDays(h.dataset.asOf, -3);
      const newCommitment = '12000000.00';
      const back = await advance(
        CAST.team,
        id,
        { closeDate: newDate, commitmentAmount: newCommitment },
        'req-pc-reenter',
      );
      expect(back.stage).toBe('Closing');
      expect(back.closing).toMatchObject({
        id: closingId,
        closeDate: newDate,
        commitmentAmount: newCommitment,
        state: 'Open',
        opsConfirmedBy: null,
        opsConfirmedAt: null,
      });
      expect(back.gates.closing).toMatchObject({ confirmed: false, ok: false });

      // What was written is what the audit event says was written, by the person who commanded it.
      const row = await closingRow(closingId);
      expect(row).toMatchObject({
        close_date: newDate,
        commitment_amount: newCommitment,
        state: 'Open',
        ops_confirmed_by: null,
        ops_confirmed_at: null,
        updated_by: user(CAST.team).id,
      });
      expect(row.reopen_reason).toMatch(/reached Closing again/);
      const [reuse] = await audits('closing.reuse', 'req-pc-reenter');
      expect(reuse!.actor_id).toBe(user(CAST.team).id);
      expect(reuse!.details).toMatchObject({
        opportunityId: id,
        state: { before: 'OpsConfirmed', after: row.state },
        closeDate: { before: h.dataset.asOf, after: row.close_date },
        commitmentAmount: { before: COMMITMENT, after: row.commitment_amount },
        opsConfirmedBy: { before: user(CAST.ops).id, after: null },
      });
      expect((await audits('opportunity.advance', 'req-pc-reenter'))[0]!.details).toMatchObject({
        stage: { before: 'Approved', after: 'Closing' },
        closing: { id: closingId, closeDate: newDate, commitmentAmount: newCommitment },
      });

      // The documents are still on file: received items stay received.
      const reopened = await closing(CAST.ops, closingId);
      expect(reopened.items.filter((i) => i.status === 'received')).toHaveLength(receivedBefore);
      expect(reopened.itemsRequiredOpen).toBe(0);

      // Closing to Closed waits for the tie-out against the new commitment and a new confirmation.
      expect(
        expectProblem(
          await command(CAST.ops, id, { command: 'advance' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/allocations do not tie/);
      await allocateInFull(id, newCommitment);
      expect(
        expectProblem(
          await command(CAST.ops, id, { command: 'advance' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/not confirmed by operations/);
      expect((await detail(CAST.team, id)).stage).toBe('Closing');
      await closingCommand(CAST.ops, closingId, { command: 'confirm' }).expect(200);
      const closed = await advance(CAST.ops, id);
      expect(closed.stage).toBe('Closed');
      const position = investmentDetail.parse(
        (await get(CAST.ops, `/api/v1/investments/${closed.investmentId}`).expect(200)).body,
      );
      expect(position.entryDate).toBe(newDate);
      expect(position.closeDate).toBe(newDate);
    });

    it('reaching Closing again with a closing that was never confirmed rewrites the date and commitment and leaves it Open', async () => {
      const id = (await create('Driftline')).id;
      const { closingId } = await toClosing(id);
      await passAndReturnToIc(id);
      await decide(CAST.approver, id, h.dataset.asOf).expect(201);
      await advance(CAST.approver, id);
      const newDate = addDays(h.dataset.asOf, 10);
      const back = await advance(
        CAST.team,
        id,
        { closeDate: newDate, commitmentAmount: '9000000.00' },
        'req-pc-reenter-open',
      );
      expect(back.closing).toMatchObject({
        id: closingId,
        closeDate: newDate,
        commitmentAmount: '9000000.00',
        state: 'Open',
      });
      const row = await closingRow(closingId);
      expect(row).toMatchObject({
        close_date: newDate,
        commitment_amount: '9000000.00',
        state: 'Open',
        updated_by: user(CAST.team).id,
      });
      expect((await audits('closing.reuse', 'req-pc-reenter-open'))[0]!.details).toMatchObject({
        state: { before: 'Open', after: 'Open' },
        closeDate: { before: h.dataset.asOf, after: newDate },
        commitmentAmount: { before: COMMITMENT, after: '9000000.00' },
      });
    });
  });

  describe('a closing confirmed by operations', () => {
    it('says in the gates whether operations confirmed, and the gate is clear only then', async () => {
      const id = (await create('Sandbar')).id;
      const { closingId } = await toClosing(id);
      await receiveRequired(closingId);
      await allocateInFull(id, COMMITMENT);
      expect((await detail(CAST.team, id)).gates.closing).toEqual({
        checklistComplete: true,
        allocationTiedOut: true,
        confirmed: false,
        ok: false,
      });
      await closingCommand(CAST.ops, closingId, { command: 'confirm' }).expect(200);
      expect((await detail(CAST.team, id)).gates.closing).toEqual({
        checklistComplete: true,
        allocationTiedOut: true,
        confirmed: true,
        ok: true,
      });
    });

    it('refuses allocation and checklist changes until operations reopen it with a reason; the reopen is audited and needs confirmation again', async () => {
      const id = (await create('Breakwater Two')).id;
      const { closingId, confirmed } = await toConfirmed(id);
      const received = confirmed.items.find((i) => i.status === 'received')!;
      const optional = confirmed.items.find((i) => !i.required && i.status === 'open')!;
      const vehicle = h.dataset.vehicles[0]!.id;

      // The lines and the items are what operations confirmed: they stay as they are.
      for (const who of [CAST.team, CAST.ops])
        expect(
          expectProblem(
            await putAllocations(who, id, [
              { vehicleId: vehicle, requested: '1.00', received: '1.00' },
            ]),
            422,
            'workflow-precondition',
          ),
        ).toMatch(CONFIRMED_MESSAGE);
      expect(
        expectProblem(
          await itemCommand(CAST.ops, closingId, received.itemCode, { command: 'reopen' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(CONFIRMED_MESSAGE);
      expect(
        expectProblem(
          await itemCommand(CAST.team, closingId, optional.itemCode, {
            command: 'waive',
            reason: 'no side letter on this deal',
          }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(CONFIRMED_MESSAGE);
      expect(
        expectProblem(
          await itemCommand(CAST.ops, closingId, optional.itemCode, {
            command: 'receive',
            documentId: hubDocumentId,
          }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(CONFIRMED_MESSAGE);
      const unchanged = await closing(CAST.ops, closingId);
      expect(unchanged.state).toBe('OpsConfirmed');
      expect(unchanged.items).toEqual(confirmed.items);
      expect(unchanged.allocations).toEqual(confirmed.allocations);

      // reopen: operations only, with a reason; a stale If-Match is refused first.
      expectProblem(
        await closingCommand(CAST.team, closingId, { command: 'reopen', reason: 'a line moved' }),
        403,
        'forbidden',
      );
      expectProblem(
        await closingCommand(CAST.ops, closingId, { command: 'reopen' }),
        400,
        'validation',
      );
      expect(
        expectProblem(
          await closingCommand(CAST.ops, closingId, { command: 'reopen', reason: '    ' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/a reason is required/);
      expectProblem(
        await closingCommand(CAST.ops, closingId, {
          command: 'reopen',
          reason: 'the second vehicle takes part of the allocation',
        }).set('if-match', `"${confirmed.rowVersion + 5}"`),
        412,
        'stale-row-version',
      );
      const reopened = closingDetail.parse(
        (
          await closingCommand(
            CAST.ops,
            closingId,
            { command: 'reopen', reason: 'the second vehicle takes part of the allocation' },
            'req-pc-reopen',
          )
            .set('if-match', `"${confirmed.rowVersion}"`)
            .expect(200)
        ).body,
      );
      expect(reopened).toMatchObject({
        state: 'Open',
        closeDate: confirmed.closeDate,
        commitmentAmount: confirmed.commitmentAmount,
        opsConfirmedBy: null,
        opsConfirmedAt: null,
      });
      const [reopenAudit] = await audits('closing.reopen', 'req-pc-reopen');
      expect(reopenAudit!.reason).toBe('the second vehicle takes part of the allocation');
      expect(reopenAudit!.details).toMatchObject({
        state: { before: 'OpsConfirmed', after: 'Open' },
        opsConfirmedBy: { before: user(CAST.ops).id, after: null },
      });
      expect((await closingRow(closingId)).reopen_reason).toBe(
        'the second vehicle takes part of the allocation',
      );
      expect((await detail(CAST.team, id)).gates.closing).toMatchObject({
        confirmed: false,
        ok: false,
      });
      // The forbidden pair: an Open closing is not reopened.
      expectProblem(
        await closingCommand(CAST.ops, closingId, { command: 'reopen', reason: 'again' }),
        409,
        'workflow-transition',
      );

      // Open again, the lines and the items change, and the closing waits for a new confirmation.
      await itemCommand(CAST.team, closingId, optional.itemCode, {
        command: 'waive',
        reason: 'no side letter on this deal',
      }).expect(200);
      await putAllocations(CAST.team, id, [
        { vehicleId: vehicle, requested: '10000000.00', received: '10000000.00' },
        { vehicleId: h.dataset.vehicles[1]!.id, requested: '5000000.00', received: '5000000.00' },
      ]).expect(200);
      expect(
        expectProblem(
          await command(CAST.ops, id, { command: 'advance' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/not confirmed by operations/);
      await closingCommand(CAST.ops, closingId, { command: 'confirm' }).expect(200);
      expect((await advance(CAST.ops, id)).stage).toBe('Closed');
    });

    it('once the position exists, refuses a close date change and a reopen: the change goes through a deal change request', async () => {
      const id = (await create('Headland')).id;
      const { closingId } = await toConfirmed(id);
      const closed = await advance(CAST.ops, id);
      expect(closed.stage).toBe('Closed');
      const position = async () =>
        investmentDetail.parse(
          (await get(CAST.ops, `/api/v1/investments/${closed.investmentId}`).expect(200)).body,
        );
      expect((await position()).entryDate).toBe(h.dataset.asOf);
      for (const body of [
        {
          command: 'changeCloseDate',
          closeDate: addDays(h.dataset.asOf, 5),
          reason: 'the signing date was recorded a week early',
        },
        { command: 'reopen', reason: 'the signing date was recorded a week early' },
      ])
        expect(
          expectProblem(
            await closingCommand(CAST.ops, closingId, body),
            422,
            'workflow-precondition',
          ),
        ).toMatch(/the position exists; record the change through a deal change request/);
      expect(await closingRow(closingId)).toMatchObject({
        close_date: h.dataset.asOf,
        state: 'OpsConfirmed',
      });
      expect(await position()).toMatchObject({
        entryDate: h.dataset.asOf,
        closeDate: h.dataset.asOf,
      });

      // The same holds for a position that predates the pipeline.
      const seeded = h.dataset.closings!.find(
        (c) => c.investmentId !== null && c.investmentId !== h.dataset.scenarios.walled_deal![0],
      )!;
      expect(
        expectProblem(
          await closingCommand(CAST.ops, seeded.id, {
            command: 'changeCloseDate',
            closeDate: addDays(seeded.closeDate, 5),
            reason: 'the signing date was recorded a week early',
          }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/the position exists/);
      expect((await closingRow(seeded.id)).close_date).toBe(seeded.closeDate);
    });
  });

  describe('the allocation tie-out (M22)', () => {
    it('sums received amounts only: a line with no received amount keeps the closing from confirming, and the refusal says how many are missing', async () => {
      const id = (await create('Shoal')).id;
      const { closingId } = await toClosing(id);
      await receiveRequired(closingId);
      const [vehicleA, vehicleB, vehicleC] = h.dataset.vehicles;

      // Requested in full, received on one line only: the requested amount never stands in.
      const partly = opportunityDetail.parse(
        (
          await putAllocations(CAST.team, id, [
            { vehicleId: vehicleA!.id, requested: '10000000.00', received: '10000000.00' },
            { vehicleId: vehicleB!.id, requested: '5000000.00' },
          ]).expect(200)
        ).body,
      );
      expect(partly.closing!.allocationTieOut).toEqual({
        commitment: COMMITMENT,
        allocated: '10000000.00',
        difference: '-5000000.00',
        tiedOut: false,
      });
      expect(partly.gates.closing).toMatchObject({ allocationTiedOut: false, ok: false });
      expect(
        expectProblem(
          await closingCommand(CAST.ops, closingId, { command: 'confirm' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/received amounts are missing on 1 line \(M22\)/);

      // Received amounts that reach the commitment do not tie while another line has none.
      const reached = opportunityDetail.parse(
        (
          await putAllocations(CAST.team, id, [
            { vehicleId: vehicleA!.id, requested: '10000000.00', received: COMMITMENT },
            { vehicleId: vehicleB!.id, requested: '3000000.00' },
            { vehicleId: vehicleC!.id, requested: '2000000.00' },
          ]).expect(200)
        ).body,
      );
      expect(reached.closing!.allocationTieOut).toEqual({
        commitment: COMMITMENT,
        allocated: COMMITMENT,
        difference: '0.00',
        tiedOut: false,
      });
      expect(
        expectProblem(
          await closingCommand(CAST.ops, closingId, { command: 'confirm' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/received amounts are missing on 2 lines \(M22\)/);
      expect(
        expectProblem(
          await command(CAST.ops, id, { command: 'advance' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/allocations do not tie/);

      // Every line received, short of the commitment: the plain tie-out refusal.
      await putAllocations(CAST.team, id, [
        { vehicleId: vehicleA!.id, requested: '10000000.00', received: '10000000.00' },
        { vehicleId: vehicleB!.id, requested: '5000000.00', received: '4000000.00' },
      ]).expect(200);
      expect(
        expectProblem(
          await closingCommand(CAST.ops, closingId, { command: 'confirm' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/allocations do not tie to the closing commitment/);

      // Every line received and the total equal to the commitment: the closing confirms.
      const tied = opportunityDetail.parse(
        (
          await putAllocations(CAST.team, id, [
            { vehicleId: vehicleA!.id, requested: '10000000.00', received: '10000000.00' },
            { vehicleId: vehicleB!.id, requested: '5000000.00', received: '5000000.00' },
          ]).expect(200)
        ).body,
      );
      expect(tied.closing!.allocationTieOut).toEqual({
        commitment: COMMITMENT,
        allocated: COMMITMENT,
        difference: '0.00',
        tiedOut: true,
      });
      await closingCommand(CAST.ops, closingId, { command: 'confirm' }).expect(200);
    });
  });

  describe('a walled deal that converts (SEC-5.3)', () => {
    /** The people of a walled deal: every one a member of the seeded wall once ops.two joins it. */
    const WALLED_CAST: Cast = { team: 'deal.three', approver: 'head.one', ops: 'ops.two' };
    const SECOND_WALL = '00000000-0000-4000-8000-0000000000a2';
    const wallsOf = async (entity: string, entityId: string): Promise<string[]> =>
      (
        await h.runtime.db.query<{ wall_id: string }>(
          'select wall_id from core.walled_record where entity = $1 and entity_id = $2 order by wall_id',
          [entity, entityId],
        )
      ).map((r) => r.wall_id);
    /**
     * A deal under two walls with its closing confirmed: the seeded wall (a deal team member, the
     * approver and, joined here, an operations user, who closes it) and a second wall whose one
     * member, deal.two, is in no other. Written as the database owner: walls have no route in the
     * prototype.
     */
    const walledDealConfirmed = async (label: string): Promise<string> => {
      const wall = h.dataset.walls[0]!;
      await h.runtime.db.query(
        'insert into core.wall (id, name) values ($1, $2) on conflict do nothing',
        [SECOND_WALL, 'Project Groyne'],
      );
      for (const [wallId, member] of [
        [wall.id, user('ops.two').id],
        [SECOND_WALL, user('deal.two').id],
      ])
        await h.runtime.db.query(
          'insert into core.wall_member (wall_id, user_id) values ($1, $2) on conflict do nothing',
          [wallId, member],
        );
      const id = (await create(label, WALLED_CAST)).id;
      for (const wallId of [wall.id, SECOND_WALL])
        await h.runtime.db.query(
          "insert into core.walled_record (wall_id, entity, entity_id) values ($1, 'opportunity', $2)",
          [wallId, id],
        );
      for (const who of ['viewer.one', 'deal.one', 'ops.one'])
        await get(who, `/api/v1/opportunities/${id}`).expect(404);
      await toConfirmed(id, WALLED_CAST);
      return id;
    };

    it('carries every wall of the opportunity to the position: a non-member gets 404 on it and a member of any of its walls sees it', async () => {
      const wall = h.dataset.walls[0]!;
      const secondWall = SECOND_WALL;
      const cast = WALLED_CAST;
      const id = await walledDealConfirmed('Seawall');
      expect(await wallsOf('opportunity', id)).toEqual([wall.id, secondWall].sort());
      const closed = await advance(cast.ops, id, {}, 'req-pc-walled-close');
      expect(closed.stage).toBe('Closed');
      const investmentId = closed.investmentId!;

      // The position carries both walls, written with the conversion: the one the person who
      // closed the deal belongs to and the one they do not.
      expect(await wallsOf('investment', investmentId)).toEqual([wall.id, secondWall].sort());
      expect((await audits('investment.create', 'req-pc-walled-close'))[0]!.details).toMatchObject({
        wallsCarried: 2,
      });

      // Nobody outside the walls can tell the position exists; a member of either wall reads it.
      for (const who of ['viewer.one', 'deal.one', 'ops.one', 'audit.one', 'ir.one']) {
        await get(who, `/api/v1/investments/${investmentId}`).expect(404);
        await get(who, `/api/v1/opportunities/${id}`).expect(404);
      }
      for (const who of ['deal.three', 'head.one', 'ops.two', 'deal.two'])
        expect(
          investmentDetail.parse(
            (await get(who, `/api/v1/investments/${investmentId}`).expect(200)).body,
          ).opportunityId,
        ).toBe(id);
    });

    it('carries no wall for a deal that has none', async () => {
      const id = (await create('Open Water')).id;
      await toConfirmed(id);
      const closed = await advance(CAST.ops, id, {}, 'req-pc-open-close');
      expect(
        await h.runtime.db.query(
          "select 1 from core.walled_record where entity = 'investment' and entity_id = $1",
          [closed.investmentId],
        ),
      ).toHaveLength(0);
      expect((await audits('investment.create', 'req-pc-open-close'))[0]!.details).toMatchObject({
        wallsCarried: 0,
      });
      await get('viewer.one', `/api/v1/investments/${closed.investmentId}`).expect(200);
    });
  });
});
