import {
  CalcError,
  D,
  alignedQuarterEnd,
  bandKeyOf,
  entryCohortBands,
  entrySnapshot,
  entryStake,
  equityValue,
  evToEbitda,
  gainByDriver,
  indexedLevel,
  latestPeriod,
  lockedNear,
  netDebtToEbitda,
  sinceEntryMeasures,
  summarizeFlows,
  toSignedFlows,
  totalGain,
  turnBands,
  valueChange,
  valueCreationBridge,
  valueCreationRollup,
} from '@pb/calc';
import type { Decimal, ValueCreationBridge } from '@pb/calc';
import { matchesValueCreationFilters } from '@pb/contracts';
import type {
  BridgeReason,
  InvestmentSummary,
  ValueCreation,
  ValueCreationFilters,
  ValueCreationPoint,
  ValueCreationPosition,
  ValueCreationReason,
  ValueCreationSeriesPoint,
} from '@pb/contracts';
import { toCsv } from '@pb/validation';
import { configDecimal, configError } from '../common/definitions.js';
import { compareText } from '../common/order.js';
import { QUARTERLY_REPORTING_DEAL_TYPES } from '../documents/expected.js';
import type { InvestmentBaseRow } from '../portfolio/loaders.js';
import { kindOf, str } from '../portfolio/metrics.js';
import type { FlowRow, OperatingRow, ValuationRow } from '../portfolio/metrics.js';

/*
 * Value creation and entry metric analytics (docs/04 M13 and M20, docs/08 section 8), pure so the
 * service, the tests and the export judge a position the same way. Nothing here reads the
 * database or the clock: the service loads the rows under the caller's row-level security and
 * passes the as-of day in. Every figure comes from @pb/calc as a Decimal and leaves as the
 * contract's decimal string; a figure that is not calculable is null with the reason beside it.
 */

/**
 * The deal types these views cover: equity co-investments and continuation vehicles, the ones
 * whose sponsors report the company's quarterly figures (mon.quarterly_performance). Private
 * credit and primary fund positions are counted as left out, never shown as empty rows.
 */
export const VALUE_CREATION_DEAL_TYPES: readonly string[] = QUARTERLY_REPORTING_DEAL_TYPES;

export const coversDealType = (dealType: string): boolean =>
  VALUE_CREATION_DEAL_TYPES.includes(dealType);

/** The band edges of the two entry metrics, in turns, from config/definitions.json `analytics`. */
export interface EntryBands {
  multiple: Decimal[];
  leverage: Decimal[];
}

/** Band edges from config: a non-empty, strictly ascending list of numbers, else a configuration problem that names the key. */
function configEdges(value: unknown, key: string): Decimal[] {
  if (!Array.isArray(value) || value.length === 0) throw configError(key);
  const edges = value.map((item: unknown) => configDecimal(item, key));
  try {
    turnBands(edges);
  } catch (error) {
    if (error instanceof CalcError) throw configError(key);
    throw error;
  }
  return edges;
}

/** `analytics.entryMultipleBands` and `analytics.entryLeverageBands`; never a default in code (rules 9 and 10). */
export function entryBandsOf(definitions: { analytics?: unknown }): EntryBands {
  const analytics = (definitions.analytics ?? {}) as Record<string, unknown>;
  return {
    multiple: configEdges(analytics.entryMultipleBands, 'analytics.entryMultipleBands'),
    leverage: configEdges(analytics.entryLeverageBands, 'analytics.entryLeverageBands'),
  };
}

/** One visible position with everything the views derive from. */
export interface PositionInputs {
  row: InvestmentBaseRow;
  summary: InvestmentSummary;
  flows: FlowRow[];
  valuations: ValuationRow[];
  operating: OperatingRow[];
}

const withCalcStatus = (rows: readonly OperatingRow[]): OperatingRow[] =>
  rows.map((r) => ({ ...r, status: r.status.replace('record_status.', '') }));

const multipleOf = (row: OperatingRow): Decimal | null =>
  row.ev === null ? null : evToEbitda(row.ev, row.ebitdaLtm);

