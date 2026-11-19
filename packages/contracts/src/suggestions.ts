import { z } from 'zod';
import { CONTRIBUTIONS_UNCHECKED_REASONS, SUGGESTION_BASES, SUGGESTION_REASONS } from '@pb/calc';
import * as s from './schemas.js';

/*
 * Valuation suggestions (docs/04 M10, docs/08 section 12, docs/18 section 14, decision 0023): a
 * mark the platform worked out from an approved capital account statement or sponsor report, as
 * it is read and decided. A suggestion is never a mark: a person in operations opens a draft
 * valuation from it, puts it on a Draft already open or dismisses it. The stored columns travel
 * as they are; the mark on record, the comparison, the checks, the other sources and the badges
 * are worked out when the suggestion is read (suggestionReading of @pb/workflows), so nothing of
 * them is stored. Money and percents travel as decimal strings, null where there is none.
 */

/** mon.valuation_suggestion.state (docs/18 section 14); the same list as valuationSuggestionMachine's states. */
export const VALUATION_SUGGESTION_STATES = ['Open', 'Accepted', 'Dismissed', 'Superseded'] as const;
export const valuationSuggestionState = z.enum(VALUATION_SUGGESTION_STATES);
export type ValuationSuggestionState = z.infer<typeof valuationSuggestionState>;

/** What a suggested mark rests on (docs/08 section 12): one source, never a blend. */
export const suggestionBasis = z.enum(SUGGESTION_BASES);
export type SuggestionBasis = z.infer<typeof suggestionBasis>;

/** Why a source gives no value (docs/08 section 12), in the order the reasons are decided. */
export const suggestionReason = z.enum(SUGGESTION_REASONS);
export type SuggestionReason = z.infer<typeof suggestionReason>;

/** Why an Open suggestion was superseded; the same list as SUPERSEDED_REASONS of @pb/workflows. */
export const SUGGESTION_SUPERSEDED_REASONS = [
  'better_source',
  'figures_changed',
  'mark_locked',
  'position_closed',
] as const;
export const suggestionSupersededReason = z.enum(SUGGESTION_SUPERSEDED_REASONS);
export type SuggestionSupersededReason = z.infer<typeof suggestionSupersededReason>;

/** Where a figure came from; the same list as SUGGESTION_SOURCE_KINDS of @pb/workflows. */
export const SUGGESTION_INPUT_SOURCE_KINDS = [
  'document',
  'reviewer',
  'record',
  'valuation',
] as const;
export const suggestionInputSourceKind = z.enum(SUGGESTION_INPUT_SOURCE_KINDS);

/**
 * Why no mark is suggested for a position and quarter (docs/18 section 14, "none when"); the
 * same list as NO_SUGGESTION_REASONS of @pb/workflows, in the order the reasons are decided.
 */
export const NO_SUGGESTION_REASON_CODES = [
  'fund_commitment',
  'private_credit',
  'not_usd',
  'not_held',
  'mark_locked',
  'dismissed',
  'on_valuation',
] as const;

/**
 * One input of the rule behind a suggestion: the field read, the figure in dollars (a fraction
 * for a share), the period it is for and where it came from. A figure read from a document names
 * the document and the page, with the file name for a reader who can open it; one a reviewer
 * typed names the reviewer; one from the approved record names the quarter; a Locked mark names
 * the valuation.
 */
export const suggestionInput = z.object({
  key: z.string(),
  value: s.decimalString,
  periodEnd: s.isoDate,
  source: z.object({
    kind: suggestionInputSourceKind,
    id: s.uuid,
    page: z.number().int().nullable(),
    /** The file name of the document, for kind document; null for every other kind. */
    fileName: z.string().nullable(),
  }),
  edited: z.boolean(),
});
export type SuggestionInput = z.infer<typeof suggestionInput>;

/** Our latest Locked mark of an earlier quarter: the mark a suggestion is set against. */
export const suggestionCurrentMark = z.object({
  valuationId: s.uuid,
  value: s.decimalString,
  periodEnd: s.isoDate,
  /** The quarter end the mark reports for. */
  reportsFor: s.isoDate,
  /** True when that is the quarter end just before the suggestion's. */
  previousQuarter: z.boolean(),
  /** Whole calendar quarters from the mark's quarter to the suggestion's. */
  ageQuarters: z.number().int(),
});

