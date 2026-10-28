import {
  addDays,
  alignedQuarterEnd,
  isQuarterEnd,
  latestQuarterEndOnOrBefore,
  lockedNear,
  toDecimalString,
  valueChange,
} from '@pb/calc';
import definitions from '../../../../../config/definitions.json';
import {
  investmentDetail,
  problemDetails,
  valuationBatchCommandBody,
  valuationCommandBody,
  valuationCreateBody,
  valuationDetail,
  valuationLockText,
} from '@pb/contracts';
import type {
  InvestmentDetail,
  ValuationApproval,
  ValuationBatchResult,
  ValuationCommandBody,
  ValuationDetail,
  ValuationRow,
} from '@pb/contracts';
import { attempt, valuationMachine } from '@pb/workflows';
import { closedByLock, isInFlight } from '../../pages/valuations/board.js';
import { sha256Hex, subtleCrypto } from '../hash.js';
import { overlayInvestmentDetail } from '../overlay.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureValuations, personFor } from '../state.js';
import type { SimActor, SimValuation } from '../state.js';
import { openChangeRequestsOf } from './changeRequests.js';
import { canOpen, defineSimRoute, knownCode, recordActivity, staleIfMatch } from './common.js';
import type { SimContext } from './common.js';

/**
 * Valuations through docs/18 section 1 (docs/04 M10, decision 0013), the way
 * apps/api/src/valuations/workflow.service.ts serves them. Create is the "(new) to Draft" row:
 * operations only (the contract's role guard), the investment must be one the credential can
 * open and must be active (404 otherwise, never a hint that it exists), the period a quarter end
 * or within the tolerance of one, on or after the entry date, and one chain per investment and
 * quarter (a Locked version is reopened first, a version in progress continued). Every other
 * change goes through attempt() on valuationMachine; each command writes one approval row the
 * detail shows and one activity entry; a reopen marks the Locked version Reopened and answers the
 * next version as a Draft with the same inputs, as the API does. The batch screen runs the same
 * command id by id and never stops at a refusal.
 */

const NOT_FOUND = 'Valuation not found';
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;
/** A core.taxonomy_term code of the valuation_method domain. */
const METHOD_CODE = /^valuation_method\.[a-z0-9_]+$/;

export function readDetail(
  ctx: SimContext,
  credential: string,
  investmentId: string,
): InvestmentDetail | undefined {
  return ctx.recordings.read(
    credential,
    `/api/v1/investments/${encodeURIComponent(investmentId)}`,
    investmentDetail,
  );
}

/** How far a period end may sit from its quarter end (config/definitions.json), as in the API. */
const TOLERANCE_DAYS: number = definitions.priorYearPeriodEndToleranceDays;

/** Fair value strictly above zero, read from the decimal string without floating point. */
export function isPositiveDecimal(value: string): boolean {
  return POSITIVE_DECIMAL.test(value) && /[1-9]/.test(value);
}

/**
 * The lock hash covers the inputs and the value (docs/18 section 1): SHA-256 over the text
 * @pb/contracts fixes (valuationLockText), the same text the API hashes with node:crypto.
 */
export function lockHashOf(row: ValuationRow): Promise<string> {
  return sha256Hex(valuationLockText(row));
}

type VersionEntry = InvestmentDetail['valuations'][number];

/** The versions of the investment the credential can see, with every simulated change applied. */
function versionsOf(ctx: SimContext, credential: string, investmentId: string): VersionEntry[] {
  const detail = readDetail(ctx, credential, investmentId);
  if (detail === undefined) return [];
  return overlayInvestmentDetail(detail, ensureValuations(ctx.state, ctx.recordings).values())
    .valuations;
}

/** The versions among these that report for the same quarter as the period end (alignedQuarterEnd). */
function sameQuarterAs(versions: readonly VersionEntry[], periodEnd: string): VersionEntry[] {
  const quarterEnd = alignedQuarterEnd(periodEnd, TOLERANCE_DAYS);
  return versions.filter((v) => alignedQuarterEnd(v.periodEnd, TOLERANCE_DAYS) === quarterEnd);
}

function nextVersion(
  versions: readonly VersionEntry[],
  sims: Iterable<SimValuation>,
  investmentId: string,
  periodEnd: string,
): number {
  let max = 0;
  for (const v of versions) if (v.periodEnd === periodEnd) max = Math.max(max, v.version);
  for (const s of sims) {
    if (s.row.investmentId === investmentId && s.row.periodEnd === periodEnd)
      max = Math.max(max, s.row.version);
  }
  return max + 1;
}

