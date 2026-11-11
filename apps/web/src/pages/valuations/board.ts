import {
  API_PREFIX,
  canonicalJson,
  decimalString,
  positiveMoney,
  ROUTES,
  valuationBatchCommand,
} from '@pb/contracts';
import type {
  InvestmentSummary,
  ValuationApproval,
  ValuationBatchCommand,
  ValuationDetail,
  ValuationRow,
  ValuationState,
  ValuationStoredInputs,
  VehicleSummary,
} from '@pb/contracts';
import { valuationMachine } from '@pb/workflows';
import definitions from '../../../../../config/definitions.json';
import type { InvestmentFilters } from '../../app/queries.js';
import { formatDate, formatPct, MISSING } from '../../lib/format.js';

/** Fair value change at or above this share of the prior Locked mark is flagged (config/definitions.json). */
export const VARIANCE_FLAG: number = definitions.valuationVarianceFlag;

export const VARIANCE_TITLE = `Above the ${formatPct(String(VARIANCE_FLAG))} flag (config/definitions.json)`;

/**
 * Active positions, with exactly the filters the analytics exposure tab sends, so both pages share
 * one cache entry and the preview recorder one response per user.
 */
export const ACTIVE_POSITIONS: InvestmentFilters = { active: 'true', limit: 200 };

/** The five states in the order of docs/18 section 1. */
export const VALUATION_STATES: readonly ValuationState[] = valuationMachine.states;

/** Versions on their way to Locked: someone still has to prepare, approve or lock them. */
export const IN_FLIGHT_STATES: readonly ValuationState[] = [
  'Draft',
  'OpsPrepared',
  'DealTeamApproved',
];

/** Period ends latest first (ISO dates sort as text), whatever order they arrive in. */
export function latestFirst(periods: readonly string[]): string[] {
  return [...new Set(periods)].sort().reverse();
}

export function isValuationState(value: string): value is ValuationState {
  return (VALUATION_STATES as readonly string[]).includes(value);
}

/** True when the change against the prior Locked mark is at or above the configured flag. */
export function aboveVarianceFlag(changePct: string | null): boolean {
  if (changePct === null) return false;
  const n = Number(changePct);
  return Number.isFinite(n) && Math.abs(n) >= VARIANCE_FLAG;
}

/** "2025-08-09T15:00:00Z" to "Aug 9, 2025"; the missing placeholder when not approved. */
export function approvedOn(approvedAt: string | null): string {
  if (approvedAt === null) return MISSING;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(approvedAt);
  return m === null ? MISSING : formatDate(m[1]);
}

/** "Cobalt Energy Group, Jun 30, 2025 v1": how messages and buttons name a version. */
export function versionLabel(
  row: Pick<ValuationRow, 'companyName' | 'periodEnd' | 'version'>,
): string {
  return `${row.companyName}, ${formatDate(row.periodEnd)} v${row.version}`;
}

export interface PeriodCounts {
  locked: number;
  inFlight: number;
  reopened: number;
}

/**
 * Version counts for one quarter (counts of rows, never money). The board works in quarters: a
 * sponsor reporting a few days before the quarter end counts for that quarter (quarterEnd, the
 * API's rule), so its mark is neither missing nor a period of its own.
 */
export function periodCounts(rows: readonly ValuationRow[], period: string): PeriodCounts {
  const counts: PeriodCounts = { locked: 0, inFlight: 0, reopened: 0 };
  for (const r of rows) {
    if (r.quarterEnd !== period) continue;
    if (r.state === 'Locked') counts.locked += 1;
    else if (r.state === 'Reopened') counts.reopened += 1;
    else counts.inFlight += 1;
  }
  return counts;
}

const byNumber = (a: InvestmentSummary, b: InvestmentSummary): number =>
  a.investmentNumber.localeCompare(b.investmentNumber);

/**
 * Active positions held at the quarter end with no valuation version of any state for the
 * quarter, in investment number order. A position entered after the quarter end has no mark to
 * miss.
 */
