/* Calendar dates in sentences (docs/06 section 3), on ISO strings: no JS Date (docs/17 section 4). */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An ISO date for sentences: "2025-03-31" -> "Mar 31, 2025" (report commentary, notice notes). */
export function fmtDate(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? '?'} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}
