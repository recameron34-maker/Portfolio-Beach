import { isQuarterEnd } from '@pb/calc';
import { API_PREFIX, MONEY_UNITS, ROUTES, valueFitsUnit } from '@pb/contracts';
import type {
  ExtractedValue,
  ExtractionBatch,
  ExtractionBatchState,
  ExtractionDecision,
  ExtractionFieldKind,
  ExtractionRun,
  ExtractionRunCommandBody,
  ExtractionRunDetail,
  ExtractionRunState,
  ExtractionUnit,
  ExtractionValidationState,
  PageLayout,
  Taxonomy,
} from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { describeActionError, plainRule } from '../../app/mutations.js';
import type { Tone } from '../../components/ui.js';
import type { UnavailableReason } from '../../lib/unavailable.js';
import { formatDate, formatPct, MISSING, plural } from '../../lib/format.js';
import { humanizeState, rolesLabel } from '../../lib/states.js';

/*
 * Pure helpers of the extraction pages (docs/04 M4, docs/18 section 7, decision 0012): who may
 * start a batch or review a run (from the route table, never a role list of the page's own),
 * the review order (flagged and invalid first), how a value reads with its unit, the status
 * phrases, the review gates the API also enforces, and the quote search over a page layout for
 * click-to-source.
 */

export const EXTRACTION_META =
  'AI extraction of quarterly figures, reviewed by exception before anything is promoted (SEC-8.4, SEC-9.1)';

/* ---- Roles, from the contract's route table (config over code) ---- */

function rolesOf(method: string, path: string): readonly string[] {
  return ROUTES.find((r) => r.method === method && r.path === path)?.roles ?? [];
}

/** Roles that may start a batch (POST /extraction/batches). */
export const BATCH_ROLES: readonly string[] = rolesOf('POST', `${API_PREFIX}/extraction/batches`);
/** Roles that may review a run (POST /extraction/runs/{id}/commands). */
export const REVIEW_ROLES: readonly string[] = rolesOf(
  'POST',
  `${API_PREFIX}/extraction/runs/{id}/commands`,
);

export function canStartBatch(roles: readonly string[]): boolean {
  return roles.some((r) => BATCH_ROLES.includes(r));
}

export function canReview(roles: readonly string[]): boolean {
  return roles.some((r) => REVIEW_ROLES.includes(r));
}

export const BATCH_READ_ONLY = 'Operations starts extraction batches; your role reads the runs.';
export const REVIEW_READ_ONLY = 'Deal team and operations review runs; your role reads them.';

export const EXTRACTION_FORBIDDEN: UnavailableReason = {
  title: 'Extraction runs are not visible to your role',
  detail:
    'Any signed-in user reads the runs of the documents they may see; ask a platform administrator if you need access.',
};

/* ---- Words and tones ---- */

const RUN_TONES: Readonly<Record<ExtractionRunState, Tone>> = {
  Queued: 'neutral',
  Running: 'watch',
  Succeeded: 'good',
  Failed: 'bad',
  NeedsRetry: 'watch',
};

export function runTone(state: ExtractionRunState): Tone {
  return RUN_TONES[state];
}

/** "NeedsRetry" reads "Needs retry"; the other states are single words. */
export function runStateWord(state: ExtractionRunState): string {
  return humanizeState(state);
}

const BATCH_TONES: Readonly<Record<ExtractionBatchState, Tone>> = {
  queued: 'neutral',
  running: 'watch',
  succeeded: 'good',
  failed: 'bad',
  dead_letter: 'bad',
};

export function batchTone(state: ExtractionBatchState): Tone {
  return BATCH_TONES[state];
}

export function batchStateWord(state: ExtractionBatchState): string {
  return humanizeState(state);
}

export const RUN_STATES: readonly ExtractionRunState[] = [
  'Queued',
  'Running',
  'Succeeded',
  'Failed',
  'NeedsRetry',
];

export function isRunState(value: string): value is ExtractionRunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

const VALIDATION_TONES: Readonly<Record<ExtractionValidationState, Tone>> = {
  clean: 'good',
  flagged: 'watch',
  invalid: 'bad',
};

