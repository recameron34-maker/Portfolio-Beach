import {
  addDays,
  alignedQuarterEnd,
  latestQuarterEndOnOrBefore,
  lockedNear,
  toDecimalString,
  valueChange,
} from '@pb/calc';
import definitions from '../../../../../config/definitions.json';
import {
  investmentDetail,
  valuationCommandBody,
  valuationCreateBody,
  valuationLockText,
} from '@pb/contracts';
import type { InvestmentDetail, ValuationRow } from '@pb/contracts';
import { attempt, valuationMachine } from '@pb/workflows';
import { closedByLock, isInFlight } from '../../pages/valuations/board.js';
import { sha256Hex, subtleCrypto } from '../hash.js';
import { overlayInvestmentDetail } from '../overlay.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureValuations, personFor } from '../state.js';
import type { SimActor, SimValuation } from '../state.js';
import { defineSimRoute, recordActivity, staleIfMatch } from './common.js';
import type { SimContext } from './common.js';

/**
 * Valuations through docs/18 section 1. Create is the "(new) to Draft" row: operations only (the
 * contract's role guard), the investment must be one the credential can open and must be active,
 * and a period that already has a Locked version needs a reopen first. Every other change goes
 * through attempt() on valuationMachine; the handler only sets the fields a command owns.
 */

const NOT_FOUND = 'Valuation not found';
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

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
  });
  return row;
}

export const createValuationRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/valuations',
  what: 'valuation',
  body: valuationCreateBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const detail = readDetail(ctx, req.credential, req.body.investmentId);
    if (detail === undefined)
      return problem(404, 'not-found', 'Investment not found', { instance, simulated: true });
    if (!detail.isActive)
      return problem(422, 'workflow-precondition', 'valuation: the investment is not active', {
        instance,
        simulated: true,
      });
    const versions = versionsOf(ctx, req.credential, detail.id);
    const { periodEnd } = req.body;
    if (periodEnd < detail.entryDate)
      return problem(
        422,
        'workflow-precondition',
        'valuation: the investment was not yet held at this period end',
        { instance, simulated: true },
      );
    // One version chain per quarter: a sponsor reporting a few days early or late is the same
    // quarter (alignedQuarterEnd), so its versions block a second chain at the quarter end.
    const sameQuarter = sameQuarterAs(versions, periodEnd);
    if (closedByLock(sameQuarter))
      return problem(
        409,
        'conflict',
        'valuation: a Locked version exists for this investment and quarter; reopen it to start a new version',
        { instance, simulated: true },
      );
    if (sameQuarter.some((v) => isInFlight(v.state)))
      return problem(
        409,
        'conflict',
        'valuation: a version for this investment and quarter is already in progress; continue that version',
        { instance, simulated: true },
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

export const valuationCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/valuations/{id}/commands',
  what: 'command',
  body: valuationCommandBody,
  idempotent: true,
  handle: async (req, ctx) => {
    const instance = req.url.pathname;
    const sims = ensureValuations(ctx.state, ctx.recordings);
    const sim = sims.get(req.params.id ?? '');
    // A record the credential cannot open is not found, never forbidden (no existence leak).
    const visible =
      sim !== undefined &&
      ctx.recordings.status(
        req.credential,
        `/api/v1/investments/${encodeURIComponent(sim.row.investmentId)}`,
      ) === 200;
    if (sim === undefined || !visible)
      return problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });
    const stale = staleIfMatch(req.headers, sim.row.rowVersion, instance);
    if (stale !== null) return stale;

    const { row } = sim;
    const { command, reason } = req.body;
    const result = attempt(valuationMachine, row.state, command, {
      actorId: req.actor.userId,
      actorRoles: req.actor.roles,
      ...(reason !== undefined ? { reason } : {}),
      record: {
        inputsComplete: row.method.length > 0 && row.fairValue.length > 0,
        validationPassed: isPositiveDecimal(row.fairValue),
        preparedBy: personFor(sim.preparedByIds, req.actor),
        lockHash: row.lockHash,
      },
    });
    if (!result.ok) return workflowProblem(result, { instance, simulated: true });

    const next: ValuationRow = { ...row, state: result.to, rowVersion: row.rowVersion + 1 };
    const updated: SimValuation = { ...sim, row: next, changed: true };
    // Everything that can refuse or fail comes before the first change to the state, so a
    // refused or failed command leaves no half-applied version behind.
    const draftId = command === 'reopen' ? ctx.env.newId() : null;
    if (command === 'lock') {
      // One Locked version per investment and quarter (valuationMachine's lock row).
      const others = sameQuarterAs(
        versionsOf(ctx, req.credential, row.investmentId),
        row.periodEnd,
      );
      if (
        others.some(
          (v) =>
            v.state === 'Locked' && !(v.periodEnd === row.periodEnd && v.version === row.version),
        )
      )
        return problem(
          409,
          'conflict',
          'valuation: another version is Locked for this investment and quarter; reopen it before locking this one',
          { instance, simulated: true },
        );
    }
    if (command === 'prepare') {
      if (subtleCrypto() === undefined)
        return problem(
          503,
          'unavailable',
          'This browser offers SHA-256 only on secure (https) pages, so the lock hash cannot be computed here.',
          { instance, simulated: true },
        );
      next.preparedBy = req.actor.displayName;
      next.lockHash = await lockHashOf(row);
      updated.preparedByIds = [req.actor.userId];
    } else if (command === 'dealTeamApprove') {
      next.dealTeamApprovedBy = req.actor.displayName;
      updated.dealTeamApprovedByIds = [req.actor.userId];
    } else if (command === 'lock') {
      next.approvedBy = req.actor.displayName;
      next.approvedAt = `${ctx.recordings.asOf}T12:00:00Z`;
      updated.approvedByIds = [req.actor.userId];
    } else if (command === 'reopen') {
      next.reopenReason = reason ?? null;
    }
    sims.set(next.id, updated);
    recordActivity(ctx, req.actor, {
      action: `valuation.${command}`,
      entity: 'valuation',
      entityId: next.id,
      reason: reason ?? null,
      from: row.state,
      to: next.state,
    });

    if (draftId !== null) {
      // docs/18 section 1: reopening creates a new Draft version with the same inputs to edit.
      const detail = readDetail(ctx, req.credential, row.investmentId);
      const versions = versionsOf(ctx, req.credential, row.investmentId);
      const draft: ValuationRow = {
        ...next,
        ...freshFields,
        id: draftId,
        version: nextVersion(versions, sims.values(), row.investmentId, row.periodEnd),
      };
      sims.set(draft.id, {
        row: draft,
        origin: 'created',
        changed: true,
        vehicleId: sim.vehicleId ?? detail?.vehicleId ?? null,
        preparedByIds: [],
        dealTeamApprovedByIds: [],
        approvedByIds: [],
      });
      recordActivity(ctx, req.actor, {
        action: 'valuation.create',
        entity: 'valuation',
        entityId: draft.id,
        reason: reason ?? null,
        from: null,
        to: draft.state,
      });
    }
    return jsonResponse(200, next, { simulated: true, etag: next.rowVersion });
  },
});
