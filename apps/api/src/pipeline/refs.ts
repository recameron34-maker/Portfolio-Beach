import { eq, inArray } from 'drizzle-orm';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { ProblemError } from '../common/problem.js';

/*
 * References a body names, checked before anything is written so a wrong id is a plain problem
 * naming the field, never a foreign-key error from Postgres. A document must be one the caller
 * can see in the hub (its own policy carries the wall, SEC-5.3). Reference data (users, taxonomy
 * codes, vehicles) is every signed-in user's. A client is not: a deal team member may name a
 * client they are not entitled to read (SEC-5.2), so the client reference is left to the foreign
 * key and its violation is answered as a validation problem by the writer (allocations.ts).
 */

/** A document in the hub the caller can see, else a 422 precondition naming the field. */
export async function requireVisibleDocument(tx: Tx, id: string, field: string): Promise<void> {
  const found = await tx
    .select({ id: schema.document.id })
    .from(schema.document)
    .where(eq(schema.document.id, id))
    .limit(1);
  if (found.length === 0)
    throw new ProblemError(
      422,
      'workflow-precondition',
      `${field}: the document is not in the hub or not visible to you`,
    );
}

/** An active app user, else a 400 validation problem on the field. */
export async function requireAppUser(tx: Tx, id: string, path: string): Promise<void> {
  const found = await tx
    .select({ id: schema.appUser.id })
    .from(schema.appUser)
    .where(eq(schema.appUser.id, id))
    .limit(1);
  if (found.length === 0)
    throw new ProblemError(400, 'validation', 'Invalid body', [{ path, message: 'Unknown user' }]);
}

/** Every code named exists in the taxonomy, else a 400 validation problem on the first field that does not. */
export async function requireTaxonomyCodes(
  tx: Tx,
  codes: readonly { code: string | undefined; path: string }[],
): Promise<void> {
  const wanted = [...new Set(codes.flatMap((c) => (c.code === undefined ? [] : [c.code])))];
  if (wanted.length === 0) return;
  const found = new Set(
    (
      await tx
        .select({ code: schema.taxonomyTerm.code })
        .from(schema.taxonomyTerm)
        .where(inArray(schema.taxonomyTerm.code, wanted))
    ).map((r) => r.code),
  );
  for (const c of codes)
    if (c.code !== undefined && !found.has(c.code))
      throw new ProblemError(400, 'validation', 'Invalid body', [
        { path: c.path, message: 'Unknown code' },
      ]);
}

/** Every vehicle id names a vehicle on record, else a 400 validation problem on the first that does not. */
export async function requireVehicles(
  tx: Tx,
  refs: readonly { vehicleId: string; path: string }[],
): Promise<void> {
  const vehicleIds = [...new Set(refs.map((r) => r.vehicleId))];
  if (vehicleIds.length === 0) return;
  const found = new Set(
    (
      await tx
        .select({ id: schema.vehicle.id })
        .from(schema.vehicle)
        .where(inArray(schema.vehicle.id, vehicleIds))
    ).map((r) => r.id),
  );
  for (const r of refs)
    if (!found.has(r.vehicleId))
      throw new ProblemError(400, 'validation', 'Invalid body', [
        { path: `${r.path}.vehicleId`, message: 'Unknown vehicle' },
      ]);
}
