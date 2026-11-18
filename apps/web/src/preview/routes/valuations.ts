import { D, alignedQuarterEnd, isQuarterEnd } from '@pb/calc';
import definitions from '../../../../../config/definitions.json';
import {
  investmentDetail,
  problemDetails,
  valuationBatchCommandBody,
  valuationCommandBody,
  valuationCreateBody,
  valuationDetail,
  valuationEditBody,
  valuationLockText,
} from '@pb/contracts';
import type {
  InvestmentDetail,
  ValuationApproval,
  ValuationBatchResult,
  ValuationCommandBody,
  ValuationDetail,
  ValuationLockInputs,
  ValuationRow,
  ValuationStoredInputs,
} from '@pb/contracts';
import { attempt, keepSuggestionKeys, valuationMachine } from '@pb/workflows';
import { closedByLock, isInFlight } from '../../pages/valuations/board.js';
import { sha256Hex, subtleCrypto } from '../hash.js';
import { versionsNow, withPriorMark } from '../overlay.js';
import type { VersionEntry } from '../overlay.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureValuations, personFor } from '../state.js';
import type { SimActor, SimValuation } from '../state.js';
import { openChangeRequestsOf } from './changeRequests.js';
import { canOpen, defineSimRoute, knownCode, recordActivity, staleIfMatch } from './common.js';
import type { SimContext } from './common.js';
import { refreshPosition, sourceReviewersOn } from './suggestionDerivation.js';

/**
 * Valuations through docs/18 section 1 (docs/04 M10, decision 0013), the way
 * apps/api/src/valuations/workflow.service.ts serves them. Create is the "(new) to Draft" row:
 * operations only (the contract's role guard), the investment must be one the credential can
 * open and must be active (404 otherwise, never a hint that it exists), the period a quarter end
 * or within the tolerance of one, on or after the entry date, and one chain per investment and
 * quarter (a Locked version is reopened first, a version in progress continued). Operations
 * corrects a Draft, and only a Draft, with the edit: the method, the value and the method inputs,
 * which approves nothing and writes no approval row. Every other change goes through attempt()
 * on valuationMachine; each command writes one approval row the detail shows and one activity
 * entry; the lock takes the hash over the identity, the method, the inputs and the value the
 * version holds then; a reopen marks the Locked version Reopened and answers the next version as
 * a Draft with the same method, inputs and value, as the API does. Every answer carries the
 * prior Locked mark as it stands when it is given. The batch screen runs the same command id by
 * id and never stops at a refusal.
 *
 * A valuation suggestion (docs/18 section 14, decision 0023) never writes a mark by itself: its
 * accept opens a Draft through openDraft and its applyToDraft corrects the open Draft through
 * correctDraft, the two writes the create and the edit routes here make. The keys a suggestion
 * leaves on a Draft's inputs (`suggestion.`) say where the value came from: a create or an edit
 * sent by a person can neither forge, change nor drop them, so the lock hash seals them with
 * the mark. Whoever approved a run behind a suggestion accepted onto a version, or typed one of
 * its figures, can take neither approval of that version nor of a later version of the same
 * quarter, which a reopen starts with the same mark (the machine's sourceReviewers). A lock and
 * a reopen derive the Open suggestions of the position again.
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
 * A fair value as the column answers it (mon.valuation.fair_value is numeric with two decimals):
 * the contract's positiveMoney admits at most two, so this adds zeros and never rounds, and a
 * value sent as 10.5 reads back as 10.50 the way the API reads it back from the row written.
 */
const storedMoney = (value: string): string => D(value).toFixed(2);

/**
 * The lock hash covers the identity, the method, the method inputs and the value (docs/18
 * section 1): SHA-256 over the text @pb/contracts fixes (valuationLockText), the same text the
 * API hashes with node:crypto. The version is passed with its inputs: a board row carries none.
 */
export function lockHashOf(version: ValuationLockInputs): Promise<string> {
  return sha256Hex(valuationLockText(version));
}

/**
 * The method inputs of a version: what a create, an edit or a reopen of this session gave it,
 * or, for a version as recorded, the inputs of its recorded detail (none when the build
 * recorded no detail for it: no version is seeded with inputs).
 */
