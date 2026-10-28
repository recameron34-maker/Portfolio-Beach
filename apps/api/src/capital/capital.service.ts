import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, lt, lte, ne, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { D, addDays } from '@pb/calc';
import { capitalNoticeState } from '@pb/contracts';
import type {
  CapitalNoticeCommandBody,
  CapitalNoticeControlDetail,
  CapitalNoticePage,
  CapitalNoticeState,
  TradeTicketPage,
  TradeTicketRow,
  TradeTicketState,
  capitalNoticeListQuery,
  tradeTicketListQuery,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { attempt, capitalNoticeMachine } from '@pb/workflows';
import type { z } from 'zod';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { fmtDate } from '../common/dates.js';
import { configInteger, configIntegerList, configStringList } from '../common/definitions.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';
import { readStoredDocument, storedDocumentProblem } from '../documents/read.js';
import { documentSettingsOf } from '../documents/settings.js';
import { str } from '../portfolio/metrics.js';
import { noticeAlerts, urgencyLanguageIn } from './alerts.js';
import { requireFreshRow } from './ifMatch.js';
import { DUE_ORDER, REGISTER_ORDER, buildNoticeRows } from './notices.js';
import {
  EMPTY_REGISTER,
  counterpartyOfNotice,
  isoDateOf,
  keyOf,
  loadRegisters,
  pendingChange,
} from './register.js';
import type { RegisterView } from './register.js';
import { systemStep } from './systemStep.js';
import { TICKET_ORDER, buildTicketRows } from './tickets.js';

/*
 * Capital activity (docs/04 M16, docs/18 section 3, SEC-12, decision 0013): the notice register
 * and detail, the notice commands and the trade tickets.
 *
 * A command moves the notice through capitalNoticeMachine with the record the machine reads
 * built from the database in the same transaction: whether the notice document is indexed, that
 * bank fields are never extracted (SEC-12.1), whether a ticket exists and who prepared it, whether
 * the counterparty's active instruction is Verified, whether a change is pending within the hold
 * window and whether the ticket is Approved. The notice is locked for the transaction, the write
 * guards on the state and row version it read (409 when another command got there first), an
 * If-Match row version answers 412 when stale, and every command writes one audit event with the
 * state, the ticket and the flags before and after (SEC-11.1).
 *
 * The hold window rule (SEC-12.3, register.ts pendingChange): a version of the counterparty other
 * than the active Verified one, proposed within capitalActivity.wireChangeHoldDays before today
 * and not Rejected, holds the ticket. A Proposed version waiting for its callback holds it; once
 * that version is verified by a second person it is the active one and the hold lifts, the
 * callback being the second approval the control asks for. The detail's wireChangeHold field
 * derives from the same rule against the as-of date.
 *
 * Writes to the notice by an actor whose role the notice's write policy does not admit (an
 * approver approving a ticket) run as the system actor inside the same transaction (systemStep),
 * after the machine authorized the command for that role. Bank details never pass through here:
 * the ticket panel carries the masked form only.
 */

export type CapitalNoticeListOptions = Omit<z.infer<typeof capitalNoticeListQuery>, 'asOf'> & {
  asOf: string;
};
export type TradeTicketListOptions = z.infer<typeof tradeTicketListQuery>;

/** Capital activity settings from config/definitions.json (docs/04 M16); only the keys this service reads. */
interface Definitions {
  capitalActivity?: {
    alertDaysBeforeDue?: unknown;
    wireChangeHoldDays?: unknown;
    urgencyPhrases?: unknown;
    dueSoonBusinessDays?: unknown;
  };
  [key: string]: unknown;
}

const notice = schema.capitalNotice;
const ticket = schema.tradeTicket;
const flow = schema.cashFlow;

const NOT_FOUND = 'Capital notice not found';
const TICKET_NOT_FOUND = 'Trade ticket not found';
const ENTITY = 'mon.capital_notice';
/** The record status a reconciliation writes: what the register, the reports and unfunded read. */
const APPROVED = 'record_status.approved';
/** The roles mon.capital_notice is written by (migration 0006); any other actor's state step runs as the system actor. */
const NOTICE_WRITERS = ['operations', 'service'];

/** The cursor is "dueDate|issueDate|id" of the last row, the register's sort key. */
const CURSOR =
  /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The ticket cursor is "fundingDate|id" of the last row. */
const TICKET_CURSOR =
  /^(\d{4}-\d{2}-\d{2})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The cash flow a notice type reconciles into (docs/03, docs/08 section 2), signed from the
 * investor's side: money out is negative. An equalization notice credits the equalizing LPs,
 * booked as a recallable distribution as the synthetic sequence shapes it (docs/14); the call to
 * the new LP it follows is a capital call notice of its own.
 */
const FLOW_OF_NOTICE: Record<string, { flowType: string; sign: 1 | -1 }> = {
  'notice_type.capital_call': { flowType: 'flow_type.contribution', sign: -1 },
  'notice_type.distribution': { flowType: 'flow_type.distribution', sign: 1 },
  'notice_type.equalization': { flowType: 'flow_type.recallable', sign: 1 },
  'notice_type.interest_payment': { flowType: 'flow_type.interest', sign: 1 },
  'notice_type.principal_repayment': { flowType: 'flow_type.principal', sign: 1 },
  'notice_type.fee_notice': { flowType: 'flow_type.fee', sign: -1 },
};

/** The notice as locked for a command. */
interface LockedNotice {
  id: string;
  state: string;
  noticeType: string;
  investmentId: string | null;
  commitmentId: string | null;
  amount: string;
  currency: string;
  dueDate: string;
  sourceDocumentId: string | null;
  urgencyFlag: boolean;
  wireChangeFlag: boolean;
  fundedAt: Date | null;
  rowVersion: number;
}

/** The ticket as locked with its notice; what the audit event carries before and after. */
interface LockedTicket {
  id: string;
  state: TradeTicketState;
  amount: string;
  fundingDate: string;
  preparedBy: string;
  approvedBy: string | null;
  wireInstructionId: string | null;
  rowVersion: number;
}

const conflict = (what: string): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    `${what}: another command changed the record first; open it again`,
  );

