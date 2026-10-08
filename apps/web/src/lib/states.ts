import type { Machine } from '@pb/workflows';
import { requireReason } from '@pb/workflows';
import type { Tone } from '../components/ui.js';
import { ROLE_WORDS } from './roles.js';

/** Acronyms in state and command names that stay in capitals ("IC", "QA failed"). */
const ACRONYMS = /\b(ic|qa)\b/gi;

/** A camelCase or PascalCase name as a sentence-case phrase, acronyms kept. */
function phrase(name: string): string {
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
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