function inputsOf(ctx: SimContext, credential: string, sim: SimValuation): ValuationStoredInputs {
  if (sim.inputs !== null) return sim.inputs;
  return (
    ctx.recordings.read(
      credential,
      `/api/v1/valuations/${encodeURIComponent(sim.row.id)}`,
      valuationDetail,
    )?.inputs ?? {}
  );
}

/** The versions of the investment the credential can see, with every simulated change applied. */
function versionsOf(ctx: SimContext, credential: string, investmentId: string): VersionEntry[] {
  return versionsNow(
    { credential, recordings: ctx.recordings, state: ctx.state },
    ensureValuations(ctx.state, ctx.recordings),
    investmentId,
  );
}

/**
 * The row as the API would answer it now: the prior Locked mark and the change against it are
 * read when the answer is given (valuations.service.ts rowById), so a reopen or a lock of this
 * session shows on every later answer for the position. A position nothing changed on keeps
 * its recorded figures.
 */
function answered(ctx: SimContext, credential: string, row: ValuationRow): ValuationRow {
  const sims = ensureValuations(ctx.state, ctx.recordings);
  for (const sim of sims.values()) {
    if (sim.changed && sim.row.investmentId === row.investmentId)
      return withPriorMark(row, versionsOf(ctx, credential, row.investmentId), TOLERANCE_DAYS);
  }
  return row;
}

/** The versions among these that report for the same quarter as the period end (alignedQuarterEnd). */
function sameQuarterAs(versions: readonly VersionEntry[], periodEnd: string): VersionEntry[] {
  const quarterEnd = alignedQuarterEnd(periodEnd, TOLERANCE_DAYS);
  return versions.filter((v) => alignedQuarterEnd(v.periodEnd, TOLERANCE_DAYS) === quarterEnd);
}

/**
 * The versions of a version's investment and quarter, itself included: the chain a reopen
 * continues, which the source reviewer rule is read over (workflow.service.ts sourceReviewers).
 */
