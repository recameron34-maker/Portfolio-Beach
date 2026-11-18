import type { IsoDate } from './dates.js';
import {
  addDays,
  alignedQuarterEnd,
  isQuarterEnd,
  latestQuarterEndOnOrBefore,
  quarterOf,
  yearOf,
} from './dates.js';
import type { Decimal, DecimalInput } from './decimal.js';
import {
  CalcError,
  D,
  Decimal as Dec,
  ONE,
  ZERO,
  decimalStringOf,
  heldAsItTravels,
} from './decimal.js';
import { valueChange } from './multiples.js';
import type { MarkRow } from './periods.js';
import { navRollForward, qtdGainLoss } from './rollforward.js';
import { SUGGESTION_METHODS } from './terms.js';
import type {
  ContributionsUncheckedReason,
  HeldMultipleReason,
  StakeMarkReason,
  StatementMarkReason,
} from './terms.js';
import { toDollars } from './units.js';

/*
 * Valuation suggestions (docs/08 section 12, decision 0023): the mark an approved capital account
 * statement or sponsor report implies for a position, and how it sits beside the mark on record.
 * Three rules give a value, each from one source and never a blend: the ending balance of a
 * position-level statement (12.1), our last Locked mark scaled by the equity value the sponsor's
 * report states (12.2), and the same with the earlier quarter's multiple held when the report
 * states no enterprise value (12.3). Rule 12.4 sets a value against the last Locked mark and rule
 * 12.5 against another source's value.
 *
 * Money comes in as dollars. A value is the exact figure rounded half up to the cent once, and
 * every change and percent beside it is worked out from the rounded value, so a reader can check
 * them from the figures shown. A missing input gives the reason, never a zero and never another
 * quarter's figure; a value is above zero or there is none. Answers travel as decimal strings
 * (section 1), so the API and a page that works a suggestion out again cannot disagree.
 */

/**
 * Arithmetic wide enough that a product of any three figures the record can hold is exact, so a
 * value is the exact quotient rounded once and not a rounding of a rounding.
 */
const Wide = Dec.clone({ precision: 120, rounding: Dec.ROUND_HALF_UP });

/** An exact figure in the wide arithmetic. */
const wide = (value: DecimalInput): Decimal => new Wide(D(value));

/** Rounded half up to the cent; what rounds to nothing is zero, never a negative zero. */
function toCents(value: Decimal): Decimal {
  const rounded = new Dec(value.toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed());
  return rounded.isZero() ? ZERO : rounded;
}

/** A figure as it travels (section 1): held to ten places first, so nothing travels as a negative zero. */
function travels(value: Decimal): string;
function travels(value: Decimal | null): string | null;
function travels(value: Decimal | null): string | null {
  return value === null ? null : decimalStringOf(heldAsItTravels(value));
}

const invalid = (message: string): CalcError => new CalcError(message, 'invalid_suggestion_input');

/** A tolerance or a flag as config holds it: never below zero. */
function notNegative(value: DecimalInput, name: string): Decimal {
  const parsed = D(value);
  if (parsed.lt(ZERO)) throw invalid(`${name} cannot be below zero`);
  return parsed;
}

/* ---- 12.1 The statement ---- */

/**
 * The lines of a capital account statement, in dollars; null for a line the statement does not
 * state. The five balance lines and the contributions to date are for the whole vehicle when the
 * statement gives our share of it, and for our own account when it gives none.
 */
export interface StatementLines {
  beginningBalance: DecimalInput | null;
  contributionsInPeriod: DecimalInput | null;
  distributionsInPeriod: DecimalInput | null;
  netGainLoss: DecimalInput | null;
  endingBalance: DecimalInput | null;
  contributionsToDate: DecimalInput | null;
  /** Our share of the vehicle as a fraction (0.25 for 25%); null when the lines are our own account. */
  share: DecimalInput | null;
}

/** The two tolerances the checks of a statement read, from config. */
export interface StatementTolerances {
  /** How far apart, in dollars, the five balance lines may be and still tie (`statementTieTolerance`). */
  tieToleranceUsd: DecimalInput;
  /** `valuationSuggestions.contributionsTolerancePct`: contributions further apart than this share of the record differ. */
  contributionsTolerancePct: DecimalInput;
}

