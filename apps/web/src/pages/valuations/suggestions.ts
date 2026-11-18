import { API_PREFIX, ROUTES, VALUATION_SUGGESTION_STATES } from '@pb/contracts';
import type {
  SuggestionBasis,
  SuggestionInput,
  SuggestionReason,
  SuggestionRunOutcome,
  ValuationState,
  ValuationStoredInputs,
  ValuationSuggestionRow,
  ValuationSuggestionState,
} from '@pb/contracts';
import { SUGGESTION_KEY_PREFIX } from '@pb/workflows';
import { SUGGESTIONS_PATH, VALUATION_TABS } from '../../app/nav.js';
import type { Tone } from '../../components/ui.js';
import {
  formatDate,
  formatMoneyM,
  formatMoneyM2,
  formatPct,
  formatWholeDollars,
  labelOf,
  MISSING,
} from '../../lib/format.js';
import { formatDollars } from '../deal/underwriting-form.js';
import { VARIANCE_FLAG } from './board.js';

/*
 * Pure helpers of the valuation suggestions (docs/04 M10, docs/08 section 12, docs/18 section 14,
 * decision 0023): who reads and who decides (from the route table, never a role list of the
 * page's own), the sentence of each rule and of each reason a source gives no value, how an input
 * and its source read, the two checks of a statement, the other sources of the quarter, and what
 * operations is offered for a suggestion. Every figure is the API's; nothing here calculates.
 */

/* ---- Roles, from the contract's route table (config over code) ---- */

function rolesOf(method: string, path: string): readonly string[] {
  return ROUTES.find((r) => r.method === method && r.path === path)?.roles ?? [];
}

/** Roles that read suggestions (GET /valuation-suggestions). Every other role is sent nothing and asks for nothing. */
export const SUGGESTION_READ_ROLES: readonly string[] = rolesOf(
  'GET',
  `${API_PREFIX}/valuation-suggestions`,
);
/** Roles that decide one (POST /valuation-suggestions/{id}/commands). */
export const SUGGESTION_DECIDE_ROLES: readonly string[] = rolesOf(
  'POST',
  `${API_PREFIX}/valuation-suggestions/{id}/commands`,
);

export function canReadSuggestions(roles: readonly string[]): boolean {
  return roles.some((r) => SUGGESTION_READ_ROLES.includes(r));
}

export function canDecideSuggestions(roles: readonly string[]): boolean {
  return roles.some((r) => SUGGESTION_DECIDE_ROLES.includes(r));
}

/** The Valuations tab row for a user: the Suggestions tab only for a role that reads suggestions. */
export function valuationTabsFor(roles: readonly string[]): typeof VALUATION_TABS {
  return canReadSuggestions(roles)
    ? VALUATION_TABS
    : VALUATION_TABS.filter((tab) => tab.to !== SUGGESTIONS_PATH);
}

/** The switch an administrator turns suggestions off with. */
export const SUGGESTIONS_FLAG = 'valuation.suggestions';

/** Whether suggestions are switched on; on until the flags say otherwise, so a slow read hides nothing. */
export function suggestionsOn(
  flags: { flags: readonly { key: string; enabled: boolean }[] } | undefined,
): boolean {
  return flags?.flags.find((f) => f.key === SUGGESTIONS_FLAG)?.enabled !== false;
}

export const SUGGESTIONS_OFF = 'Suggestions are switched off. Open ones can be read and dismissed.';

export const SUGGESTIONS_EMPTY = {
  title: 'No suggestions are open',
  detail:
    'One appears when a statement or quarterly report is approved for a position with no mark for that quarter.',
} as const;

export const SUGGESTIONS_READERS =
  'Operations, the deal team, approvers and auditors read valuation suggestions.';

export const DECIDE_READ_ONLY = 'Operations decides a suggestion; your role reads it.';

/* ---- States ---- */

export const SUGGESTION_STATES: readonly ValuationSuggestionState[] = VALUATION_SUGGESTION_STATES;

