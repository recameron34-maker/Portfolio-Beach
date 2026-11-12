import { sql } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import type { Tx } from '@pb/db';

/*
 * A mechanical step inside a person's transaction, written as the system actor (the `service`
 * role of migration 0006) while the actor's identity stays the person's: pb.current_user_id()
 * still stamps updated_by with them and the audit event the caller writes names them.
 *
 * How this differs from asSystemActor in @pb/db, and why both exist (CLAUDE.md rule 7):
 * asSystemActor switches the whole identity, app.user_id to the system user, app.roles to
 * `service` and app.client_ids to none, inside a savepoint, for the reads no person performs
 * (counting every staged row of a file, walled ones included). systemStep switches app.roles
 * alone and leaves app.user_id and app.client_ids as the person's, so a row written inside it is
 * stamped with the person who commanded the change, as rule 6 asks (who changed a number a client
 * could see), not with the system user. It carries no savepoint: the step is part of the person's
 * command and fails with it.
 *
 * Used for the consequences of a command the workflow machine has already authorized for the
 * actor's role, on a row whose write policy names a narrower set of roles than the machine does:
 * an approver's approveTicket moves the notice to TicketApproved (docs/18 section 3) while
 * mon.capital_notice is written by operations and the service only (migration 0006), and a new
 * instruction version flags every notice of its counterparty, walled ones included, which the
 * proposer may not see (SEC-5.3). Running these as a separate system transaction
 * (DbService.runAsSystem) would split one business event across two commits; this keeps the
 * ticket, the notice and the audit event together, and restores the roles that were in force
 * when the step began before anything else runs in the transaction.
 *
 * The step is re-entrant. It restores the roles it found in the transaction on entry, not the
 * principal's: a step that runs inside another one (the register's sweep calling a notice command
 * that takes steps of its own) finds `service` already in force, changes nothing and restores
 * nothing, so the enclosing step stays in force until it ends itself. The principal names the
 * person on whose command the step runs, for the reader of the call; the transaction's own
 * settings are the source of what is restored.
 */
export async function systemStep<T>(
  tx: Tx,
  _principal: Principal,
  fn: () => Promise<T>,
): Promise<T> {
  const entered = await tx.execute<{ roles: string | null }>(
    sql`select current_setting('app.roles', true) as roles`,
  );
  const prior = entered.rows[0]?.roles ?? '';
  // Already the system actor: an enclosing step, or the system actor's own transaction.
  if (prior === 'service') return fn();
  const setRoles = (roles: string): Promise<unknown> =>
    tx.execute(sql`select set_config('app.roles', ${roles}, true)`);
  await setRoles('service');
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // The step's own failure is what the caller must see: a restore that fails after it (the
    // transaction is already aborted by a refused statement) is not reported in its place.
    await setRoles(prior).catch(() => undefined);
    throw error;
  }
  await setRoles(prior);
  return result;
}