/** The statement's contributions to date against the record; it changes no value. */
export interface ContributionsCheck {
  /** T: the contributions to date times our share, to the cent; null when not stated or the share is out of range. */
  statement: string | null;
  /** R: the approved contributions on the position on or before the period end. */
  record: string;
  /** T - R; null when not checked. */
  difference: string | null;
  /** (T - R) / R as it travels; null when not checked. */
  differencePct: string | null;
  /** True when the absolute percent, as it travels, is above the tolerance; null when not checked. */
  differs: boolean | null;
  /** Why the two are not set against each other; null when they are. */
  notChecked: ContributionsUncheckedReason | null;
}

/** What a statement says our interest is worth, with its two checks (rule 12.1). */
export interface StatementMark {
  basis: 'capital_account_balance';
  method: (typeof SUGGESTION_METHODS)['capital_account_balance'];
  /** S: the ending balance times our share, to the cent; null with the reason. */
  value: string | null;
  reason: StatementMarkReason | null;
  /** True when the statement gives no share, so its lines were read as our own account. */
  ownAccount: boolean;
  /**
   * Our part of the lines rule 12.4 reads (the line times our share, to the cent); null for a
   * line not stated, and for every line when the share is out of range.
   */
  ours: {
    beginningBalance: string | null;
    contributionsInPeriod: string | null;
    distributionsInPeriod: string | null;
  };
  /** Whether the statement's own lines add up within the tolerance; null unless all five are stated. */
  ties: boolean | null;
  /** The ending balance less the sum of the other four lines; null unless all five are stated. */
  tieDifference: string | null;
  contributionsCheck: ContributionsCheck;
}

/**
 * Rule 12.1: S = B x p, where B is the ending capital balance and p is our share of the vehicle
 * when the lines are for the whole vehicle, 1 when they are our own account. No value without an
 * ending balance, with one at or below zero, or with a share not above 0 or above 1, in that
 * order. The two checks change neither the value nor its reason: whether the statement's own
 * lines add up (`navRollForward` over them, when all five are stated), and whether its
 * contributions to date, at our share, agree with the approved contributions on record.
 */
export function statementMark(
  lines: StatementLines,
  recordContributions: DecimalInput,
  tolerances: StatementTolerances,
): StatementMark {
  const tieTolerance = notNegative(tolerances.tieToleranceUsd, 'the tie tolerance');
  const contributionsTolerance = notNegative(
    tolerances.contributionsTolerancePct,
    'the contributions tolerance',
  );
  const record = notNegative(recordContributions, 'the contributions on record');

  const ownAccount = lines.share === null;
  const stated = lines.share === null ? ONE : D(lines.share);
  const share = stated.gt(ZERO) && stated.lte(ONE) ? stated : null;
  const ourPart = (line: DecimalInput | null): Decimal | null =>
    line === null || share === null ? null : toCents(wide(line).times(share));

  let value: Decimal | null = null;
  let reason: StatementMarkReason | null = null;
  if (lines.endingBalance === null) reason = 'no_ending_balance';
  else if (D(lines.endingBalance).lte(ZERO)) reason = 'non_positive_balance';
  else if (share === null) reason = 'share_out_of_range';
  else {
    const ours = toCents(wide(lines.endingBalance).times(share));
    if (ours.gt(ZERO)) value = ours;
    else reason = 'value_not_positive';
  }

  const { beginningBalance, contributionsInPeriod, distributionsInPeriod, netGainLoss } = lines;
  const tie =
    beginningBalance === null ||
    contributionsInPeriod === null ||
    distributionsInPeriod === null ||
    netGainLoss === null ||
    lines.endingBalance === null
      ? null
      : navRollForward(
          {
            beginNav: beginningBalance,
            contributions: contributionsInPeriod,
            distributions: distributionsInPeriod,
            gainLoss: netGainLoss,
            endNav: lines.endingBalance,
          },
          tieTolerance,
        );

  return {
    basis: 'capital_account_balance',
    method: SUGGESTION_METHODS.capital_account_balance,
    value: travels(value),
    reason,
    ownAccount,
    ours: {
      beginningBalance: travels(ourPart(beginningBalance)),
      contributionsInPeriod: travels(ourPart(contributionsInPeriod)),
      distributionsInPeriod: travels(ourPart(distributionsInPeriod)),
    },
    ties: tie === null ? null : tie.passed,
    tieDifference: tie === null ? null : travels(tie.difference),
    contributionsCheck: contributionsCheck(
      lines.contributionsToDate,
      ourPart(lines.contributionsToDate),
      record,
      contributionsTolerance,
    ),
  };
}