/** The suggested value against the mark on record (docs/08 rule 12.4). */
export const suggestionComparison = z.object({
  change: s.decimalString.nullable(),
  changePct: s.decimalString.nullable(),
  /** The board's variance flag; false unless the mark on record is the previous quarter's. */
  variance: z.boolean(),
  netOfFlows: s.decimalString.nullable(),
  netOfFlowsPct: s.decimalString.nullable(),
  /** Our part of the statement's beginning balance, shown beside the mark when there is no net of flows. */
  beginningBalance: s.decimalString.nullable(),
});

/** The two checks of a statement-based suggestion (docs/08 rule 12.1); they change no value. */
export const suggestionChecks = z.object({
  /** Whether the statement's own lines add up; null unless all five are stated. */
  ties: z.boolean().nullable(),
  tieDifference: s.decimalString.nullable(),
  tieToleranceUsd: s.decimalString,
  /** True when the statement gives no share, so its lines were read as our own account. */
  ownAccount: z.boolean(),
  contributionsCheck: z.object({
    statement: s.decimalString.nullable(),
    record: s.decimalString,
    difference: s.decimalString.nullable(),
    differencePct: s.decimalString.nullable(),
    differs: z.boolean().nullable(),
    notChecked: z.enum(CONTRIBUTIONS_UNCHECKED_REASONS).nullable(),
  }),
});

/** Another source beside the suggestion (docs/08 rule 12.5): its value or why it has none, and the difference. */
export const suggestionCrossCheck = z.object({
  basis: suggestionBasis,
  value: s.decimalString.nullable(),
  reason: suggestionReason.nullable(),
  difference: s.decimalString.nullable(),
  differencePct: s.decimalString.nullable(),
  differs: z.boolean(),
});

/** The badges of a suggestion. */
export const suggestionFlags = z.object({
  variance: z.boolean(),
  /** Whether the statement's lines add up; null with no answer. */
  ties: z.boolean().nullable(),
  contributionsDiffer: z.boolean(),
  sourcesDiffer: z.boolean(),
  editedByReviewer: z.boolean(),
});

/**
 * The valuation version in progress for the suggestion's quarter (a Draft, OpsPrepared or
 * DealTeamApproved one), or null. With none, a draft valuation can be opened from the
 * suggestion; with a Draft, the value can be put on it; with a version past Draft, neither until
 * it is sent back.
 */
export const suggestionInProgress = z.object({
  valuationId: s.uuid,
  periodEnd: s.isoDate,
  version: z.number().int(),
  state: s.valuationState,
  method: z.string(),
  fairValue: s.decimalString,
  rowVersion: z.number().int(),
});

export const valuationSuggestionRow = z.object({
  id: s.uuid,
  investmentId: s.uuid,
  investmentNumber: z.string(),
  companyName: z.string(),
  vehicleName: z.string(),
  dealType: z.string(),
  /** The calendar quarter end the suggestion is for. */
  periodEnd: s.isoDate,
  basis: suggestionBasis,
  /** The valuation method a draft opened from the suggestion carries (a valuation_method code). */
  method: z.string(),
  /** Dollars to the cent, above zero; null when there is a reason instead ("not calculable"). */
  suggestedValue: s.decimalString.nullable(),
  reasonCode: suggestionReason.nullable(),
  workings: z.object({ inputs: z.array(suggestionInput) }),
  /** The document of the approved run that produced the suggestion, and where its first input sits. */
  source: z.object({
    documentId: s.uuid,
    fileName: z.string().nullable(),
    extractionRunId: s.uuid,
    page: z.number().int().nullable(),
    locator: z.string().nullable(),
  }),
  /** The approver of each run an input came from, and whoever typed one: none of them may approve a valuation it is accepted onto. */
  sourceReviewerIds: z.array(s.uuid),
  promptVersion: z.string().nullable(),
  modelId: z.string().nullable(),
  calcVersion: z.string(),
  state: valuationSuggestionState,
  /** Who accepted or dismissed it; null while it is Open, and for one the system superseded. */
  decidedBy: s.person.nullable(),
  /** When it left Open, whoever or whatever moved it. */
  decidedAt: z.string().nullable(),
  /** Why it was dismissed; null in every other state. */
  decisionReason: z.string().nullable(),
  /** The draft valuation it was accepted onto; null in every other state. */
  valuationId: s.uuid.nullable(),
  supersededReason: suggestionSupersededReason.nullable(),
  /** The suggestion written in its place; null when it was closed and nothing replaced it. */
  supersededById: s.uuid.nullable(),
  createdAt: z.string(),
  rowVersion: z.number().int(),
  /** Worked out when read. */
  currentMark: suggestionCurrentMark.nullable(),
  comparison: suggestionComparison,
  /** Null for a report-based suggestion. */
  checks: suggestionChecks.nullable(),
  crossChecks: z.array(suggestionCrossCheck),
  inProgress: suggestionInProgress.nullable(),
  flags: suggestionFlags,
});
export type ValuationSuggestionRow = z.infer<typeof valuationSuggestionRow>;

