import {
  CalcError,
  D,
  ZERO,
  alignedQuarterEnd,
  bandIndexOf,
  entrySnapshot,
  equityValue,
  evToEbitda,
  gainByDriver,
  indexedLevel,
  latestPeriod,
  lockedNear,
  netDebtToEbitda,
  sinceEntryMeasures,
  summarizeFlows,
  totalGain,
  turnBands,
  valueChange,
  valueCreationBridge,
  weightedAverage,
} from '@pb/calc';
import type { Band, Decimal, GainByDriver as GainParts, ValueCreationBridge } from '@pb/calc';
import { NOT_CALCULABLE_BAND, valueCreationReason } from '@pb/contracts';
import type {
  BridgeReason,
  EntryCohort,
  InvestmentSummary,
  ValueCreation,
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
import { kindOf, pooledPositionMetrics, str } from '../portfolio/metrics.js';
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

/** A position's row with the Decimals the roll-up and the cohorts sum, so nothing is parsed back from strings. */
export interface ComputedPosition {
  inputs: PositionInputs;
  position: ValueCreationPosition;
  /** The approved entry snapshot dated on or before the as-of date. */
  entry: OperatingRow | null;
  gain: Decimal | null;
  split: GainParts | null;
  ebitdaGrowth: Decimal | null;
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
    evToEbitda: str(multipleOf(row)),
    netDebtToEbitda: str(leverageOf(row)),
  };
}

/**
 * The entry and current quarters of a position as of a date. Entry is the row flagged
 * is_entry_snapshot (never the earliest date), and only once it is approved and dated on or
 * before the as-of date: a forward-dated snapshot is no basis for a comparison as of an earlier
 * day. Current is the latest approved quarter on or before the as-of date (docs/08 section 5);
 * a quarter that is not approved never counts.
 */
export function entryAndCurrent(
  operating: readonly OperatingRow[],
  asOf: string,
): { entry: OperatingRow | null; current: OperatingRow | null } {
  const rows = withCalcStatus(operating);
  const snapshot = entrySnapshot(rows);
  const entry =
    snapshot !== null && snapshot.status === 'approved' && snapshot.periodEnd <= asOf
      ? snapshot
      : null;
  return { entry, current: latestPeriod(rows, asOf) };
}

