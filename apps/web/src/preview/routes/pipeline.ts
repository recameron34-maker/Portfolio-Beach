import { D } from '@pb/calc';
import templatesConfig from '../../../../../config/diligence_templates.json';
import {
  allocationsPutBody,
  asOfQuery,
  clientList,
  diligenceTaskCommandBody,
  diligenceTaskCreateBody,
  diligenceTemplateFor,
  diligenceTemplates,
  icDecisionBody,
  investmentDetail,
  investmentPage,
  opportunityCommandBody,
  opportunityCreateBody,
  opportunityListQuery,
  sponsorPage,
  vehicleList,
} from '@pb/contracts';
import type {
  AllocationRow,
  DiligenceTask,
  DiligenceTemplates,
  InvestmentDetail,
  OpportunityDetail,
  OpportunityGates,
  OpportunityPage,
  OpportunityRow,
} from '@pb/contracts';
import { attempt, dealStageMachine } from '@pb/workflows';
import { recordMiss } from '../monitor.js';
import { overlayRecordedBody } from '../overlay.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureClosings, ensureOpportunities, readAny } from '../state.js';
import type { SimActor, SimClosing, SimOpportunity } from '../state.js';
import { checklistOf, closingSummaryOf, requiredItemsComplete, tieOut } from './closings.js';
import {
  NOT_VISIBLE,
  decodeCursor,
  defineSimRoute,
  documentVisible,
  encodeCursor,
  knownCode,
  personOf,
  recordActivity,
  staleIfMatch,
} from './common.js';
import type { SimContext } from './common.js';

/**
 * The pipeline (docs/04 M5 skeleton, M7, docs/18 section 4, decision 0013) simulated the way
 * apps/api/src/pipeline/pipeline.service.ts serves it: opportunities with their stage commands
 * through dealStageMachine, the gates read from the same rows the detail shows (the diligence
 * tasks, the latest IC decision, the closing's checklist and allocation tie-out). Entering
 * Diligence creates the template tasks of the deal type (config/diligence_templates.json);
 * Approved to Closing opens the closing record with the checklist; Closing to Closed converts
 * the deal into a position with the data captured once, which the portfolio lists and the
 * one-pager then show. A walled deal is 404 outside its wall; a name the caller may not read
 * shows as "Not visible" while the id travels.
 */

const NOT_FOUND = 'Opportunity not found';
const TASK_NOT_FOUND = 'Diligence task not found';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The status moves a task command makes; a command from any other status is a 409. */
const TASK_MOVES: Record<
  'complete' | 'waive' | 'reopen',
  { from: readonly string[]; to: DiligenceTask['status'] }
