import { D } from '@pb/calc';
import definitions from '../../../../../config/definitions.json';
import {
  capitalNoticeAlert,
  capitalNoticeDetail,
  commitmentList,
  investmentDetail,
  tradeTicketRow,
  wireInstructionRow,
} from '@pb/contracts';
import type { CapitalNoticeControlDetail, TradeTicketRow, WireInstructionRow } from '@pb/contracts';
import {
  holdUntil,
  noticeAlerts,
  pendingChange,
  readsRegister,
  recentVerifiedChange,
  registerViewOf,
  releaseOf,
  utcDateOf,
} from '@pb/workflows';
import type { CounterpartyKeys, RegisterView as RegisterViewOf } from '@pb/workflows';
import { z } from 'zod';
import type { Recordings } from '../fixtures.js';
import { ensureNotices, ensureTickets, ensureWires, readAny } from '../state.js';
import type {
  PreviewState,
  SimNotice,
  SimNoticeFlags,
  SimTicket,
  SimWireInstruction,
} from '../state.js';

/**
 * The wire register, the trade tickets and the SEC-12.4 alerts as the simulated capital controls
 * read them (docs/04 M16, docs/18 sections 3 and 11, SEC-12, decision 0013), the way
 * apps/api/src/capital/{register,tickets,alerts}.ts read them over the database. An instruction
 * belongs to a counterparty, a sponsor fund or an investment; a notice is funded against the
 * active Verified version of its investment (the more specific) or of that investment's or its
 * commitment's sponsor fund. The hold window (SEC-12.3): a version other than the active one,
 * proposed within capitalActivity.wireChangeHoldDays before today and not Rejected, holds every
 * ticket of the counterparty until a second person's callback verifies it; for the rest of the
 * window that verified change takes a third person to release against.
 *
 * The rules themselves (the business-day count, the alerts, the active version, the hold window,
 * the release check, who reads the register) are the pure functions of @pb/workflows
 * (controls-capital.ts) that the API reads too; this module gathers what they need from the
 * session state and the recordings. "Today" is the recordings' as-of date, the API clock's today
 * when the preview was built. Bank details never pass through here (masked rows only), and a
 * register row, even masked, goes to the register's readers alone (operations, approver, auditor,
 * platform admin): every other reader of a notice or a ticket gets null in its place.
 */

export { noticeAlerts, pendingChange, readsRegister, releaseOf };
export type { CounterpartyKeys };

/** What the preview and the overlay share: the session state and the recordings. */
export interface ControlContext {
  state: PreviewState;
  recordings: Recordings;
}

/** The capital activity settings the controls read (config/definitions.json). */
export const HOLD_DAYS: number = definitions.capitalActivity.wireChangeHoldDays;
export const DUE_SOON_BUSINESS_DAYS: number = definitions.capitalActivity.dueSoonBusinessDays;

/** The register of one counterparty: every version, newest first, and the active Verified one. */
export type RegisterView = RegisterViewOf<WireInstructionRow>;

export const EMPTY_REGISTER: RegisterView = { versions: [], active: null };

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The register order: newest proposal first, then id, the list cursor's key. */
export const registerOrder = (a: WireInstructionRow, b: WireInstructionRow): number =>
  byText(b.proposedAt, a.proposedAt) || byText(b.id, a.id);

/** The register of one counterparty over the simulated versions; the investment-level active version wins. */
export function registerOf(
  wires: Iterable<SimWireInstruction>,
  keys: CounterpartyKeys,
): RegisterView {
  return registerViewOf([...wires].map((w) => w.row).sort(registerOrder), keys);
}

/** Who is reading: the user behind a credential, from the recorded sign-in. */
export interface Reader {
  userId: string;
  roles: readonly string[];
}

/** The reader behind a credential; nobody (no id, no role) when the sign-in was not recorded. */
export function readerOf(recordings: Recordings, credential: string): Reader {
  const user = recordings.user(credential);
  return { userId: user?.userId ?? '', roles: user?.roles ?? [] };
}

/**
 * The counterparty of a capital notice: its investment and that investment's sponsor fund, or
 * its commitment's sponsor fund, read from whichever recording names them (the investment detail
 * or the commitments list of any user who could read them).
 */
export function counterpartyOfNotice(
  recordings: Recordings,
  notice: { investmentId: string | null; commitmentId: string | null },
): CounterpartyKeys {
  if (notice.investmentId !== null) {
    const detail = readAny(
      recordings,
      `/api/v1/investments/${encodeURIComponent(notice.investmentId)}`,
      investmentDetail,
    );
    return { investmentId: notice.investmentId, sponsorFundId: detail?.sponsorFundId ?? null };
  }
  if (notice.commitmentId !== null) {
    const row = readAny(recordings, '/api/v1/commitments', commitmentList)?.items.find(
      (c) => c.id === notice.commitmentId,
    );
    return { investmentId: null, sponsorFundId: row?.sponsorFundId ?? null };
  }
  return { investmentId: null, sponsorFundId: null };
}

