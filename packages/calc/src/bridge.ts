import type { Decimal, DecimalInput } from './decimal.js';
import { D, RESULT_PLACES } from './decimal.js';
import { evToEbitda, growthSinceEntry, multipleDelta, netDebtToEbitda } from './operating.js';

/*
 * Value creation analytics (docs/08 section 8): the EBITDA bridge of a company from entry to the
 * current quarter, the growth measures since entry, and our own gain on a position set against
 * the company's drivers at our entry stake. Every function is null instead of a misleading value.
 */

/**
 * The places a part of a split is held to. Each split rounds its leading parts here and gives the
 * last one the remainder, so the parts sum to the whole exactly (not within a tolerance) while
 * every part stays below ten trillion; twenty places of a dollar is far finer than any display.
 */
export const SPLIT_PLACES = 20;

/** A company's figures at one end of the bridge: the entry snapshot or the current quarter. */
export interface BridgePoint {
  ebitda: DecimalInput;
  ev: DecimalInput;
  netDebt: DecimalInput;
  /** LTM revenue. With a positive one at both ends, EBITDA growth is opened into revenue and margin. */
  revenue?: DecimalInput | null;
}

/** The three drivers a change in value is split into. */
export interface BridgeDrivers {
  ebitdaGrowth: Decimal;
  multipleExpansion: Decimal;
  /** Positive when net debt fell. */
  debtPaydown: Decimal;
}

export interface ValueCreationBridge extends BridgeDrivers {
  equityAtEntry: Decimal;
  equityCurrent: Decimal;
  /** Always equityCurrent - equityAtEntry, and always the sum of the three drivers. */
  total: Decimal;
  /** Each driver as a share of the total; null when the total is zero. */
  shares: BridgeDrivers | null;
  /** The part of ebitdaGrowth from revenue at the entry margin; null without two positive revenues. */
  revenueGrowth: Decimal | null;
  /** The part of ebitdaGrowth from the change in margin; null without two positive revenues. */
  marginChange: Decimal | null;
}

export type BridgeReason = 'non_positive_ebitda';

/** A bridge, or no bridge and always the reason why. */
export type BridgeResult =
  { value: ValueCreationBridge; reason?: undefined } | { value: null; reason: BridgeReason };

/**
 * The EBITDA bridge (docs/08 section 8): equity value = EBITDA x multiple - net debt, where
 * multiple = EV / EBITDA, changed one input at a time in the fixed order EBITDA, multiple, net
 * debt. It is the four-driver attribution with its revenue and margin steps taken together:
 *
 *   EBITDA growth      = (EBITDA1 - EBITDA0) x EV0 / EBITDA0
 *   multiple expansion = EBITDA1 x (EV1 / EBITDA1 - EV0 / EBITDA0) = (EV1 - EV0) - EBITDA growth
 *   debt paydown       = net debt0 - net debt1
 *
 * With a positive revenue at both ends, EBITDA growth opens into revenue growth
 * ((revenue1 - revenue0) x EV0 / revenue0, growth at the entry margin and multiple) and margin
 * change (the rest). No bridge when an EBITDA is not positive: the multiple is then undefined.
 */
export function valueCreationBridge(entry: BridgePoint, current: BridgePoint): BridgeResult {
  const e0 = D(entry.ebitda);
  const e1 = D(current.ebitda);
  if (e0.lte(0) || e1.lte(0)) return { value: null, reason: 'non_positive_ebitda' };
  const ev0 = D(entry.ev);
  const ev1 = D(current.ev);
  const d0 = D(entry.netDebt);
  const d1 = D(current.netDebt);

  const equityAtEntry = ev0.minus(d0);
  const equityCurrent = ev1.minus(d1);
  const ebitdaGrowth = e1.minus(e0).times(ev0).div(e0).toDecimalPlaces(SPLIT_PLACES);
  const multipleExpansion = ev1.minus(ev0).minus(ebitdaGrowth);
  const debtPaydown = d0.minus(d1);
  const total = equityCurrent.minus(equityAtEntry);

  let revenueGrowth: Decimal | null = null;
  let marginChange: Decimal | null = null;
  const r0 = revenueOf(entry);
  const r1 = revenueOf(current);
  if (r0 !== null && r1 !== null) {
    revenueGrowth = r1.minus(r0).times(ev0).div(r0).toDecimalPlaces(SPLIT_PLACES);
    marginChange = ebitdaGrowth.minus(revenueGrowth);
  }
  return {
    value: {
      equityAtEntry,
      equityCurrent,
      ebitdaGrowth,
      multipleExpansion,
      debtPaydown,
      total,
      shares: total.isZero()
        ? null
        : {
            ebitdaGrowth: ebitdaGrowth.div(total),
            multipleExpansion: multipleExpansion.div(total),
            debtPaydown: debtPaydown.div(total),
          },
      revenueGrowth,
      marginChange,
    },
  };
}

/** A point's revenue when it is on record and positive, the only kind the split can use. */
function revenueOf(point: BridgePoint): Decimal | null {
  if (point.revenue === undefined || point.revenue === null) return null;
  const r = D(point.revenue);
  return r.lte(0) ? null : r;
}

/**
 * Our stake in a company at entry (docs/08 section 8): our invested capital in the position over
 * the company's equity value at entry. Null without invested capital, without an entry equity
 * value, or when that equity value is not positive (a stake in nothing has no size).
 */
export function entryStake(
  invested: DecimalInput | null,
  equityAtEntry: DecimalInput | null,
): Decimal | null {
  if (invested === null || equityAtEntry === null) return null;
  const paid = D(invested).abs();
  const equity = D(equityAtEntry);
  return paid.isZero() || equity.lte(0) ? null : paid.div(equity);
}

