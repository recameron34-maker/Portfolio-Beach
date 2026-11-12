import checklistConfig from '../../../../../config/closing_checklist.json';
import {
  closingChecklist,
  closingCommandBody,
  closingItemCommandBody,
  legalTermCommandBody,
  legalTermCreateBody,
  seesAllClients,
} from '@pb/contracts';
import type {
  AllocationRow,
  ClosingChecklist,
  ClosingDetail,
  ClosingItem,
  ClosingSummary,
  LegalTerm,
} from '@pb/contracts';
import {
  CLOSING_CONFIRMED_REFUSAL,
  POSITION_EXISTS_REFUSAL,
  allocationTotals,
  attempt,
  checklistCounts,
  closingMachine,
  confirmRefusal,
  hiddenLineCount,
  requiredItemsComplete,
  tieOutFromTotals,
} from '@pb/workflows';
import type { AllocationTotals } from '@pb/workflows';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureClosings, ensureOpportunities } from '../state.js';
import type { SimActor, SimClosing, SimOpportunity } from '../state.js';
import {
  defineSimRoute,
  documentVisible,
  knownCode,
  personOf,
  recordActivity,
  staleIfMatch,
} from './common.js';
import type { SimContext } from './common.js';

/**
 * The closing workflow (docs/04 M8, M22, docs/18 section 12, decision 0013) simulated the way
 * apps/api/src/closing/closing.service.ts serves it: the record the deal team hands to
 * operations, its required-document checklist from config/closing_checklist.json, the operations
 * confirmation through closingMachine (every required item received or waived, the received
 * amounts tying to the commitment), the audited close-date change (after confirmation it returns
 * the record to Open with a reason; while Open it is a plain date change), the reopen with a
 * reason and the legal terms captured in draft and confirmed once. What operations confirmed
 * stays as confirmed: while the closing is OpsConfirmed its items and its allocation lines are
 * refused every change. Once the deal converted, the close date is the position's entry date and
 * the closing no longer moves. The closing follows its opportunity's wall: anything the caller
 * cannot see is 404. The close date here is the single source of every close date. The tie-out,
 * the checklist gate and the refusal texts are the rules the API uses (controls-closing.ts in
 * @pb/workflows), not a copy of them.
 *
 * Who reads an allocation line (migration 0017, review finding D1-06): a client line is read by a
 * role that reads every client (ALL_CLIENT_ROLES in @pb/contracts) or by a reader entitled to
 * that client; a vehicle line by everyone who sees the deal. The simulation holds the lines of a
 * deal and shows each reader the ones that reader may read (linesShownTo); the tie-out and the
 * totals are the deal's, over every line, the same for every reader, with the number of lines the
 * reader is not shown.
 */

const NOT_FOUND = 'Closing not found';
const ITEM_NOT_FOUND = 'Closing item not found';
const TERM_NOT_FOUND = 'Legal term not found';
const ITEM_CODE = /^[a-z0-9_]{1,64}$/;

/** The status moves an item command makes; a command from any other status is a 409. */
const ITEM_MOVES: Record<
  'receive' | 'waive' | 'reopen',
  { from: readonly string[]; to: ClosingItem['status'] }
> = {
  receive: { from: ['open', 'waived'], to: 'received' },
  waive: { from: ['open'], to: 'waived' },
  reopen: { from: ['received', 'waived'], to: 'open' },
};

/** The checklist every closing starts with: the book's copy when the preview carries one, else the bundled config. */
export function checklistOf(ctx: SimContext): ClosingChecklist {
  return ctx.book?.closingChecklist ?? closingChecklist.parse(checklistConfig);
}

/** 422 for a change to what operations confirmed: the lines and the items of a confirmed closing (docs/18 section 12). */
export const closingConfirmed = (instance: string): Response =>
  problem(422, 'workflow-precondition', CLOSING_CONFIRMED_REFUSAL, { instance, simulated: true });

/** The closing's allocation lines: its opportunity's when the opportunity is known, else the lines recorded with it. */
export function allocationsOfClosing(ctx: SimContext, closing: SimClosing): AllocationRow[] {
  const opportunity = ensureOpportunities(ctx.state, ctx.recordings).get(closing.opportunityId);
  return opportunity === undefined ? closing.allocations : opportunity.allocations;
}

