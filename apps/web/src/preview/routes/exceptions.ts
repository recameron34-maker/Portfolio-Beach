import { dataExceptionCommandBody, dataExceptionListQuery } from '@pb/contracts';
import type { DataException, DataExceptionPage } from '@pb/contracts';
import { attempt, exceptionMachine } from '@pb/workflows';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import type { SimException } from '../state.js';
import { canOpen, defineSimRoute, pageNewestFirst, recordActivity } from './common.js';
import type { SimContext } from './common.js';

/**
 * The data exceptions queue (docs/04 M1 Data Health, docs/18 section 9, decision 0010) simulated
 * in the browser, the way apps/api/src/exceptions/exceptions.service.ts serves it over the
 * exceptions the simulated intakes opened this session. Visibility follows the staged row (the
 * select policy of migration 0010): an exception about a row linked to a position the credential
 * cannot open is left out of the list and not found on its own, and a visible one names its
 * position. A command moves the exception through exceptionMachine (acknowledge, resolve,
 * wont_fix, with the reason the table requires) or sets the external ticket without a state
 * change; a transition the table lacks from the state is the 409 WORKFLOW_REFUSALS maps. The
 * figures an exception carries are never written here.
 */

const NOT_FOUND = 'Data exception not found';

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

/** Whether the credential may see the exception: the row it is about links to no position, or to one they may open. */
function visibleTo(ctx: SimContext, credential: string, x: SimException): boolean {
  return x.context.investmentId === null || canOpen(ctx, credential, x.context.investmentId);
}

/** The exception as the queue serves it, its position named from the book (the caller may open it, or it is not shown at all). */
function toException(ctx: SimContext, x: SimException): DataException {
  const position =
    x.context.investmentId === null
      ? undefined
      : ctx.book?.investments.find((i) => i.id === x.context.investmentId);
  return {
    id: x.id,
    source: x.source,
    entity: x.entity,
    entityId: x.entityId,
    ruleId: x.ruleId,
    expected: x.expected,
    actual: x.actual,
    severity: x.severity,
    owner: x.ownerName,
    state: x.state,
    externalTicket: x.externalTicket,
    candidates: x.candidates,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
    rowVersion: x.rowVersion,
    context: {
      intakeFileId: x.context.intakeFileId,
      intakeFileName: x.context.intakeFileName,
      rowNo: x.context.rowNo,
      investmentId: position?.id ?? null,
      investmentNumber: position?.investmentNumber ?? null,
      companyName: position?.companyName ?? null,
    },
  };
}

/**
 * GET /api/v1/data-exceptions: the exceptions the credential may see, newest first, filtered by
 * state, source, severity and, when the contract carries it, the intake file, with cursor paging.
 */
export const exceptionsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/data-exceptions',
  what: 'query',
  body: null,
  query: dataExceptionListQuery,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const { state, source, severity } = req.query;
    // The file filter joins the query schema with the contracts change that adds it; until then
    // the parsed query carries no such key and the filter is simply absent.
    const query: Record<string, unknown> = req.query;
    const intakeFileId = typeof query.intakeFileId === 'string' ? query.intakeFileId : undefined;
    const items = [...ctx.state.exceptions.values()].filter(
      (x) =>
        visibleTo(ctx, req.credential, x) &&
        (state === undefined || x.state === state) &&
        (source === undefined || x.source === source) &&
        (severity === undefined || x.severity === severity) &&
        (intakeFileId === undefined || x.context.intakeFileId === intakeFileId),
    );
    const page = pageNewestFirst(items, (x) => ({ at: x.createdAt, id: x.id }), req.query);
    if (page === null)
      return problem(400, 'validation', 'Invalid cursor', { instance, simulated: true });
    const body: DataExceptionPage = {
      items: page.items.map((x) => toException(ctx, x)),
      nextCursor: page.nextCursor,
    };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/data-exceptions/{id}: one exception with its context; one the credential cannot see is not found. */
export const exceptionRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/data-exceptions/{id}',
  what: 'exception',
  body: null,
  handle: (req, ctx) => {
    const sim = ctx.state.exceptions.get(req.params.id ?? '');
    if (sim === undefined || !visibleTo(ctx, req.credential, sim))
      return notFound(req.url.pathname);
    return jsonResponse(200, toException(ctx, sim), { simulated: true });
  },
});

/**
 * POST /api/v1/data-exceptions/{id}/commands (operations only, the contract's guard). acknowledge,
 * resolve and wont_fix move the exception through docs/18 section 9 (the acknowledging operator
 * takes it; a later resolve or close keeps the owner); set_ticket records the external ticket and
 * changes no state. Each command bumps the row version, as the API's touch trigger does.
 */
export const exceptionCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/data-exceptions/{id}/commands',
  what: 'command',
  body: dataExceptionCommandBody,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const sim = ctx.state.exceptions.get(req.params.id ?? '');
    if (sim === undefined || !visibleTo(ctx, req.credential, sim)) return notFound(instance);
    const body = req.body;
    const from = sim.state;
    if (body.command === 'set_ticket') {
      const ticket = body.externalTicket ?? null;
      const before = sim.externalTicket;
      sim.externalTicket = ticket;
      recordActivity(ctx, req.actor, {
        action: 'data_exception.set_ticket',
        entity: 'data_exception',
        entityId: sim.id,
        reason: null,
        from,
        to: from,
        details: { ticketBefore: before === null ? 0 : 1, ticketAfter: ticket === null ? 0 : 1 },
      });
    } else {
      const result = attempt(exceptionMachine, from, body.command, {
        actorId: req.actor.userId,
        actorRoles: req.actor.roles,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        record: {},
      });
      if (!result.ok) return workflowProblem(result, { instance, simulated: true });
      // The acknowledging operator takes the exception; a later resolve or close keeps the owner.
      if (body.command === 'acknowledge') {
        sim.ownerId = req.actor.userId;
        sim.ownerName = req.actor.displayName;
      }
      sim.state = result.to;
      recordActivity(ctx, req.actor, {
        action: `data_exception.${body.command}`,
        entity: 'data_exception',
        entityId: sim.id,
        reason: body.reason ?? null,
        from,
        to: result.to,
      });
    }
    sim.rowVersion += 1;
    sim.updatedAt = ctx.env.now();
    return jsonResponse(200, toException(ctx, sim), { simulated: true, etag: sim.rowVersion });
  },
});
