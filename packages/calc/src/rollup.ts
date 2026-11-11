import type { CashFlow } from './cashflows.js';
import type { CohortBand } from './cohorts.js';
import { weightedAverage } from './cohorts.js';
import type { IsoDate } from './dates.js';
import type { Decimal } from './decimal.js';
import { D, ZERO, toDecimalString } from './decimal.js';
import type { PooledFigures } from './pooled.js';
import { pooledFigures, pooledReturns } from './pooled.js';
import type { ValueCreationReason } from './terms.js';
import { VALUE_CREATION_REASONS } from './terms.js';

/*
 * The roll-up of the value creation views (docs/08 section 8): our gain by driver summed over a
 * set of positions, and the positions pooled by the band of an entry metric. It reads position
 * rows as they travel (decimal strings, each with its signed dated flows) and answers the
 * roll-up as it travels, so the server rolls up the whole book and a page rolls up a filtered
 * set with this one function, and the two can never disagree on a figure.
 */

/** Our gain by driver as it travels: the four parts sum to the gain. */
export interface RollupGainParts {
  ebitdaGrowth: string;
  multipleExpansion: string;
  debtPaydown: string;
  /** The gain less the three driver parts (docs/08 section 8). */
  other: string;
  revenueGrowth: string | null;
  marginChange: string | null;
}

/** What the roll-up reads of one position row of the value creation response. */
export interface RollupPosition {
  /** Held on the as-of date; a realized position holds no NAV. */
  isActive: boolean;
  invested: string | null;
  /** The latest Locked mark of a held position (null while it has none); "0" once realized. */
  nav: string | null;
  distributions: string | null;
  gain: string | null;
  gainByDriver: RollupGainParts | null;
  /** Why the gain is not split by driver; null when it is. */
  gainNotCalculable: ValueCreationReason | null;
  growth: { ebitdaGrowth: string | null };
  /** The position's flows on or before the as-of date, signed: paid out negative, received positive. */
  flows: readonly { date: IsoDate; amount: string }[];
  /** The key of the position's cohort by entry purchase multiple, and by entry net leverage. */
  entryMultipleBand: string;
  entryLeverageBand: string;
}

export interface RollupPortfolio {
  /** Positions whose gain is split by driver and summed here. */
  positions: number;
  /** Sums over those positions; null when there is none. */
  invested: string | null;
  nav: string | null;
  distributions: string | null;
  /** NAV + distributions, so invested + gain = totalValue. */
  totalValue: string | null;
  gain: string | null;
  gainByDriver: RollupGainParts | null;
  /** The positions left out, counted by reason in the order VALUE_CREATION_REASONS lists them. */
  notCalculable: { reason: ValueCreationReason; count: number }[];
}

export interface RollupCohort extends CohortBand, PooledFigures {
  /** The invested-weighted EBITDA growth since entry over the positions that have both figures. */
  ebitdaGrowth: string | null;
  /** How many of the cohort's positions the weighted EBITDA growth covers. */
  ebitdaGrowthPositions: number;
}

export interface ValueCreationRollup {
  portfolio: RollupPortfolio;
  cohorts: { byEntryMultiple: RollupCohort[]; byEntryLeverage: RollupCohort[] };
}

const str = toDecimalString;
const sumOf = <T>(rows: readonly T[], pick: (row: T) => string | null): Decimal =>
  rows.reduce((acc, row) => {
    const value = pick(row);
    return value === null ? acc : acc.plus(D(value));
  }, ZERO);

/**
 * Our gain by driver summed over the positions it is split for, so the four parts sum to the
 * gain and invested + gain = totalValue; the rest are counted by reason. The revenue and margin
 * parts are a total only when every position summed carries them, never a partial sum.
 */
