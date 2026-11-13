import { DECIMAL_PATTERN } from '@pb/contracts';
import brand from '../../../../config/brand.json';

/** Display rules from docs/06 section 3. Inputs are decimal strings or null; null renders the missing placeholder. */
export const MISSING: string = brand.missingValue;

/**
 * A formatted figure with its sign in front: "+$5.0M", "-7.2%". One that rounds to nothing
 * carries none ("+0.0%" would claim a direction the figure does not show), and the placeholder
 * stays the placeholder. Every signed figure on a page goes through here, so one page has one rule.
 */
export function withSign(text: string): string {
  if (text === MISSING) return text;
  if (!/[1-9]/.test(text)) return text.replace(/^-/, '');
  return text.startsWith('-') ? text : `+${text}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function roundHalfAwayFromZero(value: number, places: number): number {
  const factor = 10 ** places;
  const scaled = Math.abs(value) * factor;
  const rounded = Math.floor(scaled + 0.5) / factor;
  return value < 0 ? -rounded : rounded;
}

/**
 * A whole number's digits in groups of three: "1234567" is "1,234,567", a minus sign stays in
 * front. Text that is not a whole number (an exponent, say) is returned as it came. Built in one
 * pass over the digits, so the time taken grows with their number and no faster.
 */
export function groupThousands(whole: string): string {
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = whole.slice(sign.length);
  if (!/^\d+$/.test(digits)) return whole;
  let grouped = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
    grouped += digits.charAt(i);
  }
  return sign + grouped;
}

function withGrouping(value: number, places: number): string {
  const fixed = roundHalfAwayFromZero(value, places).toFixed(places);
  const [whole, frac] = fixed.split('.');
  const grouped = groupThousands(whole ?? '0');
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

/**
 * formatMoneyM for an amount in its own currency: dollars as they are, any other currency with
 * its code in place of the dollar sign ("EUR 2.5M"). The figure is never converted.
 */
export function formatMoneyMIn(value: string | null | undefined, currency: string): string {
  const text = formatMoneyM(value);
  return currency === 'USD' || text === MISSING ? text : text.replaceAll('$', `${currency} `);
}

/**
 * $M label for a number the chart kit hands back (axis tooltips and table twins). The number is
 * the API's decimal string passed through Number for geometry, never the result of arithmetic.
 */
export function moneyLabel(value: number): string {
  return formatMoneyM(value.toFixed(2));
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

/**
 * "Jun 2025" for chart axes, where full month names run into each other at phone width. The
 * missing placeholder for anything that is not an ISO date with a real month.
 */
export function formatMonthYearShort(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return MISSING;
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
  const month = m === null ? undefined : MONTHS[Number(m[2]) - 1];
  return m === null || month === undefined ? MISSING : `${month} ${m[1]}`;
}

/**
 * "Q2 2025" from a quarter-end date ("2025-06-30"): the calendar quarter it falls in. Short enough
 * that every tick of a quarterly chart stays readable at phone width; the missing placeholder when
 * the value is not an ISO date with a real month.
 */
export function formatQuarter(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return MISSING;
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
  const month = Number(m?.[2]);
  if (m === null || !(month >= 1 && month <= 12)) return MISSING;
  return `Q${Math.ceil(month / 3)} ${m[1]}`;
}

/** "2.0 years" from the API's holding period in years (docs/08 section 2); the missing placeholder for null. */
export function formatYears(value: string | null | undefined): string {
  if (value === null || value === undefined || !DECIMAL_PATTERN.test(value)) return MISSING;
  return `${Number(value).toFixed(1)} years`;
}

/** "1 quarter", "3 quarters": a count with its noun, plural by adding s. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "A", "A and B", "A, B and C". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Labels from GET /api/v1/taxonomy, registered once by the app shell (useTaxonomyLabels). */
const TAXONOMY_LABELS = new Map<string, string>();

export function registerTaxonomyLabels(terms: Iterable<{ code: string; label: string }>): void {
  for (const t of terms) TAXONOMY_LABELS.set(t.code, t.label);
}

/** Test helper: forget the registered labels. */
export function clearTaxonomyLabels(): void {
  TAXONOMY_LABELS.clear();
}

/**
 * Taxonomy codes ("deal_type.co_invest_equity") to labels for display: the taxonomy's own label
 * when the shell has loaded it, otherwise one generated from the code.
 */
export function labelOf(code: string | null | undefined): string {
  if (code === null || code === undefined) return MISSING;
  const known = TAXONOMY_LABELS.get(code);
  if (known !== undefined) return known;
  const tail = code.includes('.') ? code.slice(code.indexOf('.') + 1) : code;
  const words = tail.split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** IRR display per docs/06 and docs/08: short holds and multiple roots show NM, never a misleading number. */
export function irrDisplay(row: { grossIrr: string | null; irrFlag: string | null }): string {
  if (row.irrFlag === 'short_period' || row.irrFlag === 'multiple_irr') return 'NM';
  return formatPct(row.grossIrr);
}

/** "2025-06-30T12:00:00.000Z" to "Jun 30, 2025 12:00:00 UTC" through formatDate; the raw text when not ISO. */
export function formatDateTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  if (m === null) return iso;
  return `${formatDate(m[1] ?? '')} ${m[2] ?? ''} UTC`;
}
