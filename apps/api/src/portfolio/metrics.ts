import {
  CALC_VERSION,
  D,
  ZERO,
  alignedQuarterEnd,
  containingQuarterEnd,
  currentYield,
  dpi,
  rvpi,
  tvpi,
  ebitdaMargin,
  evToEbitda,
  interestCoverage,
  latestPeriod,
  latestQuarterEndOnOrBefore,
  leverageThroughTranche,
  loanToValue,
  moic,
  netDebtToEbitda,
  nextQuarterEnd,
  sameQuarterPriorYear,
  summarizeFlows,
  toDecimalString,
  toSignedFlows,
  xirr,
  yoyGrowth,
} from '@pb/calc';
import type { CashFlow, Decimal, FlowKind, IrrReason, IrrResult, TypedCashFlow } from '@pb/calc';
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
  /** no_valuation: something still held has no Locked mark, so there is no terminal value. */
  irrFlag: 'short_period' | 'no_valuation' | IrrReason | null;
  calcVersion: string;
}

/** Decimal to the contract's decimal string (@pb/calc toDecimalString); null stays null. */
export const str = toDecimalString;

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

/** Why a position's or a pool's IRR is missing, or that its period is short (docs/08 section 3). */
function irrFlagOf(irr: IrrResult | null): PositionMetrics['irrFlag'] {
  if (irr === null) return 'insufficient_flows';
  if (irr.value === null) return irr.reason;
  return irr.shortPeriod ? 'short_period' : null;
}

/**
 * The gross IRR over signed flows that already end in the NAV, and its flag. While something
 * still held has no Locked mark the NAV is not calculable, and an IRR without it would be an
 * invented number (CLAUDE.md rule 10), so there is none.
 */
