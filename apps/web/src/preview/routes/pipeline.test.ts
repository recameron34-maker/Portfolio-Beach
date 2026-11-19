import { beforeEach, describe, expect, it } from 'vitest';
import {
  closingDetail,
  diligenceTemplateFor,
  investmentDetail,
  investmentPage,
  opportunityDetail,
  opportunityFit,
  opportunityPage,
  problemDetails,
} from '@pb/contracts';
import type { ClosingDetail, DealStage, OpportunityDetail, OpportunityRow } from '@pb/contracts';
import { dealStageMachine, forbiddenPairs } from '@pb/workflows';
import type { PreviewFixtures, PreviewUser } from '../fixtures.js';
import { getKey } from '../keys.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState, SimDocument } from '../state.js';
import { AS_OF, IDS, USERS, buildWorld, problemOf, send, testBook } from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';
import { linesShownTo } from './closings.js';
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
      IDS.opportunity.reopened,
      IDS.opportunity.ic,
      IDS.opportunity.passed,
      IDS.opportunity.closingOpen,
      IDS.opportunity.closed,
    ]);
    expect(
      opportunityPage.parse((await send(f, USERS.dealWall.externalId, 'GET', LIST)).json).items,
    ).toHaveLength(7);
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
      diligence: { requiredOpen: 0, ok: true, carriedOver: 0 },
      icDecision: { ok: true },
      closing: {
        checklistComplete: false,
        allocationTiedOut: true,
        confirmed: false,
        ok: false,
      },
    });
    const sourced = detailOf(
      await send(f, USERS.viewer.externalId, 'GET', path(IDS.opportunity.sourced)),
    );
    expect(sourced.gates.diligence).toEqual({ requiredOpen: 4, ok: false, carriedOver: 0 });
    // The closed deal: its closing is confirmed, and only then does the gate read clear.
    expect(
      detailOf(await send(f, USERS.viewer.externalId, 'GET', path(IDS.opportunity.closed))).gates
        .closing,
    ).toEqual({ checklistComplete: true, allocationTiedOut: true, confirmed: true, ok: true });
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

