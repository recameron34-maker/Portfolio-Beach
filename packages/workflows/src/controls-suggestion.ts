import {
  CalcError,
  D,
  SUGGESTION_BASES,
  alignedQuarterEnd,
  hasFlowBetween,
  heldMultipleMark,
  impliedStakeMark,
  isQuarterEnd,
  latestLockedBefore,
  lockedForOrAfter,
  markComparison,
  sourceCrossCheck,
  statementMark,
  statementTieTolerance,
  toDollars,
} from '@pb/calc';
import type {
  ContributionsCheck,
  MarkComparison,
  StatementMark,
  SuggestionBasis,
  SuggestionReason,
} from '@pb/calc';
import type { SupersededReason, ValuationState, ValuationSuggestionState } from './machines.js';

/*
 * The valuation suggestions as pure rules (docs/04 M10, docs/08 section 12, docs/18 section 14,
 * decision 0023): which source gives the suggested mark for a position and quarter, when no
 * suggestion applies at all, what a new approval does to the suggestion already open, what a
 * reader is shown beside a suggestion, and the keys a draft valuation opened from one carries.
 * The API (apps/api/src/suggestions) reads them over the database and the preview simulation
 * (apps/web/src/preview/routes) over its session state, so the two cannot drift. Plain data in,
 * plain data out: no database and no clock. Every figure is worked out by packages/calc and by
 * nothing here; this file only decides which rule is asked and what follows from its answer.
 */

/* ---- The refusals both sides answer, word for word ---- */

/** 409 for accept or applyToDraft once the figures behind the suggestion have moved: it was replaced or closed in the same step. */
export const SUGGESTION_CHANGED_REFUSAL =
  'The figures behind this suggestion changed. It has been replaced or closed.';

/** 409 when two approvals work on one position and quarter at once: the second waits its turn. */
export const SUGGESTION_BUSY_REFUSAL =
  'Another approval for this position and quarter is in progress. Try again.';

/** 409 for accept or applyToDraft while the flag `valuation.suggestions` is off; reads and dismiss still work. */
export const SUGGESTIONS_OFF_REFUSAL =
  'Suggestions are switched off. Open ones can be read and dismissed.';

/* ---- The settings (config/definitions.json) ---- */

/** What the rules read of config/definitions.json, as decimal strings and whole days. */
export interface SuggestionSettings {
  /** `valuationSuggestions.sourceOrder`: the three bases, each once, in the order they are tried. */
  sourceOrder: readonly SuggestionBasis[];
  /** `valuationSuggestions.tieToleranceByUnit`: dollars a statement's lines may be apart, by the coarsest unit read. */
  tieToleranceByUnit: Readonly<Record<CoarseUnit, string>>;
  /** `valuationSuggestions.contributionsTolerancePct`. */
  contributionsTolerancePct: string;
  /** `rollForwardToleranceUsd`: the tie tolerance of a statement read in dollars. */
  rollForwardToleranceUsd: string;
  /** `valuationVarianceFlag`: the board's flag, which also decides when two sources differ. */
  varianceFlag: string;
  /** `priorYearPeriodEndToleranceDays`: how far from a quarter end a mark or a quarter still counts for it. */
  periodEndToleranceDays: number;
}

/** The units coarser than dollars a statement line may be read in. */
export const COARSE_UNITS = ['USD_K', 'USD_M', 'USD_B'] as const;
export type CoarseUnit = (typeof COARSE_UNITS)[number];

