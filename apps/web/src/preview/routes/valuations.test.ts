import { beforeEach, describe, expect, it } from 'vitest';
import {
  valuationBatchResult,
  valuationDetail,
  valuationLockText,
  valuationPage,
  valuationRow,
} from '@pb/contracts';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { IDS, USERS, buildWorld, problemOf, send } from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';
import { lockHashOf } from './valuations.js';

/**
 * The valuation detail and the batch screen (docs/04 M10, docs/18 section 1), and journey 3 of
 * docs/12 simulated end to end through the shim: operations prepares, the deal team sends back
 * and approves, the approver locks, then reopens into a new Draft version.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const NIL = '00000000-0000-4000-8000-000000000000';
const detailPath = (id: string): string => `/api/v1/valuations/${id}`;
const commandPath = (id: string): string => `/api/v1/valuations/${id}/commands`;

let ids = 0;
const env = {
  newId: (): string => `51000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

function setup(): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  return { f: createPreviewFetch(buildWorld().fixtures, never, { env, state }), state };
}

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('GET /api/v1/valuations/{id}', () => {
  it('serves the recorded trail, the open change requests of the position and the lock text once Locked', async () => {
    const { f } = setup();
    const locked = await send(f, USERS.viewer.externalId, 'GET', detailPath(IDS.valuation.Locked));
    expect(locked.status).toBe(200);
    expect(locked.headers.get('x-pb-simulated')).toBe('true');
    const detail = valuationDetail.parse(locked.json);
    expect(detail.approvals.map((a) => [a.step, a.decision])).toEqual([
      ['ops_prepared', 'approve'],
      ['deal_team', 'approve'],
      ['final', 'approve'],
    ]);
    expect(detail.lockText).toBe(valuationLockText(detail));
    // The InProgress request of the position is open; the Applied one is not.
    expect(detail.openChangeRequests.map((r) => r.id)).toEqual([IDS.changeRequest.inProgress]);
    const draft = valuationDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', detailPath(IDS.valuation.Draft))).json,
    );
    expect(draft.approvals).toEqual([]);
    expect(draft.lockText).toBeNull();
  });

  it('is 404 outside the wall and for an unknown id, 403 for a role the route does not name', async () => {
    const { f } = setup();
    expect(
      (await send(f, USERS.viewer.externalId, 'GET', detailPath(IDS.valuation.walled))).status,
    ).toBe(404);
    expect((await send(f, USERS.ops.externalId, 'GET', detailPath(NIL))).status).toBe(404);
    const member = valuationDetail.parse(
      (await send(f, USERS.dealWall.externalId, 'GET', detailPath(IDS.valuation.walled))).json,
    );
    expect(member.openChangeRequests.map((r) => r.id)).toEqual([IDS.changeRequest.walled]);
    expect(
      (await send(f, USERS.admin.externalId, 'GET', detailPath(IDS.valuation.Locked))).status,
    ).toBe(403);
  });
});

describe('POST /api/v1/valuations/batch-commands', () => {
  it('runs the command id by id, never stopping at a refusal, one result per id in the order sent', async () => {
    const { f, state } = setup();
    const post = (who: string, body: unknown): Promise<Answer> =>
      send(f, who, 'POST', '/api/v1/valuations/batch-commands', body);
    expect(
      (await post(USERS.ops.externalId, { command: 'dealTeamApprove', ids: [IDS.valuation.Draft] }))
        .status,
    ).toBe(403);
    expect(
      (await post(USERS.deal.externalId, { command: 'prepare', ids: [IDS.valuation.Draft] }))
        .status,
    ).toBe(400);
    const batch = valuationBatchResult.parse(
      (
        await post(USERS.deal.externalId, {
          command: 'dealTeamApprove',
          ids: [IDS.valuation.OpsPrepared, IDS.valuation.Draft, IDS.valuation.Locked, NIL],
        })
      ).json,
    );
    expect(batch.results.map((r) => [r.id, r.ok, r.state ?? r.problem?.status])).toEqual([
      [IDS.valuation.OpsPrepared, true, 'DealTeamApproved'],
      [IDS.valuation.Draft, false, 409],
      [IDS.valuation.Locked, false, 409],
      [NIL, false, 404],
    ]);
    expect(batch.results[1]?.problem?.code).toBe('workflow-transition');
    expect(batch.results[1]?.problem?.detail).toBe(
      'valuation: dealTeamApprove is not allowed from Draft',
    );
    expect(state.audit.map((e) => e.action)).toEqual(['valuation.dealTeamApprove']);
    // The deal team may call the route but cannot lock: a 403 per row, not for the batch.
    const refused = valuationBatchResult.parse(
      (await post(USERS.deal.externalId, { command: 'lock', ids: [IDS.valuation.OpsPrepared] }))
        .json,
    );
    expect(refused.results[0]?.problem?.status).toBe(403);
    const locked = valuationBatchResult.parse(
      (await post(USERS.head.externalId, { command: 'lock', ids: [IDS.valuation.OpsPrepared] }))
        .json,
    );
    expect(locked.results[0]).toEqual({ id: IDS.valuation.OpsPrepared, ok: true, state: 'Locked' });
    const board = valuationPage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/valuations?limit=200')).json,
    );
    expect(board.items.find((r) => r.id === IDS.valuation.OpsPrepared)?.state).toBe('Locked');
  });
});

describe('journey 3: prepare, approve, lock, then an edit after lock', () => {
  it('walks the full path with a send back, shows the trail and the lock text, and reopens into a new Draft', async () => {
    const { f, state } = setup();
    const created = valuationRow.parse(
      (
        await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', {
          investmentId: IDS.open,
          periodEnd: '2025-06-30',
          method: 'valuation_method.sponsor_mark',
          fairValue: '1200.00',
          inputs: { source: 'sponsor letter' },
        })
      ).json,
    );
    const run = (who: string, body: unknown): Promise<Answer> =>
      send(f, who, 'POST', commandPath(created.id), body);
    expect((await run(USERS.ops.externalId, { command: 'prepare' })).status).toBe(200);
    const sentBack = valuationRow.parse(
      (
        await run(USERS.deal.externalId, {
          command: 'sendBack',
          reason: 'Check the multiple against the latest comps',
        })
      ).json,
    );
    expect(sentBack).toMatchObject({ state: 'Draft', preparedBy: USERS.ops.displayName });
    expect((await run(USERS.ops.externalId, { command: 'prepare' })).status).toBe(200);
    expect((await run(USERS.deal.externalId, { command: 'dealTeamApprove' })).status).toBe(200);
    const locked = valuationRow.parse((await run(USERS.head.externalId, { command: 'lock' })).json);
    expect(locked).toMatchObject({ state: 'Locked', approvedBy: USERS.head.displayName });
    expect(locked.lockHash).toBe(await lockHashOf(locked));

    const detail = valuationDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', detailPath(created.id))).json,
    );
    expect(detail.approvals.map((a) => [a.step, a.decision, a.actorName])).toEqual([
      ['ops_prepared', 'approve', USERS.ops.displayName],
      ['deal_team', 'reject', USERS.deal.displayName],
      ['ops_prepared', 'approve', USERS.ops.displayName],
      ['deal_team', 'approve', USERS.deal.displayName],
      ['final', 'approve', USERS.head.displayName],
    ]);
    expect(detail.approvals[1]?.reason).toBe('Check the multiple against the latest comps');
    expect(detail.lockText).toBe(valuationLockText(locked));
    expect(detail.openChangeRequests.map((r) => r.id)).toEqual([IDS.changeRequest.submitted]);

    // Reopen: a reason and a role from the table; the answer is the new Draft version.
    expect((await run(USERS.head.externalId, { command: 'reopen' })).status).toBe(422);
    expect(
      (await run(USERS.deal.externalId, { command: 'reopen', reason: 'Sponsor restated Q2' }))
        .status,
    ).toBe(403);
    const reopened = await run(USERS.head.externalId, {
      command: 'reopen',
      reason: 'Sponsor restated Q2',
    });
    expect(reopened.status).toBe(200);
    const draft = valuationRow.parse(reopened.json);
    expect(draft).toMatchObject({
      state: 'Draft',
      version: 2,
      periodEnd: '2025-06-30',
      method: locked.method,
      fairValue: locked.fairValue,
      preparedBy: null,
      lockHash: null,
      rowVersion: 1,
    });
    expect(reopened.headers.get('etag')).toBe('"1"');
    const prior = valuationDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', detailPath(created.id))).json,
    );
    expect(prior).toMatchObject({
      state: 'Reopened',
      reopenReason: 'Sponsor restated Q2',
      lockHash: locked.lockHash,
      lockText: null,
    });
    expect(prior.approvals.at(-1)).toMatchObject({
      step: 'reopen',
      decision: 'reopen',
      reason: 'Sponsor restated Q2',
      actorName: USERS.head.displayName,
    });
    const next = valuationDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', detailPath(draft.id))).json,
    );
    expect(next.approvals).toEqual([]);
    const board = valuationPage.parse(
      (
        await send(
          f,
          USERS.viewer.externalId,
          'GET',
          `/api/v1/valuations?investmentId=${IDS.open}&limit=200`,
        )
      ).json,
    );
    expect(
      board.items.filter((r) => r.periodEnd === '2025-06-30').map((r) => [r.version, r.state]),
    ).toEqual(
      expect.arrayContaining([
        [1, 'Reopened'],
        [2, 'Draft'],
      ]),
    );
    expect(state.audit.map((e) => `${e.actorExternalId}:${e.action}`)).toEqual([
      'ops.one:valuation.create',
      'ops.one:valuation.prepare',
      'deal.one:valuation.sendBack',
      'ops.one:valuation.prepare',
      'deal.one:valuation.dealTeamApprove',
      'head.one:valuation.lock',
      'head.one:valuation.reopen',
      'head.one:valuation.create',
    ]);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('refuses a stale If-Match (412) and keeps the preparer from approving (SEC-5.6)', async () => {
    const { f } = setup();
    const stale = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commandPath(IDS.valuation.Draft),
      { command: 'prepare' },
      { 'if-match': '"999"' },
    );
    expect(stale.status).toBe(412);
    const own = await send(
      f,
      USERS.all.externalId,
      'POST',
      commandPath(IDS.valuation.OpsPrepared),
      {
        command: 'dealTeamApprove',
      },
    );
    expect(own.status).toBe(422);
    expect(problemOf(own).detail).toContain('preparer');
  });
});
