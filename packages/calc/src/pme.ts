import type { Decimal, DecimalInput } from './decimal.js';
import { CalcError, D, ONE, ZERO } from './decimal.js';
import type { CashFlow } from './cashflows.js';
import { normalizeFlows } from './cashflows.js';
import type { IsoDate } from './dates.js';
import { compareIso } from './dates.js';
import { xirr } from './irr.js';
import type { IrrResult } from './irr.js';

/** An index level series. Levels are looked up as the last level on or before the date (carry forward). */
export interface IndexPoint {
  date: IsoDate;
  level: DecimalInput;
}

export function indexLevelAt(series: readonly IndexPoint[], date: IsoDate): Decimal {
  let best: IndexPoint | null = null;
  for (const p of series) {
    if (compareIso(p.date, date) <= 0 && (best === null || compareIso(p.date, best.date) > 0)) best = p;
  }
  if (best === null) throw new CalcError(`no index level on or before ${date}`, 'index_missing');
  return D(best.level);
}

export interface PmeInput {
  /** Contributions negative, distributions positive. The terminal NAV is passed separately. */
  flows: readonly CashFlow[];
  nav: DecimalInput;
  navDate: IsoDate;
  index: readonly IndexPoint[];
}

/** Kaplan-Schoar PME: (sum of distributions compounded with the index to the end + NAV) / (contributions compounded the same way). */
export function ksPme(input: PmeInput): Decimal | null {
  const endLevel = indexLevelAt(input.index, input.navDate);
  let contributions = ZERO;
  let distributions = ZERO;
  for (const f of normalizeFlows(input.flows)) {
    const factor = endLevel.div(indexLevelAt(input.index, f.date));
    if (f.amount.isNegative()) contributions = contributions.plus(f.amount.abs().times(factor));
    else distributions = distributions.plus(f.amount.times(factor));
  }
  if (contributions.isZero()) return null;
  return distributions.plus(D(input.nav)).div(contributions);
}

export interface DirectAlphaResult {
  /** Continuously compounded alpha: ln(1 + irr of index-adjusted flows). */
  value: Decimal | null;
  irr: IrrResult;
}

/** Direct Alpha: IRR of flows scaled by index_end / index_t (NAV unscaled), expressed as ln(1 + irr). */
export function directAlpha(input: PmeInput): DirectAlphaResult {
  const endLevel = indexLevelAt(input.index, input.navDate);
  const adjusted: CashFlow[] = normalizeFlows(input.flows).map((f) => ({
    date: f.date,
    amount: f.amount.times(endLevel.div(indexLevelAt(input.index, f.date))),
  }));
  adjusted.push({ date: input.navDate, amount: D(input.nav) });
  const irr = xirr(adjusted);
  const value = irr.value === null ? null : ONE.plus(irr.value).ln();
  return { value, irr };
}
