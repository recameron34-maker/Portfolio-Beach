import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  problemDetails,
  valuationBatchResult,
  valuationDetail,
  valuationLockText,
  valuationPage,
  valuationRow,
} from '@pb/contracts';
import type { ValuationDetail, ValuationRow } from '@pb/contracts';
import { getKey } from '../keys.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { IDS, USERS, buildWorld, problemOf, send } from '../test-fixtures.js';
import type { Answer, World } from '../test-fixtures.js';
import { lockHashOf } from './valuations.js';

/**
 * The valuation detail, the edit of a Draft and the batch screen (docs/04 M10, docs/18 section
 * 1), and journey 3 of docs/12 simulated end to end through the shim: operations prepares, the
 * deal team sends back and approves, the approver locks, then reopens into a new Draft version
 * that operations corrects and takes to its own lock.
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

function setup(world: World = buildWorld()): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  return { f: createPreviewFetch(world.fixtures, never, { env, state }), state };
}

/** SHA-256 as the API takes it (node:crypto), to check the simulation's SubtleCrypto digest against. */
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const detailOf = async (f: typeof fetch, who: string, id: string): Promise<ValuationDetail> =>
  valuationDetail.parse((await send(f, who, 'GET', detailPath(id))).json);

const boardOf = async (f: typeof fetch, who: string): Promise<ValuationRow[]> =>
  valuationPage.parse((await send(f, who, 'GET', '/api/v1/valuations?limit=200')).json).items;

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('GET /api/v1/valuations/{id}', () => {
  it('serves the recorded trail, the inputs, the open change requests of the position and the lock text once Locked', async () => {
    const { f } = setup();
    const locked = await send(f, USERS.ops.externalId, 'GET', detailPath(IDS.valuation.Locked));
    expect(locked.status).toBe(200);
    expect(locked.headers.get('x-pb-simulated')).toBe('true');
    const detail = valuationDetail.parse(locked.json);
    expect(detail.approvals.map((a) => [a.step, a.decision])).toEqual([
      ['ops_prepared', 'approve'],
      ['deal_team', 'approve'],
      ['final', 'approve'],
    ]);
    // No recorded version has method inputs; the lock text says so and hashes to the recorded hash.
    expect(detail.inputs).toEqual({});
    expect(detail.lockText).toBe(valuationLockText(detail));
    expect(detail.lockText).toContain('"inputs":{}');
    expect(sha256(detail.lockText ?? '')).toBe(detail.lockHash);
    // The InProgress request of the position is open; the Applied one is not.
    expect(detail.openChangeRequests.map((r) => r.id)).toEqual([IDS.changeRequest.inProgress]);
    const draft = await detailOf(f, USERS.viewer.externalId, IDS.valuation.Draft);
    expect(draft.approvals).toEqual([]);
    expect(draft.inputs).toEqual({});
    expect(draft.lockText).toBeNull();
  });

  it('lists the open change requests for the roles the change request routes serve, and for nobody else (CR-5)', async () => {
    const { f } = setup();
    for (const who of [USERS.deal, USERS.ops, USERS.head, USERS.all])
      expect(
        (await detailOf(f, who.externalId, IDS.valuation.Locked)).openChangeRequests.map(
          (r) => r.id,
        ),
        who.externalId,
      ).toEqual([IDS.changeRequest.inProgress]);
    // A viewer reads the version, never the requests GET /change-requests refuses them.
    const viewer = await detailOf(f, USERS.viewer.externalId, IDS.valuation.Locked);
    expect(viewer.openChangeRequests).toEqual([]);
    expect(viewer.fairValue).toBe('1100.00');
    expect(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/change-requests?limit=200')).status,
    ).toBe(403);
  });

  it('builds the detail of a recorded version from its list row when no detail was recorded: the lock text hashes to the recorded hash (VAL-6)', async () => {
    // The build records the detail of the first positions only (scripts/preview-plan.mjs).
    const world = buildWorld();
    for (const id of [IDS.valuation.Locked, IDS.valuation.Reopened])
      for (const user of Object.values(USERS))
        delete world.fixtures.responses[getKey(user.externalId, detailPath(id))];
    const { f } = setup(world);
    const row = world.valuations.find((r) => r.id === IDS.valuation.Locked);
    const locked = await detailOf(f, USERS.viewer.externalId, IDS.valuation.Locked);
    expect(locked).toMatchObject({
      state: 'Locked',
      inputs: {},
      // The API holds no decision rows for a seeded version either: the people are on the row.
      approvals: [],
      preparedBy: USERS.ops.displayName,
      dealTeamApprovedBy: USERS.deal.displayName,
      approvedBy: USERS.head.displayName,
      approvedAt: '2025-01-20T12:00:00Z',
      lockHash: row?.lockHash,
    });
    expect(locked.lockHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(locked.lockText ?? '')).toBe(locked.lockHash);
    // A Reopened version keeps the hash it was locked with; the text is served for Locked only.
    const reopened = await detailOf(f, USERS.viewer.externalId, IDS.valuation.Reopened);
    expect(reopened.lockText).toBeNull();
    expect(reopened.lockHash).toBe(sha256(valuationLockText(reopened)));
    expect(window.__pbPreviewMisses).toEqual([]);
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
    // The hash is taken at the lock, over what the version holds then: none before (as the API).
    expect(await detailOf(f, USERS.viewer.externalId, created.id)).toMatchObject({
      state: 'DealTeamApproved',
      lockHash: null,
    });
    const locked = valuationRow.parse((await run(USERS.head.externalId, { command: 'lock' })).json);
    expect(locked).toMatchObject({ state: 'Locked', approvedBy: USERS.head.displayName });
    const inputs = { source: 'sponsor letter' };
    expect(locked.lockHash).toBe(await lockHashOf({ ...locked, inputs }));
    expect(locked.lockHash).not.toBe(await lockHashOf({ ...locked, inputs: {} }));

    const detail = await detailOf(f, USERS.deal.externalId, created.id);
    expect(detail.approvals.map((a) => [a.step, a.decision, a.actorName])).toEqual([
      ['ops_prepared', 'approve', USERS.ops.displayName],
      ['deal_team', 'reject', USERS.deal.displayName],
      ['ops_prepared', 'approve', USERS.ops.displayName],
      ['deal_team', 'approve', USERS.deal.displayName],
      ['final', 'approve', USERS.head.displayName],
    ]);
    expect(detail.approvals[1]?.reason).toBe('Check the multiple against the latest comps');
    // The lock covers the inputs the version was created with (VAL-2), and verifies with
    // node:crypto as it would against the API.
    expect(detail.inputs).toEqual(inputs);
    expect(detail.lockText).toBe(valuationLockText({ ...locked, inputs }));
    expect(detail.lockText).toContain('"inputs":{"source":"sponsor letter"}');
    expect(sha256(detail.lockText ?? '')).toBe(locked.lockHash);
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
    const next = await detailOf(f, USERS.viewer.externalId, draft.id);
    expect(next.approvals).toEqual([]);
    // The new Draft starts with the inputs of the version it reopens (docs/18 section 1).
    expect(next.inputs).toEqual(inputs);
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

    // The edit after lock (VAL-1): operations corrects the new Draft, then it takes its own path.
    const again = (who: string, body: unknown): Promise<Answer> =>
      send(f, who, 'POST', commandPath(draft.id), body);
    const corrected = await send(f, USERS.ops.externalId, 'PATCH', detailPath(draft.id), {
      fairValue: '1250.5',
      inputs: { source: 'restated sponsor letter', multiple: 11.5 },
    });
    expect(corrected.status).toBe(200);
    expect(valuationRow.parse(corrected.json)).toMatchObject({
      state: 'Draft',
      fairValue: '1250.50',
      method: locked.method,
      rowVersion: 2,
    });
    expect((await again(USERS.ops.externalId, { command: 'prepare' })).status).toBe(200);
    expect((await again(USERS.deal.externalId, { command: 'dealTeamApprove' })).status).toBe(200);
    const relocked = valuationRow.parse(
      (await again(USERS.head.externalId, { command: 'lock' })).json,
    );
    expect(relocked).toMatchObject({ state: 'Locked', version: 2, fairValue: '1250.50' });
    expect(relocked.lockHash).not.toBe(locked.lockHash);
    const relockedDetail = await detailOf(f, USERS.viewer.externalId, draft.id);
    expect(relockedDetail.lockText).toBe(
      `{"fairValue":"1250.50","inputs":{"multiple":11.5,"source":"restated sponsor letter"},"investmentId":"${IDS.open}","method":"valuation_method.sponsor_mark","periodEnd":"2025-06-30","version":2}`,
    );
    expect(sha256(relockedDetail.lockText ?? '')).toBe(relocked.lockHash);
    // The Reopened version keeps the figure and the hash it was locked with.
    expect(await detailOf(f, USERS.viewer.externalId, created.id)).toMatchObject({
      state: 'Reopened',
      fairValue: '1200.00',
      lockHash: locked.lockHash,
      inputs,
    });
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

describe('PATCH /api/v1/valuations/{id}: the edit of a Draft (VAL-1)', () => {
  const patch = (
    f: typeof fetch,
    who: string,
    id: string,
    body: unknown,
    extra: Record<string, string> = {},
  ): Promise<Answer> => send(f, who, 'PATCH', detailPath(id), body, extra);

  it('lets operations correct the method, the value and the inputs of a Draft: each kept unless sent, the row version up, no approval row', async () => {
    const { f, state } = setup();
    const id = IDS.valuation.Draft;
    const before = await detailOf(f, USERS.ops.externalId, id);
    expect(before).toMatchObject({ state: 'Draft', inputs: {}, rowVersion: 1 });

    const byValue = await patch(
      f,
      USERS.ops.externalId,
      id,
      { fairValue: '1300.5' },
      { 'if-match': '"1"' },
    );
    expect(byValue.status).toBe(200);
    expect(byValue.headers.get('etag')).toBe('"2"');
    expect(byValue.headers.get('x-pb-simulated')).toBe('true');
    // The value reads back as the column stores it (two decimals), as the API answers.
    expect(valuationRow.parse(byValue.json)).toMatchObject({
      id,
      state: 'Draft',
      method: before.method,
      fairValue: '1300.50',
      rowVersion: 2,
    });

    const byMethod = valuationRow.parse(
      (
        await patch(f, USERS.ops2.externalId, id, {
          method: 'valuation_method.market_multiple',
          inputs: { multiple: 11.5, basis: 'LTM EBITDA' },
        })
      ).json,
    );
    expect(byMethod).toMatchObject({
      method: 'valuation_method.market_multiple',
      fairValue: '1300.50',
      rowVersion: 3,
    });
    expect(await detailOf(f, USERS.deal.externalId, id)).toMatchObject({
      state: 'Draft',
      method: 'valuation_method.market_multiple',
      fairValue: '1300.50',
      inputs: { multiple: 11.5, basis: 'LTM EBITDA' },
      // An edit approves nothing: the trail stays empty and nothing is locked.
      approvals: [],
      lockHash: null,
      lockText: null,
      rowVersion: 3,
    });
    // Inputs replace the stored ones whole; an empty record clears them.
    expect((await patch(f, USERS.ops.externalId, id, { inputs: { basis: 'NTM' } })).status).toBe(
      200,
    );
    expect((await detailOf(f, USERS.ops.externalId, id)).inputs).toEqual({ basis: 'NTM' });
    expect((await patch(f, USERS.ops.externalId, id, { inputs: {} })).status).toBe(200);
    expect((await detailOf(f, USERS.ops.externalId, id)).inputs).toEqual({});
    // The board lists the corrected version.
    expect((await boardOf(f, USERS.viewer.externalId)).find((r) => r.id === id)).toMatchObject({
      fairValue: '1300.50',
      method: 'valuation_method.market_multiple',
      rowVersion: 5,
    });
    expect(state.audit.map((e) => [e.actorExternalId, e.action, e.from, e.to])).toEqual([
      ['ops.one', 'valuation.edit', 'Draft', 'Draft'],
      ['ops.two', 'valuation.edit', 'Draft', 'Draft'],
      ['ops.one', 'valuation.edit', 'Draft', 'Draft'],
      ['ops.one', 'valuation.edit', 'Draft', 'Draft'],
    ]);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('answers what the API answers when it refuses: 403 by role, 404 unseen, 400 naming the field, 412 stale, 409 outside Draft', async () => {
    const { f, state } = setup();
    const id = IDS.valuation.Draft;
    for (const who of [USERS.viewer, USERS.deal, USERS.dealWall, USERS.head, USERS.admin])
      expect(
        (await patch(f, who.externalId, id, { fairValue: '5.00' })).status,
        who.externalId,
      ).toBe(403);
    // An unknown id, and a version behind a wall the operator is outside of: not found, no hint.
    for (const unseen of [NIL, IDS.valuation.walled]) {
      const answer = await patch(f, USERS.ops.externalId, unseen, { fairValue: '5.00' });
      expect(answer.status).toBe(404);
      expect(problemOf(answer)).toEqual({ code: 'not-found', detail: 'Valuation not found' });
    }
    const MONEY = 'An amount above zero: at most 18 digits before the decimal point and two after';
    const cases: [unknown, string, string][] = [
      [{}, '(root)', 'Give at least one of method, fairValue and inputs'],
      [{ fairValue: '0' }, 'fairValue', 'Must be above zero'],
      [{ fairValue: '0.00' }, 'fairValue', 'Must be above zero'],
      [{ fairValue: '5.005' }, 'fairValue', MONEY],
      [{ fairValue: '-5.00' }, 'fairValue', MONEY],
      [{ fairValue: `1${'9'.repeat(18)}` }, 'fairValue', MONEY],
      [{ method: 'sponsor_mark' }, 'method', 'Not a valuation_method code'],
      [{ method: 'deal_type.cv_single_asset' }, 'method', 'Not a valuation_method code'],
    ];
    for (const [body, path, message] of cases) {
      const answer = await patch(f, USERS.ops.externalId, id, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      const refused = problemDetails.parse(answer.json);
      expect(refused.type, JSON.stringify(body)).toMatch(/\/validation$/);
      expect(refused.detail).toBe('Invalid body');
      expect(refused.errors, JSON.stringify(body)).toEqual([{ path, message }]);
      // The problem names the field, never the value sent.
      expect(answer.text).not.toContain('5.005');
    }
    for (const body of [
      { fairValue: 5 },
      { method: '' },
      { inputs: { flag: true } },
      { fairValue: '5.00', state: 'Locked' },
      { periodEnd: '2025-03-31' },
    ])
      expect((await patch(f, USERS.ops.externalId, id, body)).status, JSON.stringify(body)).toBe(
        400,
      );

    const stale = await patch(
      f,
      USERS.ops.externalId,
      id,
      { fairValue: '5.00' },
      { 'if-match': '"999"' },
    );
    expect(stale.status).toBe(412);
    expect(problemOf(stale).code).toBe('stale-row-version');

    // Only a Draft can be edited: every other state is 409 in the API's words, and keeps its values.
    for (const from of ['OpsPrepared', 'DealTeamApproved', 'Locked', 'Reopened'] as const) {
      const target = IDS.valuation[from];
      const before = await detailOf(f, USERS.ops.externalId, target);
      const answer = await patch(f, USERS.ops.externalId, target, {
        fairValue: '7.00',
        inputs: { late: 1 },
      });
      expect(answer.status, from).toBe(409);
      expect(problemOf(answer), from).toEqual({
        code: 'workflow-transition',
        detail: `valuation: edit is not allowed from ${from}; only a Draft can be edited`,
      });
      expect(await detailOf(f, USERS.ops.externalId, target)).toEqual(before);
      // A stale row version is refused first, as the API checks it before the state.
      expect(
        (
          await patch(
            f,
            USERS.ops.externalId,
            target,
            { fairValue: '7.00' },
            { 'if-match': '"999"' },
          )
        ).status,
        from,
      ).toBe(412);
    }
    expect(await detailOf(f, USERS.ops.externalId, id)).toMatchObject({
      fairValue: '1100.00',
      rowVersion: 1,
      inputs: {},
    });
    expect(state.audit).toEqual([]);
  });

  it('refuses a fair value the column could not store on create too, naming the field with the contract message (VAL-3)', async () => {
    const { f } = setup();
    const create = (fairValue: string): Promise<Answer> =>
      send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', {
        investmentId: IDS.open,
        periodEnd: '2025-06-30',
        method: 'valuation_method.sponsor_mark',
        fairValue,
      });
    const third = await create('10.005');
    expect(third.status).toBe(400);
    expect(problemDetails.parse(third.json).errors).toEqual([
      {
        path: 'fairValue',
        message: 'An amount above zero: at most 18 digits before the decimal point and two after',
      },
    ]);
    expect(problemDetails.parse((await create('0.00')).json).errors).toEqual([
      { path: 'fairValue', message: 'Must be above zero' },
    ]);
    // What is stored is what was sent, read back with the column's two decimals.
    expect(valuationRow.parse((await create('10.5')).json).fairValue).toBe('10.50');
  });
});

describe('the prior Locked mark after a reopen (VAL-5)', () => {
  it('drops the prior mark and the change of the next quarter while the reopened quarter has no Locked version, and reads the corrected mark once it locks', async () => {
    const { f } = setup();
    const post = (who: string, id: string, body: unknown): Promise<Answer> =>
      send(f, who, 'POST', commandPath(id), body);
    // A Draft for the latest quarter, against the recorded Locked mark of the quarter before.
    const june = valuationRow.parse(
      (
        await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', {
          investmentId: IDS.open,
          periodEnd: '2025-06-30',
          method: 'valuation_method.sponsor_mark',
          fairValue: '1200.00',
        })
      ).json,
    );
    expect(june).toMatchObject({ priorFairValue: '1000.00', changePct: '0.2' });

    // The prior quarter's Locked version is reopened: no Locked mark stands for it any more.
    const reopened = await post(USERS.head.externalId, IDS.valuation.openPrior, {
      command: 'reopen',
      reason: 'Sponsor restated Q1',
    });
    expect(reopened.status).toBe(200);
    const march = valuationRow.parse(reopened.json);
    expect(march).toMatchObject({ periodEnd: '2025-03-31', version: 2, state: 'Draft' });
    const listed = async (who: string): Promise<ValuationRow | undefined> =>
      (await boardOf(f, who)).find((r) => r.id === june.id);
    for (const who of [USERS.viewer.externalId, USERS.ops.externalId])
      expect(await listed(who), who).toMatchObject({ priorFairValue: null, changePct: null });
    expect(await detailOf(f, USERS.viewer.externalId, june.id)).toMatchObject({
      priorFairValue: null,
      changePct: null,
    });
    // A command on the next quarter's version answers with the mark as it now stands, too.
    expect(
      valuationRow.parse((await post(USERS.ops.externalId, june.id, { command: 'prepare' })).json),
    ).toMatchObject({ state: 'OpsPrepared', priorFairValue: null, changePct: null });

    // The corrected version of the prior quarter locks: the next quarter reads the new mark.
    expect(
      (
        await send(f, USERS.ops.externalId, 'PATCH', detailPath(march.id), {
          fairValue: '960.00',
        })
      ).status,
    ).toBe(200);
    expect((await post(USERS.ops.externalId, march.id, { command: 'prepare' })).status).toBe(200);
    expect((await listed(USERS.viewer.externalId))?.priorFairValue).toBeNull();
    expect(
      (await post(USERS.deal.externalId, march.id, { command: 'dealTeamApprove' })).status,
    ).toBe(200);
    expect((await post(USERS.head.externalId, march.id, { command: 'lock' })).status).toBe(200);
    for (const who of [USERS.viewer.externalId, USERS.head.externalId])
      expect(await listed(who), who).toMatchObject({ priorFairValue: '960.00', changePct: '0.25' });
    expect(await detailOf(f, USERS.viewer.externalId, june.id)).toMatchObject({
      priorFairValue: '960.00',
      changePct: '0.25',
    });
    expect(window.__pbPreviewMisses).toEqual([]);
  });
});