/**
 * The lines of a deal a reader is shown, as row-level security leaves them in the API: every
 * vehicle line, and a client line when the reader's role reads every client or the reader is
 * entitled to that client. A reader whose entitlements are not known is entitled to none.
 */
export function linesShownTo(actor: SimActor, lines: readonly AllocationRow[]): AllocationRow[] {
  const every = seesAllClients(actor.roles);
  const entitled = new Set(actor.clientIds ?? []);
  return lines.filter((l) => l.client === null || every || entitled.has(l.client.id));
}

/**
 * The totals of every line of a deal, the same for every reader: the recorded ones while the
 * lines are as recorded (the API answered them over every line), those of the lines held once the
 * list was replaced in the session or for a deal created in it.
 */
export const totalsOfOpportunity = (sim: SimOpportunity): AllocationTotals =>
  sim.recordedTotals ?? allocationTotals(sim.allocations);

/** The totals of the closing's lines: its opportunity's when the opportunity is known, else those of the lines recorded with it. */
function totalsOfClosing(ctx: SimContext, closing: SimClosing): AllocationTotals {
  const opportunity = ensureOpportunities(ctx.state, ctx.recordings).get(closing.opportunityId);
  return opportunity === undefined
    ? allocationTotals(closing.allocations)
    : totalsOfOpportunity(opportunity);
}

/** The summary as one reader is given it: the tie-out of every line, and how many lines that reader is not shown. */
export function closingSummaryOf(
  ctx: SimContext,
  closing: SimClosing,
  actor: SimActor,
): ClosingSummary {
  const totals = totalsOfClosing(ctx, closing);
  const shown = linesShownTo(actor, allocationsOfClosing(ctx, closing)).length;
  return {
    id: closing.id,
    closeDate: closing.closeDate,
    commitmentAmount: closing.commitmentAmount,
    currency: closing.currency,
    state: closing.state,
    opsConfirmedBy: closing.opsConfirmedBy,
    opsConfirmedAt: closing.opsConfirmedAt,
    ...checklistCounts(closing.items),
    allocationTieOut: {
      ...tieOutFromTotals(closing.commitmentAmount, totals),
      hiddenLines: hiddenLineCount(totals, shown),
    },
  };
}

export function closingDetailOf(
  ctx: SimContext,
  closing: SimClosing,
  actor: SimActor,
): ClosingDetail {
  return {
    ...closingSummaryOf(ctx, closing, actor),
    opportunityId: closing.opportunityId,
    investmentId: closing.investmentId,
    items: closing.items,
    legalTerms: closing.legalTerms,
    allocations: linesShownTo(actor, allocationsOfClosing(ctx, closing)),
    rowVersion: closing.rowVersion,
  };
}

/**
 * Whether the credential may see the closing: its own recorded detail answered 200, or the
 * closing was opened this session on an opportunity it can see (a created deal has no wall; a
 * recorded one is visible when its recorded detail answered 200).
 */
export function closingVisibleTo(
  ctx: SimContext,
  credential: string,
  closing: SimClosing,
): boolean {
  if (closing.origin === 'recorded')
    return (
      ctx.recordings.status(credential, `/api/v1/closings/${encodeURIComponent(closing.id)}`) ===
      200
    );
  const opportunity = ensureOpportunities(ctx.state, ctx.recordings).get(closing.opportunityId);
  return (
    opportunity !== undefined &&
    (opportunity.origin === 'created' ||
      ctx.recordings.status(
        credential,
        `/api/v1/opportunities/${encodeURIComponent(opportunity.row.id)}`,
      ) === 200)
  );
}

/** The closing for a command, or the 404 answer when the credential cannot see it. */
function closingFor(
  ctx: SimContext,
  credential: string,
  id: string,
  instance: string,
): SimClosing | Response {
  const closing = ensureClosings(ctx.state, ctx.recordings).get(id);
  if (closing === undefined || !closingVisibleTo(ctx, credential, closing))
    return problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });
  return closing;
}

