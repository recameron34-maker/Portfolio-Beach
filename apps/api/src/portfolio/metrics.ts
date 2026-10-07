import {
  CALC_VERSION,
  D,
  currentYield,
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

const str = (d: Decimal | null): string | null =>
  d === null ? null : d.toFixed(10).replace(/\.?0+$/, '');

function kindOf(flowType: string): FlowKind {
  const k = flowType.replace('flow_type.', '');
  return k as FlowKind;
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
