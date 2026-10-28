import { D } from '@pb/calc';
import { capitalNoticeCommandBody } from '@pb/contracts';
import type { CapitalNoticeCommandBody, CapitalNoticeControlDetail, Person } from '@pb/contracts';
import { attempt, capitalNoticeMachine } from '@pb/workflows';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureNotices, ensureTickets, ensureWires } from '../state.js';
import type { SimActor, SimNotice, SimTicket } from '../state.js';
import { defineSimRoute, recordActivity, staleIfMatch } from './common.js';
import type { SimContext } from './common.js';
import {
  HOLD_DAYS,
  controlDetailOf,
  counterpartyOfNotice,
  noticeFlagsOf,
  openNoticesOf,
  pendingChange,
  readNoticeDetail,
  registerOf,
  ticketOfNotice,
} from './register.js';
import type { CounterpartyKeys } from './register.js';

/**
 * Capital notices through docs/18 section 3 (docs/04 M16, SEC-12, decision 0013), the way
 * apps/api/src/capital/capital.service.ts moves them: the machine judges the command on the
 * record the session holds (whether a ticket exists and who prepared it, whether the
 * counterparty's active instruction is Verified, whether a change sits inside the hold window,
 * whether the ticket is Approved), then the command writes what it owns: draftTicket drafts or
 * re-drafts the one ticket of the notice, approveTicket approves it against the active version
 * (dual control, SEC-12.3), wireChanged returns it to draft and flags the notice (SEC-12.4),
 * confirmFunding funds it, reconcile writes the one approved cash flow. Bank fields are never
 * extracted (SEC-12.1) and never pass through here; the answer is the notice detail judged on the
 * as-of date, the ticket's release blockers computed for the caller.
 */

const NOT_FOUND = 'Capital notice not found';
const APPROVED = 'record_status.approved';
/** Why the register fires wireChanged on a notice whose ticket was approved against the old version. */
export const WIRE_CHANGED_REASON = 'new wire instruction version proposed';

/** The cash flow a notice type reconciles into, signed from the investor's side (money out is negative). */
const FLOW_OF_NOTICE: Record<string, { flowType: string; sign: 1 | -1 }> = {
  'notice_type.capital_call': { flowType: 'flow_type.contribution', sign: -1 },
  'notice_type.distribution': { flowType: 'flow_type.distribution', sign: 1 },
  'notice_type.equalization': { flowType: 'flow_type.recallable', sign: 1 },
  'notice_type.interest_payment': { flowType: 'flow_type.interest', sign: 1 },
  'notice_type.principal_repayment': { flowType: 'flow_type.principal', sign: 1 },
  'notice_type.fee_notice': { flowType: 'flow_type.fee', sign: -1 },
};

const personOf = (actor: SimActor): Person => ({ id: actor.userId, name: actor.displayName });

type Outcome = { ok: true; detail: CapitalNoticeControlDetail } | { ok: false; response: Response };

/**
 * One command on one notice for one credential: 404 for a notice the credential cannot open (no
 * existence leak), 412 for a stale If-Match, then the machine and the write. Shared by the
 * command route and the register's sweep.
 */
