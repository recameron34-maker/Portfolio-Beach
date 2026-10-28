import { sql } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import type { Tx } from '@pb/db';

/*
 * A mechanical step inside a person's transaction, written as the system actor (the `service`
 * role of migration 0006) while the actor's identity stays the person's: pb.current_user_id()
 * still stamps updated_by with them and the audit event the caller writes names them.
 *
 * Used for the consequences of a command the workflow machine has already authorized for the
 * actor's role, on a row whose write policy names a narrower set of roles than the machine does:
 * an approver's approveTicket moves the notice to TicketApproved (docs/18 section 3) while
 * mon.capital_notice is written by operations and the service only (migration 0006), and a new
 * instruction version flags every notice of its counterparty, walled ones included, which the
 * proposer may not see (SEC-5.3). Running these as a separate system transaction
 * (DbService.runAsSystem) would split one business event across two commits; this keeps the
 * ticket, the notice and the audit event together, and restores the caller's roles before
 * anything else runs in the transaction.
 */
export async function systemStep<T>(
  tx: Tx,
  principal: Principal,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`select set_config('app.roles', 'service', true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`select set_config('app.roles', ${principal.roles.join(',')}, true)`);
  }
}
