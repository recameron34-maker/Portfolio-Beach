import { beforeEach, describe, expect, it } from 'vitest';
import {
  capitalNoticeDetail,
  capitalNoticePage,
  capitalNoticeRow,
  featureFlagList,
  investmentDetail,
  problemDetails,
  valuationPage,
  valuationRow,
} from '@pb/contracts';
import type { ValuationRow } from '@pb/contracts';
import { capitalNoticeMachine, forbiddenPairs, valuationMachine } from '@pb/workflows';
import { lockHashOf } from './routes/valuations.js';
import { createPreviewFetch } from './shim.js';
import { createPreviewState } from './state.js';
import type { PreviewState } from './state.js';
import { AS_OF, IDS, USERS, buildWorld } from './test-fixtures.js';

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));

interface Answer {
  status: number;
  json: unknown;
  text: string;
  headers: Headers;
}

/** One request through the shim, the way src/api/client.ts sends it. */
async function send(
  f: typeof fetch,
  credential: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${credential}`,
    ...extra,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await f(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text === '' ? null : JSON.parse(text),
    text,
    headers: res.headers,
  };
}

const command = (kind: 'valuations' | 'capital-notices', id: string): string =>
  `/api/v1/${kind}/${id}/commands`;

function problemOf(answer: Answer): { code: string; detail: string } {
  const p = problemDetails.parse(answer.json);
  return { code: p.type.split('/').pop() ?? '', detail: p.detail ?? '' };
}

let ids = 0;
const env = {
  newId: (): string => `50000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

function setup(options: Parameters<typeof buildWorld>[0] = {}): {
  f: typeof fetch;
  state: PreviewState;
} {
  const state = createPreviewState();
  const { fixtures } = buildWorld(options);
  return { f: createPreviewFetch(fixtures, never, { env, state }), state };
}

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('valuation commands follow docs/18 section 1 through the transition table', () => {
  it('refuses every forbidden (state, command) pair with 409, even for a user holding every role', async () => {
    const { f } = setup();
    const pairs = forbiddenPairs(valuationMachine);
    expect(pairs.length).toBeGreaterThan(0);
    for (const { from, command: cmd } of pairs) {
      const answer = await send(
        f,
        USERS.all.externalId,
        'POST',
        command('valuations', IDS.valuation[from]),
        {
          command: cmd,
          reason: 'testing the table',
        },
      );
      expect(answer.status, `${cmd} from ${from}`).toBe(409);
      expect(problemOf(answer)).toEqual({
        code: 'workflow-transition',
        detail: `valuation: ${cmd} is not allowed from ${from}`,
      });
      expect(answer.headers.get('x-pb-simulated')).toBe('true');
    }
  });

  it('refuses a viewer on every allowed row with 403', async () => {
    const { f } = setup();
    for (const t of valuationMachine.transitions) {
      const answer = await send(
        f,
        USERS.viewer.externalId,
        'POST',
        command('valuations', IDS.valuation[t.from]),
        {
          command: t.command,
          reason: 'testing the table',
        },
      );
      expect(answer.status, `${t.command} from ${t.from}`).toBe(403);
      expect(problemOf(answer).code).toBe('forbidden');
    }
  });

  it('requires a reason to send back and to reopen (422)', async () => {
    const { f } = setup();
    const sendBack = await send(
      f,
      USERS.deal.externalId,
      'POST',
      command('valuations', IDS.valuation.OpsPrepared),
      {
        command: 'sendBack',
      },
    );
    expect(sendBack.status).toBe(422);
    expect(problemOf(sendBack)).toEqual({
      code: 'workflow-precondition',
      detail: 'valuation: a reason is required',
    });
    const reopen = await send(
      f,
      USERS.head.externalId,
      'POST',
      command('valuations', IDS.valuation.Locked),
      {
        command: 'reopen',
      },
    );
    expect(reopen.status).toBe(422);
    expect(problemOf(reopen).detail).toBe('valuation: a reason is required');
  });

  it('keeps segregation of duties on user ids: the preparer cannot approve their own valuation', async () => {
    const { f } = setup();
    const created = await send(f, USERS.all.externalId, 'POST', '/api/v1/valuations', {
      investmentId: IDS.open,
      periodEnd: '2025-06-30',
      method: 'valuation_method.sponsor_mark',
      fairValue: '1200.00',
    });
    const id = valuationRow.parse(created.json).id;
    expect(
      (
        await send(f, USERS.all.externalId, 'POST', command('valuations', id), {
          command: 'prepare',
        })
      ).status,
    ).toBe(200);
    const own = await send(f, USERS.all.externalId, 'POST', command('valuations', id), {
      command: 'dealTeamApprove',
    });
    expect(own.status).toBe(422);
    expect(problemOf(own).detail).toBe(
      'valuation: the preparer cannot approve their own valuation (SEC-5.6)',
    );
  });

  it('maps recorded display names back to user ids, so a recorded preparer is refused too', async () => {
    const { f } = setup();
    const own = await send(
      f,
      USERS.all.externalId,
      'POST',
      command('valuations', IDS.valuation.OpsPrepared),
      {
        command: 'dealTeamApprove',
      },
    );
    expect(own.status).toBe(422);
    expect(problemOf(own).detail).toBe(
      'valuation: the preparer cannot approve their own valuation (SEC-5.6)',
    );
    const ownLock = await send(
      f,
      USERS.all.externalId,
      'POST',
      command('valuations', IDS.valuation.DealTeamApproved),
      {
        command: 'lock',
      },
    );
    expect(ownLock.status).toBe(422);

    const ok = await send(
      f,
      USERS.deal.externalId,
      'POST',
      command('valuations', IDS.valuation.OpsPrepared),
      {
        command: 'dealTeamApprove',
      },
    );
    expect(ok.status).toBe(200);
    expect(valuationRow.parse(ok.json).dealTeamApprovedBy).toBe(USERS.deal.displayName);
    const locked = await send(
      f,
      USERS.head.externalId,
      'POST',
      command('valuations', IDS.valuation.DealTeamApproved),
      {
        command: 'lock',
      },
    );
    expect(locked.status).toBe(200);
    expect(valuationRow.parse(locked.json)).toMatchObject({
      state: 'Locked',
      approvedBy: USERS.head.displayName,
      approvedAt: `${AS_OF}T12:00:00Z`,
      rowVersion: 2,
    });
  });
});

describe('capital notice commands follow docs/18 section 3 through the transition table', () => {
  it('refuses every forbidden (state, command) pair with 409, even for a user holding every role', async () => {
    const { f } = setup();
    for (const { from, command: cmd } of forbiddenPairs(capitalNoticeMachine)) {
      const answer = await send(
        f,
        USERS.all.externalId,
        'POST',
        command('capital-notices', IDS.notice[from]),
        {
          command: cmd,
        },
      );
      expect(answer.status, `${cmd} from ${from}`).toBe(409);
      expect(problemOf(answer)).toEqual({
        code: 'workflow-transition',
        detail: `capital_notice: ${cmd} is not allowed from ${from}`,
      });
    }
  });

  it('refuses a viewer on every allowed row with 403', async () => {
    const { f } = setup();
    for (const t of capitalNoticeMachine.transitions) {
      const answer = await send(
        f,
        USERS.viewer.externalId,
        'POST',
        command('capital-notices', IDS.notice[t.from]),
        {
          command: t.command,
        },
      );
      expect(answer.status, `${t.command} from ${t.from}`).toBe(403);
      expect(problemOf(answer).code).toBe('forbidden');
    }
  });

  it('blocks ticket approval: SEC-12.3 for the drafter, SEC-12.2 (unverified wire) for anyone else', async () => {
    const { f, state } = setup();
    const id = IDS.notice.wireChange;
    const review = await send(f, USERS.ops.externalId, 'POST', command('capital-notices', id), {
      command: 'review',
    });
    expect(review.status).toBe(200);
    expect(capitalNoticeRow.parse(review.json)).toMatchObject({ state: 'Reviewed', rowVersion: 2 });
    const draft = await send(f, USERS.ops.externalId, 'POST', command('capital-notices', id), {
      command: 'draftTicket',
    });
    expect(capitalNoticeRow.parse(draft.json).state).toBe('TicketDrafted');

    const byDrafter = await send(f, USERS.ops.externalId, 'POST', command('capital-notices', id), {
      command: 'approveTicket',
    });
    expect(byDrafter.status).toBe(422);
    expect(problemOf(byDrafter).detail).toBe(
      'capital_notice: the ticket preparer cannot approve it (SEC-12.3)',
    );
    for (const other of [USERS.ops2, USERS.head]) {
      const answer = await send(f, other.externalId, 'POST', command('capital-notices', id), {
        command: 'approveTicket',
      });
      expect(answer.status).toBe(422);
      expect(problemOf(answer).detail).toBe(
        'capital_notice: the wire instruction is not verified (SEC-12.2)',
      );
    }
    const funding = await send(f, USERS.ops.externalId, 'POST', command('capital-notices', id), {
      command: 'confirmFunding',
    });
    expect(funding.status).toBe(409);

    // Reads show the new state to every role that can open the notice.
    const detail = capitalNoticeDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', `/api/v1/capital-notices/${id}`)).json,
    );
    expect(detail).toMatchObject({ state: 'TicketDrafted', rowVersion: 3 });
    const page = capitalNoticePage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/capital-notices?limit=200')).json,
    );
    expect(page.items.find((r) => r.id === id)?.state).toBe('TicketDrafted');
    expect(page.attention.find((r) => r.id === id)?.state).toBe('TicketDrafted');
    expect(state.audit.map((e) => e.action)).toEqual([
      'capital_notice.review',
      'capital_notice.draftTicket',
    ]);
  });

  it('answers 404 for a notice the credential cannot open, without saying it exists', async () => {
    const { f } = setup();
    const hidden = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('capital-notices', IDS.notice.walled),
      {
        command: 'review',
      },
    );
    expect(hidden.status).toBe(404);
    expect(problemOf(hidden).detail).toBe('Capital notice not found');
    const unknown = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('capital-notices', IDS.open),
      {
        command: 'review',
      },
    );
    expect(unknown.text).toBe(hidden.text.replace(IDS.notice.walled, IDS.open));
  });
});

const createBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  investmentId: IDS.open,
  periodEnd: '2025-06-30',
  method: 'valuation_method.sponsor_mark',
  fairValue: '1200.00',
  ...overrides,
});

describe('creating a Draft valuation', () => {
  it('creates version 1 in Draft with the prior quarter mark and no invented change ratio', async () => {
    const { f, state } = setup();
    const answer = await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody());
    expect(answer.status).toBe(201);
    expect(answer.headers.get('x-pb-simulated')).toBe('true');
    expect(answer.headers.get('etag')).toBe('"1"');
    const row = valuationRow.parse(answer.json);
    expect(row).toMatchObject({
      investmentId: IDS.open,
      investmentNumber: 'INV-0001',
      periodEnd: '2025-06-30',
      version: 1,
      state: 'Draft',
      fairValue: '1200.00',
      priorFairValue: '1000.00',
      changePct: null,
      preparedBy: null,
      rowVersion: 1,
    });
    expect(state.audit).toEqual([
      expect.objectContaining({
        action: 'valuation.create',
        actorId: USERS.ops.userId,
        to: 'Draft',
      }),
    ]);
    const again = valuationRow.parse(
      (await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody())).json,
    );
    expect(again.version).toBe(2);
  });

  it('applies the guard, visibility, activity and lock rules', async () => {
    const { f } = setup();
    expect(
      (await send(f, USERS.deal.externalId, 'POST', '/api/v1/valuations', createBody())).status,
    ).toBe(403);
    const walled = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ investmentId: IDS.walled }),
    );
    expect(walled.status).toBe(404);
    expect(problemOf(walled).detail).toBe('Investment not found');
    expect(
      (
        await send(
          f,
          USERS.all.externalId,
          'POST',
          '/api/v1/valuations',
          createBody({ investmentId: IDS.walled }),
        )
      ).status,
    ).toBe(201);
    const realized = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ investmentId: IDS.realized }),
    );
    expect(realized.status).toBe(422);
    expect(problemOf(realized)).toEqual({
      code: 'workflow-precondition',
      detail: 'valuation: the investment is not active',
    });
    const locked = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ investmentId: IDS.lockedPeriod }),
    );
    expect(locked.status).toBe(409);
    expect(problemOf(locked).code).toBe('conflict');
  });

  it('rejects an invalid body with paths only, never echoing what was sent', async () => {
    const { f, state } = setup();
    const answer = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ fairValue: 'about-SECRET-41', note: 'SECRET-NOTE-77' }),
    );
    expect(answer.status).toBe(400);
    const p = problemDetails.parse(answer.json);
    expect(p.type).toBe('https://portfolio-beach.example/problems/validation');
    expect(p.errors?.map((e) => e.path).sort()).toEqual(['(root)', 'fairValue']);
    expect(answer.text).not.toContain('about-SECRET-41');
    expect(answer.text).not.toContain('SECRET-NOTE-77');
    const notJson = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      '{"investmentId":',
    );
    expect(notJson.status).toBe(400);
    const badCommand = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', IDS.valuation.Draft),
      {
        command: 'approveEverything',
      },
    );
    expect(badCommand.status).toBe(400);
    expect(problemDetails.parse(badCommand.json).errors?.[0]?.path).toBe('command');
    expect(state.audit).toHaveLength(0);
  });
});

