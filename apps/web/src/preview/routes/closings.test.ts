import { beforeEach, describe, expect, it } from 'vitest';
import { closingDetail, opportunityDetail } from '@pb/contracts';
import type { ClosingDetail, OpportunityDetail } from '@pb/contracts';
import { closingMachine, forbiddenPairs } from '@pb/workflows';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState, SimDocument } from '../state.js';
import { IDS, USERS, buildWorld, problemOf, send } from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';

/**
 * The simulated closing (docs/04 M8, M22, docs/18 section 12): the record, its checklist from
 * config, the operations confirmation gated on the required items and the allocation tie-out,
 * the audited close-date change, and the legal terms captured in draft and confirmed once.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const id = IDS.closing.open;
const path = (closingId: string): string => `/api/v1/closings/${closingId}`;
const commands = `${path(id)}/commands`;
const item = (code: string): string => `${path(id)}/items/${code}/commands`;
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';

let ids = 0;
const env = {
  newId: (): string => `56000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

const hubDocument: SimDocument = {
  id: IDS.document,
  sourceItemId: 'inbox/wire-confirmation.pdf',
  fileName: 'wire-confirmation.pdf',
  folder: 'inbox',
  title: 'Wire confirmation',
  docType: 'doc_type.other',
  reviewStatus: 'Classified',
  sponsorId: null,
  sponsorFundId: null,
  investmentId: null,
  periodEnd: null,
  contentHash: 'b'.repeat(64),
  sizeBytes: 100,
  pageCount: 1,
  receivedAt: '2025-06-01T10:00:00.000Z',
  indexedAt: '2025-06-01T10:00:00.000Z',
  classificationConfidence: null,
  classifierEvidence: { keywords: [], candidates: [] },
  classifiedById: null,
  classifiedBy: null,
  classifiedAt: null,
  duplicateOfId: null,
  textExcerpt: null,
  pages: null,
  unreadableCode: null,
  rowVersion: 1,
};

function setup(): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  state.documents.set(hubDocument.id, hubDocument);
  return { f: createPreviewFetch(buildWorld().fixtures, never, { env, state }), state };
}

const detailOf = (answer: Answer): ClosingDetail => {
  expect(answer.status, answer.text).toBe(200);
  return closingDetail.parse(answer.json);
};

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('reads', () => {
  it('shows the Closing deal: the checklist in config order, one required item open, allocations tying out, draft terms', async () => {
    const { f } = setup();
    const d = detailOf(await send(f, USERS.viewer.externalId, 'GET', path(id)));
    expect(d).toMatchObject({
      opportunityId: IDS.opportunity.closingOpen,
      investmentId: null,
      closeDate: '2025-07-15',
      commitmentAmount: '2000000.00',
      state: 'Open',
      opsConfirmedBy: null,
      itemsOpen: 3,
      itemsRequiredOpen: 1,
      allocationTieOut: { tiedOut: true, commitment: '2000000.00' },
    });
    expect(d.items.map((i) => i.itemCode)).toEqual([
      'signed_documents',
      'cap_table',
      'funds_flow',
      'wire_confirmation',
      'consents',
      'side_letter',
      'closing_memo',
    ]);
    expect(d.items.find((i) => i.itemCode === 'wire_confirmation')).toMatchObject({
      status: 'open',
      documentId: null,
    });
    expect(d.legalTerms).toHaveLength(2);
    expect(d.legalTerms.every((t) => t.status === 'draft' && t.confirmedBy === null)).toBe(true);
    for (const who of [USERS.deal, USERS.ops, USERS.head])
      expect((await send(f, who.externalId, 'GET', path(id))).status).toBe(200);
    expect((await send(f, USERS.admin.externalId, 'GET', path(id))).status).toBe(403);
    expect((await send(f, USERS.viewer.externalId, 'GET', path(NO_SUCH_ID))).status).toBe(404);
    // The confirmed closing of an existing position, dated at its entry date.
    const confirmed = detailOf(
      await send(f, USERS.viewer.externalId, 'GET', path(IDS.closing.confirmed)),
    );
    expect(confirmed).toMatchObject({
      state: 'OpsConfirmed',
      investmentId: IDS.open,
      closeDate: '2023-01-15',
    });
    expect(confirmed.legalTerms.every((t) => t.status === 'confirmed')).toBe(true);
  });
});

describe('the checklist and the confirmation (journey 6, the operations half)', () => {
  it('guards the writes by role', async () => {
    const { f } = setup();
    for (const who of [USERS.viewer, USERS.admin]) {
      expect((await send(f, who.externalId, 'POST', commands, { command: 'confirm' })).status).toBe(
        403,
      );
      expect(
        (await send(f, who.externalId, 'POST', item('wire_confirmation'), { command: 'reopen' }))
          .status,
      ).toBe(403);
      expect(
        (
          await send(f, who.externalId, 'POST', `${path(id)}/legal-terms`, {
            termType: 'legal_term_type.mfn',
            value: { granted: true },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await send(f, USERS.deal.externalId, 'POST', commands, { command: 'confirm' })).status,
    ).toBe(403);
    expect(
      (await send(f, USERS.head.externalId, 'POST', commands, { command: 'confirm' })).status,
    ).toBe(403);
  });

  it('cannot complete with a required document missing, refuses a tie-out that fails, confirms, and needs confirmation again after a close date change', async () => {
    const { f, state } = setup();
    const confirm = (): Promise<Answer> =>
      send(f, USERS.ops.externalId, 'POST', commands, { command: 'confirm' });
    const missing = await confirm();
    expect(missing.status).toBe(422);
    expect(problemOf(missing).detail).toMatch(/required closing document is missing/);

    // The item commands: receive needs a document the caller can see; the moves are checked.
    expect(
      (await send(f, USERS.ops.externalId, 'POST', item('no_such_item'), { command: 'reopen' }))
        .status,
    ).toBe(404);
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', item('wire_confirmation'), {
          command: 'receive',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', item('wire_confirmation'), {
          command: 'receive',
          documentId: NO_SUCH_ID,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', item('wire_confirmation'), {
          command: 'reopen',
        })
      ).status,
    ).toBe(409);
    const received = detailOf(
      await send(f, USERS.ops.externalId, 'POST', item('wire_confirmation'), {
        command: 'receive',
        documentId: IDS.document,
      }),
    );
    expect(received.items.find((i) => i.itemCode === 'wire_confirmation')).toMatchObject({
      status: 'received',
      documentId: IDS.document,
    });
    expect(received.itemsRequiredOpen).toBe(0);
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', item('wire_confirmation'), {
          command: 'waive',
          reason: 'held',
        })
      ).status,
    ).toBe(409);
    const reopened = detailOf(
      await send(f, USERS.deal.externalId, 'POST', item('wire_confirmation'), {
        command: 'reopen',
      }),
    );
    expect(reopened.items.find((i) => i.itemCode === 'wire_confirmation')).toMatchObject({
      status: 'open',
      documentId: null,
    });
    expect(reopened.itemsRequiredOpen).toBe(1);
    const waived = detailOf(
      await send(f, USERS.deal.externalId, 'POST', item('wire_confirmation'), {
        command: 'waive',
        reason: 'wire confirmation held by the bank and recorded in the closing memo',
      }),
    );
    expect(waived.items.find((i) => i.itemCode === 'wire_confirmation')?.status).toBe('waived');
    expect(waived.itemsRequiredOpen).toBe(0);

    // M22 AC: the allocations must equal the commitment or the closing cannot complete.
    const put = (requested: string): Promise<Answer> =>
      send(
        f,
        USERS.deal.externalId,
        'PUT',
        `/api/v1/opportunities/${IDS.opportunity.closingOpen}/allocations`,
        {
          allocations: [{ vehicleId: IDS.vehicle, requested, received: requested }],
        },
      );
    expect((await put('1000000.00')).status).toBe(200);
    const short = detailOf(await send(f, USERS.ops.externalId, 'GET', path(id)));
    expect(short.allocationTieOut).toMatchObject({ tiedOut: false, allocated: '1000000.00' });
    expect(problemOf(await confirm()).detail).toMatch(/allocations do not tie/);
    const tied = opportunityDetail.parse((await put('2000000.00')).json);
    expect(tied.closing?.allocationTieOut.tiedOut).toBe(true);
    // The checklist is in and the lines tie, and the gate still waits for the confirmation.
    expect(tied.gates.closing).toEqual({
      checklistComplete: true,
      allocationTiedOut: true,
      confirmed: false,
      ok: false,
    });

    // The confirmation.
    const confirmed = detailOf(await confirm());
    expect(confirmed).toMatchObject({
      state: 'OpsConfirmed',
      opsConfirmedBy: { id: USERS.ops.userId, name: USERS.ops.displayName },
      opsConfirmedAt: env.now(),
      rowVersion: 2,
    });
    expect((await confirm()).status).toBe(409);
    expect(
      opportunityDetail.parse(
        (
          await send(
            f,
            USERS.viewer.externalId,
            'GET',
            `/api/v1/opportunities/${IDS.opportunity.closingOpen}`,
          )
        ).json,
      ).gates.closing,
    ).toEqual({ checklistComplete: true, allocationTiedOut: true, confirmed: true, ok: true });

    // A close date change after confirmation needs a reason and returns the record to Open.
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', commands, {
          command: 'changeCloseDate',
          closeDate: '2026-01-15',
        })
      ).status,
    ).toBe(400);
    const stale = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commands,
      { command: 'changeCloseDate', closeDate: '2025-07-22', reason: 'signing slipped a week' },
      { 'if-match': '"1"' },
    );
    expect(stale.status).toBe(412);
    const moved = detailOf(
      await send(
        f,
        USERS.ops.externalId,
        'POST',
        commands,
        { command: 'changeCloseDate', closeDate: '2025-07-22', reason: 'signing slipped a week' },
        { 'if-match': '"2"' },
      ),
    );
    expect(moved).toMatchObject({
      state: 'Open',
      closeDate: '2025-07-22',
      opsConfirmedBy: null,
      opsConfirmedAt: null,
    });
    expect(
      opportunityDetail.parse(
        (
          await send(
            f,
            USERS.viewer.externalId,
            'GET',
            `/api/v1/opportunities/${IDS.opportunity.closingOpen}`,
          )
        ).json,
      ).gates.closing.ok,
    ).toBe(false);
    // While Open, the same command is a plain, audited date change.
    const again = detailOf(
      await send(f, USERS.ops.externalId, 'POST', commands, {
        command: 'changeCloseDate',
        closeDate: '2025-07-24',
        reason: 'funds flow agreed for the 24th',
      }),
    );
    expect(again).toMatchObject({ state: 'Open', closeDate: '2025-07-24' });
    expect(detailOf(await confirm()).state).toBe('OpsConfirmed');
    expect(state.audit.filter((e) => e.action === 'closing.changeCloseDate')).toHaveLength(2);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('answers 409 for the forbidden pairs of the closing machine; Open plus changeCloseDate is the documented date update', async () => {
    const { f } = setup();
    expect(forbiddenPairs(closingMachine)).toEqual([
      { from: 'Open', command: 'changeCloseDate' },
      { from: 'Open', command: 'reopen' },
      { from: 'OpsConfirmed', command: 'confirm' },
    ]);
    const confirmedAgain = await send(
      f,
      USERS.ops.externalId,
      'POST',
      `${path(IDS.closing.confirmed)}/commands`,
      { command: 'confirm' },
    );
    expect(confirmedAgain.status).toBe(409);
    expect(problemOf(confirmedAgain)).toEqual({
      code: 'workflow-transition',
      detail: 'closing: confirm is not allowed from OpsConfirmed',
    });
    expect(
      detailOf(await send(f, USERS.ops.externalId, 'GET', path(IDS.closing.confirmed))).state,
    ).toBe('OpsConfirmed');
    // An Open closing is not reopened.
    const reopenedOpen = await send(f, USERS.ops.externalId, 'POST', commands, {
      command: 'reopen',
      reason: 'nothing to reopen',
    });
    expect(reopenedOpen.status).toBe(409);
    expect(problemOf(reopenedOpen)).toEqual({
      code: 'workflow-transition',
      detail: 'closing: reopen is not allowed from Open',
    });
    expect(detailOf(await send(f, USERS.ops.externalId, 'GET', path(id)))).toMatchObject({
      state: 'Open',
      rowVersion: 1,
    });
  });

  it('ties out on received amounts alone: a line with no received amount keeps the closing from confirming, and the refusal says how many are missing (M22)', async () => {
    const { f } = setup();
    const confirm = (): Promise<Answer> =>
      send(f, USERS.ops.externalId, 'POST', commands, { command: 'confirm' });
    const put = async (allocations: object[]): Promise<OpportunityDetail> => {
      const answer = await send(
        f,
        USERS.deal.externalId,
        'PUT',
        `/api/v1/opportunities/${IDS.opportunity.closingOpen}/allocations`,
        { allocations },
      );
      expect(answer.status, answer.text).toBe(200);
      return opportunityDetail.parse(answer.json);
    };

    // Requested in full and nothing received: the requested amount never stands in.
    const requestedOnly = await put([{ vehicleId: IDS.vehicle, requested: '2000000.00' }]);
    expect(requestedOnly.closing?.allocationTieOut).toEqual({
      commitment: '2000000.00',
      allocated: '0.00',
      difference: '-2000000.00',
      tiedOut: false,
      hiddenLines: 0,
    });
    expect(requestedOnly.gates.closing).toMatchObject({ allocationTiedOut: false, ok: false });
    // While a required item is open the checklist refusal comes first, as the machine orders them.
    expect(problemOf(await confirm())).toEqual({
      code: 'workflow-precondition',
      detail: 'closing: a required closing document is missing (M8)',
    });
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', item('wire_confirmation'), {
          command: 'receive',
          documentId: IDS.document,
        })
      ).status,
    ).toBe(200);
    const one = await confirm();
    expect(one.status).toBe(422);
    expect(problemOf(one)).toEqual({
      code: 'workflow-precondition',
      detail: 'closing: received amounts are missing on 1 line (M22)',
    });

    // Received amounts that reach the commitment do not tie while other lines have none.
    const reached = await put([
      { vehicleId: IDS.vehicle, requested: '1000000.00', received: '2000000.00' },
      { vehicleId: IDS.vehicle2, requested: '600000.00' },
      { vehicleId: IDS.vehicle, clientId: IDS.client, requested: '400000.00' },
    ]);
    expect(reached.closing?.allocationTieOut).toEqual({
      commitment: '2000000.00',
      allocated: '2000000.00',
      difference: '0.00',
      tiedOut: false,
      hiddenLines: 0,
    });
    expect(problemOf(await confirm()).detail).toBe(
      'closing: received amounts are missing on 2 lines (M22)',
    );
    const advance = await send(
      f,
      USERS.ops.externalId,
      'POST',
      `/api/v1/opportunities/${IDS.opportunity.closingOpen}/commands`,
      { command: 'advance' },
    );
    expect(advance.status).toBe(422);
    expect(problemOf(advance).detail).toBe(
      'deal_stage: allocations do not tie to the closing commitment (M22)',
    );

    // Every line received and short of the commitment: the plain tie-out refusal.
    await put([
      { vehicleId: IDS.vehicle, requested: '1500000.00', received: '1500000.00' },
      { vehicleId: IDS.vehicle2, requested: '500000.00', received: '400000.00' },
    ]);
    expect(problemOf(await confirm()).detail).toBe(
      'closing: allocations do not tie to the closing commitment (M22)',
    );

    // Every line received and the total equal to the commitment: the closing confirms.
    const tied = await put([
      { vehicleId: IDS.vehicle, requested: '1500000.00', received: '1500000.00' },
      { vehicleId: IDS.vehicle2, requested: '500000.00', received: '500000.00' },
    ]);
    expect(tied.closing?.allocationTieOut).toEqual({
      commitment: '2000000.00',
      allocated: '2000000.00',
      difference: '0.00',
      tiedOut: true,
      hiddenLines: 0,
    });
    expect(detailOf(await confirm()).state).toBe('OpsConfirmed');
  });

  it('keeps a confirmed closing as confirmed: its lines and items are refused until operations reopen it with a reason, and it then needs confirmation again', async () => {
    const { f, state } = setup();
    const opportunityPath = `/api/v1/opportunities/${IDS.opportunity.closingOpen}`;
    const putAllocations = (who: string, received: string): Promise<Answer> =>
      send(f, who, 'PUT', `${opportunityPath}/allocations`, {
        allocations: [{ vehicleId: IDS.vehicle, requested: received, received }],
      });
    const reopen = (who: string, body: object, extra: Record<string, string> = {}) =>
      send(f, who, 'POST', commands, body, extra);
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', item('wire_confirmation'), {
          command: 'receive',
          documentId: IDS.document,
        })
      ).status,
    ).toBe(200);
    const confirmed = detailOf(
      await send(f, USERS.ops.externalId, 'POST', commands, { command: 'confirm' }),
    );
    expect(confirmed).toMatchObject({ state: 'OpsConfirmed', rowVersion: 2 });

    // The lines and the items are what operations confirmed: they stay as they are.
    const CONFIRMED = {
      code: 'workflow-precondition',
      detail: 'the closing is confirmed; change the close date or ask operations to reopen it',
    };
    for (const who of [USERS.deal, USERS.ops]) {
      const refused = await putAllocations(who.externalId, '1.00');
      expect(refused.status).toBe(422);
      expect(problemOf(refused)).toEqual(CONFIRMED);
    }
    for (const [who, code, body] of [
      [USERS.ops, 'wire_confirmation', { command: 'reopen' }],
      [USERS.deal, 'side_letter', { command: 'waive', reason: 'no side letter on this deal' }],
      [USERS.ops, 'side_letter', { command: 'receive', documentId: IDS.document }],
      // The move itself would be a 409 on an Open closing: the confirmation is checked first.
      [USERS.ops, 'side_letter', { command: 'reopen' }],
    ] as const) {
      const refused = await send(f, who.externalId, 'POST', item(code), body);
      expect(refused.status, `${code} ${body.command}`).toBe(422);
      expect(problemOf(refused)).toEqual(CONFIRMED);
    }
    // An item the checklist does not have is still not found, confirmed or not.
    expect(
      (await send(f, USERS.ops.externalId, 'POST', item('no_such_item'), { command: 'reopen' }))
        .status,
    ).toBe(404);
    const unchanged = detailOf(await send(f, USERS.ops.externalId, 'GET', path(id)));
    expect(unchanged.items).toEqual(confirmed.items);
    expect(unchanged.allocations).toEqual(confirmed.allocations);
    expect(unchanged.state).toBe('OpsConfirmed');

    // reopen: operations only, with a reason; a stale If-Match is refused first.
    expect(
      (await reopen(USERS.deal.externalId, { command: 'reopen', reason: 'a line moved' })).status,
    ).toBe(403);
    expect((await reopen(USERS.ops.externalId, { command: 'reopen' })).status).toBe(400);
    const blank = await reopen(USERS.ops.externalId, { command: 'reopen', reason: '    ' });
    expect(blank.status).toBe(422);
    expect(problemOf(blank)).toEqual({
      code: 'workflow-precondition',
      detail: 'closing: a reason is required',
    });
    const REASON = 'the second vehicle takes part of the allocation';
    expect(
      (
        await reopen(
          USERS.ops.externalId,
          { command: 'reopen', reason: REASON },
          { 'if-match': '"7"' },
        )
      ).status,
    ).toBe(412);
    const reopened = detailOf(
      await reopen(
        USERS.ops.externalId,
        { command: 'reopen', reason: REASON },
        { 'if-match': '"2"' },
      ),
    );
    expect(reopened).toMatchObject({
      state: 'Open',
      closeDate: confirmed.closeDate,
      commitmentAmount: confirmed.commitmentAmount,
      opsConfirmedBy: null,
      opsConfirmedAt: null,
      rowVersion: 3,
    });
    expect(state.audit.find((e) => e.action === 'closing.reopen')).toMatchObject({
      reason: REASON,
      from: 'OpsConfirmed',
      to: 'Open',
      actorId: USERS.ops.userId,
    });
    expect(
      opportunityDetail.parse((await send(f, USERS.viewer.externalId, 'GET', opportunityPath)).json)
        .gates.closing,
    ).toEqual({ checklistComplete: true, allocationTiedOut: true, confirmed: false, ok: false });
    expect(
      (await reopen(USERS.ops.externalId, { command: 'reopen', reason: 'again' })).status,
    ).toBe(409);

    // Open again, the lines and the items change, and the deal waits for a new confirmation.
    expect(
      (
        await send(f, USERS.deal.externalId, 'POST', item('side_letter'), {
          command: 'waive',
          reason: 'no side letter on this deal',
        })
      ).status,
    ).toBe(200);
    expect((await putAllocations(USERS.deal.externalId, '2000000.00')).status).toBe(200);
    const notConfirmed = await send(
      f,
      USERS.ops.externalId,
      'POST',
      `${opportunityPath}/commands`,
      {
        command: 'advance',
      },
    );
    expect(notConfirmed.status).toBe(422);
    expect(problemOf(notConfirmed)).toEqual({
      code: 'workflow-precondition',
      detail: 'the closing is not confirmed by operations (M8)',
    });
    expect(
      detailOf(await send(f, USERS.ops.externalId, 'POST', commands, { command: 'confirm' })).state,
    ).toBe('OpsConfirmed');
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('once the position exists, refuses a close date change and a reopen: the change goes through a deal change request', async () => {
    const { f } = setup();
    const converted = `${path(IDS.closing.confirmed)}/commands`;
    const before = detailOf(
      await send(f, USERS.ops.externalId, 'GET', path(IDS.closing.confirmed)),
    );
    expect(before.investmentId).toBe(IDS.open);
    for (const body of [
      {
        command: 'changeCloseDate',
        closeDate: '2023-01-20',
        reason: 'the signing date was recorded a week early',
      },
      { command: 'reopen', reason: 'the signing date was recorded a week early' },
    ]) {
      const refused = await send(f, USERS.ops.externalId, 'POST', converted, body);
      expect(refused.status, body.command).toBe(422);
      expect(problemOf(refused)).toEqual({
        code: 'workflow-precondition',
        detail: 'the position exists; record the change through a deal change request',
      });
      // A stale If-Match is still answered first, and the role guard before both.
      expect(
        (await send(f, USERS.ops.externalId, 'POST', converted, body, { 'if-match': '"99"' }))
          .status,
      ).toBe(412);
      expect((await send(f, USERS.deal.externalId, 'POST', converted, body)).status).toBe(403);
    }
    expect(
      detailOf(await send(f, USERS.ops.externalId, 'GET', path(IDS.closing.confirmed))),
    ).toEqual(before);
  });
});

describe('legal terms (M22)', () => {
  it('captures a term in draft with a checked source, confirms it once, by the deal team or operations', async () => {
    const { f } = setup();
    const termsPath = `${path(id)}/legal-terms`;
    const body = {
      termType: 'legal_term_type.mfn',
      value: { granted: true, scope: 'fee terms', threshold: '0.0500' },
      sourceDocumentId: IDS.document,
    };
    expect(
      (
        await send(f, USERS.deal.externalId, 'POST', termsPath, {
          ...body,
          sourceDocumentId: NO_SUCH_ID,
        })
      ).status,
    ).toBe(422);
    expect(
      (await send(f, USERS.deal.externalId, 'POST', termsPath, { ...body, termType: 'nope' }))
        .status,
    ).toBe(400);
    const created = await send(f, USERS.deal.externalId, 'POST', termsPath, body);
    expect(created.status).toBe(201);
    const detail = closingDetail.parse(created.json);
    expect(detail.legalTerms).toHaveLength(3);
    const term = detail.legalTerms.at(-1);
    expect(term).toMatchObject({ ...body, status: 'draft', confirmedBy: null });
    const termPath = `${termsPath}/${term?.id ?? ''}/commands`;
    expect(
      (await send(f, USERS.viewer.externalId, 'POST', termPath, { command: 'confirm' })).status,
    ).toBe(403);
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', `${termsPath}/${NO_SUCH_ID}/commands`, {
          command: 'confirm',
        })
      ).status,
    ).toBe(404);
    expect(
      (await send(f, USERS.ops.externalId, 'POST', termPath, { command: 'nope' })).status,
    ).toBe(400);
    const confirmed = detailOf(
      await send(f, USERS.ops.externalId, 'POST', termPath, { command: 'confirm' }),
    );
    expect(confirmed.legalTerms.find((t) => t.id === term?.id)).toMatchObject({
      status: 'confirmed',
      confirmedBy: { id: USERS.ops.userId, name: USERS.ops.displayName },
    });
    expect(
      (await send(f, USERS.ops.externalId, 'POST', termPath, { command: 'confirm' })).status,
    ).toBe(409);
  });
});
