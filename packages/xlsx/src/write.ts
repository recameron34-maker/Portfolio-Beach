/**
 * Writes a workbook with every cell as an inline string (`t="inlineStr"`), so a number written
 * as text comes back as exactly that text; nothing is parsed, rounded or formatted. The package
 * holds the six parts Excel needs to open a file (content types, root relationships, the
 * workbook, its relationships, one minimal style sheet, one part per sheet) and nothing else.
 * Output is deterministic: the same sheets give the same bytes.
 */
import { encodeUtf8 } from './bytes.js';
import { MAX_COLUMNS, MAX_ROWS, cellReference, encodeExcelEscapes } from './cells.js';
import { WorkbookError } from './errors.js';
import { escapeAttribute, escapeText, isXmlChar } from './xml.js';
import { writeZip, type ZipWriteEntry } from './zip.js';

export interface SheetInput {
  name: string;
  rows: readonly (readonly string[])[];
}

/** Excel's limits on a sheet name and on the text of one cell. */
export const MAX_SHEET_NAME_LENGTH = 31;
export const MAX_CELL_TEXT_LENGTH = 32_767;
/** Excel reserves this name for its change history sheet. */
const RESERVED_SHEET_NAME = 'history';
const FORBIDDEN_IN_SHEET_NAME = /[\\/?*[\]:]/;

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_RELATIONSHIPS_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const TYPE_OFFICE_DOCUMENT = `${NS_RELATIONSHIPS_DOCUMENT}/officeDocument`;
const TYPE_WORKSHEET = `${NS_RELATIONSHIPS_DOCUMENT}/worksheet`;
const TYPE_STYLES = `${NS_RELATIONSHIPS_DOCUMENT}/styles`;
const CONTENT_TYPE_WORKBOOK =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const CONTENT_TYPE_WORKSHEET =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const CONTENT_TYPE_STYLES =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml';
const CONTENT_TYPE_RELATIONSHIPS = 'application/vnd.openxmlformats-package.relationships+xml';

/**
 * The least a style sheet can hold and still open in Excel: one font, the two fills Excel
 * expects (none and the gray125 pattern), one empty border and the Normal cell style.
 */