/** The state filter: one state, or every state. */
export type SuggestionStateFilter = ValuationSuggestionState | 'all';

export function isSuggestionStateFilter(value: unknown): value is SuggestionStateFilter {
  return value === 'all' || (SUGGESTION_STATES as readonly unknown[]).includes(value);
}

const STATE_WORDS: Readonly<Record<ValuationSuggestionState, string>> = {
  Open: 'Open',
  Accepted: 'Accepted',
  Dismissed: 'Dismissed',
  Superseded: 'Replaced or closed',
};

export function suggestionStateWord(state: SuggestionStateFilter): string {
  return state === 'all' ? 'All states' : STATE_WORDS[state];
}

/** An Open suggestion waits on operations; an Accepted one went onto a draft; the others are history. */
const STATE_TONES: Readonly<Record<ValuationSuggestionState, Tone>> = {
  Open: 'watch',
  Accepted: 'good',
  Dismissed: 'neutral',
  Superseded: 'neutral',
};

export function suggestionTone(state: ValuationSuggestionState): Tone {
  return STATE_TONES[state];
}

/**
 * How a suggestion the system replaced or closed reads: "Replaced" when another was written in
 * its place (the page links to it), else why it was closed.
 */
export function supersededText(
  row: Pick<ValuationSuggestionRow, 'supersededReason' | 'supersededById'>,
): string {
  if (row.supersededById !== null) return 'Replaced';
  switch (row.supersededReason) {
    case 'mark_locked':
      return 'Closed: a mark for this quarter is Locked.';
    case 'position_closed':
      return 'Closed: the position is no longer held.';
    case 'figures_changed':
      return 'Closed: the figures behind it changed.';
    // A better source always writes a replacement, and a suggestion that is not superseded has
    // no reason: neither is closed for a reason the page can name.
    case 'better_source':
    case null:
      return 'Closed';
  }
}

/* ---- The source, its rule and its reasons (docs/08 section 12) ---- */

export const SOURCE_LABEL: Readonly<Record<SuggestionBasis, string>> = {
  capital_account_balance: 'Capital account statement',
  sponsor_equity_value: 'Sponsor report',
  held_multiple: 'Sponsor report, multiple held',
};

/** The suggested value's own source inside a sentence: "above the statement". */
const SOURCE_NOUN: Readonly<Record<SuggestionBasis, string>> = {
  capital_account_balance: 'the statement',
  sponsor_equity_value: "the report's indication",
  held_multiple: "the report's indication",
};

const SHARE_KEY = 'investor_share_pct';

const SCALED_MARK =
  'The last Locked mark, scaled by the change in equity value (enterprise value less net debt).';

/** The rule a suggestion was worked out by, in one sentence a reader can check the inputs against. */
export function ruleSentence(
  row: Pick<ValuationSuggestionRow, 'basis'> & {
    workings: { inputs: readonly { key: string }[] };
  },
): string {
  switch (row.basis) {
    case 'capital_account_balance':
      return row.workings.inputs.some((input) => input.key === SHARE_KEY)
        ? 'The ending capital balance on the capital account statement, times our share of the vehicle.'
        : 'The ending capital balance on the capital account statement.';
    case 'sponsor_equity_value':
      return SCALED_MARK;
    case 'held_multiple':
      return `${SCALED_MARK} Enterprise value is the new EBITDA at the earlier quarter's multiple.`;
  }
}

