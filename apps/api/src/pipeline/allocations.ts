import { asc, eq, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { D, ZERO } from '@pb/calc';
import type { AllocationRow, AllocationsPutBody } from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { ALLOCATIONS_FIXED_REFUSAL } from '@pb/workflows';
import type { AllocationTotals } from '@pb/workflows';
import { isForeignKeyViolation, pgConstraint } from '../common/pg-errors.js';
import { ProblemError } from '../common/problem.js';
import type { AuditEntry } from '../db/db.service.js';
import { requireVehicles } from './refs.js';
import { NOT_VISIBLE, closingConfirmed, requireMoney } from './rows.js';

/*
 * Allocations by vehicle and client (docs/04 M5 and M22, migration 0013): requested against
 * received, anchored on the opportunity before close and carrying the investment as well once the
 * deal converts. The closing reads the same lines (the table has no closing column: the closing's
 * allocations are its opportunity's, or its position's for a closing that predates the pipeline).
 * The tie-out compares the received amounts with the closing commitment as decimals, never rounded
 * (M22 AC: the totals must equal the commitment or the closing cannot complete). A requested amount
 * is what was asked for, not what the deal got: it never stands in for a received amount (rule 10),
 * so a line with no received amount keeps the tie-out false. Once operations confirmed the closing
 * the lines are what was confirmed and stay so until the closing is reopened (docs/18 section 12).
 * The tie-out itself is a pure rule the web preview follows too, so it lives in @pb/workflows
 * (controls-closing.ts) and is read from here.
 *
 * Who reads a line (migration 0017, review finding D1-06): a line follows its deal, and a client
 * line is also under the client rule, so a reader may be shown fewer lines than the deal has.
 * The lines a caller gets are the ones row-level security leaves (loadAllocationRows). The
 * figures about the deal, the totals and the tie-out built from them, are never computed from
 * those: they come from loadAllocationTotals, which reads every line as the system actor and
 * returns the counts and the sums alone, so they read the same for every reader.
 */

const alloc = schema.allocation;

/** The lines of an opportunity, or of the position it is or became; nothing when neither is known. */
export function allocationsOf(opportunityId: string | null, investmentId: string | null): SQL {
  const parts: SQL[] = [];
  if (opportunityId !== null) parts.push(eq(alloc.opportunityId, opportunityId));
  if (investmentId !== null) parts.push(eq(alloc.investmentId, investmentId));
  return or(...parts) ?? sql`false`;
}

/** The lines with their vehicle and client named, vehicle first; a client the caller may not read shows as NOT_VISIBLE. */
export async function loadAllocationRows(tx: Tx, where: SQL): Promise<AllocationRow[]> {
  const rows = await tx
    .select({
      id: alloc.id,
      vehicleId: alloc.vehicleId,
      vehicleName: schema.vehicle.name,
      clientId: alloc.clientId,
      clientName: schema.client.name,
      requested: alloc.requested,
      received: alloc.received,
    })
    .from(alloc)
    .innerJoin(schema.vehicle, eq(schema.vehicle.id, alloc.vehicleId))
    .leftJoin(schema.client, eq(schema.client.id, alloc.clientId))
    .where(where)
    .orderBy(asc(schema.vehicle.name), asc(alloc.clientId), asc(alloc.id));
  return rows.map((r) => ({
    id: r.id,
    vehicle: { id: r.vehicleId, name: r.vehicleName },
    client: r.clientId === null ? null : { id: r.clientId, name: r.clientName ?? NOT_VISIBLE },
    requested: r.requested,
    received: r.received,
  }));
}

/**
 * The totals of every line of a deal, whoever asks: how many lines, how many with no received
 * amount, the requested and the received sums. Read as the system actor, the way
 * nextInvestmentNumber in convert.ts reads the highest number on record: the service role reads
 * every line (migration 0017), and nothing but these figures is returned, never a line, a client
 * or an amount of one. Row-level security stays forced on the table and no definer function is
 * involved. Call it only for a deal the caller was already shown under their own row-level
 * security (its opportunity or its closing was read first), so the figures of a walled deal reach
 * nobody outside the wall.
 */
export async function loadAllocationTotals(tx: Tx, where: SQL): Promise<AllocationTotals> {
  const row = await asSystemActor(tx, async (sys) => {
    const rows = await sys
      .select({
        lines: sql<number>`count(*)::int`,
        missingReceived: sql<number>`(count(*) filter (where ${alloc.received} is null))::int`,
        requested: sql<string>`coalesce(sum(${alloc.requested}), 0)::text`,
        received: sql<string>`coalesce(sum(${alloc.received}), 0)::text`,
      })
      .from(alloc)
      .where(where);
    return rows[0];
  });
  return {
    lines: row?.lines ?? 0,
    requested: D(row?.requested ?? '0').toFixed(2),
    received: D(row?.received ?? '0').toFixed(2),
    missingReceived: row?.missingReceived ?? 0,
  };
}

/** What the audit event carries about a set of lines: counts and totals, never a client name. */
function totalsOf(
  rows: readonly { requested: string; received: string | null }[],
): Record<string, unknown> {
  const requested = rows.reduce((sum, r) => sum.plus(r.requested), ZERO);
  const known = rows.filter((r) => r.received !== null);
  const received = known.reduce((sum, r) => sum.plus(r.received ?? '0'), ZERO);
  return {
    lines: rows.length,
    requested: requested.toFixed(2),
    received: known.length === 0 ? null : received.toFixed(2),
  };
}

/**
 * Replaces the opportunity's lines with the body's (docs/04 M22). Refused once the deal is Closed:
 * the lines then belong to the position and change through a change request (M11). Refused while
 * its closing is confirmed: operations confirmed the tie-out of these lines, so they change only
 * after the closing returns to Open (a close date change or a reopen, docs/18 section 12). The
 * caller holds the opportunity's row lock, which the confirmation takes too, so the check and the
 * confirmation cannot pass each other. Every id is checked before the write; the audit event
 * carries the totals before and after.
 */
export async function replaceAllocations(
  tx: Tx,
  audit: (entry: AuditEntry) => Promise<void>,
  opportunity: { id: string; stage: string; currency: string },
  body: AllocationsPutBody,
): Promise<void> {
  if (opportunity.stage === 'Closed')
    throw new ProblemError(422, 'workflow-precondition', ALLOCATIONS_FIXED_REFUSAL);
  const closing = (
    await tx
      .select({ state: schema.closing.state })
      .from(schema.closing)
      .where(eq(schema.closing.opportunityId, opportunity.id))
      .limit(1)
  )[0];
  if (closing?.state === 'OpsConfirmed') throw closingConfirmed();
  const seen = new Set<string>();
  const lines = body.allocations.map((line, i) => {
    const clientId = line.clientId ?? null;
    const key = `${line.vehicleId}|${clientId ?? ''}`;
    if (seen.has(key))
      throw new ProblemError(400, 'validation', 'Invalid body', [
        { path: `allocations.${i}`, message: 'A vehicle and client may appear once' },
      ]);
    seen.add(key);
    requireMoney(line.requested, `allocations.${i}.requested`);
    requireMoney(line.received, `allocations.${i}.received`);
    return {
      vehicleId: line.vehicleId,
      clientId,
      requested: line.requested,
      received: line.received ?? null,
      path: `allocations.${i}`,
    };
  });
  await requireVehicles(tx, lines);

  const before = await tx
    .select({ requested: alloc.requested, received: alloc.received })
    .from(alloc)
    .where(eq(alloc.opportunityId, opportunity.id));
  await tx.delete(alloc).where(eq(alloc.opportunityId, opportunity.id));
  if (lines.length > 0) {
    try {
      await tx.insert(alloc).values(
        lines.map((l) => ({
          opportunityId: opportunity.id,
          investmentId: null,
          vehicleId: l.vehicleId,
          clientId: l.clientId,
          requested: l.requested,
          received: l.received,
          currency: opportunity.currency,
        })),
      );
    } catch (error) {
      // The client reference is the one the caller may not be able to read (SEC-5.2), so the
      // foreign key checks it; the vehicles were checked above. The transaction rolls back.
      if (!isForeignKeyViolation(error)) throw error;
      const constraint = pgConstraint(error) ?? '';
      const first = lines.find((l) =>
        constraint.includes('vehicle') ? true : l.clientId !== null,
      );
      throw new ProblemError(400, 'validation', 'Invalid body', [
        constraint.includes('vehicle')
          ? { path: `${first?.path ?? 'allocations'}.vehicleId`, message: 'Unknown vehicle' }
          : { path: `${first?.path ?? 'allocations'}.clientId`, message: 'Unknown client' },
      ]);
    }
  }
  await audit({
    action: 'opportunity.allocations.replace',
    entity: 'deal.opportunity',
    entityId: opportunity.id,
    details: { before: totalsOf(before), after: totalsOf(lines) },
  });
}