/** A key of config/definitions.json that is missing or cannot be used: the message names it, never its value. */
export class SuggestionConfigError extends Error {
  constructor(public readonly key: string) {
    super(`config/definitions.json is missing a usable ${key}`);
    this.name = 'SuggestionConfigError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const DECIMAL_TEXT = /^\d+(?:\.\d+)?$/;

/** A tolerance or a flag of zero or more, from a finite JSON number or a decimal string. */
function settingDecimal(value: unknown, key: string): string {
  const text =
    typeof value === 'number' && Number.isFinite(value) ? D(String(value)).toFixed() : value;
  if (typeof text !== 'string' || !DECIMAL_TEXT.test(text)) throw new SuggestionConfigError(key);
  return text;
}

/**
 * The settings of the suggestions from config/definitions.json, never a default in code (rules 9
 * and 10): a key that is missing, unreadable or below zero is refused by name, and so is a source
 * order that is not the three bases, each exactly once. The API reads this once at start and
 * refuses to start without it; the preview reads the same file through the same function.
 */
export function suggestionSettings(definitions: unknown): SuggestionSettings {
  const root = isRecord(definitions) ? definitions : {};
  const own = isRecord(root.valuationSuggestions) ? root.valuationSuggestions : {};

  const orderKey = 'valuationSuggestions.sourceOrder';
  const listed: readonly unknown[] = Array.isArray(own.sourceOrder) ? own.sourceOrder : [];
  const sourceOrder = SUGGESTION_BASES.filter((basis) => listed.includes(basis)).sort(
    (a, b) => listed.indexOf(a) - listed.indexOf(b),
  );
  if (listed.length !== SUGGESTION_BASES.length || sourceOrder.length !== SUGGESTION_BASES.length)
    throw new SuggestionConfigError(orderKey);

  const unitsKey = 'valuationSuggestions.tieToleranceByUnit';
  const byUnit = new Map(
    Object.entries(isRecord(own.tieToleranceByUnit) ? own.tieToleranceByUnit : {}),
  );
  const tolerance = (unit: CoarseUnit): string =>
    settingDecimal(byUnit.get(unit), `${unitsKey}.${unit}`);

  const days = root.priorYearPeriodEndToleranceDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0)
    throw new SuggestionConfigError('priorYearPeriodEndToleranceDays');

  return {
    sourceOrder,
    tieToleranceByUnit: {
      USD_K: tolerance('USD_K'),
      USD_M: tolerance('USD_M'),
      USD_B: tolerance('USD_B'),
    },
    contributionsTolerancePct: settingDecimal(
      own.contributionsTolerancePct,
      'valuationSuggestions.contributionsTolerancePct',
    ),
    rollForwardToleranceUsd: settingDecimal(
      root.rollForwardToleranceUsd,
      'rollForwardToleranceUsd',
    ),
    varianceFlag: settingDecimal(root.valuationVarianceFlag, 'valuationVarianceFlag'),
    periodEndToleranceDays: days,
  };
}

/* ---- When no suggestion applies (docs/18 section 14) ---- */

/** The deal types a suggestion is worked out for: an equity co-investment and a continuation vehicle. */
export const SUGGESTION_DEAL_TYPES: readonly string[] = [
  'deal_type.co_invest_equity',
  'deal_type.cv_single_asset',
  'deal_type.cv_multi_asset',
];

const CREDIT_DEAL_TYPE = 'deal_type.private_credit';

/**
 * Why no mark is suggested, in the order the reasons are decided. The first five are about the
 * position and the quarter and are judged before any source is read: the statement is our account
 * in a fund commitment (no linked position, or a position that is not an equity co-investment, a
 * continuation vehicle or a loan), the position is private credit, it is not held in US dollars,
 * it was not held at the period end, or a mark for the quarter or a later one is Locked. The last
 * two are about a suggestion decided before: the same basis, value and inputs were dismissed, or
 * are already on a valuation in progress or Locked.
 */
export const NO_SUGGESTION_REASONS = [
  'fund_commitment',
  'private_credit',
  'not_usd',
  'not_held',
  'mark_locked',
  'dismissed',
  'on_valuation',
] as const;
export type NoSuggestionReason = (typeof NO_SUGGESTION_REASONS)[number];

/** The reasons judged from the position and the quarter alone. */
export type SuggestionBar = Exclude<NoSuggestionReason, 'dismissed' | 'on_valuation'>;

/** A position as the rules read it. */
export interface SuggestionPosition {
  dealType: string;
  currency: string;
  isActive: boolean;
  entryDate: string;
  exitDate: string | null;
}

/** A valuation version as the rules read it: enough to say which quarter it reports for. */
export interface MarkOnRecord {
  id: string;
  periodEnd: string;
  state: string;
  fairValue: string;
}

/**
 * Why no suggestion applies to a position and a quarter, or null when one does. `position` is null
 * for a statement linked to no position (our account in a fund). A position is held at a period
 * end when it is active, entered on or before it and not exited by it, as the NAV series counts
 * it; a Locked mark counts for the quarter `alignedQuarterEnd` gives it.
 */
export function suggestionBar(
  position: SuggestionPosition | null,
  periodEnd: string,
  marks: readonly MarkOnRecord[],
  toleranceDays: number,
): SuggestionBar | null {
  if (position === null) return 'fund_commitment';
  if (position.dealType === CREDIT_DEAL_TYPE) return 'private_credit';
  if (!SUGGESTION_DEAL_TYPES.includes(position.dealType)) return 'fund_commitment';
  if (position.currency !== 'USD') return 'not_usd';
  const exited = position.exitDate !== null && position.exitDate <= periodEnd;
  if (!position.isActive || position.entryDate > periodEnd || exited) return 'not_held';
  return lockedForOrAfter(marks, periodEnd, toleranceDays) ? 'mark_locked' : null;
}

/* ---- The sources on hand ---- */

/** Where a figure came from: a page of a document, a reviewer who typed it, the approved record, or a valuation. */
export const SUGGESTION_SOURCE_KINDS = ['document', 'reviewer', 'record', 'valuation'] as const;
export type SuggestionSourceKind = (typeof SUGGESTION_SOURCE_KINDS)[number];

export interface FigureSource {
  kind: SuggestionSourceKind;
  /** The document, the reviewer, the quarterly record or the valuation the figure came from. */
  id: string;
  /** The page it was read from; null unless it was read from a document. */
  page: number | null;
}

/** A figure with where it came from: dollars as a decimal string (a fraction for a share). */
export interface SourcedFigure {
  value: string;
  source: FigureSource;
  /** True when a reviewer typed the figure over what was read. */
  edited: boolean;
}

/** A money line of a statement as read: the value in the unit it was read in. */
export interface StatementLine extends SourcedFigure {
  unit: string;
}

/**
 * The latest approved position-level statement for the quarter: its lines as read, each with its
 * unit, and our share of the vehicle as a fraction when the statement states one.
 */
export interface StatementOnHand {
  beginningBalance: StatementLine | null;
  contributionsInPeriod: StatementLine | null;
  distributionsInPeriod: StatementLine | null;
  netGainLoss: StatementLine | null;
  endingBalance: StatementLine | null;
  contributionsToDate: StatementLine | null;
  share: SourcedFigure | null;
}

/** The sponsor report's figures for the quarter, in dollars: a run's accepted or edited value, else the approved record's. */
export interface ReportOnHand {
  ev: SourcedFigure | null;
  netDebt: SourcedFigure | null;
  ebitda: SourcedFigure | null;
}

/** An approved quarter of the company's figures, in dollars; never an entry snapshot. */
export interface QuarterOnRecord {
  id: string;
  periodEnd: string;
  ev: string | null;
  netDebt: string | null;
  ebitdaLtm: string | null;
}

/** Our latest Locked mark of an earlier quarter and what rule 12.2 scales it by. */
export interface ReferenceOnHand {
  mark: {
    valuationId: string;
    value: string;
    periodEnd: string;
    /** The quarter end the mark reports for. */
    reportsFor: string;
    previousQuarter: boolean;
    ageQuarters: number;
  } | null;
  /** True when an approved cash flow is dated after the mark's period end and on or before the quarter end. */
  flowsSince: boolean;
  /** The approved figures of the quarter the mark reports for; null when there are none. */
  quarter: QuarterOnRecord | null;
}

/**
 * The reference of a quarter: the latest Locked mark of an earlier quarter (the mark a suggestion
 * is compared with, and the one a report scales), whether cash has moved since, and the approved
 * figures of the quarter that mark reports for. `flowDates` are the dates of the position's
 * approved cash flows; `quarters` are its approved quarters, entry snapshots left out. Marks are
 * listed highest version first within a period end, as `lockedNear` expects them.
 */
export function referenceOnHand(input: {
  periodEnd: string;
  marks: readonly MarkOnRecord[];
  flowDates: readonly string[];
  quarters: readonly QuarterOnRecord[];
  toleranceDays: number;
}): ReferenceOnHand {
  const found = latestLockedBefore(input.marks, input.periodEnd, input.toleranceDays);
  if (found === null) return { mark: null, flowsSince: false, quarter: null };
  let quarter: QuarterOnRecord | null = null;
  for (const row of input.quarters) {
    if (alignedQuarterEnd(row.periodEnd, input.toleranceDays) !== found.reportsFor) continue;
    if (quarter === null || row.periodEnd > quarter.periodEnd) quarter = row;
  }
  return {
    mark: {
      valuationId: found.mark.id,
      value: found.mark.fairValue,
      periodEnd: found.mark.periodEnd,
      reportsFor: found.reportsFor,
      previousQuarter: found.previousQuarter,
      ageQuarters: found.ageQuarters,
    },
    flowsSince: hasFlowBetween(
      input.flowDates.map((date) => ({ date })),
      found.mark.periodEnd,
      input.periodEnd,
    ),
    quarter,
  };
}

/** Everything the rules read for one position and quarter. */
export interface SuggestionSources {
  /** The quarter end the suggestion is for: a statement's own period end, a report's quarter. */
  periodEnd: string;
  statement: StatementOnHand | null;
  report: ReportOnHand | null;
  reference: ReferenceOnHand;
  /** The approved contributions on the position on or before the period end (`summarizeFlows`). */
  recordContributions: string;
}

/* ---- Reading the sources (docs/08 section 12) ---- */

/** One input of a rule as the workings keep it: the figure, the period it is for and where it came from. */
export interface WorkingInput {
  /** The field read: a schema key for a document figure, `reference_` before it for the earlier quarter. */
  key: string;
  value: string;
  periodEnd: string;
  source: FigureSource;
  edited: boolean;
}

/** What one source gives for the quarter: a value, or the reason it gives none, with the inputs its rule read. */
export interface SourceReading {
  basis: SuggestionBasis;
  /** The valuation method a draft opened from it carries. */
  method: string;
  value: string | null;
  reason: SuggestionReason | null;
  inputs: WorkingInput[];
}

/** Another source beside the suggestion: its value or why it has none, and the difference (rule 12.5). */
export interface CrossCheck {
  basis: SuggestionBasis;
  value: string | null;
  reason: SuggestionReason | null;
  difference: string | null;
  differencePct: string | null;
  differs: boolean;
}

/** The suggestion for a position and quarter: the first source with a value, the others beside it. */
export interface Selection extends SourceReading {
  crossChecks: CrossCheck[];
}

/** The statement on hand, read: its mark with both checks, the tie tolerance it was judged by and the inputs of its value. */
export interface StatementReading {
  mark: StatementMark;
  tieToleranceUsd: string;
  /** The ending balance in dollars and, when the statement states one, our share. */
  inputs: WorkingInput[];
}

const BALANCE_LINES = [
  'beginningBalance',
  'contributionsInPeriod',
  'distributionsInPeriod',
  'netGainLoss',
  'endingBalance',
] as const;

/** A statement line as a figure in dollars, converted from the unit it was read in. */
const dollarFigure = (line: StatementLine | null): SourcedFigure | null =>
  line === null
    ? null
    : {
        value: toDollars(line.value, line.unit).toFixed(),
        source: line.source,
        edited: line.edited,
      };

/** A statement line in dollars, as rule 12.1 takes it. */
const inDollars = (line: StatementLine | null): string | null => dollarFigure(line)?.value ?? null;

/**
 * Rule 12.1 over the statement on hand: each line converted from the unit it was read in, the tie
 * tolerance of the coarsest unit among the balance lines it states, and the contributions on
 * record. Null without a statement.
 */
export function readStatement(
  statement: StatementOnHand | null,
  periodEnd: string,
  recordContributions: string,
  settings: SuggestionSettings,
): StatementReading | null {
  if (statement === null) return null;
  const tieToleranceUsd = statementTieTolerance(
    BALANCE_LINES.flatMap((key) => {
      const line = statement[key];
      return line === null ? [] : [line.unit];
    }),
    settings,
  ).toFixed();
  const { share } = statement;
  const ending = dollarFigure(statement.endingBalance);
  return {
    tieToleranceUsd,
    mark: statementMark(
      {
        beginningBalance: inDollars(statement.beginningBalance),
        contributionsInPeriod: inDollars(statement.contributionsInPeriod),
        distributionsInPeriod: inDollars(statement.distributionsInPeriod),
        netGainLoss: inDollars(statement.netGainLoss),
        endingBalance: ending === null ? null : ending.value,
        contributionsToDate: inDollars(statement.contributionsToDate),
        share: share === null ? null : share.value,
      },
      recordContributions,
      { tieToleranceUsd, contributionsTolerancePct: settings.contributionsTolerancePct },
    ),
    inputs: [
      ...working('ending_capital_balance', periodEnd, ending),
      ...working('investor_share_pct', periodEnd, share),
    ],
  };
}

const working = (key: string, periodEnd: string, figure: SourcedFigure | null): WorkingInput[] =>
  figure === null
    ? []
    : [{ key, value: figure.value, periodEnd, source: figure.source, edited: figure.edited }];

/** A figure of the approved record, as an input. */
const fromRecord = (quarter: QuarterOnRecord, value: string | null): SourcedFigure | null =>
  value === null
    ? null
    : { value, source: { kind: 'record', id: quarter.id, page: null }, edited: false };

/** The inputs rules 12.2 and 12.3 share: the reference mark and the earlier quarter's figures. */
function referenceInputs(reference: ReferenceOnHand, withEbitda: boolean): WorkingInput[] {
  const { mark, quarter } = reference;
  if (mark === null) return [];
  const markInput: WorkingInput = {
    key: 'reference_mark',
    value: mark.value,
    periodEnd: mark.periodEnd,
    source: { kind: 'valuation', id: mark.valuationId, page: null },
    edited: false,
  };
  if (quarter === null) return [markInput];
  return [
    markInput,
    ...working('reference_enterprise_value', quarter.periodEnd, fromRecord(quarter, quarter.ev)),
    ...working('reference_net_debt', quarter.periodEnd, fromRecord(quarter, quarter.netDebt)),
    ...(withEbitda
      ? working('reference_ebitda_ltm', quarter.periodEnd, fromRecord(quarter, quarter.ebitdaLtm))
      : []),
  ];
}

/**
 * What each source on hand gives, by its own rule and in the configured order. A statement is on
 * hand when one is approved for the quarter (rule 12.1). A report is on hand when the quarter has
 * approved figures: it is read by rule 12.2 when it states an enterprise value and by rule 12.3
 * when it states none, never by both. A source that is not on hand has no reading at all, so a
 * reader is never shown a reason for a document that never arrived.
 */
export function readSources(
  sources: SuggestionSources,
  settings: SuggestionSettings,
): { readings: SourceReading[]; statement: StatementReading | null } {
  if (!isQuarterEnd(sources.periodEnd))
    throw new CalcError(`not a calendar quarter end: ${sources.periodEnd}`, 'invalid_quarter_end');
  const { periodEnd, report, reference } = sources;
  const statement = readStatement(
    sources.statement,
    periodEnd,
    sources.recordContributions,
    settings,
  );
  const quarter = reference.quarter;
  const shared = {
    referenceMark: reference.mark === null ? null : reference.mark.value,
    flowsSinceReferenceMark: reference.flowsSince,
  };

  const read = (basis: SuggestionBasis): SourceReading | null => {
    if (basis === 'capital_account_balance')
      return statement === null
        ? null
        : {
            basis,
            method: statement.mark.method,
            value: statement.mark.value,
            reason: statement.mark.reason,
            inputs: statement.inputs,
          };
    if (report === null) return null;
    if (basis === 'sponsor_equity_value') {
      if (report.ev === null) return null;
      const mark = impliedStakeMark({
        ...shared,
        reference: quarter === null ? null : { ev: quarter.ev, netDebt: quarter.netDebt },
        current: {
          ev: report.ev.value,
          netDebt: report.netDebt === null ? null : report.netDebt.value,
        },
      });
      return {
        basis,
        method: mark.method,
        value: mark.value,
        reason: mark.reason,
        inputs: [
          ...referenceInputs(reference, false),
          ...working('enterprise_value', periodEnd, report.ev),
          ...working('net_debt', periodEnd, report.netDebt),
        ],
      };
    }
    if (report.ev !== null) return null;
    const mark = heldMultipleMark({
      ...shared,
      reference:
        quarter === null
          ? null
          : { ev: quarter.ev, netDebt: quarter.netDebt, ebitda: quarter.ebitdaLtm },
      current: {
        ebitda: report.ebitda === null ? null : report.ebitda.value,
        netDebt: report.netDebt === null ? null : report.netDebt.value,
      },
    });
    return {
      basis,
      method: mark.method,
      value: mark.value,
      reason: mark.reason,
      inputs: [
        ...referenceInputs(reference, true),
        ...working('ebitda_ltm', periodEnd, report.ebitda),
        ...working('net_debt', periodEnd, report.netDebt),
      ],
    };
  };

  return {
    readings: settings.sourceOrder.flatMap((basis) => {
      const reading = read(basis);
      return reading === null ? [] : [reading];
    }),
    statement,
  };
}

/** The other sources beside a suggested value, in the configured order (rule 12.5). */
function crossChecksOf(
  readings: readonly SourceReading[],
  basis: SuggestionBasis,
  value: string | null,
  varianceFlag: string,
): CrossCheck[] {
  return readings
    .filter((other) => other.basis !== basis)
    .map((other) => ({
      basis: other.basis,
      value: other.value,
      reason: other.reason,
      ...sourceCrossCheck(other.value, value, varianceFlag),
    }));
}

/**
 * The suggestion for a position and quarter: of the sources on hand, in the configured order, the
 * first with a value; when none has one, the first on hand, with its reason. The others sit
 * beside it as cross-checks, each with its value (or why it has none) and its difference from
 * the suggested value. Nothing is blended. Null when no source is on hand.
 */
export function selectSuggestion(
  sources: SuggestionSources,
  settings: SuggestionSettings,
): Selection | null {
  const { readings } = readSources(sources, settings);
  const chosen = readings.find((reading) => reading.value !== null) ?? readings[0];
  if (chosen === undefined) return null;
  return {
    ...chosen,
    crossChecks: crossChecksOf(readings, chosen.basis, chosen.value, settings.varianceFlag),
  };
}

/* ---- What a reader is shown beside a suggestion (derived when read) ---- */

/** A suggestion as stored, as far as the reading needs it. */
export interface StoredSuggestion {
  basis: SuggestionBasis;
  value: string | null;
  reason: SuggestionReason | null;
  inputs: readonly WorkingInput[];
}

/** The badges of a suggestion. */
export interface SuggestionFlags {
  /** The change against the previous quarter's mark is at or above the board's flag. */
  variance: boolean;
  /** Whether the statement's lines add up; null with no answer. The page says so when this is false. */
  ties: boolean | null;
  /** The statement's contributions to date differ from the record. */
  contributionsDiffer: boolean;
  /** Another source's value differs from the suggested one by the board's flag or more. */
  sourcesDiffer: boolean;
  /** A reviewer typed one of the inputs. */
  editedByReviewer: boolean;
}

/** Everything derived when a suggestion is read: nothing of it is stored. */
export interface SuggestionReadingView {
  /** Our latest Locked mark of an earlier quarter, with its date and its age in quarters; null when there is none. */
  currentMark: ReferenceOnHand['mark'];
  comparison: MarkComparison;
  /** The two checks of a statement-based suggestion; null for a report-based one. */
  checks: {
    ties: boolean | null;
    tieDifference: string | null;
    tieToleranceUsd: string;
    ownAccount: boolean;
    contributionsCheck: ContributionsCheck;
  } | null;
  crossChecks: CrossCheck[];
  flags: SuggestionFlags;
}

/**
 * What sits beside a stored suggestion when it is read: the mark on record and the comparison of
 * rule 12.4, the two checks of its statement, the other sources of rule 12.5 and the badges. The
 * figures are the stored value's own (the comparison and every difference start from it); the
 * sources are those on hand when it is read. For a statement-based suggestion, `sources.statement`
 * is the statement the suggestion came from.
 */
export function suggestionReading(
  stored: StoredSuggestion,
  sources: SuggestionSources,
  settings: SuggestionSettings,
): SuggestionReadingView {
  const { readings, statement } = readSources(sources, settings);
  const ownStatement = stored.basis === 'capital_account_balance' ? statement : null;
  const mark = sources.reference.mark;
  const comparison = markComparison({
    suggested: stored.value,
    current: mark === null ? null : mark.value,
    currentIsPreviousQuarter: mark?.previousQuarter === true,
    varianceFlag: settings.varianceFlag,
    statement:
      ownStatement === null
        ? null
        : { ...ownStatement.mark.ours, tieToleranceUsd: ownStatement.tieToleranceUsd },
  });
  const crossChecks = crossChecksOf(readings, stored.basis, stored.value, settings.varianceFlag);
  return {
    currentMark: mark,
    comparison,
    checks:
      ownStatement === null
        ? null
        : {
            ties: ownStatement.mark.ties,
            tieDifference: ownStatement.mark.tieDifference,
            tieToleranceUsd: ownStatement.tieToleranceUsd,
            ownAccount: ownStatement.mark.ownAccount,
            contributionsCheck: ownStatement.mark.contributionsCheck,
          },
    crossChecks,
    flags: {
      variance: comparison.variance,
      ties: ownStatement === null ? null : ownStatement.mark.ties,
      contributionsDiffer: ownStatement?.mark.contributionsCheck.differs === true,
      sourcesDiffer: crossChecks.some((check) => check.differs),
      editedByReviewer: stored.inputs.some((input) => input.edited),
    },
  };
}

/* ---- What an approval does to the suggestions of a quarter (docs/18 section 14) ---- */

/** A suggestion written before, as the derivation reads it. */
export interface PriorSuggestion extends StoredSuggestion {
  id: string;
  state: ValuationSuggestionState;
  /** For an Accepted suggestion: the state the valuation version it was accepted onto is in now. */
  valuationState: ValuationState | null;
}

const sameAmount = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : D(a).eq(D(b));

/**
 * True when two suggestions say the same thing: the same basis, the same value (or the same
 * reason for none) and the same inputs, key by key, figure by figure and period by period. Where
 * a figure came from and who typed it are not part of it: the same balance read from a second
 * copy of a statement is the same suggestion, and is not raised again after a dismissal.
 */
export function sameSuggestion(a: StoredSuggestion, b: StoredSuggestion): boolean {
  if (a.basis !== b.basis || a.reason !== b.reason || !sameAmount(a.value, b.value)) return false;
  if (a.inputs.length !== b.inputs.length) return false;
  const theirs = new Map(b.inputs.map((input) => [input.key, input]));
  return a.inputs.every((input) => {
    const other = theirs.get(input.key);
    return other?.periodEnd === input.periodEnd && sameAmount(other.value, input.value);
  });
}

/** The valuation states in which a version is still on its way to Locked. */
const IN_PROGRESS: readonly ValuationState[] = ['Draft', 'OpsPrepared', 'DealTeamApproved'];

/** What one derivation does. Whoever calls it writes exactly this, in one transaction, and audits it. */
export type DerivationStep =
  | {
      /** Nothing is written. */
      action: 'none';
      /**
       * Why: no suggestion applies (a NoSuggestionReason), no source is on hand, the Open
       * suggestion already says the same, or this derivation only refreshes and none is Open.
       */
      because: NoSuggestionReason | 'nothing_on_hand' | 'unchanged' | 'none_open';
    }
  | {
      /** The Open suggestion is superseded and nothing takes its place. */
      action: 'close';
      supersede: { id: string; reason: SupersededReason };
      because: NoSuggestionReason | 'nothing_on_hand';
    }
  | {
      /** A suggestion is written; none was Open. */
      action: 'open';
      selection: Selection;
    }
  | {
      /** The Open suggestion is superseded by the one written. */
      action: 'replace';
      supersede: {
        id: string;
        reason: Extract<SupersededReason, 'better_source' | 'figures_changed'>;
      };
      selection: Selection;
    };

/** What a derivation is handed: the facts of the quarter and the suggestions written before. */
export interface DerivationInput {
  /** `suggestionBar`: why no suggestion applies to the position and quarter, or null. */
  bar: SuggestionBar | null;
  /** `selectSuggestion` over the sources on hand; read only when no bar applies. */
  selection: Selection | null;
  /** The Open suggestion of the position and quarter; there is at most one. */
  open: PriorSuggestion | null;
  /** Its Dismissed and Accepted suggestions. */
  decided: readonly PriorSuggestion[];
  /** `valuationSuggestions.sourceOrder`. */
  sourceOrder: readonly SuggestionBasis[];
  /**
   * `approval` when a statement or a report run was approved: a suggestion may be opened.
   * `refresh` everywhere else (an accounting import, a lock, a reopen, the check at accept): the
   * Open suggestion is derived again and none is ever created.
   */
  mode: 'approval' | 'refresh';
}

/** Why a suggestion decided before stands in the way of the same one being raised again, or null. */
function decidedBefore(
  selection: Selection,
  decided: readonly PriorSuggestion[],
): Extract<NoSuggestionReason, 'dismissed' | 'on_valuation'> | null {
  const same = decided.filter((prior) => sameSuggestion(prior, selection));
  if (same.some((prior) => prior.state === 'Dismissed')) return 'dismissed';
  const carried = same.some(
    (prior) =>
      prior.state === 'Accepted' &&
      prior.valuationState !== null &&
      (prior.valuationState === 'Locked' || IN_PROGRESS.includes(prior.valuationState)),
  );
  return carried ? 'on_valuation' : null;
}

/**
 * The one decision of a derivation (docs/18 section 14). In order:
 * - a bar applies: an Open suggestion is closed with its reason (`mark_locked` for a Locked mark,
 *   `position_closed` for every other bar) and nothing is written;
 * - no source is on hand: nothing to suggest, and an Open suggestion is closed (`figures_changed`);
 * - an Open suggestion says the same as the sources now do: nothing;
 * - the same basis, value and inputs were dismissed, or accepted onto a version in progress or
 *   Locked: nothing is written, and an Open suggestion that says something else is closed
 *   (`figures_changed`);
 * - otherwise the suggestion is written, in place of the Open one when there is one:
 *   `better_source` when its basis comes earlier in the order of sources, `figures_changed`
 *   otherwise. With none Open, a refresh writes nothing.
 */
export function derivationStep(input: DerivationInput): DerivationStep {
  const { bar, selection, open, decided, sourceOrder, mode } = input;
  if (bar !== null) {
    if (open === null) return { action: 'none', because: bar };
    const reason = bar === 'mark_locked' ? 'mark_locked' : 'position_closed';
    return { action: 'close', supersede: { id: open.id, reason }, because: bar };
  }
  if (selection === null) {
    if (open === null) return { action: 'none', because: 'nothing_on_hand' };
    return {
      action: 'close',
      supersede: { id: open.id, reason: 'figures_changed' },
      because: 'nothing_on_hand',
    };
  }
  if (open !== null && sameSuggestion(open, selection))
    return { action: 'none', because: 'unchanged' };
  const before = decidedBefore(selection, decided);
  if (open === null) {
    if (before !== null) return { action: 'none', because: before };
    return mode === 'approval'
      ? { action: 'open', selection }
      : { action: 'none', because: 'none_open' };
  }
  if (before !== null)
    return {
      action: 'close',
      supersede: { id: open.id, reason: 'figures_changed' },
      because: before,
    };
  const better = sourceOrder.indexOf(selection.basis) < sourceOrder.indexOf(open.basis);
  return {
    action: 'replace',
    supersede: { id: open.id, reason: better ? 'better_source' : 'figures_changed' },
    selection,
  };
}

/* ---- A draft valuation opened from a suggestion (docs/18 sections 1 and 14) ---- */

/** Every key a suggestion writes on a draft valuation's inputs starts with this. */
export const SUGGESTION_KEY_PREFIX = 'suggestion.';

/** A suggestion as the draft's keys read it. */
export interface AcceptedSuggestion {
  id: string;
  basis: SuggestionBasis;
  /** The suggested value: a suggestion with none cannot be accepted. */
  value: string;
  periodEnd: string;
  /** The document and the run the suggestion came from, and the first page an input was read from. */
  documentId: string | null;
  page: number | null;
  runId: string;
  inputs: readonly WorkingInput[];
  crossChecks: readonly Pick<CrossCheck, 'basis' | 'value'>[];
}

/**
 * The keys a draft valuation carries once a suggestion is accepted or put on it: flat names to
 * text, nothing for a figure that is missing. They say which suggestion the value came from, each
 * input its rule read and what the other sources gave, so the lock hash seals them with the mark.
 */
export function suggestionDraftKeys(suggestion: AcceptedSuggestion): Record<string, string> {
  const entries: [string, string | null][] = [
    ['id', suggestion.id],
    ['basis', suggestion.basis],
    ['value', suggestion.value],
    ['periodEnd', suggestion.periodEnd],
    ['documentId', suggestion.documentId],
    ['page', suggestion.page === null ? null : String(suggestion.page)],
    ['runId', suggestion.runId],
    ...suggestion.inputs.map((input): [string, string] => [`input.${input.key}`, input.value]),
    ...suggestion.crossChecks.map((check): [string, string | null] => [
      `crossCheck.${check.basis}`,
      check.value,
    ]),
  ];
  return Object.fromEntries(
    entries.flatMap(([key, value]) =>
      value === null ? [] : [[`${SUGGESTION_KEY_PREFIX}${key}`, value]],
    ),
  );
}

const isSuggestionKey = (key: string): boolean => key.startsWith(SUGGESTION_KEY_PREFIX);

/** A draft's inputs with a suggestion's keys in place of any an earlier suggestion left. */
export function withSuggestionKeys<V>(
  inputs: Readonly<Record<string, V>>,
  keys: Readonly<Record<string, string>>,
): Record<string, V | string> {
  return {
    ...Object.fromEntries(Object.entries(inputs).filter(([key]) => !isSuggestionKey(key))),
    ...keys,
  };
}

/**
 * The inputs an edit of a draft stores: what the body sends, with the stored suggestion keys kept
 * whatever it sends for them, so a suggestion's record on a draft can be neither changed nor
 * dropped by hand before the lock hash seals it.
 */
export function keepSuggestionKeys<V>(
  stored: Readonly<Record<string, V>>,
  incoming: Readonly<Record<string, V>>,
): Record<string, V> {
  return Object.fromEntries([
    ...Object.entries(incoming).filter(([key]) => !isSuggestionKey(key)),
    ...Object.entries(stored).filter(([key]) => isSuggestionKey(key)),
  ]);
}

/**
 * The people who cannot approve a valuation version because they stood behind a suggestion
 * accepted onto it: the union of the source reviewers of every Accepted suggestion (the approver
 * of each run an input came from, and whoever typed one). It is the `sourceReviewers` the
 * valuation machine reads for dealTeamApprove and lock.
 */
export function sourceReviewersOf(
  suggestions: readonly { state: string; sourceReviewerIds: readonly string[] }[],
): string[] {
  return [
    ...new Set(
      suggestions.filter((row) => row.state === 'Accepted').flatMap((row) => row.sourceReviewerIds),
    ),
  ].sort();
}

/* ---- What the suggestion machine reads (docs/18 section 14) ---- */

/** The record keys the suggestion machine reads for accept and applyToDraft. */
export interface SuggestionCommandRecord {
  /** The suggestion has a value: one with a reason instead can only be dismissed or superseded. */
  hasValue: boolean;
  /** A Draft, OpsPrepared or DealTeamApproved version reports for the suggestion's quarter. */
  versionInProgress: boolean;
  /** A Draft reports for it: the one version a suggested value can be put on. */
  draftOpen: boolean;
}

/**
 * What the valuation versions of a suggestion's quarter mean for its commands. `quarterVersions`
 * are the versions that report for the suggestion's quarter end (`alignedQuarterEnd`), as the
 * valuation workflow finds the chain of a quarter. With none in progress a draft valuation can be
 * opened (accept); with a Draft open the value goes onto it (applyToDraft); with a version past
 * Draft neither applies until that version is sent back.
 */
export function suggestionCommandRecord(
  value: string | null,
  quarterVersions: readonly { state: string }[],
): SuggestionCommandRecord {
  return {
    hasValue: value !== null,
    versionInProgress: quarterVersions.some((version) =>
      (IN_PROGRESS as readonly string[]).includes(version.state),
    ),
    draftOpen: quarterVersions.some((version) => version.state === 'Draft'),
  };
}
