/**
 * Reads a workbook into text cells, in workbook order: the root relationships name the workbook
 * part, the workbook names its sheets, the workbook relationships place each sheet and the
 * shared strings, and each sheet's `sheetData` is walked cell by cell. Every cell is returned as
 * the text the file holds: a number is the number text exactly as stored (never through a
 * float), a boolean is `TRUE` or `FALSE`, a formula cell gives its cached value, and an error
 * cell its error text (`#N/A`). Sparse rows and columns are filled with empty text up to the
 * last cell; a row element with no cells is an empty row.
 */
import { decodeUtf8 } from './bytes.js';
import {
  MAX_COLUMNS,
  MAX_ROWS,
  cellReference,
  decodeExcelEscapes,
  parseCellReference,
} from './cells.js';
import { WorkbookError } from './errors.js';
import {
  attribute,
  childElements,
  firstChild,
  isElement,
  localName,
  parseXml,
  textOf,
  type XmlElement,
} from './xml.js';
import { readZipDirectory, readZipEntry, type InflateRaw } from './zip.js';

export interface WorkbookSheet {
  name: string;
  /** Cells as text, row by row from row 1, each row from column A to its last cell. */
  rows: string[][];
}

export interface Workbook {
  /** In workbook order, hidden sheets included; a chart sheet has no rows. */
  sheets: WorkbookSheet[];
}

export interface ReadLimits {
  /** The most cells one sheet may hold once its sparse cells are filled; rows are not counted. */
  maxCells: number;
  /** The most cells every sheet of a workbook may hold together. */
  maxTotalCells: number;
  /** The most sheets a workbook may list. */
  maxSheets: number;
  /** The deepest element nesting accepted in any part. */
  maxDepth: number;
  /** The largest part (uncompressed, as the archive declares it) the reader will inflate. */
  maxPartBytes: number;
  /** The most the parts one read opens may declare together; the sum is checked before each is inflated. */
  maxTotalPartBytes: number;
}

/** The defaults; a caller passes its own from configuration (rule 9). */
export const READ_LIMITS: Readonly<ReadLimits> = Object.freeze({
  maxCells: 200_000,
  maxTotalCells: 200_000,
  maxSheets: 64,
  maxDepth: 64,
  maxPartBytes: 16 * 1024 * 1024,
  maxTotalPartBytes: 64 * 1024 * 1024,
});

/**
 * The elements and text nodes a part may hold, from the cell limit: a cell is at most a few
 * nodes (`c`, `f`, `v` or `is` and `t`, and their text), and the rest of a part is small. The
 * parser refuses at the budget, so a hostile part never grows a tree past it.
 */
const NODES_PER_CELL = 5;
const NODES_BEYOND_CELLS = 1024;

function nodeBudget(maxCells: number): number {
  return NODES_PER_CELL * maxCells + NODES_BEYOND_CELLS;
}

export interface ReadWorkbookOptions extends Partial<ReadLimits> {
  /** The inflater for method 8 entries: `nodeInflateRaw` from `@pb/xlsx/node`, or a DecompressionStream wrapper in a browser. */
  inflateRaw: InflateRaw;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
}

const DEFAULT_WORKBOOK_PATH = 'xl/workbook.xml';

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}

function relationshipsPathOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const base = slash < 0 ? path : path.slice(slash + 1);
  return `${dirOf(path)}_rels/${base}.rels`;
}

/** One segment of a relationship target with its percent escapes decoded; a bad escape refuses. */
function decodeSegment(segment: string, target: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch (cause) {
    throw new WorkbookError(
      `The relationship target ${target} holds an escape that is not valid`,
      'malformed',
      { cause },
    );
  }
}

/**
 * Resolves a relationship target against its source part's directory; `/x/y` is absolute. The
 * target is a URI, so each of its segments is percent-decoded (`sheet%201.xml` names
 * `sheet 1.xml`); `baseDir` is already a part path and is taken as it is.
 */