/** GET /api/v1/closings/{id}: the record with its checklist, legal terms and the allocation tie-out. */
export const closingRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/closings/{id}',
  what: 'closing',
  body: null,
  handle: (req, ctx) => {
    const closing = closingFor(ctx, req.credential, req.params.id ?? '', req.url.pathname);
    if (closing instanceof Response) return closing;
    return jsonResponse(200, closingDetailOf(ctx, closing, req.actor), {
      simulated: true,
      etag: closing.rowVersion,
    });
  },
});

/**
 * POST /api/v1/closings/{id}/items/{itemCode}/commands: receive (with a visible hub document),
 * waive (with a reason) or reopen one item; refused while the closing is confirmed.
 */
export const closingItemCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/closings/{id}/items/{itemCode}/commands',
  what: 'command',
  body: closingItemCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const closing = closingFor(ctx, req.credential, req.params.id ?? '', instance);
    if (closing instanceof Response) return closing;
    const code = req.params.itemCode ?? '';
    const item = ITEM_CODE.test(code) ? closing.items.find((i) => i.itemCode === code) : undefined;
    if (item === undefined)
      return problem(404, 'not-found', ITEM_NOT_FOUND, { instance, simulated: true });
    if (closing.state === 'OpsConfirmed') return closingConfirmed(instance);
    const body = req.body;
    const move = ITEM_MOVES[body.command];
    if (!move.from.includes(item.status))
      return problem(
        409,
        'workflow-transition',
        `closing item: ${body.command} is not allowed from ${item.status}`,
        { instance, simulated: true },
      );
    if (body.command === 'receive' && !documentVisible(ctx, req.credential, body.documentId))
      return problem(
        422,
        'workflow-precondition',
        'documentId: the document is not in the hub or not visible to you',
        { instance, simulated: true },
      );
    const before = item.status;
    item.status = move.to;
    item.documentId = body.command === 'receive' ? body.documentId : null;
    item.waivedReason = body.command === 'waive' ? body.reason : null;
    closing.changed = true;
    recordActivity(ctx, req.actor, {
      action: `closing_item.${body.command}`,
      entity: 'closing_item',
      entityId: item.id,
      reason: body.command === 'waive' ? body.reason : null,
      from: before,
      to: move.to,
    });
    return jsonResponse(200, closingDetailOf(ctx, closing, req.actor), {
      simulated: true,
      etag: closing.rowVersion,
    });
  },
});

/**
 * POST /api/v1/closings/{id}/commands (operations): confirm once the required items are in and
 * the received amounts tie out; changeCloseDate with a reason, which after confirmation returns
 * the record to Open and while Open is a plain audited date change; reopen with a reason, which
 * returns a confirmed closing to Open so its items and lines can change. Neither of the last two
 * moves a closing whose deal converted: the position's entry date is that close date.
 */
export const closingCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/closings/{id}/commands',
  what: 'command',
  body: closingCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const closing = closingFor(ctx, req.credential, req.params.id ?? '', instance);
    if (closing instanceof Response) return closing;
    const stale = staleIfMatch(req.headers, closing.rowVersion, instance);
    if (stale !== null) return stale;
    const body = req.body;
    const from = closing.state;
    if (body.command !== 'confirm' && closing.investmentId !== null)
      return problem(422, 'workflow-precondition', POSITION_EXISTS_REFUSAL, {
        instance,
        simulated: true,
      });
    if (body.command === 'changeCloseDate' && from === 'Open') {
      const before = closing.closeDate;
      closing.closeDate = body.closeDate;
      closing.rowVersion += 1;
      closing.changed = true;
      recordActivity(ctx, req.actor, {
        action: 'closing.changeCloseDate',
        entity: 'closing',
        entityId: closing.id,
        reason: body.reason,
        from: before,
        to: body.closeDate,
      });
      return jsonResponse(200, closingDetailOf(ctx, closing, req.actor), {
        simulated: true,
        etag: closing.rowVersion,
      });
    }
    // The tie-out a command rests on is the deal's, over every line, whoever sends the command.
    const totals = totalsOfClosing(ctx, closing);
    const tie = tieOutFromTotals(closing.commitmentAmount, totals);
    const itemsComplete = requiredItemsComplete(closing.items);
    const result = attempt(closingMachine, from, body.command, {
      actorId: req.actor.userId,
      actorRoles: req.actor.roles,
      ...(body.command === 'confirm' ? {} : { reason: body.reason }),
      record: { requiredItemsComplete: itemsComplete, allocationTiedOut: tie.tiedOut },
    });
    if (!result.ok) {
      // The confirmation's tie-out refusal names what is missing when it is a received amount (M22).
      const missing = confirmRefusal({
        command: body.command,
        code: result.code,
        itemsComplete,
        tiedOut: tie.tiedOut,
        missingReceived: totals.missingReceived,
      });
      if (missing !== null)
        return problem(422, 'workflow-precondition', missing, { instance, simulated: true });
      return workflowProblem(result, { instance, simulated: true });
    }
    if (body.command === 'confirm') {
      closing.opsConfirmedBy = personOf(req.actor);
      closing.opsConfirmedAt = ctx.env.now();
    } else {
      if (body.command === 'changeCloseDate') closing.closeDate = body.closeDate;
      closing.opsConfirmedBy = null;
      closing.opsConfirmedAt = null;
    }
    closing.state = result.to;
    closing.rowVersion += 1;
    closing.changed = true;
    recordActivity(ctx, req.actor, {
      action: `closing.${body.command}`,
      entity: 'closing',
      entityId: closing.id,
      reason: body.command === 'confirm' ? null : body.reason,
      from,
      to: result.to,
    });
    return jsonResponse(200, closingDetailOf(ctx, closing, req.actor), {
      simulated: true,
      etag: closing.rowVersion,
    });
  },
});