function portfolioOf(positions: readonly RollupPosition[]): RollupPortfolio {
  const included = positions.flatMap((p) =>
    p.gainByDriver === null ? [] : [{ row: p, parts: p.gainByDriver }],
  );
  const notCalculable = VALUE_CREATION_REASONS.flatMap((reason) => {
    const count = positions.filter((p) => p.gainNotCalculable === reason).length;
    return count === 0 ? [] : [{ reason, count }];
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
  const nav = sumOf(included, (i) => i.row.nav);
  const distributions = sumOf(included, (i) => i.row.distributions);
  const everyOne = included.every((i) => i.parts.revenueGrowth !== null);
  return {
    positions: included.length,
    invested: str(sumOf(included, (i) => i.row.invested)),
    nav: str(nav),
    distributions: str(distributions),
    totalValue: str(nav.plus(distributions)),
    gain: str(sumOf(included, (i) => i.row.gain)),
    gainByDriver: {
      ebitdaGrowth: str(sumOf(included, (i) => i.parts.ebitdaGrowth))!,
      multipleExpansion: str(sumOf(included, (i) => i.parts.multipleExpansion))!,
      debtPaydown: str(sumOf(included, (i) => i.parts.debtPaydown))!,
      other: str(sumOf(included, (i) => i.parts.other))!,
      revenueGrowth: everyOne ? str(sumOf(included, (i) => i.parts.revenueGrowth)) : null,
      marginChange: everyOne ? str(sumOf(included, (i) => i.parts.marginChange)) : null,
    },
    notCalculable,
  };
}

/**
 * The positions of one band pooled by the one pooled rule (docs/08 sections 2 and 3). The rows
 * carry what the pool sums: invested capital (contributions), the signed flows (what was received
 * is every positive one) and the NAV of the positions still held, which is not calculable while
 * one of them has no Locked mark.
 */
function cohortOf(
  band: CohortBand,
  members: readonly RollupPosition[],
  asOf: IsoDate,
): RollupCohort {
  const flows: CashFlow[] = members.flatMap((p) => [...p.flows]);
  const received = flows.reduce((acc, f) => {
    const amount = D(f.amount);
    return amount.gt(0) ? acc.plus(amount) : acc;
  }, ZERO);
  const held = members.filter((p) => p.isActive);
  const weighted = members.flatMap((p) =>
    p.invested === null || p.growth.ebitdaGrowth === null
      ? []
      : [{ weight: p.invested, value: p.growth.ebitdaGrowth }],
  );
  return {
    key: band.key,
    label: band.label,
    lower: band.lower,
    upper: band.upper,
    ...pooledFigures(
      pooledReturns({
        count: members.length,
        contributions: sumOf(members, (p) => p.invested),
        distributions: received,
        nav: held.some((p) => p.nav === null) ? null : sumOf(held, (p) => p.nav),
        flows,
        asOf,
      }),
    ),
    ebitdaGrowth: str(weightedAverage(weighted)),
    ebitdaGrowthPositions: weighted.length,
  };
}

/**
 * The roll-up over a set of position rows: the whole book the caller can see, or the rows a
 * filter leaves. `bands` lists the cohorts of each entry metric in order (entryCohortBands on the
 * server; a page passes the cohorts of the response, which carry the same keys and labels), and a
 * band that holds no position keeps its row with a count of 0 and no figure.
 */
export function valueCreationRollup(
  positions: readonly RollupPosition[],
  bands: { byEntryMultiple: readonly CohortBand[]; byEntryLeverage: readonly CohortBand[] },
  asOf: IsoDate,
): ValueCreationRollup {
  const cohorts = (
    list: readonly CohortBand[],
    keyOf: (p: RollupPosition) => string,
  ): RollupCohort[] =>
    list.map((band) =>
      cohortOf(
        band,
        positions.filter((p) => keyOf(p) === band.key),
        asOf,
      ),
    );
  return {
    portfolio: portfolioOf(positions),
    cohorts: {
      byEntryMultiple: cohorts(bands.byEntryMultiple, (p) => p.entryMultipleBand),
      byEntryLeverage: cohorts(bands.byEntryLeverage, (p) => p.entryLeverageBand),
    },
  };
}
