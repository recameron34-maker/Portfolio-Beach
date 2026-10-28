import { isQuarterEnd } from '@pb/calc';
import {
  changeRequestCommandBody,
  changeRequestCreateBody,
  changeRequestListQuery,
  investmentDetail,
  quarterEndCheckBody,
} from '@pb/contracts';
import type {
  ChangeRequestPage,
  ChangeRequestRow,
  Person,
  QuarterEndCheckResult,
} from '@pb/contracts';
import { attempt, dealChangeRequestMachine } from '@pb/workflows';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureChangeRequests } from '../state.js';
import type { SimActor, SimChangeRequest } from '../state.js';
import {
  canOpen,
  defineSimRoute,
  knownCode,
  openException,
  pageNewestFirst,
  recordActivity,
  staleIfMatch,
} from './common.js';
import type { SimContext } from './common.js';

/**
 * Deal change requests (docs/04 M11, docs/18 section 8, decision 0013) simulated the way
 * apps/api/src/change-requests/change-requests.service.ts serves them: the one form the deal
 * team or operations submits on a position they can open, routed by the deal team to an
 * operations owner, started, then applied in a quarter end on or after the effective date or
 * rejected with a reason, every move through dealChangeRequestMachine. Visibility follows the
 * position (SEC-5.3): a request on a walled position is 404 outside the wall. The quarter-end
 * check (the M11 acceptance criterion) lists every request not Applied or Rejected by the
 * period end and opens one data exception per request not already on the queue.
 */

const NOT_FOUND = 'Change request not found';
export const QUARTER_END_SOURCE = 'change_request';
export const QUARTER_END_RULE = 'CR-QE-01';
export const QUARTER_END_SEVERITY = 'exception_severity.medium';
const OPEN_STATES = ['Submitted', 'Routed', 'InProgress'] as const;

const personOf = (actor: SimActor): Person => ({ id: actor.userId, name: actor.displayName });

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

const precondition = (instance: string, detail: string): Response =>
  problem(422, 'workflow-precondition', `deal_change_request: ${detail}`, {
    instance,
    simulated: true,
  });

/** Whether the credential may see the request: it can open the position (recorded 200). */
const visibleTo = (ctx: SimContext, credential: string, sim: SimChangeRequest): boolean =>
  canOpen(ctx, credential, sim.row.investmentId);

/** The requests the credential can see, newest first. */
function visibleRows(ctx: SimContext, credential: string): ChangeRequestRow[] {
  return [...ensureChangeRequests(ctx.state, ctx.recordings).values()]
    .filter((r) => visibleTo(ctx, credential, r))
    .map((r) => r.row);
}

/** The open requests of a position (not Applied or Rejected), latest effective date first: the valuation screen's panel. */
export function openChangeRequestsOf(
  ctx: SimContext,
  credential: string,
  investmentId: string,
): ChangeRequestRow[] {
  return visibleRows(ctx, credential)
    .filter(
      (r) => r.investmentId === investmentId && r.state !== 'Applied' && r.state !== 'Rejected',
    )
    .sort((a, b) =>
      a.effectiveDate === b.effectiveDate
        ? a.id < b.id
          ? -1
          : 1
        : a.effectiveDate < b.effectiveDate
          ? 1
          : -1,
    );
}

/** GET /api/v1/change-requests: the queue the credential may see, newest first, filtered by position and state. */
export const changeRequestsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/change-requests',
  what: 'query',
  body: null,
  query: changeRequestListQuery,
  handle: (req, ctx) => {
    const { investmentId, state } = req.query;
    const rows = visibleRows(ctx, req.credential).filter(
      (r) =>
        (investmentId === undefined || r.investmentId === investmentId) &&
        (state === undefined || r.state === state),
    );
    const page = pageNewestFirst(rows, (r) => ({ at: r.createdAt, id: r.id }), req.query);
    if (page === null)
      return problem(400, 'validation', 'Invalid cursor', {
        instance: req.url.pathname,
        simulated: true,
      });
    const body: ChangeRequestPage = { items: page.items, nextCursor: page.nextCursor };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/change-requests/{id}: one request; one on a position the credential cannot open is not found. */
export const changeRequestRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/change-requests/{id}',
  what: 'change request',
  body: null,
  handle: (req, ctx) => {
    const sim = ensureChangeRequests(ctx.state, ctx.recordings).get(req.params.id ?? '');
    if (sim === undefined || !visibleTo(ctx, req.credential, sim))
      return notFound(req.url.pathname);
    return jsonResponse(200, sim.row, { simulated: true, etag: sim.row.rowVersion });
  },
});

