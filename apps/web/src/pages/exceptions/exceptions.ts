import type { DataException, DataExceptionState } from '@pb/contracts';
import { ROUTES } from '@pb/contracts';
import { exceptionMachine } from '@pb/workflows';
import type { ExceptionCommand, ExceptionState } from '@pb/workflows';
import type { Tone } from '../../components/ui.js';
import { labelOf } from '../../lib/format.js';
import { commandLabel, commandOptions, humanizeState, rolesLabel } from '../../lib/states.js';
import type { CommandOption } from '../../lib/states.js';

/*
 * Pure helpers of the exceptions pages (docs/04 M1 Data Health, docs/18 section 9): tones,
 * labels, the context of an exception and which commands the signed-in roles may issue. Nothing
 * here reads the network or the DOM.
 */

/** The page header's context line. */
export const EXCEPTIONS_META =
  'What an intake could not decide for itself, worked by operations (docs/18 section 9)';

/** What a role the queue refuses is told (the API answers 403; viewers, investor relations and platform admins). */
export const EXCEPTIONS_FORBIDDEN = {
  title: 'Exceptions are for operations and reviewers',
  detail:
    'Operations works the queue; operations, the deal team, approvers and auditors read it. Ask a platform administrator if you need access.',
};

/** The states of docs/18 section 9, from the transition table, in its order. */
export const EXCEPTION_STATES: readonly DataExceptionState[] = exceptionMachine.states;

export function isExceptionState(value: string): value is DataExceptionState {
  return (exceptionMachine.states as readonly string[]).includes(value);
}

/** The exception_severity taxonomy terms (core.taxonomy_term, migration 0002), most urgent first. */
export const SEVERITIES = [
  'exception_severity.high',
  'exception_severity.medium',
  'exception_severity.low',
] as const;

const SEVERITY_TONES: Readonly<Record<string, Tone>> = {
  'exception_severity.high': 'bad',
  'exception_severity.medium': 'watch',
  'exception_severity.low': 'neutral',
};

export function severityTone(code: string): Tone {
  return SEVERITY_TONES[code] ?? 'neutral';
}

/** "High": the taxonomy's own label once the shell has loaded it, else one made from the code. */
export function severityLabel(code: string): string {
  return labelOf(code);
}

/** docs/18 section 9: open waits for a person, acknowledged is taken, resolved is done, won't fix is closed as it stands. */
const STATE_TONES: Readonly<Record<string, Tone>> = {
  open: 'watch',
  acknowledged: 'brand',
  resolved: 'good',
  wont_fix: 'neutral',
};

export function exceptionTone(state: string): Tone {
  return STATE_TONES[state] ?? 'neutral';
}

/** "Open", "Acknowledged", "Won't fix". */
export function exceptionStateWord(state: string): string {
  return humanizeState(state);
}

/** The intakes that open exceptions, in words; another source reads as its code in words. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  accounting_import: 'Accounting import',
  lookthrough_reconcile: 'Look-through reconcile',
  weekly_import: 'Weekly values',
  ops_drop_import: 'Operations workbook',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? humanizeState(source);
}

/** The sources a reader may filter by: the known intakes plus any other source the queue holds, sorted. */
export function knownSources(items: readonly Pick<DataException, 'source'>[]): string[] {
  return [...new Set([...Object.keys(SOURCE_LABELS), ...items.map((x) => x.source)])].sort();
}

export interface ContextLink {
  to: '/data/lookthrough/$id' | '/data/intake/$id';
  params: { id: string };
  label: string;
}

/**
 * Where the staged row an exception is about can be read: the reconcile run for a look-through
 * exception, the intake file for a staged row of any other intake. A staged value (the weekly
 * intake) has its own page, which this page does not know; the file is named without a link.
 */
export function contextLink(x: DataException): ContextLink | null {
  const id = x.context.intakeFileId;
  if (id === null) return null;
  const label = x.context.intakeFileName ?? 'the staged file';
  if (x.source === 'lookthrough_reconcile')
    return { to: '/data/lookthrough/$id', params: { id }, label };
  if (x.entity === 'stg.intake_row') return { to: '/data/intake/$id', params: { id }, label };
  return null;
}