function contributionsCheck(
  stated: DecimalInput | null,
  ours: Decimal | null,
  record: Decimal,
  tolerance: Decimal,
): ContributionsCheck {
  const unchecked = (notChecked: ContributionsUncheckedReason): ContributionsCheck => ({
    statement: travels(ours),
    record: travels(record),
    difference: null,
    differencePct: null,
    differs: null,
    notChecked,
  });
  if (stated === null) return unchecked('contributions_not_stated');
  if (ours === null) return unchecked('share_out_of_range');
  const change = valueChange(ours, record);
  if (change === null) return unchecked('no_recorded_contributions');
  const pct = heldAsItTravels(change);
  return {
    statement: travels(ours),
    record: travels(record),
    difference: travels(ours.minus(record)),
    differencePct: travels(pct),
    differs: pct.abs().gt(tolerance),
    notChecked: null,
  };
}

/** The tolerances the lines of a statement may be apart by, from config. */
export interface TieTolerances {
  /** `rollForwardToleranceUsd`: for a statement read in dollars. */
  rollForwardToleranceUsd: DecimalInput;
  /** `valuationSuggestions.tieToleranceByUnit`: for one read in thousands, millions or billions. */
  tieToleranceByUnit: Readonly<Record<string, DecimalInput>>;
}

/**
 * How far apart, in dollars, the five balance lines of a statement may be and still tie: the
 * roll-forward tolerance when every line was read in dollars, otherwise the tolerance config
 * gives for the coarsest unit a line was read in, since each line was rounded in its own unit
 * before it was printed. `units` are the units of the balance lines the statement states. A unit
 * `toDollars` does not know is refused, and so is a coarser unit config gives no tolerance for:
 * there is no default in code.
 */
export function statementTieTolerance(
  units: readonly string[],
  tolerances: TieTolerances,
): Decimal {
  let coarsest = 'USD';
  let factor = toDollars('1', coarsest);
  for (const unit of units) {
    const dollars = toDollars('1', unit);
    if (dollars.gt(factor)) [coarsest, factor] = [unit, dollars];
  }
  if (coarsest === 'USD')
    return notNegative(tolerances.rollForwardToleranceUsd, 'the roll-forward tolerance');
  const configured = new Map(Object.entries(tolerances.tieToleranceByUnit)).get(coarsest);
  if (configured === undefined)
    throw new CalcError(`no tie tolerance for ${coarsest}`, 'missing_tie_tolerance');
  return notNegative(configured, `the tie tolerance for ${coarsest}`);
}

/* ---- 12.2 and 12.3 The sponsor's report ---- */

/** The enterprise value and net debt of a company at one quarter, in dollars; either may be missing. */
export interface EquityFigures {
  ev: DecimalInput | null;
  netDebt: DecimalInput | null;
}

/** What rule 12.2 reads. */
export interface StakeMarkInput {
  /** M0: our latest Locked mark of an earlier quarter; null when there is none. */
  referenceMark: DecimalInput | null;
  /** True when an approved cash flow is dated after that mark's period end and on or before the new one. */
  flowsSinceReferenceMark: boolean;
  /** The approved figures of the quarter that mark reports for; null when there are none. */
  reference: EquityFigures | null;
  /** The new quarter: the enterprise value the report states, and its net debt. */
  current: { ev: DecimalInput; netDebt: DecimalInput | null };
}

/** Our last Locked mark scaled by the change in the sponsor's equity value (rule 12.2). */
export interface StakeMark {
  basis: 'sponsor_equity_value';
  method: (typeof SUGGESTION_METHODS)['sponsor_equity_value'];
  /** S, to the cent; null with the reason. */
  value: string | null;
  reason: StakeMarkReason | null;
  /** E0: enterprise value less net debt at the reference mark's quarter; null when either is missing. */
  referenceEquity: string | null;
  /** E1: the same for the new quarter; null when it was not reached or net debt is missing. */
  equity: string | null;
}