const leverageOf = (row: OperatingRow): Decimal | null =>
  row.netDebt === null ? null : netDebtToEbitda(row.netDebt, row.ebitdaLtm);

function pointOf(row: OperatingRow): ValueCreationPoint {
  return {
    periodEnd: row.periodEnd,
    revenueLtm: row.revenueLtm,
    ebitdaLtm: row.ebitdaLtm,
    ev: row.ev,
    netDebt: row.netDebt,
    equityValue: str(equityValue(row.ev, row.netDebt)),
    evToEbitda: str(multipleOf(row)),
    netDebtToEbitda: str(leverageOf(row)),
  };
}

/** The day a position's company figures stop counting: the as-of date, or its exit when that came first. */
export const bridgeCutoff = (exitDate: string | null, asOf: string): string =>
  exitDate !== null && exitDate < asOf ? exitDate : asOf;

/**
 * The entry and current quarters of a position as of a date. Entry is the row flagged
 * is_entry_snapshot (never the earliest date), and only once it is approved and dated on or
 * before the as-of date: a forward-dated snapshot is no basis for a comparison as of an earlier
 * day, and `forwardDated` says that this is why there is no entry. Current is the latest approved
 * quarter on or before the as-of date (docs/08 section 5), or on or before the exit date of a
 * position realized by then: what the company did after we left is not our value creation. A
 * quarter that is not approved never counts.
 */
export function entryAndCurrent(
  operating: readonly OperatingRow[],
  asOf: string,
  exitDate: string | null,
): { entry: OperatingRow | null; current: OperatingRow | null; forwardDated: boolean } {
  const rows = withCalcStatus(operating);
  const flagged = entrySnapshot(rows);
  const snapshot = flagged !== null && flagged.status === 'approved' ? flagged : null;
  const forwardDated = snapshot !== null && snapshot.periodEnd > asOf;
  return {
    entry: forwardDated ? null : snapshot,
    current: latestPeriod(rows, bridgeCutoff(exitDate, asOf)),
    forwardDated,
  };
}

/** The company's bridge between two quarters, or the first reason it cannot be computed. */
function bridgeOf(
  entry: OperatingRow | null,
  current: OperatingRow | null,
  forwardDated: boolean,
): { bridge: ValueCreationBridge | null; reason: BridgeReason | null } {
  if (entry === null)
    return {
      bridge: null,
      reason: forwardDated ? 'entry_snapshot_forward_dated' : 'no_entry_snapshot',
    };
  if (current === null) return { bridge: null, reason: 'no_current_quarter' };
  if (
    entry.ebitdaLtm === null ||
    entry.ev === null ||
    entry.netDebt === null ||
    current.ebitdaLtm === null ||
    current.ev === null ||
    current.netDebt === null
  )
    return { bridge: null, reason: 'missing_figures' };
  const result = valueCreationBridge(
    { ebitda: entry.ebitdaLtm, ev: entry.ev, netDebt: entry.netDebt, revenue: entry.revenueLtm },
    {
      ebitda: current.ebitdaLtm,
      ev: current.ev,
      netDebt: current.netDebt,
      revenue: current.revenueLtm,
    },
  );
  return { bridge: result.value, reason: result.reason ?? null };
}

const figuresOf = (row: OperatingRow): Parameters<typeof sinceEntryMeasures>[0] => ({
  ebitda: row.ebitdaLtm,
  ev: row.ev,
  netDebt: row.netDebt,
});

/**
 * A position's approved flows on or before the as-of date as the row carries them: signed from
 * our side (paid out negative, received positive, fees and expenses included), by date and then
 * by amount so the same book always answers the same list.
 */
function signedFlows(inputs: PositionInputs, asOf: string): ValueCreationPosition['flows'] {
  return toSignedFlows(
    inputs.flows
      .filter((f) => f.flowDate <= asOf)
      .map((f) => ({ date: f.flowDate, kind: kindOf(f.flowType), amount: f.amount })),
  )
    .map((f) => ({ date: f.date, amount: D(f.amount) }))
    .sort((a, b) => compareText(a.date, b.date) || a.amount.comparedTo(b.amount))
    .map((f) => ({ date: f.date, amount: str(f.amount)! }));
}