/** "Row 7" when the exception is about a staged row. */
export function rowText(x: Pick<DataException, 'context'>): string | null {
  return x.context.rowNo === null ? null : `Row ${x.context.rowNo}`;
}

/** "INV-0004 Silverline Staffing Holdings" when the caller may see the position; null otherwise. */
export function positionText(x: Pick<DataException, 'context'>): string | null {
  const { investmentNumber, companyName } = x.context;
  if (investmentNumber === null && companyName === null) return null;
  return [investmentNumber, companyName].filter((t) => t !== null).join(' ');
}

const DAY_MS = 86_400_000;

/** "today", "1 day" or "12 days": how long the exception has been open, whole days by the calendar. */
export function ageLabel(createdAt: string, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(createdAt)) / DAY_MS));
  if (days === 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}

/** The contract's route for exception commands: POST /data-exceptions/{id}/commands. */
const COMMANDS_ROUTE_SUFFIX = '/data-exceptions/{id}/commands';

/**
 * Roles that may issue exception commands at all, read from the commands route in the contract
 * (packages/contracts routes.ts) so the page never keeps its own copy of that list.
 */
export const COMMAND_ROLES: readonly string[] =
  ROUTES.find((r) => r.method === 'POST' && r.path.endsWith(COMMANDS_ROUTE_SUFFIX))?.roles ?? [];

export type ExceptionTransition = CommandOption<ExceptionState, ExceptionCommand>;

export interface ExceptionActions {
  /** The buttons are offered at all: the signed-in roles may issue exception commands. */
  offered: boolean;
  /** Every transition the table lists from the state, marked by whether the roles may issue it. */
  transitions: ExceptionTransition[];
  /** The ticket form is offered: a plain update, in any state, for the roles that may command. */
  ticket: boolean;
}

/**
 * Which actions the signed-in roles may take on an exception, from the exception transition
 * table (docs/18 section 9): acknowledge from open, resolve and won't fix from open or
 * acknowledged, operations only; a terminal state lists nothing. Setting the ticket is not a
 * transition and is offered alongside.
 */
export function exceptionActions(
  roles: readonly string[],
  state: ExceptionState,
): ExceptionActions {
  const offered = roles.some((r) => COMMAND_ROLES.includes(r));
  return {
    offered,
    transitions: offered ? commandOptions(exceptionMachine, state, roles) : [],
    ticket: offered,
  };
}

/** Why a transition button is disabled, or null when it is live. */
export function blockedReason(option: ExceptionTransition): string | null {
  return option.allowed ? null : `Needs ${rolesLabel(option.roles)}`;
}

/** "Acknowledge", "Resolve", "Won't fix". */
export function transitionLabel(command: ExceptionCommand): string {
  return commandLabel(command);
}

/** What a command did, from the exception as the API answered it. */
export function commandResult(
  command: ExceptionCommand | 'set_ticket',
  after: Pick<DataException, 'owner' | 'externalTicket' | 'state'>,
): string {
  switch (command) {
    case 'acknowledge':
      return after.owner === null ? 'Acknowledged' : `Acknowledged, taken by ${after.owner}`;
    case 'resolve':
      return 'Resolved';
    case 'wont_fix':
      return "Closed as won't fix";
    case 'set_ticket':
      return after.externalTicket === null
        ? 'Ticket cleared'
        : `Ticket ${after.externalTicket} noted`;
  }
}

/** The ticket a form may send: one line of 1 to 64 characters (packages/contracts externalTicket). */
export const MAX_TICKET_LENGTH = 64;

export function isTicket(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_TICKET_LENGTH;
}

/** The exceptions of one staged file, when the page was opened from a run or a file. */
export function filterByFile(items: readonly DataException[], fileId: string): DataException[] {
  return items.filter((x) => x.context.intakeFileId === fileId);
}

/** "3 of 12 exceptions": what the queue card says of its rows. */
export function queueCountLine(shown: number, total: number): string {
  return `${shown} of ${total} exception${total === 1 ? '' : 's'}`;
}
