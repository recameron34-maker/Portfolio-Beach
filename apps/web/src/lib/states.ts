import type {
  ChangeRequestState,
  ClosingState,
  DealStage,
  DocumentReviewStatus,
  ExpectedDocumentStatus,
  ExtractionRunState,
  TradeTicketState,
  WireInstructionState,
} from '@pb/contracts';
import type { Machine } from '@pb/workflows';
import { requireReason } from '@pb/workflows';
import type { Tone } from '../components/ui.js';
import { ROLE_WORDS } from './roles.js';

/** Acronyms in state and command names that stay in capitals ("IC", "QA failed"). */
const ACRONYMS = /\b(ic|qa)\b/gi;

/** A camelCase or PascalCase name as a sentence-case phrase, acronyms kept. */
/** Names whose plain words are not their letters: a contraction, or a word the code could not carry. */
const PHRASE_WORDS: Readonly<Record<string, string>> = { wont_fix: "Won't fix" };

function phrase(name: string): string {
  const known = PHRASE_WORDS[name];
  if (known !== undefined) return known;
  const spaced = name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const sentence = spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  return sentence.replace(ACRONYMS, (a) => a.toUpperCase());
}

/** "OpsPrepared" to "Ops prepared", "TicketDrafted" to "Ticket drafted", "QAFailed" to "QA failed". */
export function humanizeState(state: string): string {
  return phrase(state);
}

/** "dealTeamApprove" to "Deal team approve", "sendBack" to "Send back", "overrideQa" to "Override QA". */
export function commandLabel(command: string): string {
  return phrase(command);
}

/** "approver" or "deal_team" as words: "approver or deal team". */
export function rolesLabel(roles: readonly string[]): string {
  const words: Readonly<Record<string, string>> = ROLE_WORDS;
  return roles.map((r) => words[r] ?? r.replace(/_/g, ' ')).join(' or ');
}

/** docs/18 section 1: reports read Locked only; the in-flight states need someone's attention. */
export function valuationTone(state: string): Tone {
  if (state === 'Locked') return 'good';
  if (state === 'OpsPrepared' || state === 'DealTeamApproved' || state === 'Reopened')
    return 'watch';
  return 'neutral';
}

/**
 * docs/18 section 3: steps waiting on a person read as watch, an approved ticket as brand, settled
 * notices as good. Received waits on the extraction service, so it is neutral like an unknown code.
 */
const NOTICE_TONES: Readonly<Record<string, Tone>> = {
  Received: 'neutral',
  Extracted: 'watch',
  Reviewed: 'watch',
  TicketDrafted: 'watch',
  TicketApproved: 'brand',
  Funded: 'good',
  Reconciled: 'good',
};

export function noticeTone(state: string): Tone {
  return NOTICE_TONES[state] ?? 'neutral';
}

/**
 * docs/18 section 2: a flagged row waits for a person, a rejected row is a refusal, a promoted row
 * reached production; new, validated and approved are steps on the way and read as neutral.
 */
const STAGING_TONES: Readonly<Record<string, Tone>> = {
  flagged: 'watch',
  rejected: 'bad',
  promoted: 'good',
};

export function stagingTone(state: string): Tone {
  return STAGING_TONES[state] ?? 'neutral';
}

/**
 * docs/18 section 6: Classified is settled, NeedsReview waits on a person, Received waits on the
 * classifier and a Duplicate points at its original (neither needs anyone). One map for the hub,
 * the review queue and the deal workspace's Documents tab.
 */
const REVIEW_STATUS_TONES: Readonly<Record<DocumentReviewStatus, Tone>> = {
  Received: 'neutral',
  Classified: 'good',
  NeedsReview: 'watch',
  Duplicate: 'neutral',
};

export function reviewStatusTone(status: DocumentReviewStatus): Tone {
  return REVIEW_STATUS_TONES[status];
}

/**
 * docs/04 M3: a received document is done, a late one waits on the sponsor and a chaser, a
 * missing one is a gap the board must show; expected is on its way. One map for the tracker and
 * the monitoring board.
 */
const EXPECTED_STATUS_TONES: Readonly<Record<ExpectedDocumentStatus, Tone>> = {
  expected: 'neutral',
  received: 'good',
  late: 'watch',
  missing: 'bad',
};

export function expectedStatusTone(status: ExpectedDocumentStatus): Tone {
  return EXPECTED_STATUS_TONES[status];
}

/**
 * docs/18 section 7, decided once for every page (docs/06: a colour carries one meaning): Queued
 * and Running wait on the extraction service, so they read neutral as Received does in section
 * 3 (watch is a person's turn, brand an approved ticket); Succeeded is done (the approval has its
 * own tone), Failed is a data exception, NeedsRetry waits for the retry a reviewer may also
 * trigger.
 */
const RUN_STATE_TONES: Readonly<Record<ExtractionRunState, Tone>> = {
  Queued: 'neutral',
  Running: 'neutral',
  Succeeded: 'good',
  Failed: 'bad',
  NeedsRetry: 'watch',
};

