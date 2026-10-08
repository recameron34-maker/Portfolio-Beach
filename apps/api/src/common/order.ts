import { D, ZERO } from '@pb/calc';
import type { Decimal } from '@pb/calc';

/*
 * Ordering and totals the read services share. Text sorts in byte order, so a list reads the same
 * in every locale; a figure that is not calculable sorts last and never counts as zero.
 */

/** Byte-order text comparison: the same order in every locale, unlike localeCompare. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Largest first, with "not calculable" (null) last. */
export function compareDecimalDesc(a: Decimal | string | null, b: Decimal | string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return D(b).comparedTo(D(a));
}

/** Sum of the calculable figures; null when none is calculable (docs/06 section 3), never 0 for unknown. */
export function sumCalculable<T>(
  rows: readonly T[],
  pick: (row: T) => Decimal | string | null,
): Decimal | null {
  let total: Decimal | null = null;
  for (const row of rows) {
    const value = pick(row);
    if (value !== null) total = (total ?? ZERO).plus(value);
  }
  return total;
}