const freshFields = {
  state: 'Draft',
  lockHash: null,
  preparedBy: null,
  dealTeamApprovedBy: null,
  approvedBy: null,
  approvedAt: null,
  reopenReason: null,
  rowVersion: 1,
} as const;

/** What a new Draft version takes: the period, the method and the value, and who prepared it when a staged value made it. */
export interface DraftInput {
  periodEnd: string;
  method: string;
  fairValue: string;
  /** The reviewer whose approval of a staged weekly value created the Draft (the API's preparedBy); none for a Draft started on the board. */
  preparedBy?: SimActor | undefined;
}

/**
 * The "(new) to Draft" row of docs/18 section 1 as a simulated record: the next version for the
 * investment and period among the versions the credential can see, its quarter and its prior
 * Locked mark by the API's rules (@pb/calc, which only this lazily loaded chunk bundles), added
 * to the valuation sims so the board and the one-pager show it. The caller checks what may refuse
 * first (an inactive investment, a Locked quarter) and records the activity.
 */
export function createDraft(
  ctx: SimContext,
  credential: string,
  detail: InvestmentDetail,
  input: DraftInput,
): ValuationRow {
  const sims = ensureValuations(ctx.state, ctx.recordings);
  const versions = versionsOf(ctx, credential, detail.id);
  const { periodEnd, method, fairValue } = input;
  const quarterEnd = alignedQuarterEnd(periodEnd, TOLERANCE_DAYS);
  // The API's rule (packages/calc): the Locked mark that reports for the quarter before this
  // one; the highest version first so the latest version wins.
  const prior =
    lockedNear(
      [...versions].sort((a, b) => b.version - a.version),
      latestQuarterEndOnOrBefore(addDays(quarterEnd, -1)),
      TOLERANCE_DAYS,
    ) ?? undefined;
  const row: ValuationRow = {
    ...freshFields,
    id: ctx.env.newId(),
    investmentId: detail.id,
    investmentNumber: detail.investmentNumber,
    companyName: detail.companyName,
    vehicleName: detail.vehicleName,
    dealType: detail.dealType,
    periodEnd,
    quarterEnd,
    version: nextVersion(versions, sims.values(), detail.id, periodEnd),
    method,
    fairValue,
    priorFairValue: prior?.fairValue ?? null,
    // The API's rule from @pb/calc (docs/08 section 2): null without a recorded prior Locked
    // mark or against a zero one.
    changePct: toDecimalString(valueChange(fairValue, prior?.fairValue ?? null)),
    preparedBy: input.preparedBy?.displayName ?? null,
  };
  sims.set(row.id, {
    row,
    origin: 'created',
    changed: true,
    vehicleId: detail.vehicleId,
    preparedByIds: input.preparedBy === undefined ? [] : [input.preparedBy.userId],
    dealTeamApprovedByIds: [],
    approvedByIds: [],
    approvals: [],
  });
  return row;
}

const precondition = (instance: string, detail: string): Response =>
  problem(422, 'workflow-precondition', detail, { instance, simulated: true });

export const createValuationRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/valuations',
  what: 'valuation',
  body: valuationCreateBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const { periodEnd } = req.body;
    const quarterEnd = alignedQuarterEnd(periodEnd, TOLERANCE_DAYS);
    if (quarterEnd === periodEnd && !isQuarterEnd(periodEnd))
      return precondition(
        instance,
        `valuation: the period end must be a quarter end or within ${TOLERANCE_DAYS} days of one`,
      );
    if (!isPositiveDecimal(req.body.fairValue))
      return problem(400, 'validation', 'Invalid body', {
        instance,
        simulated: true,
        errors: [{ path: 'fairValue', message: 'Must be above zero' }],
      });
    if (!METHOD_CODE.test(req.body.method) || !knownCode(ctx, req.credential, req.body.method))
      return problem(400, 'validation', 'Invalid body', {
        instance,
        simulated: true,
        errors: [{ path: 'method', message: 'Not a valuation_method code' }],
      });
    const detail = readDetail(ctx, req.credential, req.body.investmentId);
    // An investment the credential cannot open, or one no longer held, is not found: no hint that it exists.
    if (detail?.isActive !== true)
      return problem(404, 'not-found', 'Investment not found', { instance, simulated: true });
    const versions = versionsOf(ctx, req.credential, detail.id);
    if (periodEnd < detail.entryDate)
      return precondition(
        instance,
        'valuation: the investment was not yet held at this period end',
      );
    // One version chain per quarter: a sponsor reporting a few days early or late is the same
    // quarter (alignedQuarterEnd), so its versions block a second chain at the quarter end.
    const sameQuarter = sameQuarterAs(versions, periodEnd);
    if (closedByLock(sameQuarter))
      return precondition(
        instance,
        'valuation: a Locked version exists for this investment and quarter; reopen it to start a new version',
      );
    if (sameQuarter.some((v) => isInFlight(v.state)))
      return precondition(
        instance,
        'valuation: a version for this investment and quarter is already in progress; continue that version',
      );
    const row = createDraft(ctx, req.credential, detail, req.body);
    recordActivity(ctx, req.actor, {
      action: 'valuation.create',
      entity: 'valuation',
      entityId: row.id,
      reason: null,
      from: null,
      to: row.state,
    });
    return jsonResponse(201, row, { simulated: true, etag: row.rowVersion });
  },
});

