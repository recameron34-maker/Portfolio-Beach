import { addDays, containingQuarterEnd, latestQuarterEndOnOrBefore } from '@pb/calc';
import { API_PREFIX, changeRequestCreateBody, ROUTES } from '@pb/contracts';
import type { ChangeRequestRow, ChangeRequestState, MockUser } from '@pb/contracts';
import { dealChangeRequestMachine } from '@pb/workflows';
import { labelOf } from '../../lib/format.js';

/*
 * Pure helpers of the deal change requests (docs/04 M11, docs/18 section 8): the states, the
 * queue's counts and filters, who may submit, route and run the quarter-end check (from the
 * route table, so the lists live in one place), the owner picker's choices, the quarter ends a
 * request may be applied in, and the form's validation through the contract itself. Nothing
 * here reads the network or the DOM.
 */

/** The five states in the order of docs/18 section 8. */
export const CHANGE_REQUEST_STATES: readonly ChangeRequestState[] = dealChangeRequestMachine.states;

export function isChangeRequestState(value: string): value is ChangeRequestState {
  return (CHANGE_REQUEST_STATES as readonly string[]).includes(value);
}

/** Requests still to be applied: the quarter-end check lists every one of these (M11). */
export const OPEN_STATES: readonly ChangeRequestState[] = ['Submitted', 'Routed', 'InProgress'];

export function isOpenRequest(state: ChangeRequestState): boolean {
  return OPEN_STATES.includes(state);
}

/** "Add-on acquisition for Meridian Data Partners": how messages and buttons name a request. */
export function requestLabel(row: Pick<ChangeRequestRow, 'changeType' | 'investmentName'>): string {
  return `${labelOf(row.changeType)} for ${row.investmentName}`;
}

export interface ChangeRequestCounts {
  submitted: number;
  routed: number;
  inProgress: number;
  applied: number;
  rejected: number;
}

/** Counts of requests per state (counts of rows, never money). */
export function requestCounts(rows: readonly ChangeRequestRow[]): ChangeRequestCounts {
  const counts: ChangeRequestCounts = {
    submitted: 0,
    routed: 0,
    inProgress: 0,
    applied: 0,
    rejected: 0,
  };
  for (const r of rows) {
    if (r.state === 'Submitted') counts.submitted += 1;
    else if (r.state === 'Routed') counts.routed += 1;
    else if (r.state === 'InProgress') counts.inProgress += 1;
    else if (r.state === 'Applied') counts.applied += 1;
    else counts.rejected += 1;
  }
  return counts;
}

export interface QueueFilters {
  state: ChangeRequestState | '';
  investmentId: string;
}

/** The rows the queue shows: state and position filters over one page, newest first (the API's order kept). */
export function filterRequests(
  rows: readonly ChangeRequestRow[],
  f: QueueFilters,
): ChangeRequestRow[] {
  return rows.filter(
    (r) =>
      (f.state === '' || r.state === f.state) &&
      (f.investmentId === '' || r.investmentId === f.investmentId),
  );
}

export interface NamedOption {
  id: string;
  name: string;
}

/** The positions named on the loaded rows, once each, by name. */
export function investmentOptions(rows: readonly ChangeRequestRow[]): NamedOption[] {
  const seen = new Map<string, string>();
  for (const r of rows) if (!seen.has(r.investmentId)) seen.set(r.investmentId, r.investmentName);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

const routeOf = (method: string, path: string) =>
  ROUTES.find((r) => r.method === method && r.path === `${API_PREFIX}${path}`);

/** Roles the route table admits to each change request route; an empty list would mean any signed-in user. */
export const QUEUE_ROLES: readonly string[] = routeOf('GET', '/change-requests')?.roles ?? [];
export const SUBMIT_ROLES: readonly string[] = routeOf('POST', '/change-requests')?.roles ?? [];
export const QUARTER_END_CHECK_ROLES: readonly string[] =
  routeOf('POST', '/change-requests/quarter-end-check')?.roles ?? [];

const holdsOne = (roles: readonly string[], admitted: readonly string[]): boolean =>
  admitted.length === 0 || roles.some((r) => admitted.includes(r));

export function canReadQueue(roles: readonly string[]): boolean {
  return holdsOne(roles, QUEUE_ROLES);
}

export function canSubmitRequest(roles: readonly string[]): boolean {
  return holdsOne(roles, SUBMIT_ROLES);
}

export function canRunQuarterEndCheck(roles: readonly string[]): boolean {
  return holdsOne(roles, QUARTER_END_CHECK_ROLES);
}

/**
 * Who a request may be routed to: the operations users of the mock user list (those the list
 * names with an id), plus any owner already named on a loaded row (an operations user by the
 * API's rule). By name, each person once.
 */
export function ownerCandidates(
  users: readonly MockUser[] | undefined,
  rows: readonly ChangeRequestRow[],
): NamedOption[] {
  const byId = new Map<string, string>();
  for (const u of users ?? [])
    if (u.id !== undefined && u.roles.includes('operations')) byId.set(u.id, u.displayName);
  for (const r of rows)
    if (r.owner !== null && !byId.has(r.owner.id)) byId.set(r.owner.id, r.owner.name);
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The last `count` quarter ends on or before a day, latest first. */
export function recentQuarterEnds(today: string, count: number): string[] {
  const ends: string[] = [];
  let q = latestQuarterEndOnOrBefore(today);
  while (ends.length < count) {
    ends.push(q);
    q = latestQuarterEndOnOrBefore(addDays(q, -1));
  }
  return ends;
}

/**
 * The quarter ends a request may be applied in: the API refuses one before the effective date,
 * so the recent quarter ends from the effective date's own quarter onward, latest first. A
 * request effective after the latest quarter end offers that quarter alone.
 */
export function applicablePeriods(effectiveDate: string, today: string): string[] {
  const floor = containingQuarterEnd(effectiveDate);
  const recent = recentQuarterEnds(today, 8).filter((q) => q >= floor);
  return recent.length === 0 ? [floor] : recent;
}

export interface DetailEntry {
  key: string;
  value: string;
}

/** The form's key and value rows as the contract's details record: trimmed, rows without a key dropped. */
export function detailsRecord(entries: readonly DetailEntry[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const e of entries) {
    const key = e.key.trim();
    if (key !== '') record[key] = e.value.trim();
  }
  return record;
}

/** What each refused field is told, in plain words (the contract's own messages name patterns). */
const FIELD_MESSAGES: Readonly<Record<string, string>> = {
  changeType: 'Choose a change type.',
  effectiveDate: 'Give the effective date.',
  summary: 'Summarize the change in 3 to 200 characters of plain text.',
  details: 'Each detail needs a name of up to 100 characters and a plain-text value.',
};

/**
 * What the contract would refuse in the form, by field, before anything is sent: the same zod
 * body the API parses (changeRequestCreateBody), so the form and the API agree on what a valid
 * request is. Empty when the body is valid.
 */
export function formProblems(body: unknown): Record<string, string> {
  const parsed = changeRequestCreateBody.safeParse(body);
  if (parsed.success) return {};
  const problems: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? 'form');
    problems[field] ??= FIELD_MESSAGES[field] ?? issue.message;
  }
  return problems;
}
