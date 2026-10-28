import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, containingQuarterEnd, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  changeRequestPage,
  changeRequestRow,
  dataExceptionPage,
  problemDetails,
  quarterEndCheckResult,
} from '@pb/contracts';
import type { ChangeRequestRow, ChangeRequestState } from '@pb/contracts';
import { withUserContext } from '@pb/db';
import { dealChangeRequestMachine, forbiddenPairs } from '@pb/workflows';
import type { ChangeRequestCommand } from '@pb/workflows';
import { openChangeRequestsFor } from '../change-requests/queries.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const OPEN: readonly ChangeRequestState[] = ['Submitted', 'Routed', 'InProgress'];
const OWNER = 'ops.one';

describe('deal change requests (M11, docs/18 section 8): the one form, the owner, the applied-in period and the quarter-end check', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const person = (externalId: string) => ({
    id: user(externalId).id,
    name: user(externalId).displayName,
  });
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const openId = (): string => h.dataset.scenarios.change_request_open![0]!;
  /** An active position outside the wall, the one new requests are made on. */
  const visibleInvestment = () =>
    h.dataset.investments.find((i) => i.isActive && i.id !== walledId())!;
  const asOf = (): string => h.dataset.asOf;
  /** The quarter end the as-of date falls in, and the one before it. */
  const quarterEnd = (): string => containingQuarterEnd(asOf());
  const priorQuarterEnd = (): string => latestQuarterEndOnOrBefore(addDays(quarterEnd(), -1));
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql, params))[0]!.n;
  const auditCount = (action: string, requestId: string): Promise<number> =>
    count('select count(*)::int as n from audit.event where action = $1 and request_id = $2', [
      action,
      requestId,
    ]);
  const auditDetails = async (
    action: string,
    requestId: string,
  ): Promise<Record<string, unknown>> =>
    (
      await h.runtime.db.query<{ details: Record<string, unknown>; reason: string | null }>(
        'select details, reason from audit.event where action = $1 and request_id = $2',
        [action, requestId],
      )
    ).map((e) => ({ ...e.details, reason: e.reason }))[0]!;

  const listAs = (who: string, query = '', requestId = 'req-cr-list') =>
    h
      .http()
      .get(`/api/v1/change-requests${query}`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId);
  const list = async (who: string, query = '') =>
    changeRequestPage.parse((await listAs(who, query).expect(200)).body);
  const detailAs = (who: string, id: string, requestId = 'req-cr-detail') =>
    h
      .http()
      .get(`/api/v1/change-requests/${id}`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId);
  const detail = async (who: string, id: string) =>
    changeRequestRow.parse((await detailAs(who, id).expect(200)).body);
  const createAs = (who: string, body: object, requestId = 'req-cr-create') =>
    h
      .http()
      .post('/api/v1/change-requests')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  /** The one form, filled for a position; `extra` overrides or adds fields. */
  const form = (investmentId: string, extra: object = {}) => ({
    investmentId,
    changeType: 'change_type.add_on_acquisition',
    effectiveDate: asOf(),
    summary: 'Add-on acquisition of a regional competitor closed',
    details: { target: 'A regional competitor' },
    ...extra,
  });
  const create = async (who = 'deal.one', requestId = 'req-cr-create') =>
    changeRequestRow.parse(
      (await createAs(who, form(visibleInvestment().id), requestId).expect(201)).body,
    );
  const commandAs = (
    who: string,
    id: string,
    body: object,
    requestId = 'req-cr-command',
    headers: Record<string, string> = {},
  ) =>
    h
      .http()
      .post(`/api/v1/change-requests/${id}/commands`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .set(headers)
      .send(body);
  const command = async (who: string, id: string, body: object, requestId = 'req-cr-command') =>
    changeRequestRow.parse((await commandAs(who, id, body, requestId).expect(200)).body);
  const route = (id: string, requestId?: string) =>
    command('deal.one', id, { command: 'route', ownerId: user(OWNER).id }, requestId);
  const start = (id: string, requestId?: string) =>
    command(OWNER, id, { command: 'start' }, requestId);
  const apply = (id: string, requestId?: string) =>
    command(OWNER, id, { command: 'apply', appliedPeriod: quarterEnd() }, requestId);
  const reject = (id: string, requestId?: string) =>
    command(OWNER, id, { command: 'reject', reason: 'Already reflected in the record' }, requestId);
  /** A fresh request moved to the state named, through the API. */
  const inState = async (state: ChangeRequestState): Promise<ChangeRequestRow> => {
    const made = await create();
    if (state === 'Submitted') return made;
    const routed = await route(made.id);
    if (state === 'Routed') return routed;
    if (state === 'Rejected') return reject(made.id);
    const started = await start(made.id);
    if (state === 'InProgress') return started;
    return apply(made.id);
  };
  const checkAs = (who: string, body: object, requestId = 'req-cr-qe') =>
    h
      .http()
      .post('/api/v1/change-requests/quarter-end-check')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const exceptionsOf = async (): Promise<
    { entity_id: string; expected: string; actual: string; severity: string; state: string }[]
  > =>
    h.runtime.db.query(
      "select entity_id, expected, actual, severity, state from ops.data_exception where source = 'change_request' and rule_id = 'CR-QE-01' and entity = 'mon.deal_change_request' order by entity_id",
    );

  it('lists the synthetic requests the caller may see, named, with their people, and filters by state and position', async () => {
    const ops = await list(OWNER);
    const synthetic = h.dataset.changeRequests ?? [];
    expect(synthetic.length).toBe(6);
    expect(ops.items.map((r) => r.id).sort()).toEqual(synthetic.map((r) => r.id).sort());
    expect(ops.nextCursor).toBeNull();
    for (const r of ops.items) {
      const row = synthetic.find((s) => s.id === r.id)!;
      const company = h.dataset.portfolioCompanies.find(
        (c) =>
          c.id === h.dataset.investments.find((i) => i.id === r.investmentId)!.portfolioCompanyId,
      )!;
      expect(r.investmentName).toBe(company.name);
      expect(r.submittedBy).toEqual(person('deal.one'));
      expect(r.owner).toEqual(r.state === 'Submitted' ? null : person(OWNER));
      expect(r.summary).toBe(row.summary);
      expect(r.details).toEqual(row.details);
      expect(r.effectiveDate).toBe(row.effectiveDate);
      expect(r.appliedPeriod).toBe(row.appliedPeriod);
      expect(r.appliedBy).toEqual(r.state === 'Applied' ? person(OWNER) : null);
      expect(r.rejectionReason).toBe(row.rejectionReason);
      expect(r.rowVersion).toBe(1);
    }
    expect(ops.items.map((r) => r.state).sort()).toEqual(
      ['Applied', 'Applied', 'InProgress', 'Rejected', 'Routed', 'Submitted'].sort(),
    );
    expect((await list(OWNER, '?state=InProgress')).items.map((r) => r.id)).toEqual([openId()]);
    expect((await list(OWNER, '?state=Applied')).items.length).toBe(2);
    const first = ops.items[0]!;
    const ofPosition = await list('deal.one', `?investmentId=${first.investmentId}`);
    expect(ofPosition.items.every((r) => r.investmentId === first.investmentId)).toBe(true);
    expect(ofPosition.items.map((r) => r.id)).toContain(first.id);
    expect((await list(OWNER, `?investmentId=${walledId()}`)).items).toEqual([]);
    const bad = problemDetails.parse((await listAs(OWNER, '?state=bogus').expect(400)).body);
    expect(bad.errors?.map((e) => e.path)).toEqual(['state']);
    await listAs(OWNER, '?investmentId=nope').expect(400);
    await listAs(OWNER, '?other=1').expect(400);
  });

  it('pages on (createdAt, id) without overlap and refuses a forged cursor', async () => {
    const all = (await list(OWNER)).items.map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list(OWNER, `?limit=4${cursor === null ? '' : `&cursor=${cursor}`}`);
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(Math.ceil(all.length / 4));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all);
    const forged = Buffer.from('2025-13-40T00:00:00.000000Z|not-an-id').toString('base64url');
    const res = await listAs(OWNER, `?cursor=${forged}`).expect(400);
    expect(problemDetails.parse(res.body).detail).toBe('Invalid cursor');
  });

  it('submits from the one form (201, the row version as ETag), audits it, and refuses an unknown change type, an unseen position, a body outside the contract and the roles without the form', async () => {
    const inv = visibleInvestment();
    const res = await createAs('deal.one', form(inv.id), 'req-cr-create-1').expect(201);
    const made = changeRequestRow.parse(res.body);
    expect(res.headers.etag).toBe('"1"');
    expect(made).toMatchObject({
      investmentId: inv.id,
      changeType: 'change_type.add_on_acquisition',
      effectiveDate: asOf(),
      summary: 'Add-on acquisition of a regional competitor closed',
      details: { target: 'A regional competitor' },
      owner: null,
      submittedBy: person('deal.one'),
      state: 'Submitted',
      appliedPeriod: null,
      appliedBy: null,
      rejectionReason: null,
      rowVersion: 1,
    });
    expect(await auditCount('change_request.create', 'req-cr-create-1')).toBe(1);
    const audit = await auditDetails('change_request.create', 'req-cr-create-1');
    expect(audit.state).toEqual({ before: null, after: 'Submitted' });
    expect(audit.investmentId).toBe(inv.id);
    expect(await detail('deal.one', made.id)).toEqual(made);
    // Operations may submit too, and the details default to an empty form.
    const byOps = changeRequestRow.parse(
      (await createAs('ops.two', form(inv.id, { details: undefined })).expect(201)).body,
    );
    expect(byOps.submittedBy).toEqual(person('ops.two'));
    expect(byOps.details).toEqual({});
    // A code of another domain fails the contract; a well-formed code the taxonomy lacks fails here.
    await createAs('deal.one', form(inv.id, { changeType: 'sector.software' })).expect(400);
    const unknown = problemDetails.parse(
      (
        await createAs('deal.one', form(inv.id, { changeType: 'change_type.not_a_thing' })).expect(
          400,
        )
      ).body,
    );
    expect(unknown.errors?.map((e) => e.path)).toEqual(['changeType']);
    await createAs('deal.one', form('00000000-0000-4000-8000-00000000dead')).expect(404);
    await createAs('deal.one', form(inv.id, { summary: 'ab' })).expect(400);
    await createAs('deal.one', form(inv.id, { effectiveDate: '2025-02-30' })).expect(400);
    await createAs('deal.one', form(inv.id, { extra: 1 })).expect(400);
    await createAs('deal.one', form(inv.id, { details: { note: 'a\u0000b' } })).expect(400);
    for (const who of ['viewer', 'ir.one', 'head.one', 'audit.one']) {
      const refused = await createAs(who, form(inv.id)).expect(403);
      expect(problemDetails.parse(refused.body).type, who).toBe(`${PROBLEM}forbidden`);
    }
  });

  it('walks the full path: route to an owner, start, apply in a quarter end; every step audited with the state before and after, the row version advancing, Applied terminal', async () => {
    const made = await create('deal.one', 'req-cr-path-0');
    const routed = await command(
      'deal.one',
      made.id,
      { command: 'route', ownerId: user(OWNER).id },
      'req-cr-path-1',
    );
    expect(routed.state).toBe('Routed');
    expect(routed.owner).toEqual(person(OWNER));
    expect(routed.rowVersion).toBe(2);
    let audit = await auditDetails('change_request.route', 'req-cr-path-1');
    expect(audit.state).toEqual({ before: 'Submitted', after: 'Routed' });
    expect(audit.owner).toEqual({ before: null, after: user(OWNER).id });
    expect(audit.investmentId).toBe(made.investmentId);
    // The audit names the deal team member who routed it.
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'change_request.route' and request_id = 'req-cr-path-1' and actor_id = $1",
        [user('deal.one').id],
      ),
    ).toBe(1);
    const started = await command(OWNER, made.id, { command: 'start' }, 'req-cr-path-2');
    expect(started.state).toBe('InProgress');
    expect(started.owner).toEqual(person(OWNER));
    expect(started.rowVersion).toBe(3);
    audit = await auditDetails('change_request.start', 'req-cr-path-2');
    expect(audit.state).toEqual({ before: 'Routed', after: 'InProgress' });
    expect(audit.owner).toEqual({ before: user(OWNER).id, after: user(OWNER).id });
    const applied = await command(
      OWNER,
      made.id,
      { command: 'apply', appliedPeriod: quarterEnd() },
      'req-cr-path-3',
    );
    expect(applied.state).toBe('Applied');
    expect(applied.appliedPeriod).toBe(quarterEnd());
    expect(applied.appliedBy).toEqual(person(OWNER));
    expect(applied.owner).toEqual(person(OWNER));
    expect(applied.rowVersion).toBe(4);
    audit = await auditDetails('change_request.apply', 'req-cr-path-3');
    expect(audit.state).toEqual({ before: 'InProgress', after: 'Applied' });
    expect(audit.appliedPeriod).toEqual({ before: null, after: quarterEnd() });
    // The applied-at time comes from the clock, never from the wall clock.
    const [row] = await h.runtime.db.query<{ applied_at: string | Date }>(
      'select applied_at from mon.deal_change_request where id = $1',
      [made.id],
    );
    expect(new Date(row!.applied_at).toISOString()).toBe(`${asOf()}T12:00:00.000Z`);
    for (const body of [
      { command: 'start' },
      { command: 'apply', appliedPeriod: quarterEnd() },
      { command: 'reject', reason: 'too late to reject' },
    ]) {
      const res = await commandAs(OWNER, made.id, body, 'req-cr-path-9').expect(409);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}workflow-transition`);
    }
    await commandAs('deal.one', made.id, { command: 'route', ownerId: user(OWNER).id }).expect(409);
    const after = await detail(OWNER, made.id);
    expect(after.state).toBe('Applied');
    expect(after.rowVersion).toBe(4);
    expect(
      await count("select count(*)::int as n from audit.event where request_id = 'req-cr-path-9'"),
    ).toBe(0);
  });

  it('rejects with a reason from Routed and from InProgress; the reason is required by the contract and by the table; Rejected is terminal', async () => {
    const routed = await inState('Routed');
    await commandAs(OWNER, routed.id, { command: 'reject' }).expect(400);
    const blank = problemDetails.parse(
      (await commandAs(OWNER, routed.id, { command: 'reject', reason: '   ' }).expect(422)).body,
    );
    expect(blank.type).toBe(`${PROBLEM}workflow-precondition`);
    expect((await detail(OWNER, routed.id)).state).toBe('Routed');
    const rejected = await command(
      OWNER,
      routed.id,
      { command: 'reject', reason: 'Already reflected in the record' },
      'req-cr-reject-1',
    );
    expect(rejected.state).toBe('Rejected');
    expect(rejected.rejectionReason).toBe('Already reflected in the record');
    expect(rejected.owner).toEqual(person(OWNER));
    const audit = await auditDetails('change_request.reject', 'req-cr-reject-1');
    expect(audit.state).toEqual({ before: 'Routed', after: 'Rejected' });
    expect(audit.reason).toBe('Already reflected in the record');
    const working = await inState('InProgress');
    expect((await reject(working.id)).state).toBe('Rejected');
    for (const row of [routed, working]) {
      await commandAs('deal.one', row.id, { command: 'route', ownerId: user(OWNER).id }).expect(
        409,
      );
      await commandAs(OWNER, row.id, { command: 'start' }).expect(409);
      expect((await detail(OWNER, row.id)).state).toBe('Rejected');
    }
  });

  it('answers 409 for every (state, command) pair the table forbids, through the API, and changes nothing', async () => {
    const rows = new Map<ChangeRequestState, ChangeRequestRow>();
    for (const state of dealChangeRequestMachine.states) rows.set(state, await inState(state));
    const bodies: Record<ChangeRequestCommand, object> = {
      route: { command: 'route', ownerId: user(OWNER).id },
      start: { command: 'start' },
      apply: { command: 'apply', appliedPeriod: quarterEnd() },
      reject: { command: 'reject', reason: 'A reason the table would accept' },
    };
    const issuer: Record<ChangeRequestCommand, string> = {
      route: 'deal.one',
      start: OWNER,
      apply: OWNER,
      reject: OWNER,
    };
    const pairs = forbiddenPairs(dealChangeRequestMachine);
    expect(pairs.length).toBe(15);
    for (const { from, command: cmd } of pairs) {
      const row = rows.get(from)!;
      expect(row.state).toBe(from);
      const res = await commandAs(issuer[cmd], row.id, bodies[cmd], 'req-cr-forbidden').expect(409);
      expect(problemDetails.parse(res.body).type, `${from} ${cmd}`).toBe(
        `${PROBLEM}workflow-transition`,
      );
      const after = await detail(OWNER, row.id);
      expect(after.state, `${from} ${cmd}`).toBe(from);
      expect(after.rowVersion, `${from} ${cmd}`).toBe(row.rowVersion);
    }
    expect(
      await count(
        "select count(*)::int as n from audit.event where request_id = 'req-cr-forbidden'",
      ),
    ).toBe(0);
  });

  it('refuses the roles the table does not name with 403 (operations cannot route, the deal team cannot start, apply or reject) and keeps the queue to its roles', async () => {
    const made = await inState('Submitted');
    const refused = problemDetails.parse(
      (await commandAs(OWNER, made.id, { command: 'route', ownerId: user(OWNER).id }).expect(403))
        .body,
    );
    expect(refused.type).toBe(`${PROBLEM}forbidden`);
    expect((await detail(OWNER, made.id)).state).toBe('Submitted');
    const routed = await route(made.id);
    for (const body of [{ command: 'start' }, { command: 'reject', reason: 'not mine to reject' }])
      await commandAs('deal.one', routed.id, body).expect(403);
    await start(routed.id);
    await commandAs('deal.one', routed.id, {
      command: 'apply',
      appliedPeriod: quarterEnd(),
    }).expect(403);
    // The route guard: a viewer and investor relations have no queue; an approver and an auditor
    // read it but never command, and only operations runs the quarter-end check.
    await listAs('viewer').expect(403);
    await detailAs('viewer', made.id).expect(403);
    await listAs('ir.one').expect(403);
    for (const who of ['head.one', 'audit.one']) {
      await listAs(who).expect(200);
      await detailAs(who, made.id).expect(200);
      const res = await commandAs(who, routed.id, {
        command: 'apply',
        appliedPeriod: quarterEnd(),
      }).expect(403);
      expect(problemDetails.parse(res.body).type, who).toBe(`${PROBLEM}forbidden`);
    }
    for (const who of ['deal.one', 'head.one', 'audit.one', 'viewer'])
      await checkAs(who, { periodEnd: quarterEnd() }).expect(403);
    expect((await detail(OWNER, routed.id)).state).toBe('InProgress');
  });

  it('apply needs a quarter end on or after the effective date, and route needs a known active owner', async () => {
    const working = await inState('InProgress');
    const notQuarter = problemDetails.parse(
      (
        await commandAs(OWNER, working.id, {
          command: 'apply',
          appliedPeriod: '2025-02-15',
        }).expect(400)
      ).body,
    );
    expect(notQuarter.errors?.map((e) => e.path)).toEqual(['appliedPeriod']);
    await commandAs(OWNER, working.id, { command: 'apply', appliedPeriod: '2025-02-30' }).expect(
      400,
    );
    await commandAs(OWNER, working.id, { command: 'apply' }).expect(400);
    const early = problemDetails.parse(
      (
        await commandAs(OWNER, working.id, {
          command: 'apply',
          appliedPeriod: priorQuarterEnd(),
        }).expect(422)
      ).body,
    );
    expect(early.type).toBe(`${PROBLEM}workflow-precondition`);
    expect(early.detail).toContain('before the effective date');
    expect((await detail(OWNER, working.id)).state).toBe('InProgress');
    const made = await inState('Submitted');
    await commandAs('deal.one', made.id, { command: 'route' }).expect(400);
    await commandAs('deal.one', made.id, { command: 'route', ownerId: 'nope' }).expect(400);
    const unknown = problemDetails.parse(
      (
        await commandAs('deal.one', made.id, {
          command: 'route',
          ownerId: '00000000-0000-4000-8000-00000000dead',
        }).expect(422)
      ).body,
    );
    expect(unknown.type).toBe(`${PROBLEM}workflow-precondition`);
    expect((await detail('deal.one', made.id)).state).toBe('Submitted');
  });

  it('the quarter-end check lists every unapplied request on or before the period end and opens one data exception each (the change_request_open one among them), none on a repeat, and one again once the earlier one is resolved', async () => {
    const periodEnd = quarterEnd();
    expect(await exceptionsOf()).toEqual([]);
    const expectedIds = (await list(OWNER, '?limit=200')).items
      .filter((r) => OPEN.includes(r.state) && r.effectiveDate <= periodEnd)
      .map((r) => r.id)
      .sort();
    expect(expectedIds).toContain(openId());
    const first = quarterEndCheckResult.parse(
      (await checkAs(OWNER, { periodEnd }, 'req-cr-qe-1').expect(200)).body,
    );
    expect(first.periodEnd).toBe(periodEnd);
    expect(first.unapplied.map((r) => r.id).sort()).toEqual(expectedIds);
    expect(
      first.unapplied.every(
        (r) => r.effectiveDate <= periodEnd && r.state !== 'Applied' && r.state !== 'Rejected',
      ),
    ).toBe(true);
    for (const r of first.unapplied) expect(changeRequestRow.parse(r)).toEqual(r);
    expect(first.exceptionsOpened).toBe(expectedIds.length);
    const opened = await exceptionsOf();
    expect(opened.map((e) => e.entity_id)).toEqual(expectedIds);
    expect(opened.find((e) => e.entity_id === openId())).toEqual({
      entity_id: openId(),
      expected: `Applied by ${periodEnd}`,
      actual: 'InProgress',
      severity: 'exception_severity.medium',
      state: 'open',
    });
    // They sit on the Data Health queue, where operations works them.
    const queue = dataExceptionPage.parse(
      (
        await h
          .http()
          .get('/api/v1/data-exceptions?source=change_request&limit=200')
          .set('authorization', h.as(OWNER))
          .set('x-request-id', 'req-cr-qe-queue')
          .expect(200)
      ).body,
    );
    expect(queue.items.map((x) => x.entityId).sort()).toEqual(expectedIds);
    expect(queue.items.every((x) => x.ruleId === 'CR-QE-01' && x.state === 'open')).toBe(true);
    const audit = await auditDetails('change_request.quarter_end_check', 'req-cr-qe-1');
    expect(audit.periodEnd).toBe(periodEnd);
    expect(audit.unapplied).toBe(expectedIds.length);
    expect(audit.exceptionsOpened).toBe(expectedIds.length);
    expect((audit.requestIds as string[]).sort()).toEqual(expectedIds);
    // A second run for the same period lists the same requests and opens nothing more.
    const again = quarterEndCheckResult.parse(
      (await checkAs(OWNER, { periodEnd }, 'req-cr-qe-2').expect(200)).body,
    );
    expect(again.unapplied.map((r) => r.id).sort()).toEqual(expectedIds);
    expect(again.exceptionsOpened).toBe(0);
    expect((await exceptionsOf()).length).toBe(expectedIds.length);
    expect(
      (await auditDetails('change_request.quarter_end_check', 'req-cr-qe-2')).exceptionsOpened,
    ).toBe(0);
    // An acknowledged exception is still on the queue; a resolved one is not, so the problem
    // coming back at the next run opens a new one.
    const ofOpen = queue.items.find((x) => x.entityId === openId())!;
    const exceptionCommand = (body: object) =>
      h
        .http()
        .post(`/api/v1/data-exceptions/${ofOpen.id}/commands`)
        .set('authorization', h.as(OWNER))
        .set('x-request-id', 'req-cr-qe-x')
        .send(body)
        .expect(200);
    await exceptionCommand({ command: 'acknowledge' });
    expect(
      quarterEndCheckResult.parse((await checkAs(OWNER, { periodEnd }).expect(200)).body)
        .exceptionsOpened,
    ).toBe(0);
    await exceptionCommand({ command: 'resolve', reason: 'Applied in the quarter after all' });
    const third = quarterEndCheckResult.parse(
      (await checkAs(OWNER, { periodEnd }, 'req-cr-qe-3').expect(200)).body,
    );
    expect(third.exceptionsOpened).toBe(1);
    expect(
      (await exceptionsOf()).filter((e) => e.entity_id === openId()).map((e) => e.state),
    ).toEqual(['open', 'resolved']);
    // A period end that is no quarter end, or a body outside the contract, is refused at the boundary.
    const notQuarter = problemDetails.parse(
      (await checkAs(OWNER, { periodEnd: '2025-02-15' }).expect(400)).body,
    );
    expect(notQuarter.errors?.map((e) => e.path)).toEqual(['periodEnd']);
    await checkAs(OWNER, { periodEnd, extra: 1 }).expect(400);
    await checkAs(OWNER, {}).expect(400);
    // An earlier period end lists only what was effective by then.
    const earlier = quarterEndCheckResult.parse(
      (await checkAs(OWNER, { periodEnd: priorQuarterEnd() }).expect(200)).body,
    );
    expect(earlier.unapplied.every((r) => r.effectiveDate <= priorQuarterEnd())).toBe(true);
    expect(earlier.unapplied.map((r) => r.id)).not.toContain(openId());
  });

  it('If-Match: a stale row version is 412 and changes nothing, the current one goes through with the new ETag, a malformed header is 400', async () => {
    const made = await inState('Submitted');
    const body = { command: 'route', ownerId: user(OWNER).id };
    const stale = problemDetails.parse(
      (
        await commandAs('deal.one', made.id, body, 'req-cr-ifmatch-1', {
          'if-match': '"7"',
        }).expect(412)
      ).body,
    );
    expect(stale.type).toBe(`${PROBLEM}stale-if-match`);
    expect((await detail('deal.one', made.id)).rowVersion).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from audit.event where request_id = 'req-cr-ifmatch-1'",
      ),
    ).toBe(0);
    await commandAs('deal.one', made.id, body, 'req-cr-ifmatch-2', { 'if-match': 'latest' }).expect(
      400,
    );
    const res = await commandAs('deal.one', made.id, body, 'req-cr-ifmatch-3', {
      'if-match': 'W/"1"',
    }).expect(200);
    expect(res.headers.etag).toBe('"2"');
    expect(changeRequestRow.parse(res.body).rowVersion).toBe(2);
    const bare = await commandAs(OWNER, made.id, { command: 'start' }, 'req-cr-ifmatch-4', {
      'if-match': '2',
    }).expect(200);
    expect(bare.headers.etag).toBe('"3"');
    const shown = await detailAs(OWNER, made.id).expect(200);
    expect(shown.headers.etag).toBe('"3"');
  });

  it("a walled position's requests are 404 outside the wall (the position cannot even be named) and visible to its members", async () => {
    const walled = walledId();
    await createAs('deal.one', form(walled)).expect(404);
    await createAs(OWNER, form(walled)).expect(404);
    const made = changeRequestRow.parse(
      (await createAs('deal.three', form(walled), 'req-cr-wall-1').expect(201)).body,
    );
    expect(made.investmentId).toBe(walled);
    for (const who of [OWNER, 'deal.one', 'audit.one']) {
      await detailAs(who, made.id).expect(404);
      expect((await list(who, '?limit=200')).items.map((r) => r.id)).not.toContain(made.id);
      expect(JSON.stringify(await list(who, '?limit=200'))).not.toContain(walled);
    }
    expect((await detail('deal.three', made.id)).id).toBe(made.id);
    expect((await detail('head.one', made.id)).id).toBe(made.id);
    expect((await list('deal.three', `?investmentId=${walled}`)).items.map((r) => r.id)).toEqual([
      made.id,
    ]);
    // A command from outside is 404 and leaves no trace.
    await commandAs(OWNER, made.id, { command: 'start' }, 'req-cr-wall-2').expect(404);
    await commandAs(
      'deal.one',
      made.id,
      { command: 'route', ownerId: user(OWNER).id },
      'req-cr-wall-2',
    ).expect(404);
    expect(
      await count("select count(*)::int as n from audit.event where request_id = 'req-cr-wall-2'"),
    ).toBe(0);
    // The member routes it; the owner named outside the wall still cannot open it (the wall is the position's).
    const routed = await command(
      'deal.three',
      made.id,
      { command: 'route', ownerId: user(OWNER).id },
      'req-cr-wall-3',
    );
    expect(routed.state).toBe('Routed');
    await detailAs(OWNER, made.id).expect(404);
    await detailAs('viewer', made.id).expect(403);
    // The quarter-end check run by operations outside the wall does not list it.
    const result = quarterEndCheckResult.parse(
      (await checkAs(OWNER, { periodEnd: quarterEnd() }).expect(200)).body,
    );
    expect(result.unapplied.map((r) => r.id)).not.toContain(made.id);
    // An unknown or malformed id is 404 as well.
    await detailAs(OWNER, '00000000-0000-4000-8000-00000000dead').expect(404);
    await detailAs(OWNER, 'nope').expect(404);
    await commandAs(OWNER, 'nope', { command: 'start' }).expect(404);
  });

  it("openChangeRequestsFor reads one position's requests not Applied or Rejected for the valuation screen, under the caller's walls", async () => {
    const inv = visibleInvestment();
    const ops = user(OWNER);
    const open = await withUserContext(
      h.runtime.db.db,
      { userId: ops.id, roles: ops.roles },
      (tx) => openChangeRequestsFor(tx, inv.id),
    );
    const expected = (await list(OWNER, `?investmentId=${inv.id}&limit=200`)).items.filter(
      (r) => r.state !== 'Applied' && r.state !== 'Rejected',
    );
    expect(open.length).toBeGreaterThan(0);
    expect(open.map((r) => r.id).sort()).toEqual(expected.map((r) => r.id).sort());
    for (let i = 1; i < open.length; i++)
      expect(open[i - 1]!.effectiveDate >= open[i]!.effectiveDate).toBe(true);
    for (const r of open) expect(changeRequestRow.parse(r)).toEqual(r);
    const outsider = await withUserContext(
      h.runtime.db.db,
      { userId: ops.id, roles: ops.roles },
      (tx) => openChangeRequestsFor(tx, walledId()),
    );
    expect(outsider).toEqual([]);
    const member = user('deal.three');
    const seen = await withUserContext(
      h.runtime.db.db,
      { userId: member.id, roles: member.roles },
      (tx) => openChangeRequestsFor(tx, walledId()),
    );
    expect(seen.map((r) => r.state)).toEqual(['Routed']);
  });
});
