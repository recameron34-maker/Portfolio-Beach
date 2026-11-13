import type { IsoDate } from './dates.js';
import { compareIso, daysBetween } from './dates.js';
import type { Decimal, DecimalInput } from './decimal.js';
import { CalcError, D, Decimal as Dec, RESULT_PLACES, ZERO, toDecimalString } from './decimal.js';
import { PLAN_METRICS } from './terms.js';
import type { PlanFigureReason, PlanMetric, PlanMetricReason, PlanStatus } from './terms.js';

/*
 * Performance against the sponsor's underwritten base case (docs/08 section 11, decision 0022):
 * the plan at a date, the variance of the current quarter against it and where that stands. Every
 * function is null, with the reason, instead of a misleading value: a plan figure is never taken
 * from another date and a missing one is never a zero.
 *
 * Every figure worked out here is held to the ten places it travels with before it is used again,
 * so the variance a reader receives is the actual less the plan received, to the last place, and
 * a status can be checked from the percent beside it.
 */

/**
 * A company's figures at one date: a point of the plan, or a quarter of the actuals. Revenue and
 * EBITDA are the twelve months ending on the date and net debt is at the date; any may be missing.
 */
export interface PlanFigures {
  periodEnd: IsoDate;
  revenueLtm: DecimalInput | null;
  ebitdaLtm: DecimalInput | null;
  netDebt: DecimalInput | null;
}

const FIELD = {
  ebitda: 'ebitdaLtm',
  revenue: 'revenueLtm',
  net_debt: 'netDebt',
} as const satisfies Record<PlanMetric, keyof PlanFigures>;

/** Held to the places a result travels with; a figure that rounds to nothing is zero, never a negative zero. */
function held(value: Decimal): Decimal {
  const rounded = value.toDecimalPlaces(RESULT_PLACES);
  return rounded.isZero() ? ZERO : rounded;
}

/** A plan figure at a date, or none and always the reason why. */
export type PlanFigure =
  | {
      value: Decimal;
      /** True when the figure is a straight line between two plan dates, not a sponsor figure. */
      interpolated: boolean;
      reason?: undefined;
    }
  | { value: null; interpolated: false; reason: PlanFigureReason };

const noFigure = (reason: PlanFigureReason): PlanFigure => ({
  value: null,
  interpolated: false,
  reason,
});

/** The points in date order. Two points on one date are refused: a plan says one thing per date. */
function inDateOrder(points: readonly PlanFigures[]): PlanFigures[] {
  const sorted = [...points].sort((a, b) => compareIso(a.periodEnd, b.periodEnd));
  sorted.forEach((point, i) => {
    if (sorted[i + 1]?.periodEnd === point.periodEnd)
      throw new CalcError(`two plan points on ${point.periodEnd}`, 'duplicate_plan_date');
  });
  return sorted;
}

/**
 * The plan for one metric at a date (rule 1): the point's own figure on a plan date; between two
 * neighbouring plan dates a straight line by days, v0 + (v1 - v0) x days(d0, d) / days(d0, d1),
 * flagged as interpolated. No figure before the first plan date, after the last, or where the
 * point on the date (or either neighbour of a date between two) lacks the metric: no point
 * further away is used in its place. A plan with no points has no figure.
 */
export function planAt(
  points: readonly PlanFigures[],
  metric: PlanMetric,
  date: IsoDate,
): PlanFigure {
  const field = FIELD[metric];
  let before: PlanFigures | null = null;
  for (const point of inDateOrder(points)) {
    const order = compareIso(point.periodEnd, date);
    if (order === 0) {
      const own = point[field];
      return own === null
        ? noFigure('missing_plan_figure')
        : { value: D(own), interpolated: false };
    }
    if (order > 0) {
      // The first point after the date: `before` is the last one before it, when there is one.
      if (before === null) return noFigure('before_plan_start');
      const from = before[field];
      const to = point[field];
      if (from === null || to === null) return noFigure('missing_plan_figure');
      const start = D(from);
      const elapsed = new Dec(daysBetween(before.periodEnd, date));
      const whole = new Dec(daysBetween(before.periodEnd, point.periodEnd));
      return {
        value: held(start.plus(D(to).minus(start).times(elapsed).div(whole))),
        interpolated: true,
      };
    }
    before = point;
  }
  return noFigure(before === null ? 'missing_plan_figure' : 'past_plan_end');
}