/** Why a source gives no value, in the order the reasons are decided. */
export const REASON_SENTENCE: Readonly<Record<SuggestionReason, string>> = {
  no_ending_balance: 'The statement gives no ending balance for our account in US dollars.',
  non_positive_balance: 'The ending balance is zero or negative.',
  share_out_of_range: 'Our share of the vehicle must be above 0% and at most 100%.',
  no_reference_mark: 'No Locked mark from an earlier quarter.',
  flows_since_reference_mark: 'Cash has moved since the last Locked mark.',
  no_reference_figures: 'No approved figures for the quarter of the last Locked mark.',
  non_positive_reference_equity: 'Equity value at the last Locked mark was zero or negative.',
  no_ebitda: 'EBITDA is missing for one of the two quarters.',
  non_positive_ebitda: 'EBITDA is zero or negative in one of the two quarters.',
  no_net_debt: 'No approved net debt for the new quarter.',
  non_positive_equity: 'Equity value for the new quarter is zero or negative.',
  value_not_positive: 'The value works out at zero or less.',
};

/* ---- The mark on record and the comparison (rule 12.4) ---- */

/** "one quarter old", "3 quarters old". */
export function markAge(ageQuarters: number): string {
  return ageQuarters === 1 ? 'one quarter old' : `${ageQuarters} quarters old`;
}

/** "Mar 31, 2025, one quarter old": the date and the age of the mark a suggestion is set against. */
export function currentMarkNote(mark: NonNullable<ValuationSuggestionRow['currentMark']>): string {
  return `${formatDate(mark.periodEnd)}, ${markAge(mark.ageQuarters)}`;
}

/** "$2.5M (13.7%)": a change in money with its percent; the placeholder when there is none. */
export function changeText(amount: string | null, pct: string | null): string {
  if (amount === null) return MISSING;
  return pct === null ? formatMoneyM(amount) : `${formatMoneyM(amount)} (${formatPct(pct)})`;
}

/* ---- Badges ---- */

export interface SuggestionBadge {
  label: string;
  tone: Tone;
  /** What the badge means, for its title. */
  title: string;
}

const VARIANCE_PCT = formatPct(String(VARIANCE_FLAG));

/** The badges of a suggestion, in a fixed order; a flag that is not raised gives none. */
export function flagBadges(flags: ValuationSuggestionRow['flags']): SuggestionBadge[] {
  return [
    ...(flags.variance
      ? [
          {
            label: 'Variance',
            tone: 'watch' as const,
            title: `The change against the previous quarter's mark is at or above ${VARIANCE_PCT}`,
          },
        ]
      : []),
    ...(flags.ties === false
      ? [
          {
            label: 'Does not tie',
            tone: 'watch' as const,
            title: "The statement's own lines do not add up to its ending balance",
          },
        ]
      : []),
    ...(flags.contributionsDiffer
      ? [
          {
            label: 'Contributions differ',
            tone: 'watch' as const,
            title: "The statement's contributions to date differ from the record",
          },
        ]
      : []),
    ...(flags.sourcesDiffer
      ? [
          {
            label: 'Sources differ',
            tone: 'watch' as const,
            title: `Another source for this quarter is ${VARIANCE_PCT} or more away from this value`,
          },
        ]
      : []),
    ...(flags.editedByReviewer
      ? [
          {
            label: 'Typed by reviewer',
            tone: 'neutral' as const,
            title: 'A reviewer typed one of the figures over what was read',
          },
        ]
      : []),
  ];
}

/** Each raised flag as a sentence, for the confirmation a person reads before opening a draft. */
export function flagSentences(flags: ValuationSuggestionRow['flags']): string[] {
  return [
    ...(flags.variance
      ? [`The change against the previous quarter's mark is at or above ${VARIANCE_PCT}.`]
      : []),
    ...(flags.ties === false ? ["The statement's lines do not add up."] : []),
    ...(flags.contributionsDiffer
      ? ["The statement's contributions to date differ from the record."]
      : []),
    ...(flags.sourcesDiffer ? ['Another source for this quarter gives a different value.'] : []),
    ...(flags.editedByReviewer ? ['A reviewer typed one of the figures.'] : []),
  ];
}

/* ---- The workings: each input with its source ---- */

