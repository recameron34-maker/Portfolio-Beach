import type { Decimal, DecimalInput } from './decimal.js';
import { CalcError, D, ONE, ZERO } from './decimal.js';

export interface TakahashiAlexanderParams {
  commitment: DecimalInput;
  /** Rate of contribution per year; either one rate for every year or one per year of the horizon. */
  rateOfContribution: DecimalInput | readonly DecimalInput[];
  /** Expected fund life in years (L). */
  life: number;
  /** Bow factor (B) that shapes the distribution curve. */
  bow: DecimalInput;
  /** Annual growth of NAV (G). */
  growth: DecimalInput;
  /** Minimum distribution yield (Y). */
  yield: DecimalInput;
  /** Number of years to project. */
  years: number;
}

export interface LiquidityYear {
  year: number;
  contribution: Decimal;
  distribution: Decimal;
  nav: Decimal;
  unfunded: Decimal;
}

/**
 * Takahashi-Alexander (Yale) cash flow model per docs/08 section 8:
 * C_t = RC_t x unfunded_{t-1}; D_t = RD_t x NAV_{t-1} x (1 + G), RD_t = max(Y, (t / L)^B);
 * NAV_t = NAV_{t-1} x (1 + G) + C_t - D_t.
 */
export function takahashiAlexander(params: TakahashiAlexanderParams): LiquidityYear[] {
  if (params.years < 1 || params.life <= 0) throw new CalcError('years and life must be positive', 'invalid_params');
  const rates = Array.isArray(params.rateOfContribution)
    ? params.rateOfContribution.map((r) => D(r))
    : null;
  const singleRate = rates === null ? D(params.rateOfContribution as DecimalInput) : null;
  const bow = D(params.bow);
  const growth = D(params.growth);
  const minYield = D(params.yield);
  const life = D(String(params.life));

  let unfunded = D(params.commitment);
  let nav = ZERO;
  const out: LiquidityYear[] = [];
  for (let t = 1; t <= params.years; t++) {
    const rc = rates === null ? (singleRate ?? ZERO) : (rates[t - 1] ?? rates[rates.length - 1] ?? ZERO);
    const contribution = rc.times(unfunded);
    const grown = nav.times(ONE.plus(growth));
    const rdCurve = D(String(t)).div(life).pow(bow);
    const rd = rdCurve.gt(minYield) ? rdCurve : minYield;
    const distribution = rd.gt(1) ? grown : rd.times(grown);
    nav = grown.plus(contribution).minus(distribution);
    unfunded = unfunded.minus(contribution);
    out.push({ year: t, contribution, distribution, nav, unfunded });
  }
  return out;
}
