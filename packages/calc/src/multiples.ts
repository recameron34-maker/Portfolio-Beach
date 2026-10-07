import type { Decimal, DecimalInput } from './decimal.js';
import { D, Decimal as Dec } from './decimal.js';
import type { IsoDate } from './dates.js';
import { daysBetween } from './dates.js';

/** Return metrics per docs/08 section 2. Every function returns null instead of a misleading value. */

export function paidIn(contributions: DecimalInput): Decimal | null {
  const pi = D(contributions).abs();
  return pi.isZero() ? null : pi;
}

export function dpi(distributions: DecimalInput, contributions: DecimalInput): Decimal | null {
  const pi = paidIn(contributions);
  return pi === null ? null : D(distributions).div(pi);
}

export function rvpi(nav: DecimalInput, contributions: DecimalInput): Decimal | null {
  const pi = paidIn(contributions);
  return pi === null ? null : D(nav).div(pi);
}

export function tvpi(
  distributions: DecimalInput,
  nav: DecimalInput,
  contributions: DecimalInput,
): Decimal | null {
  const pi = paidIn(contributions);
  return pi === null ? null : D(distributions).plus(D(nav)).div(pi);
}

/** Gross deal-level MOIC: (realized proceeds + unrealized value) / invested capital. */
export function moic(
  realized: DecimalInput,
  unrealized: DecimalInput,
  invested: DecimalInput,
): Decimal | null {
  const inv = D(invested).abs();
  if (inv.isZero()) return null;
  return D(realized).plus(D(unrealized)).div(inv);
}

/** Unfunded = commitment - contributions + recallable distributions. Null when commitment is missing. */
export function unfunded(
  commitment: DecimalInput | null,
  contributions: DecimalInput,
  recallableDistributions: DecimalInput = '0',
): Decimal | null {
  if (commitment === null) return null;
  return D(commitment).minus(D(contributions).abs()).plus(D(recallableDistributions).abs());
}

/** Holding period in years (actual/365) from the first contribution to exit or as-of. */
export function holdingPeriodYears(
  firstContributionDate: IsoDate | null,
  exitOrAsOf: IsoDate,
): Decimal | null {
  if (firstContributionDate === null) return null;
  return new Dec(daysBetween(firstContributionDate, exitOrAsOf)).div(365);
}
