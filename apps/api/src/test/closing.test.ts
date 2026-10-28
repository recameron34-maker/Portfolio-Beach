import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@pb/calc';
import {
  closingDetail,
  documentPage,
  investmentDetail,
  opportunityDetail,
  problemDetails,
} from '@pb/contracts';
import type { ClosingDetail } from '@pb/contracts';
import { closingMachine, forbiddenPairs } from '@pb/workflows';
import type { Response } from 'supertest';
import { loadClosingChecklist } from '../composition.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const CONFIG_DIR = new URL('../../../../config/', import.meta.url).pathname;
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';

describe('closing (M8, M22, docs/18 section 12): the record, its checklist, the confirmation and the legal terms', () => {
  let h: Harness;
  let hubDocumentId: string;

  beforeAll(async () => {
    h = await startHarness();
    await h
      .http()
      .post('/api/v1/documents/index')
      .set('authorization', h.as('ops.one'))
      .set('x-request-id', 'req-cl-index')
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

  const get = (who: string, path: string, requestId = 'req-cl-get') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const post = (who: string, path: string, body: object, requestId = 'req-cl-post') =>
    h.http().post(path).set('authorization', h.as(who)).set('x-request-id', requestId).send(body);
  const detail = async (who: string, id: string, requestId = 'req-cl-detail') =>
    closingDetail.parse((await get(who, `/api/v1/closings/${id}`, requestId).expect(200)).body);
  const command = (who: string, id: string, body: object, requestId = 'req-cl-command') =>
    post(who, `/api/v1/closings/${id}/commands`, body, requestId);
  const commandOk = async (who: string, id: string, body: object, requestId = 'req-cl-command') =>
    closingDetail.parse((await command(who, id, body, requestId).expect(200)).body);
  const itemCommand = (
    who: string,
    id: string,
    code: string,
    body: object,
    requestId = 'req-cl-item',
  ) => post(who, `/api/v1/closings/${id}/items/${code}/commands`, body, requestId);
  const expectProblem = (res: Response, status: number, code: string): string => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}${code}`);
    return problem.detail ?? '';
  };
  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const tagged = (tag: string, i = 0): string => h.dataset.scenarios[tag]![i]!;
  const closingOf = (opportunityId: string) =>
    h.dataset.closings!.find((c) => c.opportunityId === opportunityId)!;
  const audits = (action: string, requestId: string) =>
    h.runtime.db.query<{ details: Record<string, unknown>; reason: string | null }>(
      'select details, reason from audit.event where action = $1 and request_id = $2 order by id',
      [action, requestId],
    );

  describe('reads', () => {
    it('shows the Closing deal: the checklist in config order, one required item open, allocations tying out, draft terms', async () => {
      const seeded = closingOf(tagged('closing_open'));
      await h.http().get(`/api/v1/closings/${seeded.id}`).expect(401);
      const d = await detail('viewer.one', seeded.id, 'req-cl-detail-1');
      expect(d).toMatchObject({
        id: seeded.id,
        opportunityId: tagged('closing_open'),
        investmentId: null,
        closeDate: seeded.closeDate,
        commitmentAmount: seeded.commitmentAmount,
        state: 'Open',
        opsConfirmedBy: null,
        opsConfirmedAt: null,
        itemsOpen: 3,
        itemsRequiredOpen: 1,
      });
      const checklist = loadClosingChecklist(CONFIG_DIR);
      expect(d.items.map((i) => i.itemCode)).toEqual(checklist.items.map((i) => i.code));
      expect(d.items.map((i) => i.required)).toEqual(checklist.items.map((i) => i.required));
      expect(d.items.find((i) => i.itemCode === 'wire_confirmation')).toMatchObject({
        status: 'open',
        documentId: null,
        waivedReason: null,
      });
      expect(
        d.items
          .filter((i) => i.required && i.itemCode !== 'wire_confirmation')
          .every((i) => i.status === 'waived' && i.waivedReason !== null),
      ).toBe(true);
      expect(d.allocationTieOut.tiedOut).toBe(true);
      expect(d.allocationTieOut.commitment).toBe(seeded.commitmentAmount);
      expect(d.allocations.length).toBeGreaterThan(0);
      expect(d.legalTerms).toHaveLength(2);
      expect(d.legalTerms.every((t) => t.status === 'draft' && t.confirmedBy === null)).toBe(true);
      expect(
        await h.runtime.db.query(
          "select 1 from audit.event where action = 'closing.read' and request_id = 'req-cl-detail-1'",
        ),
      ).toHaveLength(1);
      // Every read role sees it; the id must be a closing.
      for (const who of ['deal.one', 'ops.one', 'head.one', 'ir.one', 'audit.one'])
        await get(who, `/api/v1/closings/${seeded.id}`).expect(200);
      await get('viewer.one', `/api/v1/closings/${NO_SUCH_ID}`).expect(404);
      await get('viewer.one', '/api/v1/closings/nope').expect(404);
    });

    it('shows the confirmed closing of an existing position, dated at its entry date, and hides a walled one from a non-member', async () => {
      const walledInvestment = tagged('walled_deal');
      const walled = h.dataset.closings!.find((c) => c.investmentId === walledInvestment)!;
      await get('viewer.one', `/api/v1/closings/${walled.id}`).expect(404);
      await get('ops.one', `/api/v1/closings/${walled.id}`).expect(404);
      const member = await detail('deal.three', walled.id);
      expect(member.state).toBe('OpsConfirmed');
      expect(member.opsConfirmedBy?.id).toBe(user('ops.one').id);
      expect(member.investmentId).toBe(walledInvestment);
      expect(member.allocationTieOut.tiedOut).toBe(true);
      expect(member.legalTerms.every((t) => t.status === 'confirmed')).toBe(true);

      const open = h.dataset.closings!.find(
        (c) => c.investmentId !== null && c.investmentId !== walledInvestment,
      )!;
      const d = await detail('viewer.one', open.id);
      const investment = h.dataset.investments.find((i) => i.id === open.investmentId)!;
      expect(d.closeDate).toBe(investment.entryDate);
      expect(d.state).toBe('OpsConfirmed');
      expect(d.allocationTieOut.tiedOut).toBe(true);
    });

    it('serves the close date on the investment detail from the closing record alone', async () => {
      const walledInvestment = tagged('walled_deal');
      const closing = h.dataset.closings!.find(
        (c) => c.investmentId !== null && c.investmentId !== walledInvestment,
      )!;
      const before = investmentDetail.parse(
        (await get('viewer.one', `/api/v1/investments/${closing.investmentId}`).expect(200)).body,
      );
      expect(before.closeDate).toBe(closing.closeDate);
      expect(before.entryDate).toBe(closing.closeDate);
      // The workspace opens the closing by its id; a position that predates the pipeline has no
      // opportunity record, so that id is null.
      expect(before.closingId).toBe(closing.id);
      expect(before.opportunityId).toBe(closing.opportunityId);
      // Move the closing's date (as the database owner, outside the API): the detail follows the
      // closing; nothing else carries a close date.
      const moved = addDays(closing.closeDate, 3);
      await h.runtime.db.query('update deal.closing set close_date = $1 where id = $2', [
        moved,
        closing.id,
      ]);
      const after = investmentDetail.parse(
        (await get('viewer.one', `/api/v1/investments/${closing.investmentId}`).expect(200)).body,
      );
      expect(after.closeDate).toBe(moved);
      expect(after.entryDate).toBe(closing.closeDate);
      await h.runtime.db.query('update deal.closing set close_date = $1 where id = $2', [
        closing.closeDate,
        closing.id,
      ]);
    });

    it('M8 AC: no table but deal.closing carries a close_date column (information_schema)', async () => {
      const columns = await h.runtime.db.query<{ table_schema: string; table_name: string }>(
        "select table_schema, table_name from information_schema.columns where column_name = 'close_date' order by 1, 2",
      );
      expect(columns).toEqual([{ table_schema: 'deal', table_name: 'closing' }]);
    });
  });

  describe('the checklist and the confirmation (journey 6, the operations half)', () => {
    it('guards the writes by role', async () => {
      const id = closingOf(tagged('closing_open')).id;
      for (const who of ['viewer.one', 'ir.one', 'audit.one', 'admin.one']) {
        await command(who, id, { command: 'confirm' }).expect(403);
        await itemCommand(who, id, 'wire_confirmation', { command: 'reopen' }).expect(403);
        await post(who, `/api/v1/closings/${id}/legal-terms`, {
          termType: 'legal_term_type.mfn',
          value: { granted: true },
        }).expect(403);
      }
      await command('deal.one', id, { command: 'confirm' }).expect(403);
      await command('head.one', id, { command: 'confirm' }).expect(403);
    });

    it('cannot complete with a required document missing, refuses a tie-out that fails, confirms, and needs confirmation again after a close date change', async () => {
      const opportunityId = tagged('closing_open');
      const id = closingOf(opportunityId).id;
      const seeded = await detail('ops.one', id);

      // M8 AC: a required item is open.
      expect(
        expectProblem(
          await command('ops.one', id, { command: 'confirm' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/required closing document is missing/);

      // The item commands: receive needs a document the caller can see; the moves are checked.
      await itemCommand('ops.one', id, 'no_such_item', { command: 'reopen' }).expect(404);
      await itemCommand('ops.one', id, 'wire_confirmation', { command: 'receive' }).expect(400);
      expectProblem(
        await itemCommand('ops.one', id, 'wire_confirmation', {
          command: 'receive',
          documentId: NO_SUCH_ID,
        }),
        422,
        'workflow-precondition',
      );
      expectProblem(
        await itemCommand('ops.one', id, 'wire_confirmation', { command: 'reopen' }),
        409,
        'workflow-transition',
      );
      const received = closingDetail.parse(
        (
          await itemCommand(
            'ops.one',
            id,
            'wire_confirmation',
            { command: 'receive', documentId: hubDocumentId },
            'req-cl-receive',
          ).expect(200)
        ).body,
      );
      expect(received.items.find((i) => i.itemCode === 'wire_confirmation')).toMatchObject({
        status: 'received',
        documentId: hubDocumentId,
      });
      expect(received.itemsRequiredOpen).toBe(0);
      expect((await audits('closing_item.receive', 'req-cl-receive'))[0]!.details).toMatchObject({
        itemCode: 'wire_confirmation',
        status: { before: 'open', after: 'received' },
        documentId: { before: null, after: hubDocumentId },
      });
      expectProblem(
        await itemCommand('ops.one', id, 'wire_confirmation', { command: 'waive', reason: 'held' }),
        409,
        'workflow-transition',
      );
      const reopened = closingDetail.parse(
        (await itemCommand('deal.one', id, 'wire_confirmation', { command: 'reopen' }).expect(200))
          .body,
      );
      expect(reopened.items.find((i) => i.itemCode === 'wire_confirmation')).toMatchObject({
        status: 'open',
        documentId: null,
      });
      expect(reopened.itemsRequiredOpen).toBe(1);
      const waived = closingDetail.parse(
        (
          await itemCommand('deal.one', id, 'wire_confirmation', {
            command: 'waive',
            reason: 'wire confirmation held by the bank and recorded in the closing memo',
          }).expect(200)
        ).body,
      );
      expect(waived.items.find((i) => i.itemCode === 'wire_confirmation')?.status).toBe('waived');
      expect(waived.itemsRequiredOpen).toBe(0);

      // M22 AC: the allocations must equal the commitment or the closing cannot complete.
      const line = seeded.allocations[0]!;
      const put = (requested: string) =>
        h
          .http()
          .put(`/api/v1/opportunities/${opportunityId}/allocations`)
          .set('authorization', h.as('deal.one'))
          .send({ allocations: [{ vehicleId: line.vehicle.id, requested, received: requested }] });
      await put('1000000.00').expect(200);
      const short = await detail('ops.one', id);
      expect(short.allocationTieOut.tiedOut).toBe(false);
      expect(short.allocationTieOut.allocated).toBe('1000000.00');
      expect(
        expectProblem(
          await command('ops.one', id, { command: 'confirm' }),
          422,
          'workflow-precondition',
        ),
      ).toMatch(/allocations do not tie/);
      expect(
        opportunityDetail.parse((await put(seeded.commitmentAmount).expect(200)).body).closing!
          .allocationTieOut.tiedOut,
      ).toBe(true);

      // The confirmation, audited with the tie-out and the confirmer.
      const confirmed = await commandOk('ops.one', id, { command: 'confirm' }, 'req-cl-confirm');
      expect(confirmed.state).toBe('OpsConfirmed');
      expect(confirmed.opsConfirmedBy).toEqual({
        id: user('ops.one').id,
        name: user('ops.one').displayName,
      });
      expect(confirmed.opsConfirmedAt).toBe(`${h.dataset.asOf}T12:00:00.000Z`);
      expect(confirmed.rowVersion).toBe(seeded.rowVersion + 1);
      const [confirmAudit] = await audits('closing.confirm', 'req-cl-confirm');
      expect(confirmAudit!.details).toMatchObject({
        state: { before: 'Open', after: 'OpsConfirmed' },
        allocationTieOut: { tiedOut: true },
        opsConfirmedBy: { before: null, after: user('ops.one').id },
      });
      expectProblem(
        await command('ops.one', id, { command: 'confirm' }),
        409,
        'workflow-transition',
      );
      expect(
        (await get('viewer.one', `/api/v1/opportunities/${opportunityId}`).expect(200)).body,
      ).toMatchObject({
        gates: { closing: { checklistComplete: true, allocationTiedOut: true, ok: true } },
      });

      // A close date change after confirmation needs a reason, is audited with both dates and
      // returns the record to Open (docs/04 M8); a stale If-Match is refused first.
      await command('ops.one', id, { command: 'changeCloseDate', closeDate: '2026-01-15' }).expect(
        400,
      );
      expectProblem(
        await command('ops.one', id, {
          command: 'changeCloseDate',
          closeDate: '2026-01-15',
          reason: 'signing slipped a week',
        }).set('if-match', `"${seeded.rowVersion}"`),
        412,
        'stale-row-version',
      );
      const newDate = addDays(seeded.closeDate, 7);
      const reopenedClosing = closingDetail.parse(
        (
          await command(
            'ops.one',
            id,
            { command: 'changeCloseDate', closeDate: newDate, reason: 'signing slipped a week' },
            'req-cl-change-1',
          )
            .set('if-match', String(confirmed.rowVersion))
            .expect(200)
        ).body,
      );
      expect(reopenedClosing).toMatchObject({
        state: 'Open',
        closeDate: newDate,
        opsConfirmedBy: null,
        opsConfirmedAt: null,
      });
      const [changeAudit] = await audits('closing.changeCloseDate', 'req-cl-change-1');
      expect(changeAudit!.reason).toBe('signing slipped a week');
      expect(changeAudit!.details).toMatchObject({
        state: { before: 'OpsConfirmed', after: 'Open' },
        closeDate: { before: seeded.closeDate, after: newDate },
      });
      expect(
        (await get('viewer.one', `/api/v1/opportunities/${opportunityId}`).expect(200)).body,
      ).toMatchObject({ gates: { closing: { ok: false } } });

      // While Open, the same command is a plain, audited date change (no Open to Open row).
      const again = addDays(seeded.closeDate, 9);
      const moved = await commandOk(
        'ops.one',
        id,
        { command: 'changeCloseDate', closeDate: again, reason: 'funds flow agreed for the 9th' },
        'req-cl-change-2',
      );
      expect(moved.state).toBe('Open');
      expect(moved.closeDate).toBe(again);
      expect(
        (await audits('closing.changeCloseDate', 'req-cl-change-2'))[0]!.details,
      ).toMatchObject({
        state: { before: 'Open', after: 'Open' },
        closeDate: { before: newDate, after: again },
      });
      expect((await commandOk('ops.one', id, { command: 'confirm' })).state).toBe('OpsConfirmed');
    });

    it('answers 409 for the forbidden pair of the closing machine; Open plus changeCloseDate is the documented date update', async () => {
      const pairs = forbiddenPairs(closingMachine);
      expect(pairs).toEqual([
        { from: 'Open', command: 'changeCloseDate' },
        { from: 'OpsConfirmed', command: 'confirm' },
      ]);
      const confirmedClosing = h.dataset.closings!.find(
        (c) => c.state === 'OpsConfirmed' && c.investmentId !== tagged('walled_deal'),
      )!;
      expectProblem(
        await command('ops.one', confirmedClosing.id, { command: 'confirm' }),
        409,
        'workflow-transition',
      );
      expect((await detail('ops.one', confirmedClosing.id)).state).toBe('OpsConfirmed');
    });
  });

  describe('legal terms (M22)', () => {
    it('captures a term in draft with a checked type and source, confirms it once, by the deal team or operations', async () => {
      const id = closingOf(tagged('closing_open')).id;
      const path = `/api/v1/closings/${id}/legal-terms`;
      const body = {
        termType: 'legal_term_type.mfn',
        value: { granted: true, scope: 'fee terms', threshold: '0.0500' },
        sourceDocumentId: hubDocumentId,
      };
      expect(
        problemDetails.parse(
          (await post('deal.one', path, { ...body, termType: 'legal_term_type.nope' }).expect(400))
            .body,
        ).errors,
      ).toEqual([{ path: 'termType', message: 'Unknown code' }]);
      expectProblem(
        await post('deal.one', path, { ...body, sourceDocumentId: NO_SUCH_ID }),
        422,
        'workflow-precondition',
      );
      const before = (await detail('deal.one', id)).legalTerms.length;
      const created = closingDetail.parse(
        (await post('deal.one', path, body, 'req-cl-term-create').expect(201)).body,
      );
      expect(created.legalTerms).toHaveLength(before + 1);
      const term = created.legalTerms.at(-1)!;
      expect(term).toMatchObject({
        termType: body.termType,
        value: body.value,
        sourceDocumentId: hubDocumentId,
        status: 'draft',
        confirmedBy: null,
      });
      expect((await audits('legal_term.create', 'req-cl-term-create'))[0]!.details).toMatchObject({
        termType: body.termType,
        value: { before: null, after: body.value },
      });

      const termPath = `${path}/${term.id}/commands`;
      await post('viewer.one', termPath, { command: 'confirm' }).expect(403);
      await post('ops.one', `${path}/${NO_SUCH_ID}/commands`, { command: 'confirm' }).expect(404);
      await post('ops.one', termPath, { command: 'nope' }).expect(400);
      const confirmed = closingDetail.parse(
        (await post('ops.one', termPath, { command: 'confirm' }, 'req-cl-term-confirm').expect(200))
          .body,
      );
      expect(confirmed.legalTerms.find((t) => t.id === term.id)).toMatchObject({
        status: 'confirmed',
        confirmedBy: { id: user('ops.one').id, name: user('ops.one').displayName },
      });
      expect((await audits('legal_term.confirm', 'req-cl-term-confirm'))[0]!.details).toMatchObject(
        {
          status: { before: 'draft', after: 'confirmed' },
        },
      );
      expectProblem(
        await post('ops.one', termPath, { command: 'confirm' }),
        409,
        'workflow-transition',
      );
    });
  });

  describe('config/closing_checklist.json (rule 9)', () => {
    it('lists the five required documents of docs/04 M8 with distinct codes, and refuses a malformed file by path', () => {
      const checklist = loadClosingChecklist(CONFIG_DIR);
      expect(checklist.items.filter((i) => i.required).map((i) => i.code)).toEqual([
        'signed_documents',
        'cap_table',
        'funds_flow',
        'wire_confirmation',
        'consents',
      ]);
      expect(new Set(checklist.items.map((i) => i.code)).size).toBe(checklist.items.length);

      const dir = mkdtempSync(join(tmpdir(), 'pb-config-'));
      expect(() => loadClosingChecklist(dir)).toThrow(/missing: closing_checklist.json/);
      const marker = 'MARKER-NEVER-ECHOED-0014';
      writeFileSync(
        join(dir, 'closing_checklist.json'),
        JSON.stringify({
          items: [
            { code: 'cap_table', label: marker, required: true },
            { code: 'cap_table', label: 'Again', required: false },
          ],
        }),
      );
      let message = '';
      try {
        loadClosingChecklist(dir);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('not valid (closing_checklist.json)');
      expect(message).toContain('items');
      expect(message).not.toContain(marker);
    });
  });

  it('keeps every response inside the contract', async () => {
    for (const c of h.dataset.closings!.slice(0, 5)) {
      const d: ClosingDetail = await detail('deal.three', c.id);
      expect(d.id).toBe(c.id);
    }
  });
});
