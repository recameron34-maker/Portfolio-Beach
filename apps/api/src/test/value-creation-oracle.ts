import {
  D,
  ZERO,
  alignedQuarterEnd,
  bandIndexOf,
  entryStake,
  evToEbitda,
  gainByDriver,
  indexedLevel,
  moic,
  netDebtToEbitda,
  sinceEntryMeasures,
  toDecimalString,
  totalGain,
  valueCreationBridge,
  weightedAverage,
  xirr,
} from '@pb/calc';
import type { Decimal, GainByDriver, SinceEntryMeasures, ValueCreationBridge } from '@pb/calc';
import type { SyntheticDataset } from '@pb/db';

/*
 * What the value creation routes should answer for a position, worked out straight from the
 * seeded rows with the calculation library rather than through the API's own loaders and
 * composition (the way nav-oracle.ts expects the NAV series). The tests compare the API's decimal
 * strings with these, figure by figure.
 */

type Investment = SyntheticDataset['investments'][number];
type Quarter = SyntheticDataset['quarterlyPerformance'][number];

export const EQUITY_DEAL_TYPES = [
  'deal_type.co_invest_equity',
  'deal_type.cv_single_asset',
  'deal_type.cv_multi_asset',
];

const INFLOWS = new Set([
  'flow_type.distribution',
  'flow_type.interest',
  'flow_type.principal',
  'flow_type.recallable',
]);

export interface ExpectedPosition {
  investment: Investment;
  isActive: boolean;
  entry: Quarter | null;
  current: Quarter | null;
  measures: SinceEntryMeasures | null;
  bridge: ValueCreationBridge | null;
  reason: string | null;
  invested: Decimal | null;
  distributions: Decimal | null;
  nav: Decimal | null;
  moic: Decimal | null;
  gain: Decimal | null;
  /** Invested capital over the company's equity value at entry. */
  stake: Decimal | null;
  split: GainByDriver | null;
  gainReason: string | null;
  /** The approved flows on or before the date, signed from our side, by date then amount. */
  flows: { date: string; amount: string }[];
  entryMultiple: Decimal | null;
  entryLeverage: Decimal | null;
}

/** The day a position's company figures stop counting: the as-of date, or its exit when that came first. */
export const cutoffOf = (investment: Investment, asOf: string): string =>
  investment.exitDate !== null && investment.exitDate < asOf ? investment.exitDate : asOf;

const approved = (q: Quarter): boolean => q.status === 'record_status.approved';

