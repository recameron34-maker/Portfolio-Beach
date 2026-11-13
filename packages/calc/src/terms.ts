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
