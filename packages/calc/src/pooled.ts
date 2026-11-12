import type { CashFlow } from './cashflows.js';
import type { IsoDate } from './dates.js';
import type { Decimal, DecimalInput } from './decimal.js';
import { D, toDecimalString } from './decimal.js';
import type { IrrReason } from './irr.js';
import { xirr } from './irr.js';
import { dpi, moic, rvpi, tvpi } from './multiples.js';

/*
 * Pooled gross returns over a set of positions (docs/08 sections 2 and 3): the one rule behind
 * every pooled view (a vehicle, a sponsor, a client slice, the whole portfolio, an entry metric
 * cohort). The caller sums what it holds (typed flows on the server, travelling rows in a page);
 * the multiples, the terminal flow and the IRR with its flag are decided here.
 */

/** Why an IRR is missing, or that its period is short (docs/08 section 3); null for a plain rate. */
export type IrrFlag = 'short_period' | 'no_valuation' | IrrReason | null;

/**
 * The gross IRR over signed flows that already end in the NAV, and its flag. While something
 * still held has no Locked mark the NAV is not calculable, and an IRR without it would be an
 * invented number, so there is none (`no_valuation`).
 */
export function flaggedIrr(
  signed: readonly CashFlow[],
  navCalculable: boolean,
): { grossIrr: Decimal | null; irrFlag: IrrFlag } {
  if (!navCalculable) return { grossIrr: null, irrFlag: 'no_valuation' };
  const irr = signed.length >= 2 ? xirr(signed) : null;
  if (irr === null) return { grossIrr: null, irrFlag: 'insufficient_flows' };
  if (irr.value === null) return { grossIrr: null, irrFlag: irr.reason };
  return { grossIrr: irr.value, irrFlag: irr.shortPeriod ? 'short_period' : null };
}

/** What a pool sums before its returns are worked out. */
export interface PoolTotals {
  /** How many positions are pooled; a pool of none has no figure at all. */
  count: number;
  /** The contributions paid in, as a positive sum. Fees and expenses are not invested capital. */
  contributions: DecimalInput;
  /** The distributions, interest, principal and recallable distributions received. */
  distributions: DecimalInput;
  /** The NAV of the positions still held; null while one of them has no Locked mark. */
  nav: DecimalInput | null;
  /** Every pooled flow on or before the as-of date, signed (fees included), without the NAV. */
  flows: readonly CashFlow[];
  asOf: IsoDate;
}

export interface PooledReturns {
  count: number;
  invested: Decimal | null;
  distributions: Decimal | null;
  nav: Decimal | null;
  dpi: Decimal | null;
  rvpi: Decimal | null;
  tvpi: Decimal | null;
  grossMoic: Decimal | null;
  grossIrr: Decimal | null;
  irrFlag: IrrFlag;
}

/**
 * Pooled returns: the multiples over the sums, and the IRR over the pooled flows with the summed
 * NAV as the terminal flow on the as-of date (a NAV of zero adds none: realized positions hold
 * nothing). Pooled flows can change sign more than once, so the IRR flag matters.
 *
 * A pool of no position has nothing to pool: every figure is null, never 0, and the flag says
 * why. A NAV that is not calculable leaves RVPI, TVPI, MOIC and the IRR not calculable too:
 * counting the unmarked position as 0 would understate NAV and invent the rest.
 */
export function pooledReturns(totals: PoolTotals): PooledReturns {
  if (totals.count === 0) {
    return {
      count: 0,
      invested: null,
      distributions: null,
      nav: null,
      dpi: null,
      rvpi: null,
      tvpi: null,
      grossMoic: null,
      grossIrr: null,
      irrFlag: 'insufficient_flows',
    };
  }
  const contributions = D(totals.contributions);
  const distributions = D(totals.distributions);
  const invested = contributions.isZero() ? null : contributions;
  const nav = totals.nav === null ? null : D(totals.nav);
  const signed = [...totals.flows];
  if (nav !== null && !nav.isZero()) signed.push({ date: totals.asOf, amount: nav.toFixed(2) });
  return {
    count: totals.count,
    invested,
    distributions: invested === null ? null : distributions,
    nav,
    dpi: invested === null ? null : dpi(distributions, invested),
    rvpi: invested === null || nav === null ? null : rvpi(nav, invested),
    tvpi: invested === null || nav === null ? null : tvpi(distributions, nav, invested),
    grossMoic: invested === null || nav === null ? null : moic(distributions, nav, invested),
    ...flaggedIrr(signed, nav !== null),
  };
}

/** Pooled returns as they travel (docs/08 section 1): every figure a decimal string, null stays null. */
export interface PooledFigures {
  count: number;
  invested: string | null;
  distributions: string | null;
  nav: string | null;
  dpi: string | null;
  rvpi: string | null;
  tvpi: string | null;
  grossMoic: string | null;
  grossIrr: string | null;
  irrFlag: IrrFlag;
}

export function pooledFigures(pooled: PooledReturns): PooledFigures {
  return {
    count: pooled.count,
    invested: toDecimalString(pooled.invested),
    distributions: toDecimalString(pooled.distributions),
    nav: toDecimalString(pooled.nav),
    dpi: toDecimalString(pooled.dpi),
    rvpi: toDecimalString(pooled.rvpi),
    tvpi: toDecimalString(pooled.tvpi),
    grossMoic: toDecimalString(pooled.grossMoic),
    grossIrr: toDecimalString(pooled.grossIrr),
    irrFlag: pooled.irrFlag,
  };
}
