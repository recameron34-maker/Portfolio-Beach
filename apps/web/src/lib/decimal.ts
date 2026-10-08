import { formatMoneyM } from './format.js';

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Exact sum of decimal strings as a decimal string with as many places as the widest input.
 * Money never goes through floats (docs/17 section 4); null when no input is a usable number.
 */
export function sumDecimals(values: readonly (string | null | undefined)[]): string | null {
  const parts = values.filter((v): v is string => typeof v === 'string' && DECIMAL.test(v));
  if (parts.length === 0) return null;
  let scale = 0;
  for (const p of parts) scale = Math.max(scale, p.split('.')[1]?.length ?? 0);
  let total = 0n;
  for (const p of parts) {
    const negative = p.startsWith('-');
    const [whole = '0', frac = ''] = (negative ? p.slice(1) : p).split('.');
    const scaled = BigInt(whole + frac.padEnd(scale, '0'));
    total += negative ? -scaled : scaled;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${body}` : body;
}

/**
 * $M label for a number the chart kit hands back (axis tooltips and table twins). The number is
 * the API's decimal string passed through Number for geometry, never the result of arithmetic.
 */
export function moneyLabel(value: number): string {
  return formatMoneyM(value.toFixed(2));
}
