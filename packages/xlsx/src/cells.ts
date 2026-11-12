/**
 * Cell references (A1 form) and the `_xHHHH_` escapes Excel uses for characters XML cannot
 * carry. Positions are zero-based in code and one-based in references, as in Excel.
 */
import { WorkbookError } from './errors.js';
import { isXmlChar } from './xml.js';

/** The grid Excel accepts: rows 1 to 1048576, columns A to XFD. */
export const MAX_ROWS = 1_048_576;
export const MAX_COLUMNS = 16_384;

export interface CellPosition {
  /** Zero-based row: A1 is row 0. */
  row: number;
  /** Zero-based column: A is 0, Z is 25, AA is 26. */
  column: number;
}

const CODE_A = 0x41;
const LETTERS = 26;

/** `A` gives 0, `Z` 25, `AA` 26, `XFD` 16383; letters must be upper case. */
export function columnIndex(letters: string): number | null {
  if (!/^[A-Z]{1,3}$/.test(letters)) return null;
  let index = 0;
  for (let i = 0; i < letters.length; i += 1) {
    index = index * LETTERS + (letters.charCodeAt(i) - CODE_A + 1);
  }
  index -= 1;
  return index < MAX_COLUMNS ? index : null;
}

/** 0 gives `A`, 25 `Z`, 26 `AA`. */
export function columnLetters(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_COLUMNS) {
    throw new WorkbookError(`There is no column ${index} in a worksheet`, 'invalid_input');
  }
  let out = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % LETTERS;
    out = String.fromCharCode(CODE_A + remainder) + out;
    n = (n - 1 - remainder) / LETTERS;
  }
  return out;
}

/** `C7` gives row 6, column 2; null for anything that is not a reference inside Excel's grid. */
export function parseCellReference(reference: string): CellPosition | null {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(reference);
  if (!match) return null;
  const column = columnIndex(match[1] ?? '');
  const row = Number.parseInt(match[2] ?? '', 10) - 1;
  if (column === null || row >= MAX_ROWS) return null;
  return { row, column };
}

/** Row 6, column 2 gives `C7`. */
export function cellReference(position: CellPosition): string {
  if (!Number.isInteger(position.row) || position.row < 0 || position.row >= MAX_ROWS) {
    throw new WorkbookError(`There is no row ${position.row} in a worksheet`, 'invalid_input');
  }
  return `${columnLetters(position.column)}${position.row + 1}`;
}

const EXCEL_ESCAPE = /_x([0-9A-Fa-f]{4})_/g;

/**
 * Turns Excel's `_xHHHH_` sequences back into characters: `_x000D_` is a carriage return,
 * `_x005F_` a literal underscore (the escape Excel writes before a run that would otherwise read
 * as an escape).
 */
export function decodeExcelEscapes(text: string): string {
  if (!text.includes('_x')) return text;
  return text.replace(EXCEL_ESCAPE, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function hex4(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, '0');
}

const CODE_UNDERSCORE = 0x5f;
const CODE_X = 0x78;

/** The carriage return (which an XML reader would fold into a line feed) and what XML cannot carry. */
function needsEscape(code: number): boolean {
  return code === 0x0d || !isXmlChar(code);
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

/**
 * Whether the underscore at `i` would read as the start of an escape once written: `x`, four hex
 * digits, then an underscore or a character that is about to be written as an escape.
 */
function startsEscape(text: string, i: number): boolean {
  if (text.charCodeAt(i + 1) !== CODE_X) return false;
  for (let k = i + 2; k < i + 6; k += 1) if (!isHexDigit(text.charCodeAt(k))) return false;
  const next = text.codePointAt(i + 6);
  return next !== undefined && (next === CODE_UNDERSCORE || needsEscape(next));
}

/**
 * The reverse: characters XML 1.0 cannot carry (control characters other than tab and line
 * feed, U+FFFE, U+FFFF) and the carriage return become `_xHHHH_`, and an underscore that would
 * otherwise start an escape is written as `_x005F_`, scanning left to right exactly as Excel
 * does, so overlapping runs such as `_x005F_x0041_` survive. A lone surrogate is not text and
 * refuses.
 */
export function encodeExcelEscapes(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i) ?? 0;
    if (code > 0xffff) {
      out += text.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new WorkbookError('A cell holds a lone surrogate, which is not text', 'invalid_input');
    }
    if (needsEscape(code)) out += `_x${hex4(code)}_`;
    else if (code === CODE_UNDERSCORE && startsEscape(text, i)) out += '_x005F_';
    else out += text[i] ?? '';
  }
  return out;
}