type Outcome = { ok: true; row: ValuationRow } | { ok: false; response: Response };

/**
 * One command on one version for one credential, in the API's order: 404 for a version the
 * credential cannot open (no existence leak), 412 for a stale If-Match, the machine, then the
 * write and its approval row. Everything that can refuse comes before the first change, so a
 * refused command leaves no half-applied version behind. Shared by the command and batch routes.
 */
export async function runValuationCommand(
  ctx: SimContext,
  credential: string,
  actor: SimActor,
  id: string,
  body: ValuationCommandBody,
  headers: Headers,
  instance: string,
): Promise<Outcome> {
  const refuse = (response: Response): Outcome => ({ ok: false, response });
  const sims = ensureValuations(ctx.state, ctx.recordings);
  const sim = sims.get(id);
  if (sim === undefined || !canOpen(ctx, credential, sim.row.investmentId))
    return refuse(problem(404, 'not-found', NOT_FOUND, { instance, simulated: true }));
  const stale = staleIfMatch(headers, sim.row.rowVersion, instance);
  if (stale !== null) return refuse(stale);

  const { row } = sim;
  const { command, reason } = body;
  const result = attempt(valuationMachine, row.state, command, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    ...(reason !== undefined ? { reason } : {}),
    record: {
      inputsComplete: row.method.length > 0 && row.fairValue.length > 0,
      validationPassed: isPositiveDecimal(row.fairValue),
      preparedBy: personFor(sim.preparedByIds, actor),
      lockHash: row.lockHash,
    },
  });
  if (!result.ok) return refuse(workflowProblem(result, { instance, simulated: true }));

  const next: ValuationRow = { ...row, state: result.to, rowVersion: row.rowVersion + 1 };
  const updated: SimValuation = { ...sim, row: next, changed: true, approvals: [...sim.approvals] };
  const draftId = command === 'reopen' ? ctx.env.newId() : null;
  let step: ValuationApproval['step'];
  let decision: ValuationApproval['decision'];
  if (command === 'lock') {
    // One Locked version per investment and quarter (valuationMachine's lock row).
    const others = sameQuarterAs(versionsOf(ctx, credential, row.investmentId), row.periodEnd);
    if (
      others.some(
        (v) =>
          v.state === 'Locked' && !(v.periodEnd === row.periodEnd && v.version === row.version),
      )
    )
      return refuse(
        problem(
          409,
          'conflict',
          'valuation: another version is Locked for this investment and quarter; reopen it before locking this one',
          { instance, simulated: true },
        ),
      );
  }
  if (command === 'prepare') {
    if (subtleCrypto() === undefined)
      return refuse(
        problem(
          503,
          'unavailable',
          'This browser offers SHA-256 only on secure (https) pages, so the lock hash cannot be computed here.',
          { instance, simulated: true },
        ),
      );
    next.preparedBy = actor.displayName;
    next.lockHash = await lockHashOf(row);
    updated.preparedByIds = [actor.userId];
    step = 'ops_prepared';
    decision = 'approve';
  } else if (command === 'sendBack') {
    step = actor.roles.includes('deal_team') ? 'deal_team' : 'ops_prepared';
    decision = 'reject';
  } else if (command === 'dealTeamApprove') {
    next.dealTeamApprovedBy = actor.displayName;
    updated.dealTeamApprovedByIds = [actor.userId];
    step = 'deal_team';
    decision = 'approve';
  } else if (command === 'lock') {
    next.approvedBy = actor.displayName;
    next.approvedAt = `${ctx.recordings.asOf}T12:00:00Z`;
    updated.approvedByIds = [actor.userId];
    step = 'final';
    decision = 'approve';
  } else {
    next.reopenReason = reason ?? null;
    step = 'reopen';
    decision = 'reopen';
  }
  updated.approvals.push({
    id: ctx.env.newId(),
    step,
    decision,
    actorId: actor.userId,
    actorName: actor.displayName,
    at: ctx.env.now(),
    reason: reason ?? null,
  });
  sims.set(next.id, updated);
  recordActivity(ctx, actor, {
    action: `valuation.${command}`,
    entity: 'valuation',
    entityId: next.id,
    reason: reason ?? null,
    from: row.state,
    to: next.state,
  });
  if (draftId === null) return { ok: true, row: next };

  // docs/18 section 1: reopening creates a new Draft version with the same inputs to edit, and
  // the answer is that Draft, as the API answers it.
  const detail = readDetail(ctx, credential, row.investmentId);
  const draft: ValuationRow = {
    ...next,
    ...freshFields,
    id: draftId,
    version: nextVersion(
      versionsOf(ctx, credential, row.investmentId),
      sims.values(),
      row.investmentId,
      row.periodEnd,
    ),
  };
  sims.set(draft.id, {
    row: draft,
    origin: 'created',
    changed: true,
    vehicleId: sim.vehicleId ?? detail?.vehicleId ?? null,
    preparedByIds: [],
    dealTeamApprovedByIds: [],
    approvedByIds: [],
    approvals: [],
  });
  recordActivity(ctx, actor, {
    action: 'valuation.create',
    entity: 'valuation',
    entityId: draft.id,
    reason: reason ?? null,
    from: null,
    to: draft.state,
  });
  return { ok: true, row: draft };
}