/** POST /api/v1/change-requests (deal team, operations): the one form on a visible position; Submitted, the actor as submitter. */
export const createChangeRequestRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/change-requests',
  what: 'change request',
  body: changeRequestCreateBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const detail = ctx.recordings.read(
      req.credential,
      `/api/v1/investments/${encodeURIComponent(req.body.investmentId)}`,
      investmentDetail,
    );
    if (detail === undefined)
      return problem(404, 'not-found', 'Investment not found', { instance, simulated: true });
    if (!knownCode(ctx, req.credential, req.body.changeType))
      return problem(400, 'validation', 'Invalid body', {
        instance,
        simulated: true,
        errors: [{ path: 'changeType', message: 'Unknown change type' }],
      });
    const row: ChangeRequestRow = {
      id: ctx.env.newId(),
      investmentId: detail.id,
      investmentName: detail.companyName,
      changeType: req.body.changeType,
      effectiveDate: req.body.effectiveDate,
      summary: req.body.summary,
      details: req.body.details,
      owner: null,
      submittedBy: personOf(req.actor),
      state: dealChangeRequestMachine.initial,
      appliedPeriod: null,
      appliedBy: null,
      rejectionReason: null,
      createdAt: ctx.env.now(),
      rowVersion: 1,
    };
    ensureChangeRequests(ctx.state, ctx.recordings).set(row.id, {
      row,
      origin: 'created',
      changed: true,
    });
    recordActivity(ctx, req.actor, {
      action: 'change_request.create',
      entity: 'change_request',
      entityId: row.id,
      reason: null,
      from: null,
      to: row.state,
    });
    return jsonResponse(201, row, { simulated: true, etag: 1 });
  },
});

/**
 * POST /api/v1/change-requests/{id}/commands: route (the deal team) names a known active owner;
 * start (operations) opens the work; apply (operations) records a quarter end on or after the
 * effective date; reject (operations) needs the reason the table requires.
 */
export const changeRequestCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/change-requests/{id}/commands',
  what: 'command',
  body: changeRequestCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const sim = ensureChangeRequests(ctx.state, ctx.recordings).get(req.params.id ?? '');
    if (sim === undefined || !visibleTo(ctx, req.credential, sim)) return notFound(instance);
    const stale = staleIfMatch(req.headers, sim.row.rowVersion, instance);
    if (stale !== null) return stale;
    const body = req.body;
    const { row } = sim;
    const result = attempt(dealChangeRequestMachine, row.state, body.command, {
      actorId: req.actor.userId,
      actorRoles: req.actor.roles,
      ...(body.command === 'reject' ? { reason: body.reason } : {}),
      record: {
        ownerId: body.command === 'route' ? body.ownerId : (row.owner?.id ?? null),
        ...(body.command === 'apply' ? { appliedPeriod: body.appliedPeriod } : {}),
      },
    });
    if (!result.ok) return workflowProblem(result, { instance, simulated: true });

    const next: ChangeRequestRow = { ...row, state: result.to, rowVersion: row.rowVersion + 1 };
    switch (body.command) {
      case 'route': {
        const owner = ctx.recordings.users.find((u) => u.userId === body.ownerId);
        if (owner === undefined)
          return precondition(instance, 'the owner is not a known active user');
        next.owner = { id: owner.userId, name: owner.displayName };
        break;
      }
      case 'start':
        break;
      case 'apply': {
        if (!isQuarterEnd(body.appliedPeriod))
          return precondition(instance, 'the applied-in period must be a quarter end');
        if (body.appliedPeriod < row.effectiveDate)
          return precondition(
            instance,
            `the applied-in period ${body.appliedPeriod} is before the effective date ${row.effectiveDate}`,
          );
        next.appliedPeriod = body.appliedPeriod;
        next.appliedBy = personOf(req.actor);
        break;
      }
      case 'reject':
        next.rejectionReason = body.reason;
        break;
    }
    sim.row = next;
    sim.changed = true;
    recordActivity(ctx, req.actor, {
      action: `change_request.${body.command}`,
      entity: 'change_request',
      entityId: row.id,
      reason: body.command === 'reject' ? body.reason : null,
      from: row.state,
      to: result.to,
    });
    return jsonResponse(200, next, { simulated: true, etag: next.rowVersion });
  },
});

/**
 * POST /api/v1/change-requests/quarter-end-check (operations): every visible request not Applied
 * or Rejected with an effective date on or before the period end, and one data exception for
 * each not already on the queue (open or acknowledged); a repeat opens nothing more.
 */
export const quarterEndCheckRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/change-requests/quarter-end-check',
  what: 'check',
  body: quarterEndCheckBody,
  idempotent: true,
  handle: (req, ctx) => {
    const { periodEnd } = req.body;
    const unapplied = visibleRows(ctx, req.credential)
      .filter(
        (r) => (OPEN_STATES as readonly string[]).includes(r.state) && r.effectiveDate <= periodEnd,
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
      );
    const listed = new Set<string>();
    for (const x of ctx.state.exceptions.values()) {
      if (
        x.entity === 'mon.deal_change_request' &&
        x.ruleId === QUARTER_END_RULE &&
        (x.state === 'open' || x.state === 'acknowledged')
      )
        listed.add(x.entityId);
    }
    let exceptionsOpened = 0;
    for (const r of unapplied) {
      if (listed.has(r.id)) continue;
      openException(ctx, {
        source: QUARTER_END_SOURCE,
        entity: 'mon.deal_change_request',
        entityId: r.id,
        ruleId: QUARTER_END_RULE,
        expected: `Applied by ${periodEnd}`,
        actual: r.state,
        severity: QUARTER_END_SEVERITY,
        candidates: [],
        file: null,
        rowNo: null,
        investmentId: r.investmentId,
      });
      exceptionsOpened += 1;
    }
    recordActivity(ctx, req.actor, {
      action: 'change_request.quarter_end_check',
      entity: 'change_request',
      entityId: periodEnd,
      reason: null,
      from: null,
      to: null,
      details: { unapplied: unapplied.length, exceptionsOpened },
    });
    const body: QuarterEndCheckResult = { periodEnd, unapplied, exceptionsOpened };
    return jsonResponse(200, body, { simulated: true });
  },
});
