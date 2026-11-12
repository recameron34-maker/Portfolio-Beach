import { beforeEach, describe, expect, it } from 'vitest';
import {
  changeRequestPage,
  changeRequestRow,
  dataExceptionPage,
  problemDetails,
  quarterEndCheckResult,
} from '@pb/contracts';
import type { ChangeRequestRow, ChangeRequestState } from '@pb/contracts';
import { dealChangeRequestMachine, forbiddenPairs } from '@pb/workflows';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { IDS, USERS, buildWorld, problemOf, send } from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';

/**
 * The simulated deal change requests (docs/04 M11, docs/18 section 8): the queue under the
 * position's wall, the one form, the path through route, start and apply or reject, and the
 * quarter-end check opening data exceptions on the Data Health queue.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const LIST = '/api/v1/change-requests?limit=200';
const path = (id: string): string => `/api/v1/change-requests/${id}`;
const commands = (id: string): string => `${path(id)}/commands`;
const CHECK = '/api/v1/change-requests/quarter-end-check';
const OWNER = USERS.ops;
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000dead';

let ids = 0;
let clock = 0;
const env = {
  newId: (): string => `54000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  // Each call a second later, so creation times order the queue.
  now: (): string =>
    `2025-07-01T09:${String(Math.floor(++clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}.000Z`,
};

function setup(): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  return { f: createPreviewFetch(buildWorld().fixtures, never, { env, state }), state };
}

const form = (investmentId: string, extra: object = {}): object => ({
  investmentId,
  changeType: 'change_type.add_on_acquisition',
  effectiveDate: '2025-06-30',
  summary: 'Add-on acquisition of a regional competitor closed',
  details: { target: 'A regional competitor' },
  ...extra,
});

async function create(f: typeof fetch, who = USERS.deal.externalId): Promise<ChangeRequestRow> {
  const answer = await send(f, who, 'POST', '/api/v1/change-requests', form(IDS.open));
  expect(answer.status, answer.text).toBe(201);
  return changeRequestRow.parse(answer.json);
}

async function command(
  f: typeof fetch,
  who: string,
  id: string,
  body: object,
): Promise<ChangeRequestRow> {
  const answer = await send(f, who, 'POST', commands(id), body);
  expect(answer.status, answer.text).toBe(200);
  return changeRequestRow.parse(answer.json);
}

/** A fresh request moved to the state named, through the simulated API. */
async function inState(f: typeof fetch, state: ChangeRequestState): Promise<ChangeRequestRow> {
  const made = await create(f);
  if (state === 'Submitted') return made;
  const routed = await command(f, USERS.deal.externalId, made.id, {
    command: 'route',
    ownerId: OWNER.userId,
  });
  if (state === 'Routed') return routed;
  if (state === 'Rejected')
    return command(f, OWNER.externalId, made.id, {
      command: 'reject',
      reason: 'Already reflected in the record',
    });
  const started = await command(f, OWNER.externalId, made.id, { command: 'start' });
  if (state === 'InProgress') return started;
  return command(f, OWNER.externalId, made.id, { command: 'apply', appliedPeriod: '2025-06-30' });
}

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('the simulated change request queue', () => {
  it('lists what the caller may see, newest first, filtered by state and position; the wall hides a request; a viewer has no queue', async () => {
    const { f } = setup();
    const ops = changeRequestPage.parse((await send(f, OWNER.externalId, 'GET', LIST)).json);
    expect(ops.items.map((r) => r.id)).toEqual([
      IDS.changeRequest.submitted,
      IDS.changeRequest.inProgress,
      IDS.changeRequest.applied,
    ]);
    const member = changeRequestPage.parse(
      (await send(f, USERS.dealWall.externalId, 'GET', LIST)).json,
    );
    expect(member.items.map((r) => r.id)).toContain(IDS.changeRequest.walled);
    expect(
      changeRequestPage
        .parse((await send(f, OWNER.externalId, 'GET', `${LIST}&state=InProgress`)).json)
        .items.map((r) => r.id),
    ).toEqual([IDS.changeRequest.inProgress]);
    expect(
      changeRequestPage
        .parse((await send(f, OWNER.externalId, 'GET', `${LIST}&investmentId=${IDS.states}`)).json)
        .items.map((r) => r.id),
    ).toEqual([IDS.changeRequest.inProgress, IDS.changeRequest.applied]);
    expect(
      changeRequestPage.parse(
        (await send(f, OWNER.externalId, 'GET', `${LIST}&investmentId=${IDS.walled}`)).json,
      ).items,
    ).toEqual([]);
    expect((await send(f, OWNER.externalId, 'GET', `${LIST}&state=bogus`)).status).toBe(400);
    expect((await send(f, USERS.viewer.externalId, 'GET', LIST)).status).toBe(403);
    expect(
      (await send(f, USERS.viewer.externalId, 'GET', path(IDS.changeRequest.submitted))).status,
    ).toBe(403);
    expect((await send(f, OWNER.externalId, 'GET', path(IDS.changeRequest.walled))).status).toBe(
      404,
    );
    expect((await send(f, OWNER.externalId, 'GET', path(NO_SUCH_ID))).status).toBe(404);
    expect(
      changeRequestRow.parse(
        (await send(f, USERS.head.externalId, 'GET', path(IDS.changeRequest.inProgress))).json,
      ).owner,
    ).toEqual({ id: OWNER.userId, name: OWNER.displayName });
  });

  it('submits from the one form (201, the row version as ETag), audited; refuses an unseen position and the roles without the form', async () => {
    const { f, state } = setup();
    const res = await send(
      f,
      USERS.deal.externalId,
      'POST',
      '/api/v1/change-requests',
      form(IDS.open),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    const made = changeRequestRow.parse(res.json);
    expect(made).toMatchObject({
      investmentId: IDS.open,
      investmentName: 'Company 0001',
      changeType: 'change_type.add_on_acquisition',
      summary: 'Add-on acquisition of a regional competitor closed',
      details: { target: 'A regional competitor' },
      owner: null,
      submittedBy: { id: USERS.deal.userId, name: USERS.deal.displayName },
      state: 'Submitted',
      appliedPeriod: null,
      rowVersion: 1,
    });
    expect(state.audit.map((e) => e.action)).toEqual(['change_request.create']);
    expect(
      changeRequestRow.parse((await send(f, USERS.deal.externalId, 'GET', path(made.id))).json),
    ).toEqual(made);
    // The queue lists it first; operations may submit too, and the details default to an empty form.
    const byOps = changeRequestRow.parse(
      (
        await send(
          f,
          USERS.ops2.externalId,
          'POST',
          '/api/v1/change-requests',
          form(IDS.open, { details: undefined }),
        )
      ).json,
    );
    expect(byOps.details).toEqual({});
    expect(
      changeRequestPage
        .parse((await send(f, OWNER.externalId, 'GET', LIST)).json)
        .items.slice(0, 2)
        .map((r) => r.id),
    ).toEqual([byOps.id, made.id]);
    expect(
      (await send(f, USERS.deal.externalId, 'POST', '/api/v1/change-requests', form(IDS.walled)))
        .status,
    ).toBe(404);
    expect(
      (
        await send(
          f,
          USERS.dealWall.externalId,
          'POST',
          '/api/v1/change-requests',
          form(IDS.walled),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await send(
          f,
          USERS.deal.externalId,
          'POST',
          '/api/v1/change-requests',
          form(IDS.open, { summary: 'ab' }),
        )
      ).status,
    ).toBe(400);
    for (const who of [USERS.viewer, USERS.head, USERS.admin]) {
      const refused = await send(
        f,
        who.externalId,
        'POST',
        '/api/v1/change-requests',
        form(IDS.open),
      );
      expect(refused.status, who.externalId).toBe(403);
    }
  });

  it('walks the full path: route to an owner, start, apply in a quarter end; Applied is terminal', async () => {
    const { f, state } = setup();
    const made = await create(f);
    expect(
      (
        await send(f, OWNER.externalId, 'POST', commands(made.id), {
          command: 'route',
          ownerId: OWNER.userId,
        })
      ).status,
    ).toBe(403);
    const unknown = await send(f, USERS.deal.externalId, 'POST', commands(made.id), {
      command: 'route',
      ownerId: NO_SUCH_ID,
    });
    expect(unknown.status).toBe(422);
    expect(problemOf(unknown).detail).toContain('known active user');
    const routed = await command(f, USERS.deal.externalId, made.id, {
      command: 'route',
      ownerId: OWNER.userId,
    });
    expect(routed).toMatchObject({
      state: 'Routed',
      owner: { id: OWNER.userId, name: OWNER.displayName },
      rowVersion: 2,
    });
    expect(
      (await send(f, USERS.deal.externalId, 'POST', commands(made.id), { command: 'start' }))
        .status,
    ).toBe(403);
    const started = await command(f, OWNER.externalId, made.id, { command: 'start' });
    expect(started).toMatchObject({ state: 'InProgress', rowVersion: 3 });
    const early = await send(f, OWNER.externalId, 'POST', commands(made.id), {
      command: 'apply',
      appliedPeriod: '2025-03-31',
    });
    expect(early.status).toBe(422);
    expect(problemOf(early).detail).toContain('before the effective date');
    expect(
      (
        await send(f, OWNER.externalId, 'POST', commands(made.id), {
          command: 'apply',
          appliedPeriod: '2025-02-15',
        })
      ).status,
    ).toBe(400);
    const applied = await command(f, OWNER.externalId, made.id, {
      command: 'apply',
      appliedPeriod: '2025-06-30',
    });
    expect(applied).toMatchObject({
      state: 'Applied',
      appliedPeriod: '2025-06-30',
      appliedBy: { id: OWNER.userId },
      rowVersion: 4,
    });
    for (const body of [
      { command: 'start' },
      { command: 'apply', appliedPeriod: '2025-06-30' },
      { command: 'reject', reason: 'too late to reject' },
    ]) {
      const refused = await send(f, OWNER.externalId, 'POST', commands(made.id), body);
      expect(refused.status).toBe(409);
      expect(problemOf(refused).code).toBe('workflow-transition');
    }
    expect(state.audit.map((e) => e.action)).toEqual([
      'change_request.create',
      'change_request.route',
      'change_request.start',
      'change_request.apply',
    ]);
  });

  it('rejects with a reason from Routed and InProgress; a blank reason is refused by the table; Rejected is terminal', async () => {
    const { f } = setup();
    const routed = await inState(f, 'Routed');
    expect(
      (await send(f, OWNER.externalId, 'POST', commands(routed.id), { command: 'reject' })).status,
    ).toBe(400);
    const blank = await send(f, OWNER.externalId, 'POST', commands(routed.id), {
      command: 'reject',
      reason: '   ',
    });
    expect(blank.status).toBe(422);
    const rejected = await command(f, OWNER.externalId, routed.id, {
      command: 'reject',
      reason: 'Already reflected in the record',
    });
    expect(rejected).toMatchObject({
      state: 'Rejected',
      rejectionReason: 'Already reflected in the record',
    });
    const working = await inState(f, 'InProgress');
    expect(
      (await command(f, OWNER.externalId, working.id, { command: 'reject', reason: 'Not needed' }))
        .state,
    ).toBe('Rejected');
    expect(
      (await send(f, OWNER.externalId, 'POST', commands(routed.id), { command: 'start' })).status,
    ).toBe(409);
  });

  it('answers 409 for every (state, command) pair the table forbids, changing nothing', async () => {
    const { f } = setup();
    const rows = new Map<ChangeRequestState, ChangeRequestRow>();
    for (const state of dealChangeRequestMachine.states) rows.set(state, await inState(f, state));
    const bodies: Record<string, object> = {
      route: { command: 'route', ownerId: OWNER.userId },
      start: { command: 'start' },
      apply: { command: 'apply', appliedPeriod: '2025-06-30' },
      reject: { command: 'reject', reason: 'A reason the table would accept' },
    };
    const issuer: Record<string, string> = {
      route: USERS.deal.externalId,
      start: OWNER.externalId,
      apply: OWNER.externalId,
      reject: OWNER.externalId,
    };
    const pairs = forbiddenPairs(dealChangeRequestMachine);
    expect(pairs.length).toBe(15);
    for (const { from, command: cmd } of pairs) {
      const row = rows.get(from);
      expect(row?.state).toBe(from);
      const answer = await send(f, issuer[cmd] ?? '', 'POST', commands(row?.id ?? ''), bodies[cmd]);
      expect(answer.status, `${from} ${cmd}`).toBe(409);
      const after = changeRequestRow.parse(
        (await send(f, OWNER.externalId, 'GET', path(row?.id ?? ''))).json,
      );
      expect(after.state).toBe(from);
      expect(after.rowVersion).toBe(row?.rowVersion);
    }
  });

  it('the quarter-end check lists every unapplied request by the period end and opens one data exception each, none on a repeat, one again once resolved', async () => {
    const { f } = setup();
    for (const who of [USERS.deal, USERS.head, USERS.viewer])
      expect(
        (await send(f, who.externalId, 'POST', CHECK, { periodEnd: '2025-06-30' })).status,
      ).toBe(403);
    const first = quarterEndCheckResult.parse(
      (await send(f, OWNER.externalId, 'POST', CHECK, { periodEnd: '2025-06-30' })).json,
    );
    expect(first.periodEnd).toBe('2025-06-30');
    // The requests the runner may see, the earliest effective date first (the API's order).
    expect(first.unapplied.map((r) => r.id)).toEqual([
      IDS.changeRequest.inProgress,
      IDS.changeRequest.submitted,
    ]);
    // The walled position's request is covered like the rest and counted, never listed (CR-2).
    expect(first.hidden).toBe(1);
    expect(first.exceptionsOpened).toBe(3);
    const queue = dataExceptionPage.parse(
      (
        await send(
          f,
          OWNER.externalId,
          'GET',
          '/api/v1/data-exceptions?limit=200&source=change_request',
        )
      ).json,
    );
    expect(queue.items.map((x) => x.entityId).sort()).toEqual(
      first.unapplied.map((r) => r.id).sort(),
    );
    expect(queue.items.every((x) => x.ruleId === 'CR-QE-01' && x.state === 'open')).toBe(true);
    const ofOpen = queue.items.find((x) => x.entityId === IDS.changeRequest.inProgress);
    expect(ofOpen).toMatchObject({
      expected: 'Applied by 2025-06-30',
      actual: 'InProgress',
      severity: 'exception_severity.medium',
      entity: 'mon.deal_change_request',
      // As the API serves it: an exception about a request is about no staged row, so it
      // names no file and no position.
      context: {
        intakeFileId: null,
        intakeFileName: null,
        rowNo: null,
        investmentId: null,
        investmentNumber: null,
        companyName: null,
      },
    });
    // A second run for the same period lists the same requests and opens nothing more.
    const again = quarterEndCheckResult.parse(
      (await send(f, OWNER.externalId, 'POST', CHECK, { periodEnd: '2025-06-30' })).json,
    );
    expect(again.exceptionsOpened).toBe(0);
    // An acknowledged exception is still on the queue; a resolved one is not.
    const exceptionCommand = (body: object): Promise<Answer> =>
      send(
        f,
        OWNER.externalId,
        'POST',
        `/api/v1/data-exceptions/${ofOpen?.id ?? ''}/commands`,
        body,
      );
    expect((await exceptionCommand({ command: 'acknowledge' })).status).toBe(200);
    expect(
      quarterEndCheckResult.parse(
        (await send(f, OWNER.externalId, 'POST', CHECK, { periodEnd: '2025-06-30' })).json,
      ).exceptionsOpened,
    ).toBe(0);
    expect(
      (await exceptionCommand({ command: 'resolve', reason: 'Applied in the quarter after all' }))
        .status,
    ).toBe(200);
    expect(
      quarterEndCheckResult.parse(
        (await send(f, OWNER.externalId, 'POST', CHECK, { periodEnd: '2025-06-30' })).json,
      ).exceptionsOpened,
    ).toBe(1);
    // The boundary: a period end that is no quarter end, and an earlier quarter listing what was effective by then.
    const notQuarter = await send(f, OWNER.externalId, 'POST', CHECK, { periodEnd: '2025-02-15' });
    expect(notQuarter.status).toBe(400);
    expect(problemDetails.parse(notQuarter.json).errors?.map((e) => e.path)).toEqual(['periodEnd']);
    const earlier = quarterEndCheckResult.parse(
      (await send(f, OWNER.externalId, 'POST', CHECK, { periodEnd: '2025-03-31' })).json,
    );
    expect(earlier.unapplied).toEqual([]);
    // An earlier period end hides nothing that was not effective by then.
    expect(earlier.hidden).toBe(0);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('the quarter-end check opens an exception for a request its runner cannot see and counts it as hidden; the exception stays inside the wall (CR-2, CR-1)', async () => {
    const { f, state } = setup();
    const QUEUE = '/api/v1/data-exceptions?limit=200&source=change_request';
    const queueOf = async (who: string) =>
      dataExceptionPage.parse((await send(f, who, 'GET', QUEUE)).json).items;
    // Operations outside the wall runs the check: the walled request is not listed, only counted.
    const run = await send(f, OWNER.externalId, 'POST', CHECK, { periodEnd: '2025-06-30' });
    const result = quarterEndCheckResult.parse(run.json);
    expect(result.unapplied.map((r) => r.id)).not.toContain(IDS.changeRequest.walled);
    expect(result.hidden).toBe(1);
    expect(result.exceptionsOpened).toBe(result.unapplied.length + result.hidden);
    expect(run.text).not.toContain(IDS.changeRequest.walled);
    expect(run.text).not.toContain(IDS.walled);
    // The activity record carries the counts only: the total, the hidden ones, what was opened.
    expect(state.audit.at(-1)).toMatchObject({
      action: 'change_request.quarter_end_check',
      details: { unapplied: 3, hidden: 1, exceptionsOpened: 3 },
    });
    // The walled request has its exception all the same, and Data Health counts it for everyone.
    const walledException = [...state.exceptions.values()].find(
      (x) => x.entityId === IDS.changeRequest.walled,
    );
    expect(walledException).toMatchObject({
      entity: 'mon.deal_change_request',
      ruleId: 'CR-QE-01',
      expected: 'Applied by 2025-06-30',
      actual: 'Routed',
      state: 'open',
    });
    const hiddenId = walledException?.id ?? '';
    // Outside the wall it is not on the queue, not found by id and not found for a command.
    for (const who of [OWNER, USERS.deal, USERS.ops2]) {
      const seen = await queueOf(who.externalId);
      expect(seen.map((x) => x.entityId).sort(), who.externalId).toEqual(
        [IDS.changeRequest.inProgress, IDS.changeRequest.submitted].sort(),
      );
      expect(JSON.stringify(seen), who.externalId).not.toContain(IDS.changeRequest.walled);
      expect(
        (await send(f, who.externalId, 'GET', `/api/v1/data-exceptions/${hiddenId}`)).status,
        who.externalId,
      ).toBe(404);
    }
    const refused = await send(
      f,
      OWNER.externalId,
      'POST',
      `/api/v1/data-exceptions/${hiddenId}/commands`,
      { command: 'acknowledge' },
    );
    expect(refused.status).toBe(404);
    expect(state.exceptions.get(hiddenId)?.state).toBe('open');
    // Inside the wall it is on the queue, and a member who works the queue may work it.
    for (const who of [USERS.dealWall, USERS.head, USERS.all])
      expect(
        (await queueOf(who.externalId)).map((x) => x.entityId),
        who.externalId,
      ).toContain(IDS.changeRequest.walled);
    const worked = await send(
      f,
      USERS.all.externalId,
      'POST',
      `/api/v1/data-exceptions/${hiddenId}/commands`,
      { command: 'acknowledge' },
    );
    expect(worked.status).toBe(200);
    expect(state.exceptions.get(hiddenId)?.state).toBe('acknowledged');
    // A repeat opens nothing more, for the hidden request as for the others; a member who runs
    // the check has nothing hidden from them.
    const again = quarterEndCheckResult.parse(
      (await send(f, OWNER.externalId, 'POST', CHECK, { periodEnd: '2025-06-30' })).json,
    );
    expect([again.hidden, again.exceptionsOpened]).toEqual([1, 0]);
    const inside = quarterEndCheckResult.parse(
      (await send(f, USERS.all.externalId, 'POST', CHECK, { periodEnd: '2025-06-30' })).json,
    );
    expect(inside.hidden).toBe(0);
    expect(inside.unapplied.map((r) => r.id)).toContain(IDS.changeRequest.walled);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('route refuses an owner outside the wall of the position (422, nothing written) and accepts a member (CR-3)', async () => {
    const { f, state } = setup();
    const made = changeRequestRow.parse(
      (
        await send(
          f,
          USERS.dealWall.externalId,
          'POST',
          '/api/v1/change-requests',
          form(IDS.walled),
        )
      ).json,
    );
    const events = state.audit.length;
    const outside = await send(f, USERS.dealWall.externalId, 'POST', commands(made.id), {
      command: 'route',
      ownerId: OWNER.userId,
    });
    expect(outside.status).toBe(422);
    expect(problemOf(outside)).toEqual({
      code: 'workflow-precondition',
      detail:
        'deal_change_request: the owner is outside the wall of this position and could not open the request; name an owner inside the wall',
    });
    expect(
      changeRequestRow.parse((await send(f, USERS.dealWall.externalId, 'GET', path(made.id))).json),
    ).toMatchObject({ state: 'Submitted', owner: null, rowVersion: 1 });
    expect(state.audit.length).toBe(events);
    const routed = await command(f, USERS.dealWall.externalId, made.id, {
      command: 'route',
      ownerId: USERS.head.userId,
    });
    expect(routed).toMatchObject({
      state: 'Routed',
      owner: { id: USERS.head.userId, name: USERS.head.displayName },
    });
    // A position no wall covers takes any known active user as its owner, whatever they read.
    const open = await create(f);
    expect(
      (
        await command(f, USERS.deal.externalId, open.id, {
          command: 'route',
          ownerId: USERS.admin.userId,
        })
      ).owner,
    ).toEqual({ id: USERS.admin.userId, name: USERS.admin.displayName });
  });

  it('apply refuses a quarter end after the one the clock is in, and accepts the current one (CR-6)', async () => {
    const { f, state } = setup();
    // The preview's clock is the as-of date of the recordings, 2025-06-30: its own quarter end.
    const working = await inState(f, 'InProgress');
    const events = state.audit.length;
    const future = await send(f, OWNER.externalId, 'POST', commands(working.id), {
      command: 'apply',
      appliedPeriod: '2025-09-30',
    });
    expect(future.status).toBe(422);
    expect(problemOf(future)).toEqual({
      code: 'workflow-precondition',
      detail:
        'deal_change_request: the applied-in period 2025-09-30 is after the current quarter end 2025-06-30',
    });
    expect(
      changeRequestRow.parse((await send(f, OWNER.externalId, 'GET', path(working.id))).json),
    ).toMatchObject({ state: 'InProgress', appliedPeriod: null, rowVersion: working.rowVersion });
    expect(state.audit.length).toBe(events);
    // A request that takes effect after the current quarter cannot be applied yet either.
    const later = changeRequestRow.parse(
      (
        await send(
          f,
          USERS.deal.externalId,
          'POST',
          '/api/v1/change-requests',
          form(IDS.open, { effectiveDate: '2025-07-10' }),
        )
      ).json,
    );
    await command(f, USERS.deal.externalId, later.id, { command: 'route', ownerId: OWNER.userId });
    await command(f, OWNER.externalId, later.id, { command: 'start' });
    for (const appliedPeriod of ['2025-09-30', '2025-06-30'])
      expect(
        (
          await send(f, OWNER.externalId, 'POST', commands(later.id), {
            command: 'apply',
            appliedPeriod,
          })
        ).status,
        appliedPeriod,
      ).toBe(422);
    expect(
      (
        await command(f, OWNER.externalId, working.id, {
          command: 'apply',
          appliedPeriod: '2025-06-30',
        })
      ).appliedPeriod,
    ).toBe('2025-06-30');
  });

  it('If-Match: a stale row version is 412 and changes nothing; the current one goes through with the new ETag', async () => {
    const { f } = setup();
    const made = await inState(f, 'Submitted');
    const body = { command: 'route', ownerId: OWNER.userId };
    const stale = await send(f, USERS.deal.externalId, 'POST', commands(made.id), body, {
      'if-match': '"7"',
    });
    expect(stale.status).toBe(412);
    expect(
      changeRequestRow.parse((await send(f, USERS.deal.externalId, 'GET', path(made.id))).json)
        .rowVersion,
    ).toBe(1);
    const ok = await send(f, USERS.deal.externalId, 'POST', commands(made.id), body, {
      'if-match': 'W/"1"',
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('etag')).toBe('"2"');
    // A command from outside the wall is 404 and leaves no trace.
    const walled = await send(f, OWNER.externalId, 'POST', commands(IDS.changeRequest.walled), {
      command: 'start',
    });
    expect(walled.status).toBe(404);
  });
});