export function missingMarks(
  active: readonly InvestmentSummary[],
  rows: readonly ValuationRow[],
  period: string,
): InvestmentSummary[] {
  const marked = new Set(rows.filter((r) => r.quarterEnd === period).map((r) => r.investmentId));
  return active.filter((i) => i.entryDate <= period && !marked.has(i.id)).sort(byNumber);
}

/** A version as the one-chain-per-quarter rule reads it: its state and version number. */
export interface QuarterVersion {
  state: string;
  version: number;
}

/** Whether a version is still being worked on (docs/18 section 1). */
export function isInFlight(state: string): boolean {
  return (IN_FLIGHT_STATES as readonly string[]).includes(state);
}

/** A Locked version with no Reopened version after it: the quarter is closed to new drafts. */
export function closedByLock(versions: readonly QuarterVersion[]): boolean {
  return versions.some(
    (locked) =>
      locked.state === 'Locked' &&
      !versions.some((v) => v.version > locked.version && v.state === 'Reopened'),
  );
}

/**
 * Whether a new version may start from these versions of one investment and quarter (docs/18
 * section 1, the rule the preview applies and the API will): nothing in flight and no Locked
 * version without a reopen after it. An empty quarter is open, a reopened one is open until its
 * new draft starts, a locked one needs a reopen first.
 */
export function openForNewVersion(versions: readonly QuarterVersion[]): boolean {
  return !versions.some((v) => isInFlight(v.state)) && !closedByLock(versions);
}

/**
 * Active positions a new version may start for in the quarter, in investment number order: held
 * at the quarter end and open under the rule above. Needs the full version list for the quarter.
 */
export function startablePositions(
  active: readonly InvestmentSummary[],
  rows: readonly ValuationRow[],
  period: string,
): InvestmentSummary[] {
  return active
    .filter(
      (i) =>
        i.entryDate <= period &&
        openForNewVersion(rows.filter((r) => r.investmentId === i.id && r.quarterEnd === period)),
    )
    .sort(byNumber);
}

export interface BoardFilters {
  period: string;
  state: ValuationState | '';
  vehicle: string;
  search: string;
}

/** The rows the table shows: one quarter, then state, vehicle and a search over number and company. */
export function filterRows(rows: readonly ValuationRow[], f: BoardFilters): ValuationRow[] {
  const needle = f.search.trim().toLowerCase();
  return rows
    .filter(
      (r) =>
        r.quarterEnd === f.period &&
        (f.state === '' || r.state === f.state) &&
        (f.vehicle === '' || r.vehicleName === f.vehicle) &&
        (needle === '' ||
          r.investmentNumber.toLowerCase().includes(needle) ||
          r.companyName.toLowerCase().includes(needle)),
    )
    .sort((a, b) => a.investmentNumber.localeCompare(b.investmentNumber) || b.version - a.version);
}

/** Distinct valuation method codes present in the loaded rows, for the new valuation form. */
export function methodCodes(rows: readonly ValuationRow[]): string[] {
  return [...new Set(rows.map((r) => r.method))].sort();
}

/**
 * The method of a position's most recent version (latest period, then highest version), so a new
 * valuation starts from the method the position was last marked with; null when it has none.
 */
export function lastMethodOf(rows: readonly ValuationRow[], investmentId: string): string | null {
  let best: ValuationRow | null = null;
  for (const r of rows) {
    if (r.investmentId !== investmentId) continue;
    if (
      best === null ||
      r.periodEnd > best.periodEnd ||
      (r.periodEnd === best.periodEnd && r.version > best.version)
    )
      best = r;
  }
  return best === null ? null : best.method;
}