const STYLES_XML =
  `${XML_DECLARATION}<styleSheet xmlns="${NS_MAIN}">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** Why a sheet name cannot be used, as a plain sentence, or null when it can. */
export function sheetNameProblem(name: string): string | null {
  if (name.length === 0) return 'a sheet name cannot be empty';
  if (name.length > MAX_SHEET_NAME_LENGTH) {
    return `a sheet name cannot be longer than ${MAX_SHEET_NAME_LENGTH} characters`;
  }
  const forbidden = FORBIDDEN_IN_SHEET_NAME.exec(name);
  if (forbidden) return `a sheet name cannot contain ${forbidden[0]}`;
  if (name.startsWith("'") || name.endsWith("'"))
    return 'a sheet name cannot start or end with an apostrophe';
  if (name.toLowerCase() === RESERVED_SHEET_NAME) return 'Excel reserves the sheet name History';
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) {
      return 'a sheet name holds a lone surrogate, which is not text';
    }
    if (code < 0x20 || code === 0x7f) return 'a sheet name cannot contain control characters';
    if (!isXmlChar(code)) return 'a sheet name cannot contain a character XML does not allow';
  }
  return null;
}

/** Refuses an empty list, a name Excel would not accept, or two names that differ only in case. */
export function validateSheetNames(names: readonly string[]): void {
  if (names.length === 0)
    throw new WorkbookError('A workbook needs at least one sheet', 'invalid_input');
  const seen = new Set<string>();
  for (const name of names) {
    const problem = sheetNameProblem(name);
    if (problem !== null)
      throw new WorkbookError(`Sheet name "${name}" is not allowed: ${problem}`, 'invalid_input');
    const key = name.toLowerCase();
    if (seen.has(key))
      throw new WorkbookError(
        `Two sheets are named "${name}" (Excel ignores case)`,
        'invalid_input',
      );
    seen.add(key);
  }
}

/** Leading or trailing whitespace, a tab or a line feed need `xml:space="preserve"` to survive Excel. */
const NEEDS_PRESERVE = /^\s|\s$|[\t\n]/;

function cellXml(text: unknown, position: { row: number; column: number }, sheet: string): string {
  const reference = cellReference(position);
  if (typeof text !== 'string') {
    throw new WorkbookError(
      `Cell ${reference} on sheet ${sheet} is not text; every cell is written as the text given`,
      'invalid_input',
    );
  }
  if (text.length > MAX_CELL_TEXT_LENGTH) {
    throw new WorkbookError(
      `Cell ${reference} on sheet ${sheet} is longer than the ${MAX_CELL_TEXT_LENGTH} characters Excel allows`,
      'invalid_input',
    );
  }
  const escaped = encodeExcelEscapes(text);
  const preserve = NEEDS_PRESERVE.test(escaped) ? ' xml:space="preserve"' : '';
  return `<c r="${reference}" t="inlineStr"><is><t${preserve}>${escapeText(escaped)}</t></is></c>`;
}

function sheetXml(sheet: SheetInput): string {
  if (sheet.rows.length > MAX_ROWS) {
    throw new WorkbookError(
      `Sheet ${sheet.name} has more rows than the ${MAX_ROWS} Excel allows`,
      'invalid_input',
    );
  }
  const parts: string[] = [XML_DECLARATION, `<worksheet xmlns="${NS_MAIN}"><sheetData>`];
  for (let row = 0; row < sheet.rows.length; row += 1) {
    const cells = sheet.rows[row] ?? [];
    if (cells.length > MAX_COLUMNS) {
      throw new WorkbookError(
        `Row ${row + 1} of sheet ${sheet.name} has more cells than the ${MAX_COLUMNS} columns Excel allows`,
        'invalid_input',
      );
    }
    if (cells.length === 0) {
      parts.push(`<row r="${row + 1}"/>`);
      continue;
    }
    parts.push(`<row r="${row + 1}">`);
    for (let column = 0; column < cells.length; column += 1) {
      parts.push(cellXml(cells[column], { row, column }, sheet.name));
    }
    parts.push('</row>');
  }
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

function contentTypesXml(sheetCount: number): string {
  const overrides: string[] = [
    `<Override PartName="/xl/workbook.xml" ContentType="${CONTENT_TYPE_WORKBOOK}"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="${CONTENT_TYPE_STYLES}"/>`,
  ];
  for (let n = 1; n <= sheetCount; n += 1) {
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="${CONTENT_TYPE_WORKSHEET}"/>`,
    );
  }
  return (
    `${XML_DECLARATION}<Types xmlns="${NS_CONTENT_TYPES}">` +
    `<Default Extension="rels" ContentType="${CONTENT_TYPE_RELATIONSHIPS}"/>` +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `${overrides.join('')}</Types>`
  );
}

function rootRelationshipsXml(): string {
  return (
    `${XML_DECLARATION}<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">` +
    `<Relationship Id="rId1" Type="${TYPE_OFFICE_DOCUMENT}" Target="xl/workbook.xml"/>` +
    '</Relationships>'
  );
}

function workbookXml(names: readonly string[]): string {
  const sheets = names.map(
    (name, i) => `<sheet name="${escapeAttribute(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
  );
  return (
    `${XML_DECLARATION}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_RELATIONSHIPS_DOCUMENT}">` +
    `<sheets>${sheets.join('')}</sheets></workbook>`
  );
}

function workbookRelationshipsXml(sheetCount: number): string {
  const relationships: string[] = [];
  for (let n = 1; n <= sheetCount; n += 1) {
    relationships.push(
      `<Relationship Id="rId${n}" Type="${TYPE_WORKSHEET}" Target="worksheets/sheet${n}.xml"/>`,
    );
  }
  relationships.push(
    `<Relationship Id="rId${sheetCount + 1}" Type="${TYPE_STYLES}" Target="styles.xml"/>`,
  );
  return (
    `${XML_DECLARATION}<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">` +
    `${relationships.join('')}</Relationships>`
  );
}

/** Writes the sheets, in order, as an .xlsx; every cell is the text given. */
export function writeWorkbook(sheets: readonly SheetInput[]): Uint8Array {
  const names = sheets.map((s) => s.name);
  validateSheetNames(names);
  const entry = (name: string, xml: string): ZipWriteEntry => ({ name, data: encodeUtf8(xml) });
  const entries: ZipWriteEntry[] = [
    entry('[Content_Types].xml', contentTypesXml(sheets.length)),
    entry('_rels/.rels', rootRelationshipsXml()),
    entry('xl/workbook.xml', workbookXml(names)),
    entry('xl/_rels/workbook.xml.rels', workbookRelationshipsXml(sheets.length)),
    entry('xl/styles.xml', STYLES_XML),
  ];
  sheets.forEach((sheet, i) =>
    entries.push(entry(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet))),
  );
  return writeZip(entries);
}
