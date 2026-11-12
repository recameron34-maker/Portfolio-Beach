import { NOT_CALCULABLE_BAND } from '@pb/contracts';
import type {
  EntryCohort,
  GainByDriver,
  ValueCreation,
  ValueCreationBridge,
  ValueCreationPosition,
  ValueCreationReason,
} from '@pb/contracts';
import type { BarDatum, BridgeStep, ScatterPoint } from '../../components/charts/index.js';
import {
  formatMoic,
  formatMoneyM,
  formatMultiple,
  formatPct,
  MISSING,
  plural,
} from '../../lib/format.js';

/*
 * View helpers of the value creation and entry metric tabs and of the deal's value creation card.
 * Pure: every figure a reader sees is formatted from the API's decimal string; Number is used for
 * chart geometry and for ordering rows, never to derive a figure (docs/08, CLAUDE.md rule 10).
 */

/** Why a figure is missing, in plain words; the placeholder always travels with one of these. */
export const REASON_TEXT: Record<ValueCreationReason, string> = {
  no_entry_snapshot: 'No approved entry snapshot',
  // The wording of the deal's Since entry card for the same case.
  entry_snapshot_forward_dated: 'The entry snapshot is dated after the as-of date',
  no_current_quarter: 'No approved quarter on or before the as-of date, or the exit',
  missing_figures: 'EBITDA, EV or net debt is missing at entry or in the current quarter',
  non_positive_ebitda: 'EBITDA is at or below zero at entry or in the current quarter',
  non_positive_entry_equity:
    'The company equity value at entry is not positive, so our stake has no size',
  no_gain: 'Our gain is not calculable: no Locked valuation, or nothing invested',
};

/** What the page calls `other`, the part of our gain the company's change at our stake does not explain. */
export const MARK_AND_TIMING = 'Mark and timing';

/** A change in $M with its sign: "+$5.0M", "-$1.3M"; an unchanged figure has none; null is the placeholder. */
export function formatSignedMoneyM(value: string | null | undefined): string {
  const text = formatMoneyM(value);
  if (text === MISSING || text.startsWith('-') || Number(value) === 0) return text;
  return `+${text}`;
}

/** A change in turns with its sign: "+1.0x", "-0.2x". */
export function formatSignedTurns(value: string | null | undefined): string {
  const text = formatMultiple(value);
  if (text === MISSING || text.startsWith('-') || Number(value) === 0) return text;
  return `+${text}`;
}

const numberOf = (value: string): number => Number(value);

/**
 * The steps between the two totals of a bridge: EBITDA growth (or, opened, its revenue and margin
 * parts), multiple expansion and debt paydown, and for our own gain the rest of it, mark and
 * timing. Opening needs both parts; without them the step stays whole.
 */
function driverSteps(
  drivers: GainByDriver | ValueCreationBridge,
  open: boolean,
): { label: string; value: string }[] {
  const { revenueGrowth, marginChange } = drivers;
  const ebitda =
    open && revenueGrowth !== null && marginChange !== null
      ? [
          { label: 'Revenue growth', value: revenueGrowth },
          { label: 'Margin change', value: marginChange },
        ]
      : [{ label: 'EBITDA growth', value: drivers.ebitdaGrowth }];
  return [
    ...ebitda,
    { label: 'Multiple expansion', value: drivers.multipleExpansion },
    { label: 'Debt paydown', value: drivers.debtPaydown },
    ...('other' in drivers ? [{ label: MARK_AND_TIMING, value: drivers.other }] : []),
  ];
}

function bridgeSteps(
  from: { label: string; value: string },
  drivers: GainByDriver | ValueCreationBridge,
  to: { label: string; value: string },
  open: boolean,
): BridgeStep[] {
  const total = (t: { label: string; value: string }): BridgeStep => ({
    label: t.label,
    value: numberOf(t.value),
    display: formatMoneyM(t.value),
    kind: 'total',
  });
  return [
    total(from),
    ...driverSteps(drivers, open).map((s): BridgeStep => ({
      label: s.label,
      value: numberOf(s.value),
      display: formatSignedMoneyM(s.value),
      kind: 'change',
    })),
    total(to),
  ];
}