/** One position's row: the company side from its quarters, our side from the portfolio's own metrics. */
export function computePosition(
  inputs: PositionInputs,
  asOf: string,
  bands: EntryBands,
): ValueCreationPosition {
  const { row, summary } = inputs;
  const { entry, current, forwardDated } = entryAndCurrent(inputs.operating, asOf, row.exitDate);
  const measures =
    entry === null || current === null
      ? null
      : sinceEntryMeasures(figuresOf(entry), figuresOf(current));
  const { bridge, reason } = bridgeOf(entry, current, forwardDated);

  // Our side is the position's own summary (the figures the portfolio grid shows), never a
  // second calculation: invested, distributions and NAV as of the date.
  const { invested, distributions, nav } = summary;
  const calculable = invested !== null && distributions !== null && nav !== null;
  const gain = calculable ? totalGain(distributions, nav, invested) : null;
  const valuationGrowth = calculable ? valueChange(D(nav).plus(distributions), invested) : null;
  const ebitdaGrowth = measures?.ebitdaGrowth ?? null;
  // Our gain against the company's drivers at our entry stake (docs/08 section 8): without a
  // bridge the bridge's reason stands, otherwise the split says why it has none.
  const ours = bridge === null ? null : gainByDriver(gain, invested, bridge);
  const split = ours?.value ?? null;
  const gainReason: ValueCreationReason | null = ours === null ? reason : (ours.reason ?? null);

  return {
    id: row.id,
    investmentNumber: row.investmentNumber,
    companyName: row.companyName,
    vehicleId: row.vehicleId,
    vehicleName: row.vehicleName,
    sponsorId: row.sponsorId,
    sponsorName: row.sponsorName,
    sector: row.sector,
    dealType: row.dealType,
    entryDate: row.entryDate,
    entryYear: Number(row.entryDate.slice(0, 4)),
    exitDate: row.exitDate,
    isActive: row.isActive,
    status: row.isActive ? 'active' : 'realized',
    entry: entry === null ? null : pointOf(entry),
    current: current === null ? null : pointOf(current),
    growth: {
      ebitdaGrowth: str(ebitdaGrowth),
      evGrowth: str(measures?.evGrowth ?? null),
      equityValueGrowth: str(measures?.equityValueGrowth ?? null),
      multipleChange: str(measures?.multipleChange ?? null),
      netLeverageChange: str(measures?.netLeverageChange ?? null),
      netDebtChange: str(measures?.netDebtChange ?? null),
    },
    bridge:
      bridge === null
        ? null
        : {
            equityAtEntry: str(bridge.equityAtEntry)!,
            equityCurrent: str(bridge.equityCurrent)!,
            ebitdaGrowth: str(bridge.ebitdaGrowth)!,
            multipleExpansion: str(bridge.multipleExpansion)!,
            debtPaydown: str(bridge.debtPaydown)!,
            total: str(bridge.total)!,
            shares:
              bridge.shares === null
                ? null
                : {
                    ebitdaGrowth: str(bridge.shares.ebitdaGrowth)!,
                    multipleExpansion: str(bridge.shares.multipleExpansion)!,
                    debtPaydown: str(bridge.shares.debtPaydown)!,
                  },
            revenueGrowth: str(bridge.revenueGrowth),
            marginChange: str(bridge.marginChange),
          },
    notCalculable: reason,
    invested,
    nav,
    distributions,
    grossMoic: summary.grossMoic,
    grossIrr: summary.grossIrr,
    irrFlag: summary.irrFlag,
    valuationGrowth: str(valuationGrowth),
    valuationGrowthGap: str(
      valuationGrowth === null || ebitdaGrowth === null
        ? null
        : valuationGrowth.minus(ebitdaGrowth),
    ),
    // The stake needs the entry snapshot and our invested capital only, so it stands where the
    // bridge does not (a current quarter with EBITDA below zero, say).
    stake: str(
      entryStake(invested, entry === null ? null : equityValue(entry.ev, entry.netDebt)),
    ),
    gain: str(gain),
    gainByDriver:
      split === null
        ? null
        : {
            ebitdaGrowth: str(split.ebitdaGrowth)!,
            multipleExpansion: str(split.multipleExpansion)!,
            debtPaydown: str(split.debtPaydown)!,
            other: str(split.other)!,
            revenueGrowth: str(split.revenueGrowth),
            marginChange: str(split.marginChange),
          },
    gainNotCalculable: gainReason,
    flows: signedFlows(inputs, asOf),
    entryMultipleBand: bandKeyOf(entry === null ? null : multipleOf(entry), bands.multiple),
    entryLeverageBand: bandKeyOf(entry === null ? null : leverageOf(entry), bands.leverage),
  };
}

