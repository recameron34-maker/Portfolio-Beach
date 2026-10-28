import {
  wireInstructionCommandBody,
  wireInstructionListQuery,
  wireInstructionProposeBody,
} from '@pb/contracts';
import type {
  BankDetails,
  Person,
  WireInstructionDetail,
  WireInstructionPage,
  WireInstructionRow,
} from '@pb/contracts';
import { attempt, wireInstructionMachine } from '@pb/workflows';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureWires } from '../state.js';
import type { SimActor, SimWireInstruction } from '../state.js';
import { sweepNoticesForNewVersion } from './capitalNotices.js';
import {
  SYSTEM_ACTOR,
  canOpen,
  defineSimRoute,
  pageNewestFirst,
  recordActivity,
  staleIfMatch,
} from './common.js';
import type { SimContext } from './common.js';

import type { CounterpartyKeys } from './register.js';

/**
 * The wire instruction register (docs/04 M16, docs/18 section 11, SEC-12.1 to SEC-12.4,
 * decision 0013) simulated the way apps/api/src/capital/wires.service.ts serves it. Bank details
 * enter in one way: a person types them into the propose body (never from a document, an email
 * or a model). The register has no wall (it is an operations control), its readers are the
 * contract's roles, and only operations and approvers read the details in clear: a recorded
 * version answers the reveal from the book (the recordings carry null for every credential), a
 * version proposed this session from what was typed. A new version is Proposed; it becomes
 * Verified through a callback by a person other than the proposer, supersedes the previous active
 * version and lifts the hold on the counterparty's tickets; a reject records the reason.
 */

const NOT_FOUND = 'Wire instruction not found';
/** The roles that read bank details in clear (SEC-12.2); everyone else sees the masked form. */
const CLEAR_READERS = ['operations', 'approver'];

const personOf = (actor: SimActor): Person => ({ id: actor.userId, name: actor.displayName });

/** "<bank name> ****<last four digits>": the one form every page shows (packages/db maskBankDetails). */
export const maskBankDetails = (d: BankDetails): string =>
  `${d.bankName} ****${d.accountNumber.slice(-4)}`;

/** The exact key a version is unique under: the investment, else the sponsor fund. */
const sameKey = (row: WireInstructionRow, keys: CounterpartyKeys): boolean =>
  keys.investmentId !== null
    ? row.counterparty.kind === 'investment' && row.counterparty.id === keys.investmentId
    : row.counterparty.kind === 'sponsor_fund' && row.counterparty.id === keys.sponsorFundId;

/** The row with the details in clear for a clear reader, null for anyone else or when nothing is known. */
function detailOf(
  ctx: SimContext,
  actor: SimActor,
  sim: SimWireInstruction,
): WireInstructionDetail {
  if (!actor.roles.some((r) => CLEAR_READERS.includes(r))) return { ...sim.row, bankDetails: null };
  const bankDetails =
    sim.bankDetails ??
    ctx.book?.wireInstructions.find((w) => w.id === sim.row.id)?.bankDetails ??
    null;
  return { ...sim.row, bankDetails };
}

/** GET /api/v1/wire-instructions: the register, newest proposal first, masked, filtered by counterparty and state. */
export const wireInstructionsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/wire-instructions',
  what: 'query',
  body: null,
  query: wireInstructionListQuery,
  handle: (req, ctx) => {
    const { investmentId, sponsorFundId, state } = req.query;
    const rows = [...ensureWires(ctx.state, ctx.recordings).values()]
      .map((w) => w.row)
      .filter(
        (r) =>
          (investmentId === undefined ||
            (r.counterparty.kind === 'investment' && r.counterparty.id === investmentId)) &&
          (sponsorFundId === undefined ||
            (r.counterparty.kind === 'sponsor_fund' && r.counterparty.id === sponsorFundId)) &&
          (state === undefined || r.state === state),
      );
    const page = pageNewestFirst(rows, (r) => ({ at: r.proposedAt, id: r.id }), req.query);
    if (page === null)
      return problem(400, 'validation', 'Invalid cursor', {
        instance: req.url.pathname,
        simulated: true,
      });
    const body: WireInstructionPage = { items: page.items, nextCursor: page.nextCursor };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/wire-instructions/{id}: one version; the details in clear for operations and approvers only. */
export const wireInstructionRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/wire-instructions/{id}',
  what: 'instruction',
  body: null,
  handle: (req, ctx) => {
    const sim = ensureWires(ctx.state, ctx.recordings).get(req.params.id ?? '');
    if (sim === undefined)
      return problem(404, 'not-found', NOT_FOUND, { instance: req.url.pathname, simulated: true });
    return jsonResponse(200, detailOf(ctx, req.actor, sim), {
      simulated: true,
      etag: sim.row.rowVersion,
    });
  },
});

/**
 * POST /api/v1/wire-instructions (operations): a new version for a counterparty, the highest
 * version plus one, Proposed, masked; then the SEC-12.4 sweep over the counterparty's notices.
 */
