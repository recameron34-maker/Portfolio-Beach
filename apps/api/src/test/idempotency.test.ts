import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ROUTES,
  canonicalJson,
  capitalNoticeControlDetail,
  changeRequestRow,
  opportunityDetail,
  problemDetails,
  valuationRow,
  wireInstructionDetail,
} from '@pb/contracts';
import type { RouteDefinition } from '@pb/contracts';
import type { AppRole } from '@pb/db';
import {
  idempotencyKeyOf,
  isIdempotentRoute,
  requestFingerprint,
  storableAnswer,
} from '../common/idempotency.js';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const NIL = '00000000-0000-4000-8000-000000000000';
const REPLAYED = 'idempotency-replayed';

interface StoredKey {
  user_id: string;
  method: string;
  path: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  response_etag: string | null;
}

/**
 * The Idempotency-Key header on the routes the contract marks idempotent (docs/17 section 3,
 * review findings D7-1, VAL-4 and CR-4): a repeat answers the stored result and runs nothing.
 */
describe('Idempotency-Key (docs/17 section 3)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const send = (
    who: string,
    path: string,
    body: object,
    headers: Record<string, string> = {},
    method: 'post' | 'put' = 'post',
  ) => h.http()[method](path).set('authorization', h.as(who)).set(headers).send(body);
  const keyOf = (key: string): Record<string, string> => ({ 'idempotency-key': key });
  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const problemType = (res: { body: unknown }): string => problemDetails.parse(res.body).type;
  const stored = (key: string): Promise<StoredKey[]> =>
    h.runtime.db.query<StoredKey>(
      'select user_id, method, path, key, request_hash, response_status, response_body, response_etag from ops.idempotency_key where key = $1 order by path',
      [key],
    );
  const count = async (from: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(`select count(*)::int as n from ${from}`, params))[0]!
      .n;
  const rowVersionOf = async (table: string, id: string): Promise<number> =>
    (
      await h.runtime.db.query<{ row_version: number }>(
        `select row_version from ${table} where id = $1`,
        [id],
      )
    )[0]!.row_version;
  const opportunityBody = (name: string) => {
    const fund = h.dataset.sponsorFunds.find((f) => f.strategy !== 'strategy.credit')!;
    return {
      name,
      companyName: `${name} Holdings`,
      sponsorId: fund.sponsorId,
      sponsorFundId: fund.id,
      dealType: 'deal_type.co_invest_equity',
      receivedDate: h.dataset.asOf,
      targetCommitment: '15000000.00',
    };
  };

  it('replays a valuation create and a valuation command: one version, one approval row, the same answer', async () => {
    const investmentId = h.dataset.scenarios.stale_valuation![0]!;
    const body = {
      investmentId,
      periodEnd: '2025-06-30',
      method: 'valuation_method.sponsor_mark',
      fairValue: '1250000.00',
    };
    const first = await send('ops.one', '/api/v1/valuations', body, keyOf('val-create-1')).expect(
      201,
    );
    expect(first.headers[REPLAYED]).toBeUndefined();
    const created = valuationRow.parse(first.body);
    const auditsAfterCreate = await count('audit.event');
    const again = await send('ops.one', '/api/v1/valuations', body, keyOf('val-create-1')).expect(
      201,
    );
    expect(again.headers[REPLAYED]).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(again.headers.etag).toBe(first.headers.etag);
    expect(await count('audit.event')).toBe(auditsAfterCreate);
    expect(
      await count('mon.valuation where investment_id = $1 and period_end = $2', [
        investmentId,
        '2025-06-30',
      ]),
    ).toBe(1);

    // The command, with the row version it was read at: the repeat names a version that is stale
    // by then, and is still the answer to the request already made, not a 412.
    const path = `/api/v1/valuations/${created.id}/commands`;
    const headers = { ...keyOf('val-prepare-1'), 'if-match': `"${created.rowVersion}"` };
    const prepared = await send('ops.one', path, { command: 'prepare' }, headers).expect(200);
    expect(prepared.headers[REPLAYED]).toBeUndefined();
    expect(valuationRow.parse(prepared.body).state).toBe('OpsPrepared');
    const snapshot = async () => ({
      audits: await count('audit.event'),
      approvals: await count('mon.valuation_approval where valuation_id = $1', [created.id]),
      rowVersion: await rowVersionOf('mon.valuation', created.id),
    });
    const before = await snapshot();
    expect(before.approvals).toBe(1);
    const replayed = await send('ops.one', path, { command: 'prepare' }, headers).expect(200);
    expect(replayed.headers[REPLAYED]).toBe('true');
    expect(replayed.body).toEqual(prepared.body);
    expect(replayed.headers.etag).toBe(prepared.headers.etag);
    expect(await snapshot()).toEqual(before);

    // Without the key the same command is evaluated again, and the table refuses it.
    expect(problemType(await send('ops.one', path, { command: 'prepare' }).expect(409))).toBe(
      `${PROBLEM}workflow-transition`,
    );
    // The same key with another body is refused and runs nothing.
    const reused = await send(
      'ops.one',
      path,
      { command: 'sendBack', reason: 'Wrong period' },
      keyOf('val-prepare-1'),
    ).expect(422);
    expect(problemType(reused)).toBe(`${PROBLEM}idempotency-key-reuse`);
    expect(await snapshot()).toEqual(before);

    const [row] = await stored('val-prepare-1');
    expect(row).toMatchObject({
      user_id: user('ops.one').id,
      method: 'POST',
      path,
      response_status: 200,
      response_etag: prepared.headers.etag,
    });
    expect(row!.response_body).toEqual(prepared.body);
  });

  it('replays a capital notice command: the notice moves once and is audited once', async () => {
    const notice = h.dataset.capitalNotices.find((n) => n.scenarioTag === 'wire_change')!;
    const path = `/api/v1/capital-notices/${notice.id}/commands`;
    const first = await send('ops.one', path, { command: 'review' }, keyOf('notice-review-1'))
      .set('x-request-id', 'req-idem-review-1')
      .expect(200);
    expect(capitalNoticeControlDetail.parse(first.body).state).toBe('Reviewed');
    const snapshot = async () => ({
      audits: await count('audit.event'),
      reviews: await count(
        "audit.event where action = 'capital_notice.review' and entity_id = $1",
        [notice.id],
      ),
      rowVersion: await rowVersionOf('mon.capital_notice', notice.id),
    });
    const before = await snapshot();
    expect(before.reviews).toBe(1);
    const again = await send('ops.one', path, { command: 'review' }, keyOf('notice-review-1'))
      .set('x-request-id', 'req-idem-review-2')
      .expect(200);
    expect(again.headers[REPLAYED]).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await snapshot()).toEqual(before);
    // The repeat is its own request: it carries its own request id, never the first one's.
    expect(again.headers['x-request-id']).toBe('req-idem-review-2');
    expect(problemType(await send('ops.one', path, { command: 'review' }).expect(409))).toBe(
      `${PROBLEM}workflow-transition`,
    );
  });

  it('replays a change request create and its routing: one request, routed once', async () => {
    const walled = h.dataset.scenarios.walled_deal![0]!;
    const investment = h.dataset.investments.find((i) => i.isActive && i.id !== walled)!;
    const form = {
      investmentId: investment.id,
      changeType: 'change_type.add_on_acquisition',
      effectiveDate: h.dataset.asOf,
      summary: 'Idem add-on acquisition of a regional competitor closed',
      details: { target: 'A regional competitor' },
    };
    const first = await send(
      'deal.one',
      '/api/v1/change-requests',
      form,
      keyOf('cr-create-1'),
    ).expect(201);
    const created = changeRequestRow.parse(first.body);
    const again = await send(
      'deal.one',
      '/api/v1/change-requests',
      form,
      keyOf('cr-create-1'),
    ).expect(201);
    expect(again.headers[REPLAYED]).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(again.headers.etag).toBe(first.headers.etag);
    expect(await count('mon.deal_change_request where summary = $1', [form.summary])).toBe(1);

    const path = `/api/v1/change-requests/${created.id}/commands`;
    const route = { command: 'route', ownerId: user('ops.one').id };
    const routed = await send('deal.one', path, route, keyOf('cr-route-1')).expect(200);
    expect(changeRequestRow.parse(routed.body).state).toBe('Routed');
    const snapshot = async () => ({
      audits: await count('audit.event'),
      rowVersion: await rowVersionOf('mon.deal_change_request', created.id),
    });
    const before = await snapshot();
    const replayed = await send('deal.one', path, route, keyOf('cr-route-1')).expect(200);
    expect(replayed.headers[REPLAYED]).toBe('true');
    expect(replayed.body).toEqual(routed.body);
    expect(await snapshot()).toEqual(before);
    // Without the key the routing is evaluated again, and the table refuses it.
    expect(problemType(await send('deal.one', path, route).expect(409))).toBe(
      `${PROBLEM}workflow-transition`,
    );
  });

  it('replays an opportunity create and an opportunity command: one deal, one stage move', async () => {
    const body = opportunityBody('Project Idem Lantern');
    const first = await send(
      'deal.one',
      '/api/v1/opportunities',
      body,
      keyOf('opp-create-1'),
    ).expect(201);
    const created = opportunityDetail.parse(first.body);
    const again = await send(
      'deal.one',
      '/api/v1/opportunities',
      body,
      keyOf('opp-create-1'),
    ).expect(201);
    expect(again.headers[REPLAYED]).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await count('deal.opportunity where name = $1', [body.name])).toBe(1);

    const path = `/api/v1/opportunities/${created.id}/commands`;
    const advanced = await send(
      'deal.one',
      path,
      { command: 'advance' },
      keyOf('opp-advance-1'),
    ).expect(200);
    expect(opportunityDetail.parse(advanced.body).stage).toBe('Screening');
    const snapshot = async () => ({
      audits: await count('audit.event'),
      history: await count('deal.opportunity_stage_history where opportunity_id = $1', [
        created.id,
      ]),
      rowVersion: await rowVersionOf('deal.opportunity', created.id),
      stage: (
        await h.runtime.db.query<{ stage: string }>(
          'select stage from deal.opportunity where id = $1',
          [created.id],
        )
      )[0]!.stage,
    });
    const before = await snapshot();
    expect(before).toMatchObject({ history: 2, stage: 'Screening' });
    const replayed = await send(
      'deal.one',
      path,
      { command: 'advance' },
      keyOf('opp-advance-1'),
    ).expect(200);
    expect(replayed.headers[REPLAYED]).toBe('true');
    expect(replayed.body).toEqual(advanced.body);
    // Evaluated again, the same command would have moved the deal on to Prescreen.
    expect(await snapshot()).toEqual(before);

    // A PUT the contract marks idempotent is keyed the same way: the lines are replaced once.
    const lines = {
      allocations: [{ vehicleId: h.dataset.vehicles[0]!.id, requested: '1000000.00' }],
    };
    const allocationsPath = `/api/v1/opportunities/${created.id}/allocations`;
    const lineIds = async (): Promise<string[]> =>
      (
        await h.runtime.db.query<{ id: string }>(
          'select id from deal.allocation where opportunity_id = $1 order by id',
          [created.id],
        )
      ).map((r) => r.id);
    const put = await send('deal.one', allocationsPath, lines, keyOf('opp-alloc-1'), 'put').expect(
      200,
    );
    const afterPut = { audits: await count('audit.event'), lines: await lineIds() };
    expect(afterPut.lines).toHaveLength(1);
    const putAgain = await send(
      'deal.one',
      allocationsPath,
      lines,
      keyOf('opp-alloc-1'),
      'put',
    ).expect(200);
    expect(putAgain.headers[REPLAYED]).toBe('true');
    expect(putAgain.body).toEqual(put.body);
    expect({ audits: await count('audit.event'), lines: await lineIds() }).toEqual(afterPut);
    expect((await stored('opp-alloc-1')).map((r) => r.method)).toEqual(['PUT']);
  });

  it('scopes a key to its user and its path, and keeps nothing of a refused first attempt', async () => {
    // Two people may choose the same key: each runs their own request and reads their own answer.
    const mine = await send(
      'deal.one',
      '/api/v1/opportunities',
      opportunityBody('Project Idem Shared One'),
      keyOf('shared-key-1'),
    ).expect(201);
    const theirs = await send(
      'deal.two',
      '/api/v1/opportunities',
      opportunityBody('Project Idem Shared One'),
      keyOf('shared-key-1'),
    ).expect(201);
    expect(theirs.headers[REPLAYED]).toBeUndefined();
    expect(opportunityDetail.parse(theirs.body).id).not.toBe(opportunityDetail.parse(mine.body).id);
    expect((await stored('shared-key-1')).map((r) => r.user_id).sort()).toEqual(
      [user('deal.one').id, user('deal.two').id].sort(),
    );

    // The same key on another path is another request.
    const id = opportunityDetail.parse(mine.body).id;
    const moved = await send(
      'deal.one',
      `/api/v1/opportunities/${id}/commands`,
      { command: 'advance' },
      keyOf('shared-key-1'),
    ).expect(200);
    expect(moved.headers[REPLAYED]).toBeUndefined();
    expect(opportunityDetail.parse(moved.body).stage).toBe('Screening');

    // A refused request stores nothing: the key is free for the corrected body.
    const wrong = { ...opportunityBody('Project Idem Second Try'), dealType: 'deal_type.nope' };
    await send('deal.one', '/api/v1/opportunities', wrong, keyOf('second-try-1')).expect(400);
    expect(await stored('second-try-1')).toEqual([]);
    const right = await send(
      'deal.one',
      '/api/v1/opportunities',
      opportunityBody('Project Idem Second Try'),
      keyOf('second-try-1'),
    ).expect(201);
    expect(right.headers[REPLAYED]).toBeUndefined();
    expect(await stored('second-try-1')).toHaveLength(1);
  });

  it('accepts 1 to 200 visible ASCII characters and answers 400 for anything else, never echoing the key', async () => {
    const body = opportunityBody('Project Idem Key Shape');
    const bad = [
      '',
      'two words',
      `k${'x'.repeat(200)}`,
      `caf${String.fromCharCode(0xe9)}`,
      'tab\tkey',
    ];
    for (const key of bad) {
      const res = await send('deal.one', '/api/v1/opportunities', body, keyOf(key)).expect(400);
      const problem = problemDetails.parse(res.body);
      expect(problem.type, key).toBe(`${PROBLEM}validation`);
      expect(
        problem.errors?.map((e) => e.path),
        key,
      ).toEqual(['Idempotency-Key']);
      if (key.length > 0) expect(JSON.stringify(res.body)).not.toContain(key);
    }
    expect(await count('deal.opportunity where name = $1', [body.name])).toBe(0);
    const longest = 'k'.repeat(200);
    await send('deal.one', '/api/v1/opportunities', body, keyOf(longest)).expect(201);
    expect(await stored(longest)).toHaveLength(1);
    // The key is checked before the body: a malformed key is the answer even with a body the
    // contract would refuse, and a malformed key on a route that is not idempotent is ignored.
    const both = await send(
      'deal.one',
      '/api/v1/opportunities',
      { nope: true },
      keyOf('a b'),
    ).expect(400);
    expect(problemDetails.parse(both.body).errors?.map((e) => e.path)).toEqual(['Idempotency-Key']);
    await h
      .http()
      .get('/api/v1/valuations?limit=1')
      .set('authorization', h.as('viewer'))
      .set(keyOf('a b'))
      .expect(200);
    // A path too long to name a record is not found, and the store is never asked to key it.
    const endless = `/api/v1/closings/${NIL}/items/${'x'.repeat(600)}/commands`;
    const lost = await send('ops.one', endless, { command: 'reopen' }, keyOf('endless-1')).expect(
      404,
    );
    expect(problemType(lost)).toBe(`${PROBLEM}not-found`);
    expect(await stored('endless-1')).toEqual([]);
  });

  it('reads the header on every route the contract marks idempotent, and on no other', async () => {
    const holderOf = (route: RouteDefinition): string => {
      const role = route.roles.find((r) =>
        h.dataset.users.some((u) => u.roles.includes(r as AppRole)),
      );
      if (role === undefined) throw new Error(`no synthetic user for ${route.path}`);
      return role;
    };
    const call = (route: RouteDefinition) => {
      const path = route.path.replace(/\{[a-zA-Z]+\}/g, NIL);
      const method = route.method.toLowerCase() as 'post' | 'put' | 'patch';
      return h
        .http()
        [method](path)
        .set('authorization', h.as(holderOf(route)))
        .set(keyOf('not a key'))
        .send({ nope: true });
    };
    const keyRefused = (res: { status: number; body: unknown }): boolean =>
      res.status === 400 &&
      problemDetails.parse(res.body).errors?.some((e) => e.path === 'Idempotency-Key') === true;
    const writes = ROUTES.filter((r) => r.method !== 'GET' && r.roles.length > 0);
    const idempotent = writes.filter((r) => r.idempotent === true);
    expect(idempotent.length).toBeGreaterThanOrEqual(19);
    expect(ROUTES.filter((r) => r.idempotent === true)).toEqual(idempotent);
    for (const route of idempotent)
      expect(keyRefused(await call(route)), `${route.method} ${route.path}`).toBe(true);
    // Every other write ignores the header and goes on to refuse the body. (A write with no body
    // would run; isIdempotentRoute is checked against the whole route table further down.)
    const others = writes.filter((r) => r.idempotent !== true && r.body !== undefined);
    expect(others.length).toBeGreaterThan(0);
    for (const route of others) {
      const res = await call(route);
      expect(keyRefused(res), `${route.method} ${route.path}`).toBe(false);
      expect(res.status, `${route.method} ${route.path}`).toBe(400);
    }
  });

  it('never stores bank details: the stored answer and its replay carry none, and the request is kept sealed', async () => {
    const fund = h.dataset.sponsorFunds[0]!;
    const bankDetails = {
      bankName: 'Meridian Clearing',
      accountName: 'Synthetic Fund Nine LP',
      accountNumber: '5550001234567',
      routingCode: '026009593',
    };
    const body = {
      sponsorFundId: fund.id,
      counterpartyName: fund.name,
      bankDetails,
      sourceNote: 'Letter received by post and typed in',
    };
    const first = await send(
      'ops.one',
      '/api/v1/wire-instructions',
      body,
      keyOf('wire-propose-1'),
    ).expect(201);
    const created = wireInstructionDetail.parse(first.body);
    expect(created.bankDetails).toEqual(bankDetails);
    const snapshot = async () => ({
      versions: await count('mon.wire_instruction where sponsor_fund_id = $1', [fund.id]),
      clearReads: await count(
        "audit.event where action = 'wire_instruction.read' and entity_id = $1",
        [created.id],
      ),
      audits: await count('audit.event'),
    });
    const before = await snapshot();

    const [row] = await stored('wire-propose-1');
    const { bankDetails: _clear, ...masked } = created;
    expect(row!.response_body).toEqual({ ...masked, bankDetails: null });
    const everything = JSON.stringify(row);
    for (const secret of [
      bankDetails.accountNumber,
      bankDetails.routingCode,
      bankDetails.accountName,
    ])
      expect(everything).not.toContain(secret);
    // A bare digest of the body would let a reader of the table test guesses of the account
    // number against the masked form: what is stored is not one.
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
          : v,
      );
    const digests = [JSON.stringify(body), canonical(body)].map((text) =>
      createHash('sha256').update(text).digest('hex'),
    );
    expect(digests).not.toContain(row!.request_hash);
    expect(row!.request_hash).not.toMatch(/^[0-9a-f]{64}$/i);

    // The replay answers the stored body: the instruction, masked, with no details in clear and
    // no clear read to audit. The details are read again on the instruction itself (audited).
    const again = await send(
      'ops.one',
      '/api/v1/wire-instructions',
      body,
      keyOf('wire-propose-1'),
    ).expect(201);
    expect(again.headers[REPLAYED]).toBe('true');
    expect(again.body).toEqual({ ...masked, bankDetails: null });
    expect(await snapshot()).toEqual(before);

    // The fingerprint covers the details: the same key with another account is refused.
    const other = { ...body, bankDetails: { ...bankDetails, accountNumber: '5550001234568' } };
    const reused = await send(
      'ops.one',
      '/api/v1/wire-instructions',
      other,
      keyOf('wire-propose-1'),
    ).expect(422);
    expect(problemType(reused)).toBe(`${PROBLEM}idempotency-key-reuse`);
    expect(await snapshot()).toEqual(before);
  });

  it('reads the same body in another key order as the same request', async () => {
    const body = opportunityBody('Project Idem Reordered');
    const first = await send('deal.one', '/api/v1/opportunities', body, keyOf('reorder-1')).expect(
      201,
    );
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(body));
    const again = await send(
      'deal.one',
      '/api/v1/opportunities',
      reordered,
      keyOf('reorder-1'),
    ).expect(201);
    expect(again.headers[REPLAYED]).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await count('deal.opportunity where name = $1', [body.name])).toBe(1);
  });

  it('refuses a repeat while the first request is still running, and runs nothing', async () => {
    const body = opportunityBody('Project Idem Pending');
    const pending = async (): Promise<StoredKey> => (await stored('pending-1'))[0]!;
    // A reservation with no answer yet, as the first request leaves it while its command runs.
    await h.runtime.db.query(
      "insert into ops.idempotency_key (user_id, method, path, key, request_hash) values ($1, 'POST', '/api/v1/opportunities', 'pending-1', $2)",
      [user('deal.one').id, h.runtime.fieldCipher.encrypt(requestFingerprint(body))],
    );
    const res = await send('deal.one', '/api/v1/opportunities', body, keyOf('pending-1')).expect(
      409,
    );
    expect(problemType(res)).toBe(`${PROBLEM}idempotency-key-in-progress`);
    expect(res.headers[REPLAYED]).toBeUndefined();
    expect(await count('deal.opportunity where name = $1', [body.name])).toBe(0);
    // The refused repeat leaves the first request's reservation as it found it.
    expect(await pending()).toMatchObject({ response_status: null, response_body: null });
    // Another body on the reserved key is a reuse, running or not.
    const other = await send(
      'deal.one',
      '/api/v1/opportunities',
      opportunityBody('Project Idem Pending Other'),
      keyOf('pending-1'),
    ).expect(422);
    expect(problemType(other)).toBe(`${PROBLEM}idempotency-key-reuse`);
    expect(await pending()).toMatchObject({ response_status: null });

    // Once the first request has answered, the repeat reads that answer: the stored status and
    // body as they are (200 here, where the route itself answers 201).
    await h.runtime.db.query(
      `update ops.idempotency_key set response_status = 200, response_body = '{"id": "${NIL}"}' where key = 'pending-1'`,
    );
    const replayed = await send(
      'deal.one',
      '/api/v1/opportunities',
      body,
      keyOf('pending-1'),
    ).expect(200);
    expect(replayed.headers[REPLAYED]).toBe('true');
    expect(replayed.body).toEqual({ id: NIL });
    expect(await count('deal.opportunity where name = $1', [body.name])).toBe(0);

    // A fingerprint this process cannot open (sealed with another key) is another request.
    await h.runtime.db.query(
      "insert into ops.idempotency_key (user_id, method, path, key, request_hash, response_status, response_body) values ($1, 'POST', '/api/v1/opportunities', 'unreadable-1', 'not-sealed-here', 201, '{}')",
      [user('deal.one').id],
    );
    const unreadable = await send(
      'deal.one',
      '/api/v1/opportunities',
      body,
      keyOf('unreadable-1'),
    ).expect(422);
    expect(problemType(unreadable)).toBe(`${PROBLEM}idempotency-key-reuse`);
  });

  it('holds the key while the command runs: a repeat in that window is 409, and reads the answer afterwards', async () => {
    const body = opportunityBody('Project Idem Gate');
    const service = h.app.get(PipelineService);
    const create = service.create.bind(service);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held = vi.spyOn(service, 'create').mockImplementation(async (...args) => {
      await gate;
      return create(...args);
    });
    try {
      const first = send('deal.one', '/api/v1/opportunities', body, keyOf('gate-1')).then(
        (res) => res,
      );
      // The key is reserved, with no answer yet, by the time the command runs.
      await vi.waitFor(
        async () => {
          expect(held).toHaveBeenCalledTimes(1);
          expect(await stored('gate-1')).toMatchObject([{ response_status: null }]);
        },
        { timeout: 20_000, interval: 5 },
      );
      const during = await send('deal.one', '/api/v1/opportunities', body, keyOf('gate-1')).expect(
        409,
      );
      expect(problemType(during)).toBe(`${PROBLEM}idempotency-key-in-progress`);
      expect(held).toHaveBeenCalledTimes(1);
      expect(await count('deal.opportunity where name = $1', [body.name])).toBe(0);

      open();
      const answered = await first;
      expect(answered.status).toBe(201);
      expect(answered.headers[REPLAYED]).toBeUndefined();
      expect(await stored('gate-1')).toMatchObject([{ response_status: 201 }]);
      const after = await send('deal.one', '/api/v1/opportunities', body, keyOf('gate-1')).expect(
        201,
      );
      expect(after.headers[REPLAYED]).toBe('true');
      expect(after.body).toEqual(answered.body);
      expect(held).toHaveBeenCalledTimes(1);
      expect(await count('deal.opportunity where name = $1', [body.name])).toBe(1);
    } finally {
      open();
      held.mockRestore();
    }
  });

  it('sends the answer of a command that committed even when the key cannot be completed, and logs no content', async () => {
    const body = opportunityBody('Project Idem Lost Completion');
    const service = h.app.get(PipelineService);
    const create = service.create.bind(service);
    const db = h.app.get(DbService);
    const run = db.run.bind(db);
    let committed = false;
    const created = vi.spyOn(service, 'create').mockImplementation(async (...args) => {
      const result = await create(...args);
      committed = true;
      return result;
    });
    // The transaction after the command's own is the completion: it is lost, with an error whose
    // message carries the statement's parameters the way a failed query's does.
    const lost = vi.spyOn(db, 'run').mockImplementation((principal, requestId, fn) => {
      if (!committed) return run(principal, requestId, fn);
      committed = false;
      return Promise.reject(new Error(`Failed query: update params: ${body.name}`));
    });
    const logged = vi.spyOn(h.runtime.logger, 'error');
    try {
      const res = await send('deal.one', '/api/v1/opportunities', body, keyOf('lost-1'))
        .set('x-request-id', 'req-idem-lost-1')
        .expect(201);
      expect(opportunityDetail.parse(res.body).name).toBe(body.name);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]![0]).toEqual({
        request_id: 'req-idem-lost-1',
        user_id: user('deal.one').id,
        action: 'idempotency.complete',
        entity: 'ops.idempotency_key',
        err: { name: 'Error', code: null },
      });
      expect(JSON.stringify(logged.mock.calls)).not.toContain(body.name);
    } finally {
      created.mockRestore();
      lost.mockRestore();
      logged.mockRestore();
    }
    // The key stays reserved: a repeat is told so, and the deal is never created twice.
    expect(await stored('lost-1')).toMatchObject([{ response_status: null }]);
    const again = await send('deal.one', '/api/v1/opportunities', body, keyOf('lost-1')).expect(
      409,
    );
    expect(problemType(again)).toBe(`${PROBLEM}idempotency-key-in-progress`);
    expect(await count('deal.opportunity where name = $1', [body.name])).toBe(1);
  });

  it('runs one of two concurrent requests with the same key', async () => {
    const body = opportunityBody('Project Idem Twins');
    const results = await Promise.all(
      [0, 1].map(() =>
        send('deal.one', '/api/v1/opportunities', body, keyOf('twins-1')).then((res) => ({
          status: res.status,
          replayed: res.headers[REPLAYED] === 'true',
          type: res.status === 409 ? problemType(res) : null,
        })),
      ),
    );
    expect(await count('deal.opportunity where name = $1', [body.name])).toBe(1);
    const ran = results.filter((r) => r.status === 201 && !r.replayed);
    expect(ran).toHaveLength(1);
    const other = results.find((r) => r !== ran[0])!;
    // The second either waited for the stored answer or was told the first is still running.
    expect(
      (other.status === 201 && other.replayed) ||
        other.type === `${PROBLEM}idempotency-key-in-progress`,
    ).toBe(true);
  });
});

