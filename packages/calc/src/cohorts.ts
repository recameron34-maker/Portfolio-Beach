import type { Decimal, DecimalInput } from './decimal.js';
import { CalcError, D, ZERO } from './decimal.js';

/*
 * Cohorts by an entry metric (docs/08 section 8): bands over a figure measured in turns (the
 * entry purchase multiple, the entry net leverage) and the weighted average a cohort reports.
 */

/** One band of a figure measured in turns. */
export interface Band {
  /** Position among the bands, 0 for the lowest. */
  index: number;
  /** The edge the band starts at (values at it belong to the band); null for the lowest band. */
  lower: Decimal | null;
  /** The edge the band stops short of; null for the highest band. */
  upper: Decimal | null;
  /** "Under 8.0x", "8.0x to 10.0x", "14.0x and over". */
  label: string;
}

/** Edges as Decimals; there must be at least one and they must be strictly ascending (config, never code). */
function ascending(edges: readonly DecimalInput[]): [Decimal, ...Decimal[]] {
  const [first, ...rest] = edges.map((e) => D(e));
  if (first === undefined)
    throw new CalcError('bands need at least one edge', 'invalid_band_edges');
  let before = first;
  for (const here of rest) {
    if (here.lte(before))
      throw new CalcError('band edges must be strictly ascending', 'invalid_band_edges');
    before = here;
  }
  return [first, ...rest];
}

/** An edge in turns: one decimal, or the places the edge itself carries when it has more. */
const turns = (edge: Decimal): string =>
  `${edge.decimalPlaces() <= 1 ? edge.toFixed(1) : edge.toString()}x`;

/**
 * The bands that ascending edges cut the line into: below the first edge, each interval closed
 * below and open above, and at or above the last edge. One more band than edges; together they
 * hold every value exactly once.
 */
export function turnBands(edges: readonly DecimalInput[]): Band[] {
  const [first, ...rest] = ascending(edges);
  const bands: Band[] = [{ index: 0, lower: null, upper: first, label: `Under ${turns(first)}` }];
  let lower = first;
  for (const upper of rest) {
    bands.push({ index: bands.length, lower, upper, label: `${turns(lower)} to ${turns(upper)}` });
    lower = upper;
  }
  bands.push({ index: bands.length, lower, upper: null, label: `${turns(lower)} and over` });
  return bands;
}

/** The index of the band a value falls in: the number of edges at or below it. */
export function bandIndexOf(value: DecimalInput, edges: readonly DecimalInput[]): number {
  const v = D(value);
  return ascending(edges).filter((edge) => edge.lte(v)).length;
}

/**
 * The weighted average of values (sum of weight x value / sum of weights), such as a cohort's
 * invested-weighted EBITDA growth. Null for no items or weights that sum to zero.
 */
export function weightedAverage(
  items: readonly { weight: DecimalInput; value: DecimalInput }[],
): Decimal | null {
  let weights = ZERO;
  let weighted = ZERO;
  for (const item of items) {
    const w = D(item.weight);
    weights = weights.plus(w);
    weighted = weighted.plus(w.times(D(item.value)));
  }
  return weights.isZero() ? null : weighted.div(weights);
}