> = {
  complete: { from: ['open'], to: 'done' },
  waive: { from: ['open'], to: 'waived' },
  reopen: { from: ['done', 'waived'], to: 'open' },
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const validation = (instance: string, path: string, message: string): Response =>
  problem(400, 'validation', 'Invalid body', {
    instance,
    simulated: true,
    errors: [{ path, message }],
  });

const precondition = (instance: string, detail: string): Response =>
  problem(422, 'workflow-precondition', detail, { instance, simulated: true });

/** A money value from a body must fit the record's two decimals; more is a validation problem. */
const tooManyDecimals = (value: string | undefined): boolean =>
  value !== undefined && D(value).decimalPlaces() > 2;

/** The templates: the book's copy when the preview carries one, else the bundled config. */
export function templatesOf(ctx: SimContext): DiligenceTemplates {
  return ctx.book?.diligenceTemplates ?? diligenceTemplates.parse(templatesConfig);
}

/** Whether the credential may see the deal: created this session (no wall), or its own recorded detail answered 200. */
export function opportunityVisibleTo(
  ctx: SimContext,
  credential: string,
  sim: SimOpportunity,
): boolean {
  return (
    sim.origin === 'created' ||
    ctx.recordings.status(credential, `/api/v1/opportunities/${encodeURIComponent(sim.row.id)}`) ===
      200
  );
}

const gatesOf = (ctx: SimContext, sim: SimOpportunity): OpportunityGates => {
  const requiredOpen = sim.tasks.filter((t) => t.requiredForIc && t.status === 'open').length;
  const closing =
    sim.closingId === null
      ? undefined
      : ensureClosings(ctx.state, ctx.recordings).get(sim.closingId);
  const checklistComplete = closing !== undefined && requiredItemsComplete(closing.items);
  const allocationTiedOut =
    closing !== undefined && tieOut(closing.commitmentAmount, sim.allocations).tiedOut;
  return {
    diligence: { requiredOpen, ok: requiredOpen === 0 },
    icDecision: { ok: sim.decisions[0]?.decision === 'approved' },
    closing: {
      checklistComplete,
      allocationTiedOut,
      ok: closing?.state === 'OpsConfirmed' && checklistComplete && allocationTiedOut,
    },
  };
};

export function opportunityDetailOf(ctx: SimContext, sim: SimOpportunity): OpportunityDetail {
  const closing =
    sim.closingId === null
      ? undefined
      : ensureClosings(ctx.state, ctx.recordings).get(sim.closingId);
  return {
    ...sim.row,
    source: sim.source,
    passNote: sim.passNote,
    stageHistory: sim.stageHistory,
    diligenceTasks: sim.tasks,
    icDecisions: sim.decisions,
    allocations: sim.allocations,
    closing: closing === undefined ? null : closingSummaryOf(ctx, closing),
    gates: gatesOf(ctx, sim),
  };
}

/** The deal for a command, or the 404 answer when the credential cannot see it. */
function opportunityFor(
  ctx: SimContext,
  credential: string,
  id: string,
  instance: string,
): SimOpportunity | Response {
  const sim = ensureOpportunities(ctx.state, ctx.recordings).get(id);
  if (sim === undefined || !opportunityVisibleTo(ctx, credential, sim))
    return problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });
  return sim;
}

const answer = (ctx: SimContext, sim: SimOpportunity, status = 200): Response =>
  jsonResponse(status, opportunityDetailOf(ctx, sim), {
    simulated: true,
    etag: sim.row.rowVersion,
  });

/** GET /api/v1/opportunities: the board's rows the credential can see, newest received first, by stage and deal lead. */
export const opportunitiesRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/opportunities',
  what: 'query',
  body: null,
  query: opportunityListQuery,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const { stage, ownerId, limit, cursor } = req.query;
    const rows = [...ensureOpportunities(ctx.state, ctx.recordings).values()]
      .filter(
        (o) =>
          opportunityVisibleTo(ctx, req.credential, o) &&
          (stage === undefined || o.row.stage === stage) &&
          (ownerId === undefined || o.row.owner?.id === ownerId),
      )
      .map((o) => o.row)
      .sort((a, b) => byText(b.receivedDate, a.receivedDate) || byText(b.id, a.id));
    let start = 0;
    if (cursor !== undefined) {
      const key = decodeCursor(cursor);
      const at = key === null ? -1 : rows.findIndex((r) => r.id === key.id);
      if (key === null || at < 0)
        return problem(400, 'validation', 'Invalid cursor', { instance, simulated: true });
      start = at + 1;
    }
    const page = rows.slice(start, start + limit);
    const last = page[page.length - 1];
    const body: OpportunityPage = {
      items: page,
      nextCursor:
        rows.length > start + limit && last !== undefined
          ? encodeCursor({ at: `${last.receivedDate}T00:00:00Z`, id: last.id })
          : null,
    };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/opportunities/{id}: the deal with its history, tasks, decisions, allocations, closing and gates. */
export const opportunityRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/opportunities/{id}',
  what: 'opportunity',
  body: null,
  handle: (req, ctx) => {
    const sim = opportunityFor(ctx, req.credential, req.params.id ?? '', req.url.pathname);
    return sim instanceof Response ? sim : answer(ctx, sim);
  },
});