export function validationTone(state: ExtractionValidationState): Tone {
  return VALIDATION_TONES[state];
}

export function validationWord(state: ExtractionValidationState): string {
  return humanizeState(state);
}

const DECISION_TONES: Readonly<Record<ExtractionDecision, Tone>> = {
  accepted: 'good',
  edited: 'brand',
  rejected: 'bad',
};

export function decisionTone(decision: ExtractionDecision): Tone {
  return DECISION_TONES[decision];
}

export function decisionWord(decision: ExtractionDecision): string {
  return humanizeState(decision);
}

/* ---- The review order: flagged and invalid first, then clean, schema order kept within each group ---- */

const REVIEW_RANK: Readonly<Record<ExtractionValidationState, number>> = {
  flagged: 0,
  invalid: 0,
  clean: 1,
};

export function reviewOrder(values: readonly ExtractedValue[]): ExtractedValue[] {
  return values
    .map((value, index) => ({ value, index }))
    .sort(
      (a, b) =>
        REVIEW_RANK[a.value.validationState] - REVIEW_RANK[b.value.validationState] ||
        a.index - b.index,
    )
    .map((entry) => entry.value);
}

/* ---- How a value reads ---- */

const MONEY_SUFFIX: Readonly<Record<string, string>> = {
  USD: '',
  USD_K: 'K',
  USD_M: 'M',
  USD_B: 'B',
};

export function isMoneyUnit(unit: string | null | undefined): unit is ExtractionUnit {
  return unit !== null && unit !== undefined && (MONEY_UNITS as readonly string[]).includes(unit);
}

/** The unit as a short label for a select: "$M", "%", "count", "date". */
export function unitLabel(unit: ExtractionUnit): string {
  if (isMoneyUnit(unit)) return `$${MONEY_SUFFIX[unit] ?? ''}`;
  if (unit === 'PCT') return '%';
  return unit === 'COUNT' ? 'count' : 'date';
}

/**
 * A value as the document states it, in its own unit: "$125.40M", "42.50%", "Jun 30, 2025",
 * "120"; the missing placeholder when the model answered null. Nothing is converted here: the
 * dollars reach the record only through the promotion, which converts with packages/calc.
 */
export function valueText(
  value: string | null,
  unit: ExtractionUnit | null,
  kind: ExtractionFieldKind,
): string {
  if (value === null || value === '') return MISSING;
  switch (kind) {
    case 'money':
      return isMoneyUnit(unit) ? `$${value}${MONEY_SUFFIX[unit] ?? ''}` : value;
    case 'percent':
      return formatPct(value, 2);
    case 'date':
      return formatDate(value);
    case 'count':
      return value;
  }
}

/** The value a promotion would take: the reviewer's edit in its own unit when there is one, else the model's answer (WF-1). */
export function finalValue(v: ExtractedValue): {
  value: string | null;
  unit: ExtractionUnit | null;
} {
  return v.decision === 'edited' && v.editedValue !== null
    ? { value: v.editedValue, unit: v.editedUnit ?? v.unit }
    : { value: v.value, unit: v.unit };
}

export function finalValueText(v: ExtractedValue): string {
  const final = finalValue(v);
  return valueText(final.value, final.unit, v.kind);
}

/** "100%" from the model's confidence; the missing placeholder when it gave none. */
export function confidenceText(confidence: string | null): string {
  return confidence === null ? MISSING : formatPct(confidence, 0);
}

/** "1 flagged, 2 invalid" for a run's counts; the missing placeholder when both are zero. */
export function flagsText(counts: ExtractionRun['counts']): string {
  const parts: string[] = [];
  if (counts.flagged > 0) parts.push(`${counts.flagged} flagged`);
  if (counts.invalid > 0) parts.push(`${counts.invalid} invalid`);
  return parts.length === 0 ? MISSING : parts.join(', ');
}

export function approvalText(run: ExtractionRun): string {
  if (run.approvedBy !== null) return `Approved by ${run.approvedBy}`;
  if (run.state === 'Succeeded') return 'Awaiting approval';
  return MISSING;
}