export function runNoticeCommand(
  ctx: SimContext,
  credential: string,
  actor: SimActor,
  id: string,
  body: CapitalNoticeCommandBody,
  headers: Headers,
  instance: string,
): Outcome {
  const notices = ensureNotices(ctx.state, ctx.recordings);
  const sim = notices.get(id);
  const recorded = sim === undefined ? undefined : readNoticeDetail(ctx.recordings, credential, id);
  if (sim === undefined || recorded === undefined)
    return {
      ok: false,
      response: problem(404, 'not-found', NOT_FOUND, { instance, simulated: true }),
    };
  const stale = staleIfMatch(headers, sim.row.rowVersion, instance);
  if (stale !== null) return { ok: false, response: stale };

  const wires = ensureWires(ctx.state, ctx.recordings);
  const tickets = ensureTickets(ctx.state, ctx.recordings);
  const keys = counterpartyOfNotice(ctx.recordings, recorded);
  const register = registerOf(wires.values(), keys);
  const ticket = ticketOfNotice(tickets, id);
  const live = ticket !== undefined && ticket.state !== 'Withdrawn';
  const { row } = sim;
  const reason = body.reason;
  const result = attempt(capitalNoticeMachine, row.state, body.command, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    ...(reason !== undefined ? { reason } : {}),
    record: {
      documentIndexed: true,
      bankFieldsExtracted: false,
      ticketExists: live,
      ticketPreparedBy: live ? ticket.preparedBy.id : undefined,
      wireVerified: register.active !== null,
      wireChangedWithinHold: pendingChange(register, ctx.recordings.asOf, HOLD_DAYS) !== null,
      ticketApproved: live && ticket.state === 'Approved',
    },
  });
  if (!result.ok)
    return { ok: false, response: workflowProblem(result, { instance, simulated: true }) };
  if (body.command === 'wireChanged' && reason === undefined)
    return {
      ok: false,
      response: problem(
        422,
        'workflow-precondition',
        'capital_notice: a reason is required to record a wire change',
        { instance, simulated: true },
      ),
    };

  const now = ctx.env.now();
  const flags = (sim.flags ??= noticeFlagsOf(recorded));
  switch (body.command) {
    case 'draftTicket': {
      const values = {
        amount: body.amount ?? row.amount,
        currency: row.currency,
        fundingDate: body.fundingDate ?? row.dueDate,
        preparedBy: personOf(actor),
        preparedAt: now,
        approvedBy: null,
        approvedAt: null,
        wireInstructionId: null,
        state: 'Drafted' as const,
      };
      if (ticket === undefined) {
        const drafted: SimTicket = {
          id: ctx.env.newId(),
          capitalNoticeId: id,
          ...values,
          rowVersion: 1,
          origin: 'created',
          changed: true,
        };
        tickets.set(drafted.id, drafted);
      } else {
        // A notice already carrying a ticket is re-drafted, never given a second one.
        Object.assign(ticket, values, { rowVersion: ticket.rowVersion + 1, changed: true });
      }
      break;
    }
    case 'approveTicket': {
      if (ticket === undefined || register.active === null)
        return {
          ok: false,
          response: problem(
            409,
            'conflict',
            'trade_ticket: the ticket or the instruction changed first',
            {
              instance,
              simulated: true,
            },
          ),
        };
      Object.assign(ticket, {
        approvedBy: personOf(actor),
        approvedAt: now,
        wireInstructionId: register.active.id,
        state: 'Approved' as const,
        rowVersion: ticket.rowVersion + 1,
        changed: true,
      });
      break;
    }
    case 'wireChanged': {
      if (ticket !== undefined)
        Object.assign(ticket, {
          approvedBy: null,
          approvedAt: null,
          wireInstructionId: null,
          state: 'Drafted' as const,
          rowVersion: ticket.rowVersion + 1,
          changed: true,
        });
      flags.wireChangeFlag = true;
      break;
    }
    case 'confirmFunding': {
      if (ticket === undefined)
        return {
          ok: false,
          response: problem(409, 'conflict', 'trade_ticket: the ticket changed first', {
            instance,
            simulated: true,
          }),
        };
      Object.assign(ticket, {
        state: 'Funded' as const,
        rowVersion: ticket.rowVersion + 1,
        changed: true,
      });
      sim.fundedBy = actor.userId;
      break;
    }
    case 'reconcile': {
      const refused = writeCashFlow(sim, recorded, ticket, instance);
      if (refused !== null) return { ok: false, response: refused };
      break;
    }
    case 'extract':
    case 'review':
      break;
  }

  sim.row = { ...row, state: result.to, rowVersion: row.rowVersion + 1 };
  sim.changed = true;
  recordActivity(ctx, actor, {
    action: `capital_notice.${body.command}`,
    entity: 'capital_notice',
    entityId: id,
    reason: reason ?? null,
    from: row.state,
    to: result.to,
  });
  return { ok: true, detail: controlDetailOf(ctx, credential, recorded, sim) };
}