/** POST /api/v1/opportunities (deal team): a new deal at Sourced, led by the creator, with its first stage history row. */
export const createOpportunityRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/opportunities',
  what: 'opportunity',
  body: opportunityCreateBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const body = req.body;
    if (tooManyDecimals(body.targetCommitment))
      return validation(instance, 'targetCommitment', 'At most two decimal places');
    for (const [path, code] of [
      ['dealType', body.dealType],
      ['sector', body.sector],
      ['geography', body.geography],
    ] as const) {
      if (code !== undefined && !knownCode(ctx, req.credential, code))
        return validation(instance, path, 'Unknown code');
    }
    const sponsors = ctx.recordings.read(req.credential, '/api/v1/sponsors?limit=200', sponsorPage);
    const sponsor = sponsors?.items.find((s) => s.id === body.sponsorId);
    if (sponsors !== undefined && sponsor === undefined)
      return validation(instance, 'sponsorId', 'Unknown sponsor');
    const fund =
      body.sponsorFundId === undefined
        ? undefined
        : ctx.book?.sponsorFunds.find((f) => f.id === body.sponsorFundId);
    if (body.sponsorFundId !== undefined && ctx.book !== null && fund?.sponsorId !== body.sponsorId)
      return validation(instance, 'sponsorFundId', 'Not a fund of the sponsor');
    const now = ctx.env.now();
    const row: OpportunityRow = {
      id: ctx.env.newId(),
      name: body.name,
      companyName: body.companyName,
      sponsor: { id: body.sponsorId, name: sponsor?.name ?? NOT_VISIBLE },
      sponsorFund:
        body.sponsorFundId === undefined
          ? null
          : { id: body.sponsorFundId, name: fund?.name ?? NOT_VISIBLE },
      dealType: body.dealType,
      sector: body.sector ?? null,
      geography: body.geography ?? null,
      stage: 'Sourced',
      owner: personOf(req.actor),
      receivedDate: body.receivedDate,
      targetCommitment: body.targetCommitment ?? null,
      currency: 'USD',
      daysInStage: 0,
      passReasonCode: null,
      investmentId: null,
      rowVersion: 1,
    };
    const sim: SimOpportunity = {
      row,
      source: body.source ?? null,
      passNote: null,
      stageHistory: [
        {
          fromStage: null,
          toStage: 'Sourced',
          command: 'create',
          reason: null,
          changedBy: personOf(req.actor),
          changedAt: now,
        },
      ],
      tasks: [],
      decisions: [],
      allocations: [],
      closingId: null,
      origin: 'created',
      changed: true,
    };
    ensureOpportunities(ctx.state, ctx.recordings).set(row.id, sim);
    recordActivity(ctx, req.actor, {
      action: 'opportunity.create',
      entity: 'opportunity',
      entityId: row.id,
      reason: null,
      from: null,
      to: 'Sourced',
    });
    return answer(ctx, sim, 201);
  },
});

/** The template tasks of the deal type, created when the deal has none yet; the deal lead owns them. */
function createTemplateTasks(ctx: SimContext, sim: SimOpportunity): number {
  if (sim.tasks.length > 0) return 0;
  const template = diligenceTemplateFor(templatesOf(ctx), sim.row.dealType);
  for (const t of template)
    sim.tasks.push({
      id: ctx.env.newId(),
      workstream: t.workstream,
      title: t.title,
      owner: sim.row.owner,
      dueDate: null,
      status: 'open',
      requiredForIc: t.requiredForIc,
      evidenceDocumentId: null,
      waivedReason: null,
    });
  return template.length;
}

/** The highest INV-nnnn on record, across the book, every recorded list and the positions created this session. */
function nextInvestmentNumber(ctx: SimContext): string {
  let highest = 0;
  const note = (n: string): void => {
    const m = /^INV-(\d+)$/.exec(n);
    if (m !== null) highest = Math.max(highest, Number(m[1]));
  };
  for (const i of ctx.book?.investments ?? []) note(i.investmentNumber);
  for (const query of ['limit=200', 'active=false&limit=200', 'active=true&limit=200']) {
    const page = readAny(ctx.recordings, `/api/v1/investments?${query}`, investmentPage);
    for (const i of page?.items ?? []) note(i.investmentNumber);
  }
  for (const s of ctx.state.investments.values()) note(s.detail.investmentNumber);
  return `INV-${String(highest + 1).padStart(4, '0')}`;
}