describe('the valuation journey across roles', () => {
  it('ops prepares, deal team approves, the approver locks, and a reopen starts version 2 in Draft', async () => {
    const { f, state } = setup();
    const created = valuationRow.parse(
      (await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody())).json,
    );
    const run = (credential: string, body: unknown): Promise<Answer> =>
      send(f, credential, 'POST', command('valuations', created.id), body);

    const prepared = await run(USERS.ops.externalId, { command: 'prepare' });
    expect(prepared.status).toBe(200);
    const preparedRow = valuationRow.parse(prepared.json);
    expect(preparedRow).toMatchObject({
      state: 'OpsPrepared',
      preparedBy: USERS.ops.displayName,
      rowVersion: 2,
    });
    expect(preparedRow.lockHash).toBe(await lockHashOf(created));
    expect(preparedRow.lockHash).toMatch(/^[0-9a-f]{64}$/);

    expect((await run(USERS.ops.externalId, { command: 'dealTeamApprove' })).status).toBe(403);
    expect((await run(USERS.head.externalId, { command: 'lock' })).status).toBe(409);
    expect(
      valuationRow.parse((await run(USERS.deal.externalId, { command: 'dealTeamApprove' })).json)
        .state,
    ).toBe('DealTeamApproved');
    const locked = valuationRow.parse((await run(USERS.head.externalId, { command: 'lock' })).json);
    expect(locked).toMatchObject({
      state: 'Locked',
      approvedBy: USERS.head.displayName,
      approvedAt: '2025-06-30T12:00:00Z',
      dealTeamApprovedBy: USERS.deal.displayName,
      rowVersion: 4,
    });

    // A viewer now reads the Locked row in the list and the one-pager; recorded figures stay as recorded.
    const list = valuationPage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/valuations?limit=200')).json,
    );
    expect(list.items[0]).toEqual(locked);
    expect(list.periods[0]).toBe('2025-06-30');
    const detail = investmentDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', `/api/v1/investments/${IDS.open}`)).json,
    );
    expect(detail.valuations.at(-1)).toEqual({
      periodEnd: '2025-06-30',
      version: 1,
      state: 'Locked',
      fairValue: '1200.00',
      method: 'valuation_method.sponsor_mark',
    });
    expect(detail.nav).toBe('1100.00');

    const reopened = await run(USERS.head.externalId, {
      command: 'reopen',
      reason: 'sponsor restated the mark',
    });
    expect(reopened.status).toBe(200);
    expect(valuationRow.parse(reopened.json)).toMatchObject({
      state: 'Reopened',
      reopenReason: 'sponsor restated the mark',
    });
    const versions = valuationPage
      .parse(
        (
          await send(
            f,
            USERS.ops.externalId,
            'GET',
            `/api/v1/valuations?investmentId=${IDS.open}&limit=200`,
          )
        ).json,
      )
      .items.filter((r) => r.periodEnd === '2025-06-30')
      .map((r) => [r.version, r.state]);
    expect(versions).toEqual(
      expect.arrayContaining([
        [1, 'Reopened'],
        [2, 'Draft'],
      ]),
    );
    expect(state.audit.map((e) => `${e.actorExternalId}:${e.action}`)).toEqual([
      'ops.one:valuation.create',
      'ops.one:valuation.prepare',
      'deal.one:valuation.dealTeamApprove',
      'head.one:valuation.lock',
      'head.one:valuation.reopen',
      'head.one:valuation.create',
    ]);
  });

  it('refuses to prepare a draft whose fair value is not positive (validation has not passed)', async () => {
    const { f } = setup();
    const row = valuationRow.parse(
      (
        await send(
          f,
          USERS.ops.externalId,
          'POST',
          '/api/v1/valuations',
          createBody({ fairValue: '0.00' }),
        )
      ).json,
    );
    const answer = await send(f, USERS.ops.externalId, 'POST', command('valuations', row.id), {
      command: 'prepare',
    });
    expect(answer.status).toBe(422);
    expect(problemOf(answer).detail).toBe('valuation: validation has not passed');
  });
});

