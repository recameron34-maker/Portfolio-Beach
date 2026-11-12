import { isCalendarDate } from '@pb/calc';

/*
 * Date text helpers for the models. Everything is text in, text out: nothing here reads a clock
 * (the package is a domain package under the lint rules of docs/17 section 4). Whether a string
 * names a day or a quarter end is @pb/calc's call (isCalendarDate, isQuarterEnd), as everywhere.
 */

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