/** The line that names the vehicle the position closes into: the largest by received (else requested), then by vehicle name. */
const largestAllocation = (rows: readonly AllocationRow[]): AllocationRow | undefined =>
  [...rows].sort(
    (a, b) =>
      D(b.received ?? b.requested).comparedTo(D(a.received ?? a.requested)) ||
      byText(a.vehicle.name, b.vehicle.name),
  )[0];

/**
 * Closing to Closed: the position is created from the deal as captured (docs/04 M5 AC: data
 * captured once), its entry date the closing's close date, its vehicle the largest allocation
 * line's; the closing is stamped with it. The one-pager's figures stay null: no flow or mark is
 * on record yet, and nothing is invented (rule 10).
 */
function convert(
  ctx: SimContext,
  actor: SimActor,
  sim: SimOpportunity,
  closing: SimClosing,
  instance: string,
): InvestmentDetail | Response {
  const largest = largestAllocation(sim.allocations);
  if (largest === undefined)
    return precondition(instance, 'no allocation names the vehicle the position closes into (M22)');
  const detail: InvestmentDetail = {
    id: ctx.env.newId(),
    investmentNumber: nextInvestmentNumber(ctx),
    companyName: sim.row.companyName,
    sponsorId: sim.row.sponsor.id,
    sponsorName: sim.row.sponsor.name,
    sponsorFundName: sim.row.sponsorFund?.name ?? null,
    vehicleId: largest.vehicle.id,
    vehicleName: largest.vehicle.name,
    dealType: sim.row.dealType,
    sector: sim.row.sector,
    geography: sim.row.geography,
    vintage: Number(closing.closeDate.slice(0, 4)),
    entryDate: closing.closeDate,
    exitDate: null,
    isActive: true,
    holdingPeriodYears: null,
    invested: null,
    distributions: null,
    nav: null,
    navDate: null,
    grossMoic: null,
    grossIrr: null,
    irrFlag: 'insufficient_flows',
    calcVersion: 'preview',
    companyId: ctx.env.newId(),
    sponsorFundId: sim.row.sponsorFund?.id ?? null,
    closeDate: closing.closeDate,
    companyDescription: null,
    latestPeriodEnd: null,
    cashFlows: [],
    valuations: [],
    credit: null,
    operating: null,
  };
  ctx.state.investments.set(detail.id, {
    detail,
    opportunityId: sim.row.id,
    closingId: closing.id,
  });
  closing.investmentId = detail.id;
  closing.changed = true;
  recordActivity(ctx, actor, {
    action: 'investment.create',
    entity: 'investment',
    entityId: detail.id,
    reason: null,
    from: null,
    to: 'active',
  });
  return detail;
}

/**
 * POST /api/v1/opportunities/{id}/commands: advance through the gates, pass with a reason code,
 * reopen with a reason; Approved to Closing opens the closing record, Closing to Closed converts
 * the deal once operations confirmed the closing.
 */