function chainIdsOf(sims: Iterable<SimValuation>, row: ValuationRow): string[] {
  const quarterEnd = alignedQuarterEnd(row.periodEnd, TOLERANCE_DAYS);
  const ids: string[] = [];
  for (const sim of sims) {
    if (
      sim.row.investmentId === row.investmentId &&
      alignedQuarterEnd(sim.row.periodEnd, TOLERANCE_DAYS) === quarterEnd
    )
      ids.push(sim.row.id);
  }
  return ids;
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

/** What a new Draft version takes: the period, the method, the value and the inputs, and who prepared it when a staged value made it. */
export interface DraftInput {
  periodEnd: string;
  method: string;
  fairValue: string;
  /** The method inputs the create carried; none for a Draft a staged weekly value made. */
  inputs?: ValuationStoredInputs | undefined;
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
  const row: ValuationRow = withPriorMark(
    {
      ...freshFields,
      id: ctx.env.newId(),
      investmentId: detail.id,
      investmentNumber: detail.investmentNumber,
      companyName: detail.companyName,
      vehicleName: detail.vehicleName,
      dealType: detail.dealType,
      periodEnd,
      quarterEnd: alignedQuarterEnd(periodEnd, TOLERANCE_DAYS),
      version: nextVersion(versions, sims.values(), detail.id, periodEnd),
      method,
      fairValue,
      priorFairValue: null,
      changePct: null,
      preparedBy: input.preparedBy?.displayName ?? null,
    },
    // The Locked mark that reports for the quarter before this one, as the versions now stand.
    versions,
    TOLERANCE_DAYS,
  );
  sims.set(row.id, {
    row,
    origin: 'created',
    changed: true,
    vehicleId: detail.vehicleId,
    preparedByIds: input.preparedBy === undefined ? [] : [input.preparedBy.userId],
    dealTeamApprovedByIds: [],
    approvedByIds: [],
    approvals: [],
    inputs: input.inputs ?? {},
  });
  return row;
}

const precondition = (instance: string, detail: string): Response =>
  problem(422, 'workflow-precondition', detail, { instance, simulated: true });

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

/** 400 on the method field, in the API's two wordings: the shape of the code, then the taxonomy. */
const badMethod = (instance: string, message: string): Response =>
  problem(400, 'validation', 'Invalid body', {
    instance,
    simulated: true,
    errors: [{ path: 'method', message }],
  });

const NOT_A_METHOD_CODE = 'Not a valuation_method code';
const UNKNOWN_METHOD = 'Unknown valuation method';

/** What a write on a version answers: the row as it now stands, or the refusal, with nothing changed. */
export type Outcome = { ok: true; row: ValuationRow } | { ok: false; response: Response };

/** What a Draft is opened with: the body of a create, or the value and the keys of an accepted suggestion. */
export interface OpenDraftInput {
  investmentId: string;
  periodEnd: string;
  method: string;
  fairValue: string;
  /** Stored as given: the caller decides which keys a Draft may start with. */
  inputs: ValuationStoredInputs;
}

/**
 * The one write of a Draft version (the "(new) to Draft" row) with everything that refuses it,
 * in the API's order (createDraft of valuations/workflow.service.ts): the create route below,
 * and the accept of a valuation suggestion (docs/18 section 14). Nothing changes when it refuses.
 */
export function openDraft(
  ctx: SimContext,
  credential: string,
  actor: SimActor,
  input: OpenDraftInput,
  instance: string,
): Outcome {
  const refuse = (response: Response): Outcome => ({ ok: false, response });
  const { periodEnd } = input;
  const quarterEnd = alignedQuarterEnd(periodEnd, TOLERANCE_DAYS);
  if (quarterEnd === periodEnd && !isQuarterEnd(periodEnd))
    return refuse(
      precondition(
        instance,
        `valuation: the period end must be a quarter end or within ${TOLERANCE_DAYS} days of one`,
      ),
    );
  if (!isPositiveDecimal(input.fairValue))
    return refuse(
      problem(400, 'validation', 'Invalid body', {
        instance,
        simulated: true,
        errors: [{ path: 'fairValue', message: 'Must be above zero' }],
      }),
    );
  if (!METHOD_CODE.test(input.method)) return refuse(badMethod(instance, NOT_A_METHOD_CODE));
  const detail = readDetail(ctx, credential, input.investmentId);
  // An investment the credential cannot open, or one no longer held, is not found: no hint that it exists.
  if (detail?.isActive !== true)
    return refuse(problem(404, 'not-found', 'Investment not found', { instance, simulated: true }));
  if (!knownCode(ctx, credential, input.method)) return refuse(badMethod(instance, UNKNOWN_METHOD));
  const versions = versionsOf(ctx, credential, detail.id);
  if (periodEnd < detail.entryDate)
    return refuse(
      precondition(instance, 'valuation: the investment was not yet held at this period end'),
    );
  // One version chain per quarter: a sponsor reporting a few days early or late is the same
  // quarter (alignedQuarterEnd), so its versions block a second chain at the quarter end.
  const sameQuarter = sameQuarterAs(versions, periodEnd);
  if (closedByLock(sameQuarter))
    return refuse(
      precondition(
        instance,
        'valuation: a Locked version exists for this investment and quarter; reopen it to start a new version',
      ),
    );
  if (sameQuarter.some((v) => isInFlight(v.state)))
    return refuse(
      precondition(
        instance,
        'valuation: a version for this investment and quarter is already in progress; continue that version',
      ),
    );
  const row = createDraft(ctx, credential, detail, {
    periodEnd,
    method: input.method,
    fairValue: storedMoney(input.fairValue),
    inputs: input.inputs,
  });
  recordActivity(ctx, actor, {
    action: 'valuation.create',
    entity: 'valuation',
    entityId: row.id,
    reason: null,
    from: null,
    to: row.state,
  });
  return { ok: true, row };
}

export const createValuationRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/valuations',
  what: 'body',
  body: valuationCreateBody,
  idempotent: true,
  handle: (req, ctx) => {
    const outcome = openDraft(
      ctx,
      req.credential,
      req.actor,
      {
        investmentId: req.body.investmentId,
        periodEnd: req.body.periodEnd,
        method: req.body.method,
        fairValue: req.body.fairValue,
        // A person's own inputs: a key a suggestion would write is not theirs to send.
        inputs: keepSuggestionKeys({}, req.body.inputs ?? {}),
      },
      req.url.pathname,
    );
    if (!outcome.ok) return outcome.response;
    return jsonResponse(201, outcome.row, { simulated: true, etag: outcome.row.rowVersion });
  },
});