/** The variance of an actual against its plan figure; the reason says what is missing. */
export interface PlanVariance {
  /** actual - plan, in money. */
  variance: Decimal | null;
  /** variance / plan, held to the places it travels with. */
  variancePct: Decimal | null;
  reason: Exclude<PlanMetricReason, 'no_current_quarter'> | null;
}

/**
 * Variance against plan (rule 2): actual - plan in money, and that over the plan. No percent when
 * the plan figure is zero or less (the variance in money still stands); nothing without a plan
 * figure (its own reason) or without the actual.
 */
export function planVariance(actual: DecimalInput | null, plan: PlanFigure): PlanVariance {
  if (plan.value === null) return { variance: null, variancePct: null, reason: plan.reason };
  if (actual === null) return { variance: null, variancePct: null, reason: 'missing_actual' };
  const variance = D(actual).minus(plan.value);
  if (plan.value.lte(ZERO)) return { variance, variancePct: null, reason: 'non_positive_plan' };
  return { variance, variancePct: held(variance.div(plan.value)), reason: null };
}

/**
 * The percent with the sign that reads "more is better": the percent itself for revenue and
 * EBITDA, its negative for net debt, where less than plan is the favourable side.
 */
export function favourablePct(metric: PlanMetric, variancePct: Decimal): Decimal {
  return metric === 'net_debt' ? variancePct.neg() : variancePct;
}

/**
 * Where a favourable figure stands (rule 3): ahead above the tolerance, behind below its negative,
 * otherwise on plan, so a figure exactly on either edge is on plan. A tolerance below zero is
 * refused.
 */
export function planStatus(favourable: DecimalInput, tolerance: DecimalInput): PlanStatus {
  const edge = D(tolerance);
  if (edge.lt(ZERO))
    throw new CalcError('a tolerance cannot be below zero', 'invalid_plan_tolerance');
  const value = D(favourable);
  if (value.gt(edge)) return 'ahead';
  return value.lt(edge.neg()) ? 'behind' : 'on_plan';
}

/** One metric of the current quarter against plan, as it travels (docs/08 section 1). */
export interface PlanMetricRow {
  metric: PlanMetric;
  actual: string | null;
  plan: string | null;
  /** True when `plan` is a straight line between two plan dates. */
  interpolated: boolean;
  variance: string | null;
  variancePct: string | null;
  status: PlanStatus | null;
  /** Why there is no percent and no status; null when there are. */
  notCalculable: PlanMetricReason | null;
}

function metricRow(
  points: readonly PlanFigures[],
  metric: PlanMetric,
  quarter: PlanFigures | null,
  tolerance: DecimalInput,
): PlanMetricRow {
  if (quarter === null)
    return {
      metric,
      actual: null,
      plan: null,
      interpolated: false,
      variance: null,
      variancePct: null,
      status: null,
      notCalculable: 'no_current_quarter',
    };
  const actual = quarter[FIELD[metric]];
  const plan = planAt(points, metric, quarter.periodEnd);
  const { variance, variancePct, reason } = planVariance(actual, plan);
  return {
    metric,
    actual: actual === null ? null : toDecimalString(D(actual)),
    plan: toDecimalString(plan.value),
    interpolated: plan.interpolated,
    variance: toDecimalString(variance),
    variancePct: toDecimalString(variancePct),
    status: variancePct === null ? null : planStatus(favourablePct(metric, variancePct), tolerance),
    notCalculable: reason,
  };
}

/**
 * The current quarter against plan (rules 1 to 3): one row per metric in the order of
 * PLAN_METRICS, each with the plan at the quarter's date, the variance, the percent and the
 * status, or the reason there is none. `quarter` is null when the position has no current quarter.
 */
export function planMetrics(
  points: readonly PlanFigures[],
  quarter: PlanFigures | null,
  onPlanTolerance: DecimalInput,
): PlanMetricRow[] {
  // Read once on a harmless value, so a bad tolerance is refused whatever the figures.
  planStatus(ZERO, onPlanTolerance);
  return PLAN_METRICS.map((metric) => metricRow(points, metric, quarter, onPlanTolerance));
}

/** The headline of a comparison: the status of EBITDA against plan. There is no blended score. */
export function planHeadline(rows: readonly PlanMetricRow[]): PlanStatus | null {
  return rows.find((row) => row.metric === 'ebitda')?.status ?? null;
}