describe('reads keep walls per credential', () => {
  it('shows a simulated row on the walled investment only to wall members', async () => {
    const { f } = setup();
    const created = valuationRow.parse(
      (
        await send(
          f,
          USERS.all.externalId,
          'POST',
          '/api/v1/valuations',
          createBody({ investmentId: IDS.walled }),
        )
      ).json,
    );
    const listFor = async (credential: string): Promise<ValuationRow[]> =>
      valuationPage.parse((await send(f, credential, 'GET', '/api/v1/valuations?limit=200')).json)
        .items;
    expect(
      (await listFor(USERS.viewer.externalId)).some((r) => r.investmentId === IDS.walled),
    ).toBe(false);
    expect((await listFor(USERS.ops.externalId)).some((r) => r.id === created.id)).toBe(false);
    expect((await listFor(USERS.dealWall.externalId)).some((r) => r.id === created.id)).toBe(true);
    expect(
      (await send(f, USERS.viewer.externalId, 'GET', `/api/v1/investments/${IDS.walled}`)).status,
    ).toBe(404);
    const memberDetail = investmentDetail.parse(
      (await send(f, USERS.dealWall.externalId, 'GET', `/api/v1/investments/${IDS.walled}`)).json,
    );
    expect(memberDetail.valuations.some((v) => v.periodEnd === '2025-06-30')).toBe(true);
    // Commands on it are a 404 for anyone outside the wall.
    const outside = await send(f, USERS.ops.externalId, 'POST', command('valuations', created.id), {
      command: 'prepare',
    });
    expect(outside.status).toBe(404);
    expect(problemOf(outside).detail).toBe('Valuation not found');
  });

  it('keeps an investment-filtered list to that investment', async () => {
    const { f } = setup();
    await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody());
    await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ investmentId: IDS.states, periodEnd: '2025-06-30' }),
    );
    const items = valuationPage.parse(
      (
        await send(
          f,
          USERS.ops.externalId,
          'GET',
          `/api/v1/valuations?investmentId=${IDS.open}&limit=200`,
        )
      ).json,
    ).items;
    expect(new Set(items.map((r) => r.investmentId))).toEqual(new Set([IDS.open]));
  });
});

