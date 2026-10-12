/**
 * The template signature of an operations workbook (docs/04 M2, the ops-drop import): its sheet
 * names and the header row of one sheet, in one canonical text the caller hashes (node crypto
 * in the API, SubtleCrypto in the browser). The package itself hashes nothing.
 */
import { WorkbookError } from './errors.js';
import type { Workbook } from './read.js';

/** Separates sheet names in the canonical text (ASCII record separator). */
export const TEMPLATE_RECORD_SEPARATOR = '\u001e';
/** Separates the sheet names from the header, and the header cells from each other (ASCII unit separator). */
export const TEMPLATE_UNIT_SEPARATOR = '\u001f';

export interface TemplateKey {
  /** Every sheet name, in workbook order. */
  sheets: string[];
  /** The cells of the header sheet's first row, as read. */
  header: string[];
  /** `sheets` joined by the record separator, the unit separator, then `header` joined by the unit separator. */
  canonical: string;
}

/** Refuses, with a `WorkbookError`, when the workbook has no sheet of that name. */
export function templateKey(workbook: Workbook, headerSheet: string): TemplateKey {
  const sheets = workbook.sheets.map((s) => s.name);
  const sheet = workbook.sheets.find((s) => s.name === headerSheet);
  if (!sheet) {
    throw new WorkbookError(`The workbook has no sheet named ${headerSheet}`, 'missing_part');
  }
  const header = [...(sheet.rows[0] ?? [])];
  const canonical =
    sheets.join(TEMPLATE_RECORD_SEPARATOR) +
    TEMPLATE_UNIT_SEPARATOR +
    header.join(TEMPLATE_UNIT_SEPARATOR);
  return { sheets, header, canonical };
}