export const opportunityCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/opportunities/{id}/commands',
  what: 'command',
  body: opportunityCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const body = req.body;
    if (body.command === 'advance' && tooManyDecimals(body.commitmentAmount))
      return validation(instance, 'commitmentAmount', 'At most two decimal places');
    const sim = opportunityFor(ctx, req.credential, req.params.id ?? '', instance);
    if (sim instanceof Response) return sim;
    const stale = staleIfMatch(req.headers, sim.row.rowVersion, instance);
    if (stale !== null) return stale;
    const from = sim.row.stage;
    const closings = ensureClosings(ctx.state, ctx.recordings);
    const closing = sim.closingId === null ? undefined : closings.get(sim.closingId);
    const gates = gatesOf(ctx, sim);
    const reason = body.command === 'pass' ? body.note : body.reason;
    const result = attempt(dealStageMachine, from, body.command, {
      actorId: req.actor.userId,
      actorRoles: req.actor.roles,
      ...(reason !== undefined ? { reason } : {}),
      record: {
        requiredTasksDone: gates.diligence.ok,
        icDecisionRecorded: gates.icDecision.ok,
        closingChecklistComplete: gates.closing.checklistComplete,
        allocationTiedOut: gates.closing.allocationTiedOut,
        closingRecordReady:
          body.command === 'advance' &&
          body.closeDate !== undefined &&
          body.commitmentAmount !== undefined,
        ...(body.command === 'pass' ? { passReasonCode: body.passReasonCode } : {}),
      },
    });
    if (!result.ok) return workflowProblem(result, { instance, simulated: true });
    const to = result.to;

    const next: OpportunityRow = {
      ...sim.row,
      stage: to,
      daysInStage: 0,
      rowVersion: sim.row.rowVersion + 1,
    };
    let passNote = sim.passNote;
    if (body.command === 'pass') {
      if (!knownCode(ctx, req.credential, body.passReasonCode))
        return validation(instance, 'passReasonCode', 'Unknown code');
      next.passReasonCode = body.passReasonCode;
      passNote = body.note ?? null;
    } else if (body.command === 'reopen') {
      next.passReasonCode = null;
      passNote = null;
    } else if (from === 'Approved' && to === 'Closing') {
      if (body.closeDate === undefined || body.commitmentAmount === undefined)
        return precondition(instance, 'a close date and commitment are required to open closing');
      if (closing !== undefined) {
        // A deal that reaches Closing again keeps the record it had, with the new date and commitment.
        closing.closeDate = body.closeDate;
        closing.commitmentAmount = body.commitmentAmount;
        closing.changed = true;
      } else {
        const opened: SimClosing = {
          id: ctx.env.newId(),
          opportunityId: sim.row.id,
          investmentId: null,
          closeDate: body.closeDate,
          commitmentAmount: body.commitmentAmount,
          currency: sim.row.currency,
          state: 'Open',
          opsConfirmedBy: null,
          opsConfirmedAt: null,
          items: checklistOf(ctx).items.map((i) => ({
            id: ctx.env.newId(),
            itemCode: i.code,
            label: i.label,
            required: i.required,
            documentId: null,
            status: 'open',
            waivedReason: null,
          })),
          legalTerms: [],
          allocations: [],
          rowVersion: 1,
          origin: 'created',
          changed: true,
        };
        closings.set(opened.id, opened);
        sim.closingId = opened.id;
        recordActivity(ctx, req.actor, {
          action: 'closing.open',
          entity: 'closing',
          entityId: opened.id,
          reason: null,
          from: null,
          to: 'Open',
        });
      }
    } else if (from === 'Closing' && to === 'Closed') {
      if (closing?.state !== 'OpsConfirmed')
        return precondition(instance, 'the closing is not confirmed by operations (M8)');
      const created = convert(ctx, req.actor, sim, closing, instance);
      if (created instanceof Response) return created;
      next.investmentId = created.id;
    }
    if (to === 'Diligence') createTemplateTasks(ctx, sim);

    sim.row = next;
    sim.passNote = passNote;
    sim.stageHistory.push({
      fromStage: from,
      toStage: to,
      command: body.command,
      reason: reason ?? null,
      changedBy: personOf(req.actor),
      changedAt: ctx.env.now(),
    });
    sim.changed = true;
    recordActivity(ctx, req.actor, {
      action: `opportunity.${body.command}`,
      entity: 'opportunity',
      entityId: sim.row.id,
      reason: reason ?? null,
      from,
      to,
    });
    return answer(ctx, sim);
  },
});