/**
 * Our bridge over the positions the gain is split for: invested capital, the three drivers of our
 * gain, mark and timing, and the value now (NAV plus distributions). Null when no position can
 * be split.
 */
export function portfolioBridgeSteps(
  portfolio: ValueCreation['portfolio'],
  open: boolean,
): BridgeStep[] | null {
  const { invested, totalValue, gainByDriver } = portfolio;
  if (invested === null || totalValue === null || gainByDriver === null) return null;
  return bridgeSteps(
    { label: 'Invested', value: invested },
    gainByDriver,
    { label: 'Value now', value: totalValue },
    open,
  );
}

/** A company's bridge: equity value at entry, the three drivers, equity value now. */
export function companyBridgeSteps(bridge: ValueCreationBridge, open: boolean): BridgeStep[] {
  return bridgeSteps(
    { label: 'Equity value at entry', value: bridge.equityAtEntry },
    bridge,
    { label: 'Equity value now', value: bridge.equityCurrent },
    open,
  );
}

/** Whether a bridge carries the revenue and margin parts, so EBITDA growth can be opened. */
export function canOpenEbitda(drivers: GainByDriver | ValueCreationBridge | null): boolean {
  if (drivers === null) return false;
  return drivers.revenueGrowth !== null && drivers.marginChange !== null;
}

export interface PlottedPositions {
  points: ScatterPoint[];
  /** Positions without one of the two figures: named in a line under the chart, never plotted at zero. */
  leftOut: number;
}

/** What valuation growth is measured on, against the company's EBITDA growth. */
export type GrowthMeasure = 'mark' | 'equity' | 'ev';

interface GrowthMeasureWords {
  key: GrowthMeasure;
  /** The option a reader picks. */
  label: string;
  /** The y axis and the table column. */
  axis: string;
  /** The two sides of the line where the measure equals EBITDA growth: the chart's series. */
  ahead: string;
  behind: string;
  /** "our mark grew faster than the company EBITDA". */
  subject: string;
  /** How the chart's summary names the measure. */
  summary: string;
  /** "has no EBITDA growth or no mark growth". */
  missing: string;
  value: (p: ValueCreationPosition) => string | null;
}

/**
 * The three measures, our mark first (the default). Levered equity usually grows faster than
 * EBITDA; enterprise value is the like-for-like view.
 */
export const GROWTH_MEASURES: readonly GrowthMeasureWords[] = [
  {
    key: 'mark',
    label: 'Our mark',
    axis: 'Growth in our mark',
    ahead: 'Mark ahead of EBITDA growth',
    behind: 'Mark at or behind EBITDA growth',
    subject: 'our mark',
    summary: 'Growth in our mark (gross MOIC less one)',
    missing: 'mark growth',
    value: (p) => p.valuationGrowth,
  },
  {
    key: 'equity',
    label: 'Company equity value',
    axis: 'Equity value growth',
    ahead: 'Equity value ahead of EBITDA growth',
    behind: 'Equity value at or behind EBITDA growth',
    subject: 'the company equity value',
    summary: 'Growth in the company equity value (EV less net debt)',
    missing: 'equity value growth',
    value: (p) => p.growth.equityValueGrowth,
  },
  {
    key: 'ev',
    label: 'Enterprise value',
    axis: 'Enterprise value growth',
    ahead: 'Enterprise value ahead of EBITDA growth',
    behind: 'Enterprise value at or behind EBITDA growth',
    subject: 'the enterprise value',
    summary: 'Growth in the enterprise value',
    missing: 'enterprise value growth',
    value: (p) => p.growth.evGrowth,
  },
];

export function growthMeasure(key: GrowthMeasure): GrowthMeasureWords {
  return GROWTH_MEASURES.find((m) => m.key === key) ?? GROWTH_MEASURES[0]!;
}

