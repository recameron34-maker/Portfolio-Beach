import { CalcError } from './decimal.js';

/**
 * Calendar dates as ISO strings (YYYY-MM-DD). All arithmetic is done on day numbers computed from
 * the civil calendar, so no JS Date or time zone is ever involved (docs/03 section 1).
 */
export type IsoDate = string;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export function parseIso(iso: IsoDate): CivilDate {
  const m = ISO.exec(iso);
  if (!m) throw new CalcError(`invalid ISO date: ${iso}`, 'invalid_date');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new CalcError(`invalid calendar date: ${iso}`, 'invalid_date');
  }
  return { year, month, day };
}

export function formatIso(d: CivilDate): IsoDate {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${String(d.year).padStart(4, '0')}-${mm}-${dd}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  const table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) return 29;
  return table[month - 1] ?? 31;
}

/** Days since 1970-01-01 (Howard Hinnant's days_from_civil). */
export function toDayNumber(iso: IsoDate): number {
  const { year, month, day } = parseIso(iso);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDayNumber(dayNumber: number): IsoDate {
  const z = dayNumber + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return formatIso({ year: month <= 2 ? y + 1 : y, month, day });
}

/** b minus a in whole days (negative when b is earlier). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toDayNumber(b) - toDayNumber(a);
}

export function compareIso(a: IsoDate, b: IsoDate): number {
  return toDayNumber(a) - toDayNumber(b);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(iso) + days);
}

/** Adds calendar months, clamping the day to the end of the target month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso: IsoDate, months: number): IsoDate {
  const d = parseIso(iso);
  const index = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const day = Math.min(d.day, daysInMonth(year, month));
  return formatIso({ year, month, day });
}

export function addYears(iso: IsoDate, years: number): IsoDate {
  return addMonths(iso, years * 12);
}

/** Calendar quarter (1 to 4) of a date. Fiscal calendars that differ are mapped before calling calc. */
export function quarterOf(iso: IsoDate): number {
  return Math.floor((parseIso(iso).month - 1) / 3) + 1;
}

export function yearOf(iso: IsoDate): number {
  return parseIso(iso).year;
}
