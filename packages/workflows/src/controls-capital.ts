import { addDays, toDayNumber } from '@pb/calc';
import type { CapitalNoticeState, WireInstructionState } from './machines.js';

/*
 * The capital activity controls as pure rules (docs/04 M16, docs/18 sections 3 and 11, SEC-12.2
 * to SEC-12.4, decision 0013): the business-day count and the alerts of a notice, the register of
 * one counterparty with its active version, the hold window after a changed instruction, and the
 * release check of a trade ticket. The API (apps/api/src/capital) reads them over the database
 * and the preview simulation (apps/web/src/preview/routes) over its session state, so the two
 * cannot drift. Plain data in, plain data out: no database, and no clock (the as-of date or today
 * is always passed in). The types name only what the rules read; the contract's rows satisfy them.
 */

/* ---- Business days and the SEC-12.4 alerts ---- */

/** 1970-01-01 (day number 0) was a Thursday; 0 is Sunday, 6 is Saturday. */
export function weekdayOf(iso: string): number {
  return (((toDayNumber(iso) + 4) % 7) + 7) % 7;
}

const isWeekday = (dayNumber: number): boolean => {
  const weekday = (((dayNumber + 4) % 7) + 7) % 7;
  return weekday !== 0 && weekday !== 6;
};

/**
 * Business days (Monday to Friday, no holiday calendar) strictly after `from` up to and including
 * `to`; negative when `to` is earlier, counting the weekdays after `to` up to `from`. Whole weeks
 * count five, the remainder is walked day by day.
 */
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

/** The SEC-12.4 alerts a notice carries, in the contract's order (capitalNoticeAlert). */
export type NoticeAlert =
  'wire_changed' | 'urgency_language' | 'due_within_two_business_days' | 'unverified_instruction';

/** The states in which the wire is already out, so the due date no longer needs attention. */
const SETTLED: readonly CapitalNoticeState[] = ['Funded', 'Reconciled'];

export interface AlertInput {
  state: CapitalNoticeState;
  urgencyFlag: boolean;
  wireChangeFlag: boolean;
  dueDate: string;
  /** The date the alerts are judged on: the as-of date of a read, today for a command. */
  asOf: string;
  dueSoonBusinessDays: number;
  /** Whether the counterparty has an active Verified instruction. */
  wireVerified: boolean;
}

/**
 * The alerts in the contract's order; an empty list when nothing needs attention: the
 * instructions changed, the notice uses urgency language, the due date is under the configured
 * number of business days away, the counterparty has no verified instruction.
 */