export const proposeWireInstructionRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/wire-instructions',
  what: 'instruction',
  body: wireInstructionProposeBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const keys: CounterpartyKeys = {
      investmentId: req.body.investmentId ?? null,
      sponsorFundId: req.body.sponsorFundId ?? null,
    };
    const wires = ensureWires(ctx.state, ctx.recordings);
    if (keys.investmentId !== null) {
      if (!canOpen(ctx, req.credential, keys.investmentId))
        return problem(404, 'not-found', 'Investment not found', { instance, simulated: true });
    } else if (keys.sponsorFundId !== null) {
      // A fund the book names, or one the register already holds a version for.
      const known =
        ctx.book?.sponsorFunds.some((f) => f.id === keys.sponsorFundId) === true ||
        [...wires.values()].some((w) => sameKey(w.row, keys));
      if (ctx.book !== null && !known)
        return problem(404, 'not-found', 'Sponsor fund not found', { instance, simulated: true });
    }
    let version = 0;
    for (const w of wires.values())
      if (sameKey(w.row, keys)) version = Math.max(version, w.row.version);
    version += 1;
    const row: WireInstructionRow = {
      id: ctx.env.newId(),
      counterparty:
        keys.investmentId !== null
          ? { kind: 'investment', id: keys.investmentId, name: req.body.counterpartyName }
          : {
              kind: 'sponsor_fund',
              id: keys.sponsorFundId ?? '',
              name: req.body.counterpartyName,
            },
      version,
      state: 'Proposed',
      bankDetailsMasked: maskBankDetails(req.body.bankDetails),
      proposedBy: personOf(req.actor),
      proposedAt: ctx.env.now(),
      sourceNote: req.body.sourceNote ?? null,
      callback: null,
      verifiedAt: null,
      rejectionReason: null,
      active: false,
      rowVersion: 1,
    };
    const sim: SimWireInstruction = {
      row,
      origin: 'created',
      changed: true,
      bankDetails: req.body.bankDetails,
    };
    wires.set(row.id, sim);
    recordActivity(ctx, req.actor, {
      action: 'wire_instruction.propose',
      entity: 'wire_instruction',
      entityId: row.id,
      reason: null,
      from: null,
      to: 'Proposed',
    });
    sweepNoticesForNewVersion(ctx, req.actor, keys);
    return jsonResponse(201, detailOf(ctx, req.actor, sim), { simulated: true, etag: 1 });
  },
});

/**
 * POST /api/v1/wire-instructions/{id}/commands (operations, approver): verify records the
 * confirming callback by the actor (never the proposer, SEC-12.2), makes the version active and
 * supersedes the previous active one as the system's step; reject records the reason and the
 * failed callback when one was made.
 */
export const wireInstructionCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/wire-instructions/{id}/commands',
  what: 'command',
  body: wireInstructionCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const wires = ensureWires(ctx.state, ctx.recordings);
    const sim = wires.get(req.params.id ?? '');
    if (sim === undefined)
      return problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });
    const stale = staleIfMatch(req.headers, sim.row.rowVersion, instance);
    if (stale !== null) return stale;
    const body = req.body;
    const { row } = sim;
    const result = attempt(wireInstructionMachine, row.state, body.command, {
      actorId: req.actor.userId,
      actorRoles: req.actor.roles,
      ...(body.command === 'reject' ? { reason: body.reason } : {}),
      record: {
        proposedBy: row.proposedBy.id,
        callbackConfirmed: body.command === 'verify' && body.callbackResult === 'confirmed',
      },
    });
    if (!result.ok) return workflowProblem(result, { instance, simulated: true });
    const now = ctx.env.now();
    const keys: CounterpartyKeys =
      row.counterparty.kind === 'investment'
        ? { investmentId: row.counterparty.id, sponsorFundId: null }
        : { investmentId: null, sponsorFundId: row.counterparty.id };

    if (body.command === 'verify') {
      // The previous active version of the same key moves to Superseded through the machine as
      // the system actor, before the new one becomes active: one active per counterparty.
      for (const old of wires.values()) {
        if (old.row.id === row.id || !old.row.active || !sameKey(old.row, keys)) continue;
        const superseded = attempt(wireInstructionMachine, old.row.state, 'supersede', {
          actorId: SYSTEM_ACTOR.actorId,
          actorRoles: [...SYSTEM_ACTOR.actorRoles],
          record: { newerVerifiedExists: true },
        });
        if (!superseded.ok) return workflowProblem(superseded, { instance, simulated: true });
        old.row = {
          ...old.row,
          state: superseded.to,
          active: false,
          rowVersion: old.row.rowVersion + 1,
        };
        old.changed = true;
        recordActivity(ctx, req.actor, {
          action: 'wire_instruction.supersede',
          entity: 'wire_instruction',
          entityId: old.row.id,
          reason: null,
          from: 'Verified',
          to: superseded.to,
        });
      }
      sim.row = {
        ...row,
        state: result.to,
        callback: {
          by: personOf(req.actor),
          at: now,
          numberSource: body.callbackNumberSource,
          result: body.callbackResult,
        },
        verifiedAt: now,
        active: true,
        rowVersion: row.rowVersion + 1,
      };
    } else {
      const loggedCallback = body.callbackResult !== undefined;
      if (loggedCallback && req.actor.userId === row.proposedBy.id)
        return problem(
          422,
          'workflow-precondition',
          'wire_instruction: the callback must be made by a person other than the proposer (SEC-12.2)',
          { instance, simulated: true },
        );
      sim.row = {
        ...row,
        state: result.to,
        rejectionReason: body.reason,
        callback:
          loggedCallback &&
          body.callbackNumberSource !== undefined &&
          body.callbackResult !== undefined
            ? {
                by: personOf(req.actor),
                at: now,
                numberSource: body.callbackNumberSource,
                result: body.callbackResult,
              }
            : row.callback,
        rowVersion: row.rowVersion + 1,
      };
    }
    sim.changed = true;
    recordActivity(ctx, req.actor, {
      action: `wire_instruction.${body.command}`,
      entity: 'wire_instruction',
      entityId: row.id,
      reason: body.command === 'reject' ? body.reason : null,
      from: row.state,
      to: result.to,
    });
    return jsonResponse(200, detailOf(ctx, req.actor, sim), {
      simulated: true,
      etag: sim.row.rowVersion,
    });
  },
});
