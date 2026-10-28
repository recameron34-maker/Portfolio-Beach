import { toDayNumber } from '@pb/calc';
import type { CapitalNoticeAlert, CapitalNoticeState } from '@pb/contracts';

/*
 * The SEC-12.4 alerts a capital notice carries (docs/04 M16): the instructions changed, the
 * notice uses urgency language, the due date is under the configured number of business days
 * away, the counterparty has no verified instruction. The look-alike sender domain alert waits
 * for the mail adapter (docs/11). Pure functions over what the service already read; no clock.
 */

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

/** Whitespace folded, case folded: a phrase matches across a line break in the notice text. */
const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** True when any configured phrase (capitalActivity.urgencyPhrases) appears in the text, case-insensitively. */
export function urgencyLanguageIn(text: string, phrases: readonly string[]): boolean {
  const folded = fold(text);
  return phrases.some((phrase) => fold(phrase).length > 0 && folded.includes(fold(phrase)));
}

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

/** The alerts in the contract's order; an empty list when nothing needs attention. */
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