/**
 * PATCH /api/v1/valuations/{id} (operations, the contract's guard): the correction of a Draft
 * before it is prepared, which is how a reopened valuation comes to carry a corrected value
 * (docs/18 section 1, SEC-9.3). In the API's order: a method that is no valuation_method code is
 * 400, a version the credential cannot open is 404, a stale If-Match is 412, any state but
 * Draft is 409 and keeps every value, a method the taxonomy does not carry is 400. What the
 * body leaves out stays as it was; inputs replace the stored ones whole. The state stays Draft,
 * the row version goes up by one and no approval row is written, since an edit approves nothing.
 */
export const editValuationRoute = defineSimRoute({
  method: 'PATCH',
  path: '/api/v1/valuations/{id}',
  what: 'body',
  body: valuationEditBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const { method, fairValue, inputs } = req.body;
    if (method !== undefined && !METHOD_CODE.test(method))
      return badMethod(instance, NOT_A_METHOD_CODE);
    const outcome = correctDraft(
      ctx,
      req.credential,
      req.actor,
      req.params.id ?? '',
      (stored) => ({
        ...(method !== undefined ? { method } : {}),
        ...(fairValue !== undefined ? { fairValue } : {}),
        // The keys a suggestion left stay as stored, whatever the body sends for them.
        ...(inputs !== undefined ? { inputs: keepSuggestionKeys(stored, inputs) } : {}),
      }),
      req.headers,
      instance,
    );
    if (!outcome.ok) return outcome.response;
    return jsonResponse(200, outcome.row, { simulated: true, etag: outcome.row.rowVersion });
  },
});

/**
 * The one write of a Draft's correction (editDraft of valuations/workflow.service.ts): the edit
 * route above, and the applyToDraft of a valuation suggestion (docs/18 section 14), which puts
 * its value, its method and its keys on the Draft. `change` is handed the inputs the Draft
 * stores and answers what to write; the Draft keeps its period end. `headers` carry the
 * If-Match of a person's edit; a suggestion's own write names none.
 */
export function correctDraft(
  ctx: SimContext,
  credential: string,
  actor: SimActor,
  id: string,
  change: (stored: ValuationStoredInputs) => {
    method?: string;
    fairValue?: string;
    inputs?: ValuationStoredInputs;
  },
  headers: Headers | null,
  instance: string,
): Outcome {
  const refuse = (response: Response): Outcome => ({ ok: false, response });
  const sims = ensureValuations(ctx.state, ctx.recordings);
  const sim = sims.get(id);
  if (sim === undefined || !canOpen(ctx, credential, sim.row.investmentId))
    return refuse(notFound(instance));
  const stale = headers === null ? null : staleIfMatch(headers, sim.row.rowVersion, instance);
  if (stale !== null) return refuse(stale);
  const { row } = sim;
  if (row.state !== 'Draft')
    return refuse(
      problem(
        409,
        'workflow-transition',
        `valuation: edit is not allowed from ${row.state}; only a Draft can be edited`,
        { instance, simulated: true },
      ),
    );
  const patch = change(inputsOf(ctx, credential, sim));
  if (patch.method !== undefined && !knownCode(ctx, credential, patch.method))
    return refuse(badMethod(instance, UNKNOWN_METHOD));

  const next: ValuationRow = {
    ...row,
    ...(patch.method !== undefined ? { method: patch.method } : {}),
    ...(patch.fairValue !== undefined ? { fairValue: storedMoney(patch.fairValue) } : {}),
    rowVersion: row.rowVersion + 1,
  };
  sims.set(next.id, {
    ...sim,
    row: next,
    changed: true,
    inputs: patch.inputs ?? sim.inputs,
  });
  recordActivity(ctx, actor, {
    action: 'valuation.edit',
    entity: 'valuation',
    entityId: next.id,
    reason: null,
    from: row.state,
    to: next.state,
  });
  return { ok: true, row: answered(ctx, credential, next) };
}