/** POST /api/v1/opportunities/{id}/diligence-tasks (deal team): a task beside the template ones. */
export const createDiligenceTaskRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/opportunities/{id}/diligence-tasks',
  what: 'task',
  body: diligenceTaskCreateBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const sim = opportunityFor(ctx, req.credential, req.params.id ?? '', instance);
    if (sim instanceof Response) return sim;
    const body = req.body;
    if (!knownCode(ctx, req.credential, body.workstream))
      return validation(instance, 'workstream', 'Unknown code');
    const owner =
      body.ownerId === undefined
        ? undefined
        : ctx.recordings.users.find((u) => u.userId === body.ownerId);
    if (body.ownerId !== undefined && owner === undefined)
      return validation(instance, 'ownerId', 'Unknown user');
    const task: DiligenceTask = {
      id: ctx.env.newId(),
      workstream: body.workstream,
      title: body.title,
      owner: owner === undefined ? null : { id: owner.userId, name: owner.displayName },
      dueDate: body.dueDate ?? null,
      status: 'open',
      requiredForIc: body.requiredForIc,
      evidenceDocumentId: null,
      waivedReason: null,
    };
    sim.tasks.push(task);
    sim.changed = true;
    recordActivity(ctx, req.actor, {
      action: 'diligence_task.create',
      entity: 'diligence_task',
      entityId: task.id,
      reason: null,
      from: null,
      to: 'open',
    });
    return answer(ctx, sim, 201);
  },
});

/** POST /api/v1/opportunities/{id}/diligence-tasks/{taskId}/commands: complete (evidence optional), waive (reason) or reopen a task. */
export const diligenceTaskCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/opportunities/{id}/diligence-tasks/{taskId}/commands',
  what: 'command',
  body: diligenceTaskCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const sim = opportunityFor(ctx, req.credential, req.params.id ?? '', instance);
    if (sim instanceof Response) return sim;
    const taskId = req.params.taskId ?? '';
    const task = UUID.test(taskId) ? sim.tasks.find((t) => t.id === taskId) : undefined;
    if (task === undefined)
      return problem(404, 'not-found', TASK_NOT_FOUND, { instance, simulated: true });
    const body = req.body;
    const move = TASK_MOVES[body.command];
    if (!move.from.includes(task.status))
      return problem(
        409,
        'workflow-transition',
        `diligence task: ${body.command} is not allowed from ${task.status}`,
        { instance, simulated: true },
      );
    if (body.command === 'complete' && body.evidenceDocumentId !== undefined) {
      if (!documentVisible(ctx, req.credential, body.evidenceDocumentId))
        return precondition(
          instance,
          'evidenceDocumentId: the document is not in the hub or not visible to you',
        );
      task.evidenceDocumentId = body.evidenceDocumentId;
    }
    const before = task.status;
    task.status = move.to;
    task.waivedReason = body.command === 'waive' ? body.reason : null;
    sim.changed = true;
    recordActivity(ctx, req.actor, {
      action: `diligence_task.${body.command}`,
      entity: 'diligence_task',
      entityId: task.id,
      reason: body.command === 'waive' ? body.reason : null,
      from: before,
      to: move.to,
    });
    return answer(ctx, sim);
  },
});

/** POST /api/v1/opportunities/{id}/ic-decisions (approver): the committee's decision while the deal is at IC; one per date. */
export const icDecisionRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/opportunities/{id}/ic-decisions',
  what: 'decision',
  body: icDecisionBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const sim = opportunityFor(ctx, req.credential, req.params.id ?? '', instance);
    if (sim instanceof Response) return sim;
    const body = req.body;
    if (sim.row.stage !== 'IC')
      return precondition(
        instance,
        'an IC decision is recorded while the deal is at IC (docs/18 section 4)',
      );
    if (tooManyDecimals(body.amount))
      return validation(instance, 'amount', 'At most two decimal places');
    if (sim.decisions.some((d) => d.decisionDate === body.decisionDate))
      return problem(
        409,
        'conflict',
        'a decision is already recorded for that date; a decision on another date supersedes it',
        { instance, simulated: true },
      );
    const decision = {
      id: ctx.env.newId(),
      decisionDate: body.decisionDate,
      decision: body.decision,
      amount: body.amount ?? null,
      conditions: body.conditions,
      recordedBy: personOf(req.actor),
    };
    // Latest first: the newest decision date leads, and among one date the one recorded last.
    sim.decisions = [decision, ...sim.decisions].sort((a, b) =>
      byText(b.decisionDate, a.decisionDate),
    );
    sim.changed = true;
    recordActivity(ctx, req.actor, {
      action: 'ic_decision.record',
      entity: 'ic_decision',
      entityId: decision.id,
      reason: null,
      from: null,
      to: body.decision,
    });
    return answer(ctx, sim, 201);
  },
});

