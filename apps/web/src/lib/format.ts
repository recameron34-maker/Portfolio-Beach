import brand from '../../../../config/brand.json';

/** Display rules from docs/06 section 3. Inputs are decimal strings or null; null renders the missing placeholder. */
export const MISSING: string = brand.missingValue;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function roundHalfAwayFromZero(value: number, places: number): number {
  const factor = 10 ** places;
  const scaled = Math.abs(value) * factor;
  const rounded = Math.floor(scaled + 0.5) / factor;
  return value < 0 ? -rounded : rounded;
}

function withGrouping(value: number, places: number): string {
  const fixed = roundHalfAwayFromZero(value, places).toFixed(places);
  const [whole, frac] = fixed.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/** Dollars as $M with one decimal: 12,345,678.90 -> "$12.3M". */
export function formatMoneyM(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const n = Number(value);
  if (!Number.isFinite(n)) return MISSING;
  const millions = n / 1_000_000;
  const sign = millions < 0 ? '-' : '';
  return `${sign}$${withGrouping(Math.abs(millions), 1)}M`;
}

/** MOIC with two decimals and an "x". */
export function formatMoic(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const n = Number(value);
  return Number.isFinite(n) ? `${withGrouping(n, 2)}x` : MISSING;
}

/** Multiples (EV/EBITDA, leverage, coverage) with one decimal and an "x". */
export function formatMultiple(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const n = Number(value);
  return Number.isFinite(n) ? `${withGrouping(n, 1)}x` : MISSING;
}

/** Rates as percentages: IRR one decimal; yields and spreads two decimals (docs/06). */
export function formatPct(value: string | null | undefined, places = 1): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const n = Number(value);
  return Number.isFinite(n) ? `${withGrouping(n * 100, places)}%` : MISSING;
}

/** "Jan 15, 2026" from an ISO date, with no time zone involved. */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return MISSING;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return MISSING;
  return `${MONTHS[Number(m[2]) - 1] ?? '?'} ${Number(m[3])}, ${m[1]}`;
}

/** "January 2026" for investment dates. */
export function formatMonthYear(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return MISSING;
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
  if (!m) return MISSING;
  const long = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${long[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
}

/** Taxonomy codes ("deal_type.co_invest_equity") to labels for display. */
export function labelOf(code: string | null | undefined): string {
  if (code === null || code === undefined) return MISSING;
  const tail = code.includes('.') ? code.slice(code.indexOf('.') + 1) : code;
  const words = tail.split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** IRR display per docs/06 and docs/08: short holds and multiple roots show NM, never a misleading number. */
export function irrDisplay(row: { grossIrr: string | null; irrFlag: string | null }): string {
  if (row.irrFlag === 'short_period' || row.irrFlag === 'multiple_irr') return 'NM';
  return formatPct(row.grossIrr);
}