/**
 * The reconciliation's one write into the cash flows (rule 5: the notice is the staging record a
 * person approved through the workflow): one approved flow, typed and signed by the notice type,
 * dated on the ticket's funding date (the due date without a ticket). A notice that already has
 * an approved flow is refused: nothing is counted twice.
 */
function writeCashFlow(
  sim: SimNotice,
  recorded: {
    noticeType: string;
    amount: string;
    dueDate: string;
    cashFlows: { status: string }[];
  },
  ticket: SimTicket | undefined,
  instance: string,
): Response | null {
  const refuse = (detail: string): Response =>
    problem(422, 'workflow-precondition', detail, { instance, simulated: true });
  if (sim.cashFlows.length > 0 || recorded.cashFlows.some((f) => f.status === APPROVED))
    return refuse('capital_notice: an approved cash flow is already recorded for this notice');
  const mapping = FLOW_OF_NOTICE[recorded.noticeType];
  if (mapping === undefined)
    return refuse('capital_notice: no cash flow type is defined for this notice type');
  sim.cashFlows.push({
    date: ticket?.fundingDate ?? recorded.dueDate,
    flowType: mapping.flowType,
    amount: D(recorded.amount).times(mapping.sign).toFixed(2),
    status: APPROVED,
  });
  return null;
}

/**
 * SEC-12.4 after a new version of a counterparty (the register's propose): every notice of the
 * counterparty not yet Reconciled carries the wire change flag, and a notice whose ticket was
 * approved against the previous version goes back to TicketDrafted through the machine's
 * wireChanged row, with the service path's reason, as apps/api/src/capital/wires.service.ts
 * sweeps them. Walled notices are flagged too: the register is a control, not a deal record.
 */
export function sweepNoticesForNewVersion(
  ctx: SimContext,
  actor: SimActor,
  keys: CounterpartyKeys,
): void {
  const tickets = ensureTickets(ctx.state, ctx.recordings);
  for (const sim of openNoticesOf(ctx, keys)) {
    const flags = (sim.flags ??= noticeFlagsOf(
      readNoticeDetail(ctx.recordings, actor.externalId, sim.row.id),
    ));
    if (sim.row.state === 'TicketApproved') {
      const result = attempt(capitalNoticeMachine, sim.row.state, 'wireChanged', {
        actorId: actor.userId,
        actorRoles: actor.roles,
        reason: WIRE_CHANGED_REASON,
        record: {},
      });
      if (!result.ok) continue;
      const ticket = ticketOfNotice(tickets, sim.row.id);
      if (ticket !== undefined)
        Object.assign(ticket, {
          approvedBy: null,
          approvedAt: null,
          wireInstructionId: null,
          state: 'Drafted' as const,
          rowVersion: ticket.rowVersion + 1,
          changed: true,
        });
      flags.wireChangeFlag = true;
      sim.row = { ...sim.row, state: result.to, rowVersion: sim.row.rowVersion + 1 };
      sim.changed = true;
      recordActivity(ctx, actor, {
        action: 'capital_notice.wireChanged',
        entity: 'capital_notice',
        entityId: sim.row.id,
        reason: WIRE_CHANGED_REASON,
        from: 'TicketApproved',
        to: result.to,
      });
      continue;
    }
    if (flags.wireChangeFlag) continue;
    flags.wireChangeFlag = true;
    sim.changed = true;
    recordActivity(ctx, actor, {
      action: 'capital_notice.wire_change_flag',
      entity: 'capital_notice',
      entityId: sim.row.id,
      reason: WIRE_CHANGED_REASON,
      from: sim.row.state,
      to: sim.row.state,
    });
  }
}

export const capitalNoticeCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/capital-notices/{id}/commands',
  what: 'command',
  body: capitalNoticeCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const outcome = runNoticeCommand(
      ctx,
      req.credential,
      req.actor,
      req.params.id ?? '',
      req.body,
      req.headers,
      req.url.pathname,
    );
    if (!outcome.ok) return outcome.response;
    return jsonResponse(200, outcome.detail, { simulated: true, etag: outcome.detail.rowVersion });
  },
});
