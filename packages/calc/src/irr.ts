import type { Decimal } from './decimal.js';
import { Decimal as Dec, ONE, ZERO } from './decimal.js';
import type { CashFlow, DatedAmount } from './cashflows.js';
import { normalizeFlows } from './cashflows.js';
import { daysBetween } from './dates.js';

export type IrrReason =
  'insufficient_flows' | 'same_sign' | 'no_root' | 'multiple_irr' | 'no_convergence';

/** A rate, or no rate and always the reason why: never a misleading number. */
export type IrrResult =
  | {
      /** Annualized rate as a decimal (0.125 = 12.5%). */
      value: Decimal;
      reason?: undefined;
      /** True when the span from first to last flow is under one year (docs/08 section 3). */
      shortPeriod: boolean;
      iterations: number;
    }
  | { value: null; reason: IrrReason; shortPeriod: boolean; iterations: number };

export interface IrrOptions {
  /** Day count basis: 365 (default) or 365.25. */
  dayCountBasis?: 365 | 365.25;
  /** Newton-Raphson starting rate. */
  initialGuess?: string;
  /** Absolute NPV tolerance. */
  tolerance?: string;
  maxIterations?: number;
}

const BRACKET_LO = new Dec('-0.9999');
const BRACKET_HI = new Dec('100');

interface Prepared {
  amounts: Decimal[];
  /** Exponents in years from the first flow. */
  years: Decimal[];
}

function prepare(flows: readonly DatedAmount[], basis: Decimal): Prepared {
  const first = flows[0];
  if (!first) throw new Error('unreachable: flows checked before prepare');
  return {
    amounts: flows.map((f) => f.amount),
    years: flows.map((f) => new Dec(daysBetween(first.date, f.date)).div(basis)),
  };
}

/** NPV at a rate. ln(1 + r) is taken once; each term is amount x exp(-t x ln(1 + r)), which is the same value as (1 + r)^(-t) and several times faster at 34 digits. */
export function npvAt(prepared: Prepared, rate: Decimal): Decimal {
  const lnBase = ONE.plus(rate).ln();
  let total = ZERO;
  for (let i = 0; i < prepared.amounts.length; i++) {
    const amount = prepared.amounts[i];
    const t = prepared.years[i];
    if (amount === undefined || t === undefined) continue;
    total = total.plus(amount.times(t.times(lnBase).neg().exp()));
  }
  return total;
}

function dNpvAt(prepared: Prepared, rate: Decimal): Decimal {
  const lnBase = ONE.plus(rate).ln();
  let total = ZERO;
  for (let i = 0; i < prepared.amounts.length; i++) {
    const amount = prepared.amounts[i];
    const t = prepared.years[i];
    if (amount === undefined || t === undefined) continue;
    total = total.minus(t.times(amount).times(t.plus(ONE).times(lnBase).neg().exp()));
  }
  return total;
}

function signChanges(amounts: readonly Decimal[]): number {
  let changes = 0;
  let last: 1 | -1 | 0 = 0;
  for (const a of amounts) {
    if (a.isZero()) continue;
    const sign = a.isNegative() ? -1 : 1;
    if (last !== 0 && sign !== last) changes++;
    last = sign;
  }
  return changes;
}

/**
 * Scans the bracket for sign changes of NPV. The grid is dense near zero (where realistic IRRs
 * live) and coarser toward the top of the bracket. Returns the sub-brackets found.
 *
 * The scan runs in floating point on purpose: it only locates where NPV changes sign, and every
 * reported rate is then solved in exact decimals inside that bracket. Nothing from this scan is
 * ever returned as a value.
 */
function scanBrackets(prepared: Prepared): [Decimal, Decimal][] {
  const amounts = prepared.amounts.map((a) => a.toNumber());
  const years = prepared.years.map((t) => t.toNumber());
  const npvFloat = (rate: number): number => {
    let total = 0;
    for (let i = 0; i < amounts.length; i++)
      total += (amounts[i] ?? 0) * Math.pow(1 + rate, -(years[i] ?? 0));
    return total;
  };
  const points: number[] = [];
  // -0.9999 .. 2.0 in steps of 0.001, then 2.25 .. 100 in steps of 0.25.
  for (let i = 0; i <= 3000; i++) points.push(-0.9999 + i * 0.001);
  for (let r = 2.25; r <= 100; r += 0.25) points.push(r);
  const brackets: [Decimal, Decimal][] = [];
  let prevPoint: number | null = null;
  let prevSign: 1 | -1 | 0 = 0;
  for (const p of points) {
    const v = npvFloat(p);
    const sign: 1 | -1 | 0 = v === 0 ? 0 : v < 0 ? -1 : 1;
    if (prevPoint !== null && sign !== 0 && prevSign !== 0 && sign !== prevSign) {
      brackets.push([new Dec(prevPoint.toFixed(6)), new Dec(p.toFixed(6))]);
    }
    if (sign !== 0) prevSign = sign;
    prevPoint = p;
  }
  return brackets;
}

