import { CalcError } from './decimal.js';
import type { IsoDate } from './dates.js';
import { addYears, compareIso, daysBetween } from './dates.js';

/** The subset of a monitoring row that period selection needs (docs/08 section 5). */
export interface PeriodRow {
  periodEnd: IsoDate;
  /** Staging status; only 'approved' rows count as data (docs/18 section 2). */
  status: string;
  isEntrySnapshot: boolean;
}

export interface PeriodOptions {
  /** Period-end dates up to this many days apart still count as the same quarter (config). */
  toleranceDays?: number;
}

/**
 * Same quarter one year earlier, matched on date within the tolerance. Never the nearest period.
 */
export function sameQuarterPriorYear<T extends PeriodRow>(
  rows: readonly T[],
  target: IsoDate,
  options: PeriodOptions = {},
): T | null {
  const tolerance = options.toleranceDays ?? 7;
  const wanted = addYears(target, -1);
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.isEntrySnapshot) continue;
    const distance = Math.abs(daysBetween(wanted, row.periodEnd));
    if (distance <= tolerance && distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The most recent period with approved data on or before the reporting date, ignoring entry
 * snapshots and anything after the reporting date (forward-dated rows are never selected).
 */
export function latestPeriod<T extends PeriodRow>(
  rows: readonly T[],
  reportingDate: IsoDate,
): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (row.isEntrySnapshot || row.status !== 'approved') continue;
    if (compareIso(row.periodEnd, reportingDate) > 0) continue;
    if (best === null || compareIso(row.periodEnd, best.periodEnd) > 0) best = row;
  }
  return best;
}

/** The row flagged as the entry snapshot. Never inferred from the earliest date. */
export function entrySnapshot<T extends PeriodRow>(rows: readonly T[]): T | null {
  const flagged = rows.filter((r) => r.isEntrySnapshot);
  if (flagged.length > 1) {
    throw new CalcError('more than one entry snapshot flagged', 'multiple_entry_snapshots');
  }
  return flagged[0] ?? null;
}