@Injectable()
export class CapitalService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  /**
   * The capital notice register (M16), latest due date first, with the attention list: every
   * visible notice that is not Reconciled or falls due within the alert window after the as-of
   * date (the largest of capitalActivity.alertDaysBeforeDue), whatever the page and filters.
   * Walls and client entitlements apply through row-level security (SEC-5.1, SEC-5.2, SEC-5.3).
   */
  async list(
    principal: Principal,
    requestId: string,
    opts: CapitalNoticeListOptions,
  ): Promise<CapitalNoticePage> {
    const alertDays = Math.max(
      ...configIntegerList(
        this.definitions.capitalActivity?.alertDaysBeforeDue,
        'capitalActivity.alertDaysBeforeDue',
      ),
    );
    const conditions: (SQL | undefined)[] = [];
    if (opts.cursor !== undefined) {
      const [dueDate = '', issueDate = '', id = ''] = decodeCursor(opts.cursor, CURSOR, [1, 2]);
      // The sort is due date descending, issue date descending, id ascending.
      conditions.push(
        or(
          lt(notice.dueDate, dueDate),
          and(eq(notice.dueDate, dueDate), lt(notice.issueDate, issueDate)),
          and(eq(notice.dueDate, dueDate), eq(notice.issueDate, issueDate), gt(notice.id, id)),
        ),
      );
    }
    if (opts.state !== undefined) conditions.push(eq(notice.state, opts.state));
    if (opts.vehicleId !== undefined) conditions.push(eq(notice.vehicleId, opts.vehicleId));
    if (opts.investmentId !== undefined)
      conditions.push(eq(notice.investmentId, opts.investmentId));
    if (opts.noticeType !== undefined) conditions.push(eq(notice.noticeType, opts.noticeType));
    if (opts.dueFrom !== undefined) conditions.push(gte(notice.dueDate, opts.dueFrom));
    if (opts.dueTo !== undefined) conditions.push(lte(notice.dueDate, opts.dueTo));

    return this.db.run(principal, requestId, async (tx) => {
      const rows = await buildNoticeRows(tx, opts.asOf, and(...conditions), {
        orderBy: REGISTER_ORDER,
        limit: opts.limit + 1,
      });
      const page = rows.slice(0, opts.limit);
      const attention = await buildNoticeRows(
        tx,
        opts.asOf,
        or(
          ne(notice.state, 'Reconciled'),
          and(gte(notice.dueDate, opts.asOf), lte(notice.dueDate, addDays(opts.asOf, alertDays))),
        ),
        { orderBy: DUE_ORDER },
      );
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.dueDate, last.issueDate, last.id])
            : null,
        asOf: opts.asOf,
        attention,
        alertDaysBeforeDue: alertDays,
      };
    });
  }

  /**
   * One notice with the cash flows created from it, the wire change hold (SEC-12.3), plain notes,
   * the ticket panel, the counterparty's active instruction (masked) and the SEC-12.4 alerts.
   * Never carries bank details. 404 when the notice does not exist or the caller cannot see it;
   * a successful open is audited (SEC-11.1).
   */
  async detail(
    principal: Principal,
    requestId: string,
    id: string,
    asOf: string,
  ): Promise<CapitalNoticeControlDetail> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const detail = await this.controlDetail(tx, id, asOf, principal);
      if (detail === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      await audit({ action: 'capital_notice.read', entity: ENTITY, entityId: id });
      return detail;
    });
  }

  /**
   * A command on a notice (docs/18 section 3): review, draftTicket, approveTicket, wireChanged,
   * confirmFunding, reconcile by a person; extract by the system actor. Answers the notice as it
   * now stands, judged on today's date.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: CapitalNoticeCommandBody,
    ifMatch?: number,
  ): Promise<CapitalNoticeControlDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      await this.commandWithin(tx, audit, principal, id, body, ifMatch);
      const detail = await this.controlDetail(tx, id, this.adapters.clock.today(), principal);
      if (detail === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return detail;
    });
  }

  /**
   * The command itself, inside a transaction the caller owns: the wire register runs wireChanged
   * through this on every notice with an approved ticket when a new instruction version is
   * proposed (wires.service.ts). Returns the states before and after.
   */
  async commandWithin(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    id: string,
    body: CapitalNoticeCommandBody,
    ifMatch?: number,
  ): Promise<{ from: CapitalNoticeState; to: CapitalNoticeState }> {
    const today = this.adapters.clock.today();
    const now = new Date(this.adapters.clock.now());
    const holdDays = this.holdDays();
    // Visibility is the caller's own (404 past a wall); the lock is taken as the system step for
    // an actor the notice's write policy does not admit, since a row lock under row-level
    // security also passes the UPDATE policy, and an approver's approveTicket would otherwise
    // find no row to lock.
    const seen = await tx.select({ id: notice.id }).from(notice).where(eq(notice.id, id));
    if (seen.length === 0) throw new ProblemError(404, 'not-found', NOT_FOUND);
    const isWriter = principal.roles.some((r) => NOTICE_WRITERS.includes(r));
    const lock = (): Promise<LockedNotice[]> =>
      tx
        .select({
          id: notice.id,
          state: notice.state,
          noticeType: notice.noticeType,
          investmentId: notice.investmentId,
          commitmentId: notice.commitmentId,
          amount: notice.amount,
          currency: notice.currency,
          dueDate: notice.dueDate,
          sourceDocumentId: notice.sourceDocumentId,
          urgencyFlag: notice.urgencyFlag,
          wireChangeFlag: notice.wireChangeFlag,
          fundedAt: notice.fundedAt,
          rowVersion: notice.rowVersion,
        })
        .from(notice)
        .where(eq(notice.id, id))
        .for('update');
    const locked = (isWriter ? await lock() : await systemStep(tx, principal, lock))[0];
    if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
    requireFreshRow(ifMatch, locked.rowVersion, 'capital_notice');
    const from = this.stateOf(locked.state);

    const keys = await counterpartyOfNotice(tx, locked);
    const register =
      (await systemStep(tx, principal, () => loadRegisters(tx, [keys]))).get(keyOf(keys)) ??
      EMPTY_REGISTER;
    const ticketBefore = await this.lockTicket(tx, id);
    const documentIndexed =
      locked.sourceDocumentId !== null &&
      (
        await tx
          .select({ id: schema.document.id })
          .from(schema.document)
          .where(eq(schema.document.id, locked.sourceDocumentId))
      ).length > 0;
    const live = ticketBefore !== null && ticketBefore.state !== 'Withdrawn';
    const record = {
      documentIndexed,
      bankFieldsExtracted: false,
      ticketExists: live,
      ticketPreparedBy: live ? ticketBefore.preparedBy : undefined,
      wireVerified: register.active !== null,
      wireChangedWithinHold: pendingChange(register, today, holdDays) !== null,
      ticketApproved: live && ticketBefore.state === 'Approved',
    };
    const result = attempt(capitalNoticeMachine, from, body.command, {
      actorId: principal.userId,
      actorRoles: principal.roles,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      record,
    });
    if (!result.ok) throw workflowProblem(result);
    if (body.command === 'wireChanged' && body.reason === undefined)
      throw new ProblemError(
        422,
        'workflow-precondition',
        'capital_notice: a reason is required to record a wire change',
      );

    const patch: Partial<typeof notice.$inferInsert> = { state: result.to };
    const details: Record<string, unknown> = { state: { before: from, after: result.to } };
    let ticketAfter: LockedTicket | null = ticketBefore;
    switch (body.command) {
      case 'extract': {
        const urgencyFlag = await this.urgencyIn(tx, locked.sourceDocumentId);
        patch.urgencyFlag = urgencyFlag;
        details.urgencyFlag = { before: locked.urgencyFlag, after: urgencyFlag };
        break;
      }
      case 'review':
        break;
      case 'draftTicket': {
        const values = {
          amount: body.amount ?? locked.amount,
          currency: locked.currency,
          fundingDate: body.fundingDate ?? locked.dueDate,
          preparedBy: principal.userId,
          preparedAt: now,
          approvedBy: null,
          approvedAt: null,
          wireInstructionId: null,
          state: 'Drafted' as const,
          withdrawnReason: null,
        };
        if (ticketBefore === null) {
          const [inserted] = await tx
            .insert(ticket)
            .values({ capitalNoticeId: id, ...values })
            .returning();
          if (inserted === undefined) throw conflict('trade_ticket');
          ticketAfter = await this.lockTicket(tx, id);
        } else {
          // A notice already carrying a ticket is re-drafted, never given a second one.
          ticketAfter = await this.writeTicket(tx, ticketBefore, values);
        }
        break;
      }
      case 'approveTicket': {
        if (ticketBefore === null || register.active === null) throw conflict('trade_ticket');
        ticketAfter = await this.writeTicket(tx, ticketBefore, {
          approvedBy: principal.userId,
          approvedAt: now,
          wireInstructionId: register.active.id,
          state: 'Approved',
        });
        break;
      }
      case 'wireChanged': {
        if (ticketBefore !== null)
          ticketAfter = await this.writeTicket(tx, ticketBefore, {
            approvedBy: null,
            approvedAt: null,
            wireInstructionId: null,
            state: 'Drafted',
          });
        patch.wireChangeFlag = true;
        details.wireChangeFlag = { before: locked.wireChangeFlag, after: true };
        break;
      }
      case 'confirmFunding': {
        if (ticketBefore === null) throw conflict('trade_ticket');
        ticketAfter = await this.writeTicket(tx, ticketBefore, { state: 'Funded' });
        patch.fundedAt = now;
        patch.fundedBy = principal.userId;
        details.funded = { at: now.toISOString(), by: principal.userId };
        break;
      }
      case 'reconcile': {
        details.cashFlow = await this.writeCashFlow(
          tx,
          principal,
          locked,
          ticketBefore,
          now,
          body.reason,
        );
        break;
      }
    }

    const write = async (): Promise<void> => {
      const updated = await tx
        .update(notice)
        .set(patch)
        .where(
          and(eq(notice.id, id), eq(notice.state, from), eq(notice.rowVersion, locked.rowVersion)),
        )
        .returning();
      if (updated[0] === undefined) throw conflict('capital_notice');
    };
    if (isWriter) await write();
    else await systemStep(tx, principal, write);

    details.ticket = {
      before: ticketBefore === null ? null : this.ticketImage(ticketBefore),
      after: ticketAfter === null ? null : this.ticketImage(ticketAfter),
    };
    await audit({
      action: `capital_notice.${body.command}`,
      entity: ENTITY,
      entityId: id,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      details,
    });
    return { from, to: result.to };
  }

  /** Tickets the caller can see, latest funding date first, with their release blockers (SEC-12.3). */
  async listTickets(
    principal: Principal,
    requestId: string,
    opts: TradeTicketListOptions,
  ): Promise<TradeTicketPage> {
    const conditions: (SQL | undefined)[] = [];
    if (opts.state !== undefined) conditions.push(eq(ticket.state, opts.state));
    if (opts.cursor !== undefined) {
      const [fundingDate = '', id = ''] = decodeCursor(opts.cursor, TICKET_CURSOR, [1]);
      conditions.push(
        or(
          lt(ticket.fundingDate, fundingDate),
          and(eq(ticket.fundingDate, fundingDate), gt(ticket.id, id)),
        ),
      );
    }
    const ctx = { asOf: this.adapters.clock.today(), holdDays: this.holdDays(), principal };
    return this.db.run(principal, requestId, async (tx) => {
      const rows = await buildTicketRows(tx, ctx, and(...conditions), {
        orderBy: TICKET_ORDER,
        limit: opts.limit + 1,
      });
      const page = rows.slice(0, opts.limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.fundingDate, last.id])
            : null,
      };
    });
  }

  /** One ticket; 404 when its notice is not visible to the caller. The open is audited. */
  async ticketDetail(principal: Principal, requestId: string, id: string): Promise<TradeTicketRow> {
    requireUuid(id, TICKET_NOT_FOUND);
    const ctx = { asOf: this.adapters.clock.today(), holdDays: this.holdDays(), principal };
    return this.db.run(principal, requestId, async (tx, audit) => {
      const [row] = await buildTicketRows(tx, ctx, eq(ticket.id, id));
      if (row === undefined) throw new ProblemError(404, 'not-found', TICKET_NOT_FOUND);
      await audit({ action: 'trade_ticket.read', entity: 'mon.trade_ticket', entityId: id });
      return row;
    });
  }

  /**
   * The detail as the contract shapes it, built inside a transaction: the row, its cash flows,
   * the hold from the register, the notes, the ticket, the active instruction and the alerts.
   * Null when the notice is not visible (or issued after the as-of date).
   */
  private async controlDetail(
    tx: Tx,
    id: string,
    asOf: string,
    principal: Principal,
  ): Promise<CapitalNoticeControlDetail | null> {
    requireUuid(id, NOT_FOUND);
    const holdDays = this.holdDays();
    const dueSoon = configInteger(
      this.definitions.capitalActivity?.dueSoonBusinessDays,
      'capitalActivity.dueSoonBusinessDays',
    );
    const [row] = await buildNoticeRows(tx, asOf, eq(notice.id, id));
    if (row === undefined) return null;
    const [control] = await tx
      .select({
        urgencyFlag: notice.urgencyFlag,
        wireChangeFlag: notice.wireChangeFlag,
        commitmentId: notice.commitmentId,
      })
      .from(notice)
      .where(eq(notice.id, id));
    if (control === undefined) return null;
    const cashFlows = await tx
      .select({
        date: flow.flowDate,
        flowType: flow.flowType,
        amount: flow.amount,
        status: flow.status,
      })
      .from(flow)
      .where(and(eq(flow.sourceNoticeId, row.id), lte(flow.flowDate, asOf)))
      .orderBy(asc(flow.flowDate), asc(flow.id));

    const keys = await counterpartyOfNotice(tx, {
      investmentId: row.investmentId,
      commitmentId: control.commitmentId,
    });
    // The masked active instruction and the hold are facts of the notice its readers see; the
    // register rows themselves stay behind the register's policy (systemStep.ts).
    const register: RegisterView =
      (await systemStep(tx, principal, () => loadRegisters(tx, [keys]))).get(keyOf(keys)) ??
      EMPTY_REGISTER;
    const pending = pendingChange(register, asOf, holdDays);
    const changedOn = pending === null ? null : isoDateOf(new Date(pending.proposedAt));
    const wireChangeHold =
      changedOn === null ? null : { until: addDays(changedOn, holdDays), holdDays };
    const notes: string[] = [];
    if (wireChangeHold !== null && changedOn !== null)
      notes.push(
        `Wire instructions changed on ${fmtDate(changedOn)}; release is held until ${fmtDate(wireChangeHold.until)} (SEC-12.3).`,
      );
    if (row.settledAmount === null)
      notes.push(
        cashFlows.length === 0
          ? 'No cash flow has been recorded for this notice.'
          : 'No approved cash flow has been recorded for this notice.',
      );
    const [ticketRow] = await buildTicketRows(
      tx,
      { asOf, holdDays, principal },
      eq(ticket.capitalNoticeId, id),
    );
    const alerts = noticeAlerts({
      state: row.state,
      urgencyFlag: control.urgencyFlag,
      wireChangeFlag: control.wireChangeFlag,
      dueDate: row.dueDate,
      asOf,
      dueSoonBusinessDays: dueSoon,
      wireVerified: register.active !== null,
    });
    return {
      ...row,
      cashFlows,
      wireChangeHold,
      notes,
      ticket: ticketRow ?? null,
      activeWireInstruction: register.active,
      alerts,
    };
  }

  private holdDays(): number {
    return configInteger(
      this.definitions.capitalActivity?.wireChangeHoldDays,
      'capitalActivity.wireChangeHoldDays',
    );
  }

  /** The stored state as the machine knows it; anything else is a record the commands cannot work. */
  private stateOf(state: string): CapitalNoticeState {
    const parsed = capitalNoticeState.safeParse(state);
    if (!parsed.success)
      throw new ProblemError(
        500,
        'internal',
        'capital_notice: the stored state is not one the workflow knows',
      );
    return parsed.data;
  }

  private async lockTicket(tx: Tx, noticeId: string): Promise<LockedTicket | null> {
    const [row] = await tx
      .select({
        id: ticket.id,
        state: ticket.state,
        amount: ticket.amount,
        fundingDate: ticket.fundingDate,
        preparedBy: ticket.preparedBy,
        approvedBy: ticket.approvedBy,
        wireInstructionId: ticket.wireInstructionId,
        rowVersion: ticket.rowVersion,
      })
      .from(ticket)
      .where(eq(ticket.capitalNoticeId, noticeId))
      .for('update');
    return row ?? null;
  }

  /** The one write of a ticket, on the row as it was locked; nothing written is a conflict. */
  private async writeTicket(
    tx: Tx,
    locked: LockedTicket,
    patch: Partial<typeof ticket.$inferInsert>,
  ): Promise<LockedTicket> {
    const updated = await tx
      .update(ticket)
      .set(patch)
      .where(
        and(
          eq(ticket.id, locked.id),
          eq(ticket.state, locked.state),
          eq(ticket.rowVersion, locked.rowVersion),
        ),
      )
      .returning();
    const row = updated[0];
    if (row === undefined) throw conflict('trade_ticket');
    return {
      id: row.id,
      state: row.state,
      amount: row.amount,
      fundingDate: row.fundingDate,
      preparedBy: row.preparedBy,
      approvedBy: row.approvedBy,
      wireInstructionId: row.wireInstructionId,
      rowVersion: row.rowVersion,
    };
  }

  /** What the audit event records of a ticket: ids, the figure and the people, never bank details. */
  private ticketImage(t: LockedTicket): Record<string, unknown> {
    return {
      id: t.id,
      state: t.state,
      amount: t.amount,
      fundingDate: t.fundingDate,
      preparedBy: t.preparedBy,
      approvedBy: t.approvedBy,
      wireInstructionId: t.wireInstructionId,
    };
  }

  /**
   * The reconciliation's one write into mon.cash_flow (rule 5: the notice is the staging record a
   * person approved through the workflow; rule 6: the audit event carries the figure): one approved
   * flow for the notice, typed and signed by the notice type, dated on the ticket's funding date
   * (the due date without a ticket), with the actor as approver and the notice as its source. A
   * notice that already has an approved flow is refused: nothing is counted twice.
   */
  private async writeCashFlow(
    tx: Tx,
    principal: Principal,
    locked: LockedNotice,
    ticketRow: LockedTicket | null,
    now: Date,
    reason: string | undefined,
  ): Promise<Record<string, unknown>> {
    const existing = await tx
      .select({ id: flow.id })
      .from(flow)
      .where(and(eq(flow.sourceNoticeId, locked.id), eq(flow.status, APPROVED)));
    if (existing.length > 0)
      throw new ProblemError(
        422,
        'workflow-precondition',
        'capital_notice: an approved cash flow is already recorded for this notice',
      );
    const mapping = FLOW_OF_NOTICE[locked.noticeType];
    if (mapping === undefined)
      throw new ProblemError(
        422,
        'workflow-precondition',
        'capital_notice: no cash flow type is defined for this notice type',
      );
    const amount = str(D(locked.amount).times(mapping.sign));
    if (amount === null) throw conflict('cash_flow');
    const flowDate = ticketRow?.fundingDate ?? locked.dueDate;
    const [inserted] = await tx
      .insert(flow)
      .values({
        investmentId: locked.investmentId,
        commitmentId: locked.commitmentId,
        flowDate,
        flowType: mapping.flowType,
        amount,
        currency: locked.currency,
        sourceNoticeId: locked.id,
        status: APPROVED,
        approvedBy: principal.userId,
        approvedAt: now,
        approvalReason: reason ?? null,
      })
      .returning();
    if (inserted === undefined) throw conflict('cash_flow');
    return { id: inserted.id, flowType: mapping.flowType, amount, flowDate, status: APPROVED };
  }

  /**
   * SEC-12.4 on extract: the notice document's text (readStoredDocument, @pb/pdf) scanned for
   * capitalActivity.urgencyPhrases, case-insensitively. Only the boolean leaves this method; the
   * text is neither stored nor logged. A document the store no longer has or the reader refuses
   * answers through storedDocumentProblem.
   */
  private async urgencyIn(tx: Tx, sourceDocumentId: string | null): Promise<boolean> {
    if (sourceDocumentId === null) return false;
    const phrases = configStringList(
      this.definitions.capitalActivity?.urgencyPhrases,
      'capitalActivity.urgencyPhrases',
    );
    const [doc] = await tx
      .select({ sourceItemId: schema.document.sourceItemId })
      .from(schema.document)
      .where(eq(schema.document.id, sourceDocumentId));
    if (doc === undefined) return false;
    try {
      const pdf = await readStoredDocument(
        this.adapters.documents,
        documentSettingsOf(this.definitions),
        doc.sourceItemId,
      );
      return urgencyLanguageIn(pdf.pages.map((p) => p.text).join('\n'), phrases);
    } catch (error) {
      throw storedDocumentProblem(error);
    }
  }
}
