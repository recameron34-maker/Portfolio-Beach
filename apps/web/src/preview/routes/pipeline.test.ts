import { beforeEach, describe, expect, it } from 'vitest';
import {
  closingDetail,
  diligenceTemplateFor,
  investmentDetail,
  investmentPage,
  opportunityDetail,
  opportunityPage,
  problemDetails,
} from '@pb/contracts';
import type { DealStage, OpportunityDetail, OpportunityRow } from '@pb/contracts';
import { dealStageMachine, forbiddenPairs } from '@pb/workflows';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState, SimDocument } from '../state.js';
import { AS_OF, IDS, USERS, buildWorld, problemOf, send, testBook } from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';
import { templatesOf } from './pipeline.js';

/**
 * The simulated pipeline (docs/04 M5 skeleton, M7, docs/18 section 4) and journey 6 of docs/12
 * end to end through the shim: the deal team creates a deal and advances it through the gates,
 * the approver records the IC decision, the closing opens with the checklist, operations receives
 * the wire confirmation, the allocations tie out, operations confirms and closes, and the new
 * position appears in the portfolio grid with the close date on its one-pager.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const LIST = '/api/v1/opportunities?limit=200';
const path = (id: string): string => `/api/v1/opportunities/${id}`;
const commands = (id: string): string => `${path(id)}/commands`;
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
const CO_INVEST = 'deal_type.co_invest_equity';

let ids = 0;
const env = {
  newId: (): string => `55000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

/** A document in the simulated hub every role can see: the evidence a task or an item may name. */
const hubDocument: SimDocument = {
  id: IDS.document,
  sourceItemId: 'inbox/closing-set.pdf',
  fileName: 'closing-set.pdf',
  folder: 'inbox',
  title: 'Closing set',
  docType: 'doc_type.other',
  reviewStatus: 'Classified',
  sponsorId: null,
  sponsorFundId: null,
  investmentId: null,
  periodEnd: null,
  contentHash: 'a'.repeat(64),
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
  return {
    f: createPreviewFetch(buildWorld().fixtures, never, { env, state, book: testBook() }),
    state,
  };
}