export function resolvePartPath(baseDir: string, target: string): string {
  const base = target.startsWith('/') ? [] : baseDir.split('/');
  const out: string[] = [];
  for (const segment of [...base, ...target.split('/').map((s) => decodeSegment(s, target))]) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

function readRelationships(root: XmlElement, part: string): Relationship[] {
  if (localName(root.name) !== 'Relationships') {
    throw new WorkbookError(`${part} is not a relationships part`, 'malformed');
  }
  const out: Relationship[] = [];
  for (const element of childElements(root, 'Relationship')) {
    const { Id: id, Type: type, Target: target, TargetMode: mode } = element.attributes;
    if (id === undefined || type === undefined || target === undefined) {
      throw new WorkbookError(
        `${part} holds a relationship without an id, a type or a target`,
        'malformed',
      );
    }
    if (mode === 'External') continue;
    out.push({ id, type, target });
  }
  return out;
}

/**
 * The text of a rich text container (`si` or `is`): its `t` children and the `t` of each `r`
 * run, joined. Excel's `_xHHHH_` escapes are decoded within each run on its own, as Excel does,
 * so an escape-shaped sequence that straddles two runs stays literal.
 */
function richText(element: XmlElement): string {
  let out = '';
  for (const child of element.children) {
    if (!isElement(child)) continue;
    const name = localName(child.name);
    if (name === 't') out += decodeExcelEscapes(textOf(child));
    else if (name === 'r') {
      const t = firstChild(child, 't');
      if (t) out += decodeExcelEscapes(textOf(t));
    }
  }
  return out;
}

function readSharedStrings(root: XmlElement, part: string): string[] {
  if (localName(root.name) !== 'sst') {
    throw new WorkbookError(`${part} is not a shared strings part`, 'malformed');
  }
  return childElements(root, 'si').map(richText);
}

function cellValue(
  cell: XmlElement,
  reference: string,
  sheet: string,
  strings: readonly string[],
): string {
  const type = attribute(cell, 't') ?? 'n';
  const value = firstChild(cell, 'v');
  const malformed = (what: string): never => {
    throw new WorkbookError(`Cell ${reference} on sheet ${sheet} ${what}`, 'malformed');
  };
  switch (type) {
    case 'n':
    case 'd':
    case 'e':
      return value ? textOf(value) : '';
    case 'str':
      return value ? decodeExcelEscapes(textOf(value)) : '';
    case 'b': {
      const raw = value ? textOf(value).trim() : '';
      if (raw === '1') return 'TRUE';
      if (raw === '0') return 'FALSE';
      if (raw === '') return '';
      return malformed(`holds ${raw} where a boolean cell holds 0 or 1`);
    }
    case 's': {
      if (!value) return '';
      const raw = textOf(value).trim();
      if (!/^[0-9]{1,9}$/.test(raw)) return malformed('does not point at a shared string');
      const text = strings[Number.parseInt(raw, 10)];
      if (text === undefined)
        return malformed(`points at shared string ${raw}, which the workbook does not have`);
      return text;
    }
    case 'inlineStr': {
      const inline = firstChild(cell, 'is');
      return inline ? richText(inline) : '';
    }
    default:
      return malformed(`has a type the reader does not understand: ${type}`);
  }
}

/** The cell limits one workbook read shares across its sheets. */
interface CellBudget {
  /** The most cells one sheet may hold once its sparse cells are filled. */
  maxCells: number;
  /** The most cells every sheet may hold together. */
  maxTotalCells: number;
  /** Cells counted so far, across the sheets already read and the one being read. */
  total: number;
}

function readSheetRows(
  root: XmlElement,
  sheet: string,
  strings: readonly string[],
  budget: CellBudget,
): string[][] {
  const rows: string[][] = [];
  const data = firstChild(root, 'sheetData');
  if (!data) return rows;
  let cells = 0;
  let nextRow = 0;
  const listed = new Set<number>();
  const tooLarge = (what: string): never => {
    throw new WorkbookError(what, 'too_large');
  };
  const malformed = (what: string): never => {
    throw new WorkbookError(`Sheet ${sheet} ${what}`, 'malformed');
  };
  /** Counts cells about to be stored, on this sheet and across the workbook, before they are. */
  const count = (n: number): void => {
    cells += n;
    budget.total += n;
    if (cells > budget.maxCells) tooLarge(`Sheet ${sheet} has more than ${budget.maxCells} cells`);
    if (budget.total > budget.maxTotalCells) {
      tooLarge(`The workbook has more than ${budget.maxTotalCells} cells across its sheets`);
    }
  };
  for (const row of childElements(data, 'row')) {
    const r = attribute(row, 'r');
    let rowIndex = nextRow;
    if (r !== undefined) {
      if (!/^[1-9][0-9]{0,6}$/.test(r)) malformed(`has a row numbered "${r}"`);
      rowIndex = Number.parseInt(r, 10) - 1;
    }
    if (rowIndex >= MAX_ROWS) {
      malformed(`has a row numbered ${rowIndex + 1}, past the last row Excel allows`);
    }
    if (rowIndex >= budget.maxCells) {
      tooLarge(
        `Sheet ${sheet} has a row numbered ${rowIndex + 1}, past the ${budget.maxCells} rows the reader accepts`,
      );
    }
    if (listed.has(rowIndex)) malformed(`lists row ${rowIndex + 1} twice`);
    listed.add(rowIndex);
    while (rows.length <= rowIndex) rows.push([]);
    const stored = rows[rowIndex] ?? [];
    const filled = new Set<number>();
    let nextColumn = 0;
    for (const cell of childElements(row, 'c')) {
      const ref = attribute(cell, 'r');
      let column = nextColumn;
      if (ref !== undefined) {
        const position =
          parseCellReference(ref) ??
          malformed(`has a cell referenced as "${ref}", which is not a reference Excel accepts`);
        if (position.row !== rowIndex) malformed(`places cell ${ref} in row ${rowIndex + 1}`);
        column = position.column;
      }
      if (column >= MAX_COLUMNS) {
        malformed(
          `places a cell past column XFD, the last column Excel allows, in row ${rowIndex + 1}`,
        );
      }
      if (column >= budget.maxCells) {
        tooLarge(`Sheet ${sheet} has more than ${budget.maxCells} cells`);
      }
      const reference = ref ?? cellReference({ row: rowIndex, column });
      if (filled.has(column)) malformed(`holds cell ${reference} twice`);
      filled.add(column);
      if (stored.length < column) {
        count(column - stored.length);
        while (stored.length < column) stored.push('');
      }
      const text = cellValue(cell, reference, sheet, strings);
      if (stored.length === column) {
        count(1);
        stored.push(text);
      } else stored[column] = text;
      nextColumn = column + 1;
    }
    nextRow = rowIndex + 1;
  }
  return rows;
}

/**
 * Reads an .xlsx (or .xlsm; macros are never run, their parts are never opened) into text cells.
 * Refuses, with a `WorkbookError`, anything that is not a zip, is encrypted, lacks a workbook
 * part, uses a compression method other than stored or deflate, or passes a read limit.
 */
export async function readWorkbook(
  bytes: Uint8Array,
  options: ReadWorkbookOptions,
): Promise<Workbook> {
  const limits: ReadLimits = {
    maxCells: options.maxCells ?? READ_LIMITS.maxCells,
    maxTotalCells: options.maxTotalCells ?? options.maxCells ?? READ_LIMITS.maxTotalCells,
    maxSheets: options.maxSheets ?? READ_LIMITS.maxSheets,
    maxDepth: options.maxDepth ?? READ_LIMITS.maxDepth,
    maxPartBytes: options.maxPartBytes ?? READ_LIMITS.maxPartBytes,
    maxTotalPartBytes: options.maxTotalPartBytes ?? READ_LIMITS.maxTotalPartBytes,
  };
  const maxNodes = nodeBudget(limits.maxCells);
  const directory = readZipDirectory(bytes);
  let declaredBytes = 0;
  const readPart = async (path: string): Promise<XmlElement | null> => {
    const entry = directory.get(path);
    if (!entry) return null;
    declaredBytes += entry.uncompressedSize;
    if (declaredBytes > limits.maxTotalPartBytes) {
      throw new WorkbookError(
        `The parts of the workbook declare ${declaredBytes} bytes together, more than the ${limits.maxTotalPartBytes} the reader accepts`,
        'too_large',
      );
    }
    const text = decodeUtf8(
      await readZipEntry(bytes, entry, options.inflateRaw, limits.maxPartBytes),
      path,
    );
    return parseXml(text, { maxDepth: limits.maxDepth, maxNodes, part: path });
  };
  const relationshipsOf = async (path: string): Promise<Relationship[] | null> => {
    const root = await readPart(path);
    return root ? readRelationships(root, path) : null;
  };

  let workbookPath = DEFAULT_WORKBOOK_PATH;
  const rootRelationships = await relationshipsOf('_rels/.rels');
  const office = rootRelationships?.find((r) => r.type.endsWith('/officeDocument'));
  if (office) workbookPath = resolvePartPath('', office.target);
  const workbook = await readPart(workbookPath);
  if (!workbook) {
    throw new WorkbookError(
      `The file has no workbook part (${workbookPath}), so it is not an Excel workbook`,
      'missing_part',
    );
  }
  if (localName(workbook.name) !== 'workbook') {
    throw new WorkbookError(`${workbookPath} is not a workbook part`, 'malformed');
  }
  const sheetsElement = firstChild(workbook, 'sheets');
  const sheetElements = sheetsElement ? childElements(sheetsElement, 'sheet') : [];
  if (sheetElements.length > limits.maxSheets) {
    throw new WorkbookError(
      `The workbook lists ${sheetElements.length} sheets, more than the ${limits.maxSheets} the reader accepts`,
      'too_large',
    );
  }
  const baseDir = dirOf(workbookPath);
  const relationshipsPath = relationshipsPathOf(workbookPath);
  const relationships = await relationshipsOf(relationshipsPath);
  if (!relationships && sheetElements.length > 0) {
    throw new WorkbookError(
      `The file has no workbook relationships part (${relationshipsPath})`,
      'missing_part',
    );
  }
  const related = relationships ?? [];

  const sharedRelationship = related.find((r) => r.type.endsWith('/sharedStrings'));
  const sharedPath = sharedRelationship
    ? resolvePartPath(baseDir, sharedRelationship.target)
    : `${baseDir}sharedStrings.xml`;
  const shared = await readPart(sharedPath);
  if (sharedRelationship && !shared) {
    throw new WorkbookError(`The file has no shared strings part (${sharedPath})`, 'missing_part');
  }
  const strings = shared ? readSharedStrings(shared, sharedPath) : [];

  const sheets: WorkbookSheet[] = [];
  const budget: CellBudget = {
    maxCells: limits.maxCells,
    maxTotalCells: limits.maxTotalCells,
    total: 0,
  };
  for (const element of sheetElements) {
    const name = attribute(element, 'name');
    const relationshipId = attribute(element, 'id');
    if (name === undefined || relationshipId === undefined) {
      throw new WorkbookError(
        `${workbookPath} lists a sheet without a name or a relationship id`,
        'malformed',
      );
    }
    const relationship = related.find((r) => r.id === relationshipId);
    if (!relationship) {
      throw new WorkbookError(
        `Sheet ${name} points at relationship ${relationshipId}, which the workbook does not define`,
        'malformed',
      );
    }
    const path = resolvePartPath(baseDir, relationship.target);
    const root = await readPart(path);
    if (!root)
      throw new WorkbookError(
        `Sheet ${name} points at ${path}, which is not in the file`,
        'missing_part',
      );
    const kind = localName(root.name);
    let rows: string[][];
    if (kind === 'worksheet') rows = readSheetRows(root, name, strings, budget);
    else if (kind === 'chartsheet') rows = [];
    else
      throw new WorkbookError(
        `Sheet ${name} is a ${kind}, which the reader does not understand`,
        'unsupported',
      );
    sheets.push({ name, rows });
  }
  return { sheets };
}