/** PUT /api/v1/opportunities/{id}/allocations (deal team, operations): the whole list at once; fixed once the deal is Closed. */
export const putAllocationsRoute = defineSimRoute({
  method: 'PUT',
  path: '/api/v1/opportunities/{id}/allocations',
  what: 'allocations',
  body: allocationsPutBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const sim = opportunityFor(ctx, req.credential, req.params.id ?? '', instance);
    if (sim instanceof Response) return sim;
    if (sim.row.stage === 'Closed')
      return precondition(
        instance,
        'allocations are fixed once the deal is closed (M22); raise a change request instead',
      );
    const vehicles = ctx.recordings.read(req.credential, '/api/v1/vehicles', vehicleList)?.items;
    const clients = ctx.recordings.read(req.credential, '/api/v1/clients', clientList)?.items;
    const seen = new Set<string>();
    const lines: AllocationRow[] = [];
    for (const [i, line] of req.body.allocations.entries()) {
      const clientId = line.clientId ?? null;
      const key = `${line.vehicleId}|${clientId ?? ''}`;
      if (seen.has(key))
        return validation(instance, `allocations.${i}`, 'A vehicle and client may appear once');
      seen.add(key);
      if (tooManyDecimals(line.requested))
        return validation(instance, `allocations.${i}.requested`, 'At most two decimal places');
      if (tooManyDecimals(line.received))
        return validation(instance, `allocations.${i}.received`, 'At most two decimal places');
      const vehicle = vehicles?.find((v) => v.id === line.vehicleId);
      if (vehicles !== undefined && vehicle === undefined)
        return validation(instance, `allocations.${i}.vehicleId`, 'Unknown vehicle');
      const client = clientId === null ? undefined : clients?.find((c) => c.id === clientId);
      lines.push({
        id: ctx.env.newId(),
        vehicle: { id: line.vehicleId, name: vehicle?.name ?? NOT_VISIBLE },
        client: clientId === null ? null : { id: clientId, name: client?.name ?? NOT_VISIBLE },
        requested: line.requested,
        received: line.received ?? null,
      });
    }
    // Lines read by vehicle name, then client, as the API orders them.
    sim.allocations = lines.sort(
      (a, b) =>
        byText(a.vehicle.name, b.vehicle.name) || byText(a.client?.id ?? '', b.client?.id ?? ''),
    );
    sim.changed = true;
    recordActivity(ctx, req.actor, {
      action: 'opportunity.allocations.replace',
      entity: 'opportunity',
      entityId: sim.row.id,
      reason: null,
      from: null,
      to: null,
      details: { lines: lines.length },
    });
    return answer(ctx, sim);
  },
});

/**
 * GET /api/v1/investments/{id}: the one-pager of a position a simulated close created this
 * session, built from the conversion; every other position answers from the credential's own
 * recording with this session's overlays, as the shim would, so a wall still hides what it hid
 * and a request outside the recordings is still logged as a miss.
 */
export const investmentDetailRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/investments/{id}',
  what: 'query',
  body: null,
  query: asOfQuery,
  handle: (req, ctx) => {
    const id = req.params.id ?? '';
    const created = ctx.state.investments.get(id);
    if (created !== undefined)
      return jsonResponse(200, investmentDetail.parse(created.detail), { simulated: true });
    const key = `${req.credential}|GET ${req.url.pathname}${req.url.search}`;
    const recorded = ctx.recordings.byKey(key);
    if (recorded === undefined) {
      recordMiss(key);
      return problem(404, 'not-found', 'This request is outside the recorded preview', {
        instance: req.url.pathname,
      });
    }
    const text =
      recorded.status === 200
        ? overlayRecordedBody(req.url, recorded.text, {
            credential: req.credential,
            recordings: ctx.recordings,
            state: ctx.state,
          })
        : recorded.text;
    return new Response(text, {
      status: recorded.status,
      headers: { 'content-type': recorded.contentType, 'x-request-id': 'preview' },
    });
  },
});