const INPUT_LABELS: Readonly<Record<string, string>> = {
  ending_capital_balance: 'Ending capital balance',
  [SHARE_KEY]: 'Our share of the vehicle',
  reference_mark: 'Last Locked mark',
  reference_enterprise_value: 'Enterprise value, earlier quarter',
  reference_net_debt: 'Net debt, earlier quarter',
  reference_ebitda_ltm: 'EBITDA (LTM), earlier quarter',
  enterprise_value: 'Enterprise value',
  net_debt: 'Net debt',
  ebitda_ltm: 'EBITDA (LTM)',
};

/** An input's name in words; one the page has no word for reads from its key. */
export function inputLabel(key: string): string {
  return INPUT_LABELS[key] ?? labelOf(key);
}

/** An input's figure: a share as a percent to two places, money in full with its cents. */
export function inputValueText(input: Pick<SuggestionInput, 'key' | 'value'>): string {
  if (input.key === SHARE_KEY) return formatPct(input.value, 2);
  return formatDollars(input.value) ?? MISSING;
}

/** Where an input came from, in the words the workings use. */
export function inputSourceText(input: Pick<SuggestionInput, 'source' | 'periodEnd'>): string {
  const { source } = input;
  switch (source.kind) {
    case 'document': {
      const file = source.fileName ?? 'the document';
      return source.page === null ? `From ${file}` : `From ${file}, page ${source.page}`;
    }
    case 'reviewer':
      return 'Typed by the reviewer';
    case 'record':
      return 'From the record';
    case 'valuation':
      return `Locked mark, ${formatDate(input.periodEnd)}`;
  }
}

/* ---- The two checks of a statement (rule 12.1) ---- */

type Checks = NonNullable<ValuationSuggestionRow['checks']>;

/** A decimal string without its sign. */
const unsigned = (value: string): string => value.replace(/^-/, '');

/** True for a decimal string that is zero to every place it carries. */
const isZero = (value: string): boolean => !/[1-9]/.test(value);

/** Whether the statement's own lines add up, and by how much they miss when they do not. */
export function tieSentence(checks: Pick<Checks, 'ties' | 'tieDifference'>): string {
  if (checks.ties === null || checks.tieDifference === null)
    return 'The lines were not added up: the statement does not state all five.';
  return checks.ties
    ? 'The lines add up.'
    : `The lines are ${formatWholeDollars(unsigned(checks.tieDifference))} apart.`;
}

const NOT_CHECKED: Readonly<
  Record<NonNullable<Checks['contributionsCheck']['notChecked']>, string>
> = {
  contributions_not_stated: 'the statement does not state contributions to date.',
  share_out_of_range: 'our share of the vehicle is out of range.',
  no_recorded_contributions: 'the record holds no approved contribution.',
};

/** The statement's contributions to date beside the record's, or why they were not set side by side. */
export function contributionsSentence(check: Checks['contributionsCheck']): string {
  if (check.notChecked !== null)
    return `Contributions not checked: ${NOT_CHECKED[check.notChecked]}`;
  return `Contributions to date: statement ${formatMoneyM2(check.statement)}, record ${formatMoneyM2(check.record)}.`;
}

/* ---- The other sources of the quarter (rule 12.5) ---- */

/**
 * Another source beside the suggestion: its value and how far it is from the suggested one, or
 * why it has no value. Nothing is averaged; the line only sets the two side by side.
 */
export function crossCheckSentence(
  check: ValuationSuggestionRow['crossChecks'][number],
  basis: SuggestionBasis,
): string {
  const label = SOURCE_LABEL[check.basis];
  if (check.value === null) {
    const why = check.reason === null ? '' : ` ${REASON_SENTENCE[check.reason]}`;
    return `${label}: no value.${why}`;
  }
  const value = formatMoneyM2(check.value);
  if (check.difference === null) return `${label}: ${value}.`;
  if (isZero(check.difference)) return `${label}: ${value}, the same as ${SOURCE_NOUN[basis]}.`;
  const size = formatWholeDollars(unsigned(check.difference));
  const pct = check.differencePct === null ? '' : ` (${formatPct(unsigned(check.differencePct))})`;
  const side = check.difference.startsWith('-') ? 'below' : 'above';
  return `${label}: ${value}, ${size}${pct} ${side} ${SOURCE_NOUN[basis]}.`;
}