/**
 * The roll-up of the rows (docs/08 section 8): our gain by driver over the positions it is split
 * for, and the positions pooled by entry multiple band and by entry net leverage band. It is the
 * calculation library's own roll-up over the rows as the response carries them, so a page that
 * filters those rows rolls the rest up by the same rule, and the two cannot disagree.
 */
export function rollupOf(
  positions: readonly ValueCreationPosition[],
  bands: EntryBands,
  asOf: string,
): Pick<ValueCreation, 'portfolio' | 'cohorts'> {
  return valueCreationRollup(
    positions,
    {
      byEntryMultiple: entryCohortBands(bands.multiple),
      byEntryLeverage: entryCohortBands(bands.leverage),
    },
    asOf,
  );
}

/** The visible positions these views do not cover, counted by deal type and ordered by label. */
export function leftOutOf(
  rows: readonly InvestmentBaseRow[],
  labels: ReadonlyMap<string, string>,
): ValueCreation['leftOut'] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.dealType, (counts.get(row.dealType) ?? 0) + 1);
  return [...counts.entries()]
    .map(([dealType, count]) => ({ dealType, label: labels.get(dealType) ?? dealType, count }))
    .sort((a, b) => compareText(a.label, b.label) || compareText(a.dealType, b.dealType));
}

/**
 * The indexed series of one position: the entry snapshot (the company lines at 100), then each
 * approved quarter after it on or before the as-of date, or on or before the exit of a position
 * realized by then (the series stops where its bridge does). The company lines are indexed to the
 * entry figures; `markIndex` is the Locked mark that counts for the quarter (lockedNear, the
 * valuation board's rule) per 100 of the capital invested by the quarter's period end. A figure
 * that is missing, or whose base is not positive, is null: never carried and never zero.
 */
export function seriesOf(
  inputs: PositionInputs,
  asOf: string,
  toleranceDays: number,
): ValueCreationSeriesPoint[] {
  const { entry } = entryAndCurrent(inputs.operating, asOf, inputs.row.exitDate);
  const cutoff = bridgeCutoff(inputs.row.exitDate, asOf);
  const company = (
    row: OperatingRow,
  ): Pick<ValueCreationSeriesPoint, 'ebitdaIndex' | 'evIndex' | 'equityValueIndex'> => ({
    ebitdaIndex: str(indexedLevel(row.ebitdaLtm, entry?.ebitdaLtm ?? null)),
    evIndex: str(indexedLevel(row.ev, entry?.ev ?? null)),
    equityValueIndex: str(
      indexedLevel(
        equityValue(row.ev, row.netDebt),
        entry === null ? null : equityValue(entry.ev, entry.netDebt),
      ),
    ),
  });
  const points: ValueCreationSeriesPoint[] = [];
  if (entry !== null)
    points.push({ periodEnd: entry.periodEnd, isEntry: true, ...company(entry), markIndex: null });
  const marks = inputs.valuations.filter((v) => v.periodEnd <= asOf);
  const quarters = withCalcStatus(inputs.operating)
    .filter(
      (r) =>
        !r.isEntrySnapshot &&
        r.status === 'approved' &&
        r.periodEnd <= cutoff &&
        (entry === null || r.periodEnd > entry.periodEnd),
    )
    .sort((a, b) => compareText(a.periodEnd, b.periodEnd));
  for (const quarter of quarters) {
    const mark = lockedNear(
      marks,
      alignedQuarterEnd(quarter.periodEnd, toleranceDays),
      toleranceDays,
    );
    const invested = summarizeFlows(
      inputs.flows
        .filter((f) => f.flowDate <= quarter.periodEnd)
        .map((f) => ({ date: f.flowDate, kind: kindOf(f.flowType), amount: f.amount })),
    ).contributions;
    points.push({
      periodEnd: quarter.periodEnd,
      isEntry: false,
      ...company(quarter),
      markIndex: str(indexedLevel(mark?.fairValue ?? null, invested)),
    });
  }
  return points;
}