export function noticeAlerts(input: AlertInput): NoticeAlert[] {
  const out: NoticeAlert[] = [];
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

/* ---- The register of one counterparty ---- */

/** The two keys an instruction can carry; a notice's counterparty may hold both. */
export interface CounterpartyKeys {
  sponsorFundId: string | null;
  investmentId: string | null;
}

/** What the rules read of one version of the register; the contract's wireInstructionRow has it all. */
export interface RegisterVersion {
  id: string;
  counterparty: { kind: 'sponsor_fund' | 'investment'; id: string };
  version: number;
  state: WireInstructionState;
  proposedBy: { id: string };
  proposedAt: string;
  callback: { by: { id: string } } | null;
  active: boolean;
}

/** The register for one counterparty: every version, newest first, and the active Verified one. */
export interface RegisterView<V extends RegisterVersion = RegisterVersion> {
  versions: V[];
  active: V | null;
}

/** The ISO calendar date (UTC) of a timestamp, for the hold window arithmetic. */
export const utcDateOf = (at: string): string => new Date(at).toISOString().slice(0, 10);

/** Whether a version belongs to a counterparty, by either of its keys. */
export function belongsToCounterparty(
  version: Pick<RegisterVersion, 'counterparty'>,
  keys: CounterpartyKeys,
): boolean {
  return (
    (version.counterparty.kind === 'investment' && version.counterparty.id === keys.investmentId) ||
    (version.counterparty.kind === 'sponsor_fund' && version.counterparty.id === keys.sponsorFundId)
  );
}

/**
 * The active version among a counterparty's versions: when both kinds carry one, the
 * investment-level instruction is the more specific and wins.
 */
export function activeVersionOf<V extends RegisterVersion>(versions: readonly V[]): V | null {
  return (
    versions.find((v) => v.active && v.counterparty.kind === 'investment') ??
    versions.find((v) => v.active) ??
    null
  );
}

/** The register of one counterparty out of versions already in register order (newest proposal first). */
export function registerViewOf<V extends RegisterVersion>(
  ordered: readonly V[],
  keys: CounterpartyKeys,
): RegisterView<V> {
  const versions = ordered.filter((v) => belongsToCounterparty(v, keys));
  return { versions, active: activeVersionOf(versions) };
}

/**
 * The roles the register is read by (the read_register policy of migration 0013 and WIRE_ROLES
 * of the contract's route table, plus the system actor). A register row, even masked, carries the
 * bank's name, the last four digits and the names of the people who proposed and verified it:
 * pages that every role reads (the notice detail, the ticket) hand it to these roles only.
 */
export const REGISTER_READERS: readonly string[] = [
  'operations',
  'approver',
  'auditor',
  'platform_admin',
  'service',
];

export const readsRegister = (principal: { roles: readonly string[] }): boolean =>
  principal.roles.some((role) => REGISTER_READERS.includes(role));

/**
 * Whether a newer version of the same counterparty key is already Verified, so this one must be
 * rejected, never verified over it (wireInstructionMachine verify, record key olderThanVerified).
 * The key is exact: a fund-level version is compared with fund-level versions only. The API asks
 * the database the same question (wires.service.ts).
 */
export function olderThanVerified(
  version: Pick<RegisterVersion, 'counterparty' | 'version'>,
  versions: Iterable<Pick<RegisterVersion, 'counterparty' | 'version' | 'state'>>,
): boolean {
  for (const other of versions) {
    if (
      other.state === 'Verified' &&
      other.version > version.version &&
      other.counterparty.kind === version.counterparty.kind &&
      other.counterparty.id === version.counterparty.id
    )
      return true;
  }
  return false;
}

/* ---- The hold window (SEC-12.3) ---- */

/** The first date after the hold window of a version proposed at the timestamp given. */
export function holdUntil(proposedAt: string, holdDays: number): string {
  return addDays(utcDateOf(proposedAt), holdDays);
}

/** Whether the date given is still inside the hold window that opened when the version was proposed. */
export function insideHoldWindow(proposedAt: string, asOf: string, holdDays: number): boolean {
  return asOf < holdUntil(proposedAt, holdDays);
}

/**
 * The pending change that holds a release (SEC-12.3, docs/04 M16): the latest version of the
 * counterparty other than the active Verified one that was proposed within the hold window, that
 * is, whose proposal date plus capitalActivity.wireChangeHoldDays is still after the date given.
 * A Rejected version is not a change (the callback refused it; the active instruction stands), so
 * it never holds a release; a Proposed version waiting for its callback, or a version Verified or
 * Superseded within the window, does. Once the changed version is verified by a second person
 * and becomes the active one, it is no longer "other than the active one" and this hold lifts:
 * the callback is the second approval the control asks for, and recentVerifiedChange below then
 * keeps the people who made the change from releasing against it. Null when nothing holds.
 */
export function pendingChange<V extends RegisterVersion>(
  register: RegisterView<V>,
  asOf: string,
  holdDays: number,
): V | null {
  let latest: V | null = null;
  for (const v of register.versions) {
    if (v.id === register.active?.id || v.state === 'Rejected') continue;
    if (!insideHoldWindow(v.proposedAt, asOf, holdDays)) continue;
    if (latest === null || v.proposedAt > latest.proposedAt) latest = v;
  }
  return latest;
}

/**
 * The verified change still inside the hold window (SEC-12.3 "recently changed without a second
 * approval"): the active Verified version when it was proposed within
 * capitalActivity.wireChangeHoldDays before the date given, the same window pendingChange
 * measures, from the day the new or changed instruction was proposed. While it is inside the
 * window, the ticket approver must be a person other than its proposer and other than the person
 * whose callback verified it, so three people touch a recently changed instruction
 * (capitalNoticeMachine approveTicket, releaseOf below). Null once the window has passed or when
 * there is no active version: the dual control rule alone stands.
 */
export function recentVerifiedChange<V extends RegisterVersion>(
  register: RegisterView<V>,
  asOf: string,
  holdDays: number,
): V | null {
  const active = register.active;
  if (active === null) return null;
  return insideHoldWindow(active.proposedAt, asOf, holdDays) ? active : null;
}

/* ---- The release check of a trade ticket (SEC-12.3) ---- */

export type TicketState = 'Drafted' | 'Approved' | 'Funded' | 'Withdrawn';

/** Why a ticket cannot be released, in the contract's order (releaseBlocker). */
export type ReleaseBlocker =
  | 'unverified_instruction'
  | 'changed_within_hold'
  | 'same_person'
  | 'no_instruction'
  | 'verifier_within_hold';

/** Who is looking, and when: the release is judged for one person on one date. */
export interface ReleaseReader {
  userId: string;
  /** The date the hold window is judged on: today for a command, the as-of date for a read. */
  asOf: string;
  holdDays: number;
}

/**
 * Why a ticket cannot be released by the reader now (SEC-12.3), in the contract's order. Only a
 * Drafted ticket awaits release; an Approved one awaits funding and reports the same checks so a
 * change after approval shows at once; a Funded or Withdrawn one has nothing to release. The
 * preparer sees same_person on their own ticket, and the proposer or the verifier of a change
 * inside the hold window sees verifier_within_hold: that release takes a third person.
 */
export function releaseOf(
  ticket: { state: TicketState; preparedBy: string },
  register: RegisterView,
  reader: ReleaseReader,
): { allowed: boolean; blockers: ReleaseBlocker[] } {
  if (ticket.state === 'Funded' || ticket.state === 'Withdrawn')
    return { allowed: false, blockers: [] };
  const blockers: ReleaseBlocker[] = [];
  if (register.versions.length === 0) blockers.push('no_instruction');
  else if (register.active === null) blockers.push('unverified_instruction');
  if (pendingChange(register, reader.asOf, reader.holdDays) !== null)
    blockers.push('changed_within_hold');
  if (ticket.preparedBy === reader.userId) blockers.push('same_person');
  // A change verified inside the window takes a third person: not its proposer, not its verifier.
  const recent = recentVerifiedChange(register, reader.asOf, reader.holdDays);
  if (
    recent !== null &&
    (recent.proposedBy.id === reader.userId || recent.callback?.by.id === reader.userId)
  )
    blockers.push('verifier_within_hold');
  return { allowed: blockers.length === 0, blockers };
}
