import { asc, eq, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { D, ZERO } from '@pb/calc';
import type { AllocationRow, AllocationTieOut, AllocationsPutBody } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { isForeignKeyViolation, pgConstraint } from '../common/pg-errors.js';
import { ProblemError } from '../common/problem.js';
import type { AuditEntry } from '../db/db.service.js';
import { requireVehicles } from './refs.js';
import { NOT_VISIBLE, requireMoney } from './rows.js';

/*
 * Allocations by vehicle and client (docs/04 M5 and M22, migration 0013): requested against
 * received, anchored on the opportunity before close and carrying the investment as well once the
 * deal converts. The closing reads the same lines (the table has no closing column: the closing's
 * allocations are its opportunity's, or its position's for a closing that predates the pipeline).
 * The tie-out compares the lines with the closing commitment as decimals, never rounded (M22 AC:
 * the totals must equal the commitment or the closing cannot complete).
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

/** The M22 tie-out: the lines (received when known, else requested) against the commitment, compared exactly. */
export function tieOut(
  commitment: string,
  rows: readonly Pick<AllocationRow, 'requested' | 'received'>[],
): AllocationTieOut {
  const allocated = rows.reduce((sum, r) => sum.plus(r.received ?? r.requested), ZERO);
  const target = D(commitment);
  return {
    commitment: target.toFixed(2),
    allocated: allocated.toFixed(2),
    difference: allocated.minus(target).toFixed(2),
    tiedOut: allocated.comparedTo(target) === 0,
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
 * the lines then belong to the position and change through a change request (M11). Every id is
 * checked before the write; the audit event carries the totals before and after.
 */
export async function replaceAllocations(
  tx: Tx,
  audit: (entry: AuditEntry) => Promise<void>,
  opportunity: { id: string; stage: string; currency: string },
  body: AllocationsPutBody,
): Promise<void> {
  if (opportunity.stage === 'Closed')
    throw new ProblemError(
      422,
      'workflow-precondition',
      'allocations are fixed once the deal is closed (M22); raise a change request instead',
    );
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
