import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
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
