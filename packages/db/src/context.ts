import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { isAppRole, SYSTEM_USER_ID } from './roles.js';
import type { AppRole } from './roles.js';

/** Who is acting in a transaction (docs/03 section 1, SEC-5.1). Set once per transaction, never per query. */
export interface UserContext {
  userId: string;
  roles: readonly AppRole[];
  /** Client ids the user is entitled to (SEC-5.2). */
  clientIds?: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`${label} is not a UUID`);
}

/**
 * Every role must be an application role by value, not only by type: the roles travel to Postgres
 * as one comma-joined setting that pb.current_roles() splits again, so a single string such as
 * "viewer,service" would otherwise grant the system actor's role to a sign-in (SEC-5.3).
 */
function assertAppRoles(roles: readonly string[]): void {
  for (const role of roles)
    if (!isAppRole(role)) throw new Error(`role "${role}" is not an application role`);
}

/**
 * Runs `fn` inside a transaction as the application role with the user's identity, roles and
 * entitlements set as transaction-local settings. Postgres row-level security reads them through
 * the pb.* helper functions. Nothing outside this call ever runs as pb_app.
 */
export async function withUserContext<T>(
  db: Db,
  ctx: UserContext,
  fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  assertUuid(ctx.userId, 'userId');
  assertAppRoles(ctx.roles);
  for (const c of ctx.clientIds ?? []) assertUuid(c, 'clientId');
  const roles = ctx.roles.join(',');
  const clients = (ctx.clientIds ?? []).join(',');
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role pb_app`);
    await tx.execute(sql`select set_config('app.user_id', ${ctx.userId}, true)`);
    await tx.execute(sql`select set_config('app.roles', ${roles}, true)`);
    await tx.execute(sql`select set_config('app.client_ids', ${clients}, true)`);
    return fn(tx);
  });
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Runs `fn` inside an open user transaction with the identity switched to the system actor (the
 * `service` role, migration 0008), then restores the caller's identity. This is the one way server
 * code acts as the system actor without leaving the caller's transaction, for the mechanical reads
 * no person performs: counting every staged row of a file, walled ones included, so the file reads
 * the same for everyone. What `fn` reads is never returned to the caller as rows; the policies on
 * what the caller reads still filter per reader (SEC-5.3). A separate transaction would not do:
 * it could not see the caller's uncommitted writes, and on the in-process database it would wait
 * on the caller's own transaction. The switch sits in a savepoint, so a statement that fails inside
 * `fn` leaves the transaction usable and the caller's identity in place.
 */
export async function asSystemActor<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const saved = await tx.execute<{
    user_id: string | null;
    roles: string | null;
    client_ids: string | null;
  }>(
    sql`select current_setting('app.user_id', true) as user_id, current_setting('app.roles', true) as roles, current_setting('app.client_ids', true) as client_ids`,
  );
  const prior = saved.rows[0];
  if (prior?.user_id === undefined || prior.user_id === null || prior.user_id === '')
    throw new Error('asSystemActor runs only inside a user transaction (withUserContext)');
  await tx.execute(sql`savepoint pb_system_actor`);
  try {
    await tx.execute(
      sql`select set_config('app.user_id', ${SYSTEM_USER_ID}, true), set_config('app.roles', 'service', true), set_config('app.client_ids', '', true)`,
    );
    const result = await fn(tx);
    await tx.execute(
      sql`select set_config('app.user_id', ${prior.user_id}, true), set_config('app.roles', ${prior.roles ?? ''}, true), set_config('app.client_ids', ${prior.client_ids ?? ''}, true)`,
    );
    await tx.execute(sql`release savepoint pb_system_actor`);
    return result;
  } catch (error) {
    // Rolling back to the savepoint discards the identity switch with everything `fn` wrote.
    await tx.execute(sql`rollback to savepoint pb_system_actor`).catch(() => undefined);
    await tx.execute(sql`release savepoint pb_system_actor`).catch(() => undefined);
    throw error;
  }
}