/** The two sides of the line where growth in our mark equals EBITDA growth. */
export const MARK_AHEAD = growthMeasure('mark').ahead;
export const MARK_BEHIND = growthMeasure('mark').behind;

export interface GrowthScatter extends PlottedPositions {
  /** The sides that hold a mark, ahead first: the chart's series. */
  seriesNames: string[];
  /** How many of the plotted marks sit above the line: a count of marks, not a figure. */
  ahead: number;
}

/**
 * Valuation growth against EBITDA growth, one mark per company: x is the company's EBITDA growth
 * since entry, y the growth in the measure picked (our mark by default: the gross MOIC less
 * one). A mark above the line where the two are equal ran ahead of earnings; the side is the
 * mark's series, so the two sides stand apart. A position without one of the two figures is not
 * plotted, never drawn at zero.
 */
export function growthPoints(
  positions: readonly ValueCreationPosition[],
  measure: GrowthMeasure = 'mark',
): GrowthScatter {
  const words = growthMeasure(measure);
  const points: ScatterPoint[] = [];
  for (const p of positions) {
    const { ebitdaGrowth } = p.growth;
    const growth = words.value(p);
    if (ebitdaGrowth === null || growth === null) continue;
    points.push({
      label: p.companyName,
      x: numberOf(ebitdaGrowth),
      y: numberOf(growth),
      xDisplay: formatPct(ebitdaGrowth),
      yDisplay: formatPct(growth),
      series: numberOf(growth) > numberOf(ebitdaGrowth) ? words.ahead : words.behind,
    });
  }
  const present = new Set(points.map((p) => p.series));
  return {
    points,
    leftOut: positions.length - points.length,
    seriesNames: [words.ahead, words.behind].filter((name) => present.has(name)),
    ahead: points.filter((p) => p.series === words.ahead).length,
  };
}

/** The label of a cohort key in one of the two cohort lists; the key itself when the list does not name it. */
export function bandLabel(cohorts: readonly EntryCohort[], key: string): string {
  return cohorts.find((c) => c.key === key)?.label ?? key;
}

/** The cohorts a table lists: every band, and "Not calculable" only when it holds a position. */
export function listedCohorts(cohorts: readonly EntryCohort[]): EntryCohort[] {
  return cohorts.filter((c) => c.key !== NOT_CALCULABLE_BAND || c.count > 0);
}

/** MOIC bars of the bands that have one; a band with no MOIC has no bar, never a bar at zero. */
export function moicBars(cohorts: readonly EntryCohort[]): BarDatum[] {
  return cohorts.flatMap((c) =>
    c.key === NOT_CALCULABLE_BAND || c.grossMoic === null
      ? []
      : [{ label: c.label, value: numberOf(c.grossMoic), display: formatMoic(c.grossMoic) }],
  );
}

export interface EntryScatter extends PlottedPositions {
  /** The leverage bands that appear among the plotted marks, in the order of the cohorts. */
  seriesNames: string[];
}

/**
 * Entry purchase multiple against gross MOIC, one mark per company, the entry net leverage band
 * as the series. The band labels come from the response's cohorts, never from the page.
 */
export function entryMultiplePoints(
  view: Pick<ValueCreation, 'positions' | 'cohorts'>,
): EntryScatter {
  const points: ScatterPoint[] = [];
  for (const p of view.positions) {
    const multiple = p.entry?.evToEbitda ?? null;
    if (multiple === null || p.grossMoic === null) continue;
    points.push({
      label: p.companyName,
      x: numberOf(multiple),
      y: numberOf(p.grossMoic),
      xDisplay: formatMultiple(multiple),
      yDisplay: formatMoic(p.grossMoic),
      series: bandLabel(view.cohorts.byEntryLeverage, p.entryLeverageBand),
    });
  }
  const present = new Set(points.map((p) => p.series));
  return {
    points,
    leftOut: view.positions.length - points.length,
    seriesNames: view.cohorts.byEntryLeverage.map((c) => c.label).filter((l) => present.has(l)),
  };
}