/** POST /api/v1/closings/{id}/legal-terms (deal team, operations): a structured term in draft, typed by the taxonomy. */
export const createLegalTermRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/closings/{id}/legal-terms',
  what: 'legal term',
  body: legalTermCreateBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const closing = closingFor(ctx, req.credential, req.params.id ?? '', instance);
    if (closing instanceof Response) return closing;
    if (!knownCode(ctx, req.credential, req.body.termType))
      return problem(400, 'validation', 'Invalid body', {
        instance,
        simulated: true,
        errors: [{ path: 'termType', message: 'Unknown code' }],
      });
    if (
      req.body.sourceDocumentId !== undefined &&
      !documentVisible(ctx, req.credential, req.body.sourceDocumentId)
    )
      return problem(
        422,
        'workflow-precondition',
        'sourceDocumentId: the document is not in the hub or not visible to you',
        { instance, simulated: true },
      );
    const term: LegalTerm = {
      id: ctx.env.newId(),
      termType: req.body.termType,
      value: req.body.value,
      sourceDocumentId: req.body.sourceDocumentId ?? null,
      status: 'draft',
      confirmedBy: null,
    };
    closing.legalTerms.push(term);
    closing.changed = true;
    recordActivity(ctx, req.actor, {
      action: 'legal_term.create',
      entity: 'legal_term',
      entityId: term.id,
      reason: null,
      from: null,
      to: 'draft',
    });
    return jsonResponse(201, closingDetailOf(ctx, closing, req.actor), {
      simulated: true,
      etag: closing.rowVersion,
    });
  },
});

/** POST /api/v1/closings/{id}/legal-terms/{termId}/commands: confirm a draft term once. */
export const legalTermCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/closings/{id}/legal-terms/{termId}/commands',
  what: 'command',
  body: legalTermCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const closing = closingFor(ctx, req.credential, req.params.id ?? '', instance);
    if (closing instanceof Response) return closing;
    const term = closing.legalTerms.find((t) => t.id === req.params.termId);
    if (term === undefined)
      return problem(404, 'not-found', TERM_NOT_FOUND, { instance, simulated: true });
    if (term.status !== 'draft')
      return problem(
        409,
        'workflow-transition',
        `legal term: ${req.body.command} is not allowed from ${term.status}`,
        { instance, simulated: true },
      );
    term.status = 'confirmed';
    term.confirmedBy = personOf(req.actor);
    closing.changed = true;
    recordActivity(ctx, req.actor, {
      action: 'legal_term.confirm',
      entity: 'legal_term',
      entityId: term.id,
      reason: null,
      from: 'draft',
      to: 'confirmed',
    });
    return jsonResponse(200, closingDetailOf(ctx, closing, req.actor), {
      simulated: true,
      etag: closing.rowVersion,
    });
  },
});
