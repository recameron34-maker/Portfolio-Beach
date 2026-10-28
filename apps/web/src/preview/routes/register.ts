import { D, addDays, toDayNumber } from '@pb/calc';
import definitions from '../../../../../config/definitions.json';
import {
  capitalNoticeAlert,
  capitalNoticeDetail,
  commitmentList,
  investmentDetail,
  tradeTicketRow,
  wireInstructionRow,
} from '@pb/contracts';
import type {
  CapitalNoticeAlert,
  CapitalNoticeControlDetail,
  CapitalNoticeState,
  ReleaseBlocker,
  TradeTicketRow,
  WireInstructionRow,
} from '@pb/contracts';
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
 * ticket of the counterparty until a second person's callback verifies it. Pure functions over
 * the session state and the recordings; "today" is the recordings' as-of date, the API clock's
 * today when the preview was built. Bank details never pass through here (masked rows only).
 */

/** What the preview and the overlay share: the session state and the recordings. */
export interface ControlContext {
  state: PreviewState;
  recordings: Recordings;
}

/** The capital activity settings the controls read (config/definitions.json). */
export const HOLD_DAYS: number = definitions.capitalActivity.wireChangeHoldDays;
export const DUE_SOON_BUSINESS_DAYS: number = definitions.capitalActivity.dueSoonBusinessDays;

export interface CounterpartyKeys {
  investmentId: string | null;
  sponsorFundId: string | null;
}

/** The register of one counterparty: every version, newest first, and the active Verified one. */
export interface RegisterView {
  versions: WireInstructionRow[];
  active: WireInstructionRow | null;
}

export const EMPTY_REGISTER: RegisterView = { versions: [], active: null };

/** The ISO calendar date of a timestamp, for the hold window arithmetic. */
export const isoDateOf = (at: string): string => at.slice(0, 10);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The register order: newest proposal first, then id, the list cursor's key. */
export const registerOrder = (a: WireInstructionRow, b: WireInstructionRow): number =>
  byText(b.proposedAt, a.proposedAt) || byText(b.id, a.id);

/** Whether a version belongs to a counterparty, by either of its keys. */
export function belongsTo(row: WireInstructionRow, keys: CounterpartyKeys): boolean {
  return (
    (row.counterparty.kind === 'investment' && row.counterparty.id === keys.investmentId) ||
    (row.counterparty.kind === 'sponsor_fund' && row.counterparty.id === keys.sponsorFundId)
  );
}

/** The register of one counterparty over the simulated versions; the investment-level active version wins. */
export function registerOf(
  wires: Iterable<SimWireInstruction>,
  keys: CounterpartyKeys,
): RegisterView {
  const versions = [...wires]
    .map((w) => w.row)
    .filter((row) => belongsTo(row, keys))
    .sort(registerOrder);
  return {
    versions,
    active:
      versions.find((v) => v.active && v.counterparty.kind === 'investment') ??
      versions.find((v) => v.active) ??
      null,
  };
}

/**
 * The pending change that holds a release (SEC-12.3, docs/04 M16): the latest version of the
 * counterparty other than the active one, not Rejected, whose proposal date plus the hold days
 * is still after the date given. Null when nothing holds.
 */
