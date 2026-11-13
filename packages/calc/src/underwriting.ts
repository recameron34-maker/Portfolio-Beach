import { valueCreationBridge } from './bridge.js';
import type { CashFlow } from './cashflows.js';
import type { IsoDate } from './dates.js';
import { compareIso, daysBetween } from './dates.js';
import type { Decimal, DecimalInput } from './decimal.js';
import {
  CalcError,
  D,
  Decimal as Dec,
  ONE,
  RESULT_PLACES,
  ZERO,
  toDecimalString,
  trimFractionZeros,
} from './decimal.js';
import type { IrrFlag } from './pooled.js';
import { PLAN_METRICS } from './terms.js';
import type {
  PlanFigureReason,
  PlanMetric,
  PlanMetricReason,
  PlanPathReason,
  PlanProgressReason,
  PlanStatus,
  UnderwritingForm,
} from './terms.js';

/*
 * Performance against the sponsor's underwritten base case (docs/08 section 11, decision 0022):
 * the plan at a date, the variance of the current quarter against it and where that stands; the
 * planned EBITDA bridge and how much of it has been earned; and our returns against the
 * underwritten IRR. `underwritingComparison` answers all of it as it travels, over rows as they
 * travel, so the API and a page work it out by one rule. Every function is null, with the reason,
 * instead of a misleading value: a plan figure is never taken from another date and a missing one
 * is never a zero.
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

/* ---- Rules 4 to 6 and the comparison as it travels ---- */

/** The base case of a position, as the comparison reads it (docs/08 section 11). */
export interface UnderwritingCase {
  form: UnderwritingForm;
  /** The planned exit; for a loan, the expected repayment. */
  plannedExitDate: IsoDate;
  /** EV / EBITDA at the planned exit. An equity case has one; a loan has none. */
  exitMultiple: DecimalInput | null;
  /** The underwritten gross MOIC and gross IRR, from our entry to the planned exit. */
  grossMoic: DecimalInput;
  grossIrr: DecimalInput;
  /** The plan points of an equity case, in any order, on distinct dates. A loan has none. */
  points: readonly PlanFigures[];
}

/** The entry snapshot of the company: what the planned bridge starts from. */
export interface EntryFigures {
  periodEnd: IsoDate;
  ebitdaLtm: DecimalInput | null;
  ev: DecimalInput | null;
  netDebt: DecimalInput | null;
}

/** The three drivers of an EBITDA bridge and their total. */
export interface DriverFigures<T> {
  ebitdaGrowth: T;
  multipleExpansion: T;
  /** Positive when net debt fell. */
  debtPaydown: T;
  total: T;
}

/** Why the company has no EBITDA bridge from entry to the current quarter (docs/08 section 8). */
export type ActualBridgeReason = Exclude<PlanProgressReason, 'missing_plan_figure'>;

/**
 * What the comparison is worked out from, none of it worked out a second time here. The entry
 * snapshot, the current quarter and the bridge are those of docs/08 section 8 ("Entry and current
 * quarter of a position") as of the date; the flows, the invested capital, the distributions, the
 * gross MOIC and the gross IRR with its flag are the position's own as of the date.
 */
export interface UnderwritingInputs {
  asOf: IsoDate;
  /** Held on the as-of date; false once realized. */
  isActive: boolean;
  /** The approved entry snapshot dated on or before the as-of date; null when there is none. */
  entry: EntryFigures | null;
  /** The current quarter; null when there is none. */
  current: PlanFigures | null;
  /** The approved quarters, in any order. Those dated before the current quarter join the series. */
  quarters: readonly PlanFigures[];
  /** The company's EBITDA bridge from entry to the current quarter; null with the reason below. */
  bridge: DriverFigures<DecimalInput> | null;
  bridgeNotCalculable: ActualBridgeReason | null;
  /** Our signed flows on or before the as-of date (docs/08 section 1), without the terminal value. */
  flows: readonly CashFlow[];
  invested: DecimalInput | null;
  distributions: DecimalInput | null;
  grossMoic: DecimalInput | null;
  grossIrr: DecimalInput | null;
  irrFlag: IrrFlag;
  /** A loan's yield to maturity as of the date (docs/08 section 10); null for an equity position. */
  yieldToMaturity: DecimalInput | null;
}

/** The tolerances of config/definitions.json `underwriting`. */
export interface UnderwritingTolerances {
  /** Revenue, EBITDA and net debt within this share of plan, either way, are on plan. */
  onPlanTolerance: DecimalInput;
  /** A gross IRR within this many points of the underwritten IRR, either way, is on plan. */
  irrTolerance: DecimalInput;
}

