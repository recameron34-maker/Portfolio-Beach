import { Decimal as DecimalBase } from 'decimal.js';

/**
 * A private Decimal constructor so the library's precision and rounding never depend on, or
 * change, the global decimal.js configuration of a consumer (docs/17 section 4).
 */
export const Decimal = DecimalBase.clone({
  precision: 34,
  rounding: DecimalBase.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30,
});
export type Decimal = DecimalBase;

/** Money, rates and multiples enter as strings or Decimals. JS numbers are rejected on purpose. */
export type DecimalInput = string | DecimalBase;

export class CalcError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'CalcError';
  }
}

export function D(value: DecimalInput): Decimal {
  if (typeof value === 'number') {
    throw new CalcError(
      'JS numbers are not accepted for money or rates; pass a string',
      'number_input',
    );
  }
  const d = new Decimal(value);
  if (!d.isFinite()) throw new CalcError(`not a finite decimal: ${String(value)}`, 'not_finite');
  return d;
}

/**
 * A result as the API contract's decimal string: rounded half up to ten places with this
 * library's settings, never an exponent, trailing zeros dropped ("0.2", not "0.2000000000");
 * null stays null, the missing placeholder (docs/06 section 3). The one rendering the API and the
 * preview simulation share.
 */
export function toDecimalString(value: Decimal | null): string | null {
  return value === null ? null : value.toFixed(10).replace(/\.?0+$/, '');
}

export function isZero(value: Decimal): boolean {
  return value.isZero();
}

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