const detailOf = (answer: Answer): OpportunityDetail => {
  expect(answer.status, answer.text).toBe(200);
  return opportunityDetail.parse(answer.json);
};

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('reads', () => {
  it('lists what the caller can see, newest received first, filtered by stage and lead, paged; the walled deal for members only', async () => {
    const { f } = setup();
    const page = opportunityPage.parse((await send(f, USERS.viewer.externalId, 'GET', LIST)).json);
    expect(page.items.map((o) => o.id)).toEqual([
      IDS.opportunity.sourced,
      IDS.opportunity.ic,
      IDS.opportunity.passed,
      IDS.opportunity.closingOpen,
      IDS.opportunity.closed,
    ]);
    expect(
      opportunityPage.parse((await send(f, USERS.dealWall.externalId, 'GET', LIST)).json).items,
    ).toHaveLength(6);
    expect(
      opportunityPage
        .parse((await send(f, USERS.viewer.externalId, 'GET', `${LIST}&stage=Passed`)).json)
        .items.map((o) => o.id),
    ).toEqual([IDS.opportunity.passed]);
    expect(
      opportunityPage.parse(
        (await send(f, USERS.viewer.externalId, 'GET', `${LIST}&ownerId=${USERS.dealWall.userId}`))
          .json,
      ).items,
    ).toEqual([]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const part = opportunityPage.parse(
        (
          await send(
            f,
            USERS.viewer.externalId,
            'GET',
            `/api/v1/opportunities?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`,
          )
        ).json,
      );
      seen.push(...part.items.map((o) => o.id));
      cursor = part.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(page.items.map((o) => o.id));
    expect((await send(f, USERS.viewer.externalId, 'GET', `${LIST}&stage=Nope`)).status).toBe(400);
    expect(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/opportunities?cursor=bm9wZQ')).status,
    ).toBe(400);
    expect((await send(f, USERS.admin.externalId, 'GET', LIST)).status).toBe(403);
  });

  it('shows the detail with its history, tasks, decisions, allocations, closing summary and gates; the walled deal is 404 outside', async () => {
    const { f } = setup();
    const closing = detailOf(
      await send(f, USERS.viewer.externalId, 'GET', path(IDS.opportunity.closingOpen)),
    );
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
    expect(closing.diligenceTasks.filter((t) => t.status === 'waived')).toHaveLength(1);
    expect(closing.closing).toMatchObject({ state: 'Open', itemsRequiredOpen: 1, itemsOpen: 3 });
    expect(closing.gates).toEqual({
      diligence: { requiredOpen: 0, ok: true },
      icDecision: { ok: true },
      closing: { checklistComplete: false, allocationTiedOut: true, ok: false },
    });
    const sourced = detailOf(
      await send(f, USERS.viewer.externalId, 'GET', path(IDS.opportunity.sourced)),
    );
    expect(sourced.gates.diligence).toEqual({ requiredOpen: 4, ok: false });
    expect((await send(f, USERS.deal.externalId, 'GET', path(IDS.opportunity.walled))).status).toBe(
      404,
    );
    expect(
      (
        await send(f, USERS.deal.externalId, 'POST', commands(IDS.opportunity.walled), {
          command: 'advance',
        })
      ).status,
    ).toBe(404);
    expect(
      detailOf(await send(f, USERS.dealWall.externalId, 'GET', path(IDS.opportunity.walled))).stage,
    ).toBe('Diligence');
    expect((await send(f, USERS.viewer.externalId, 'GET', path(NO_SUCH_ID))).status).toBe(404);
  });
});

describe('journey 6: Sourced to Closed through the gates', () => {
  it('moves a deal from Sourced to Closed and converts it into a position the portfolio shows', async () => {
    const { f, state } = setup();
    const body = {
      name: 'Project Lantern',
      companyName: 'Lantern Logistics Co',
      sponsorId: IDS.sponsor,
      sponsorFundId: IDS.fund,
      dealType: CO_INVEST,
      sector: 'sector.software',
      geography: 'geography.north_america',
      receivedDate: AS_OF,
      targetCommitment: '15000000.00',
      source: 'Sponsor introduction',
    };
    const create = (who: string, b: object): Promise<Answer> =>
      send(f, who, 'POST', '/api/v1/opportunities', b);
    expect((await create(USERS.viewer.externalId, body)).status).toBe(403);
    expect((await create(USERS.ops.externalId, body)).status).toBe(403);
    const unknownSponsor = await create(USERS.deal.externalId, { ...body, sponsorId: NO_SUCH_ID });
    expect(unknownSponsor.status).toBe(400);
    expect(problemDetails.parse(unknownSponsor.json).errors).toEqual([
      { path: 'sponsorId', message: 'Unknown sponsor' },
    ]);
    expect(
      (
        await create(USERS.deal.externalId, {
          ...body,
          sponsorFundId: IDS.fund2,
          sponsorId: NO_SUCH_ID,
        })
      ).status,
    ).toBe(400);
    expect(
      (await create(USERS.deal.externalId, { ...body, targetCommitment: '15000000.005' })).status,
    ).toBe(400);

    const createdAnswer = await create(USERS.deal.externalId, body);
    expect(createdAnswer.status).toBe(201);
    const created = opportunityDetail.parse(createdAnswer.json);
    const id = created.id;
    expect(created).toMatchObject({
      stage: 'Sourced',
      owner: { id: USERS.deal.userId },
      sponsor: { id: IDS.sponsor, name: 'Test Sponsor' },
      sponsorFund: { id: IDS.fund, name: 'Test Fund IV' },
      daysInStage: 0,
      diligenceTasks: [],
      closing: null,
    });
    expect(created.stageHistory).toEqual([
      expect.objectContaining({ fromStage: null, toStage: 'Sourced', command: 'create' }),
    ]);

    // Sourced > Screening: a stale If-Match is 412, the current row version passes.
    const run = (who: string, b: object, extra: Record<string, string> = {}): Promise<Answer> =>
      send(f, who, 'POST', commands(id), b, extra);
    expect(
      (await run(USERS.deal.externalId, { command: 'advance' }, { 'if-match': '"99"' })).status,
    ).toBe(412);
    const screening = detailOf(
      await run(USERS.deal.externalId, { command: 'advance' }, { 'if-match': '"1"' }),
    );
    expect(screening).toMatchObject({ stage: 'Screening', rowVersion: 2 });
    expect(detailOf(await run(USERS.deal.externalId, { command: 'advance' })).stage).toBe(
      'Prescreen',
    );
    expect((await run(USERS.ops.externalId, { command: 'advance' })).status).toBe(403);

    // Entering Diligence creates the template tasks of the deal type once.
    const diligence = detailOf(await run(USERS.deal.externalId, { command: 'advance' }));
    expect(diligence.stage).toBe('Diligence');
    const template = diligenceTemplateFor(templatesOf({ book: testBook() } as never), CO_INVEST);
    expect(diligence.diligenceTasks.map((t) => [t.workstream, t.title, t.requiredForIc])).toEqual(
      template.map((t) => [t.workstream, t.title, t.requiredForIc]),
    );
    expect(
      diligence.diligenceTasks.every(
        (t) => t.status === 'open' && t.owner?.id === USERS.deal.userId,
      ),
    ).toBe(true);
    expect(diligence.gates.diligence).toEqual({
      requiredOpen: template.filter((t) => t.requiredForIc).length,
      ok: false,
    });

    // The IC gate holds while a required task is open (M7 AC).
    const held = await run(USERS.deal.externalId, { command: 'advance' });
    expect(held.status).toBe(422);
    expect(problemOf(held).detail).toMatch(/required diligence tasks are open/);
    const required = diligence.diligenceTasks.filter((t) => t.requiredForIc);
    const optional = diligence.diligenceTasks.find((t) => !t.requiredForIc);
    const task = (who: string, taskId: string, b: object): Promise<Answer> =>
      send(f, who, 'POST', `${path(id)}/diligence-tasks/${taskId}/commands`, b);
    const unseen = await task(USERS.deal.externalId, required[0]?.id ?? '', {
      command: 'complete',
      evidenceDocumentId: NO_SUCH_ID,
    });
    expect(unseen.status).toBe(422);
    expect(
      (await task(USERS.viewer.externalId, required[0]?.id ?? '', { command: 'complete' })).status,
    ).toBe(403);
    expect((await task(USERS.deal.externalId, NO_SUCH_ID, { command: 'complete' })).status).toBe(
      404,
    );
    const withEvidence = detailOf(
      await task(USERS.deal.externalId, required[0]?.id ?? '', {
        command: 'complete',
        evidenceDocumentId: IDS.document,
      }),
    );
    expect(withEvidence.diligenceTasks.find((t) => t.id === required[0]?.id)).toMatchObject({
      status: 'done',
      evidenceDocumentId: IDS.document,
    });
    expect(
      (await task(USERS.deal.externalId, required[0]?.id ?? '', { command: 'complete' })).status,
    ).toBe(409);
    for (const t of required.slice(1))
      expect((await task(USERS.deal.externalId, t.id, { command: 'complete' })).status).toBe(200);
    expect(
      (await task(USERS.head.externalId, optional?.id ?? '', { command: 'waive' })).status,
    ).toBe(400);
    const waived = detailOf(
      await task(USERS.head.externalId, optional?.id ?? '', {
        command: 'waive',
        reason: 'covered by the sponsor review shared in diligence',
      }),
    );
    expect(waived.diligenceTasks.find((t) => t.id === optional?.id)).toMatchObject({
      status: 'waived',
      waivedReason: 'covered by the sponsor review shared in diligence',
    });
    const reopened = detailOf(
      await task(USERS.deal.externalId, optional?.id ?? '', { command: 'reopen' }),
    );
    expect(reopened.diligenceTasks.find((t) => t.id === optional?.id)).toMatchObject({
      status: 'open',
      waivedReason: null,
    });
    expect(reopened.gates.diligence).toEqual({ requiredOpen: 0, ok: true });

    // Diligence > IC, then the decision gate (approver only).
    expect(detailOf(await run(USERS.deal.externalId, { command: 'advance' })).stage).toBe('IC');
    expect((await run(USERS.deal.externalId, { command: 'advance' })).status).toBe(403);
    const noDecision = await run(USERS.head.externalId, { command: 'advance' });
    expect(noDecision.status).toBe(422);
    expect(problemOf(noDecision).detail).toMatch(/IC decision record is required/);
    const decision = {
      decisionDate: AS_OF,
      decision: 'approved',
      amount: '15000000.00',
      conditions: ['Confirmatory legal review complete before signing'],
    };
    const decide = (who: string, b: object): Promise<Answer> =>
      send(f, who, 'POST', `${path(id)}/ic-decisions`, b);
    expect((await decide(USERS.deal.externalId, decision)).status).toBe(403);
    expect((await decide(USERS.head.externalId, { ...decision, amount: '1.005' })).status).toBe(
      400,
    );
    const decided = await decide(USERS.head.externalId, decision);
    expect(decided.status).toBe(201);
    const withDecision = opportunityDetail.parse(decided.json);
    expect(withDecision.icDecisions[0]).toMatchObject({
      decision: 'approved',
      amount: '15000000.00',
      conditions: decision.conditions,
      recordedBy: { id: USERS.head.userId },
    });
    expect(withDecision.gates.icDecision.ok).toBe(true);
    expect((await decide(USERS.head.externalId, decision)).status).toBe(409);
    expect(detailOf(await run(USERS.head.externalId, { command: 'advance' })).stage).toBe(
      'Approved',
    );

    // Approved > Closing needs the close date and the commitment together; it opens the closing.
    const bare = await run(USERS.deal.externalId, { command: 'advance' });
    expect(bare.status).toBe(422);
    expect(problemOf(bare).detail).toMatch(/close date and commitment/);
    expect(
      (await run(USERS.deal.externalId, { command: 'advance', closeDate: AS_OF })).status,
    ).toBe(400);
    const closingStage = detailOf(
      await run(USERS.deal.externalId, {
        command: 'advance',
        closeDate: AS_OF,
        commitmentAmount: '15000000.00',
      }),
    );
    expect(closingStage.stage).toBe('Closing');
    const closing = closingStage.closing;
    expect(closing).toMatchObject({
      closeDate: AS_OF,
      commitmentAmount: '15000000.00',
      currency: 'USD',
      state: 'Open',
      itemsOpen: 7,
      itemsRequiredOpen: 5,
      allocationTieOut: {
        commitment: '15000000.00',
        allocated: '0.00',
        difference: '-15000000.00',
        tiedOut: false,
      },
    });
    const closingPath = `/api/v1/closings/${closing?.id ?? ''}`;
    const opened = closingDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', closingPath)).json,
    );
    expect(opened.items.map((i) => i.itemCode)).toEqual([
      'signed_documents',
      'cap_table',
      'funds_flow',
      'wire_confirmation',
      'consents',
      'side_letter',
      'closing_memo',
    ]);

    // M8 AC: the closing cannot complete with a required document missing.
    const missing = await send(f, USERS.ops.externalId, 'POST', `${closingPath}/commands`, {
      command: 'confirm',
    });
    expect(missing.status).toBe(422);
    expect(problemOf(missing).detail).toMatch(/required closing document is missing/);
    for (const code of ['signed_documents', 'cap_table', 'funds_flow', 'consents'])
      expect(
        (
          await send(f, USERS.deal.externalId, 'POST', `${closingPath}/items/${code}/commands`, {
            command: 'waive',
            reason: `${code} held by outside counsel and recorded in the closing memo`,
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await send(
          f,
          USERS.ops.externalId,
          'POST',
          `${closingPath}/items/wire_confirmation/commands`,
          {
            command: 'receive',
            documentId: IDS.document,
          },
        )
      ).status,
    ).toBe(200);
    // Closing > Closed is operations only, and refused while the closing is not confirmed.
    expect((await run(USERS.deal.externalId, { command: 'advance' })).status).toBe(403);
    const untied = await run(USERS.ops.externalId, { command: 'advance' });
    expect(untied.status).toBe(422);
    expect(problemOf(untied).detail).toMatch(/allocations do not tie/);
    expect(
      problemOf(
        await send(f, USERS.ops.externalId, 'POST', `${closingPath}/commands`, {
          command: 'confirm',
        }),
      ).detail,
    ).toMatch(/allocations do not tie/);

    // M22 AC: the allocations must equal the closing commitment or the closing cannot complete.
    const allocations = {
      allocations: [
        { vehicleId: IDS.vehicle, requested: '10000000.00', received: '10000000.00' },
        { vehicleId: IDS.vehicle2, requested: '5000000.00' },
      ],
    };
    expect(
      (await send(f, USERS.viewer.externalId, 'PUT', `${path(id)}/allocations`, allocations))
        .status,
    ).toBe(403);
    const allocated = detailOf(
      await send(f, USERS.deal.externalId, 'PUT', `${path(id)}/allocations`, allocations),
    );
    expect(allocated.allocations.map((a) => [a.vehicle.name, a.requested, a.received])).toEqual([
      ['Test Vehicle I', '10000000.00', '10000000.00'],
      ['Test Vehicle II', '5000000.00', null],
    ]);
    expect(allocated.closing?.allocationTieOut).toEqual({
      commitment: '15000000.00',
      allocated: '15000000.00',
      difference: '0.00',
      tiedOut: true,
    });
    expect(allocated.gates.closing).toEqual({
      checklistComplete: true,
      allocationTiedOut: true,
      ok: false,
    });
    const confirmed = closingDetail.parse(
      (
        await send(f, USERS.ops.externalId, 'POST', `${closingPath}/commands`, {
          command: 'confirm',
        })
      ).json,
    );
    expect(confirmed.state).toBe('OpsConfirmed');
    expect(detailOf(await send(f, USERS.deal.externalId, 'GET', path(id))).gates.closing.ok).toBe(
      true,
    );

    // Closing > Closed converts the deal into a position: nothing is re-entered.
    const closed = detailOf(await run(USERS.ops.externalId, { command: 'advance' }));
    expect(closed.stage).toBe('Closed');
    expect(closed.investmentId).not.toBeNull();
    expect(closed.stageHistory.at(-1)).toMatchObject({
      fromStage: 'Closing',
      toStage: 'Closed',
      command: 'advance',
      changedBy: { id: USERS.ops.userId },
    });
    const investmentId = closed.investmentId ?? '';
    const position = investmentDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', `/api/v1/investments/${investmentId}`)).json,
    );
    expect(position).toMatchObject({
      investmentNumber: 'INV-0002',
      companyName: body.companyName,
      sponsorId: IDS.sponsor,
      sponsorName: 'Test Sponsor',
      sponsorFundId: IDS.fund,
      sponsorFundName: 'Test Fund IV',
      vehicleId: IDS.vehicle,
      vehicleName: 'Test Vehicle I',
      dealType: CO_INVEST,
      sector: body.sector,
      entryDate: AS_OF,
      closeDate: AS_OF,
      isActive: true,
      exitDate: null,
      nav: null,
      invested: null,
    });
    // The portfolio grid lists it first; the closing is stamped with it; Closed is terminal.
    const grid = investmentPage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/investments?limit=100')).json,
    );
    expect(grid.items[0]?.id).toBe(investmentId);
    expect(grid.items[0]?.investmentNumber).toBe('INV-0002');
    expect(
      closingDetail.parse((await send(f, USERS.viewer.externalId, 'GET', closingPath)).json)
        .investmentId,
    ).toBe(investmentId);
    expect((await run(USERS.ops.externalId, { command: 'advance' })).status).toBe(409);
    expect(
      (await send(f, USERS.ops.externalId, 'PUT', `${path(id)}/allocations`, allocations)).status,
    ).toBe(422);
    expect(state.audit.map((e) => e.action)).toContain('investment.create');
    expect(window.__pbPreviewMisses).toEqual([]);
  });
});