function bisect(
  prepared: Prepared,
  lo: Decimal,
  hi: Decimal,
  tolerance: Decimal,
  maxIterations: number,
): { value: Decimal | null; iterations: number } {
  let fLo = npvAt(prepared, lo);
  let a = lo;
  let b = hi;
  for (let i = 1; i <= maxIterations; i++) {
    const mid = a.plus(b).div(2);
    const fMid = npvAt(prepared, mid);
    if (fMid.abs().lte(tolerance) || b.minus(a).abs().lt('1e-18')) {
      return { value: mid, iterations: i };
    }
    if (fMid.isNegative() === fLo.isNegative()) {
      a = mid;
      fLo = fMid;
    } else {
      b = mid;
    }
  }
  return { value: null, iterations: maxIterations };
}

/**
 * XIRR per docs/08 section 3: Newton-Raphson from the initial guess with a bisection fallback on
 * [-0.9999, 100]. Returns null (with a reason) rather than a misleading number.
 */
export function xirr(flows: readonly CashFlow[], options: IrrOptions = {}): IrrResult {
  const basis = new Dec(options.dayCountBasis ?? 365);
  const tolerance = new Dec(options.tolerance ?? '1e-10');
  const maxIterations = options.maxIterations ?? 200;
  const sorted = normalizeFlows(flows);

  if (sorted.length < 2) {
    return { value: null, reason: 'insufficient_flows', shortPeriod: false, iterations: 0 };
  }
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) throw new Error('unreachable');
  const shortPeriod = daysBetween(first.date, last.date) < 365;

  const amounts = sorted.map((f) => f.amount);
  const hasNegative = amounts.some((a) => a.isNegative());
  const hasPositive = amounts.some((a) => a.gt(0));
  if (!hasNegative || !hasPositive) {
    return { value: null, reason: 'same_sign', shortPeriod, iterations: 0 };
  }

  const prepared = prepare(sorted, basis);

  // Descartes: with more than one sign change there may be several roots. Check before solving.
  if (signChanges(amounts) > 1) {
    const brackets = scanBrackets(prepared);
    if (brackets.length > 1) {
      return { value: null, reason: 'multiple_irr', shortPeriod, iterations: 0 };
    }
    if (brackets.length === 0) {
      return { value: null, reason: 'no_root', shortPeriod, iterations: 0 };
    }
    const only = brackets[0];
    if (!only) throw new Error('unreachable');
    const b = bisect(prepared, only[0], only[1], tolerance, maxIterations);
    return b.value === null
      ? { value: null, reason: 'no_convergence', shortPeriod, iterations: b.iterations }
      : { value: b.value, shortPeriod, iterations: b.iterations };
  }

  // Newton-Raphson.
  let rate = new Dec(options.initialGuess ?? '0.1');
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations++;
    const f = npvAt(prepared, rate);
    if (f.abs().lte(tolerance)) {
      return { value: rate, shortPeriod, iterations };
    }
    const df = dNpvAt(prepared, rate);
    if (df.isZero()) break;
    const next = rate.minus(f.div(df));
    if (next.lte(BRACKET_LO) || next.gt(BRACKET_HI) || !next.isFinite()) break;
    if (next.minus(rate).abs().lt('1e-18')) {
      rate = next;
      const check = npvAt(prepared, rate);
      if (check.abs().lte(tolerance)) return { value: rate, shortPeriod, iterations };
      break;
    }
    rate = next;
  }
  // Newton stalled, left the bracket or ran out of iterations: bisection takes over.

  // Bisection fallback over the whole bracket, or over the single sign-change sub-bracket.
  const lo = BRACKET_LO;
  const hi = BRACKET_HI;
  const fLo = npvAt(prepared, lo);
  const fHi = npvAt(prepared, hi);
  let bracket: [Decimal, Decimal] | null = null;
  if (fLo.isNegative() !== fHi.isNegative()) {
    bracket = [lo, hi];
  } else {
    const found = scanBrackets(prepared);
    if (found.length === 1) bracket = found[0] ?? null;
    else if (found.length > 1) {
      return { value: null, reason: 'multiple_irr', shortPeriod, iterations };
    }
  }
  if (bracket === null) {
    return { value: null, reason: 'no_root', shortPeriod, iterations };
  }
  const b = bisect(prepared, bracket[0], bracket[1], tolerance, maxIterations);
  const total = iterations + b.iterations;
  return b.value === null
    ? { value: null, reason: 'no_convergence', shortPeriod, iterations: total }
    : { value: b.value, shortPeriod, iterations: total };
}

/** NPV of flows at a given annual rate, exposed for tests and the Python cross-check. */
export function npv(
  flows: readonly CashFlow[],
  rate: Decimal,
  dayCountBasis: 365 | 365.25 = 365,
): Decimal {
  const sorted = normalizeFlows(flows);
  if (sorted.length === 0) return ZERO;
  return npvAt(prepare(sorted, new Dec(dayCountBasis)), rate);
}
