import { D } from '@pb/calc';

/*
 * Figures in API-written sentences (weekly report commentary, monitoring flags), the way docs/06
 * section 3 writes them: money as $M with one decimal, multiples with two, percentages with one.
 * Dates go through fmtDate (common/dates.ts). Values arrive as decimal strings, never JS numbers.
 */

const group = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Dollars as $M with one decimal from a decimal string: "390009856.77" -> "$390.0M". */
export function fmtMoneyM(value: string): string {
  const millions = D(value).div('1000000');
  const [whole, frac] = millions.abs().toFixed(1).split('.');
  return `${millions.isNegative() ? '-' : ''}$${group(whole ?? '0')}.${frac ?? '0'}M`;
}

export const fmtMoic = (value: string): string => `${D(value).toFixed(2)}x`;

/** Percentage with one decimal: "0.0530" -> "5.3%". */
export const fmtPct = (value: string): string => `${D(value).mul('100').toFixed(1)}%`;

/** Signed percentage with one decimal for changes: "0.1234" -> "+12.3%". */
export function fmtSignedPct(value: string): string {
  const pct = D(value).mul('100');
  return `${pct.isNegative() ? '-' : '+'}${pct.abs().toFixed(1)}%`;
}

export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

export const joinList = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
