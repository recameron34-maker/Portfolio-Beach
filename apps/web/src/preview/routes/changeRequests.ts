import { containingQuarterEnd, isQuarterEnd } from '@pb/calc';
import {
  API_PREFIX,
  ROUTES,
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
 * team or operations submits on a position they can open, routed by the deal team to an owner
 * who can open the request (inside the position's wall when it has one), started, then applied
 * in a quarter end on or after the effective date and no later than the quarter the clock is in,
 * or rejected with a reason, every move through dealChangeRequestMachine. Visibility follows the
 * position (SEC-5.3): a request on a walled position is 404 outside the wall. The quarter-end
 * check (the M11 acceptance criterion) covers every request on the book that is not Applied or
 * Rejected by the period end, whoever runs it: one data exception per request not already on
 * the queue, the ones behind a wall the runner is outside of included. The answer lists the
 * requests the runner may see and counts the others as hidden; each exception is then read
 * under its request's own visibility (routes/exceptions.ts). "Today" is the as-of date of the
 * recordings, the API clock's today when the preview was built.
 */

const NOT_FOUND = 'Change request not found';
export const QUARTER_END_SOURCE = 'change_request';
export const QUARTER_END_RULE = 'CR-QE-01';
export const QUARTER_END_SEVERITY = 'exception_severity.medium';
const OPEN_STATES = ['Submitted', 'Routed', 'InProgress'] as const;
/**
 * The roles the change request routes serve, read from the contract's route table: the valuation
 * screen lists a position's open requests for these roles only (CR-5), as the API does.
 */
const CHANGE_REQUEST_READERS: readonly string[] =
  ROUTES.find((r) => r.method === 'GET' && r.path === `${API_PREFIX}/change-requests`)?.roles ?? [];

/** Text order, for the sorts below (ISO dates and timestamps sort as text). */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/**
 * The open requests of a position (not Applied or Rejected), latest effective date first, then
 * the newest: the valuation screen's panel. An empty list for a reader the change request routes
 * do not serve (a viewer, investor relations), so the screen shows nobody what GET
 * /change-requests refuses them (CR-5).
 */
export function openChangeRequestsOf(
  ctx: SimContext,
  credential: string,
  roles: readonly string[],
  investmentId: string,
): ChangeRequestRow[] {
  if (!roles.some((role) => CHANGE_REQUEST_READERS.includes(role))) return [];
  return visibleRows(ctx, credential)
    .filter(
      (r) => r.investmentId === investmentId && r.state !== 'Applied' && r.state !== 'Rejected',
    )
    .sort(
      (a, b) =>
        byText(b.effectiveDate, a.effectiveDate) ||
        byText(b.createdAt, a.createdAt) ||
        byText(b.id, a.id),
    );
}

/**
 * Whether a person could open a request on the position, the question the API asks of
 * pb.user_inside_wall before a request is routed to them: true when no wall covers the position,
 * or the person is inside it. The recordings carry the walls as each user's own answer: a
 * position is walled when the detail of someone who reads positions answered 404, and a person
 * is inside when their own answered 200. A position a simulated close created has no wall.
 */
function insideWall(ctx: SimContext, ownerCredential: string, investmentId: string): boolean {
  if (ctx.state.investments.has(investmentId)) return true;
  const path = `/api/v1/investments/${encodeURIComponent(investmentId)}`;
  const walled = ctx.recordings.users.some(
    (u) => ctx.recordings.status(u.externalId, path) === 404,
  );
  return !walled || ctx.recordings.status(ownerCredential, path) === 200;
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
  what: 'body',
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
 * POST /api/v1/change-requests/{id}/commands: route (the deal team) names a known active owner
 * who can open the request (inside the position's wall when it has one); start (operations)
 * opens the work; apply (operations) records a quarter end on or after the effective date and
 * no later than the quarter the clock is in; reject (operations) needs the reason the table
 * requires. A refusal writes nothing and records nothing.
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
        if (!insideWall(ctx, owner.externalId, row.investmentId))
          return precondition(
            instance,
            'the owner is outside the wall of this position and could not open the request; name an owner inside the wall',
          );
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
        // A change is applied in a quarter that has started: never one the clock has not reached.
        const currentQuarterEnd = containingQuarterEnd(ctx.recordings.asOf);
        if (body.appliedPeriod > currentQuarterEnd)
          return precondition(
            instance,
            `the applied-in period ${body.appliedPeriod} is after the current quarter end ${currentQuarterEnd}`,
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
 * POST /api/v1/change-requests/quarter-end-check (operations): every request on the book not
 * Applied or Rejected with an effective date on or before the period end gets a data exception
 * unless one is still on the queue (open or acknowledged), whoever runs the check: the scan and
 * the exceptions are the system actor's in the API, so a request behind a wall the runner is
 * outside of is covered like the rest. The answer lists the requests the runner may see, the
 * earliest effective date first, and counts the others as hidden; exceptionsOpened counts every
 * exception the run opened, the hidden ones included. A repeat opens nothing more. The activity
 * entry carries the counts only, never a hidden id.
 */
export const quarterEndCheckRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/change-requests/quarter-end-check',
  what: 'body',
  body: quarterEndCheckBody,
  idempotent: true,
  handle: (req, ctx) => {
    const { periodEnd } = req.body;
    const scanned = [...ensureChangeRequests(ctx.state, ctx.recordings).values()].filter(
      ({ row }) =>
        (OPEN_STATES as readonly string[]).includes(row.state) && row.effectiveDate <= periodEnd,
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
    for (const { row } of scanned) {
      if (listed.has(row.id)) continue;
      // About a request, not a staged row: the exception names no file and no position (the
      // API's queue reads a position from a staged row only). Who may read it is decided by
      // the request itself (routes/exceptions.ts).
      openException(ctx, {
        source: QUARTER_END_SOURCE,
        entity: 'mon.deal_change_request',
        entityId: row.id,
        ruleId: QUARTER_END_RULE,
        expected: `Applied by ${periodEnd}`,
        actual: row.state,
        severity: QUARTER_END_SEVERITY,
        candidates: [],
        file: null,
        rowNo: null,
        investmentId: null,
      });
      exceptionsOpened += 1;
    }
    // What the runner is shown of the scan: the requests they may see. The rest is a count.
    const unapplied = scanned
      .filter((sim) => visibleTo(ctx, req.credential, sim))
      .map((sim) => sim.row)
      .sort(
        (a, b) =>
          byText(a.effectiveDate, b.effectiveDate) ||
          byText(a.createdAt, b.createdAt) ||
          byText(a.id, b.id),
      );
    const hidden = scanned.length - unapplied.length;
    recordActivity(ctx, req.actor, {
      action: 'change_request.quarter_end_check',
      entity: 'change_request',
      entityId: periodEnd,
      reason: null,
      from: null,
      to: null,
      details: { unapplied: scanned.length, hidden, exceptionsOpened },
    });
    const body: QuarterEndCheckResult = { periodEnd, unapplied, hidden, exceptionsOpened };
    return jsonResponse(200, body, { simulated: true });
  },
});
