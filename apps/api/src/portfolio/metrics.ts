import {
  CALC_VERSION,
  D,
  ZERO,
  currentYield,
  daysBetween,
  daysInMonth,
  dpi,
  formatIso,
  parseIso,
  rvpi,
  tvpi,
  ebitdaMargin,
  evToEbitda,
  interestCoverage,
  latestPeriod,
  leverageThroughTranche,
  loanToValue,
  moic,
  netDebtToEbitda,
  sameQuarterPriorYear,
  summarizeFlows,
  toSignedFlows,
  xirr,
  yoyGrowth,
} from '@pb/calc';
import type { Decimal, FlowKind, IrrReason, TypedCashFlow } from '@pb/calc';
import type { PooledMetrics, SeriesPoint } from '@pb/contracts';

export interface FlowRow {
  flowDate: string;
  flowType: string;
  amount: string;
}

export interface ValuationRow {
  periodEnd: string;
  version: number;
  state: string;
  fairValue: string;
  method: string;
}

export interface PositionMetrics {
  invested: string | null;
  distributions: string | null;
  nav: string | null;
  navDate: string | null;
  grossMoic: string | null;
  grossIrr: string | null;
  irrFlag: 'short_period' | IrrReason | null;
  calcVersion: string;
}

/** Decimal to the contract's decimal string (no exponent, no trailing zeros); null stays null. */
export const str = (d: Decimal | null): string | null =>
  d === null ? null : d.toFixed(10).replace(/\.?0+$/, '');

/** The flow kind packages/calc expects: the taxonomy code without its domain prefix. */
export function kindOf(flowType: string): FlowKind {
  return flowType.replace('flow_type.', '') as FlowKind;
}

/** Latest Locked valuation on or before the as-of date: the NAV date rule (docs/03 section 4). */
export function latestLockedValuation(
  valuations: readonly ValuationRow[],
  asOf: string,
): ValuationRow | null {
  let best: ValuationRow | null = null;
  for (const v of valuations) {
    if (v.state !== 'Locked' || v.periodEnd > asOf) continue;
    if (best === null || v.periodEnd > best.periodEnd) best = v;
  }
  return best;
}

/** Gross deal-level metrics from approved cash flows and the latest Locked valuation (docs/08). */
export function positionMetrics(
  flows: readonly FlowRow[],
  valuations: readonly ValuationRow[],
  asOf: string,
  isActive: boolean,
): PositionMetrics {
  const typed: TypedCashFlow[] = flows
    .filter((f) => f.flowDate <= asOf)
    .map((f) => ({ date: f.flowDate, kind: kindOf(f.flowType), amount: f.amount }));
  const summary = summarizeFlows(typed);
  const nav = isActive ? latestLockedValuation(valuations, asOf) : null;
  const invested = summary.contributions.isZero() ? null : summary.contributions;
  const navValue = nav === null ? (isActive ? null : D('0')) : D(nav.fairValue);
  const grossMoic =
    invested === null ? null : moic(summary.distributions, navValue ?? D('0'), invested);
  const signed = toSignedFlows(typed);
  if (nav !== null) signed.push({ date: asOf, amount: nav.fairValue });
  const irr = signed.length >= 2 ? xirr(signed) : null;
  let irrFlag: PositionMetrics['irrFlag'] = null;
  if (irr === null) irrFlag = 'insufficient_flows';
  else if (irr.value === null) irrFlag = irr.reason ?? 'no_root';
  else if (irr.shortPeriod) irrFlag = 'short_period';
  return {
    invested: str(invested),
    distributions: invested === null ? null : str(summary.distributions),
    nav: str(navValue),
    navDate: nav?.periodEnd ?? null,
    grossMoic: str(grossMoic),
    grossIrr: irr?.value === undefined || irr.value === null ? null : str(irr.value),
    irrFlag,
    calcVersion: CALC_VERSION,
  };
}

export interface OperatingRow {
  periodEnd: string;
  status: string;
  isEntrySnapshot: boolean;
  revenueLtm: string | null;
  ebitdaLtm: string | null;
  ev: string | null;
  netDebt: string | null;
}

export interface OperatingView {
  periodEnd: string;
  revenueLtm: string | null;
  ebitdaLtm: string | null;
  ev: string | null;
  netDebt: string | null;
  evToEbitda: string | null;
  netDebtToEbitda: string | null;
  ebitdaMargin: string | null;
  revenueYoy: string | null;
  ebitdaYoy: string | null;
  priorYearPeriodEnd: string | null;
}

