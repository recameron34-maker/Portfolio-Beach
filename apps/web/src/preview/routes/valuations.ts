import { investmentDetail, valuationCommandBody, valuationCreateBody } from '@pb/contracts';
import type { InvestmentDetail, ValuationRow } from '@pb/contracts';
import { attempt, valuationMachine } from '@pb/workflows';
import { overlayInvestmentDetail } from '../overlay.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureValuations, personFor } from '../state.js';
import type { SimValuation } from '../state.js';
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

function readDetail(
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

/** The last calendar quarter end before the quarter that holds the date. */
export function previousQuarterEnd(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const quarter = Math.floor((month - 1) / 3);
  if (quarter === 0) return `${year - 1}-12-31`;
  const endMonth = quarter * 3;
  return `${year}-${String(endMonth).padStart(2, '0')}-${endMonth === 3 ? '31' : '30'}`;
}

/** Fair value strictly above zero, read from the decimal string without floating point. */
export function isPositiveDecimal(value: string): boolean {
  return POSITIVE_DECIMAL.test(value) && /[1-9]/.test(value);
}

/** JSON with sorted keys and no spaces, so the same inputs always hash the same. */
export function canonicalJson(value: Readonly<Record<string, string | number>>): string {
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`)
    .join(',')}}`;
}

function subtleCrypto(): SubtleCrypto | undefined {
  // Browsers expose SubtleCrypto only in secure contexts (https or localhost).
  return (globalThis.crypto as Crypto | undefined)?.subtle;
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = subtleCrypto();
  if (subtle === undefined) throw new Error('SHA-256 is not available in this context');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The lock hash covers the inputs and the value (docs/18 section 1). */
export function lockHashOf(row: ValuationRow): Promise<string> {
  const { investmentId, periodEnd, version, method, fairValue } = row;
  return sha256Hex(canonicalJson({ investmentId, periodEnd, version, method, fairValue }));
}

type VersionEntry = InvestmentDetail['valuations'][number];

/** A Locked version with no Reopened version after it: the period is closed to new drafts. */
function closedByLock(versions: readonly VersionEntry[]): boolean {
  return versions.some(
    (locked) =>
      locked.state === 'Locked' &&
      !versions.some((v) => v.version > locked.version && v.state === 'Reopened'),
  );
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

export const createValuationRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/valuations',
  what: 'valuation',
  body: valuationCreateBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const sims = ensureValuations(ctx.state, ctx.recordings);
    const detail = readDetail(ctx, req.credential, req.body.investmentId);
    if (detail === undefined)
      return problem(404, 'not-found', 'Investment not found', { instance, simulated: true });
    if (!detail.isActive)
      return problem(422, 'workflow-precondition', 'valuation: the investment is not active', {
        instance,
        simulated: true,
      });
    const versions = overlayInvestmentDetail(detail, sims.values()).valuations;
    const { periodEnd, method, fairValue } = req.body;
    if (closedByLock(versions.filter((v) => v.periodEnd === periodEnd)))
      return problem(
        409,
        'conflict',
        'valuation: a Locked version exists for this investment and period; reopen it to start a new version',
        { instance, simulated: true },
      );
    const priorPeriod = previousQuarterEnd(periodEnd);
    const prior = versions
      .filter((v) => v.periodEnd === priorPeriod && v.state === 'Locked')
      .sort((a, b) => b.version - a.version)[0];
    const row: ValuationRow = {
      ...freshFields,
      id: ctx.env.newId(),
      investmentId: detail.id,
      investmentNumber: detail.investmentNumber,
      companyName: detail.companyName,
      vehicleName: detail.vehicleName,
      dealType: detail.dealType,
      periodEnd,
      version: nextVersion(versions, sims.values(), detail.id, periodEnd),
      method,
      fairValue,
      priorFairValue: prior?.fairValue ?? null,
      // The change ratio belongs to @pb/calc (docs/08), which the preview chunk does not bundle;
      // it stays null (shown as the missing placeholder) rather than a float approximation.
      changePct: null,
    };
    sims.set(row.id, {
      row,
      origin: 'created',
      changed: true,
      vehicleId: detail.vehicleId,
      preparedByIds: [],
      dealTeamApprovedByIds: [],
      approvedByIds: [],
    });
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

    if (command === 'reopen') {
      // docs/18 section 1: reopening creates a new Draft version with the same inputs to edit.
      const detail = readDetail(ctx, req.credential, row.investmentId);
      const versions =
        detail === undefined ? [] : overlayInvestmentDetail(detail, sims.values()).valuations;
      const draft: ValuationRow = {
        ...next,
        ...freshFields,
        id: ctx.env.newId(),
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
