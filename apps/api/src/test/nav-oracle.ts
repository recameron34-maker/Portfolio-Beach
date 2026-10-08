import { D, ZERO, daysBetween } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import type { SyntheticDataset } from '@pb/db';

/** The last day of the calendar quarter that contains a date. */
export function containingQuarterEnd(iso: string): string {
  const year = iso.slice(0, 4);
  const month = Math.ceil(Number(iso.slice(5, 7)) / 3) * 3;
  const day = month === 3 || month === 12 ? 31 : 30;
  return `${year}-${String(month).padStart(2, '0')}-${day}`;
}

/**
 * The NAV series a test expects, worked out straight from the seed rather than through the API's
 * helpers: the Locked marks of the given investments on or before the as-of date, summed by the
 * calendar quarter they report for, the latest `quarters` points oldest first. Valid for the
 * synthetic seed, whose marks sit on the quarter end or a few days before it (period_end_shift)
 * and never twice in one quarter for a position; it throws otherwise, so the oracle can never
 * silently disagree with the rule.
 */
export function expectedNavSeries(
  dataset: SyntheticDataset,
  investmentIds: ReadonlySet<string>,
  quarters: number,
  toleranceDays: number,
): { periodEnd: string; value: Decimal }[] {
  const totals = new Map<string, Decimal>();
  const seen = new Set<string>();
  for (const v of dataset.valuations) {
    if (!investmentIds.has(v.investmentId) || v.state !== 'Locked' || v.periodEnd > dataset.asOf)
      continue;
    const quarterEnd = containingQuarterEnd(v.periodEnd);
    if (daysBetween(v.periodEnd, quarterEnd) > toleranceDays)
      throw new Error(`mark ${v.periodEnd} is not within ${toleranceDays} days of ${quarterEnd}`);
    const key = `${v.investmentId}|${quarterEnd}`;
    if (seen.has(key)) throw new Error(`two Locked marks fold into ${key}`);
    seen.add(key);
    totals.set(quarterEnd, (totals.get(quarterEnd) ?? ZERO).plus(D(v.fairValue)));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(-quarters)
    .map(([periodEnd, value]) => ({ periodEnd, value }));
}