export function approvalTone(run: ExtractionRun): Tone {
  if (run.approvedBy !== null) return 'good';
  return run.state === 'Succeeded' ? 'watch' : 'neutral';
}

/** "12 succeeded", "1 failed, 11 succeeded": a batch's runs by state, the non-zero ones only. */
export function runsByState(batch: ExtractionBatch): string {
  const r = batch.runs;
  const parts = [
    r.failed > 0 ? `${r.failed} failed` : null,
    r.needsRetry > 0 ? `${r.needsRetry} needs retry` : null,
    r.running > 0 ? `${r.running} running` : null,
    r.queued > 0 ? `${r.queued} queued` : null,
    r.succeeded > 0 ? `${r.succeeded} succeeded` : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? MISSING : parts.join(', ');
}

export function tokensText(tokensIn: number | null, tokensOut: number | null): string {
  if (tokensIn === null && tokensOut === null) return MISSING;
  return `${tokensIn ?? MISSING} in, ${tokensOut ?? MISSING} out`;
}

/** The cost as the API records it, to four places, never rounded here. */
export function costText(costUsd: string | null): string {
  return costUsd === null ? MISSING : `$${costUsd}`;
}

/* ---- Review gates (the API enforces the same; the page says why a button is off) ---- */

export interface RunGates {
  /** The roles may review and the run is Succeeded and not yet approved. */
  reviewable: boolean;
  /** The roles may review and the run is Failed or NeedsRetry. */
  retryable: boolean;
  /** Why the review buttons are off, or null when they are live. */
  blocked: string | null;
}

export function runGates(run: ExtractionRun, roles: readonly string[]): RunGates {
  const allowed = canReview(roles);
  if (!allowed)
    return { reviewable: false, retryable: false, blocked: `Needs ${rolesLabel(REVIEW_ROLES)}` };
  if (run.approvedBy !== null)
    return {
      reviewable: false,
      retryable: false,
      blocked: 'This run is approved and its figures are promoted',
    };
  const retryable = run.state === 'Failed' || run.state === 'NeedsRetry';
  if (run.state !== 'Succeeded')
    return {
      reviewable: false,
      retryable,
      blocked: `Review needs a Succeeded run; this one is ${runStateWord(run.state).toLowerCase()}`,
    };
  return { reviewable: true, retryable: false, blocked: null };
}

/** Why a value cannot be accepted as it stands: an invalid value can only be edited or rejected. */
export function acceptBlocker(v: ExtractedValue): string | null {
  if (v.validationState !== 'invalid') return null;
  const first = v.findings[0]?.message;
  return `${v.label} is invalid and cannot be accepted${first === undefined ? '' : `: ${first}`}; edit or reject it`;
}

/**
 * The first reason an approval would be refused, in the API's own words (409 review-blocked),
 * or null when every required value is accepted or edited, no invalid value is accepted and no
 * flagged value is undecided.
 */
export function approveBlocker(values: readonly ExtractedValue[]): string | null {
  for (const v of values) {
    if (v.required && v.decision !== 'accepted' && v.decision !== 'edited')
      return `${v.label} is required and not accepted or edited`;
    if (v.validationState === 'invalid' && v.decision !== 'edited' && v.decision !== 'rejected')
      return `${v.label} is invalid and not edited or rejected`;
    if (v.validationState === 'flagged' && v.decision === null)
      return `${v.label} is flagged and undecided`;
  }
  return null;
}

/** Clean values with no decision yet (schema fields; the narrative rows carry no decision in the contract). */
export function undecidedClean(values: readonly ExtractedValue[]): number {
  return values.filter((v) => v.validationState === 'clean' && v.decision === null).length;
}

/* ---- Status phrases (fixed by the wave 3 brief) ---- */

export function batchStartedPhrase(batch: ExtractionBatch): string {
  return `Batch started: ${plural(batch.runs.total, 'run')}`;
}

export function decisionPhrase(label: string, command: 'accept' | 'edit' | 'reject'): string {
  const word = command === 'accept' ? 'accepted' : command === 'edit' ? 'edited' : 'rejected';
  return `${label} ${word}`;
}

export function acceptCleanPhrase(before: ExtractionRun, after: ExtractionRun): string {
  const n = Math.max(0, after.counts.decided - before.counts.decided);
  return `${plural(n, 'clean value')} accepted`;
}

/**
 * The quarter an approval promotes to, chosen as the API chooses it (review.service, finalOf):
 * the period_end row's edited value when the reviewer edited it, the model's answer when it was
 * accepted, and null while it is undecided or rejected (the API refuses the approval then). The
 * run's classified period is the document's, not necessarily the figures', so it stands in only
 * when the run staged no period_end row at all (CLAUDE.md rule 10: never the nearest period).
 */
export function promotedPeriod(detail: ExtractionRunDetail): string | null {
  const row = detail.values.find((v) => v.field === 'period_end');
  if (row === undefined) return detail.run.periodEnd;
  if (row.decision === 'edited') return row.editedValue;
  return row.decision === 'accepted' ? row.value : null;
}

export function approvedPhrase(detail: ExtractionRunDetail): string {
  return `Approved: figures promoted for ${formatDate(promotedPeriod(detail))}`;
}

export function retriedPhrase(detail: ExtractionRunDetail): string {
  return `Retried: the run ${runStateWord(detail.run.state).toLowerCase()}`;
}

/* ---- Errors: the kill switch and a review refusal read as the problem's own sentence ---- */

const PLAIN_PROBLEMS = [
  'kill-switch',
  'review-blocked',
  'workflow-transition',
  'workflow-precondition',
];

/** One sentence from a refusal: the problem's detail for the extraction codes, else the shared mapping. */
export function describeExtractionError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.problem.type.slice(error.problem.type.lastIndexOf('/') + 1);
    if (PLAIN_PROBLEMS.includes(code) && error.problem.detail !== undefined)
      return plainRule(error.problem.detail);
  }
  return describeActionError(error);
}