/** One date of a metric's series: the quarter's own figure and the plan at that date. */
export interface PlanSeriesPoint {
  periodEnd: IsoDate;
  /** Null on a plan date with no approved quarter: an actual is never read off a line. */
  actual: string | null;
  plan: string | null;
  interpolated: boolean;
}

export interface PlanSeries {
  metric: PlanMetric;
  points: PlanSeriesPoint[];
}

/** The planned bridge, the actual one and how much of each planned driver has been earned. */
export interface PlanProgress {
  planned: DriverFigures<string> | null;
  actual: DriverFigures<string> | null;
  /**
   * actual / planned for each driver and the total; null for a driver whose planned figure is
   * zero or less. The whole is null unless both bridges stand.
   */
  progress: DriverFigures<string | null> | null;
  /** days(entry snapshot, current quarter) / days(entry snapshot, planned exit); may pass 1. */
  timePassed: string | null;
  notCalculable: PlanProgressReason | null;
}

/** Our returns against the underwritten ones. */
export interface PlanReturns {
  grossIrr: string | null;
  /** The gross IRR less the underwritten IRR, in points. */
  irrGap: string | null;
  /** Null without a gap and while the IRR carries a flag: the flag is the reason. */
  irrStatus: PlanStatus | null;
  irrFlag: IrrFlag;
  grossMoic: string | null;
  /** The MOIC a held position would show today had every flow compounded at the underwritten IRR. */
  moicOnPath: string | null;
  /**
   * The gross MOIC less the MOIC on the path; for a realized position, less the underwritten
   * gross MOIC. It carries no status.
   */
  moicGap: string | null;
  /** Why a held position has no path; null when it has one, and for a realized position. */
  pathNotCalculable: PlanPathReason | null;
}

/** A position against its base case, as it travels (docs/08 section 1). */
export interface UnderwritingComparison {
  /** The date of the current quarter; null without one, and for a loan. */
  quarter: IsoDate | null;
  /** One row per metric in the order of PLAN_METRICS; empty for a loan. */
  metrics: PlanMetricRow[];
  /** The status of EBITDA against plan; null when it has none, and for a loan. */
  headline: PlanStatus | null;
  /** One series per metric in the order of PLAN_METRICS; empty for a loan. */
  series: PlanSeries[];
  /** Null for a loan. */
  valueCreation: PlanProgress | null;
  returns: PlanReturns;
  /** A loan's yield to maturity as it stands, shown and not judged; null for an equity position. */
  yieldToMaturity: string | null;
}

const invalidCase = (message: string): CalcError =>
  new CalcError(message, 'invalid_underwriting_case');

/** The figures of a case the record could not hold are refused before anything is worked out. */
function checkedCase(base: UnderwritingCase): {
  rate: Decimal;
  target: Decimal;
  exitMultiple: Decimal | null;
} {
  const rate = D(base.grossIrr);
  if (rate.lte(ONE.neg())) throw invalidCase('an underwritten IRR is above -100%');
  const target = D(base.grossMoic);
  if (target.lte(ZERO)) throw invalidCase('an underwritten MOIC is above zero');
  if (base.form === 'credit') return { rate, target, exitMultiple: null };
  if (base.exitMultiple === null) throw invalidCase('an equity case has an exit multiple');
  const exitMultiple = D(base.exitMultiple);
  if (exitMultiple.lte(ZERO)) throw invalidCase('an exit multiple is above zero');
  inDateOrder(base.points);
  return { rate, target, exitMultiple };
}

/**
 * The value a position would have on the as-of date had every flow compounded at a rate (rule 5):
 * -sum(flow x (1 + rate)^(days(flow date, as-of) / 365)) over our signed flows. It is the terminal
 * value at which the IRR of the flows is the rate exactly.
 */
export function pathValue(flows: readonly CashFlow[], rate: DecimalInput, asOf: IsoDate): Decimal {
  const base = ONE.plus(D(rate));
  if (base.lte(ZERO)) throw invalidCase('an underwritten IRR is above -100%');
  let total = ZERO;
  for (const flow of flows) {
    const years = new Dec(daysBetween(flow.date, asOf)).div(365);
    total = total.plus(D(flow.amount).times(base.pow(years)));
  }
  return held(total.neg());
}