export function pendingChange(
  register: RegisterView,
  asOf: string,
  holdDays: number,
): WireInstructionRow | null {
  let latest: WireInstructionRow | null = null;
  for (const v of register.versions) {
    if (v.id === register.active?.id || v.state === 'Rejected') continue;
    if (asOf >= addDays(isoDateOf(v.proposedAt), holdDays)) continue;
    if (latest === null || v.proposedAt > latest.proposedAt) latest = v;
  }
  return latest;
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

const isWeekday = (dayNumber: number): boolean => {
  const weekday = (((dayNumber + 4) % 7) + 7) % 7;
  return weekday !== 0 && weekday !== 6;
};

/** Business days (Monday to Friday) strictly after `from` up to and including `to`; negative when `to` is earlier. */
export function businessDaysBetween(from: string, to: string): number {
  const a = toDayNumber(from);
  const b = toDayNumber(to);
  if (b < a) return -businessDaysBetween(to, from);
  const span = b - a;
  const weeks = Math.floor(span / 7);
  let count = weeks * 5;
  for (let d = a + weeks * 7 + 1; d <= b; d += 1) if (isWeekday(d)) count += 1;
  return count;
}

/** The states in which the wire is already out, so the due date no longer needs attention. */
const SETTLED: readonly CapitalNoticeState[] = ['Funded', 'Reconciled'];

export interface AlertInput {
  state: CapitalNoticeState;
  urgencyFlag: boolean;
  wireChangeFlag: boolean;
  dueDate: string;
  asOf: string;
  dueSoonBusinessDays: number;
  wireVerified: boolean;
}

/** The SEC-12.4 alerts in the contract's order; an empty list when nothing needs attention. */
export function noticeAlerts(input: AlertInput): CapitalNoticeAlert[] {
  const out: CapitalNoticeAlert[] = [];
  if (input.wireChangeFlag) out.push('wire_changed');
  if (input.urgencyFlag) out.push('urgency_language');
  if (
    !SETTLED.includes(input.state) &&
    businessDaysBetween(input.asOf, input.dueDate) < input.dueSoonBusinessDays
  )
    out.push('due_within_two_business_days');
  if (!input.wireVerified) out.push('unverified_instruction');
  return out;
}

/**
 * Why a ticket cannot be released by the reader now (SEC-12.3), in the contract's order: only a
 * Drafted or Approved ticket is judged; a Funded or Withdrawn one has nothing to release.
 */
export function releaseOf(
  ticket: { state: SimTicket['state']; preparedById: string },
  register: RegisterView,
  readerId: string,
  asOf: string,
): { allowed: boolean; blockers: ReleaseBlocker[] } {
  if (ticket.state === 'Funded' || ticket.state === 'Withdrawn')
    return { allowed: false, blockers: [] };
  const blockers: ReleaseBlocker[] = [];
  if (register.versions.length === 0) blockers.push('no_instruction');
  else if (register.active === null) blockers.push('unverified_instruction');
  if (pendingChange(register, asOf, HOLD_DAYS) !== null) blockers.push('changed_within_hold');
  if (ticket.preparedById === readerId) blockers.push('same_person');
  return { allowed: blockers.length === 0, blockers };
}

/** A ticket as the contract serves it to one reader: the version it was approved against (masked) and the release check. */
export function ticketRowOf(
  sim: SimTicket,
  wires: ReadonlyMap<string, SimWireInstruction>,
  register: RegisterView,
  readerId: string,
  asOf: string,
): TradeTicketRow {
  const against = sim.wireInstructionId === null ? undefined : wires.get(sim.wireInstructionId);
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
    release: releaseOf(
      { state: sim.state, preparedById: sim.preparedBy.id },
      register,
      readerId,
      asOf,
    ),
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An ISO date for a notice note, as the API writes it: "2025-03-31" is "Mar 31, 2025". */
export const fmtDate = (iso: string): string =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? '?'} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

/** The user id behind a credential, from the recorded sign-in; empty when unknown. */
export function readerIdOf(recordings: Recordings, credential: string): string {
  return recordings.user(credential)?.userId ?? '';
}

/**
 * The notice detail as the contract serves it, built from the recorded detail with the
 * session's register, ticket and flags laid over: the state and row version, the cash flow a
 * reconcile wrote, the hold from the register (SEC-12.3) and its note, the ticket judged for
 * the reader, the counterparty's active instruction (masked) and the SEC-12.4 alerts.
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
  const changedOn = pending === null ? null : isoDateOf(pending.proposedAt);
  const wireChangeHold =
    changedOn === null ? null : { until: addDays(changedOn, HOLD_DAYS), holdDays: HOLD_DAYS };
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
  const readerId = readerIdOf(ctx.recordings, credential);
  return {
    ...recorded,
    state: sim.row.state,
    rowVersion: sim.row.rowVersion,
    cashFlows,
    settledAmount,
    wireChangeHold,
    notes,
    ticket: ticket === undefined ? null : ticketRowOf(ticket, wires, register, readerId, asOf),
    activeWireInstruction: register.active,
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