describe('idempotency and optimistic concurrency (docs/17 section 3)', () => {
  it('replays the stored answer for a repeated Idempotency-Key and refuses the key with another body', async () => {
    const { f, state } = setup();
    const key = { 'idempotency-key': 'create-1' };
    const first = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody(),
      key,
    );
    const second = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody(),
      key,
    );
    expect(second.status).toBe(201);
    expect(second.text).toBe(first.text);
    expect(state.audit).toHaveLength(1);
    const reused = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ fairValue: '9.00' }),
      key,
    );
    expect(reused.status).toBe(422);
    expect(problemOf(reused).code).toBe('idempotency-key-reuse');

    const id = valuationRow.parse(first.json).id;
    const prepareKey = { 'idempotency-key': 'prepare-1' };
    const prepared = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', id),
      { command: 'prepare' },
      prepareKey,
    );
    const replayed = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', id),
      { command: 'prepare' },
      prepareKey,
    );
    expect(replayed.status).toBe(200);
    expect(replayed.text).toBe(prepared.text);
    // Without the key the same command is evaluated again, and the table refuses it.
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', command('valuations', id), {
          command: 'prepare',
        })
      ).status,
    ).toBe(409);
  });

  it('answers 412 when If-Match names another row version and proceeds when it matches', async () => {
    const { f } = setup();
    const id = IDS.valuation.Draft;
    const stale = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', id),
      { command: 'prepare' },
      { 'if-match': '"2"' },
    );
    expect(stale.status).toBe(412);
    expect(problemOf(stale).code).toBe('precondition');
    const fresh = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', id),
      { command: 'prepare' },
      { 'if-match': 'W/"1"' },
    );
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('etag')).toBe('"2"');
    const noticeStale = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('capital-notices', IDS.notice.Extracted),
      { command: 'review' },
      { 'if-match': '"7"' },
    );
    expect(noticeStale.status).toBe(412);
  });
});

