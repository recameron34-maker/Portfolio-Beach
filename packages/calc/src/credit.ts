import type { Decimal, DecimalInput } from './decimal.js';
import { D, Decimal as Dec, ONE } from './decimal.js';
import type { CashFlow } from './cashflows.js';
import type { IsoDate } from './dates.js';
import { addMonths, compareIso } from './dates.js';
import { xirr } from './irr.js';
import type { IrrResult } from './irr.js';
import type { CheckResult } from './rollforward.js';

/** Private credit metrics per docs/08 section 10. Rates are annual decimals. */

export interface CouponTerms {
  baseRate: DecimalInput | null;
  floor: DecimalInput | null;
  spread: DecimalInput;
}

/** All-in coupon = max(base rate, floor) + spread. Null when the base rate is missing. */
export function allInCoupon(terms: CouponTerms): Decimal | null {
  if (terms.baseRate === null) return null;
  const base = D(terms.baseRate);
  const floor = terms.floor === null ? base : D(terms.floor);
  return (base.gt(floor) ? base : floor).plus(D(terms.spread));
}

/** Annual cash interest / fair value. Null when fair value is not positive. */
export function currentYield(cashCoupon: DecimalInput, par: DecimalInput, fairValue: DecimalInput): Decimal | null {
  const fv = D(fairValue);
  if (fv.lte(0)) return null;
  return D(cashCoupon).times(D(par)).div(fv);
}

export type PaymentFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

const MONTHS: Record<PaymentFrequency, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

export interface YtmInput {
  asOf: IsoDate;
  fairValue: DecimalInput;
  par: DecimalInput;
  cashCoupon: DecimalInput;
  pikCoupon?: DecimalInput;
  maturity: IsoDate;
  frequency: PaymentFrequency;
  /** Scheduled principal repayments (positive amounts) on or before maturity. */
  scheduledPrincipal?: readonly { date: IsoDate; amount: DecimalInput }[];
}

export interface YtmResult {
  value: Decimal | null;
  irr: IrrResult | null;
  /** The contractual flows used, exposed for review screens and the cross-check. */
  flows: CashFlow[];
  /** Par at maturity after PIK capitalization and scheduled repayments. */
  parAtMaturity: Decimal | null;
}

/**
 * Yield to maturity: XIRR of {-fair value today, remaining cash interest and scheduled principal,
 * par plus capitalized PIK at maturity}. Payment dates are generated backwards from maturity.
 * PIK accrues into par each period and is paid at maturity. Null when maturity is not in the
 * future or fair value is not positive.
 */
export function yieldToMaturity(input: YtmInput): YtmResult {
  const fv = D(input.fairValue);
  if (fv.lte(0) || compareIso(input.maturity, input.asOf) <= 0) {
    return { value: null, irr: null, flows: [], parAtMaturity: null };
  }
  const months = MONTHS[input.frequency];
  const periodsPerYear = new Dec(12 / months);
  const cash = D(input.cashCoupon).div(periodsPerYear);
  const pik = D(input.pikCoupon ?? '0').div(periodsPerYear);

  const dates: IsoDate[] = [];
  for (let d = input.maturity; compareIso(d, input.asOf) > 0; d = addMonths(d, -months)) dates.push(d);
  dates.reverse();

  const principal = [...(input.scheduledPrincipal ?? [])].sort((a, b) => compareIso(a.date, b.date));
  let par = D(input.par);
  let principalIndex = 0;
  const flows: CashFlow[] = [{ date: input.asOf, amount: fv.neg() }];
  for (const date of dates) {
    const interest = par.times(cash);
    par = par.times(ONE.plus(pik));
    let repaid = new Dec(0);
    while (principalIndex < principal.length) {
      const p = principal[principalIndex];
      if (!p || compareIso(p.date, date) > 0) break;
      repaid = repaid.plus(D(p.amount).abs());
      principalIndex++;
    }
    if (repaid.gt(par)) repaid = par;
    par = par.minus(repaid);
    const isMaturity = compareIso(date, input.maturity) === 0;
    const amount = interest.plus(repaid).plus(isMaturity ? par : 0);
    flows.push({ date, amount });
  }
  const irr = xirr(flows);
  return { value: irr.value, irr, flows, parAtMaturity: par };
}

/** Cash interest received over the period / average funded amount. Null when nothing was funded. */
export function cashOnCash(cashInterestReceived: DecimalInput, averageFunded: DecimalInput): Decimal | null {
  const funded = D(averageFunded);
  return funded.lte(0) ? null : D(cashInterestReceived).div(funded);
}

/** EBITDA LTM / cash interest expense LTM at the borrower. Null when either is not positive. */
export function interestCoverage(ebitdaLtm: DecimalInput | null, cashInterestExpenseLtm: DecimalInput | null): Decimal | null {
  if (ebitdaLtm === null || cashInterestExpenseLtm === null) return null;
  const e = D(ebitdaLtm);
  const i = D(cashInterestExpenseLtm);
  return e.lte(0) || i.lte(0) ? null : e.div(i);
}

/** Net debt senior to and including the tranche / EBITDA LTM. Null when EBITDA is not positive. */
export function leverageThroughTranche(netDebtThroughTranche: DecimalInput, ebitdaLtm: DecimalInput | null): Decimal | null {
  if (ebitdaLtm === null) return null;
  const e = D(ebitdaLtm);
  return e.lte(0) ? null : D(netDebtThroughTranche).div(e);
}

/** Net debt through the tranche / enterprise value. Null when EV is not positive. */
export function loanToValue(netDebtThroughTranche: DecimalInput, enterpriseValue: DecimalInput | null): Decimal | null {
  if (enterpriseValue === null) return null;
  const ev = D(enterpriseValue);
  return ev.lte(0) ? null : D(netDebtThroughTranche).div(ev);
}

export interface DscrInput {
  ebitdaLtm: DecimalInput;
  cashTaxes: DecimalInput;
  maintenanceCapex: DecimalInput;
  cashInterestLtm: DecimalInput;
  scheduledPrincipalLtm: DecimalInput;
}

/** (EBITDA - cash taxes - maintenance capex) / (cash interest + scheduled principal). Null when debt service is not positive. */
export function dscr(input: DscrInput): Decimal | null {
  const service = D(input.cashInterestLtm).plus(D(input.scheduledPrincipalLtm));
  if (service.lte(0)) return null;
  return D(input.ebitdaLtm).minus(D(input.cashTaxes)).minus(D(input.maintenanceCapex)).div(service);
}

export interface ParRollForwardInput {
  beginPar: DecimalInput;
  fundings: DecimalInput;
  pikCapitalized: DecimalInput;
  principalRepaid: DecimalInput;
  endPar: DecimalInput;
}

/** begin + fundings + PIK capitalized - principal repaid = end within the tolerance. */
export function parRollForward(input: ParRollForwardInput, toleranceUsd: DecimalInput = '1'): CheckResult {
  const expected = D(input.beginPar).plus(D(input.fundings)).plus(D(input.pikCapitalized)).minus(D(input.principalRepaid));
  const difference = D(input.endPar).minus(expected);
  return { passed: difference.abs().lte(D(toleranceUsd)), difference };
}

/** Par after capitalizing PIK for one period: par x (1 + pik coupon / periods per year). Never below the starting par. */
export function capitalizePik(par: DecimalInput, pikCoupon: DecimalInput, frequency: PaymentFrequency): Decimal {
  const periodsPerYear = new Dec(12 / MONTHS[frequency]);
  return D(par).times(ONE.plus(D(pikCoupon).abs().div(periodsPerYear)));
}
