import { MISSING } from './format.js';

const DAY_MS = 86_400_000;

function utcDays(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

/** Whole days from one ISO date to another (UTC, no time zone involved); null when either is malformed. */
export function daysBetween(from: string, to: string): number | null {
  const a = utcDays(from);
  const b = utcDays(to);
  return a === null || b === null ? null : Math.round(b - a);
}

/**
 * Holding period as "x.y years" from entry to exit, a plain date difference over 365.25-day
 * years. The missing placeholder when either date is absent: nothing is inferred.
 */
export function formatHoldingPeriod(
  entry: string | null | undefined,
  exit: string | null | undefined,
): string {
  if (entry === null || entry === undefined || exit === null || exit === undefined) return MISSING;
  const days = daysBetween(entry, exit);
  if (days === null || days < 0) return MISSING;
  return `${(days / 365.25).toFixed(1)} years`;
}