/* ---- What operations is offered (docs/18 section 14) ---- */

type InProgress = NonNullable<ValuationSuggestionRow['inProgress']>;

/**
 * What can be done with a suggestion, from its state, its value and the valuation version in
 * progress for its quarter. The API still judges every command; this only picks which one the
 * page offers, so a person is never shown a button the rule would refuse.
 */
export type SuggestionOffer =
  /** Open with a value and no version in progress: a draft valuation can be opened. */
  | { kind: 'accept' }
  /** Open with a value and a Draft open for the quarter: the value can be put on it. */
  | { kind: 'applyToDraft'; draft: InProgress }
  /** Open with a value and a version past Draft: neither, until it is sent back. */
  | { kind: 'blocked'; version: InProgress }
  /** Open with no value: it can only be dismissed. */
  | { kind: 'noValue' }
  /** No longer Open: nothing is left to decide. */
  | { kind: 'decided' };

export function offerFor(
  row: Pick<ValuationSuggestionRow, 'state' | 'suggestedValue' | 'inProgress'>,
): SuggestionOffer {
  if (row.state !== 'Open') return { kind: 'decided' };
  if (row.suggestedValue === null) return { kind: 'noValue' };
  if (row.inProgress === null) return { kind: 'accept' };
  const draft: ValuationState = 'Draft';
  return row.inProgress.state === draft
    ? { kind: 'applyToDraft', draft: row.inProgress }
    : { kind: 'blocked', version: row.inProgress };
}

export const VERSION_IN_APPROVAL =
  'A valuation for this quarter is being approved. Send it back to change it.';

/** What the confirmation says before a draft valuation is opened from a suggestion. */
export function acceptSentence(
  row: Pick<ValuationSuggestionRow, 'suggestedValue' | 'periodEnd'>,
): string {
  return `This opens a draft valuation at ${formatMoneyM(row.suggestedValue)} for ${formatDate(row.periodEnd)}. It still has to be prepared and approved before it is locked.`;
}

/** What the confirmation says before a suggested value is put on the Draft already open. */
export function applySentence(
  row: Pick<ValuationSuggestionRow, 'suggestedValue' | 'method'>,
  draft: Pick<InProgress, 'periodEnd'>,
): string {
  return `This puts ${formatMoneyM(row.suggestedValue)} and the method ${labelOf(row.method)} on the draft dated ${formatDate(draft.periodEnd)}. The draft keeps its date.`;
}

/** "Meridian Data Partners, Jun 30, 2025": how messages and buttons name a suggestion. */
export function suggestionLabel(
  row: Pick<ValuationSuggestionRow, 'companyName' | 'periodEnd'>,
): string {
  return `${row.companyName}, ${formatDate(row.periodEnd)}`;
}

/* ---- What an approved run did (the run page) ---- */

type NoneReason = NonNullable<SuggestionRunOutcome['reason']>;

/** Why no mark is suggested, as the sentence that follows "No mark suggested:". */
export const NO_SUGGESTION_SENTENCE: Readonly<Record<NoneReason, string>> = {
  fund_commitment: 'this is our account in a fund commitment, which has no valuation record yet.',
  private_credit: 'suggestions are not built for private credit.',
  not_usd: 'the position is not held in US dollars and nothing is converted.',
  not_held: 'the position was not held at this period end.',
  mark_locked: 'a mark for this quarter or a later one is Locked.',
  dismissed: 'the same value from this source was dismissed.',
  on_valuation: 'this value is already on the valuation in progress.',
  nothing_on_hand: 'nothing approved for this position and quarter gives a figure to work from.',
};

/**
 * What the approval of a run did to the suggestions of its position and quarter, in the page's
 * words. `linked` is true when the sentence is about a suggestion the reader can open.
 */