/**
 * What capitalNoticeMachine reads of the register for approveTicket, the four keys
 * apps/api/src/capital/capital.service.ts builds: whether an instruction is Verified, whether a
 * change is pending inside the hold window, and who proposed and whose callback verified a
 * change verified inside it. Those two are null when no verified change sits inside the window:
 * the machine then asks for nothing beyond dual control.
 */
export function approvalRecordOf(
  register: RegisterView,
  asOf: string,
): {
  wireVerified: boolean;
  wireChangedWithinHold: boolean;
  wireProposedByWithinHold: string | null;
  wireVerifiedByWithinHold: string | null;
} {
  const recent = recentVerifiedChange(register, asOf, HOLD_DAYS);
  return {
    wireVerified: register.active !== null,
    wireChangedWithinHold: pendingChange(register, asOf, HOLD_DAYS) !== null,
    wireProposedByWithinHold: recent?.proposedBy.id ?? null,
    wireVerifiedByWithinHold: recent?.callback?.by.id ?? null,
  };
}

/**
 * A ticket as the contract serves it to one reader: the release check judged for that person,
 * and the version it was approved against (masked) for a reader of the register only; every
 * other reader of the ticket gets null there, as the API answers.
 */
export function ticketRowOf(
  sim: SimTicket,
  wires: ReadonlyMap<string, SimWireInstruction>,
  register: RegisterView,
  reader: Reader,
  asOf: string,
): TradeTicketRow {
  const against =
    sim.wireInstructionId === null || !readsRegister(reader)
      ? undefined
      : wires.get(sim.wireInstructionId);
  return {
    id: sim.id,
    capitalNoticeId: sim.capitalNoticeId,
    amount: sim.amount,
    currency: sim.currency,
    fundingDate: sim.fundingDate,
    preparedBy: sim.preparedBy,
    preparedAt: sim.preparedAt,
    approvedBy: sim.approvedBy,
    approvedAt: sim.approvedAt,
    wireInstruction:
      against === undefined
        ? null
        : {
            id: against.row.id,
            version: against.row.version,
            state: against.row.state,
            bankDetailsMasked: against.row.bankDetailsMasked,
          },
    state: sim.state,
    release: releaseOf({ state: sim.state, preparedBy: sim.preparedBy.id }, register, {
      userId: reader.userId,
      asOf,
      holdDays: HOLD_DAYS,
    }),
    rowVersion: sim.rowVersion,
  };
}

/** The ticket of a notice, if one was recorded or drafted this session. */
export function ticketOfNotice(
  tickets: ReadonlyMap<string, SimTicket>,
  noticeId: string,
): SimTicket | undefined {
  for (const t of tickets.values()) if (t.capitalNoticeId === noticeId) return t;
  return undefined;
}

/**
 * A recorded notice detail, read leniently: the three control fields are what the API serves
 * since Phase 3 wave 2, and a detail recorded before them still reads (as no ticket, no active
 * instruction and no alerts).
 */
export const recordedNoticeDetail = capitalNoticeDetail.extend({
  ticket: tradeTicketRow.nullable().default(null),
  activeWireInstruction: wireInstructionRow.nullable().default(null),
  alerts: z.array(capitalNoticeAlert).default([]),
});
export type RecordedNoticeDetail = z.infer<typeof recordedNoticeDetail>;

/** The flags of a notice from what its recorded detail alerted on; the extract that sets them is the system's step, never a person's. */
export function noticeFlagsOf(recorded: RecordedNoticeDetail | undefined): SimNoticeFlags {
  return {
    urgencyFlag: recorded?.alerts.includes('urgency_language') ?? false,
    wireChangeFlag: recorded?.alerts.includes('wire_changed') ?? false,
  };
}

/** The note a funded ticket adds when its amount is not the notice's, in the API's words. */
export const FUNDED_AMOUNT_DIFFERS = 'Funded amount differs from the notice amount.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An ISO date for a notice note, as the API writes it: "2025-03-31" is "Mar 31, 2025". */
export const fmtDate = (iso: string): string =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? '?'} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

/**
 * The notice detail as the contract serves it, built from the recorded detail with the
 * session's register, ticket and flags laid over: the state and row version, the cash flow a
 * reconcile wrote, the hold from the register (SEC-12.3) and its note, the note of a funded
 * amount that differs from the notice, the ticket judged for the reader, the counterparty's
 * active instruction (masked, for a reader of the register only) and the SEC-12.4 alerts, which
 * tell every reader whether a Verified instruction is on file.
 */