/**
 * What an approved run did to the suggestions of its position and quarter, as it stands when
 * read: it `opened` one, it `replaced` the one that was open, the open one says the same and is
 * `unchanged`, or there is `none`. For `none`, `reason` is the rule that keeps a mark from being
 * suggested ("none when", docs/18 section 14), `nothing_on_hand` when no source gives anything
 * to suggest, or null when no rule applies now. `suggestionId` is the suggestion to open: the
 * newest one the run produced, or the open one it left unchanged.
 */
export const SUGGESTION_RUN_OUTCOMES = ['opened', 'replaced', 'unchanged', 'none'] as const;
export const suggestionRunOutcome = z.object({
  outcome: z.enum(SUGGESTION_RUN_OUTCOMES),
  reason: z.enum([...NO_SUGGESTION_REASON_CODES, 'nothing_on_hand']).nullable(),
  suggestionId: s.uuid.nullable(),
});
export type SuggestionRunOutcome = z.infer<typeof suggestionRunOutcome>;

/**
 * The list, newest first. `state` is Open unless given; `all` lists every state. A quarter is
 * named by its calendar quarter end. With `extractionRunId` the list holds the suggestions that
 * run produced and the answer carries `runOutcome`.
 */
export const valuationSuggestionListQuery = s.pageQuery.extend({
  state: z.enum([...VALUATION_SUGGESTION_STATES, 'all']).default('Open'),
  investmentId: s.uuid.optional(),
  periodEnd: s.isoDate.optional(),
  extractionRunId: s.uuid.optional(),
});
export type ValuationSuggestionListQuery = z.infer<typeof valuationSuggestionListQuery>;

export const valuationSuggestionPage = z.object({
  items: z.array(valuationSuggestionRow),
  nextCursor: z.string().nullable(),
  /** Every Open suggestion the caller can see, whatever the filters. */
  openCount: z.number().int(),
  /** Present when the list was asked by `extractionRunId` and the caller can see an approved run of that id; null otherwise. */
  runOutcome: suggestionRunOutcome.nullable(),
});
export type ValuationSuggestionPage = z.infer<typeof valuationSuggestionPage>;

/** A reason a person writes on a dismissal: 3 to 500 characters of plain text. */
const reason = s.plainText(500).min(3);

/**
 * The commands of docs/18 section 14 a person sends: accept opens a draft valuation at the
 * suggested value, applyToDraft puts the value and its method on the Draft already open for the
 * quarter, dismiss sets the suggestion aside with a reason. supersede is the derivation's own
 * step and nobody sends it.
 */
export const valuationSuggestionCommandBody = z.discriminatedUnion('command', [
  z.object({ command: z.literal('accept') }).strict(),
  z.object({ command: z.literal('applyToDraft') }).strict(),
  z.object({ command: z.literal('dismiss'), reason }).strict(),
]);
export type ValuationSuggestionCommandBody = z.infer<typeof valuationSuggestionCommandBody>;