/** Latest approved quarter with ratios and the exact prior-year comparison (docs/08 sections 4 and 5). */
export function operatingView(
  rows: readonly OperatingRow[],
  asOf: string,
  priorYearToleranceDays: number,
): OperatingView | null {
  const mapped = rows.map((r) => ({ ...r, status: r.status.replace('record_status.', '') }));
  const latest = latestPeriod(mapped, asOf);
  if (latest === null) return null;
  const prior = sameQuarterPriorYear(
    mapped.filter((r) => r.status === 'approved'),
    latest.periodEnd,
    { toleranceDays: priorYearToleranceDays },
  );
  const ev = latest.ev === null ? null : D(latest.ev);
  return {
    periodEnd: latest.periodEnd,
    revenueLtm: latest.revenueLtm,
    ebitdaLtm: latest.ebitdaLtm,
    ev: latest.ev,
    netDebt: latest.netDebt,
    evToEbitda: ev === null ? null : str(evToEbitda(ev, latest.ebitdaLtm)),
    netDebtToEbitda:
      latest.netDebt === null ? null : str(netDebtToEbitda(latest.netDebt, latest.ebitdaLtm)),
    ebitdaMargin:
      latest.ebitdaLtm === null ? null : str(ebitdaMargin(latest.ebitdaLtm, latest.revenueLtm)),
    revenueYoy: str(yoyGrowth(latest.revenueLtm, prior?.revenueLtm ?? null)),
    ebitdaYoy: str(yoyGrowth(latest.ebitdaLtm, prior?.ebitdaLtm ?? null)),
    priorYearPeriodEnd: prior?.periodEnd ?? null,
  };
}

export interface CreditRow {
  periodEnd: string;
  status: string;
  isEntrySnapshot: boolean;
  parValue: string | null;
  fairValue: string | null;
  ebitdaLtm: string | null;
  cashInterestExpenseLtm: string | null;
  netDebtThroughTranche: string | null;
  ev: string | null;
  covenantStatus: string | null;
  paymentStatus: string | null;
}

export interface CreditView {
  periodEnd: string;
  parValue: string | null;
  fairValue: string | null;
  currentYield: string | null;
  interestCoverage: string | null;
  leverageThroughTranche: string | null;
  loanToValue: string | null;
  covenantStatus: string | null;
  paymentStatus: string | null;
}

export function creditView(
  rows: readonly CreditRow[],
  cashCoupon: string,
  asOf: string,
): CreditView | null {
  const mapped = rows.map((r) => ({ ...r, status: r.status.replace('record_status.', '') }));
  const latest = latestPeriod(mapped, asOf);
  if (latest === null) return null;
  return {
    periodEnd: latest.periodEnd,
    parValue: latest.parValue,
    fairValue: latest.fairValue,
    currentYield:
      latest.parValue === null || latest.fairValue === null
        ? null
        : str(currentYield(cashCoupon, latest.parValue, latest.fairValue)),
    interestCoverage: str(interestCoverage(latest.ebitdaLtm, latest.cashInterestExpenseLtm)),
    leverageThroughTranche:
      latest.netDebtThroughTranche === null
        ? null
        : str(leverageThroughTranche(latest.netDebtThroughTranche, latest.ebitdaLtm)),
    loanToValue:
      latest.netDebtThroughTranche === null
        ? null
        : str(loanToValue(latest.netDebtThroughTranche, latest.ev)),
    covenantStatus: latest.covenantStatus,
    paymentStatus: latest.paymentStatus,
  };
}

export interface PositionInput {
  flows: readonly FlowRow[];
  valuations: readonly ValuationRow[];
  isActive: boolean;
}

/**
 * Pooled gross metrics over a set of positions (vehicle, sponsor, client slice, whole portfolio):
 * flows are pooled, NAV is the sum of each active position's latest Locked mark, and the IRR runs
 * over the pooled flows plus the summed NAV as a terminal flow (docs/08 sections 2 and 3). Pooled
 * flows can change sign more than once, so the IRR flag matters. Never a JS number for money.
 */