/** The company's bridge between two quarters, or the first reason it cannot be computed. */
function bridgeOf(
  entry: OperatingRow | null,
  current: OperatingRow | null,
): { bridge: ValueCreationBridge | null; reason: BridgeReason | null } {
  if (entry === null) return { bridge: null, reason: 'no_entry_snapshot' };
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

const bandKey = (value: Decimal | null, edges: readonly Decimal[]): string =>
  value === null ? NOT_CALCULABLE_BAND : `band_${bandIndexOf(value, edges)}`;

/** One position's row: the company side from its quarters, our side from the portfolio's own metrics. */
export function computePosition(
  inputs: PositionInputs,
  asOf: string,
  bands: EntryBands,
): ComputedPosition {
  const { row, summary } = inputs;
  const { entry, current } = entryAndCurrent(inputs.operating, asOf);
  const measures =
    entry === null || current === null
      ? null
      : sinceEntryMeasures(figuresOf(entry), figuresOf(current));
  const { bridge, reason } = bridgeOf(entry, current);

  // Our side is the position's own summary (the figures the portfolio grid shows), never a
  // second calculation: invested, distributions and NAV as of the date.
  const { invested, distributions, nav } = summary;
  const calculable = invested !== null && distributions !== null && nav !== null;
  const gain = calculable ? totalGain(distributions, nav, invested) : null;
  const valuationGrowth = calculable ? valueChange(D(nav).plus(distributions), invested) : null;
  const ebitdaGrowth = measures?.ebitdaGrowth ?? null;
  const split = gainByDriver(gain, bridge);
  const gainReason: ValueCreationReason | null =
    split !== null
      ? null
      : bridge === null
        ? reason
        : gain === null
          ? 'no_gain'
          : 'no_equity_change';

  return {
    inputs,
    entry,
    gain,
    split,
    ebitdaGrowth,
    position: {
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
      exitDate: row.exitDate,
      isActive: row.isActive,
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
      gain: str(gain),
      gainByDriver: split === null ? null : gainParts(split),
      gainNotCalculable: gainReason,
      entryMultipleBand: bandKey(entry === null ? null : multipleOf(entry), bands.multiple),
      entryLeverageBand: bandKey(entry === null ? null : leverageOf(entry), bands.leverage),
    },
  };
}

function gainParts(split: GainParts): NonNullable<ValueCreationPosition['gainByDriver']> {
  return {
    ebitdaGrowth: str(split.ebitdaGrowth)!,
    multipleExpansion: str(split.multipleExpansion)!,
    debtPaydown: str(split.debtPaydown)!,
    revenueGrowth: str(split.revenueGrowth),
    marginChange: str(split.marginChange),
  };
}

/**
 * Our gain by driver summed over the positions it can be split for, so the drivers sum to the
 * gain and invested + gain = totalValue (NAV + distributions); the rest are counted by reason, in the order
 * the contract lists the reasons. The revenue and margin parts are a total only when every
 * position summed carries them, never a partial sum.
 */
export function portfolioOf(computed: readonly ComputedPosition[]): ValueCreation['portfolio'] {
  const included = computed.filter((c) => c.split !== null);
  const reasons = new Map<ValueCreationReason, number>();
  for (const c of computed) {
    const reason = c.position.gainNotCalculable;
    if (reason !== null) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const notCalculable = valueCreationReason.options.flatMap((reason) => {
    const count = reasons.get(reason);
    return count === undefined ? [] : [{ reason, count }];
  });
  if (included.length === 0)
    return {
      positions: 0,
      invested: null,
      nav: null,
      distributions: null,
      totalValue: null,
      gain: null,
      gainByDriver: null,
      notCalculable,
    };
  const sum = (pick: (c: ComputedPosition) => Decimal | string | null): Decimal =>
    included.reduce((acc, c) => acc.plus(pick(c) ?? ZERO), ZERO);
  const nav = sum((c) => c.position.nav);
  const distributions = sum((c) => c.position.distributions);
  const everyOne = included.every((c) => c.split !== null && c.split.revenueGrowth !== null);
  return {
    positions: included.length,
    invested: str(sum((c) => c.position.invested)),
    nav: str(nav),
    distributions: str(distributions),
    totalValue: str(nav.plus(distributions)),
    gain: str(sum((c) => c.gain)),
    gainByDriver: {
      ebitdaGrowth: str(sum((c) => c.split?.ebitdaGrowth ?? null))!,
      multipleExpansion: str(sum((c) => c.split?.multipleExpansion ?? null))!,
      debtPaydown: str(sum((c) => c.split?.debtPaydown ?? null))!,
      revenueGrowth: everyOne ? str(sum((c) => c.split?.revenueGrowth ?? null)) : null,
      marginChange: everyOne ? str(sum((c) => c.split?.marginChange ?? null)) : null,
    },
    notCalculable,
  };
}

/**
 * The positions pooled by the band of one entry metric: every config band, lowest first, an
 * empty one with a count of 0, then the "Not calculable" cohort for the positions with no entry
 * figure. Each cohort is pooled by the one pooled rule (docs/08 sections 2 and 3).
 */
export function cohortsOf(
  computed: readonly ComputedPosition[],
  edges: readonly Decimal[],
  keyOf: (position: ValueCreationPosition) => string,
  asOf: string,
): EntryCohort[] {
  const bands: (Band | null)[] = [...turnBands(edges), null];
  return bands.map((band) => {
    const key = band === null ? NOT_CALCULABLE_BAND : `band_${band.index}`;
    const members = computed.filter((c) => keyOf(c.position) === key);
    const weighted = members.flatMap((c) =>
      c.position.invested === null || c.ebitdaGrowth === null
        ? []
        : [{ weight: c.position.invested, value: c.ebitdaGrowth }],
    );
    return {
      key,
      label: band === null ? 'Not calculable' : band.label,
      lower: str(band?.lower ?? null),
      upper: str(band?.upper ?? null),
      ...pooledPositionMetrics(
        members.map((c) => ({
          flows: c.inputs.flows,
          valuations: c.inputs.valuations,
          isActive: c.inputs.row.isActive,
        })),
        asOf,
      ),
      ebitdaGrowth: str(weightedAverage(weighted)),
      ebitdaGrowthPositions: weighted.length,
    };
  });
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
 * approved quarter after it on or before the as-of date. The company lines are indexed to the
 * entry figures; `markIndex` is the Locked mark that counts for the quarter (lockedNear, the
 * valuation board's rule) per 100 of the capital invested by the quarter's period end. A figure
 * that is missing, or whose base is not positive, is null: never carried and never zero.
 */
export function seriesOf(
  inputs: PositionInputs,
  asOf: string,
  toleranceDays: number,
): ValueCreationSeriesPoint[] {
  const { entry } = entryAndCurrent(inputs.operating, asOf);
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
        r.periodEnd <= asOf &&
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
  'exitDate',
  'status',
  'entryPeriodEnd',
  'entryRevenueLtm',
  'entryEbitdaLtm',
  'entryEv',
  'entryNetDebt',
  'entryEvToEbitda',
  'entryNetDebtToEbitda',
  'currentPeriodEnd',
  'currentRevenueLtm',
  'currentEbitdaLtm',
  'currentEv',
  'currentNetDebt',
  'currentEvToEbitda',
  'currentNetDebtToEbitda',
  'ebitdaGrowth',
  'evGrowth',
  'equityValueGrowth',
  'multipleChange',
  'netLeverageChange',
  'netDebtChange',
  'equityAtEntry',
  'equityCurrent',
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
  'gain',
  'gainEbitdaGrowth',
  'gainMultipleExpansion',
  'gainDebtPaydown',
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
    exitDate: p.exitDate,
    status: p.isActive ? 'active' : 'realized',
    entryPeriodEnd: p.entry?.periodEnd ?? null,
    entryRevenueLtm: p.entry?.revenueLtm ?? null,
    entryEbitdaLtm: p.entry?.ebitdaLtm ?? null,
    entryEv: p.entry?.ev ?? null,
    entryNetDebt: p.entry?.netDebt ?? null,
    entryEvToEbitda: p.entry?.evToEbitda ?? null,
    entryNetDebtToEbitda: p.entry?.netDebtToEbitda ?? null,
    currentPeriodEnd: p.current?.periodEnd ?? null,
    currentRevenueLtm: p.current?.revenueLtm ?? null,
    currentEbitdaLtm: p.current?.ebitdaLtm ?? null,
    currentEv: p.current?.ev ?? null,
    currentNetDebt: p.current?.netDebt ?? null,
    currentEvToEbitda: p.current?.evToEbitda ?? null,
    currentNetDebtToEbitda: p.current?.netDebtToEbitda ?? null,
    ebitdaGrowth: p.growth.ebitdaGrowth,
    evGrowth: p.growth.evGrowth,
    equityValueGrowth: p.growth.equityValueGrowth,
    multipleChange: p.growth.multipleChange,
    netLeverageChange: p.growth.netLeverageChange,
    netDebtChange: p.growth.netDebtChange,
    equityAtEntry: p.bridge?.equityAtEntry ?? null,
    equityCurrent: p.bridge?.equityCurrent ?? null,
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
    gain: p.gain,
    gainEbitdaGrowth: p.gainByDriver?.ebitdaGrowth ?? null,
    gainMultipleExpansion: p.gainByDriver?.multipleExpansion ?? null,
    gainDebtPaydown: p.gainByDriver?.debtPaydown ?? null,
    gainRevenueGrowth: p.gainByDriver?.revenueGrowth ?? null,
    gainMarginChange: p.gainByDriver?.marginChange ?? null,
    gainNotCalculable: p.gainNotCalculable,
    entryMultipleBand: multipleLabels.get(p.entryMultipleBand) ?? p.entryMultipleBand,
    entryLeverageBand: leverageLabels.get(p.entryLeverageBand) ?? p.entryLeverageBand,
    investmentId: p.id,
  };
}

/** The positions as CSV: a header line and one line per position, with the band labels of the view. */
export function valueCreationCsv(view: ValueCreation): string {
  const multipleLabels = new Map(view.cohorts.byEntryMultiple.map((c) => [c.key, c.label]));
  const leverageLabels = new Map(view.cohorts.byEntryLeverage.map((c) => [c.key, c.label]));
  return toCsv(
    VALUE_CREATION_CSV_COLUMNS,
    view.positions.map((p) => {
      const cells = csvCells(p, multipleLabels, leverageLabels);
      return VALUE_CREATION_CSV_COLUMNS.map((column) => cells[column] ?? '');
    }),
  );
}