/** The export's columns, in order: identity, the company at entry and now, the bridge, then ours. */
export const VALUE_CREATION_CSV_COLUMNS = [
  'investmentNumber',
  'companyName',
  'vehicleName',
  'sponsorName',
  'sector',
  'dealType',
  'entryDate',
  'entryYear',
  'exitDate',
  'status',
  'entryPeriodEnd',
  'entryRevenueLtm',
  'entryEbitdaLtm',
  'entryEv',
  'entryNetDebt',
  'entryEquityValue',
  'entryEvToEbitda',
  'entryNetDebtToEbitda',
  'currentPeriodEnd',
  'currentRevenueLtm',
  'currentEbitdaLtm',
  'currentEv',
  'currentNetDebt',
  'currentEquityValue',
  'currentEvToEbitda',
  'currentNetDebtToEbitda',
  'ebitdaGrowth',
  'evGrowth',
  'equityValueGrowth',
  'multipleChange',
  'netLeverageChange',
  'netDebtChange',
  'bridgeEbitdaGrowth',
  'bridgeMultipleExpansion',
  'bridgeDebtPaydown',
  'bridgeTotal',
  'shareEbitdaGrowth',
  'shareMultipleExpansion',
  'shareDebtPaydown',
  'bridgeRevenueGrowth',
  'bridgeMarginChange',
  'notCalculable',
  'invested',
  'nav',
  'distributions',
  'grossMoic',
  'grossIrr',
  'irrFlag',
  'valuationGrowth',
  'valuationGrowthGap',
  'stake',
  'gain',
  'gainEbitdaGrowth',
  'gainMultipleExpansion',
  'gainDebtPaydown',
  'gainOther',
  'gainRevenueGrowth',
  'gainMarginChange',
  'gainNotCalculable',
  'entryMultipleBand',
  'entryLeverageBand',
  'investmentId',
] as const;
type CsvColumn = (typeof VALUE_CREATION_CSV_COLUMNS)[number];