/** Vehicle names for the filter: the vehicle list when it loaded, otherwise the names on the rows. */
export function vehicleNames(
  vehicles: readonly VehicleSummary[] | undefined,
  rows: readonly ValuationRow[],
): string[] {
  const names =
    vehicles === undefined ? rows.map((r) => r.vehicleName) : vehicles.map((v) => v.name);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * A decimal amount as a form takes it: digits with an optional decimal point (the decimalString
 * contract, never negative). The pipeline's amount fields read it (pages/pipeline/pipeline.ts);
 * a valuation's fair value is held to the stricter fairValueProblem below.
 */
export function isFairValue(text: string): boolean {
  return !text.startsWith('-') && decimalString.safeParse(text).success;
}

/* ---- The fair value and the method inputs as the forms take them ---- */

/**
 * Why the contract would refuse a fair value typed into a form, in the contract's own words
 * (positiveMoney: above zero, at most 18 digits before the decimal point and two after, the
 * value the column stores exactly as sent); null for a value the API takes. The new valuation
 * and the edit forms share it, so both refuse what the API would refuse and say the same.
 */
export function fairValueProblem(text: string): string | null {
  const parsed = positiveMoney.safeParse(text);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Not a valid amount');
}

/** One method input as a form row: its name and its value as text. */
export interface InputEntry {
  name: string;
  value: string;
}

const isPlainInput = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/**
 * The stored method inputs as form rows, by name; null when one of them is neither text nor a
 * number (a version loaded another way may hold a nested value): the edit body carries text and
 * numbers only and replaces the inputs whole, so such inputs are shown and left as they are.
 */
export function inputEntries(inputs: ValuationStoredInputs): InputEntry[] | null {
  const rows: InputEntry[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (!isPlainInput(value)) return null;
    rows.push({ name, value: String(value) });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** A number the way it is written, with nothing a float could have changed: 12 and 0.125, never 11.50 or twenty digits. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * A typed value as the contract carries it. A row that still reads as the stored value keeps
 * that value, so text stays text and a number stays a number across an edit that did not touch
 * it. A retyped value is a number only when it is written exactly as that number reads; anything
 * else, a padded or a very long figure included, is kept as the text typed.
 */
function inputValue(text: string, stored: unknown): string | number {
  if (isPlainInput(stored) && String(stored) === text) return stored;
  return PLAIN_NUMBER.test(text) && String(Number(text)) === text ? Number(text) : text;
}

/** The form rows as the inputs record an edit sends: names and values trimmed, rows left empty dropped. */
export function inputsFromEntries(
  entries: readonly InputEntry[],
  stored: ValuationStoredInputs,
): Record<string, string | number> {
  const record: Record<string, string | number> = {};
  for (const entry of entries) {
    const name = entry.name.trim();
    const value = entry.value.trim();
    if (name === '' && value === '') continue;
    record[name] = inputValue(value, stored[name]);
  }
  return record;
}

/** What the contract would refuse in the rows, in plain words; null when they make a valid record. */
export function inputEntriesProblem(entries: readonly InputEntry[]): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.trim();
    if (name === '' && entry.value.trim() === '') continue;
    if (name === '') return 'Give each input a name, or clear its value.';
    if (name.length > 100) return 'An input name can be up to 100 characters.';
    if (seen.has(name)) return `Use each input name once: ${name} is there twice.`;
    seen.add(name);
  }
  return null;
}

/** Whether two inputs records hold the same names and values, whatever order they list them in. */
export function sameInputs(a: ValuationStoredInputs, b: ValuationStoredInputs): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * What an edit changed, in words for the result line: "the fair value", "the method and the
 * inputs", "the method, the fair value and the inputs".
 */
export function changedParts(body: {
  method?: unknown;
  fairValue?: unknown;
  inputs?: unknown;
}): string {
  const parts = [
    ...(body.method !== undefined ? ['the method'] : []),
    ...(body.fairValue !== undefined ? ['the fair value'] : []),
    ...(body.inputs !== undefined ? ['the inputs'] : []),
  ];
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}

/** Roles the route table admits to the edit of a Draft (PATCH /valuations/{id}). */
export const EDIT_ROLES: readonly string[] =
  ROUTES.find((r) => r.method === 'PATCH' && r.path === `${API_PREFIX}/valuations/{id}`)?.roles ??
  [];

export function canEditDraft(roles: readonly string[]): boolean {
  return roles.some((r) => EDIT_ROLES.includes(r));
}

/* ---- The batch approval screen (docs/04 M10) ---- */

/** One batch command the signed-in roles may run: the transition row it stands for. */
export interface BatchPlan {
  command: ValuationBatchCommand;
  from: ValuationState;
  to: ValuationState;
  roles: readonly string[];
}

/**
 * The batch commands the roles may issue, from the transition table: the deal team approves
 * Ops prepared versions and an approver locks Deal team approved ones (never a send back or a
 * reopen, which need a reason each). Empty for every other role, so the board shows no checkbox.
 */
export function batchPlans(roles: readonly string[]): BatchPlan[] {
  const plans: BatchPlan[] = [];
  for (const t of valuationMachine.transitions) {
    const command = valuationBatchCommand.safeParse(t.command);
    if (!command.success || !t.roles.some((r) => roles.includes(r))) continue;
    plans.push({ command: command.data, from: t.from, to: t.to, roles: t.roles });
  }
  return plans;
}

/** The plan a row may join (its state is the plan's starting state), if any. */
export function batchPlanFor(
  row: Pick<ValuationRow, 'state'>,
  plans: readonly BatchPlan[],
): BatchPlan | undefined {
  return plans.find((p) => p.from === row.state);
}

/** "Approve selected" or "Lock selected": the batch bar's button words. */
export function batchLabel(command: ValuationBatchCommand): string {
  return command === 'lock' ? 'Lock selected' : 'Approve selected';
}

/* ---- The version screen ---- */

/** The steps of docs/18 section 1 in order; Reopened sits after Locked and has every step behind it. */
export const VALUATION_STEPS: readonly ValuationState[] = [
  'Draft',
  'OpsPrepared',
  'DealTeamApproved',
  'Locked',
];

export type StepStatus = 'done' | 'current' | 'upcoming';

/** A person named on a version for a step, with the time where the version carries one. */
export interface SignOff {
  step: ValuationApproval['step'];
  by: string;
  at: string | null;
}

type Signed = Pick<
  ValuationDetail,
  'state' | 'approvals' | 'preparedBy' | 'dealTeamApprovedBy' | 'approvedBy' | 'approvedAt'
>;

/** The step a version in each state has behind it: how many of the three sign-offs it has had. */
const STEPS_PASSED: Readonly<Record<ValuationState, number>> = {
  Draft: 0,
  OpsPrepared: 1,
  DealTeamApproved: 2,
  Locked: 3,
  Reopened: 3,
};

/**
 * The people named on a version that holds no decision rows: who prepared it, who approved it
 * for the deal team and who locked it, with the lock time. A version loaded with its sign-offs
 * (the seeded history, an import) has the names on the version and no step-by-step rows, so the
 * screen shows the names rather than "no decisions". Only the steps the version's state has
 * behind it count: a Draft may already name a preparer (a staged weekly value made it, or it was
 * sent back) without having been prepared. Empty when the version has decision rows (they say
 * who, when and why) or names nobody.
 */
export function signOffsOf(detail: Signed): SignOff[] {
  if (detail.approvals.length > 0) return [];
  const named: [ValuationApproval['step'], string | null, string | null][] = [
    ['ops_prepared', detail.preparedBy, null],
    ['deal_team', detail.dealTeamApprovedBy, null],
    ['final', detail.approvedBy, detail.approvedAt],
  ];
  return named
    .slice(0, STEPS_PASSED[detail.state])
    .flatMap(([step, by, at]) => (by === null ? [] : [{ step, by, at }]));
}

/** Who locked the version: the final approval of its trail, else the approver named on the version once it carries a lock time; null while it is not locked. */
export function lockedBy(detail: Signed): string | null {
  const final = detail.approvals.find((a) => a.step === 'final' && a.decision === 'approve');
  if (final !== undefined) return final.actorName;
  return detail.approvedAt === null ? null : detail.approvedBy;
}

/** Each step as done, current or upcoming for a version in the given state. */
export function valuationSteps(
  state: ValuationState,
): { state: ValuationState; status: StepStatus }[] {
  const at = state === 'Reopened' ? VALUATION_STEPS.length : VALUATION_STEPS.indexOf(state);
  return VALUATION_STEPS.map((s, i) => ({
    state: s,
    status: i < at ? 'done' : i === at ? 'current' : 'upcoming',
  }));
}