export function runOutcomeText(outcome: SuggestionRunOutcome): { text: string; linked: boolean } {
  switch (outcome.outcome) {
    case 'opened':
      return { text: 'Valuation suggestion opened', linked: outcome.suggestionId !== null };
    case 'replaced':
      return { text: 'Valuation suggestion replaced', linked: outcome.suggestionId !== null };
    case 'unchanged':
      return {
        text: 'The valuation suggestion open for this quarter is unchanged',
        linked: outcome.suggestionId !== null,
      };
    case 'none':
      return {
        text:
          outcome.reason === null
            ? 'No mark suggested: none was worked out when this run was approved.'
            : `No mark suggested: ${NO_SUGGESTION_SENTENCE[outcome.reason]}`,
        linked: false,
      };
  }
}

export const RELINK_NOTE =
  'Wrong position, or none? A classified document cannot be relinked yet. Dismiss the suggestion; a draft can still be started on the board.';

/* ---- A draft valuation started from a suggestion (the version screen) ---- */

/** What a draft's inputs say about the suggestion its value came from. */
export interface SuggestionOnDraft {
  id: string;
  /** The suggested value in dollars, as text. */
  value: string | null;
  basis: string | null;
  documentId: string | null;
  page: number | null;
  runId: string | null;
}

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** The suggestion a version's inputs name, or null for a version that was not started from one. */
export function suggestionOnDraft(inputs: ValuationStoredInputs): SuggestionOnDraft | null {
  const read = (key: string): string | null => textOf(inputs[`${SUGGESTION_KEY_PREFIX}${key}`]);
  const id = read('id');
  if (id === null) return null;
  const page = Number(read('page'));
  return {
    id,
    value: read('value'),
    basis: read('basis'),
    documentId: read('documentId'),
    page: Number.isInteger(page) && page > 0 ? page : null,
    runId: read('runId'),
  };
}

/** True for an input a suggestion wrote on a draft: the edit form shows it and never changes it. */
export function isSuggestionKey(name: string): boolean {
  return name.startsWith(SUGGESTION_KEY_PREFIX);
}

/** A version's inputs split in two: those a person edits, and those a suggestion wrote. */
export function splitSuggestionKeys(inputs: ValuationStoredInputs): {
  own: ValuationStoredInputs;
  kept: ValuationStoredInputs;
} {
  const own: Record<string, unknown> = {};
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(inputs))
    (isSuggestionKey(name) ? kept : own)[name] = value;
  return { own, kept };
}

/** "Started from a suggestion of $20.9M." */
export function startedFromSentence(found: SuggestionOnDraft): string {
  return found.value === null
    ? 'Started from a suggestion.'
    : `Started from a suggestion of ${formatMoneyM(found.value)}.`;
}

export const NEWER_SUGGESTION = 'A newer suggestion is open for this quarter.';

/* ---- The page's address ---- */

/** What the Suggestions tab reads from its address: the suggestion shown with its workings, and the state listed. */
export interface SuggestionsSearch {
  id?: string;
  state?: SuggestionStateFilter;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The search of the Suggestions tab. An id that is not an id and a state the list does not know
 * are dropped, so a stale bookmark opens the open suggestions and never an error page. Open is
 * the list's own default and is left out.
 */
export function parseSuggestionsSearch(search: Record<string, unknown>): SuggestionsSearch {
  const { id, state } = search;
  return {
    ...(typeof id === 'string' && UUID.test(id) ? { id } : {}),
    ...(isSuggestionStateFilter(state) && state !== 'Open' ? { state } : {}),
  };
}

/** The search that shows one suggestion while keeping the state listed. */
export function searchFor(id: string | undefined, state: SuggestionStateFilter): SuggestionsSearch {
  return {
    ...(id === undefined ? {} : { id }),
    ...(state === 'Open' ? {} : { state }),
  };
}