/** Our gain on a position set against the company's drivers at our entry stake; the four parts sum to the gain exactly. */
export interface GainByDriver extends BridgeDrivers {
  /** Our invested capital over the company's equity value at entry. */
  stake: Decimal;
  /**
   * The gain less the three driver parts: what the company's equity value change at our entry
   * stake does not explain (our mark against the company's value, fees, the timing of flows,
   * follow-on investments and realizations). A real figure, shown and summed.
   */
  other: Decimal;
  /** The part of ebitdaGrowth from revenue; null when the company's bridge has no revenue split. */
  revenueGrowth: Decimal | null;
  marginChange: Decimal | null;
}

export type GainSplitReason = 'no_gain' | 'non_positive_entry_equity';

/** The split, or no split and always the reason why. */
export type GainSplitResult =
  { value: GainByDriver; reason?: undefined } | { value: null; reason: GainSplitReason };

/**
 * Our own gain on a position by driver (docs/08 section 8). Our share of each company driver is
 * our entry stake times the driver in money, invested x driver / entry equity value, held to the
 * places a result travels with (RESULT_PLACES), so the parts a reader receives are the parts that
 * were summed. `other` is the gain less the three shares, so the four parts are the gain exactly;
 * the revenue and margin parts open the EBITDA part the same way. A company whose equity value
 * did not move is no special case: its drivers cancel and `other` carries the gain.
 *
 * Not calculable without a gain or invested capital (`no_gain`), or when the company's equity
 * value at entry is not positive (`non_positive_entry_equity`). The rule lives in this one
 * function so it can change in one place.
 */
export function gainByDriver(
  gain: DecimalInput | null,
  invested: DecimalInput | null,
  bridge: ValueCreationBridge,
): GainSplitResult {
  if (gain === null || invested === null || D(invested).isZero())
    return { value: null, reason: 'no_gain' };
  const stake = entryStake(invested, bridge.equityAtEntry);
  if (stake === null) return { value: null, reason: 'non_positive_entry_equity' };
  const paid = D(invested).abs();
  const share = (driver: Decimal): Decimal =>
    paid.times(driver).div(bridge.equityAtEntry).toDecimalPlaces(RESULT_PLACES);
  const ebitdaGrowth = share(bridge.ebitdaGrowth);
  const multipleExpansion = share(bridge.multipleExpansion);
  const debtPaydown = share(bridge.debtPaydown);
  const revenueGrowth = bridge.revenueGrowth === null ? null : share(bridge.revenueGrowth);
  return {
    value: {
      stake,
      ebitdaGrowth,
      multipleExpansion,
      debtPaydown,
      other: D(gain).minus(ebitdaGrowth).minus(multipleExpansion).minus(debtPaydown),
      revenueGrowth,
      marginChange: revenueGrowth === null ? null : ebitdaGrowth.minus(revenueGrowth),
    },
  };
}

/** The figures the growth measures read; any of them may be missing from a quarter. */
export interface OperatingFigures {
  ebitda: DecimalInput | null;
  ev: DecimalInput | null;
  netDebt: DecimalInput | null;
}

export interface SinceEntryMeasures {
  /** Ratios: current / entry - 1. */
  ebitdaGrowth: Decimal | null;
  evGrowth: Decimal | null;
  equityValueGrowth: Decimal | null;
  /** Turns: current EV / EBITDA less entry EV / EBITDA. */
  multipleChange: Decimal | null;
  /** Turns: current net debt / EBITDA less entry net debt / EBITDA. */
  netLeverageChange: Decimal | null;
  /** Money: current net debt less entry net debt (negative when debt was paid down). */
  netDebtChange: Decimal | null;
}

/** Equity value = EV - net debt; null when either is not on record. */
export function equityValue(ev: DecimalInput | null, netDebt: DecimalInput | null): Decimal | null {
  return ev === null || netDebt === null ? null : D(ev).minus(D(netDebt));
}

/**
 * Growth since entry of EBITDA, EV and equity value, and the change in the multiple, in net
 * leverage and in net debt, each by the one rule docs/08 section 4 gives it: a ratio is null on a
 * missing figure or a base at or below zero, a multiple is null on an EBITDA at or below zero.
 */
export function sinceEntryMeasures(
  entry: OperatingFigures,
  current: OperatingFigures,
): SinceEntryMeasures {
  const multiple = (p: OperatingFigures): Decimal | null =>
    p.ev === null ? null : evToEbitda(p.ev, p.ebitda);
  const leverage = (p: OperatingFigures): Decimal | null =>
    p.netDebt === null ? null : netDebtToEbitda(p.netDebt, p.ebitda);
  return {
    ebitdaGrowth: growthSinceEntry(current.ebitda, entry.ebitda),
    evGrowth: growthSinceEntry(current.ev, entry.ev),
    equityValueGrowth: growthSinceEntry(
      equityValue(current.ev, current.netDebt),
      equityValue(entry.ev, entry.netDebt),
    ),
    multipleChange: multipleDelta(multiple(current), multiple(entry)),
    netLeverageChange: multipleDelta(leverage(current), leverage(entry)),
    netDebtChange:
      current.netDebt === null || entry.netDebt === null
        ? null
        : D(current.netDebt).minus(D(entry.netDebt)),
  };
}

/**
 * A figure indexed to 100 at its base (current / base x 100), for lines that start together at
 * entry; null on a missing figure or a base at or below zero, as growth since entry is.
 */
export function indexedLevel(
  current: DecimalInput | null,
  base: DecimalInput | null,
): Decimal | null {
  if (current === null || base === null) return null;
  const b = D(base);
  return b.lte(0) ? null : D(current).times(100).div(b);
}
