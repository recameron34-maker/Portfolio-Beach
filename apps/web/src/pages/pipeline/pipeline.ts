import { D, ZERO } from '@pb/calc';
import { API_PREFIX, isoDate, ROUTES } from '@pb/contracts';
import type {
  AllocationRow,
  AllocationsPutBody,
  AllocationTieOut,
  ClosingItem,
  ClosingSummary,
  DealStage,
  DiligenceTask,
  IcDecision,
  LegalTerm,
  OpportunityGates,
  OpportunityRow,
  Person,
  Taxonomy,
} from '@pb/contracts';
import { dealStageMachine } from '@pb/workflows';
import definitions from '../../../../../config/definitions.json';
import type { Tone } from '../../components/ui.js';
import { formatMoneyM, labelOf, MISSING, plural } from '../../lib/format.js';
import { isFairValue } from '../valuations/board.js';

/*
 * Pure helpers for the pipeline pages (docs/04 M5, M8, M22; docs/18 sections 4 and 12). No
 * components here: the pages render what these decide, and the tests beside this file prove the
 * decisions without a DOM.
 */

/** The nine stages in the order of docs/18 section 4, Passed last; the board shows one column each. */
export const STAGES: readonly DealStage[] = dealStageMachine.states;

/** The stages a live deal moves through in order (every stage but Passed): the progress strip. */
export const LIVE_STAGES: readonly DealStage[] = STAGES.filter((s) => s !== 'Passed');

export function isDealStage(value: string): value is DealStage {
  return (STAGES as readonly string[]).includes(value);
}

/**
 * Days an opportunity may sit in a stage before it reads as aging (config/definitions.json
 * pipeline.stageAgingDays). Closed and Passed carry no entry: a settled deal never ages.
 */
export const STAGE_AGING_DAYS: Readonly<Partial<Record<DealStage, number>>> =
  definitions.pipeline.stageAgingDays;

export function isAging(stage: DealStage, daysInStage: number): boolean {
  const limit = STAGE_AGING_DAYS[stage];
  return limit !== undefined && daysInStage > limit;
}

/** Aging reads as watch (someone's attention); within the guide it needs nobody. */
export function agingTone(stage: DealStage, daysInStage: number): Tone {
  return isAging(stage, daysInStage) ? 'watch' : 'neutral';
}

export function daysInStageLabel(daysInStage: number): string {
  return `${plural(daysInStage, 'day')} in stage`;
}

/** Why a card reads as aging, for its title; null while it sits within the guide. */
export function agingHint(stage: DealStage, daysInStage: number): string | null {
  const limit = STAGE_AGING_DAYS[stage];
  if (limit === undefined || daysInStage <= limit) return null;
  return `Over the ${limit}-day guide for ${stage} (config pipeline.stageAgingDays)`;
}

export interface PipelineFilters {
  /** The deal lead's user id; '' for every owner. */
  ownerId: string;
  /** A deal_type code; '' for every type. */
  dealType: string;
}

export function filterOpportunities(
  rows: readonly OpportunityRow[],
  f: PipelineFilters,
): OpportunityRow[] {
  return rows.filter(
    (r) =>
      (f.ownerId === '' || r.owner?.id === f.ownerId) &&
      (f.dealType === '' || r.dealType === f.dealType),
  );
}

/** Rows per stage column, every stage present; the longest in its stage first, then by name. */
export function groupByStage(rows: readonly OpportunityRow[]): Map<DealStage, OpportunityRow[]> {
  const columns = new Map<DealStage, OpportunityRow[]>(STAGES.map((s) => [s, []]));
  for (const r of rows) columns.get(r.stage)?.push(r);
  for (const list of columns.values())
    list.sort((a, b) => b.daysInStage - a.daysInStage || a.name.localeCompare(b.name));
  return columns;
}

