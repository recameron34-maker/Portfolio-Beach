import type { Decimal, DecimalInput } from './decimal.js';
import { CalcError, D } from './decimal.js';

export type MoneyUnit = 'USD' | 'USD_K' | 'USD_M' | 'USD_B';

const FACTORS: Record<MoneyUnit, string> = {
  USD: '1',
  USD_K: '1000',
  USD_M: '1000000',
  USD_B: '1000000000',
};

export function isMoneyUnit(unit: string): unit is MoneyUnit {
  return Object.prototype.hasOwnProperty.call(FACTORS, unit);
}

/** Converts a declared-unit value to dollars. Any unknown unit throws (docs/08 section 6). */
export function toDollars(value: DecimalInput, unit: string): Decimal {
  if (!isMoneyUnit(unit)) throw new CalcError(`unknown money unit: ${unit}`, 'unknown_unit');
  return D(value).times(FACTORS[unit]);
}

export interface SanityBounds {
  min: DecimalInput;
  max: DecimalInput;
}

/** True when a converted dollar value falls outside the configured bounds (catches millions entered as dollars). */
export function unitSanityFlag(dollars: DecimalInput, bounds: SanityBounds): boolean {
  const v = D(dollars).abs();
  return v.lt(D(bounds.min)) || v.gt(D(bounds.max));
}