describe('pass, reopen and the refusals', () => {
  it('refuses a pass without a reason code (400) and records the code and note with one; reopen returns the deal to Screening', async () => {
    const { f } = setup();
    const id = IDS.opportunity.sourced;
    const run = (who: string, b: object): Promise<Answer> => send(f, who, 'POST', commands(id), b);
    expect((await run(USERS.deal.externalId, { command: 'pass' })).status).toBe(400);
    expect(
      (await run(USERS.ops.externalId, { command: 'pass', passReasonCode: 'pass_reason.sector' }))
        .status,
    ).toBe(403);
    const passed = detailOf(
      await run(USERS.deal.externalId, {
        command: 'pass',
        passReasonCode: 'pass_reason.sector',
        note: 'Outside the sector focus',
      }),
    );
    expect(passed).toMatchObject({
      stage: 'Passed',
      passReasonCode: 'pass_reason.sector',
      passNote: 'Outside the sector focus',
      daysInStage: 0,
    });
    expect(passed.stageHistory.at(-1)).toMatchObject({
      fromStage: 'Sourced',
      toStage: 'Passed',
      command: 'pass',
      reason: 'Outside the sector focus',
    });
    expect((await run(USERS.deal.externalId, { command: 'reopen' })).status).toBe(400);
    const reopened = detailOf(
      await run(USERS.deal.externalId, {
        command: 'reopen',
        reason: 'the sponsor came back with a lower price',
      }),
    );
    expect(reopened).toMatchObject({ stage: 'Screening', passReasonCode: null, passNote: null });
    expect((await run(USERS.deal.externalId, { command: 'reopen', reason: 'again' })).status).toBe(
      409,
    );
    // The board shows the moved deal to every reader.
    const board = opportunityPage.parse((await send(f, USERS.viewer.externalId, 'GET', LIST)).json);
    expect(board.items.find((o) => o.id === id)?.stage).toBe('Screening');
  });

  it('answers 409 for every forbidden pair of the deal stage machine, changing nothing', async () => {
    const { f } = setup();
    const who = USERS.all.externalId;
    // Rows at every stage: the fixtures, plus deals moved through the simulated API to the rest.
    const create = async (): Promise<string> =>
      opportunityDetail.parse(
        (
          await send(f, who, 'POST', '/api/v1/opportunities', {
            name: 'Project Pair',
            companyName: 'Pair Co',
            sponsorId: IDS.sponsor,
            dealType: CO_INVEST,
            receivedDate: AS_OF,
          })
        ).json,
      ).id;
    const advance = async (id: string, times: number): Promise<void> => {
      for (let i = 0; i < times; i += 1)
        expect((await send(f, who, 'POST', commands(id), { command: 'advance' })).status).toBe(200);
    };
    const screening = await create();
    await advance(screening, 1);
    const prescreen = await create();
    await advance(prescreen, 2);
    expect(
      (
        await send(f, who, 'POST', `${path(IDS.opportunity.ic)}/ic-decisions`, {
          decisionDate: AS_OF,
          decision: 'approved',
          conditions: [],
        })
      ).status,
    ).toBe(201);
    await advance(IDS.opportunity.ic, 1);
    const byStage: Record<DealStage, string> = {
      Sourced: IDS.opportunity.sourced,
      Screening: screening,
      Prescreen: prescreen,
      Diligence: IDS.opportunity.walled,
      IC: IDS.opportunity.sourced,
      Approved: IDS.opportunity.ic,
      Closing: IDS.opportunity.closingOpen,
      Closed: IDS.opportunity.closed,
      Passed: IDS.opportunity.passed,
    };
    const bodyFor = (command: string): object =>
      command === 'pass'
        ? { command, passReasonCode: 'pass_reason.other' }
        : command === 'reopen'
          ? { command, reason: 'reopened for the forbidden pair test' }
          : { command };
    for (const pair of forbiddenPairs(dealStageMachine).filter((p) => p.from !== 'IC')) {
      const target = byStage[pair.from];
      const before = detailOf(await send(f, who, 'GET', path(target)));
      expect(before.stage, `a deal at ${pair.from}`).toBe(pair.from);
      const answer = await send(f, who, 'POST', commands(target), bodyFor(pair.command));
      expect(answer.status, `${pair.from} ${pair.command}`).toBe(409);
      expect(detailOf(await send(f, who, 'GET', path(target))).stage).toBe(pair.from);
    }
  });

  it('records an IC decision only at IC, by an approver, once per date', async () => {
    const { f } = setup();
    const decision = { decisionDate: AS_OF, decision: 'deferred', conditions: [] };
    expect(
      (
        await send(
          f,
          USERS.deal.externalId,
          'POST',
          `${path(IDS.opportunity.ic)}/ic-decisions`,
          decision,
        )
      ).status,
    ).toBe(403);
    const notAtIc = await send(
      f,
      USERS.head.externalId,
      'POST',
      `${path(IDS.opportunity.sourced)}/ic-decisions`,
      decision,
    );
    expect(notAtIc.status).toBe(422);
    const deferred = await send(
      f,
      USERS.head.externalId,
      'POST',
      `${path(IDS.opportunity.ic)}/ic-decisions`,
      decision,
    );
    expect(deferred.status).toBe(201);
    const detail = opportunityDetail.parse(deferred.json);
    expect(detail.icDecisions[0]?.decision).toBe('deferred');
    expect(detail.gates.icDecision.ok).toBe(false);
    expect(
      (
        await send(f, USERS.head.externalId, 'POST', commands(IDS.opportunity.ic), {
          command: 'advance',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await send(
          f,
          USERS.head.externalId,
          'POST',
          `${path(IDS.opportunity.ic)}/ic-decisions`,
          decision,
        )
      ).status,
    ).toBe(409);
  });

  it('checks the allocation list before writing: distinct lines, known vehicles, two decimals; a client id travels', async () => {
    const { f } = setup();
    const id = IDS.opportunity.ic;
    const put = (b: object): Promise<Answer> =>
      send(f, USERS.deal.externalId, 'PUT', `${path(id)}/allocations`, b);
    const duplicate = await put({
      allocations: [
        { vehicleId: IDS.vehicle, requested: '1.00' },
        { vehicleId: IDS.vehicle, requested: '2.00' },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect(problemDetails.parse(duplicate.json).errors?.[0]?.path).toBe('allocations.1');
    const unknown = await put({ allocations: [{ vehicleId: NO_SUCH_ID, requested: '1.00' }] });
    expect(problemDetails.parse(unknown.json).errors).toEqual([
      { path: 'allocations.0.vehicleId', message: 'Unknown vehicle' },
    ]);
    expect(
      (await put({ allocations: [{ vehicleId: IDS.vehicle, requested: '1.005' }] })).status,
    ).toBe(400);
    expect(
      (await put({ allocations: [{ vehicleId: IDS.vehicle, requested: '-1.00' }] })).status,
    ).toBe(400);
    const withClient = detailOf(
      await put({
        allocations: [{ vehicleId: IDS.vehicle, clientId: IDS.client, requested: '1.00' }],
      }),
    );
    expect(withClient.allocations).toHaveLength(1);
    expect(withClient.allocations[0]?.client).toEqual({ id: IDS.client, name: 'Not visible' });
    expect(detailOf(await put({ allocations: [] })).allocations).toEqual([]);
  });

  it('adds a task beside the template ones for the deal team only, with a known workstream and owner', async () => {
    const { f } = setup();
    const id = IDS.opportunity.sourced;
    const body = {
      workstream: 'diligence_workstream.references',
      title: 'Customer reference calls',
      ownerId: USERS.ops2.userId,
      dueDate: AS_OF,
      requiredForIc: true,
    };
    const add = (who: string, b: object): Promise<Answer> =>
      send(f, who, 'POST', `${path(id)}/diligence-tasks`, b);
    expect((await add(USERS.ops.externalId, body)).status).toBe(403);
    expect((await add(USERS.deal.externalId, { ...body, workstream: 'nope' })).status).toBe(400);
    const unknownOwner = await add(USERS.deal.externalId, { ...body, ownerId: NO_SUCH_ID });
    expect(unknownOwner.status).toBe(400);
    expect(problemDetails.parse(unknownOwner.json).errors).toEqual([
      { path: 'ownerId', message: 'Unknown user' },
    ]);
    const before = detailOf(await send(f, USERS.deal.externalId, 'GET', path(id))).gates.diligence
      .requiredOpen;
    const added = await add(USERS.deal.externalId, body);
    expect(added.status).toBe(201);
    const detail = opportunityDetail.parse(added.json);
    expect(detail.diligenceTasks.find((t) => t.title === body.title)).toMatchObject({
      workstream: body.workstream,
      owner: { id: USERS.ops2.userId, name: USERS.ops2.displayName },
      dueDate: AS_OF,
      status: 'open',
      requiredForIc: true,
    });
    expect(detail.gates.diligence.requiredOpen).toBe(before + 1);
    // The board row of a changed deal keeps its shape.
    const row: OpportunityRow | undefined = opportunityPage
      .parse((await send(f, USERS.viewer.externalId, 'GET', LIST)).json)
      .items.find((o) => o.id === id);
    expect(row?.stage).toBe('Sourced');
  });
});