/** M0, E0 and the figures E0 came from, or the first reason there is no value to scale. */
type Reference<F extends EquityFigures> =
  | { mark: Decimal; ev: Decimal; equity: Decimal; figures: F; reason: null }
  | { mark: null; equity: Decimal | null; reason: StakeMarkReason };

/** Enterprise value less net debt at the reference quarter, with the figures it came from; null when either is missing. */
function statedEquity<F extends EquityFigures>(
  figures: F | null,
): { figures: F; ev: Decimal; equity: Decimal } | null {
  if (figures === null) return null;
  const { ev, netDebt } = figures;
  if (ev === null || netDebt === null) return null;
  return { figures, ev: D(ev), equity: D(ev).minus(D(netDebt)) };
}

/** The start of rules 12.2 and 12.3: the reference mark and the equity value it is scaled from. */
function referenceOf<F extends EquityFigures>(
  referenceMark: DecimalInput | null,
  flowsSince: boolean,
  figures: F | null,
): Reference<F> {
  const stated = statedEquity(figures);
  const none = (reason: StakeMarkReason): Reference<F> => ({
    mark: null,
    equity: stated === null ? null : stated.equity,
    reason,
  });
  if (referenceMark === null) return none('no_reference_mark');
  if (flowsSince) return none('flows_since_reference_mark');
  if (stated === null) return none('no_reference_figures');
  if (stated.equity.lte(ZERO)) return none('non_positive_reference_equity');
  return { mark: D(referenceMark), ...stated, reason: null };
}

/** The exact quotient to the cent: a value above zero, or the reason there is none. */
function scaled(
  numerator: Decimal,
  denominator: Decimal,
): { value: Decimal; reason: null } | { value: null; reason: 'value_not_positive' } {
  const value = toCents(numerator.div(denominator));
  return value.gt(ZERO) ? { value, reason: null } : { value: null, reason: 'value_not_positive' };
}

/**
 * Rule 12.2: a report values the company and not our holding, so our last Locked mark is scaled
 * by the change in the company's equity value. S = M0 x E1 / E0, where M0 is our latest Locked
 * mark of an earlier quarter, E0 is enterprise value less net debt from that quarter's approved
 * figures and E1 the same for the new quarter (never the total equity a record carries, which may
 * be book equity). No value without M0, after a cash flow since it (our stake may have changed),
 * without E0 or with one at or below zero, without the new net debt or with an E1 at or below
 * zero, in that order.
 */
export function impliedStakeMark(input: StakeMarkInput): StakeMark {
  const reference = referenceOf(
    input.referenceMark,
    input.flowsSinceReferenceMark,
    input.reference,
  );
  const answer = (
    value: Decimal | null,
    reason: StakeMarkReason | null,
    equity: Decimal | null,
  ): StakeMark => ({
    basis: 'sponsor_equity_value',
    method: SUGGESTION_METHODS.sponsor_equity_value,
    value: travels(value),
    reason,
    referenceEquity: travels(reference.equity),
    equity: travels(equity),
  });
  if (reference.reason !== null) return answer(null, reference.reason, null);
  if (input.current.netDebt === null) return answer(null, 'no_net_debt', null);
  const equity = D(input.current.ev).minus(D(input.current.netDebt));
  if (equity.lte(ZERO)) return answer(null, 'non_positive_equity', equity);
  const result = scaled(wide(reference.mark).times(wide(equity)), wide(reference.equity));
  return answer(result.value, result.reason, equity);
}

/** What rule 12.3 reads: rule 12.2's inputs, with EBITDA in both quarters and no new enterprise value. */
export interface HeldMultipleInput {
  referenceMark: DecimalInput | null;
  flowsSinceReferenceMark: boolean;
  /** The approved figures of the quarter the reference mark reports for; null when there are none. */
  reference: (EquityFigures & { ebitda: DecimalInput | null }) | null;
  /** The new quarter, whose report states no enterprise value. */
  current: { ebitda: DecimalInput | null; netDebt: DecimalInput | null };
}