/** The position's figures as of a date, from the seeded rows alone. */
export function expectedPosition(
  dataset: SyntheticDataset,
  investment: Investment,
  asOf: string,
): ExpectedPosition {
  const quarters = dataset.quarterlyPerformance.filter((q) => q.investmentId === investment.id);
  const flagged = quarters.find((q) => q.isEntrySnapshot) ?? null;
  const snapshot = flagged !== null && approved(flagged) ? flagged : null;
  const entry = snapshot !== null && snapshot.periodEnd <= asOf ? snapshot : null;
  // A realized position's company figures stop at its exit.
  const cutoff = cutoffOf(investment, asOf);
  const current =
    quarters
      .filter((q) => !q.isEntrySnapshot && approved(q) && q.periodEnd <= cutoff)
      .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))[0] ?? null;

  let reason: string | null;
  let bridge: ValueCreationBridge | null = null;
  if (entry === null)
    reason = snapshot === null ? 'no_entry_snapshot' : 'entry_snapshot_forward_dated';
  else if (current === null) reason = 'no_current_quarter';
  else if (
    [entry, current].some((q) => q.ebitdaLtm === null || q.ev === null || q.netDebt === null)
  )
    reason = 'missing_figures';
  else {
    const point = (q: Quarter): Parameters<typeof valueCreationBridge>[0] => ({
      ebitda: q.ebitdaLtm!,
      ev: q.ev!,
      netDebt: q.netDebt!,
      revenue: q.revenueLtm,
    });
    const r = valueCreationBridge(point(entry), point(current));
    bridge = r.value;
    reason = r.reason ?? null;
  }
  const figures = (q: Quarter): Parameters<typeof sinceEntryMeasures>[0] => ({
    ebitda: q.ebitdaLtm,
    ev: q.ev,
    netDebt: q.netDebt,
  });

  const flows = dataset.cashFlows.filter(
    (f) =>
      f.investmentId === investment.id &&
      f.status === 'record_status.approved' &&
      f.flowDate <= asOf,
  );
  const sumOf = (pick: (flowType: string) => boolean): Decimal =>
    flows.filter((f) => pick(f.flowType)).reduce((acc, f) => acc.plus(D(f.amount).abs()), ZERO);
  const contributed = sumOf((t) => t === 'flow_type.contribution');
  const invested = contributed.isZero() ? null : contributed;
  const distributions = invested === null ? null : sumOf((t) => INFLOWS.has(t));
  const isActive = investment.exitDate === null || investment.exitDate > asOf;
  const mark = dataset.valuations
    .filter((v) => v.investmentId === investment.id && v.state === 'Locked' && v.periodEnd <= asOf)
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))[0];
  const nav = !isActive ? ZERO : mark === undefined ? null : D(mark.fairValue);
  const calculable = invested !== null && distributions !== null && nav !== null;
  const entryEv = entry?.ev ?? null;
  const entryNetDebt = entry?.netDebt ?? null;
  const gain = calculable ? totalGain(distributions, nav, invested) : null;
  const ours = bridge === null ? null : gainByDriver(gain, invested, bridge);
  const split = ours?.value ?? null;
  const gainReason = ours === null ? reason : (ours.reason ?? null);
  const signed = flows
    .map((f) => ({
      date: f.flowDate,
      amount: INFLOWS.has(f.flowType) ? D(f.amount).abs() : D(f.amount).abs().neg(),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.amount.comparedTo(b.amount)));
  return {
    investment,
    isActive,
    entry,
    current,
    measures:
      entry !== null && current !== null
        ? sinceEntryMeasures(figures(entry), figures(current))
        : null,
    bridge,
    reason,
    invested,
    distributions,
    nav,
    moic: calculable ? moic(distributions, nav, invested) : null,
    gain,
    stake: entryStake(
      invested,
      entryEv === null || entryNetDebt === null ? null : D(entryEv).minus(entryNetDebt),
    ),
    split,
    gainReason,
    flows: signed.map((f) => ({ date: f.date, amount: toDecimalString(f.amount)! })),
    entryMultiple: entryEv === null ? null : evToEbitda(entryEv, entry?.ebitdaLtm ?? null),
    entryLeverage:
      entryNetDebt === null ? null : netDebtToEbitda(entryNetDebt, entry?.ebitdaLtm ?? null),
  };
}

/** The cohort key a figure in turns falls in: its band by the config edges, or "not_calculable". */
export function expectedBand(value: Decimal | null, edges: readonly number[]): string {
  return value === null
    ? 'not_calculable'
    : `band_${bandIndexOf(
        value,
        edges.map((e) => String(e)),
      )}`;
}

export interface ExpectedPoint {
  periodEnd: string;
  isEntry: boolean;
  ebitdaIndex: string | null;
  evIndex: string | null;
  equityValueIndex: string | null;
  markIndex: string | null;
}

/** The indexed series of a position as of a date: the entry snapshot, then each approved quarter up to its exit. */
export function expectedSeries(
  dataset: SyntheticDataset,
  investment: Investment,
  asOf: string,
  toleranceDays: number,
): ExpectedPoint[] {
  const { entry } = expectedPosition(dataset, investment, asOf);
  const cutoff = cutoffOf(investment, asOf);
  const equity = (q: Quarter): Decimal | null =>
    q.ev === null || q.netDebt === null ? null : D(q.ev).minus(q.netDebt);
  const company = (
    q: Quarter,
  ): Pick<ExpectedPoint, 'ebitdaIndex' | 'evIndex' | 'equityValueIndex'> => ({
    ebitdaIndex: toDecimalString(indexedLevel(q.ebitdaLtm, entry?.ebitdaLtm ?? null)),
    evIndex: toDecimalString(indexedLevel(q.ev, entry?.ev ?? null)),
    equityValueIndex: toDecimalString(
      indexedLevel(equity(q), entry === null ? null : equity(entry)),
    ),
  });
  const points: ExpectedPoint[] = [];
  if (entry !== null)
    points.push({ periodEnd: entry.periodEnd, isEntry: true, ...company(entry), markIndex: null });
  const quarters = dataset.quarterlyPerformance
    .filter(
      (q) =>
        q.investmentId === investment.id &&
        !q.isEntrySnapshot &&
        approved(q) &&
        q.periodEnd <= cutoff &&
        (entry === null || q.periodEnd > entry.periodEnd),
    )
    .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
  for (const q of quarters) {
    const quarterEnd = alignedQuarterEnd(q.periodEnd, toleranceDays);
    const mark = dataset.valuations
      .filter(
        (v) =>
          v.investmentId === investment.id &&
          v.state === 'Locked' &&
          v.periodEnd <= asOf &&
          alignedQuarterEnd(v.periodEnd, toleranceDays) === quarterEnd,
      )
      .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))[0];
    const investedByThen = dataset.cashFlows
      .filter(
        (f) =>
          f.investmentId === investment.id &&
          f.status === 'record_status.approved' &&
          f.flowType === 'flow_type.contribution' &&
          f.flowDate <= q.periodEnd,
      )
      .reduce((acc, f) => acc.plus(D(f.amount).abs()), ZERO);
    points.push({
      periodEnd: q.periodEnd,
      isEntry: false,
      ...company(q),
      markIndex: toDecimalString(indexedLevel(mark?.fairValue ?? null, investedByThen.toString())),
    });
  }
  return points;
}