export function controlDetailOf(
  ctx: ControlContext,
  credential: string,
  recorded: RecordedNoticeDetail,
  sim: SimNotice,
): CapitalNoticeControlDetail {
  const asOf = ctx.recordings.asOf;
  const wires = ensureWires(ctx.state, ctx.recordings);
  const tickets = ensureTickets(ctx.state, ctx.recordings);
  const keys = counterpartyOfNotice(ctx.recordings, recorded);
  const register = registerOf(wires.values(), keys);
  const pending = pendingChange(register, asOf, HOLD_DAYS);
  const changedOn = pending === null ? null : utcDateOf(pending.proposedAt);
  const wireChangeHold =
    pending === null
      ? null
      : { until: holdUntil(pending.proposedAt, HOLD_DAYS), holdDays: HOLD_DAYS };
  const cashFlows = [...recorded.cashFlows, ...sim.cashFlows];
  const settled = sim.cashFlows.reduce((sum, f) => sum.plus(D(f.amount).abs()), D('0'));
  const settledAmount =
    sim.cashFlows.length === 0
      ? recorded.settledAmount
      : settled.plus(recorded.settledAmount ?? '0').toFixed(2);
  const notes: string[] = [];
  if (wireChangeHold !== null && changedOn !== null)
    notes.push(
      `Wire instructions changed on ${fmtDate(changedOn)}; release is held until ${fmtDate(wireChangeHold.until)} (SEC-12.3).`,
    );
  if (settledAmount === null)
    notes.push(
      cashFlows.length === 0
        ? 'No cash flow has been recorded for this notice.'
        : 'No approved cash flow has been recorded for this notice.',
    );
  const flags = (sim.flags ??= noticeFlagsOf(recorded));
  const ticket = ticketOfNotice(tickets, recorded.id);
  // What left the account is the ticket's amount; the reconciliation books it (writeCashFlow).
  if (ticket?.state === 'Funded' && !D(ticket.amount).equals(D(recorded.amount)))
    notes.push(FUNDED_AMOUNT_DIFFERS);
  const reader = readerOf(ctx.recordings, credential);
  return {
    ...recorded,
    state: sim.row.state,
    rowVersion: sim.row.rowVersion,
    cashFlows,
    settledAmount,
    wireChangeHold,
    notes,
    ticket: ticket === undefined ? null : ticketRowOf(ticket, wires, register, reader, asOf),
    // The register's row goes to the register's readers only; the alerts below already say
    // whether a Verified instruction is on file (unverified_instruction).
    activeWireInstruction: readsRegister(reader) ? register.active : null,
    alerts: noticeAlerts({
      state: sim.row.state,
      urgencyFlag: flags.urgencyFlag,
      wireChangeFlag: flags.wireChangeFlag,
      dueDate: recorded.dueDate,
      asOf,
      dueSoonBusinessDays: DUE_SOON_BUSINESS_DAYS,
      wireVerified: register.active !== null,
    }),
  };
}

/** The recorded notice detail of a credential, or undefined when it cannot open the notice. */
export function readNoticeDetail(
  recordings: Recordings,
  credential: string,
  id: string,
): RecordedNoticeDetail | undefined {
  return recordings.read(
    credential,
    `/api/v1/capital-notices/${encodeURIComponent(id)}`,
    recordedNoticeDetail,
  );
}

/**
 * The flags a notice carried when the preview was built, from the recorded detail of any user
 * who could open it: the flags are the notice's own (mon.capital_notice), whoever reads them, so
 * a step taken by someone outside the notice's wall (the register's sweep) starts from the same
 * flags a wall member sees.
 */
export function recordedFlagsOf(recordings: Recordings, id: string): SimNoticeFlags {
  return noticeFlagsOf(
    readAny(recordings, `/api/v1/capital-notices/${encodeURIComponent(id)}`, recordedNoticeDetail),
  );
}

/** Whether the register, the tickets or the notice itself changed this session, so a recorded detail must be rebuilt. */
export function controlsTouched(ctx: ControlContext, sim: SimNotice | undefined): boolean {
  if (sim?.changed === true) return true;
  const { wires, tickets } = ctx.state;
  if (wires !== null) for (const w of wires.values()) if (w.changed) return true;
  if (tickets !== null) for (const t of tickets.values()) if (t.changed) return true;
  return false;
}

/** The notices of a counterparty not yet Reconciled, as the register's SEC-12.4 sweep finds them. */
export function openNoticesOf(ctx: ControlContext, keys: CounterpartyKeys): SimNotice[] {
  const notices = ensureNotices(ctx.state, ctx.recordings);
  const out: SimNotice[] = [];
  for (const sim of notices.values()) {
    if (sim.row.state === 'Reconciled') continue;
    const own = counterpartyOfNotice(ctx.recordings, sim.row);
    const match =
      (keys.investmentId !== null && own.investmentId === keys.investmentId) ||
      (keys.sponsorFundId !== null && own.sponsorFundId === keys.sponsorFundId);
    if (match) out.push(sim);
  }
  return out;
}