describe('reset', () => {
  it('forgets every simulated change and seeds again from the recordings', async () => {
    const { f, state } = setup();
    await send(f, USERS.admin.externalId, 'PATCH', '/api/v1/flags/ai.extraction', {
      enabled: true,
      reason: 'demo',
    });
    const created = valuationRow.parse(
      (await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody())).json,
    );
    await send(f, USERS.ops.externalId, 'POST', command('capital-notices', IDS.notice.Extracted), {
      command: 'review',
    });

    const reset = await send(f, USERS.viewer.externalId, 'POST', '/api/v1/preview/reset');
    expect(reset.status).toBe(200);
    expect(reset.json).toEqual({ reset: true });
    expect(reset.headers.get('x-pb-simulated')).toBe('true');
    expect(state.audit).toHaveLength(0);

    const flags = featureFlagList.parse(
      (await send(f, USERS.admin.externalId, 'GET', '/api/v1/flags')).json,
    );
    expect(flags.flags[0]?.enabled).toBe(false);
    const list = valuationPage.parse(
      (await send(f, USERS.ops.externalId, 'GET', '/api/v1/valuations?limit=200')).json,
    );
    expect(list.items.some((r) => r.id === created.id)).toBe(false);
    const notice = capitalNoticeDetail.parse(
      (
        await send(
          f,
          USERS.ops.externalId,
          'GET',
          `/api/v1/capital-notices/${IDS.notice.Extracted}`,
        )
      ).json,
    );
    expect(notice).toMatchObject({ state: 'Extracted', rowVersion: 1 });
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', command('valuations', created.id), {
          command: 'prepare',
        })
      ).status,
    ).toBe(404);
  });
});

describe('while the workflow reads are recorded as 501', () => {
  it('starts with no seeded records, still creates from the investment detail, and replays the 501s', async () => {
    const { f } = setup({ workflowEndpoints: 'not-implemented' });
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', command('valuations', IDS.valuation.Draft), {
          command: 'prepare',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(
          f,
          USERS.ops.externalId,
          'POST',
          command('capital-notices', IDS.notice.Extracted),
          { command: 'review' },
        )
      ).status,
    ).toBe(404);
    const created = await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody());
    expect(created.status).toBe(201);
    const list = await send(f, USERS.ops.externalId, 'GET', '/api/v1/valuations?limit=200');
    expect(list.status).toBe(501);
    const detail = investmentDetail.parse(
      (await send(f, USERS.ops.externalId, 'GET', `/api/v1/investments/${IDS.open}`)).json,
    );
    expect(detail.valuations.some((v) => v.periodEnd === '2025-06-30' && v.state === 'Draft')).toBe(
      true,
    );
    expect(window.__pbPreviewMisses).toEqual([]);
  });
});
