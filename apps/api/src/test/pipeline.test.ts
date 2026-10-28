import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daysBetween } from '@pb/calc';
import {
  documentPage,
  investmentDetail,
  opportunityDetail,
  opportunityPage,
  problemDetails,
} from '@pb/contracts';
import type { OpportunityDetail, OpportunityRow } from '@pb/contracts';
import { dealStageMachine, forbiddenPairs } from '@pb/workflows';
import type { Response } from 'supertest';
import { loadDiligenceTemplates } from '../composition.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const CONFIG_DIR = new URL('../../../../config/', import.meta.url).pathname;
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
const CO_INVEST = 'deal_type.co_invest_equity';

describe('pipeline (M5 skeleton, docs/18 section 4): opportunities, their stage commands and gates', () => {
  let h: Harness;
  /** A document in the hub every role can see, indexed from the synthetic inbox. */
  let hubDocumentId: string;

  beforeAll(async () => {
    h = await startHarness();
    await h
      .http()
      .post('/api/v1/documents/index')
      .set('authorization', h.as('ops.one'))
      .set('x-request-id', 'req-pl-index')
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

  const get = (who: string, path: string, requestId = 'req-pl-get') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const post = (who: string, path: string, body: object, requestId = 'req-pl-post') =>
    h.http().post(path).set('authorization', h.as(who)).set('x-request-id', requestId).send(body);
  const list = async (who: string, query = '') =>
    opportunityPage.parse((await get(who, `/api/v1/opportunities${query}`).expect(200)).body);
  const detail = async (who: string, id: string, requestId = 'req-pl-detail') =>
    opportunityDetail.parse(
      (await get(who, `/api/v1/opportunities/${id}`, requestId).expect(200)).body,
    );
  const command = (who: string, id: string, body: object, requestId = 'req-pl-command') =>
    post(who, `/api/v1/opportunities/${id}/commands`, body, requestId);
  const commandOk = async (who: string, id: string, body: object, requestId = 'req-pl-command') =>
    opportunityDetail.parse((await command(who, id, body, requestId).expect(200)).body);
  const taskCommand = (who: string, id: string, taskId: string, body: object) =>
    post(who, `/api/v1/opportunities/${id}/diligence-tasks/${taskId}/commands`, body);
  const expectProblem = (res: Response, status: number, code: string): string => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}${code}`);
    return problem.detail ?? '';
  };
  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const opps = () => h.dataset.opportunities!;
  const tagged = (tag: string, i = 0): string => h.dataset.scenarios[tag]![i]!;
  const walledOpportunityIds = (): Set<string> =>
    new Set(
      h.dataset.walls[0]!.records.filter((r) => r.entity === 'opportunity').map((r) => r.entityId),
    );
  const audits = (action: string, requestId: string) =>
    h.runtime.db.query<{ details: Record<string, unknown>; reason: string | null }>(
      'select details, reason from audit.event where action = $1 and request_id = $2 order by id',
      [action, requestId],
    );

  describe('reads', () => {
    it('lists what the caller can see, newest received first, with days in stage from the latest stage move', async () => {
      await h.http().get('/api/v1/opportunities').expect(401);
      const walled = walledOpportunityIds();
      expect(walled.size).toBe(2);
      const page = await list('viewer.one', '?limit=200');
      expect(page.nextCursor).toBeNull();
      expect(page.items.length).toBe(opps().length - walled.size);
      expect(page.items.some((o) => walled.has(o.id))).toBe(false);
      for (let i = 1; i < page.items.length; i++)
        expect(page.items[i - 1]!.receivedDate >= page.items[i]!.receivedDate).toBe(true);
      // The wall member sees every deal.
      expect((await list('deal.three', '?limit=200')).items.length).toBe(opps().length);

      // Days in stage: from the latest stage history row to today (the dataset's as-of date).
      const sourced = page.items.find((o) => o.id === tagged('sourced_deal'))!;
      const entered = h.dataset
        .opportunityStageHistory!.filter((r) => r.opportunityId === sourced.id)
        .map((r) => r.changedAt)
        .sort()
        .at(-1)!
        .slice(0, 10);
      expect(sourced.daysInStage).toBe(daysBetween(entered, h.dataset.asOf));
      expect(sourced.stage).toBe('Sourced');
      expect(sourced.owner).toEqual({
        id: user('deal.one').id,
        name: user('deal.one').displayName,
      });
      expect(sourced.sponsor.name.length).toBeGreaterThan(0);

      // Filters and paging.
      const passed = await list('viewer.one', '?stage=Passed');
      expect(passed.items.length).toBe(2);
      expect(passed.items.every((o) => o.stage === 'Passed' && o.passReasonCode !== null)).toBe(
        true,
      );
      const mine = await list('viewer.one', `?ownerId=${user('deal.two').id}&limit=200`);
      expect(mine.items.length).toBeGreaterThan(0);
      expect(mine.items.every((o) => o.owner?.id === user('deal.two').id)).toBe(true);
      await get('viewer.one', '/api/v1/opportunities?stage=Nope').expect(400);
      await get('viewer.one', '/api/v1/opportunities?cursor=bm9wZQ').expect(400);
      const seen: OpportunityRow[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const after: string = cursor === null ? '' : `&cursor=${cursor}`;
        const part = await list('viewer.one', `?limit=7${after}`);
        seen.push(...part.items);
        cursor = part.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 50);
      expect(seen.map((o) => o.id)).toEqual(page.items.map((o) => o.id));
      expect(pages).toBe(Math.ceil(page.items.length / 7));
    });

    it('shows the detail with its history, tasks, decisions, allocations, closing summary and gates', async () => {
      const closing = await detail('viewer.one', tagged('closing_open'), 'req-pl-detail-1');
      expect(closing.stage).toBe('Closing');
      expect(closing.stageHistory.map((s) => s.toStage)).toEqual([
        'Sourced',
        'Screening',
        'Prescreen',
        'Diligence',
        'IC',
        'Approved',
        'Closing',
      ]);
      expect(closing.stageHistory[0]).toMatchObject({
        fromStage: null,
        toStage: 'Sourced',
        command: 'create',
      });
      expect(closing.diligenceTasks.length).toBe(6);
      expect(closing.diligenceTasks.filter((t) => t.status === 'waived').length).toBe(1);
      expect(closing.icDecisions.length).toBe(1);
      expect(closing.icDecisions[0]!.decision).toBe('approved');
      expect(closing.allocations.length).toBeGreaterThan(0);
      expect(closing.closing).not.toBeNull();
      expect(closing.closing!.state).toBe('Open');
      expect(closing.closing!.itemsRequiredOpen).toBe(1);
      expect(closing.closing!.itemsOpen).toBe(3);
      expect(closing.closing!.allocationTieOut.tiedOut).toBe(true);
      expect(closing.closing!.allocationTieOut.difference).toBe('0.00');
      expect(closing.gates).toEqual({
        diligence: { requiredOpen: 0, ok: true },
        icDecision: { ok: true },
        closing: { checklistComplete: false, allocationTiedOut: true, ok: false },
      });
      expect(
        await h.runtime.db.query(
          "select 1 from audit.event where action = 'opportunity.read' and request_id = 'req-pl-detail-1'",
        ),
      ).toHaveLength(1);

      const ic = await detail('viewer.one', tagged('ic_pending'));
      expect(ic.gates.diligence.ok).toBe(true);
      expect(ic.gates.icDecision.ok).toBe(false);
      expect(ic.closing).toBeNull();

      const sourced = await detail('viewer.one', tagged('sourced_deal'));
      expect(sourced.diligenceTasks.every((t) => t.status === 'open')).toBe(true);
      expect(sourced.gates.diligence).toEqual({ requiredOpen: 4, ok: false });

      await get('viewer.one', `/api/v1/opportunities/${NO_SUCH_ID}`).expect(404);
      await get('viewer.one', '/api/v1/opportunities/not-a-uuid').expect(404);
    });

    it('hides a walled opportunity from a non-member (404 on the detail and the commands) and shows it to a wall member', async () => {
      const walled = tagged('walled_opportunity');
      await get('viewer.one', `/api/v1/opportunities/${walled}`).expect(404);
      await get('deal.one', `/api/v1/opportunities/${walled}`).expect(404);
      await command('deal.one', walled, { command: 'advance' }).expect(404);
      await post('deal.one', `/api/v1/opportunities/${walled}/diligence-tasks`, {
        workstream: 'diligence_workstream.tax',
        title: 'Tax memo',
        requiredForIc: false,
      }).expect(404);
      const member = await detail('deal.three', walled);
      expect(member.stage).toBe('Diligence');
      expect((await detail('head.one', walled)).id).toBe(walled);
    });
  });

  describe('journey 6 (docs/12): Sourced to Closed through the gates', () => {
    it('moves a deal from Sourced to Closed and converts it into a position with the data captured once', async () => {
      const fund = h.dataset.sponsorFunds.find((f) => f.strategy !== 'strategy.credit')!;
      const sponsor = h.dataset.sponsors.find((s) => s.id === fund.sponsorId)!;
      const sample = opps().find((o) => o.sector !== null && o.geography !== null)!;
      const body = {
        name: 'Project Lantern',
        companyName: 'Lantern Logistics Co',
        sponsorId: sponsor.id,
        sponsorFundId: fund.id,
        dealType: CO_INVEST,
        sector: sample.sector!,
        geography: sample.geography!,
        receivedDate: h.dataset.asOf,
        targetCommitment: '15000000.00',
        source: 'Sponsor introduction',
      };
      // Only the deal team creates; references are checked before anything is written.
      await post('viewer.one', '/api/v1/opportunities', body).expect(403);
      await post('ops.one', '/api/v1/opportunities', body).expect(403);
      expect(
        problemDetails.parse(
          (
            await post('deal.one', '/api/v1/opportunities', {
              ...body,
              sponsorId: NO_SUCH_ID,
            }).expect(400)
          ).body,
        ).errors,
      ).toEqual([{ path: 'sponsorId', message: 'Unknown sponsor' }]);
      const otherFund = h.dataset.sponsorFunds.find((f) => f.sponsorId !== sponsor.id)!;
      await post('deal.one', '/api/v1/opportunities', {
        ...body,
        sponsorFundId: otherFund.id,
      }).expect(400);
      await post('deal.one', '/api/v1/opportunities', {
        ...body,
        dealType: 'deal_type.nope',
      }).expect(400);
      await post('deal.one', '/api/v1/opportunities', {
        ...body,
        targetCommitment: '15000000.005',
      }).expect(400);

      const created = opportunityDetail.parse(
        (await post('deal.one', '/api/v1/opportunities', body, 'req-j6-create').expect(201)).body,
      );
      const id = created.id;
      expect(created.stage).toBe('Sourced');
      expect(created.owner).toEqual({
        id: user('deal.one').id,
        name: user('deal.one').displayName,
      });
      expect(created.sponsor).toEqual({ id: sponsor.id, name: sponsor.name });
      expect(created.sponsorFund).toEqual({ id: fund.id, name: fund.name });
      expect(created.stageHistory).toHaveLength(1);
      expect(created.stageHistory[0]).toMatchObject({
        fromStage: null,
        toStage: 'Sourced',
        command: 'create',
        changedBy: { id: user('deal.one').id },
      });
      expect(created.diligenceTasks).toEqual([]);
      expect(created.closing).toBeNull();
      expect(created.daysInStage).toBe(0);
      expect(await audits('opportunity.create', 'req-j6-create')).toHaveLength(1);

      // Sourced > Screening: a stale If-Match is 412, the current row version passes.
      expectProblem(
        await command('deal.one', id, { command: 'advance' }).set('if-match', '"99"'),
        412,
        'stale-row-version',
      );
      expect((await detail('deal.one', id)).stage).toBe('Sourced');
      const screening = opportunityDetail.parse(
        (
          await command('deal.one', id, { command: 'advance' }, 'req-j6-screening')
            .set('if-match', `"${created.rowVersion}"`)
            .expect(200)
        ).body,
      );
      expect(screening.stage).toBe('Screening');
      expect(screening.rowVersion).toBe(created.rowVersion + 1);
      expect((await audits('opportunity.advance', 'req-j6-screening'))[0]!.details).toMatchObject({
        stage: { before: 'Sourced', after: 'Screening' },
      });

      // Screening > Prescreen > Diligence: the template of the deal type creates the tasks once.
      expect((await commandOk('deal.one', id, { command: 'advance' })).stage).toBe('Prescreen');
      expectProblem(await command('ops.one', id, { command: 'advance' }), 403, 'forbidden');
      const diligence = await commandOk('deal.one', id, { command: 'advance' }, 'req-j6-diligence');
      expect(diligence.stage).toBe('Diligence');
      const template = loadDiligenceTemplates(CONFIG_DIR).templates[CO_INVEST]!;
      const byWorkstream = (
        tasks: { workstream: string; title: string; requiredForIc: boolean }[],
      ) => tasks.map((t) => `${t.workstream}|${t.title}|${String(t.requiredForIc)}`).sort();
      expect(byWorkstream(diligence.diligenceTasks)).toEqual(byWorkstream(template));
      // Tasks read in the taxonomy's workstream order: commercial first, sponsor last.
      expect(diligence.diligenceTasks[0]!.workstream).toBe('diligence_workstream.commercial');
      expect(diligence.diligenceTasks.at(-1)!.workstream).toBe('diligence_workstream.sponsor');
      expect(diligence.diligenceTasks.every((t) => t.status === 'open')).toBe(true);
      expect(diligence.diligenceTasks.every((t) => t.owner?.id === user('deal.one').id)).toBe(true);
      expect(
        (await audits('diligence_task.create_from_template', 'req-j6-diligence'))[0]!.details,
      ).toMatchObject({ count: template.length, dealType: CO_INVEST });
      expect(diligence.gates.diligence).toEqual({
        requiredOpen: template.filter((t) => t.requiredForIc).length,
        ok: false,
      });

      // The IC gate holds server side while a required task is open (M7 AC).
      expect(
        expectProblem(
          await command('deal.one', id, { command: 'advance' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/required diligence tasks are open/);
      const required = diligence.diligenceTasks.filter((t) => t.requiredForIc);
      const optional = diligence.diligenceTasks.find((t) => !t.requiredForIc)!;
      expectProblem(
        await taskCommand('deal.one', id, required[0]!.id, {
          command: 'complete',
          evidenceDocumentId: NO_SUCH_ID,
        }),
        422,
        'workflow-precondition',
      );
      await taskCommand('viewer.one', id, required[0]!.id, { command: 'complete' }).expect(403);
      await taskCommand('deal.one', id, NO_SUCH_ID, { command: 'complete' }).expect(404);
      const withEvidence = opportunityDetail.parse(
        (
          await post(
            'deal.one',
            `/api/v1/opportunities/${id}/diligence-tasks/${required[0]!.id}/commands`,
            { command: 'complete', evidenceDocumentId: hubDocumentId },
            'req-j6-task-complete',
          ).expect(200)
        ).body,
      );
      expect(withEvidence.diligenceTasks.find((t) => t.id === required[0]!.id)).toMatchObject({
        status: 'done',
        evidenceDocumentId: hubDocumentId,
      });
      expect(
        (await audits('diligence_task.complete', 'req-j6-task-complete'))[0]!.details,
      ).toMatchObject({ status: { before: 'open', after: 'done' } });
      expectProblem(
        await taskCommand('deal.one', id, required[0]!.id, { command: 'complete' }),
        409,
        'workflow-transition',
      );
      for (const task of required.slice(1))
        await taskCommand('deal.one', id, task.id, { command: 'complete' }).expect(200);
      await taskCommand('head.one', id, optional.id, { command: 'waive' }).expect(400);
      const waived = opportunityDetail.parse(
        (
          await taskCommand('head.one', id, optional.id, {
            command: 'waive',
            reason: 'covered by the sponsor review shared in diligence',
          }).expect(200)
        ).body,
      );
      expect(waived.diligenceTasks.find((t) => t.id === optional.id)).toMatchObject({
        status: 'waived',
        waivedReason: 'covered by the sponsor review shared in diligence',
      });
      const reopened = opportunityDetail.parse(
        (await taskCommand('deal.one', id, optional.id, { command: 'reopen' }).expect(200)).body,
      );
      expect(reopened.diligenceTasks.find((t) => t.id === optional.id)).toMatchObject({
        status: 'open',
        waivedReason: null,
      });
      expect(reopened.gates.diligence).toEqual({ requiredOpen: 0, ok: true });

      // Diligence > IC, then the decision gate (approver only).
      const ic = await commandOk('deal.one', id, { command: 'advance' });
      expect(ic.stage).toBe('IC');
      expectProblem(await command('deal.one', id, { command: 'advance' }), 403, 'forbidden');
      expect(
        expectProblem(
          await command('head.one', id, { command: 'advance' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/IC decision record is required/);
      const decision = {
        decisionDate: h.dataset.asOf,
        decision: 'approved',
        amount: '15000000.00',
        conditions: ['Confirmatory legal review complete before signing'],
      };
      await post('deal.one', `/api/v1/opportunities/${id}/ic-decisions`, decision).expect(403);
      await post('head.one', `/api/v1/opportunities/${id}/ic-decisions`, {
        ...decision,
        amount: '1.005',
      }).expect(400);
      const decided = opportunityDetail.parse(
        (
          await post(
            'head.one',
            `/api/v1/opportunities/${id}/ic-decisions`,
            decision,
            'req-j6-ic',
          ).expect(201)
        ).body,
      );
      expect(decided.icDecisions).toHaveLength(1);
      expect(decided.icDecisions[0]).toMatchObject({
        decision: 'approved',
        amount: '15000000.00',
        conditions: decision.conditions,
        recordedBy: { id: user('head.one').id },
      });
      expect(decided.gates.icDecision.ok).toBe(true);
      expectProblem(
        await post('head.one', `/api/v1/opportunities/${id}/ic-decisions`, decision),
        409,
        'conflict',
      );
      expect(await audits('ic_decision.record', 'req-j6-ic')).toHaveLength(1);
      const approved = await commandOk('head.one', id, { command: 'advance' });
      expect(approved.stage).toBe('Approved');

      // Approved > Closing needs the close date and the commitment together; it opens the closing.
      expect(
        expectProblem(
          await command('deal.one', id, { command: 'advance' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/close date and commitment/);
      await command('deal.one', id, { command: 'advance', closeDate: h.dataset.asOf }).expect(400);
      await command('deal.one', id, {
        command: 'advance',
        closeDate: h.dataset.asOf,
        commitmentAmount: '15000000.005',
      }).expect(400);
      const closeDate = h.dataset.asOf;
      const closingStage = await commandOk(
        'deal.one',
        id,
        { command: 'advance', closeDate, commitmentAmount: '15000000.00' },
        'req-j6-closing',
      );
      expect(closingStage.stage).toBe('Closing');
      const closing = closingStage.closing!;
      expect(closing).toMatchObject({
        closeDate,
        commitmentAmount: '15000000.00',
        currency: 'USD',
        state: 'Open',
        opsConfirmedBy: null,
        itemsOpen: 7,
        itemsRequiredOpen: 5,
      });
      expect(closing.allocationTieOut).toEqual({
        commitment: '15000000.00',
        allocated: '0.00',
        difference: '-15000000.00',
        tiedOut: false,
      });
      expect((await audits('closing.open', 'req-j6-closing'))[0]!.details).toMatchObject({
        opportunityId: id,
        closeDate,
        items: [
          'signed_documents',
          'cap_table',
          'funds_flow',
          'wire_confirmation',
          'consents',
          'side_letter',
          'closing_memo',
        ],
      });
      const closingPath = `/api/v1/closings/${closing.id}`;
      const closingDetail = (await get('viewer.one', closingPath).expect(200)).body as {
        items: { itemCode: string; required: boolean; status: string }[];
      };
      expect(closingDetail.items.map((i) => i.itemCode)).toEqual([
        'signed_documents',
        'cap_table',
        'funds_flow',
        'wire_confirmation',
        'consents',
        'side_letter',
        'closing_memo',
      ]);

      // M8 AC: the closing cannot complete with a required document missing.
      expect(
        expectProblem(
          await post('ops.one', `${closingPath}/commands`, { command: 'confirm' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/required closing document is missing/);
      for (const code of ['signed_documents', 'cap_table', 'funds_flow', 'consents'])
        await post('deal.one', `${closingPath}/items/${code}/commands`, {
          command: 'waive',
          reason: `${code} held by outside counsel and recorded in the closing memo`,
        }).expect(200);
      await post('ops.one', `${closingPath}/items/wire_confirmation/commands`, {
        command: 'receive',
        documentId: hubDocumentId,
      }).expect(200);
      // Closing > Closed is refused while the closing is not confirmed, and operations only.
      expectProblem(await command('deal.one', id, { command: 'advance' }), 403, 'forbidden');
      expect(
        expectProblem(
          await command('ops.one', id, { command: 'advance' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/allocations do not tie/);

      // M22 AC: the allocations must equal the closing commitment or the closing cannot complete.
      expect(
        expectProblem(
          await post('ops.one', `${closingPath}/commands`, { command: 'confirm' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/allocations do not tie/);
      const [vehicleA, vehicleB] = h.dataset.vehicles;
      const allocations = {
        allocations: [
          { vehicleId: vehicleA!.id, requested: '10000000.00', received: '10000000.00' },
          { vehicleId: vehicleB!.id, requested: '5000000.00' },
        ],
      };
      await h
        .http()
        .put(`/api/v1/opportunities/${id}/allocations`)
        .set('authorization', h.as('viewer.one'))
        .send(allocations)
        .expect(403);
      const allocated = opportunityDetail.parse(
        (
          await h
            .http()
            .put(`/api/v1/opportunities/${id}/allocations`)
            .set('authorization', h.as('deal.one'))
            .set('x-request-id', 'req-j6-allocations')
            .send(allocations)
            .expect(200)
        ).body,
      );
      // Lines come back by vehicle name; compare them by vehicle id.
      const byVehicle = (lines: (string | null)[][]) =>
        [...lines].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
      expect(
        byVehicle(allocated.allocations.map((a) => [a.vehicle.id, a.requested, a.received])),
      ).toEqual(
        byVehicle([
          [vehicleA!.id, '10000000.00', '10000000.00'],
          [vehicleB!.id, '5000000.00', null],
        ]),
      );
      expect(allocated.closing!.allocationTieOut).toEqual({
        commitment: '15000000.00',
        allocated: '15000000.00',
        difference: '0.00',
        tiedOut: true,
      });
      expect(
        (await audits('opportunity.allocations.replace', 'req-j6-allocations'))[0]!.details,
      ).toEqual({
        before: { lines: 0, requested: '0.00', received: null },
        after: { lines: 2, requested: '15000000.00', received: '10000000.00' },
      });
      expect(allocated.gates.closing).toEqual({
        checklistComplete: true,
        allocationTiedOut: true,
        ok: false,
      });
      const confirmed = (
        await post('ops.one', `${closingPath}/commands`, { command: 'confirm' }).expect(200)
      ).body as { state: string };
      expect(confirmed.state).toBe('OpsConfirmed');
      expect((await detail('deal.one', id)).gates.closing.ok).toBe(true);

      // Closing > Closed converts the deal into a position: nothing is re-entered.
      const closed = await commandOk('ops.one', id, { command: 'advance' }, 'req-j6-closed');
      expect(closed.stage).toBe('Closed');
      expect(closed.investmentId).not.toBeNull();
      expect(closed.stageHistory.at(-1)).toMatchObject({
        fromStage: 'Closing',
        toStage: 'Closed',
        command: 'advance',
        changedBy: { id: user('ops.one').id },
      });
      const [closedAudit] = await audits('opportunity.advance', 'req-j6-closed');
      const createdIds = closedAudit!.details.created as {
        investmentId: string;
        investmentNumber: string;
        portfolioCompanyCreated: boolean;
        vehicleId: string;
      };
      expect(createdIds.investmentId).toBe(closed.investmentId);
      expect(createdIds.portfolioCompanyCreated).toBe(true);
      expect(createdIds.vehicleId).toBe(vehicleA!.id);
      const highestSeeded = Math.max(
        ...h.dataset.investments.map((i) => Number(i.investmentNumber.slice(4))),
      );
      expect(createdIds.investmentNumber).toBe(`INV-${String(highestSeeded + 1).padStart(4, '0')}`);
      expect(await audits('investment.create', 'req-j6-closed')).toHaveLength(1);

      const closingAfter = (await get('viewer.one', closingPath).expect(200)).body as {
        id: string;
        investmentId: string | null;
        state: string;
      };
      const position = investmentDetail.parse(
        (await get('viewer.one', `/api/v1/investments/${closed.investmentId}`).expect(200)).body,
      );
      expect(position).toMatchObject({
        investmentNumber: createdIds.investmentNumber,
        companyName: body.companyName,
        sponsorId: sponsor.id,
        sponsorName: sponsor.name,
        sponsorFundId: fund.id,
        sponsorFundName: fund.name,
        vehicleId: vehicleA!.id,
        dealType: CO_INVEST,
        sector: body.sector,
        geography: body.geography,
        entryDate: closeDate,
        closeDate,
        opportunityId: id,
        closingId: closingAfter.id,
        isActive: true,
        exitDate: null,
      });
      const company = await h.runtime.db.query<{ name: string; sector: string | null }>(
        'select name, sector from core.portfolio_company where id = $1',
        [position.companyId],
      );
      expect(company).toEqual([{ name: body.companyName, sector: body.sector }]);
      expect(closingAfter.investmentId).toBe(closed.investmentId);
      expect(
        await h.runtime.db.query<{ n: number }>(
          'select count(*)::int as n from deal.allocation where investment_id = $1 and opportunity_id = $2',
          [closed.investmentId, id],
        ),
      ).toEqual([{ n: 2 }]);
      // Closed is terminal, and the allocations are now the position's.
      expectProblem(
        await command('ops.one', id, { command: 'advance' }),
        409,
        'workflow-transition',
      );
      expectProblem(
        await h
          .http()
          .put(`/api/v1/opportunities/${id}/allocations`)
          .set('authorization', h.as('ops.one'))
          .send(allocations),
        422,
        'workflow-precondition',
      );
    });
  });

  describe('pass and reopen', () => {
    it('refuses a pass without a reason code (400) and records the code and note with one; reopen returns the deal to Screening', async () => {
      const sourced = opps().find((o) => o.stage === 'Sourced' && o.id !== tagged('sourced_deal'))!;
      expectProblem(await command('deal.one', sourced.id, { command: 'pass' }), 400, 'validation');
      expectProblem(
        await command('deal.one', sourced.id, {
          command: 'pass',
          passReasonCode: 'pass_reason.nope',
        }),
        400,
        'validation',
      );
      expectProblem(
        await command('ops.one', sourced.id, {
          command: 'pass',
          passReasonCode: 'pass_reason.sector',
        }),
        403,
        'forbidden',
      );
      const passed = await commandOk(
        'deal.one',
        sourced.id,
        { command: 'pass', passReasonCode: 'pass_reason.sector', note: 'Outside the sector focus' },
        'req-pl-pass',
      );
      expect(passed.stage).toBe('Passed');
      expect(passed.passReasonCode).toBe('pass_reason.sector');
      expect(passed.passNote).toBe('Outside the sector focus');
      expect(passed.stageHistory.at(-1)).toMatchObject({
        fromStage: 'Sourced',
        toStage: 'Passed',
        command: 'pass',
        reason: 'Outside the sector focus',
      });
      const [passAudit] = await audits('opportunity.pass', 'req-pl-pass');
      expect(passAudit!.details).toMatchObject({
        stage: { before: 'Sourced', after: 'Passed' },
        passReasonCode: { before: null, after: 'pass_reason.sector' },
      });
      expect(passAudit!.reason).toBe('Outside the sector focus');

      await command('deal.one', sourced.id, { command: 'reopen' }).expect(400);
      const reopened = await commandOk(
        'deal.one',
        sourced.id,
        { command: 'reopen', reason: 'the sponsor came back with a lower price' },
        'req-pl-reopen',
      );
      expect(reopened.stage).toBe('Screening');
      expect(reopened.passReasonCode).toBeNull();
      expect(reopened.passNote).toBeNull();
      expect((await audits('opportunity.reopen', 'req-pl-reopen'))[0]!.reason).toBe(
        'the sponsor came back with a lower price',
      );
      expectProblem(
        await command('deal.one', sourced.id, { command: 'reopen', reason: 'again' }),
        409,
        'workflow-transition',
      );
    });
  });

  describe('refusals', () => {
    it('answers 409 for every forbidden pair of the deal stage machine, changing nothing', async () => {
      const pairs = forbiddenPairs(dealStageMachine);
      expect(pairs.length).toBeGreaterThan(0);
      const everything = (await list('deal.three', '?limit=200')).items;
      const walled = walledOpportunityIds();
      const bodyFor = (command: string): object =>
        command === 'pass'
          ? { command, passReasonCode: 'pass_reason.other' }
          : command === 'reopen'
            ? { command, reason: 'reopened for the forbidden pair test' }
            : { command };
      for (const pair of pairs) {
        const target = everything.find((o) => o.stage === pair.from && !walled.has(o.id));
        expect(target, `an opportunity at ${pair.from}`).toBeDefined();
        const res = await command('deal.one', target!.id, bodyFor(pair.command));
        expect(res.status, `${pair.from} ${pair.command}`).toBe(409);
        expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}workflow-transition`);
        expect((await detail('deal.three', target!.id)).stage).toBe(pair.from);
      }
    });

    it('records an IC decision only at IC, by an approver, once per date', async () => {
      const decision = { decisionDate: h.dataset.asOf, decision: 'deferred', conditions: [] };
      await post(
        'deal.one',
        `/api/v1/opportunities/${tagged('ic_pending')}/ic-decisions`,
        decision,
      ).expect(403);
      expectProblem(
        await post(
          'head.one',
          `/api/v1/opportunities/${tagged('sourced_deal')}/ic-decisions`,
          decision,
        ),
        422,
        'workflow-precondition',
      );
      const deferred = opportunityDetail.parse(
        (
          await post(
            'head.one',
            `/api/v1/opportunities/${tagged('ic_pending')}/ic-decisions`,
            decision,
          ).expect(201)
        ).body,
      );
      expect(deferred.icDecisions[0]!.decision).toBe('deferred');
      expect(deferred.gates.icDecision.ok).toBe(false);
      expectProblem(
        await command('head.one', tagged('ic_pending'), { command: 'advance' }),
        422,
        'workflow-precondition',
      );
      expectProblem(
        await post(
          'head.one',
          `/api/v1/opportunities/${tagged('ic_pending')}/ic-decisions`,
          decision,
        ),
        409,
        'conflict',
      );
    });

    it('checks the allocation list before writing: distinct lines, known vehicles and clients, two decimals', async () => {
      const id = tagged('ic_pending');
      const vehicle = h.dataset.vehicles[0]!;
      const put = (body: object) =>
        h
          .http()
          .put(`/api/v1/opportunities/${id}/allocations`)
          .set('authorization', h.as('deal.one'))
          .send(body);
      expect(
        problemDetails.parse(
          (
            await put({
              allocations: [
                { vehicleId: vehicle.id, requested: '1.00' },
                { vehicleId: vehicle.id, requested: '2.00' },
              ],
            }).expect(400)
          ).body,
        ).errors?.[0]?.path,
      ).toBe('allocations.1');
      expect(
        problemDetails.parse(
          (await put({ allocations: [{ vehicleId: NO_SUCH_ID, requested: '1.00' }] }).expect(400))
            .body,
        ).errors,
      ).toEqual([{ path: 'allocations.0.vehicleId', message: 'Unknown vehicle' }]);
      expect(
        problemDetails.parse(
          (
            await put({
              allocations: [{ vehicleId: vehicle.id, clientId: NO_SUCH_ID, requested: '1.00' }],
            }).expect(400)
          ).body,
        ).errors,
      ).toEqual([{ path: 'allocations.0.clientId', message: 'Unknown client' }]);
      await put({ allocations: [{ vehicleId: vehicle.id, requested: '1.005' }] }).expect(400);
      await put({ allocations: [{ vehicleId: vehicle.id, requested: '-1.00' }] }).expect(400);
      // A deal team member may name a client they cannot read: the line is kept and the id travels.
      const client = h.dataset.clients[0]!;
      const withClient = opportunityDetail.parse(
        (
          await put({
            allocations: [{ vehicleId: vehicle.id, clientId: client.id, requested: '1.00' }],
          }).expect(200)
        ).body,
      );
      expect(withClient.allocations).toHaveLength(1);
      expect(withClient.allocations[0]!.client?.id).toBe(client.id);
      expect(
        opportunityDetail.parse((await put({ allocations: [] }).expect(200)).body).allocations,
      ).toEqual([]);
    });

    it('adds a task beside the template ones for the deal team only, with a known workstream and owner', async () => {
      const id = tagged('sourced_deal');
      const path = `/api/v1/opportunities/${id}/diligence-tasks`;
      const body = {
        workstream: 'diligence_workstream.references',
        title: 'Customer reference calls',
        ownerId: user('deal.two').id,
        dueDate: h.dataset.asOf,
        requiredForIc: true,
      };
      await post('ops.one', path, body).expect(403);
      await post('deal.one', path, { ...body, workstream: 'diligence_workstream.nope' }).expect(
        400,
      );
      await post('deal.one', path, { ...body, ownerId: NO_SUCH_ID }).expect(400);
      const before = (await detail('deal.one', id)).gates.diligence.requiredOpen;
      const added = opportunityDetail.parse((await post('deal.one', path, body).expect(201)).body);
      expect(added.diligenceTasks.find((t) => t.title === body.title)).toMatchObject({
        workstream: body.workstream,
        title: body.title,
        owner: { id: user('deal.two').id },
        dueDate: h.dataset.asOf,
        status: 'open',
        requiredForIc: true,
      });
      expect(added.gates.diligence.requiredOpen).toBe(before + 1);
    });
  });

  describe('config/diligence_templates.json (rule 9)', () => {
    it('names a template per deal type with taxonomy codes, and refuses a malformed file by path', async () => {
      const templates = loadDiligenceTemplates(CONFIG_DIR);
      const terms = await h.runtime.db.query<{ domain: string; code: string }>(
        "select domain, code from core.taxonomy_term where domain in ('deal_type', 'diligence_workstream') and active",
      );
      const codes = new Set(terms.map((t) => t.code));
      for (const [dealType, tasks] of Object.entries(templates.templates)) {
        expect(codes.has(dealType), dealType).toBe(true);
        expect(
          tasks.some((t) => t.requiredForIc),
          dealType,
        ).toBe(true);
        for (const t of tasks) expect(codes.has(t.workstream), t.workstream).toBe(true);
      }
      for (const t of templates.default) expect(codes.has(t.workstream), t.workstream).toBe(true);
      expect(Object.keys(templates.templates)).toContain('deal_type.private_credit');

      const dir = mkdtempSync(join(tmpdir(), 'pb-config-'));
      expect(() => loadDiligenceTemplates(dir)).toThrow(/missing: diligence_templates.json/);
      const marker = 'MARKER-NEVER-ECHOED-0013';
      writeFileSync(
        join(dir, 'diligence_templates.json'),
        JSON.stringify({
          templates: {
            [CO_INVEST]: [{ workstream: `tax.${marker}`, title: 'x', requiredForIc: true }],
          },
          default: [],
        }),
      );
      let message = '';
      try {
        loadDiligenceTemplates(dir);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('not valid (diligence_templates.json)');
      expect(message).toContain('default');
      expect(message).not.toContain(marker);
    });
  });

  it('keeps every response inside the contract', async () => {
    const page = await list('deal.three', '?limit=200');
    for (const row of page.items.slice(0, 5)) {
      const d: OpportunityDetail = await detail('deal.three', row.id);
      expect(d.id).toBe(row.id);
    }
  });
});