describe('portfolio fit (docs/08 section 8): the answer of the API, never worked out here', () => {
  const fitPath = (id: string): string => `${path(id)}/fit`;

  it('answers a recorded deal what the API answered the caller, as of the recorded date only', async () => {
    const { f } = setup();
    const answer = await send(f, USERS.viewer.externalId, 'GET', fitPath(IDS.opportunity.ic));
    expect(answer.status, answer.text).toBe(200);
    const fit = opportunityFit.parse(answer.json);
    expect(fit.opportunityId).toBe(IDS.opportunity.ic);
    expect(fit.asOf).toBe(AS_OF);
    expect(fit.measures).toHaveLength(7);
    // The recording is replayed as it is: it is the API's answer, not a simulated one.
    expect(answer.headers.get('x-pb-simulated')).toBeNull();

    const same = await send(
      f,
      USERS.viewer.externalId,
      'GET',
      `${fitPath(IDS.opportunity.ic)}?asOf=${AS_OF}`,
    );
    expect(same.status).toBe(200);
    const other = await send(
      f,
      USERS.viewer.externalId,
      'GET',
      `${fitPath(IDS.opportunity.ic)}?asOf=2024-12-31`,
    );
    expect(other.status).toBe(404);
    expect(problemOf(other).detail).toBe('This request is outside the recorded preview');
    const bad = await send(
      f,
      USERS.viewer.externalId,
      'GET',
      `${fitPath(IDS.opportunity.ic)}?asOf=yesterday`,
    );
    expect(bad.status).toBe(400);
  });

  it('follows the wall of the deal and answers 404 for a deal that does not exist', async () => {
    const { f } = setup();
    const outside = await send(f, USERS.deal.externalId, 'GET', fitPath(IDS.opportunity.walled));
    expect(outside.status).toBe(404);
    expect(problemOf(outside).detail).not.toContain(IDS.opportunity.walled);
    const member = await send(f, USERS.dealWall.externalId, 'GET', fitPath(IDS.opportunity.walled));
    expect(opportunityFit.parse(member.json).opportunityId).toBe(IDS.opportunity.walled);
    expect((await send(f, USERS.viewer.externalId, 'GET', fitPath(NO_SUCH_ID))).status).toBe(404);
  });

  it('says a deal created in the preview has no fit recorded (501), and logs no miss for it', async () => {
    const { f } = setup();
    const created = opportunityDetail.parse(
      (
        await send(f, USERS.deal.externalId, 'POST', '/api/v1/opportunities', {
          name: 'Project Fitless',
          companyName: 'Fitless Holdings',
          sponsorId: IDS.sponsor,
          dealType: CO_INVEST,
          receivedDate: AS_OF,
        })
      ).json,
    );
    const answer = await send(f, USERS.deal.externalId, 'GET', fitPath(created.id));
    expect(answer.status).toBe(501);
    expect(problemOf(answer).detail).toBe(
      'Portfolio fit is worked out by the API; a deal created in this preview has none recorded',
    );
    expect(window.__pbPreviewMisses).toEqual([]);
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
      carriedOver: 0,
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
    expect(reopened.gates.diligence).toEqual({ requiredOpen: 0, ok: true, carriedOver: 0 });

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
    // The tie-out sums what was received: a requested amount never stands in for a received one.
    const requestedOnly = {
      allocations: [
        { vehicleId: IDS.vehicle, requested: '10000000.00', received: '10000000.00' },
        { vehicleId: IDS.vehicle2, requested: '5000000.00' },
      ],
    };
    expect(
      (await send(f, USERS.viewer.externalId, 'PUT', `${path(id)}/allocations`, requestedOnly))
        .status,
    ).toBe(403);
    const partly = detailOf(
      await send(f, USERS.deal.externalId, 'PUT', `${path(id)}/allocations`, requestedOnly),
    );
    expect(partly.allocations.map((a) => [a.vehicle.name, a.requested, a.received])).toEqual([
      ['Test Vehicle I', '10000000.00', '10000000.00'],
      ['Test Vehicle II', '5000000.00', null],
    ]);
    expect(partly.closing?.allocationTieOut).toEqual({
      commitment: '15000000.00',
      allocated: '10000000.00',
      difference: '-5000000.00',
      tiedOut: false,
      hiddenLines: 0,
    });
    expect(partly.gates.closing).toEqual({
      checklistComplete: true,
      allocationTiedOut: false,
      confirmed: false,
      ok: false,
    });
    expect(
      problemOf(
        await send(f, USERS.ops.externalId, 'POST', `${closingPath}/commands`, {
          command: 'confirm',
        }),
      ).detail,
    ).toBe('closing: received amounts are missing on 1 line (M22)');
    const allocations = {
      allocations: [
        { vehicleId: IDS.vehicle, requested: '10000000.00', received: '10000000.00' },
        { vehicleId: IDS.vehicle2, requested: '5000000.00', received: '5000000.00' },
      ],
    };
    const allocated = detailOf(
      await send(f, USERS.deal.externalId, 'PUT', `${path(id)}/allocations`, allocations),
    );
    expect(allocated.closing?.allocationTieOut).toEqual({
      commitment: '15000000.00',
      allocated: '15000000.00',
      difference: '0.00',
      tiedOut: true,
      hiddenLines: 0,
    });
    expect(allocated.gates.closing).toEqual({
      checklistComplete: true,
      allocationTiedOut: true,
      confirmed: false,
      ok: false,
    });
    // The checklist is in and the lines tie: Closing to Closed still waits for the confirmation.
    const unconfirmed = await run(USERS.ops.externalId, { command: 'advance' });
    expect(unconfirmed.status).toBe(422);
    expect(problemOf(unconfirmed)).toEqual({
      code: 'workflow-precondition',
      detail: 'the closing is not confirmed by operations (M8)',
    });
    const confirmed = closingDetail.parse(
      (
        await send(f, USERS.ops.externalId, 'POST', `${closingPath}/commands`, {
          command: 'confirm',
        })
      ).json,
    );
    expect(confirmed.state).toBe('OpsConfirmed');
    expect(detailOf(await send(f, USERS.deal.externalId, 'GET', path(id))).gates.closing).toEqual({
      checklistComplete: true,
      allocationTiedOut: true,
      confirmed: true,
      ok: true,
    });

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
    // The stamp is a write to the closing row: opened at 1, confirmed at 2, stamped at 3.
    expect(
      closingDetail.parse((await send(f, USERS.viewer.externalId, 'GET', closingPath)).json),
    ).toMatchObject({ investmentId, state: 'OpsConfirmed', rowVersion: 3 });
    expect((await run(USERS.ops.externalId, { command: 'advance' })).status).toBe(409);
    const fixed = await send(
      f,
      USERS.ops.externalId,
      'PUT',
      `${path(id)}/allocations`,
      allocations,
    );
    expect(fixed.status).toBe(422);
    expect(problemOf(fixed).detail).toBe(
      'allocations are fixed once the deal is closed (M22); raise a change request instead',
    );
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

/** The people who walk a deal in the tests below: the deal team member, the approver and operations. */
interface Cast {
  team: PreviewUser;
  approver: PreviewUser;
  ops: PreviewUser;
}
const CAST: Cast = { team: USERS.deal, approver: USERS.head, ops: USERS.ops };
const COMMITMENT = '15000000.00';

/** The walk of a deal through the simulated API, step by step, as the API's own tests walk it. */
function walker(f: typeof fetch) {
  const post = (who: PreviewUser, p: string, b: object): Promise<Answer> =>
    send(f, who.externalId, 'POST', p, b);
  const detail = async (who: PreviewUser, id: string): Promise<OpportunityDetail> =>
    detailOf(await send(f, who.externalId, 'GET', path(id)));
  const command = (who: PreviewUser, id: string, b: object): Promise<Answer> =>
    post(who, commands(id), b);
  const advance = async (
    who: PreviewUser,
    id: string,
    extra: object = {},
  ): Promise<OpportunityDetail> =>
    detailOf(await command(who, id, { command: 'advance', ...extra }));
  const create = async (label: string, cast: Cast = CAST): Promise<OpportunityDetail> => {
    const answer = await post(cast.team, '/api/v1/opportunities', {
      name: `Project ${label}`,
      companyName: `${label} Holdings Co`,
      sponsorId: IDS.sponsor,
      sponsorFundId: IDS.fund,
      dealType: CO_INVEST,
      receivedDate: AS_OF,
      targetCommitment: COMMITMENT,
    });
    expect(answer.status, answer.text).toBe(201);
    return opportunityDetail.parse(answer.json);
  };
  const decide = (
    who: PreviewUser,
    id: string,
    decisionDate: string,
    decision = 'approved',
  ): Promise<Answer> =>
    post(who, `${path(id)}/ic-decisions`, {
      decisionDate,
      decision,
      amount: COMMITMENT,
      conditions: [],
    });
  /** Every open task required for IC is completed. */
  const completeRequired = async (id: string, cast: Cast): Promise<void> => {
    for (const t of (await detail(cast.team, id)).diligenceTasks.filter(
      (x) => x.requiredForIc && x.status === 'open',
    ))
      expect(
        (
          await post(cast.team, `${path(id)}/diligence-tasks/${t.id}/commands`, {
            command: 'complete',
          })
        ).status,
      ).toBe(200);
  };
  /** Sourced to IC: the template tasks required for IC are completed on the way. */
  const toIc = async (id: string, cast: Cast = CAST): Promise<OpportunityDetail> => {
    await advance(cast.team, id);
    await advance(cast.team, id);
    expect((await advance(cast.team, id)).stage).toBe('Diligence');
    await completeRequired(id, cast);
    const ic = await advance(cast.team, id);
    expect(ic.stage).toBe('IC');
    return ic;
  };
  /** Sourced to Approved, the decision dated the day before the as-of date. */
  const toApproved = async (id: string, cast: Cast = CAST): Promise<OpportunityDetail> => {
    await toIc(id, cast);
    expect((await decide(cast.approver, id, '2025-06-29')).status).toBe(201);
    const approved = await advance(cast.approver, id);
    expect(approved.stage).toBe('Approved');
    return approved;
  };
  /** Approved to Closing with the closing opened for the as-of date and the commitment. */
  const openClosing = async (id: string, cast: Cast = CAST): Promise<string> => {
    const opportunity = await advance(cast.team, id, {
      closeDate: AS_OF,
      commitmentAmount: COMMITMENT,
    });
    expect(opportunity.stage).toBe('Closing');
    return opportunity.closing?.id ?? '';
  };
  const closing = async (who: PreviewUser, closingId: string): Promise<ClosingDetail> => {
    const answer = await send(f, who.externalId, 'GET', `/api/v1/closings/${closingId}`);
    expect(answer.status, answer.text).toBe(200);
    return closingDetail.parse(answer.json);
  };
  const closingCommand = (who: PreviewUser, closingId: string, b: object): Promise<Answer> =>
    post(who, `/api/v1/closings/${closingId}/commands`, b);
  /** Every required item received with the hub document. */
  const receiveRequired = async (closingId: string, cast: Cast = CAST): Promise<void> => {
    for (const i of (await closing(cast.ops, closingId)).items.filter(
      (x) => x.required && x.status === 'open',
    ))
      expect(
        (
          await post(cast.ops, `/api/v1/closings/${closingId}/items/${i.itemCode}/commands`, {
            command: 'receive',
            documentId: IDS.document,
          })
        ).status,
      ).toBe(200);
  };
  /** One vehicle line, requested and received in full, so the lines tie to the amount. */
  const allocateInFull = async (id: string, amount: string, cast: Cast = CAST): Promise<void> => {
    expect(
      (
        await send(f, cast.team.externalId, 'PUT', `${path(id)}/allocations`, {
          allocations: [{ vehicleId: IDS.vehicle, requested: amount, received: amount }],
        })
      ).status,
    ).toBe(200);
  };
  /** Closing to a closing confirmed by operations. */
  const confirm = async (
    id: string,
    closingId: string,
    cast: Cast = CAST,
  ): Promise<ClosingDetail> => {
    await receiveRequired(closingId, cast);
    await allocateInFull(id, COMMITMENT, cast);
    const answer = await closingCommand(cast.ops, closingId, { command: 'confirm' });
    expect(answer.status, answer.text).toBe(200);
    return closingDetail.parse(answer.json);
  };
  /** Passed, reopened and walked back to IC: Screening, Prescreen, Diligence (the tasks stay as they were), IC. */
  const passAndReturnToIc = async (id: string, cast: Cast = CAST): Promise<OpportunityDetail> => {
    expect(
      (
        await command(cast.team, id, {
          command: 'pass',
          passReasonCode: 'pass_reason.other',
          note: 'The sponsor withdrew the allocation',
        })
      ).status,
    ).toBe(200);
    const reopened = detailOf(
      await command(cast.team, id, {
        command: 'reopen',
        reason: 'the sponsor came back with the allocation',
      }),
    );
    expect(reopened.stage).toBe('Screening');
    await advance(cast.team, id);
    await advance(cast.team, id);
    const ic = await advance(cast.team, id);
    expect(ic.stage).toBe('IC');
    return ic;
  };
  return {
    post,
    detail,
    command,
    advance,
    create,
    decide,
    completeRequired,
    toApproved,
    openClosing,
    closing,
    closingCommand,
    allocateInFull,
    confirm,
    passAndReturnToIc,
  };
}

describe('a deal that was passed and reopened (docs/18 section 4)', () => {
  it('serves the recorded gates of a reopened deal: the tasks done before the reopen are carried over and the first round approval is not the gate', async () => {
    const { f } = setup();
    const w = walker(f);
    const id = IDS.opportunity.reopened;
    const recorded = await w.detail(USERS.viewer, id);
    expect(recorded.stage).toBe('IC');
    expect(recorded.icDecisions.map((d) => d.decision)).toEqual(['approved']);
    expect(recorded.gates).toEqual({
      diligence: { requiredOpen: 0, ok: true, carriedOver: 4 },
      icDecision: { ok: false },
      closing: {
        checklistComplete: false,
        allocationTiedOut: false,
        confirmed: false,
        ok: false,
      },
    });
    const refused = await w.command(USERS.head, id, { command: 'advance' });
    expect(refused.status).toBe(422);
    expect(problemOf(refused)).toEqual({
      code: 'workflow-precondition',
      detail: 'deal_stage: an IC decision record is required',
    });
    // A task reopened and done again is this round's work: one fewer is carried over.
    const task = recorded.diligenceTasks.find((t) => t.requiredForIc);
    const taskPath = `${path(id)}/diligence-tasks/${task?.id ?? ''}/commands`;
    expect(
      detailOf(await w.post(USERS.deal, taskPath, { command: 'reopen' })).gates.diligence,
    ).toEqual({ requiredOpen: 1, ok: false, carriedOver: 3 });
    expect(
      detailOf(await w.post(USERS.deal, taskPath, { command: 'complete' })).gates.diligence,
    ).toEqual({ requiredOpen: 0, ok: true, carriedOver: 3 });
    // A decision of this round opens the gate, even one dated before the first round's.
    const decided = await w.decide(USERS.head, id, '2025-05-10');
    expect(decided.status).toBe(201);
    expect(opportunityDetail.parse(decided.json).gates.icDecision.ok).toBe(true);
    expect((await w.advance(USERS.head, id)).stage).toBe('Approved');
  });

  it('needs a new IC decision: one recorded before the pass no longer opens Approved, and the tasks done before it are counted as carried over', async () => {
    const { f } = setup();
    const w = walker(f);
    const id = (await w.create('Tidewater')).id;
    const approved = await w.toApproved(id);
    expect(approved.gates.icDecision.ok).toBe(true);
    expect(approved.gates.diligence).toEqual({ requiredOpen: 0, ok: true, carriedOver: 0 });
    const required = approved.diligenceTasks.filter((t) => t.requiredForIc).length;
    expect(required).toBeGreaterThan(0);

    const ic = await w.passAndReturnToIc(id);
    // The decision of the first round is still on record, and no longer the gate's.
    expect(ic.icDecisions).toHaveLength(1);
    expect(ic.icDecisions[0]?.decision).toBe('approved');
    expect(ic.gates.icDecision.ok).toBe(false);
    // The work was done, so the tasks stay done; the gate says they predate the reopen.
    expect(ic.gates.diligence).toEqual({ requiredOpen: 0, ok: true, carriedOver: required });
    const refused = await w.command(CAST.approver, id, { command: 'advance' });
    expect(refused.status).toBe(422);
    expect(problemOf(refused).detail).toBe('deal_stage: an IC decision record is required');
    expect((await w.detail(CAST.team, id)).stage).toBe('IC');

    // A decision of this round opens the gate again; a declined one does not.
    expect((await w.decide(CAST.approver, id, AS_OF, 'declined')).status).toBe(201);
    expect((await w.command(CAST.approver, id, { command: 'advance' })).status).toBe(422);
    const decided = opportunityDetail.parse((await w.decide(CAST.approver, id, '2025-07-01')).json);
    expect(decided.icDecisions).toHaveLength(3);
    expect(decided.gates.icDecision.ok).toBe(true);
    expect((await w.advance(CAST.approver, id)).stage).toBe('Approved');
  });

  it('shows no IC decision as the gate between the reopen and the next IC, whatever was recorded before the pass', async () => {
    const { f } = setup();
    const w = walker(f);
    const id = (await w.create('Saltmarsh')).id;
    await w.toApproved(id);
    expect(
      (await w.command(CAST.team, id, { command: 'pass', passReasonCode: 'pass_reason.other' }))
        .status,
    ).toBe(200);
    const reopened = detailOf(
      await w.command(CAST.team, id, { command: 'reopen', reason: 'reopened to look again' }),
    );
    expect(reopened.stage).toBe('Screening');
    expect(reopened.gates.icDecision.ok).toBe(false);
    expect(reopened.icDecisions).toHaveLength(1);
  });

  it('reaching Closing again rewrites the closing, returns a confirmed one to Open and needs confirmation again before Closed', async () => {
    const { f, state } = setup();
    const w = walker(f);
    const id = (await w.create('Longshore')).id;
    await w.toApproved(id);
    const closingId = await w.openClosing(id);
    const confirmed = await w.confirm(id, closingId);
    expect(confirmed).toMatchObject({ state: 'OpsConfirmed', rowVersion: 2 });
    expect((await w.detail(CAST.team, id)).gates.closing.ok).toBe(true);
    const receivedBefore = confirmed.items.filter((i) => i.status === 'received').length;
    expect(receivedBefore).toBeGreaterThan(0);

    await w.passAndReturnToIc(id);
    // Passed and reopened, the closing is still what operations confirmed: its lines stay frozen.
    expect(
      problemOf(
        await send(f, CAST.team.externalId, 'PUT', `${path(id)}/allocations`, { allocations: [] }),
      ).detail,
    ).toBe('the closing is confirmed; change the close date or ask operations to reopen it');
    expect((await w.decide(CAST.approver, id, AS_OF)).status).toBe(201);
    await w.advance(CAST.approver, id);

    // The deal team opens the closing again with a new date and a new commitment.
    const newDate = '2025-06-27';
    const newCommitment = '12000000.00';
    const back = await w.advance(CAST.team, id, {
      closeDate: newDate,
      commitmentAmount: newCommitment,
    });
    expect(back.stage).toBe('Closing');
    expect(back.closing).toMatchObject({
      id: closingId,
      closeDate: newDate,
      commitmentAmount: newCommitment,
      state: 'Open',
      opsConfirmedBy: null,
      opsConfirmedAt: null,
    });
    expect(back.gates.closing).toEqual({
      checklistComplete: true,
      allocationTiedOut: false,
      confirmed: false,
      ok: false,
    });
    // The change is on the activity list with who made it and why the confirmation was cleared.
    expect(state.audit.find((e) => e.action === 'closing.reuse')).toMatchObject({
      entity: 'closing',
      entityId: closingId,
      actorId: CAST.team.userId,
      from: 'OpsConfirmed',
      to: 'Open',
      reason:
        'The deal reached Closing again with a new close date and commitment; operations confirm again',
    });

    // The documents are still on file: received items stay received; the record moved once more.
    const reopened = await w.closing(CAST.ops, closingId);
    expect(reopened.items).toEqual(confirmed.items);
    expect(reopened.itemsRequiredOpen).toBe(0);
    expect(reopened.rowVersion).toBe(3);

    // Closing to Closed waits for the tie-out against the new commitment and a new confirmation.
    const untied = await w.command(CAST.ops, id, { command: 'advance' });
    expect(untied.status).toBe(422);
    expect(problemOf(untied).detail).toBe(
      'deal_stage: allocations do not tie to the closing commitment (M22)',
    );
    await w.allocateInFull(id, newCommitment);
    const unconfirmed = await w.command(CAST.ops, id, { command: 'advance' });
    expect(unconfirmed.status).toBe(422);
    expect(problemOf(unconfirmed).detail).toBe('the closing is not confirmed by operations (M8)');
    expect((await w.detail(CAST.team, id)).stage).toBe('Closing');
    expect((await w.closingCommand(CAST.ops, closingId, { command: 'confirm' })).status).toBe(200);
    const closed = await w.advance(CAST.ops, id);
    expect(closed.stage).toBe('Closed');
    const position = investmentDetail.parse(
      (
        await send(
          f,
          CAST.ops.externalId,
          'GET',
          `/api/v1/investments/${closed.investmentId ?? ''}`,
        )
      ).json,
    );
    expect(position).toMatchObject({ entryDate: newDate, closeDate: newDate });
  });

  it('reaching Closing again with a closing that was never confirmed rewrites the date and commitment and leaves it Open', async () => {
    const { f, state } = setup();
    const w = walker(f);
    const id = (await w.create('Driftline')).id;
    await w.toApproved(id);
    const closingId = await w.openClosing(id);
    await w.passAndReturnToIc(id);
    expect((await w.decide(CAST.approver, id, AS_OF)).status).toBe(201);
    await w.advance(CAST.approver, id);
    const back = await w.advance(CAST.team, id, {
      closeDate: '2025-07-10',
      commitmentAmount: '9000000.00',
    });
    expect(back.closing).toMatchObject({
      id: closingId,
      closeDate: '2025-07-10',
      commitmentAmount: '9000000.00',
      state: 'Open',
    });
    expect(state.audit.find((e) => e.action === 'closing.reuse')).toMatchObject({
      from: 'Open',
      to: 'Open',
      reason: null,
    });
    // One closing record for the deal, opened once.
    expect(state.audit.filter((e) => e.action === 'closing.open')).toHaveLength(1);
    expect((await w.closing(CAST.ops, closingId)).rowVersion).toBe(2);
  });
});

describe('a walled deal that converts (SEC-5.3)', () => {
  it('puts the position behind the wall of its deal: a non-member gets 404 on it and does not see it on the grid, a member does', async () => {
    const { f } = setup();
    const w = walker(f);
    const id = IDS.opportunity.walled;
    // A member of the wall who holds every role walks the walled deal from Diligence to Closed.
    const member: Cast = { team: USERS.all, approver: USERS.all, ops: USERS.all };
    await w.completeRequired(id, member);
    expect((await w.advance(USERS.all, id)).stage).toBe('IC');
    expect((await w.decide(USERS.all, id, AS_OF)).status).toBe(201);
    await w.advance(USERS.all, id);
    const closingId = await w.openClosing(id, member);
    await w.confirm(id, closingId, member);
    const closed = await w.advance(USERS.all, id);
    expect(closed.stage).toBe('Closed');
    const investmentId = closed.investmentId ?? '';
    const position = `/api/v1/investments/${investmentId}`;
    const grid = async (who: PreviewUser): Promise<string[]> =>
      investmentPage
        .parse((await send(f, who.externalId, 'GET', '/api/v1/investments?limit=100')).json)
        .items.map((i) => i.id);

    for (const who of [USERS.all, USERS.dealWall, USERS.head]) {
      expect((await send(f, who.externalId, 'GET', position)).status, who.externalId).toBe(200);
      expect(await grid(who)).toContain(investmentId);
    }
    for (const who of [USERS.viewer, USERS.deal, USERS.ops]) {
      const hidden = await send(f, who.externalId, 'GET', position);
      expect(hidden.status, who.externalId).toBe(404);
      expect(problemOf(hidden)).toEqual({ code: 'not-found', detail: 'Investment not found' });
      expect(await grid(who)).not.toContain(investmentId);
      // Its closing follows the deal too.
      expect((await send(f, who.externalId, 'GET', `/api/v1/closings/${closingId}`)).status).toBe(
        404,
      );
    }
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('carries no wall for a deal that has none: the position of a recorded or a new deal is open to every reader', async () => {
    const { f } = setup();
    const w = walker(f);
    const id = (await w.create('Open Water')).id;
    await w.toApproved(id);
    const closingId = await w.openClosing(id);
    await w.confirm(id, closingId);
    const closed = await w.advance(CAST.ops, id);
    for (const who of [USERS.viewer, USERS.dealWall, USERS.admin])
      expect(
        (await send(f, who.externalId, 'GET', `/api/v1/investments/${closed.investmentId ?? ''}`))
          .status,
        who.externalId,
      ).toBe(200);
    // The recorded Closing deal has no wall either: once closed, every reader opens its position.
    expect(
      (
        await w.post(
          USERS.ops,
          `/api/v1/closings/${IDS.closing.open}/items/wire_confirmation/commands`,
          { command: 'receive', documentId: IDS.document },
        )
      ).status,
    ).toBe(200);
    expect(
      (await w.closingCommand(USERS.ops, IDS.closing.open, { command: 'confirm' })).status,
    ).toBe(200);
    const recordedClosed = await w.advance(USERS.ops, IDS.opportunity.closingOpen);
    expect(recordedClosed.stage).toBe('Closed');
    for (const who of [USERS.viewer, USERS.deal, USERS.admin])
      expect(
        (
          await send(
            f,
            who.externalId,
            'GET',
            `/api/v1/investments/${recordedClosed.investmentId ?? ''}`,
          )
        ).status,
        who.externalId,
      ).toBe(200);
  });
});

/*
 * The client-level allocation lines of a deal (review finding D1-06, migration 0017): the API
 * answers each reader the lines that reader may read, with the totals and the tie-out of every
 * line and the number of lines not shown. The simulation holds the lines of a deal once and must
 * answer each reader the same way: from the recordings, and after a simulated replace.
 */
describe('client allocation lines per reader (D1-06)', () => {
  const alpha = { id: '77000000-0000-4000-8000-0000000000a1', name: 'Alpha Pension Trust' };
  const beta = { id: '77000000-0000-4000-8000-0000000000a2', name: 'Beta Endowment' };
  const vehicle = { id: IDS.vehicle, name: 'Test Vehicle I' };
  const ir: PreviewUser = {
    externalId: 'ir.one',
    userId: '40000000-0000-4000-8000-000000000021',
    displayName: 'Test Investor Relations',
    roles: ['investor_relations'],
  };
  const auditor: PreviewUser = {
    externalId: 'audit.one',
    userId: '40000000-0000-4000-8000-000000000022',
    displayName: 'Test Auditor',
    roles: ['auditor'],
  };
  /** Who reads every client, who reads Alpha alone, who reads none. */
  const everyLine = [USERS.deal, USERS.ops, USERS.head, auditor];
  const entitled = (who: PreviewUser): string[] => (who === ir ? [alpha.id] : []);
  const dealId = IDS.opportunity.closingOpen;
  const closingPath = `/api/v1/closings/${IDS.closing.open}`;

  /** The lines of the recorded deal in Closing: a vehicle line and a line for each client, tying out to 2,000,000.00. */
  const recordedLines: OpportunityDetail['allocations'] = [
    {
      id: '77000000-0000-4000-8000-0000000000b1',
      vehicle,
      client: null,
      requested: '1000000.00',
      received: '1000000.00',
    },
    {
      id: '77000000-0000-4000-8000-0000000000b2',
      vehicle,
      client: alpha,
      requested: '600000.00',
      received: '600000.00',
    },
    {
      id: '77000000-0000-4000-8000-0000000000b3',
      vehicle,
      client: beta,
      requested: '400000.00',
      received: '400000.00',
    },
  ];

  /**
   * The test world with the recorded Closing deal answered per reader the way the API answers it:
   * the lines the reader may read, the totals of all three and the number not shown. The viewer,
   * who is shown no client line, is the first user of the recordings.
   */
  function perReaderWorld(): PreviewFixtures {
    const world = buildWorld();
    const fx = world.fixtures;
    const record = (credential: string, path: string, body: unknown): void => {
      const key = `d106-${Object.keys(fx.bodies).length}`;
      fx.bodies[key] = JSON.stringify(body);
      fx.responses[getKey(credential, path)] = {
        status: 200,
        contentType: 'application/json',
        body: key,
      };
    };
    const deal = world.opportunities.find((d) => d.id === dealId)!;
    const closing = world.closings.find((c) => c.id === IDS.closing.open)!;
    fx.users.push(ir, auditor);
    expect(fx.users[0]?.externalId).toBe(USERS.viewer.externalId);
    for (const who of [USERS.viewer, ...everyLine, ir]) {
      const c = who.externalId;
      const all = everyLine.includes(who);
      const shown = recordedLines.filter(
        (l) => l.client === null || all || entitled(who).includes(l.client.id),
      );
      const hiddenLines = recordedLines.length - shown.length;
      if (who === ir || who === auditor)
        record(c, '/api/v1/auth/me', {
          userId: who.userId,
          externalId: c,
          displayName: who.displayName,
          roles: who.roles,
          clientIds: entitled(who),
          mockIdentity: true,
        });
      const tieOut = { ...closing.allocationTieOut, hiddenLines };
      record(c, path(dealId), {
        ...deal,
        allocations: shown,
        allocationTotals: {
          lines: 3,
          hiddenLines,
          requested: '2000000.00',
          received: '2000000.00',
          missingReceived: 0,
        },
        closing: { ...deal.closing, allocationTieOut: tieOut },
      });
      record(c, closingPath, { ...closing, allocations: shown, allocationTieOut: tieOut });
      record(c, '/api/v1/vehicles', {
        items: [
          {
            id: vehicle.id,
            name: vehicle.name,
            vehicleType: 'vehicle_type.co_invest',
            vintage: 2022,
            activeInvestments: 5,
            lpCommitmentsTotal: null,
          },
        ],
      });
      // The client look-through: every client for the roles that read them all, the entitled one for investor relations.
      const clients = [alpha, beta].filter((cl) => all || entitled(who).includes(cl.id));
      record(c, '/api/v1/clients', {
        asOf: AS_OF,
        items: clients.map((cl) => ({
          id: cl.id,
          name: cl.name,
          reportingBases: ['reporting_basis.gross'],
          reportingCadence: 'reporting_cadence.quarterly',
          vehicles: [],
          totals: {
            commitment: null,
            invested: null,
            distributions: null,
            nav: null,
            grossMoic: null,
          },
        })),
        calcVersion: '0.1.0',
      });
    }
    return fx;
  }

  function open(): typeof fetch {
    return createPreviewFetch(perReaderWorld(), never, {
      env,
      state: createPreviewState(),
      book: testBook(),
    });
  }
  const read = async (f: typeof fetch, who: PreviewUser): Promise<OpportunityDetail> =>
    detailOf(await send(f, who.externalId, 'GET', path(dealId)));
  const readClosing = async (f: typeof fetch, who: PreviewUser): Promise<ClosingDetail> => {
    const answer = await send(f, who.externalId, 'GET', closingPath);
    expect(answer.status, answer.text).toBe(200);
    return closingDetail.parse(answer.json);
  };
  const clientsOf = (d: { allocations: OpportunityDetail['allocations'] }): (string | null)[] =>
    d.allocations.map((a) => a.client?.name ?? null);

  it('seeds a deal from the recording that shows every line and answers each reader the lines that reader may read', async () => {
    const f = open();
    const totals = {
      lines: 3,
      requested: '2000000.00',
      received: '2000000.00',
      missingReceived: 0,
    };
    const tied = {
      commitment: '2000000.00',
      allocated: '2000000.00',
      difference: '0.00',
      tiedOut: true,
    };
    // The viewer's recording comes first and holds no client line: the deal still has all three.
    for (const who of everyLine) {
      const seen = await read(f, who);
      expect(clientsOf(seen), who.externalId).toEqual([null, alpha.name, beta.name]);
      expect(seen.allocationTotals, who.externalId).toEqual({ ...totals, hiddenLines: 0 });
      expect(seen.closing?.allocationTieOut, who.externalId).toEqual({ ...tied, hiddenLines: 0 });
    }
    const viewer = await read(f, USERS.viewer);
    expect(clientsOf(viewer)).toEqual([null]);
    expect(viewer.allocationTotals).toEqual({ ...totals, hiddenLines: 2 });
    expect(viewer.closing?.allocationTieOut).toEqual({ ...tied, hiddenLines: 2 });
    const own = await read(f, ir);
    expect(clientsOf(own)).toEqual([null, alpha.name]);
    expect(own.allocationTotals).toEqual({ ...totals, hiddenLines: 1 });
    expect(own.closing?.allocationTieOut).toEqual({ ...tied, hiddenLines: 1 });
    // The gates are the deal's, and the closing detail agrees with the opportunity for each reader.
    for (const who of [USERS.viewer, ir, ...everyLine]) {
      const seen = await read(f, who);
      const record = await readClosing(f, who);
      expect(seen.gates, who.externalId).toEqual(viewer.gates);
      expect(record.allocations, who.externalId).toEqual(seen.allocations);
      expect(record.allocationTieOut, who.externalId).toEqual(seen.closing?.allocationTieOut);
    }
    // A platform admin does not read the pipeline at all, as in the API.
    expect((await send(f, USERS.admin.externalId, 'GET', path(dealId))).status).toBe(403);
  });

  it('filters and counts the same way after a simulated replace of the lines, with the totals of every line', async () => {
    const f = open();
    const saved = detailOf(
      await send(f, USERS.ops.externalId, 'PUT', `${path(dealId)}/allocations`, {
        allocations: [
          { vehicleId: vehicle.id, requested: '500000.00', received: '500000.00' },
          {
            vehicleId: vehicle.id,
            clientId: alpha.id,
            requested: '900000.00',
            received: '900000.00',
          },
          { vehicleId: vehicle.id, clientId: beta.id, requested: '600000.00' },
        ],
      }),
    );
    const totals = {
      lines: 3,
      requested: '2000000.00',
      received: '1400000.00',
      missingReceived: 1,
    };
    const short = {
      commitment: '2000000.00',
      allocated: '1400000.00',
      difference: '-600000.00',
      tiedOut: false,
    };
    // The writer reads back every line it wrote, the client lines with their client named.
    expect(clientsOf(saved)).toEqual([null, alpha.name, beta.name]);
    expect(saved.allocationTotals).toEqual({ ...totals, hiddenLines: 0 });
    expect(saved.closing?.allocationTieOut).toEqual({ ...short, hiddenLines: 0 });
    for (const who of everyLine) {
      const seen = await read(f, who);
      expect(seen.allocations, who.externalId).toEqual(saved.allocations);
      expect(seen.allocationTotals, who.externalId).toEqual(saved.allocationTotals);
    }
    // A viewer: the vehicle line, two lines not shown, and the tie-out of all three, not of one.
    const viewer = await read(f, USERS.viewer);
    expect(clientsOf(viewer)).toEqual([null]);
    expect(viewer.allocations[0]).toMatchObject({ requested: '500000.00', received: '500000.00' });
    expect(viewer.allocationTotals).toEqual({ ...totals, hiddenLines: 2 });
    expect(viewer.closing?.allocationTieOut).toEqual({ ...short, hiddenLines: 2 });
    expect(viewer.gates).toEqual(saved.gates);
    expect(viewer.gates.closing.allocationTiedOut).toBe(false);
    // Investor relations: the vehicle line and the line of the client it is entitled to.
    const own = await read(f, ir);
    expect(clientsOf(own)).toEqual([null, alpha.name]);
    expect(own.allocationTotals).toEqual({ ...totals, hiddenLines: 1 });
    expect(own.closing?.allocationTieOut).toEqual({ ...short, hiddenLines: 1 });
    for (const who of [USERS.viewer, ir, auditor]) {
      const seen = await read(f, who);
      const record = await readClosing(f, who);
      expect(record.allocations, who.externalId).toEqual(seen.allocations);
      expect(record.allocationTieOut, who.externalId).toEqual(seen.closing?.allocationTieOut);
    }
  });

  it('shows a reader whose entitlements are not known no client line (fail closed)', () => {
    const reader = { userId: ir.userId, externalId: 'ir.unknown', displayName: 'Unknown' };
    expect(
      linesShownTo({ ...reader, roles: ['investor_relations'] }, recordedLines).map((l) => l.id),
    ).toEqual([recordedLines[0]?.id]);
    expect(
      linesShownTo(
        { ...reader, roles: ['investor_relations'], clientIds: [beta.id] },
        recordedLines,
      ).map((l) => l.client?.name ?? null),
    ).toEqual([null, beta.name]);
    for (const role of ['operations', 'deal_team', 'approver', 'auditor'])
      expect(linesShownTo({ ...reader, roles: [role] }, recordedLines), role).toHaveLength(3);
    for (const role of ['viewer', 'platform_admin', 'service'])
      expect(linesShownTo({ ...reader, roles: [role] }, recordedLines), role).toHaveLength(1);
  });
});