/** Rule 12.2 with the enterprise value worked out at the earlier quarter's multiple (rule 12.3). */
export interface HeldMultipleMark {
  basis: 'held_multiple';
  method: (typeof SUGGESTION_METHODS)['held_multiple'];
  /** S, to the cent; null with the reason. */
  value: string | null;
  reason: HeldMultipleReason | null;
  /** E0, as in rule 12.2. */
  referenceEquity: string | null;
  /** EV1: the new EBITDA at the earlier quarter's multiple, as it travels; null when not reached. */
  impliedEv: string | null;
  /** E1: that enterprise value less the new net debt, as it travels; null when not reached. */
  equity: string | null;
}

/**
 * Rule 12.3, only when the new quarter's report states no enterprise value: the earlier quarter's
 * multiple is held, EV1 = EBITDA1 x EV0 / EBITDA0, and rule 12.2 follows with it. Rule 12.2's
 * reasons stand in their order, with two more before the new net debt is read: an EBITDA missing
 * in either quarter, then one at or below zero in either (a multiple of nothing is not held). The
 * value is the exact figure to the cent: the enterprise value is not rounded on the way.
 */
export function heldMultipleMark(input: HeldMultipleInput): HeldMultipleMark {
  const reference = referenceOf(
    input.referenceMark,
    input.flowsSinceReferenceMark,
    input.reference,
  );
  const answer = (
    value: Decimal | null,
    reason: HeldMultipleReason | null,
    impliedEv: Decimal | null,
    equity: Decimal | null,
  ): HeldMultipleMark => ({
    basis: 'held_multiple',
    method: SUGGESTION_METHODS.held_multiple,
    value: travels(value),
    reason,
    referenceEquity: travels(reference.equity),
    impliedEv: travels(impliedEv),
    equity: travels(equity),
  });
  if (reference.reason !== null) return answer(null, reference.reason, null, null);
  const ebitda0 = reference.figures.ebitda;
  const ebitda1 = input.current.ebitda;
  if (ebitda0 === null || ebitda1 === null) return answer(null, 'no_ebitda', null, null);
  if (D(ebitda0).lte(ZERO) || D(ebitda1).lte(ZERO))
    return answer(null, 'non_positive_ebitda', null, null);
  // EV1 and E1 over the one denominator EBITDA0, so nothing is rounded before the value is.
  const evTimesBase = wide(ebitda1).times(wide(reference.ev));
  const impliedEv = evTimesBase.div(wide(ebitda0));
  if (input.current.netDebt === null) return answer(null, 'no_net_debt', impliedEv, null);
  const equityTimesBase = evTimesBase.minus(wide(input.current.netDebt).times(wide(ebitda0)));
  const equity = equityTimesBase.div(wide(ebitda0));
  if (equityTimesBase.lte(ZERO)) return answer(null, 'non_positive_equity', impliedEv, equity);
  const result = scaled(
    wide(reference.mark).times(equityTimesBase),
    wide(reference.equity).times(wide(ebitda0)),
  );
  return answer(result.value, result.reason, impliedEv, equity);
}

/* ---- 12.4 and 12.5 A value beside the mark on record and beside another source ---- */

/**
 * The variance rule of the valuation board, the one rule for every flag of its kind: a change is
 * flagged when its absolute percent, as it travels, is at or above the flag
 * (`valuationVarianceFlag`). No percent, no flag.
 */
export function atOrAboveVarianceFlag(
  changePct: DecimalInput | null,
  varianceFlag: DecimalInput,
): boolean {
  const flag = notNegative(varianceFlag, 'the variance flag');
  return changePct !== null && heldAsItTravels(D(changePct)).abs().gte(flag);
}

