import { tradeTicketState } from '@pb/contracts';
import type {
  CapitalNoticeAlert,
  CapitalNoticeRow,
  ReleaseBlocker,
  TradeTicketRow,
  TradeTicketState,
} from '@pb/contracts';
import type { Tone } from '../../components/ui.js';
import { labelOf } from '../../lib/format.js';
import { noticeSubject } from './notices.js';

/*
 * Trade tickets and the SEC-12.4 alerts in words (docs/04 M16, SEC-12.3): the states, the
 * release blockers as sentences a person can act on, the alerts with their tone, and the
 * client-side filter of the ticket list.
 */

/** The four states in the order of docs/18 section 3. */
export const TICKET_STATES: readonly TradeTicketState[] = tradeTicketState.options;

export function isTicketState(value: string): value is TradeTicketState {
  return (TICKET_STATES as readonly string[]).includes(value);
}

/** Why a ticket cannot be released, one sentence each (SEC-12.2, SEC-12.3). */
export const BLOCKER_WORDS: Readonly<Record<ReleaseBlocker, string>> = {
  no_instruction: 'No wire instruction is on file for the counterparty (SEC-12.2).',
  unverified_instruction: 'The counterparty has no Verified wire instruction (SEC-12.2).',
  changed_within_hold:
    "The wire instructions changed within the hold window and wait for a second person's callback (SEC-12.3).",
  same_person: 'You prepared this ticket; a different person must approve it (SEC-12.3).',
};

/** "Changed within hold": the blocker as a short label for a table cell. */
export function blockerLabel(blocker: ReleaseBlocker): string {
  return labelOf(blocker);
}

/** The sentence the ticket panel shows when nothing blocks the release. */
export const RELEASE_ALLOWED =
  'Release allowed: a Verified instruction is on file, nothing changed within the hold window and a different person prepared the ticket (SEC-12.3).';

/** A Funded or Withdrawn ticket has nothing left to release. */
export function nothingToRelease(state: TradeTicketState): boolean {
  return state === 'Funded' || state === 'Withdrawn';
}

export interface AlertWords {
  label: string;
  sentence: string;
  tone: Tone;
}

/** The SEC-12.4 alerts: a short label for the badge and one plain sentence each. */
export const ALERT_WORDS: Readonly<Record<CapitalNoticeAlert, AlertWords>> = {
  wire_changed: {
    label: 'Wire changed',
    sentence:
      "The counterparty's wire instructions changed; the ticket releases only after a second person's callback verifies the new version (SEC-12.3).",
    tone: 'bad',
  },
  urgency_language: {
    label: 'Urgency language',
    sentence:
      'The notice presses for a quick payment; pressure to pay fast is a warning sign, so check the instructions with extra care (SEC-12.4).',
    tone: 'watch',
  },
  due_within_two_business_days: {
    label: 'Due soon',
    sentence: 'The due date is under two business days away.',
    tone: 'watch',
  },
  unverified_instruction: {
    label: 'No verified instruction',
    sentence: 'The counterparty has no Verified wire instruction on file (SEC-12.2).',
    tone: 'bad',
  },
};

export interface TicketFilters {
  state: TradeTicketState | '';
}

/** Client-side filter over the one unfiltered page, in the API's order (latest funding date first). */
export function filterTickets(
  items: readonly TradeTicketRow[],
  f: TicketFilters,
): TradeTicketRow[] {
  return items.filter((t) => f.state === '' || t.state === f.state);
}

/**
 * The notice a ticket pays, named as the notice board names it ("Capital call: Summit Services
 * Co") when the notice list is at hand; the short id otherwise, so the link still stands.
 */
export function ticketNoticeLabel(
  ticket: TradeTicketRow,
  notices: ReadonlyMap<string, CapitalNoticeRow>,
): string {
  const notice = notices.get(ticket.capitalNoticeId);
  if (notice === undefined) return `Notice ${ticket.capitalNoticeId.slice(0, 8)}`;
  return `${labelOf(notice.noticeType)}: ${noticeSubject(notice)}`;
}
