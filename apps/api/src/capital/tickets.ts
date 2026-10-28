import { asc, desc, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Principal } from '@pb/adapters';
import { tradeTicketState } from '@pb/contracts';
import type { ReleaseBlocker, TradeTicketRow, TradeTicketState } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { keyOf, loadRegisters, pendingChange } from './register.js';
import type { CounterpartyKeys, RegisterView } from './register.js';
import { systemStep } from './systemStep.js';

/*
 * Trade tickets (docs/04 M16, SEC-12.3): one per capital notice, prepared by one person and
 * approved by another against the counterparty's active Verified instruction. The release check
 * on every row is computed from the same record capitalNoticeMachine judges approveTicket on
 * (capital.service.ts), so what the ticket shows is what the command will say. Rows read under
 * the caller's row-level security: a ticket follows its notice, so a walled notice's ticket is
 * simply absent (404 on the detail).
 */

const ticket = schema.tradeTicket;
const notice = schema.capitalNotice;
const wire = schema.wireInstruction;
const preparer = alias(schema.appUser, 'ticket_preparer');
const approver = alias(schema.appUser, 'ticket_approver');

/** The ticket list order: latest funding date first, then id (the cursor key). */
export const TICKET_ORDER: readonly SQL[] = [desc(ticket.fundingDate), asc(ticket.id)];

export interface TicketContext {
  /** The date the hold window is judged on: today for a command, the as-of date for a read. */
  asOf: string;
  holdDays: number;
  /**
   * Who is looking: the preparer sees same_person on their own ticket. The counterparty's register
   * is read as a system step on their behalf: the masked active instruction and the hold are facts
   * of the ticket its readers (TICKET_ROLES) see, while the register's own rows stay behind the
   * register's policy.
   */
  principal: Principal;
}

export interface TicketRowOptions {
  orderBy?: readonly SQL[];
  limit?: number;
}

/**
 * Why a ticket cannot be released by the caller now (SEC-12.3), in the contract's order. Only a
 * Drafted ticket awaits release; an Approved one awaits funding and reports the same checks so a
 * change after approval shows at once; a Funded or Withdrawn one has nothing to release.
 */
export function releaseOf(
  row: { state: TradeTicketState; preparedBy: string },
  register: RegisterView,
  ctx: TicketContext,
): { allowed: boolean; blockers: ReleaseBlocker[] } {
  if (row.state === 'Funded' || row.state === 'Withdrawn') return { allowed: false, blockers: [] };
  const blockers: ReleaseBlocker[] = [];
  if (register.versions.length === 0) blockers.push('no_instruction');
  else if (register.active === null) blockers.push('unverified_instruction');
  if (pendingChange(register, ctx.asOf, ctx.holdDays) !== null)
    blockers.push('changed_within_hold');
  if (row.preparedBy === ctx.principal.userId) blockers.push('same_person');
  return { allowed: blockers.length === 0, blockers };
}

/** Tickets as contract rows with their counterparty's register judged for release. */
export async function buildTicketRows(
  tx: Tx,
  ctx: TicketContext,
  where?: SQL,
  options: TicketRowOptions = {},
): Promise<TradeTicketRow[]> {
  const query = tx
    .select({
      id: ticket.id,
      capitalNoticeId: ticket.capitalNoticeId,
      amount: ticket.amount,
      currency: ticket.currency,
      fundingDate: ticket.fundingDate,
      preparedBy: ticket.preparedBy,
      preparerName: preparer.displayName,
      preparedAt: ticket.preparedAt,
      approvedBy: ticket.approvedBy,
      approverName: approver.displayName,
      approvedAt: ticket.approvedAt,
      state: ticket.state,
      rowVersion: ticket.rowVersion,
      wireId: wire.id,
      wireVersion: wire.version,
      wireState: wire.state,
      wireMasked: wire.bankDetailsMasked,
      noticeInvestmentId: notice.investmentId,
      investmentFundId: schema.investment.sponsorFundId,
      commitmentFundId: schema.commitment.sponsorFundId,
    })
    .from(ticket)
    .innerJoin(notice, eq(notice.id, ticket.capitalNoticeId))
    .innerJoin(preparer, eq(preparer.id, ticket.preparedBy))
    .leftJoin(approver, eq(approver.id, ticket.approvedBy))
    .leftJoin(wire, eq(wire.id, ticket.wireInstructionId))
    .leftJoin(schema.investment, eq(schema.investment.id, notice.investmentId))
    .leftJoin(schema.commitment, eq(schema.commitment.id, notice.commitmentId))
    .where(where)
    .orderBy(...(options.orderBy ?? TICKET_ORDER));
  const rows = await (options.limit === undefined ? query : query.limit(options.limit));
  if (rows.length === 0) return [];

  const keysOf = (r: (typeof rows)[number]): CounterpartyKeys => ({
    investmentId: r.noticeInvestmentId,
    sponsorFundId: r.investmentFundId ?? r.commitmentFundId,
  });
  const registers = await systemStep(tx, ctx.principal, () => loadRegisters(tx, rows.map(keysOf)));
  return rows.map((r) => {
    const state = tradeTicketState.parse(r.state);
    const register = registers.get(keyOf(keysOf(r))) ?? { versions: [], active: null };
    return {
      id: r.id,
      capitalNoticeId: r.capitalNoticeId,
      amount: r.amount,
      currency: r.currency,
      fundingDate: r.fundingDate,
      preparedBy: { id: r.preparedBy, name: r.preparerName },
      preparedAt: r.preparedAt.toISOString(),
      approvedBy:
        r.approvedBy !== null && r.approverName !== null
          ? { id: r.approvedBy, name: r.approverName }
          : null,
      approvedAt: r.approvedAt === null ? null : r.approvedAt.toISOString(),
      wireInstruction:
        r.wireId !== null && r.wireVersion !== null && r.wireState !== null && r.wireMasked !== null
          ? {
              id: r.wireId,
              version: r.wireVersion,
              state: r.wireState,
              bankDetailsMasked: r.wireMasked,
            }
          : null,
      state,
      release: releaseOf({ state, preparedBy: r.preparedBy }, register, ctx),
      rowVersion: r.rowVersion,
    };
  });
}