/** What rule 12.4 reads. */
export interface MarkComparisonInput {
  /** S: the suggested value; null when the suggestion has none. */
  suggested: DecimalInput | null;
  /** C: our latest Locked mark of an earlier quarter; null when there is none. */
  current: DecimalInput | null;
  /** True when C reports for the quarter end just before the suggestion's. */
  currentIsPreviousQuarter: boolean;
  /** `valuationVarianceFlag`. */
  varianceFlag: DecimalInput;
  /**
   * For a value from a statement: our part of its beginning balance and of its two period lines
   * (`StatementMark.ours`) and the statement's tie tolerance. Null for a value from a report.
   */
  statement: {
    beginningBalance: DecimalInput | null;
    contributionsInPeriod: DecimalInput | null;
    distributionsInPeriod: DecimalInput | null;
    tieToleranceUsd: DecimalInput;
  } | null;
}

/** A suggested value against the mark on record (rule 12.4). */
export interface MarkComparison {
  /** S - C; null without either. */
  change: string | null;
  /** (S - C) / C as it travels; null without either, or against a mark of zero. */
  changePct: string | null;
  /** The board's variance flag; false (no badge) unless C is the previous quarter's mark. */
  variance: boolean;
  /** The change with the quarter's contributions taken out and its distributions added back; null unless the statement supports it. */
  netOfFlows: string | null;
  /** The net of flows over C, as it travels. */
  netOfFlowsPct: string | null;
  /** Our part of the statement's beginning balance, to show beside C when there is no net of flows; null when not stated. */
  beginningBalance: string | null;
}

/**
 * Rule 12.4: change = S - C and percent = `valueChange(S, C)`, neither without C. The variance
 * flag is the board's rule and no other, and only when C is the previous quarter's mark: against
 * an older mark the change spans more than a quarter and carries no badge. The net of flows is
 * `qtdGainLoss` over S, C and our part of the statement's two period lines: a separate figure,
 * worked out only when C is the previous quarter's mark, the statement states both period lines,
 * and our part of its beginning balance equals C within the statement's tie tolerance (so the
 * statement starts where our record does). Otherwise the page shows that balance beside C.
 */
export function markComparison(input: MarkComparisonInput): MarkComparison {
  // Read before anything is worked out, so a bad flag or tolerance is refused whatever the figures.
  notNegative(input.varianceFlag, 'the variance flag');
  const statement =
    input.statement === null
      ? null
      : {
          ...input.statement,
          tolerance: notNegative(input.statement.tieToleranceUsd, 'the tie tolerance'),
        };
  const stated = statement?.beginningBalance ?? null;
  const begin = stated === null ? null : D(stated);
  const suggested = input.suggested === null ? null : D(input.suggested);
  const current = input.current === null ? null : D(input.current);
  if (suggested === null || current === null)
    return {
      change: null,
      changePct: null,
      variance: false,
      netOfFlows: null,
      netOfFlowsPct: null,
      beginningBalance: travels(begin),
    };

  const changePct = valueChange(suggested, current);
  let netOfFlows: Decimal | null = null;
  if (
    input.currentIsPreviousQuarter &&
    statement !== null &&
    begin !== null &&
    statement.contributionsInPeriod !== null &&
    statement.distributionsInPeriod !== null &&
    begin.minus(current).abs().lte(statement.tolerance)
  )
    netOfFlows = qtdGainLoss({
      endNav: suggested,
      beginNavOfQuarter: current,
      contributionsQtd: statement.contributionsInPeriod,
      distributionsQtd: statement.distributionsInPeriod,
    });
  return {
    change: travels(suggested.minus(current)),
    changePct: travels(changePct),
    variance:
      input.currentIsPreviousQuarter && atOrAboveVarianceFlag(changePct, input.varianceFlag),
    netOfFlows: travels(netOfFlows),
    netOfFlowsPct: travels(
      netOfFlows === null || current.isZero() ? null : netOfFlows.div(current),
    ),
    beginningBalance: travels(begin),
  };
}

/** A suggested value against what another source gives for the same quarter (rule 12.5). */
export interface SourceCrossCheck {
  /** X - S; null without either. */
  difference: string | null;
  /** (X - S) / S as it travels. */
  differencePct: string | null;
  /** True when the absolute percent is at or above the variance flag. Nothing is averaged. */
  differs: boolean;
}

/**
 * Rule 12.5: for another source's value X, difference = X - S and percent = `valueChange(X, S)`.
 * The sources differ by the board's variance rule over that percent. A source with no value has
 * no difference and does not differ.
 */