export function runStateTone(state: ExtractionRunState): Tone {
  return RUN_STATE_TONES[state];
}

/** "Needs retry"; the other run states are single words. */
export function runStateWord(state: ExtractionRunState): string {
  return humanizeState(state);
}

/* ---- Phase 3 controls (decision 0013): one tone map per machine, shared by every page that
   shows the state (docs/06: a colour carries one meaning). A state the map does not know reads
   neutral, as noticeTone does, so a page never throws on an unexpected value. ---- */

/** A state's tone from its map; neutral for a value the map does not list. */
function toneOf(map: Readonly<Record<string, Tone>>, state: string): Tone {
  return map[state] ?? 'neutral';
}

/**
 * docs/18 section 11 (SEC-12.2): a Proposed version waits for the second person's callback, a
 * Verified one is the register's word, a Rejected one failed the callback, a Superseded one is
 * history.
 */
const WIRE_TONES: Readonly<Record<WireInstructionState, Tone>> = {
  Proposed: 'watch',
  Verified: 'good',
  Rejected: 'bad',
  Superseded: 'neutral',
};

export function wireTone(state: string): Tone {
  return toneOf(WIRE_TONES, state);
}

/**
 * SEC-12.3: a Drafted ticket waits for its approver, an Approved one is released (brand, as the
 * notice's TicketApproved), a Funded one is settled, a Withdrawn one is history.
 */
const TICKET_TONES: Readonly<Record<TradeTicketState, Tone>> = {
  Drafted: 'watch',
  Approved: 'brand',
  Funded: 'good',
  Withdrawn: 'neutral',
};

export function ticketTone(state: string): Tone {
  return toneOf(TICKET_TONES, state);
}

/**
 * docs/18 section 8: a Submitted request waits for the deal team to route it, Routed and
 * InProgress are in operations' hands, Applied is done, Rejected is a refusal with its reason.
 */
const CHANGE_REQUEST_TONES: Readonly<Record<ChangeRequestState, Tone>> = {
  Submitted: 'watch',
  Routed: 'brand',
  InProgress: 'brand',
  Applied: 'good',
  Rejected: 'bad',
};

export function changeRequestTone(state: string): Tone {
  return toneOf(CHANGE_REQUEST_TONES, state);
}

/**
 * docs/18 section 4: Sourced and Screening are intake, Prescreen and Diligence are the team's
 * work (brand), IC waits on a decision, Approved and Closed are won, Closing is in progress,
 * Passed is history.
 */
const STAGE_TONES: Readonly<Record<DealStage, Tone>> = {
  Sourced: 'neutral',
  Screening: 'neutral',
  Prescreen: 'brand',
  Diligence: 'brand',
  IC: 'watch',
  Approved: 'good',
  Closing: 'brand',
  Closed: 'good',
  Passed: 'neutral',
};

export function stageTone(stage: string): Tone {
  return toneOf(STAGE_TONES, stage);
}

/** docs/18 section 12 (M8): an Open closing waits for operations' confirmation. */
const CLOSING_TONES: Readonly<Record<ClosingState, Tone>> = {
  Open: 'watch',
  OpsConfirmed: 'good',
};

export function closingTone(state: string): Tone {
  return toneOf(CLOSING_TONES, state);
}

/** Urgency of a due date against the alert window (config capitalActivity.alertDaysBeforeDue). */
export function dueTone(daysToDue: number, alertDaysBeforeDue: readonly number[]): Tone {
  if (daysToDue < 0) return 'bad';
  const window = Math.max(0, ...alertDaysBeforeDue);
  return daysToDue <= window ? 'watch' : 'neutral';
}

export function dueLabel(daysToDue: number): string {
  if (daysToDue < 0) return daysToDue === -1 ? 'Overdue by 1 day' : `Overdue by ${-daysToDue} days`;
  if (daysToDue === 0) return 'Due today';
  return daysToDue === 1 ? 'Due tomorrow' : `Due in ${daysToDue} days`;
}

export interface CommandOption<S extends string, C extends string> {
  command: C;
  to: S;
  roles: readonly string[];
  /** True when at least one of the actor's roles may issue the command from this state. */
  allowed: boolean;
  /** True when the transition table requires a reason (send back, reopen). */
  needsReason: boolean;
  note: string | undefined;
}

/**
 * Every command the transition table lists from a state, marked by whether the actor's roles may
 * issue it (docs/18). Preconditions such as segregation of duties or missing inputs are evaluated
 * by the API, or by the preview simulation, never in the page: the page shows the refusal it gets.
 */
export function commandOptions<S extends string, C extends string>(
  machine: Machine<S, C>,
  state: S,
  actorRoles: readonly string[],
): CommandOption<S, C>[] {
  return machine.transitions
    .filter((t) => t.from === state)
    .map((t) => ({
      command: t.command,
      to: t.to,
      roles: t.roles,
      allowed: t.roles.some((r) => actorRoles.includes(r)),
      needsReason: t.precondition === requireReason,
      note: t.note,
    }));
}