function returnsAgainstPlan(
  base: UnderwritingCase,
  inputs: UnderwritingInputs,
  rate: Decimal,
  target: Decimal,
  irrTolerance: DecimalInput,
): PlanReturns {
  const irr = inputs.grossIrr === null ? null : D(inputs.grossIrr);
  const irrGap = irr === null ? null : held(irr.minus(rate));
  const moic = inputs.grossMoic === null ? null : D(inputs.grossMoic);

  // What the gross MOIC is set against: the exit target once realized, the path while held.
  let against: Decimal | null = null;
  let moicOnPath: Decimal | null = null;
  let pathNotCalculable: PlanPathReason | null = null;
  if (!inputs.isActive) against = target;
  else if (compareIso(inputs.asOf, base.plannedExitDate) > 0) pathNotCalculable = 'past_plan_end';
  else if (inputs.invested === null || inputs.distributions === null || D(inputs.invested).isZero())
    pathNotCalculable = 'no_invested_capital';
  else {
    const value = pathValue(inputs.flows, rate, inputs.asOf);
    moicOnPath = held(D(inputs.distributions).plus(value).div(D(inputs.invested).abs()));
    against = moicOnPath;
  }
  return {
    grossIrr: toDecimalString(irr),
    irrGap: toDecimalString(irrGap),
    irrStatus: irrGap === null || inputs.irrFlag !== null ? null : planStatus(irrGap, irrTolerance),
    irrFlag: inputs.irrFlag,
    grossMoic: toDecimalString(moic),
    moicOnPath: toDecimalString(moicOnPath),
    moicGap: toDecimalString(moic === null || against === null ? null : held(moic.minus(against))),
    pathNotCalculable,
  };
}

type Planned =
  { value: DriverFigures<Decimal>; reason: null } | { value: null; reason: PlanProgressReason };

/**
 * The planned bridge (rule 4): the one bridge rule from the entry snapshot to the plan point dated
 * the planned exit, whose EV is the exit multiple x its EBITDA.
 */
function plannedBridge(
  base: UnderwritingCase,
  exitMultiple: Decimal,
  entry: EntryFigures | null,
): Planned {
  if (entry === null) return { value: null, reason: 'no_entry_snapshot' };
  if (entry.ebitdaLtm === null || entry.ev === null || entry.netDebt === null)
    return { value: null, reason: 'missing_figures' };
  const exit = base.points.find((point) => point.periodEnd === base.plannedExitDate);
  if (exit === undefined || exit.ebitdaLtm === null || exit.netDebt === null)
    return { value: null, reason: 'missing_plan_figure' };
  const bridge = valueCreationBridge(
    { ebitda: entry.ebitdaLtm, ev: entry.ev, netDebt: entry.netDebt },
    { ebitda: exit.ebitdaLtm, ev: exitMultiple.times(D(exit.ebitdaLtm)), netDebt: exit.netDebt },
  );
  if (bridge.value === null) return { value: null, reason: bridge.reason };
  const { ebitdaGrowth, multipleExpansion, debtPaydown, total } = bridge.value;
  return {
    value: {
      ebitdaGrowth: held(ebitdaGrowth),
      multipleExpansion: held(multipleExpansion),
      debtPaydown: held(debtPaydown),
      total: held(total),
    },
    reason: null,
  };
}

/** A figure as it travels: the one rendering of toDecimalString, for a figure that is there. */
const travels = (value: Decimal): string => trimFractionZeros(value.toFixed(RESULT_PLACES));

const driverStrings = (drivers: DriverFigures<Decimal>): DriverFigures<string> => ({
  ebitdaGrowth: travels(drivers.ebitdaGrowth),
  multipleExpansion: travels(drivers.multipleExpansion),
  debtPaydown: travels(drivers.debtPaydown),
  total: travels(drivers.total),
});