export function pooledPositionMetrics(
  positions: readonly PositionInput[],
  asOf: string,
): PooledMetrics {
  const typed: TypedCashFlow[] = [];
  let navSum = ZERO;
  let anyNav = false;
  let anyActive = false;
  for (const p of positions) {
    for (const f of p.flows) {
      if (f.flowDate <= asOf)
        typed.push({ date: f.flowDate, kind: kindOf(f.flowType), amount: f.amount });
    }
    if (p.isActive) {
      anyActive = true;
      const nav = latestLockedValuation(p.valuations, asOf);
      if (nav !== null) {
        navSum = navSum.plus(nav.fairValue);
        anyNav = true;
      }
    }
  }
  const summary = summarizeFlows(typed);
  const invested = summary.contributions.isZero() ? null : summary.contributions;
  // Realized sets carry a zero NAV; an active set with no Locked mark is not calculable.
  const nav: Decimal | null = anyNav ? navSum : anyActive ? null : ZERO;
  const signed = toSignedFlows(typed);
  if (nav !== null && !nav.isZero()) signed.push({ date: asOf, amount: nav.toFixed(2) });
  const irr = signed.length >= 2 ? xirr(signed) : null;
  let irrFlag: PositionMetrics['irrFlag'] = null;
  if (irr === null) irrFlag = 'insufficient_flows';
  else if (irr.value === null) irrFlag = irr.reason ?? 'no_root';
  else if (irr.shortPeriod) irrFlag = 'short_period';
  return {
    count: positions.length,
    invested: str(invested),
    distributions: invested === null ? null : str(summary.distributions),
    nav: str(nav),
    dpi: invested === null ? null : str(dpi(summary.distributions, invested)),
    rvpi: invested === null || nav === null ? null : str(rvpi(nav, invested)),
    tvpi:
      invested === null || nav === null ? null : str(tvpi(summary.distributions, nav, invested)),
    grossMoic: invested === null ? null : str(moic(summary.distributions, nav ?? ZERO, invested)),
    grossIrr: irr?.value === undefined || irr.value === null ? null : str(irr.value),
    irrFlag,
  };
}

const quarterEndOf = (year: number, month: number): string =>
  formatIso({ year, month, day: daysInMonth(year, month) });

/** The calendar quarter end on or before a date. */
export function latestQuarterEndOnOrBefore(date: string): string {
  const { year, month } = parseIso(date);
  const endMonth = Math.ceil(month / 3) * 3;
  const candidate = quarterEndOf(year, endMonth);
  if (candidate <= date) return candidate;
  return endMonth === 3 ? quarterEndOf(year - 1, 12) : quarterEndOf(year, endMonth - 3);
}

/**
 * The calendar quarter end a period end reports for: the nearest quarter end when it is within
 * the tolerance (docs/08 section 5), otherwise the period end as reported.
 */
function alignedQuarterEnd(periodEnd: string, toleranceDays: number): string {
  const floor = latestQuarterEndOnOrBefore(periodEnd);
  if (floor === periodEnd) return periodEnd;
  const { year, month } = parseIso(floor);
  const ceil = month === 12 ? quarterEndOf(year + 1, 3) : quarterEndOf(year, month + 3);
  const toFloor = daysBetween(floor, periodEnd);
  const toCeil = daysBetween(periodEnd, ceil);
  const nearest = toFloor <= toCeil ? floor : ceil;
  return Math.min(toFloor, toCeil) <= toleranceDays ? nearest : periodEnd;
}

export interface NavSeriesOptions {
  /** How many of the latest points to keep (definitions.analytics.navSeriesQuarters). */
  quarters: number;
  /** How far a period end may sit from its calendar quarter end (definitions.priorYearPeriodEndToleranceDays). */
  toleranceDays: number;
}

/**
 * Sum of Locked fair values per calendar quarter end over a set of positions, oldest first,
 * limited to the latest `quarters` points. Only marks with a period end on or before the as-of
 * date count (the NAV date rule, docs/03 section 4).
 *
 * The one NAV series rule for every view that charts NAV by quarter (analytics, vehicle detail):
 * a Locked mark whose period end is within `toleranceDays` of a calendar quarter end counts for
 * that quarter end, the same tolerance as the prior-year match (docs/08 section 5). A sponsor
 * closing its books a few days early (period_end_shift reports on the 27th or 28th) therefore
 * lands on the same point as every other position instead of becoming a point of its own. A mark
 * further from any quarter end keeps its own date, and so does a mark whose quarter end falls
 * after the as-of date, so the alignment never drops a mark. When two marks of one position fold
 * into the same point, the later one counts, so no position is counted twice. A position without
 * a Locked mark for a period simply does not contribute to that point; the caller says so in the
 * chart subtitle.
 */
export function lockedNavSeries(
  valuationSets: readonly (readonly ValuationRow[])[],
  asOf: string,
  options: NavSeriesOptions,
): SeriesPoint[] {
  const totals = new Map<string, Decimal>();
  for (const set of valuationSets) {
    const marks = new Map<string, ValuationRow>();
    for (const v of set) {
      if (v.state !== 'Locked' || v.periodEnd > asOf) continue;
      const aligned = alignedQuarterEnd(v.periodEnd, options.toleranceDays);
      const point = aligned > asOf ? v.periodEnd : aligned;
      const held = marks.get(point);
      if (held === undefined || v.periodEnd > held.periodEnd) marks.set(point, v);
    }
    for (const [point, v] of marks)
      totals.set(point, (totals.get(point) ?? ZERO).plus(v.fairValue));
  }
  const points = [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (options.quarters === 0 ? [] : points.slice(-options.quarters)).map(
    ([periodEnd, value]) => ({ periodEnd, value: str(value) }),
  );
}