/** What the machine's lock precondition is shown where this browser cannot take the hash; the 503 below answers instead. */
const HASH_UNAVAILABLE = 'unavailable';

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
    return refuse(notFound(instance));
  const stale = staleIfMatch(headers, sim.row.rowVersion, instance);
  if (stale !== null) return refuse(stale);

  const { row } = sim;
  const { command, reason } = body;
  const inputs = inputsOf(ctx, credential, sim);
  // The hash the lock would write, taken over what the version holds now and before the machine
  // is asked, so its precondition sees it; every other command carries the hash the row holds
  // (none before a lock), as the API does.
  const hashable = subtleCrypto() !== undefined;
  const lockHash =
    command !== 'lock'
      ? row.lockHash
      : hashable
        ? await lockHashOf({ ...row, inputs })
        : HASH_UNAVAILABLE;
  const result = attempt(valuationMachine, row.state, command, {
    actorId: actor.userId,
    actorRoles: actor.roles,
    ...(reason !== undefined ? { reason } : {}),
    record: {
      inputsComplete: row.method.length > 0 && row.fairValue.length > 0,
      validationPassed: isPositiveDecimal(row.fairValue),
      preparedBy: personFor(sim.preparedByIds, actor),
      lockHash,
      // Read for the two approvals that ask for it: no list bars nobody.
      ...(command === 'dealTeamApprove' || command === 'lock'
        ? { sourceReviewers: sourceReviewersOn(ctx, chainIdsOf(sims.values(), row)) }
        : {}),
    },
  });
  if (!result.ok) return refuse(workflowProblem(result, { instance, simulated: true }));

  const next: ValuationRow = { ...row, state: result.to, rowVersion: row.rowVersion + 1 };
  const updated: SimValuation = { ...sim, row: next, changed: true, approvals: [...sim.approvals] };
  const draftId = command === 'reopen' ? ctx.env.newId() : null;
  let step: ValuationApproval['step'];
  let decision: ValuationApproval['decision'];
  if (command === 'lock') {
    if (!hashable)
      return refuse(
        problem(
          503,
          'unavailable',
          'This browser offers SHA-256 only on secure (https) pages, so the lock hash cannot be computed here.',
          { instance, simulated: true },
        ),
      );
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
    next.preparedBy = actor.displayName;
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
    next.lockHash = lockHash;
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
  if (draftId === null) {
    // A Locked mark closes the Open suggestion of its quarter and of any earlier one, and is the
    // mark a later quarter's suggestion is now worked out from (docs/18 section 14).
    if (command === 'lock') refreshPosition(ctx, { credential, actor }, row.investmentId);
    return { ok: true, row: answered(ctx, credential, next) };
  }

  // docs/18 section 1: reopening creates a new Draft version with the same method, inputs and
  // value to edit, and the answer is that Draft, as the API answers it.
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
    inputs: { ...inputs },
  });
  recordActivity(ctx, actor, {
    action: 'valuation.create',
    entity: 'valuation',
    entityId: draft.id,
    reason: reason ?? null,
    from: null,
    to: draft.state,
  });
  // The mark is no longer Locked: a later quarter's Open suggestion rested on it.
  refreshPosition(ctx, { credential, actor }, row.investmentId);
  return { ok: true, row: answered(ctx, credential, draft) };
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
  what: 'body',
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
 * GET /api/v1/valuations/{id}: the version as the session holds it with its method inputs, the
 * recorded approval trail with this session's rows after it, the open change requests of its
 * position (M11) for the roles the change request routes serve and, once Locked, the exact text
 * its hash covers. A recorded version the build recorded no detail for is built from its list
 * row, which carries the people and the hash: the API holds no decision rows for a seeded
 * version either. 404 for a version the credential cannot open.
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
      return notFound(instance);
    const row = answered(ctx, req.credential, sim.row);
    const inputs = inputsOf(ctx, req.credential, sim);
    const detail: ValuationDetail = {
      ...row,
      inputs,
      approvals: [...(recorded?.approvals ?? []), ...sim.approvals],
      openChangeRequests: openChangeRequestsOf(
        ctx,
        req.credential,
        req.actor.roles,
        row.investmentId,
      ),
      lockText: row.state === 'Locked' ? valuationLockText({ ...row, inputs }) : null,
    };
    return jsonResponse(200, detail, { simulated: true, etag: row.rowVersion });
  },
});
