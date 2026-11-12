/**
 * @pb/xlsx: a dependency-free XLSX reader and writer in pure TypeScript. This entry imports no
 * runtime module, so it bundles for the browser as it is; the inflater is injected
 * (`@pb/xlsx/node` provides the zlib one).
 */
export { WorkbookError, type WorkbookErrorCode } from './errors.js';
export {
  readWorkbook,
  READ_LIMITS,
  resolvePartPath,
  type ReadLimits,
  type ReadWorkbookOptions,
  type Workbook,
  type WorkbookSheet,
} from './read.js';
export {
  writeWorkbook,
  validateSheetNames,
  sheetNameProblem,
  MAX_SHEET_NAME_LENGTH,
  MAX_CELL_TEXT_LENGTH,
  type SheetInput,
} from './write.js';
export {
  templateKey,
  TEMPLATE_RECORD_SEPARATOR,
  TEMPLATE_UNIT_SEPARATOR,
  type TemplateKey,
} from './template.js';
export {
  cellReference,
  parseCellReference,
  columnIndex,
  columnLetters,
  MAX_ROWS,
  MAX_COLUMNS,
  type CellPosition,
} from './cells.js';
export type { InflateRaw } from './zip.js';