/** The columns the positions table sorts by. */
export type SortKey =
  | 'investmentNumber'
  | 'companyName'
  | 'stake'
  | 'entryMultiple'
  | 'currentMultiple'
  | 'entryLeverage'
  | 'currentLeverage'
  | 'ebitdaGrowth'
  | 'valuationGrowth'
  | 'gain'
  | 'gainEbitdaGrowth'
  | 'gainMultipleExpansion'
  | 'gainDebtPaydown'
  | 'gainOther'
  | 'grossMoic'
  | 'grossIrr';

export interface SortState {
  key: SortKey;
  direction: 'ascending' | 'descending';
}

/** The table opens on our gain, largest first: the positions that made the headline. */
export const DEFAULT_SORT: SortState = { key: 'gain', direction: 'descending' };

const SORT_VALUE: Record<SortKey, (p: ValueCreationPosition) => string | null> = {
  investmentNumber: (p) => p.investmentNumber,
  companyName: (p) => p.companyName,
  stake: (p) => p.stake,
  entryMultiple: (p) => p.entry?.evToEbitda ?? null,
  currentMultiple: (p) => p.current?.evToEbitda ?? null,
  entryLeverage: (p) => p.entry?.netDebtToEbitda ?? null,
  currentLeverage: (p) => p.current?.netDebtToEbitda ?? null,
  ebitdaGrowth: (p) => p.growth.ebitdaGrowth,
  valuationGrowth: (p) => p.valuationGrowth,
  gain: (p) => p.gain,
  gainEbitdaGrowth: (p) => p.gainByDriver?.ebitdaGrowth ?? null,
  gainMultipleExpansion: (p) => p.gainByDriver?.multipleExpansion ?? null,
  gainDebtPaydown: (p) => p.gainByDriver?.debtPaydown ?? null,
  gainOther: (p) => p.gainByDriver?.other ?? null,
  grossMoic: (p) => p.grossMoic,
  grossIrr: (p) => p.grossIrr,
};

const TEXT_KEYS: ReadonlySet<SortKey> = new Set(['investmentNumber', 'companyName']);

/**
 * The positions in a sort order. A figure that is not calculable sorts last whichever way the
 * column runs, so it never reads as the smallest or the largest; ties keep the investment number
 * order.
 */
export function sortPositions(
  positions: readonly ValueCreationPosition[],
  sort: SortState,
): ValueCreationPosition[] {
  const pick = SORT_VALUE[sort.key];
  const sign = sort.direction === 'ascending' ? 1 : -1;
  const text = TEXT_KEYS.has(sort.key);
  return [...positions].sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else {
      const order = text
        ? va < vb
          ? -1
          : va > vb
            ? 1
            : 0
        : Math.sign(numberOf(va) - numberOf(vb));
      if (order !== 0) return order * sign;
    }
    return a.investmentNumber < b.investmentNumber
      ? -1
      : a.investmentNumber > b.investmentNumber
        ? 1
        : 0;
  });
}

/** The next sort after a header is pressed: the other direction on the same column, else largest first (A to Z for text). */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key)
    return { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' };
  return { key, direction: TEXT_KEYS.has(key) ? 'ascending' : 'descending' };
}

/** "2 private credit positions": the deal types the views leave out, as the response counts them. */
export function leftOutText(leftOut: ValueCreation['leftOut']): string | null {
  if (leftOut.length === 0) return null;
  const parts = leftOut.map((l) => `${l.count} ${l.label.toLowerCase()}`);
  const total = leftOut.reduce((n, l) => n + l.count, 0);
  return `${parts.length === 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`} ${total === 1 ? 'position is' : 'positions are'} not part of this view: it covers equity co-investments and continuation vehicles.`;
}

/** "16 positions": the count the headline is over. */
export const positionsText = (n: number): string => plural(n, 'position');

/** The file the export saves as; the same name the API puts in its Content-Disposition. */
export const exportFileName = (asOf: string): string => `value-creation-${asOf}.csv`;
