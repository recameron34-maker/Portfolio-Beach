import { daysInMonth } from '@pb/calc';

/*
 * Date text helpers for the models and validators. Everything is text in, text out: nothing here
 * reads a clock (the package is a domain package under the lint rules of docs/17 section 4).
 */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in ISO form (year, month and day all within range), with no date arithmetic. */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/** True when an ISO date is the last day of a calendar quarter (March, June, September or December). */
export function isQuarterEnd(value: string): boolean {
  if (!isCalendarDate(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return month % 3 === 0 && day === daysInMonth(year, month);
}

export const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const MONTH_DAY_YEAR = new RegExp(
  `\\b(${MONTH_NAMES.join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`,
  'i',
);

/**
 * The ISO date of the first "Month D, YYYY" in a text ("June 30, 2025" gives 2025-06-30), or null
 * when there is none or it is not a real day.
 */
export function parseMonthDayYear(text: string): string | null {
  const match = MONTH_DAY_YEAR.exec(text);
  if (match === null) return null;
  const [, monthName = '', day = '', year = ''] = match;
  const month = MONTH_NAMES.indexOf(monthName.toLowerCase() as (typeof MONTH_NAMES)[number]) + 1;
  const iso = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isCalendarDate(iso) ? iso : null;
}