function progressAgainstPlan(
  base: UnderwritingCase,
  exitMultiple: Decimal,
  inputs: UnderwritingInputs,
): PlanProgress {
  const { entry, current } = inputs;
  if (inputs.bridge === null && inputs.bridgeNotCalculable === null)
    throw new CalcError(
      'a position with no bridge says why it has none',
      'invalid_underwriting_inputs',
    );
  const planned = plannedBridge(base, exitMultiple, entry);
  const actual =
    inputs.bridge === null
      ? null
      : {
          ebitdaGrowth: held(D(inputs.bridge.ebitdaGrowth)),
          multipleExpansion: held(D(inputs.bridge.multipleExpansion)),
          debtPaydown: held(D(inputs.bridge.debtPaydown)),
          total: held(D(inputs.bridge.total)),
        };

  let progress: DriverFigures<string | null> | null = null;
  const plan = planned.value;
  if (plan !== null && actual !== null) {
    const earned = (key: keyof DriverFigures<unknown>): string | null =>
      plan[key].lte(ZERO) ? null : travels(held(actual[key].div(plan[key])));
    progress = {
      ebitdaGrowth: earned('ebitdaGrowth'),
      multipleExpansion: earned('multipleExpansion'),
      debtPaydown: earned('debtPaydown'),
      total: earned('total'),
    };
  }

  let timePassed: Decimal | null = null;
  if (entry !== null && current !== null) {
    const whole = daysBetween(entry.periodEnd, base.plannedExitDate);
    if (whole > 0)
      timePassed = held(new Dec(daysBetween(entry.periodEnd, current.periodEnd)).div(whole));
  }
  return {
    planned: plan === null ? null : driverStrings(plan),
    actual: actual === null ? null : driverStrings(actual),
    progress,
    timePassed: toDecimalString(timePassed),
    // The actual bridge's reason comes first; with one that stands, the plan's own.
    notCalculable: actual === null ? inputs.bridgeNotCalculable : planned.reason,
  };
}

/**
 * The series by date: one row for each approved quarter dated before the current quarter, for the
 * current quarter itself and for each plan date, in date order, with the quarter's own figure
 * (none on a plan date with no approved quarter) and the plan at that date by rule 1 (none where
 * rule 1 gives a reason). Without a current quarter no approved quarter counts.
 */
function planSeries(
  points: readonly PlanFigures[],
  quarters: readonly PlanFigures[],
  current: PlanFigures | null,
): PlanSeries[] {
  const history = new Map<IsoDate, PlanFigures>();
  if (current !== null) {
    for (const quarter of quarters) {
      if (compareIso(quarter.periodEnd, current.periodEnd) >= 0) continue;
      if (history.has(quarter.periodEnd))
        throw new CalcError(`two quarters on ${quarter.periodEnd}`, 'duplicate_quarter_date');
      history.set(quarter.periodEnd, quarter);
    }
    history.set(current.periodEnd, current);
  }
  const dates = [...new Set([...history.keys(), ...points.map((p) => p.periodEnd)])].sort(
    compareIso,
  );
  return PLAN_METRICS.map((metric) => ({
    metric,
    points: dates.map((date) => {
      const actual = history.get(date)?.[FIELD[metric]] ?? null;
      const plan = planAt(points, metric, date);
      return {
        periodEnd: date,
        actual: actual === null ? null : toDecimalString(D(actual)),
        plan: toDecimalString(plan.value),
        interpolated: plan.interpolated,
      };
    }),
  }));
}

/**
 * A position against the base case its sponsor underwrote (docs/08 section 11), as it travels.
 * An equity or continuation vehicle position carries the current quarter against plan (rules 1 to
 * 3), the series by date, the value creation against plan (rule 4) and the returns (rule 5). A
 * loan is judged on its IRR gap alone (rule 6): it carries the returns and its yield to maturity
 * as it stands, and nothing else.
 */
export function underwritingComparison(
  base: UnderwritingCase,
  inputs: UnderwritingInputs,
  tolerances: UnderwritingTolerances,
): UnderwritingComparison {
  // Every tolerance and every figure of the case is read before any is used, so a bad one is
  // refused whatever the inputs.
  planStatus(ZERO, tolerances.onPlanTolerance);
  planStatus(ZERO, tolerances.irrTolerance);
  const { rate, target, exitMultiple } = checkedCase(base);
  const returns = returnsAgainstPlan(base, inputs, rate, target, tolerances.irrTolerance);
  // Only a loan has no exit multiple: an equity case without one was refused above.
  if (exitMultiple === null)
    return {
      quarter: null,
      metrics: [],
      headline: null,
      series: [],
      valueCreation: null,
      returns,
      yieldToMaturity:
        inputs.yieldToMaturity === null ? null : toDecimalString(D(inputs.yieldToMaturity)),
    };
  const metrics = planMetrics(base.points, inputs.current, tolerances.onPlanTolerance);
  return {
    quarter: inputs.current?.periodEnd ?? null,
    metrics,
    headline: planHeadline(metrics),
    series: planSeries(base.points, inputs.quarters, inputs.current),
    valueCreation: progressAgainstPlan(base, exitMultiple, inputs),
    returns,
    yieldToMaturity: null,
  };
}