export const valuationCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/valuations/{id}/commands',
  what: 'command',
  body: valuationCommandBody,
  idempotent: true,
  handle: async (req, ctx) => {
    const outcome = await runValuationCommand(
      ctx,
      req.credential,
      req.actor,
      req.params.id ?? '',
      req.body,
      req.headers,
      req.url.pathname,
    );
    if (!outcome.ok) return outcome.response;
    return jsonResponse(200, outcome.row, { simulated: true, etag: outcome.row.rowVersion });
  },
});

/**
 * POST /api/v1/valuations/batch-commands (deal team, approver): the same command on each id in
 * the order sent, each judged on its own, so one refusal never stops the rest; the answer
 * carries the new state or the problem per id, and the batch itself records nothing.
 */
export const valuationBatchCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/valuations/batch-commands',
  what: 'batch',
  body: valuationBatchCommandBody,
  idempotent: true,
  handle: async (req, ctx) => {
    const results: ValuationBatchResult['results'] = [];
    for (const id of req.body.ids) {
      const outcome = await runValuationCommand(
        ctx,
        req.credential,
        req.actor,
        id,
        {
          command: req.body.command,
          ...(req.body.reason !== undefined ? { reason: req.body.reason } : {}),
        },
        new Headers(),
        `/api/v1/valuations/${encodeURIComponent(id)}/commands`,
      );
      if (outcome.ok) {
        results.push({ id, ok: true, state: outcome.row.state });
        continue;
      }
      const refusal = problemDetails.parse(JSON.parse(await outcome.response.text()));
      results.push({
        id,
        ok: false,
        problem: {
          status: refusal.status,
          code: refusal.type.split('/').pop() ?? 'error',
          detail: refusal.detail ?? refusal.title,
        },
      });
    }
    const body: ValuationBatchResult = { results };
    return jsonResponse(200, body, { simulated: true });
  },
});

/**
 * GET /api/v1/valuations/{id}: the version as the session holds it, the recorded approval trail
 * with this session's rows after it, the open change requests of its position (M11) and, once
 * Locked, the exact text its hash covers. 404 for a version the credential cannot open.
 */
export const valuationDetailRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/valuations/{id}',
  what: 'valuation',
  body: null,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const id = req.params.id ?? '';
    const sim = ensureValuations(ctx.state, ctx.recordings).get(id);
    const recorded = ctx.recordings.read(
      req.credential,
      `/api/v1/valuations/${encodeURIComponent(id)}`,
      valuationDetail,
    );
    if (sim === undefined || !canOpen(ctx, req.credential, sim.row.investmentId))
      return problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });
    const { row } = sim;
    const detail: ValuationDetail = {
      ...row,
      approvals: [...(recorded?.approvals ?? []), ...sim.approvals],
      openChangeRequests: openChangeRequestsOf(ctx, req.credential, row.investmentId),
      lockText: row.state === 'Locked' ? valuationLockText(row) : null,
    };
    return jsonResponse(200, detail, { simulated: true, etag: row.rowVersion });
  },
});