describe('Idempotency-Key helpers', () => {
  it('knows the idempotent routes by the server pattern and by the contract template', () => {
    expect(isIdempotentRoute('POST', '/api/v1/valuations/:id/commands')).toBe(true);
    expect(isIdempotentRoute('post', '/api/v1/valuations/{id}/commands')).toBe(true);
    expect(isIdempotentRoute('PUT', '/api/v1/opportunities/:id/allocations')).toBe(true);
    expect(isIdempotentRoute('GET', '/api/v1/valuations/:id')).toBe(false);
    expect(isIdempotentRoute('PATCH', '/api/v1/flags/:key')).toBe(false);
    for (const route of ROUTES)
      expect(isIdempotentRoute(route.method, route.path), route.path).toBe(
        route.idempotent === true,
      );
  });

  it('parses the header: absent is undefined, a repeated or malformed one is 400', () => {
    expect(idempotencyKeyOf(undefined)).toBeUndefined();
    expect(idempotencyKeyOf('7c0e9c1e-6f0e-4a57-9d0c-2a4f8a5d1b11')).toBe(
      '7c0e9c1e-6f0e-4a57-9d0c-2a4f8a5d1b11',
    );
    for (const header of ['', ' ', 'a b', 'k'.repeat(201), ['a', 'b']])
      expect(() => idempotencyKeyOf(header)).toThrow(ProblemError);
  });

  it('fingerprints a body by its content, whatever the order of its keys', () => {
    const a = { command: 'draftTicket', amount: '10.00', nested: { x: 1, y: [1, { b: 2, a: 1 }] } };
    const b = { nested: { y: [1, { a: 1, b: 2 }], x: 1 }, amount: '10.00', command: 'draftTicket' };
    expect(canonicalJson(a)).toBe(
      '{"amount":"10.00","command":"draftTicket","nested":{"x":1,"y":[1,{"a":1,"b":2}]}}',
    );
    expect(requestFingerprint(a)).toBe(requestFingerprint(b));
    // An absent body is null, and an entry with no value is no entry, as on the wire.
    expect(requestFingerprint(undefined)).toBe(requestFingerprint(null));
    expect(requestFingerprint({ a: 1, b: undefined })).toBe(requestFingerprint({ a: 1 }));
    expect(requestFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
    // Array order and values are content.
    expect(requestFingerprint({ ids: [1, 2] })).not.toBe(requestFingerprint({ ids: [2, 1] }));
    expect(requestFingerprint({ amount: '10.00' })).not.toBe(
      requestFingerprint({ amount: '10.0' }),
    );
    expect(requestFingerprint(undefined)).toBe(requestFingerprint(null));
    expect(requestFingerprint({})).not.toBe(requestFingerprint(null));
  });

  it('stores an answer as its JSON with bank details removed at any depth', () => {
    const details = { bankName: 'Meridian Clearing', accountNumber: '5550001234567' };
    expect(
      storableAnswer({
        id: 'x',
        bankDetails: details,
        bankDetailsMasked: 'Meridian Clearing ****4567',
        items: [{ bankDetails: details, version: 2 }],
        loose: { accountNumber: '5550001234567', routingCode: '026009593', accountName: 'x' },
        at: new Date('2025-06-30T12:00:00Z'),
        skipped: undefined,
      }),
    ).toEqual({
      id: 'x',
      bankDetails: null,
      bankDetailsMasked: 'Meridian Clearing ****4567',
      items: [{ bankDetails: null, version: 2 }],
      loose: { accountNumber: null, routingCode: null, accountName: 'x' },
      at: '2025-06-30T12:00:00.000Z',
    });
    expect(storableAnswer(undefined)).toBeNull();
  });
});
