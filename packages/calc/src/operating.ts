import type { Decimal, DecimalInput } from './decimal.js';
import { D } from './decimal.js';

/** Operating metrics per docs/08 section 4. Null rules are part of the contract. */

export function evToEbitda(ev: DecimalInput, ebitdaLtm: DecimalInput | null): Decimal | null {
  if (ebitdaLtm === null) return null;
  const e = D(ebitdaLtm);
  return e.lte(0) ? null : D(ev).div(e);
}

export function netDebtToEbitda(
  netDebt: DecimalInput,
  ebitdaLtm: DecimalInput | null,
): Decimal | null {
  if (ebitdaLtm === null) return null;
  const e = D(ebitdaLtm);
  return e.lte(0) ? null : D(netDebt).div(e);
}

export function ebitdaMargin(
  ebitdaLtm: DecimalInput,
  revenueLtm: DecimalInput | null,
): Decimal | null {
  if (revenueLtm === null) return null;
  const r = D(revenueLtm);
  return r.lte(0) ? null : D(ebitdaLtm).div(r);
}

/** current / prior_same_quarter - 1; null when the prior-year quarter is missing or not positive. */
export function yoyGrowth(
  current: DecimalInput | null,
  priorSameQuarter: DecimalInput | null,
): Decimal | null {
  if (current === null || priorSameQuarter === null) return null;
  const p = D(priorSameQuarter);
  return p.lte(0) ? null : D(current).div(p).minus(1);
}

export function growthSinceEntry(
  current: DecimalInput | null,
  entrySnapshot: DecimalInput | null,
): Decimal | null {
  if (current === null || entrySnapshot === null) return null;
  const e = D(entrySnapshot);
  return e.lte(0) ? null : D(current).div(e).minus(1);
}

/** current EV/EBITDA minus entry EV/EBITDA; null when either side is null. */
export function multipleDelta(
  currentMultiple: Decimal | null,
  entryMultiple: Decimal | null,
): Decimal | null {
  if (currentMultiple === null || entryMultiple === null) return null;
  return currentMultiple.minus(entryMultiple);
}