/** One position as the export's cells; a figure that is not calculable is an empty cell, never a zero. */
function csvCells(
  p: ValueCreationPosition,
  multipleLabels: ReadonlyMap<string, string>,
  leverageLabels: ReadonlyMap<string, string>,
): Record<CsvColumn, string | null> {
  return {
    investmentNumber: p.investmentNumber,
    companyName: p.companyName,
    vehicleName: p.vehicleName,
    sponsorName: p.sponsorName,
    sector: p.sector,
    dealType: p.dealType,
    entryDate: p.entryDate,
    entryYear: String(p.entryYear),
    exitDate: p.exitDate,
    status: p.status,
    entryPeriodEnd: p.entry?.periodEnd ?? null,
    entryRevenueLtm: p.entry?.revenueLtm ?? null,
    entryEbitdaLtm: p.entry?.ebitdaLtm ?? null,
    entryEv: p.entry?.ev ?? null,
    entryNetDebt: p.entry?.netDebt ?? null,
    entryEquityValue: p.entry?.equityValue ?? null,
    entryEvToEbitda: p.entry?.evToEbitda ?? null,
    entryNetDebtToEbitda: p.entry?.netDebtToEbitda ?? null,
    currentPeriodEnd: p.current?.periodEnd ?? null,
    currentRevenueLtm: p.current?.revenueLtm ?? null,
    currentEbitdaLtm: p.current?.ebitdaLtm ?? null,
    currentEv: p.current?.ev ?? null,
    currentNetDebt: p.current?.netDebt ?? null,
    currentEquityValue: p.current?.equityValue ?? null,
    currentEvToEbitda: p.current?.evToEbitda ?? null,
    currentNetDebtToEbitda: p.current?.netDebtToEbitda ?? null,
    ebitdaGrowth: p.growth.ebitdaGrowth,
    evGrowth: p.growth.evGrowth,
    equityValueGrowth: p.growth.equityValueGrowth,
    multipleChange: p.growth.multipleChange,
    netLeverageChange: p.growth.netLeverageChange,
    netDebtChange: p.growth.netDebtChange,
    bridgeEbitdaGrowth: p.bridge?.ebitdaGrowth ?? null,
    bridgeMultipleExpansion: p.bridge?.multipleExpansion ?? null,
    bridgeDebtPaydown: p.bridge?.debtPaydown ?? null,
    bridgeTotal: p.bridge?.total ?? null,
    shareEbitdaGrowth: p.bridge?.shares?.ebitdaGrowth ?? null,
    shareMultipleExpansion: p.bridge?.shares?.multipleExpansion ?? null,
    shareDebtPaydown: p.bridge?.shares?.debtPaydown ?? null,
    bridgeRevenueGrowth: p.bridge?.revenueGrowth ?? null,
    bridgeMarginChange: p.bridge?.marginChange ?? null,
    notCalculable: p.notCalculable,
    invested: p.invested,
    nav: p.nav,
    distributions: p.distributions,
    grossMoic: p.grossMoic,
    grossIrr: p.grossIrr,
    irrFlag: p.irrFlag,
    valuationGrowth: p.valuationGrowth,
    valuationGrowthGap: p.valuationGrowthGap,
    stake: p.stake,
    gain: p.gain,
    gainEbitdaGrowth: p.gainByDriver?.ebitdaGrowth ?? null,
    gainMultipleExpansion: p.gainByDriver?.multipleExpansion ?? null,
    gainDebtPaydown: p.gainByDriver?.debtPaydown ?? null,
    gainOther: p.gainByDriver?.other ?? null,
    gainRevenueGrowth: p.gainByDriver?.revenueGrowth ?? null,
    gainMarginChange: p.gainByDriver?.marginChange ?? null,
    gainNotCalculable: p.gainNotCalculable,
    entryMultipleBand: multipleLabels.get(p.entryMultipleBand) ?? p.entryMultipleBand,
    entryLeverageBand: leverageLabels.get(p.entryLeverageBand) ?? p.entryLeverageBand,
    investmentId: p.id,
  };
}

/** The positions of a view that pass its filters: the rule a page filters its own rows by. */
export function filteredPositions(
  view: ValueCreation,
  filters: ValueCreationFilters,
): ValueCreationPosition[] {
  return view.positions.filter((p) => matchesValueCreationFilters(p, filters));
}

/**
 * The positions as CSV: a header line and one line per position that passes the filters (every
 * position when none is set), with the band labels of the view.
 */
export function valueCreationCsv(view: ValueCreation, filters: ValueCreationFilters = {}): string {
  const multipleLabels = new Map(view.cohorts.byEntryMultiple.map((c) => [c.key, c.label]));
  const leverageLabels = new Map(view.cohorts.byEntryLeverage.map((c) => [c.key, c.label]));
  return toCsv(
    VALUE_CREATION_CSV_COLUMNS,
    filteredPositions(view, filters).map((p) => {
      const cells = csvCells(p, multipleLabels, leverageLabels);
      return VALUE_CREATION_CSV_COLUMNS.map((column) => cells[column] ?? '');
    }),
  );
}