/* ---- The batch form ---- */

export const DEFAULT_DOC_TYPE = 'doc_type.quarterly_financials';

export interface BatchForm {
  periodEnd: string;
  docType: string;
}

/** Why the form cannot be sent, or null: the period must be a quarter end and a type chosen. */
export function batchFormProblem(form: BatchForm): string | null {
  if (!isQuarterEnd(form.periodEnd.trim()))
    return 'Enter a quarter end as YYYY-MM-DD, for example 2025-06-30.';
  if (form.docType === '') return 'Choose a document type.';
  return null;
}

/** The document types of the taxonomy, active ones, in their sort order. */
export function docTypeOptions(taxonomy: Taxonomy | undefined): { code: string; label: string }[] {
  const domain = taxonomy?.domains.find((d) => d.domain === 'doc_type');
  if (domain === undefined) return [{ code: DEFAULT_DOC_TYPE, label: 'Quarterly financials' }];
  return [...domain.terms]
    .filter((t) => t.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => ({ code: t.code, label: t.label }));
}

/* ---- The edit dialog ---- */

export interface EditForm {
  value: string;
  unit: string;
  reason: string;
}

/** The unit a non-money kind always carries; a money field takes the reviewer's. */
export function naturalUnit(kind: ExtractionFieldKind): ExtractionUnit | null {
  switch (kind) {
    case 'percent':
      return 'PCT';
    case 'count':
      return 'COUNT';
    case 'date':
      return 'DATE';
    case 'money':
      return null;
  }
}

export const MIN_REASON_LENGTH = 3;

const VALUE_HINTS: Readonly<Record<ExtractionFieldKind, string>> = {
  money: 'Digits with an optional decimal point, in the unit chosen, for example 125.40.',
  percent: 'A decimal fraction, for example 0.4250 for 42.5%.',
  count: 'A whole number, for example 120.',
  date: 'A calendar date as YYYY-MM-DD.',
};

export function valueHint(kind: ExtractionFieldKind): string {
  return VALUE_HINTS[kind];
}

export interface EditProblems {
  value?: string;
  unit?: string;
  reason?: string;
}

