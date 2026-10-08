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

/** The subset of a valuation that choosing the mark for a quarter needs. */
export interface MarkRow {
  periodEnd: IsoDate;
  state: string;
}

/**
 * The Locked mark that counts for a quarter end: the latest one whose period end is the target or
 * up to `toleranceDays` before it, so a sponsor reporting a few days before the quarter end still
 * counts for that quarter. Never a mark after the target. On equal period ends the first in input
 * order wins, so callers that list the highest version first get the latest version.
 */
export function lockedNear<T extends MarkRow>(
  marks: readonly T[],
  target: IsoDate,
  toleranceDays: number,
): T | null {
  let best: T | null = null;
  for (const m of marks) {
    if (m.state !== 'Locked') continue;
    const gap = daysBetween(m.periodEnd, target);
    if (gap < 0 || gap > toleranceDays) continue;
    if (best === null || m.periodEnd > best.periodEnd) best = m;
  }
  return best;
}
