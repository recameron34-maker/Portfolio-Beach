/*
 * The names the value creation views share with the API contract (docs/08 section 8). They live
 * apart from the functions so a consumer that only needs the names bundles nothing else.
 */

/**
 * Why a figure of the value creation views is not calculable, in the order every view lists the
 * reasons. The first five say why a company has no EBITDA bridge: no approved entry snapshot, an
 * approved entry snapshot dated after the as-of date, no approved quarter on or before the as-of
 * date (or the exit), an EBITDA, EV or net debt missing at either end, or an EBITDA at or below
 * zero at either end. The last two say why our gain is not set against a bridge that stands: the
 * company's equity value at entry is not positive (no stake), or our own gain is not calculable
 * (no Locked valuation, or nothing invested).
 */
export const VALUE_CREATION_REASONS = [
  'no_entry_snapshot',
  'entry_snapshot_forward_dated',
  'no_current_quarter',
  'missing_figures',
  'non_positive_ebitda',
  'non_positive_entry_equity',
  'no_gain',
] as const;
export type ValueCreationReason = (typeof VALUE_CREATION_REASONS)[number];

/** The key of the cohort that holds the positions with no entry figure to band. */
export const NOT_CALCULABLE_BAND = 'not_calculable';

/*
 * The names the comparison against the underwritten base case shares with the API contract
 * (docs/08 section 11).
 */

/** The company figures a base case plans, in the order they are answered: EBITDA is the headline. */
export const PLAN_METRICS = ['ebitda', 'revenue', 'net_debt'] as const;
export type PlanMetric = (typeof PLAN_METRICS)[number];

/** Where a figure stands against plan, best first. */
export const PLAN_STATUSES = ['ahead', 'on_plan', 'behind'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * Why a plan has no figure at a date: the date is before its first point, after its last, or the
 * point on the date (or a neighbour of a date between two points) lacks the figure.
 */
export const PLAN_FIGURE_REASONS = [
  'before_plan_start',
  'past_plan_end',
  'missing_plan_figure',
] as const;
export type PlanFigureReason = (typeof PLAN_FIGURE_REASONS)[number];

/**
 * Why a metric has no variance, percent or status against plan, in the order they are decided:
 * no approved quarter to compare, no plan figure (the three reasons above), the quarter lacks the
 * figure, or the plan figure is zero or less (the variance in money stands; the percent does not).
 */
export const PLAN_METRIC_REASONS = [
  'no_current_quarter',
  ...PLAN_FIGURE_REASONS,
  'missing_actual',
  'non_positive_plan',
] as const;
export type PlanMetricReason = (typeof PLAN_METRIC_REASONS)[number];

/** The forms a base case takes: plan points and exit terms for equity, yield and loss rate for a loan. */
export const UNDERWRITING_FORMS = ['equity', 'credit'] as const;
export type UnderwritingForm = (typeof UNDERWRITING_FORMS)[number];

/**
 * Why the value creation against plan is not calculable, in the order every view lists the
 * reasons. The first five are the reasons a company has no EBITDA bridge (the first five of
 * VALUE_CREATION_REASONS); the last is the plan's own: no plan point on the planned exit, or one
 * without EBITDA or net debt. An EBITDA at or below zero at the planned exit is
 * `non_positive_ebitda`, as it is at either end of the actual bridge.
 */
export const PLAN_PROGRESS_REASONS = [
  'no_entry_snapshot',
  'entry_snapshot_forward_dated',
  'no_current_quarter',
  'missing_figures',
  'non_positive_ebitda',
  'missing_plan_figure',
] as const;
export type PlanProgressReason = (typeof PLAN_PROGRESS_REASONS)[number];

/**
 * Why a held position has no MOIC on the underwritten path: the as-of date is after the planned
 * exit, or nothing was invested by the as-of date. A realized position has no path and no reason:
 * its gap is against the underwritten MOIC at exit.
 */
export const PLAN_PATH_REASONS = ['past_plan_end', 'no_invested_capital'] as const;
export type PlanPathReason = (typeof PLAN_PATH_REASONS)[number];

/*
 * The names the valuation suggestions share with the API contract (docs/08 section 12).
 */

/**
 * What a suggested mark rests on, in the order the sources are tried unless config says otherwise
 * (`valuationSuggestions.sourceOrder`): the ending balance of a position-level capital account
 * statement, the equity value the sponsor's report states, or that report with the earlier
 * quarter's multiple held.
 */
export const SUGGESTION_BASES = [
  'capital_account_balance',
  'sponsor_equity_value',
  'held_multiple',
] as const;
export type SuggestionBasis = (typeof SUGGESTION_BASES)[number];

/**
 * The valuation method (a `valuation_method` taxonomy code) a draft opened from each basis
 * carries: the sponsor's own mark for a statement, an indication from the sponsor's report for the
 * two report bases.
 */
export const SUGGESTION_METHODS = {
  capital_account_balance: 'valuation_method.sponsor_mark',
  sponsor_equity_value: 'valuation_method.report_indication',
  held_multiple: 'valuation_method.report_indication',
} as const satisfies Record<SuggestionBasis, string>;

/**
 * Why a source gives no value, in the order the reasons are decided: when several apply, the
 * first listed is the reason. The first three are a statement's (rule 12.1): no ending balance,
 * one at or below zero, a share of the vehicle not above 0 or above 1. The next eight are a
 * report's (rules 12.2 and 12.3): no Locked mark of an earlier quarter; an approved cash flow
 * since that mark; no approved enterprise value or net debt for that mark's quarter; an equity
 * value at or below zero there; an EBITDA missing in either quarter, or at or below zero in
 * either (the multiple held only); no net debt for the new quarter; an equity value at or below
 * zero in it. The last is any rule's: the value works out at zero or less to the cent (a balance
 * under half a cent, a Locked mark of zero), and a mark is above zero.
 */
export const SUGGESTION_REASONS = [
  'no_ending_balance',
  'non_positive_balance',
  'share_out_of_range',
  'no_reference_mark',
  'flows_since_reference_mark',
  'no_reference_figures',
  'non_positive_reference_equity',
  'no_ebitda',
  'non_positive_ebitda',
  'no_net_debt',
  'non_positive_equity',
  'value_not_positive',
] as const;
export type SuggestionReason = (typeof SUGGESTION_REASONS)[number];

/** The reasons a statement gives no value (rule 12.1). */
export type StatementMarkReason = Extract<
  SuggestionReason,
  'no_ending_balance' | 'non_positive_balance' | 'share_out_of_range' | 'value_not_positive'
>;

/** The reasons the sponsor's equity value gives none (rule 12.2). */
export type StakeMarkReason = Extract<
  SuggestionReason,
  | 'no_reference_mark'
  | 'flows_since_reference_mark'
  | 'no_reference_figures'
  | 'non_positive_reference_equity'
  | 'no_net_debt'
  | 'non_positive_equity'
  | 'value_not_positive'
>;

/** The reasons the multiple held gives none (rule 12.3): those of rule 12.2 and the two of EBITDA. */
export type HeldMultipleReason = StakeMarkReason | 'no_ebitda' | 'non_positive_ebitda';

/**
 * Why a statement's contributions to date are not set against the record, in the order they are
 * decided: the statement does not state them, our share of the vehicle is out of range (so our
 * part of them cannot be worked out), or the record holds no approved contribution.
 */
export const CONTRIBUTIONS_UNCHECKED_REASONS = [
  'contributions_not_stated',
  'share_out_of_range',
  'no_recorded_contributions',
] as const;
export type ContributionsUncheckedReason = (typeof CONTRIBUTIONS_UNCHECKED_REASONS)[number];