/** The problems of an edit form, keyed by field; empty when the edit can be sent. */
export function editProblems(v: ExtractedValue, form: EditForm): EditProblems {
  const problems: EditProblems = {};
  const value = form.value.trim();
  const unit = v.kind === 'money' ? form.unit : naturalUnit(v.kind);
  if (value === '') problems.value = 'A value is required';
  if (v.kind === 'money' && !isMoneyUnit(unit)) problems.unit = 'A money edit needs a money unit';
  else if (
    value !== '' &&
    unit !== null &&
    unit !== '' &&
    !valueFitsUnit(value, unit as ExtractionUnit)
  )
    problems.value = 'The value does not fit the unit';
  if (form.reason.trim().length < MIN_REASON_LENGTH)
    problems.reason = `Give a reason of at least ${MIN_REASON_LENGTH} characters`;
  return problems;
}

export function editBody(v: ExtractedValue, form: EditForm): ExtractionRunCommandBody {
  const unit = v.kind === 'money' ? form.unit : naturalUnit(v.kind);
  return {
    command: 'edit',
    field: v.field,
    value: form.value.trim(),
    ...(unit === null || unit === '' ? {} : { unit: unit as ExtractionUnit }),
    reason: form.reason.trim(),
  };
}

/* ---- Click-to-source: the quote found among a page's text runs ---- */

/** Runs within this many page units of each other sit on one baseline (packages/pdf's rule). */
export const BASELINE_TOLERANCE = 2;

/** Whitespace runs folded to one space, as the citation check reads the page (EXT-CITE-02). */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The runs of a page, grouped by baseline (top of the page first, left to right within a line),
 * as indices into page.runs.
 */
export function pageLines(page: PageLayout): number[][] {
  const order = page.runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => b.run.y - a.run.y || a.run.x - b.run.x);
  const lines: { y: number; indices: number[] }[] = [];
  for (const { run, index } of order) {
    const last = lines[lines.length - 1];
    if (last !== undefined && Math.abs(last.y - run.y) <= BASELINE_TOLERANCE)
      last.indices.push(index);
    else lines.push({ y: run.y, indices: [index] });
  }
  return lines.map((line) =>
    line.indices.sort((a, b) => (page.runs[a]?.x ?? 0) - (page.runs[b]?.x ?? 0)),
  );
}

/**
 * The runs that carry a quote on a page: the quote is matched against each line's runs joined
 * by single spaces, whitespace folded, case kept (the validator's own rule), and the runs the
 * match overlaps are returned as indices into page.runs. Empty when the quote is not on the page.
 */
export function findQuote(page: PageLayout, quote: string | null): number[] {
  if (quote === null) return [];
  const needle = normalizeWhitespace(quote);
  if (needle === '') return [];
  for (const line of pageLines(page)) {
    const texts = line.map((i) => normalizeWhitespace(page.runs[i]?.text ?? ''));
    const joined = texts.join(' ');
    const at = joined.indexOf(needle);
    if (at < 0) continue;
    const end = at + needle.length;
    const hits: number[] = [];
    let offset = 0;
    texts.forEach((text, position) => {
      const start = offset;
      const stop = offset + text.length;
      if (text.length > 0 && start < end && stop > at) hits.push(line[position] ?? -1);
      offset = stop + 1;
    });
    return hits.filter((i) => i >= 0);
  }
  return [];
}

/**
 * The width of a run in page units when the browser cannot measure it: about half an em per
 * character for a text face at the run's size.
 */
export function estimateWidth(text: string, size: number): number {
  return text.length * size * 0.52;
}

/** The page the review opens on: the first value's cited page in review order, else page 1. */
export function firstPage(detail: ExtractionRunDetail): number {
  const first = reviewOrder(detail.values).find((v) => v.page !== null);
  return first?.page ?? detail.pages[0]?.number ?? 1;
}

/** The values the run page's narrative card decides: the drafted highlights and commentary rows. */
export const NARRATIVE_FIELDS = { highlights: 'highlights', commentary: 'commentary' } as const;