function grossIrrOf(
  signed: readonly CashFlow[],
  navCalculable: boolean,
): Pick<PositionMetrics, 'grossIrr' | 'irrFlag'> {
  if (!navCalculable) return { grossIrr: null, irrFlag: 'no_valuation' };
  const irr = signed.length >= 2 ? xirr(signed) : null;
  return {
    grossIrr: str(irr?.value ?? null),
    irrFlag: irrFlagOf(irr),
  };
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
  // A realized position holds nothing, so its NAV is 0; an active one without a Locked mark has
  // no NAV, and nothing that needs one (MOIC, IRR) is calculable either.
  const navValue = nav === null ? (isActive ? null : D('0')) : D(nav.fairValue);
  const grossMoic =
    invested === null || navValue === null ? null : moic(summary.distributions, navValue, invested);
  const signed = toSignedFlows(typed);
  if (nav !== null) signed.push({ date: asOf, amount: nav.fairValue });
  return {
    invested: str(invested),
    distributions: invested === null ? null : str(summary.distributions),
    nav: str(navValue),
    navDate: nav?.periodEnd ?? null,
    grossMoic: str(grossMoic),
    ...grossIrrOf(signed, navValue !== null),
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
 *
 * A set with no position at all (the primary program, a sponsor the caller holds nothing with, a
 * reader behind every wall) has nothing to pool: every figure is null, never 0, and the IRR flag
 * says why (docs/06 section 3). Every view that pools gets that answer from here alone.
 */
export function pooledPositionMetrics(
  positions: readonly PositionInput[],
  asOf: string,
): PooledMetrics {
  if (positions.length === 0) {
    return {
      count: 0,
      invested: null,
      distributions: null,
      nav: null,
      dpi: null,
      rvpi: null,
      tvpi: null,
      grossMoic: null,
      grossIrr: null,
      irrFlag: 'insufficient_flows',
    };
  }
  const typed: TypedCashFlow[] = [];
  let navSum = ZERO;
  let unmarked = false;
  for (const p of positions) {
    for (const f of p.flows) {
      if (f.flowDate <= asOf)
        typed.push({ date: f.flowDate, kind: kindOf(f.flowType), amount: f.amount });
    }
    if (p.isActive) {
      const nav = latestLockedValuation(p.valuations, asOf);
      if (nav === null) unmarked = true;
      else navSum = navSum.plus(nav.fairValue);
    }
  }
  const summary = summarizeFlows(typed);
  const invested = summary.contributions.isZero() ? null : summary.contributions;
  // Realized positions hold nothing (0). One active position with no Locked mark leaves the
  // pool's NAV unknown: counting it as 0 would understate NAV and invent MOIC and IRR (rule 10).
  const nav: Decimal | null = unmarked ? null : navSum;
  const signed = toSignedFlows(typed);
  if (nav !== null && !nav.isZero()) signed.push({ date: asOf, amount: nav.toFixed(2) });
  return {
    count: positions.length,
    invested: str(invested),
    distributions: invested === null ? null : str(summary.distributions),
    nav: str(nav),
    dpi: invested === null ? null : str(dpi(summary.distributions, invested)),
    rvpi: invested === null || nav === null ? null : str(rvpi(nav, invested)),
    tvpi:
      invested === null || nav === null ? null : str(tvpi(summary.distributions, nav, invested)),
    grossMoic:
      invested === null || nav === null ? null : str(moic(summary.distributions, nav, invested)),
    ...grossIrrOf(signed, nav !== null),
  };
}

export interface NavSeriesOptions {
  /** How many of the latest points to keep (definitions.analytics.navSeriesQuarters). */
  quarters: number;
  /** How far a period end may sit from its calendar quarter end (definitions.priorYearPeriodEndToleranceDays). */
  toleranceDays: number;
}

/** A position as the NAV series needs it: its valuation versions and the dates it was held between. */
export interface NavSeriesPosition {
  valuations: readonly ValuationRow[];
  entryDate: string;
  exitDate: string | null;
}

/**
 * NAV at each calendar quarter end, oldest first, the latest `quarters` points: the NAV date rule
 * (docs/03 section 4) applied at every quarter end, the one NAV series rule for every view that
 * charts NAV by quarter (analytics, vehicle detail).
 *
 * Every position held on a quarter end (entered on or before it, not exited by it) counts at its
 * latest Locked mark reporting for that quarter or an earlier one. A mark within `toleranceDays`
 * of a calendar quarter end reports for it (alignedQuarterEnd, the prior-year tolerance of docs/08
 * section 5), so a sponsor closing its books a few days early or late lands on the quarter; a mark
 * further from any quarter end reports from the next one. A position whose sponsor missed a
 * quarter is carried at its earlier mark, as the NAV tiles carry it, so a missing mark never shows
 * as a fall. A quarter end at which a held position has no Locked mark at all is not calculable
 * (null), never a partial sum (CLAUDE.md rule 10). Only marks dated on or before the as-of date
 * count, and the series ends at the last quarter end on or before it.
 */
export function lockedNavSeries(
  positions: readonly NavSeriesPosition[],
  asOf: string,
  options: NavSeriesOptions,
): SeriesPoint[] {
  if (options.quarters === 0) return [];
  const last = latestQuarterEndOnOrBefore(asOf);
  const marked = positions.map((p) => ({
    p,
    marks: p.valuations
      .filter((v) => v.state === 'Locked' && v.periodEnd <= asOf)
      .map((v) => ({ v, reportsFor: alignedQuarterEnd(v.periodEnd, options.toleranceDays) })),
  }));
  let first: string | null = null;
  for (const { marks } of marked)
    for (const { reportsFor } of marks)
      if (first === null || reportsFor < first) first = reportsFor;
  if (first === null) return [];
  const quarterEnds: string[] = [];
  for (let q = containingQuarterEnd(first); q <= last; q = nextQuarterEnd(q)) quarterEnds.push(q);
  return quarterEnds.slice(-options.quarters).map((periodEnd) => {
    let total = ZERO;
    for (const { p, marks } of marked) {
      if (p.entryDate > periodEnd || (p.exitDate !== null && p.exitDate <= periodEnd)) continue;
      let latest: ValuationRow | null = null;
      for (const { v, reportsFor } of marks)
        if (reportsFor <= periodEnd && (latest === null || v.periodEnd > latest.periodEnd))
          latest = v;
      if (latest === null) return { periodEnd, value: null };
      total = total.plus(latest.fairValue);
    }
    return { periodEnd, value: str(total) };
  });
}