export interface ExpectedPool {
  count: number;
  invested: string | null;
  distributions: string | null;
  nav: string | null;
  grossMoic: string | null;
  grossIrr: string | null;
  /** The invested-weighted EBITDA growth over the positions that have both figures. */
  ebitdaGrowth: string | null;
  ebitdaGrowthPositions: number;
}

/**
 * A cohort pooled by the rule every pooled view follows (docs/08 sections 2 and 3): flows pooled,
 * NAV summed (not calculable while a held position has no Locked mark), MOIC over the sums and
 * the IRR over the pooled flows ending in the summed NAV on the as-of date.
 */
export function expectedPool(
  dataset: SyntheticDataset,
  positions: readonly ExpectedPosition[],
  asOf: string,
): ExpectedPool {
  const ids = new Set(positions.map((p) => p.investment.id));
  const flows = dataset.cashFlows
    .filter(
      (f) =>
        f.investmentId !== null &&
        ids.has(f.investmentId) &&
        f.status === 'record_status.approved' &&
        f.flowDate <= asOf,
    )
    .sort((a, b) => (a.flowDate < b.flowDate ? -1 : a.flowDate > b.flowDate ? 1 : 0));
  const contributed = flows
    .filter((f) => f.flowType === 'flow_type.contribution')
    .reduce((acc, f) => acc.plus(D(f.amount).abs()), ZERO);
  const received = flows
    .filter((f) => INFLOWS.has(f.flowType))
    .reduce((acc, f) => acc.plus(D(f.amount).abs()), ZERO);
  const invested = positions.length === 0 || contributed.isZero() ? null : contributed;
  const unmarked = positions.some((p) => p.nav === null);
  const nav =
    positions.length === 0 || unmarked
      ? null
      : positions.reduce((acc, p) => acc.plus(p.nav ?? ZERO), ZERO);
  const signed = flows.map((f) => ({
    date: f.flowDate,
    amount: INFLOWS.has(f.flowType) ? D(f.amount).abs() : D(f.amount).abs().neg(),
  }));
  if (nav !== null && !nav.isZero()) signed.push({ date: asOf, amount: D(nav.toFixed(2)) });
  const irr = nav === null || signed.length < 2 ? null : xirr(signed);
  // The cohort weighs the growth as the row carries it (ten places), which is what a page that
  // rolls a filtered set up has to weigh too.
  const weighted = positions.flatMap((p) => {
    const growth = toDecimalString(p.measures?.ebitdaGrowth ?? null);
    return p.invested === null || growth === null ? [] : [{ weight: p.invested, value: growth }];
  });
  return {
    count: positions.length,
    invested: toDecimalString(invested),
    distributions: invested === null ? null : toDecimalString(received),
    nav: toDecimalString(nav),
    grossMoic:
      invested === null || nav === null ? null : toDecimalString(moic(received, nav, invested)),
    grossIrr: toDecimalString(irr?.value ?? null),
    ebitdaGrowth: toDecimalString(weightedAverage(weighted)),
    ebitdaGrowthPositions: weighted.length,
  };
}