export function sourceCrossCheck(
  other: DecimalInput | null,
  suggested: DecimalInput | null,
  varianceFlag: DecimalInput,
): SourceCrossCheck {
  notNegative(varianceFlag, 'the variance flag');
  if (other === null || suggested === null)
    return { difference: null, differencePct: null, differs: false };
  const pct = valueChange(other, suggested);
  return {
    difference: travels(D(other).minus(D(suggested))),
    differencePct: travels(pct),
    differs: atOrAboveVarianceFlag(pct, varianceFlag),
  };
}

/* ---- Which marks and flows count for a quarter ---- */

function requireQuarterEnd(quarterEnd: IsoDate): void {
  if (!isQuarterEnd(quarterEnd))
    throw new CalcError(`not a calendar quarter end: ${quarterEnd}`, 'invalid_quarter_end');
}

/** The calendar quarter end before a calendar quarter end. */
export function previousQuarterEnd(quarterEnd: IsoDate): IsoDate {
  requireQuarterEnd(quarterEnd);
  return latestQuarterEndOnOrBefore(addDays(quarterEnd, -1));
}

/** Whole calendar quarters from the quarter that contains one date to the quarter that contains another. */
export function quartersBetween(from: IsoDate, to: IsoDate): number {
  return (yearOf(to) - yearOf(from)) * 4 + (quarterOf(to) - quarterOf(from));
}

/** The Locked mark a suggestion is set against, and how it stands to the suggestion's quarter. */
export interface ReferenceMark<T extends MarkRow> {
  mark: T;
  /** The quarter end the mark reports for (`alignedQuarterEnd`). */
  reportsFor: IsoDate;
  /** True when that is the quarter end just before the suggestion's. */
  previousQuarter: boolean;
  /**
   * Whole calendar quarters from the mark's quarter to the suggestion's: 1 for the previous
   * quarter's mark; 0 for a mark dated inside the suggestion's own quarter and further from its
   * end than the tolerance.
   */
  ageQuarters: number;
}

/**
 * The latest Locked mark of an earlier quarter: the mark a suggestion for `quarterEnd` is compared
 * with (C of rule 12.4) and the one rule 12.2 scales (M0). A mark counts for the quarter end
 * `alignedQuarterEnd` gives it, as the valuation workflow and `lockedNear` count it, so one dated
 * a few days after a quarter end is that quarter's and never a later one's. On equal period ends
 * the first in input order wins, so callers that list the highest version first get the latest
 * version.
 */
export function latestLockedBefore<T extends MarkRow>(
  marks: readonly T[],
  quarterEnd: IsoDate,
  toleranceDays: number,
): ReferenceMark<T> | null {
  requireQuarterEnd(quarterEnd);
  let best: { mark: T; reportsFor: IsoDate } | null = null;
  for (const mark of marks) {
    if (mark.state !== 'Locked') continue;
    const reportsFor = alignedQuarterEnd(mark.periodEnd, toleranceDays);
    if (reportsFor >= quarterEnd) continue;
    if (best === null || mark.periodEnd > best.mark.periodEnd) best = { mark, reportsFor };
  }
  if (best === null) return null;
  return {
    ...best,
    previousQuarter: best.reportsFor === previousQuarterEnd(quarterEnd),
    ageQuarters: quartersBetween(best.reportsFor, quarterEnd),
  };
}

/**
 * True when a Locked mark reports for the quarter or a later one: the quarter is then marked and
 * no suggestion for it applies.
 */
export function lockedForOrAfter(
  marks: readonly MarkRow[],
  quarterEnd: IsoDate,
  toleranceDays: number,
): boolean {
  requireQuarterEnd(quarterEnd);
  return marks.some(
    (mark) =>
      mark.state === 'Locked' && alignedQuarterEnd(mark.periodEnd, toleranceDays) >= quarterEnd,
  );
}

/**
 * True when a flow is dated after one date and on or before another: for rule 12.2, an approved
 * cash flow after the reference mark's own period end and on or before the new quarter end.
 */
export function hasFlowBetween(
  flows: readonly { date: IsoDate }[],
  after: IsoDate,
  onOrBefore: IsoDate,
): boolean {
  return flows.some((flow) => flow.date > after && flow.date <= onOrBefore);
}