/** The deal leads named on the rows, once each, by name. */
export function ownerOptions(rows: readonly OpportunityRow[]): Person[] {
  const byId = new Map<string, Person>();
  for (const r of rows) if (r.owner !== null) byId.set(r.owner.id, r.owner);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Distinct deal type codes on the rows, ordered by their label. */
export function dealTypeOptions(rows: readonly OpportunityRow[]): string[] {
  return [...new Set(rows.map((r) => r.dealType))].sort((a, b) =>
    labelOf(a).localeCompare(labelOf(b)),
  );
}

export type StepStatus = 'done' | 'current' | 'upcoming';

/**
 * The progress strip over the live stages: every stage before the current one is done, the rest
 * are still to come. A Passed deal sits on none of them (its header says Passed and why).
 */
export function stageSteps(stage: DealStage): { stage: DealStage; status: StepStatus }[] {
  const at = LIVE_STAGES.indexOf(stage);
  return LIVE_STAGES.map((s, i) => ({
    stage: s,
    status: at < 0 || i > at ? 'upcoming' : i === at ? 'current' : 'done',
  }));
}

/** The stage `advance` moves to from this one; null from Closed and Passed. */
export function nextStage(stage: DealStage): DealStage | null {
  const t = dealStageMachine.transitions.find((x) => x.from === stage && x.command === 'advance');
  return t === undefined ? null : t.to;
}

export interface GateLine {
  key: 'diligence' | 'ic' | 'checklist' | 'tieOut';
  ok: boolean;
  text: string;
}

/** The four gates of docs/18 section 4 as sentences, each saying whether it is clear and what clears it. */
export function gateLines(gates: OpportunityGates, hasClosing: boolean): GateLine[] {
  const open = gates.diligence.requiredOpen;
  return [
    {
      key: 'diligence',
      ok: gates.diligence.ok,
      text: gates.diligence.ok
        ? 'Every diligence task required for IC is done or waived.'
        : `${plural(open, 'diligence task')} required for IC ${open === 1 ? 'is' : 'are'} still open; the advance to IC waits for them (an approver may override with a reason).`,
    },
    {
      key: 'ic',
      ok: gates.icDecision.ok,
      text: gates.icDecision.ok
        ? 'An IC decision is recorded.'
        : 'No IC decision is recorded; the advance from IC waits for one.',
    },
    {
      key: 'checklist',
      ok: gates.closing.checklistComplete,
      text: !hasClosing
        ? 'No closing record yet: it opens when the deal advances from Approved with a close date and a commitment.'
        : gates.closing.checklistComplete
          ? 'Every required closing item is received or waived.'
          : 'A required closing item is still open (M8).',
    },
    {
      key: 'tieOut',
      ok: gates.closing.allocationTiedOut,
      text: !hasClosing
        ? 'The allocation tie-out starts once the closing record exists.'
        : gates.closing.allocationTiedOut
          ? 'Allocations tie to the closing commitment.'
          : 'Allocations do not tie to the closing commitment (M22).',
    },
  ];
}

/**
 * The rule that blocks an advance from this stage for these roles, or null when the gates are
 * clear (docs/18 section 4). The API and the machine decide for real; this names the rule on the
 * disabled button before anyone tries.
 */
export function advanceBlocker(
  stage: DealStage,
  gates: OpportunityGates,
  roles: readonly string[],
): string | null {
  switch (stage) {
    case 'Diligence': {
      if (gates.diligence.ok || roles.includes('approver')) return null;
      return `${plural(gates.diligence.requiredOpen, 'diligence task')} required for IC still open; an approver may override with a reason`;
    }
    case 'IC':
      return gates.icDecision.ok ? null : 'An IC decision record is required';
    case 'Closing': {
      const reasons: string[] = [];
      if (!gates.closing.checklistComplete) reasons.push('the closing checklist is incomplete');
      if (!gates.closing.allocationTiedOut)
        reasons.push('allocations do not tie to the closing commitment (M22)');
      return reasons.length === 0 ? null : capitalize(reasons.join('; '));
    }
    case 'Sourced':
    case 'Screening':
    case 'Prescreen':
    case 'Approved':
    case 'Closed':
    case 'Passed':
      return null;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Short by $0.5M" inside a sentence: only the first letter changes, the unit keeps its case. */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/* Status tones (docs/06: one meaning per colour, the badge always carries the word). */

/** A task required for IC that is still open waits on someone; done is settled; waived or optional open needs nobody. */
export function taskStatusTone(task: Pick<DiligenceTask, 'status' | 'requiredForIc'>): Tone {
  if (task.status === 'done') return 'good';
  return task.status === 'open' && task.requiredForIc ? 'watch' : 'neutral';
}

/** A required checklist item still open blocks the confirmation; received is settled; waived or optional open needs nobody. */
export function itemStatusTone(item: Pick<ClosingItem, 'status' | 'required'>): Tone {
  if (item.status === 'received') return 'good';
  return item.status === 'open' && item.required ? 'watch' : 'neutral';
}

const DECISION_TONES: Readonly<Record<IcDecision['decision'], Tone>> = {
  approved: 'good',
  declined: 'bad',
  deferred: 'watch',
};

export function decisionTone(decision: IcDecision['decision']): Tone {
  return DECISION_TONES[decision];
}

/** A draft term waits for someone to confirm it against its source; confirmed is settled. */
export function termStatusTone(status: LegalTerm['status']): Tone {
  return status === 'confirmed' ? 'good' : 'watch';
}

/** "Tied out", "Short by $0.5M" or "Over by $0.5M" against the closing commitment (M22). */
export function tieOutLabel(t: AllocationTieOut): string {
  if (t.tiedOut) return 'Tied out';
  const short = t.difference.startsWith('-');
  const size = formatMoneyM(short ? t.difference.slice(1) : t.difference);
  return short ? `Short by ${size}` : `Over by ${size}`;
}

export function tieOutTone(t: AllocationTieOut): Tone {
  return t.tiedOut ? 'good' : 'bad';
}

/** One row of the allocations editor as typed: ids from the pickers, amounts as text. */
export interface AllocationLine {
  vehicleId: string;
  clientId: string;
  requested: string;
  received: string;
}

export function linesOf(rows: readonly AllocationRow[]): AllocationLine[] {
  return rows.map((r) => ({
    vehicleId: r.vehicle.id,
    clientId: r.client?.id ?? '',
    requested: r.requested,
    received: r.received ?? '',
  }));
}

/** An amount as the form takes it: digits with an optional decimal point, never negative. */
export function isAmount(text: string): boolean {
  return isFairValue(text.trim());
}

/** An amount above zero (a commitment, a target): the contract's positiveDecimal. */
export function isPositiveAmount(text: string): boolean {
  return isAmount(text) && /[1-9]/.test(text);
}

/** A line the API would accept: a vehicle, a requested amount and, when typed, a received one. */
export function isCompleteLine(line: AllocationLine): boolean {
  return (
    line.vehicleId !== '' &&
    isAmount(line.requested) &&
    (line.received.trim() === '' || isAmount(line.received))
  );
}

/**
 * The allocated total as the API ties it out (received when known, otherwise requested), to two
 * places; null while a line is incomplete, so the editor shows the placeholder, never a guess.
 */
export function allocatedTotal(lines: readonly AllocationLine[]): string | null {
  if (!lines.every(isCompleteLine)) return null;
  return lines
    .reduce(
      (sum, l) => sum.plus(D(l.received.trim() === '' ? l.requested.trim() : l.received.trim())),
      ZERO,
    )
    .toFixed(2);
}

/** The PUT body for the typed lines; every line must be complete (isCompleteLine) first. */
export function allocationsBody(lines: readonly AllocationLine[]): AllocationsPutBody {
  return {
    allocations: lines.map((l) => ({
      vehicleId: l.vehicleId,
      ...(l.clientId === '' ? {} : { clientId: l.clientId }),
      requested: l.requested.trim(),
      ...(l.received.trim() === '' ? {} : { received: l.received.trim() }),
    })),
  };
}

/** What stops the operations confirmation, in words (docs/18 section 12); empty when nothing does. */
export function closingBlockers(
  summary: Pick<ClosingSummary, 'itemsRequiredOpen' | 'allocationTieOut'>,
): string[] {
  const out: string[] = [];
  if (summary.itemsRequiredOpen > 0)
    out.push(
      `${plural(summary.itemsRequiredOpen, 'required closing item')} still open: a required closing document is missing (M8)`,
    );
  if (!summary.allocationTieOut.tiedOut)
    out.push(
      `Allocations do not tie to the closing commitment, ${lowerFirst(tieOutLabel(summary.allocationTieOut))} (M22)`,
    );
  return out;
}

/** The IC conditions as typed, one per line; blank lines dropped. */
export function conditionsFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** A legal term's fields as one line: "rate: 2%; basis: committed capital". */
export function termValueText(value: Readonly<Record<string, string | number | boolean>>): string {
  const parts = Object.entries(value).map(([k, v]) => `${k}: ${String(v)}`);
  return parts.length === 0 ? MISSING : parts.join('; ');
}

/** The term's fields as typed in the add form: a name and a value per row, both plain text. */
export interface TermField {
  name: string;
  value: string;
}

/** The value object of a term from its typed rows; rows with no name are dropped. */
export function termValueOf(fields: readonly TermField[]): Record<string, string> {
  const value: Record<string, string> = {};
  for (const f of fields) {
    const name = f.name.trim();
    if (name !== '') value[name] = f.value.trim();
  }
  return value;
}

export function personName(p: Person | null): string {
  return p === null ? MISSING : p.name;
}

/** A date as the form takes it (an input of type date gives yyyy-mm-dd). */
export function isIsoDate(text: string): boolean {
  return isoDate.safeParse(text).success;
}

/** The active terms of a taxonomy domain in their sort order, for a picker. */
export function termsOf(
  taxonomy: Taxonomy | undefined,
  domain: string,
): { code: string; label: string }[] {
  const found = taxonomy?.domains.find((d) => d.domain === domain);
  if (found === undefined) return [];
  return found.terms
    .filter((t) => t.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => ({ code: t.code, label: t.label }));
}

/** Roles a route admits, read from the contract's route table so the list lives in one place. */
export function routeRoles(method: string, path: string): readonly string[] {
  return ROUTES.find((r) => r.method === method && r.path === `${API_PREFIX}${path}`)?.roles ?? [];
}

/** True when the signed-in roles may use a route; an empty role list means any signed-in user. */
export function mayUse(actorRoles: readonly string[], allowed: readonly string[]): boolean {
  return allowed.length === 0 || actorRoles.some((r) => allowed.includes(r));
}

/** The write routes the pipeline pages gate their forms on. */
export const PIPELINE_ROLES = {
  createOpportunity: routeRoles('POST', '/opportunities'),
  createTask: routeRoles('POST', '/opportunities/{id}/diligence-tasks'),
  taskCommand: routeRoles('POST', '/opportunities/{id}/diligence-tasks/{taskId}/commands'),
  icDecision: routeRoles('POST', '/opportunities/{id}/ic-decisions'),
  allocations: routeRoles('PUT', '/opportunities/{id}/allocations'),
  closingItem: routeRoles('POST', '/closings/{id}/items/{itemCode}/commands'),
  closingCommand: routeRoles('POST', '/closings/{id}/commands'),
  legalTerm: routeRoles('POST', '/closings/{id}/legal-terms'),
  legalTermCommand: routeRoles('POST', '/closings/{id}/legal-terms/{termId}/commands'),
} as const;
