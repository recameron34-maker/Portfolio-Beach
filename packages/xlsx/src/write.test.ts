import { describe, expect, it } from 'vitest';
import { MAX_COLUMNS } from './cells.js';
import { WorkbookError } from './errors.js';
import { nodeInflateRaw } from './node.js';
import { readWorkbook } from './read.js';
import { templateKey } from './template.js';
import {
  MAX_CELL_TEXT_LENGTH,
  MAX_SHEET_NAME_LENGTH,
  sheetNameProblem,
  validateSheetNames,
  writeWorkbook,
  type SheetInput,
} from './write.js';
import { readZipDirectory, readZipEntry } from './zip.js';

const decoder = new TextDecoder();
const read = (bytes: Uint8Array) => readWorkbook(bytes, { inflateRaw: nodeInflateRaw });

async function part(bytes: Uint8Array, name: string): Promise<string> {
  const entry = readZipDirectory(bytes).get(name);
  if (!entry) throw new Error(`no part ${name}`);
  return decoder.decode(await readZipEntry(bytes, entry, nodeInflateRaw, 1 << 24));
}

function refusal(run: () => unknown): WorkbookError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkbookError);
    return error as WorkbookError;
  }
  throw new Error('expected a WorkbookError');
}

const SHEETS: SheetInput[] = [
  {
    name: 'Positions',
    rows: [
      ['Investment', 'Fair value', 'Note'],
      ['INV-0001', '12345678.123456789012345', ''],
      [],
      ['INV-0002', '-0.000000000000000001', '1E+30'],
      ['INV-0003', '007', 'TRUE'],
    ],
  },
  {
    name: 'Notes & more',
    rows: [
      ['a&b', '<tag>', '"quoted"', "it's", ']]>'],
      ['日本語', 'emoji 😀', 'tab\tin', 'line\nbreak', ' lead', 'trail '],
      ['\r carriage', '_x000D_ literal', 'crlf\r\n', '\u0001 control'],
      [],
      [],
    ],
  },
  { name: 'Empty', rows: [] },
  { name: 'Only empty rows', rows: [[], []] },
];

describe('writeWorkbook then readWorkbook', () => {
  it('round-trips several sheets, sparse cells, empty rows, long number text and XML-sensitive text', async () => {
    const workbook = await read(writeWorkbook(SHEETS));
    expect(workbook.sheets).toEqual(
      SHEETS.map((s) => ({ name: s.name, rows: s.rows.map((r) => [...r]) })),
    );
  });

  it('writes the same bytes for the same input and different bytes for a different sheet order', () => {
    const once = writeWorkbook(SHEETS);
    expect(writeWorkbook(SHEETS)).toEqual(once);
    expect(writeWorkbook([...SHEETS].reverse())).not.toEqual(once);
    expect(once.length).toBeGreaterThan(0);
  });

  it('lays out exactly the parts Excel needs, stored, in a fixed order', async () => {
    const bytes = writeWorkbook(SHEETS.slice(0, 2));
    const directory = readZipDirectory(bytes);
    expect([...directory.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    for (const entry of directory.values()) expect(entry.method, entry.name).toBe(0);
    const types = await part(bytes, '[Content_Types].xml');
    expect(types).toContain('PartName="/xl/worksheets/sheet2.xml"');
    expect(types).not.toContain('sheet3.xml');
    const workbook = await part(bytes, 'xl/workbook.xml');
    expect(workbook).toContain('<sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/>');
    const rels = await part(bytes, 'xl/_rels/workbook.xml.rels');
    expect(rels).toContain(
      'Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"',
    );
    expect(rels).toContain(
      'Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"',
    );
  });

  it('writes every cell as an inline string and preserves whitespace only where Excel would drop it', async () => {
    const sheet = await part(writeWorkbook(SHEETS.slice(1, 2)), 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t>a&amp;b</t></is></c>');
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t>&lt;tag&gt;</t></is></c>');
    expect(sheet).toContain(
      '<c r="E2" t="inlineStr"><is><t xml:space="preserve"> lead</t></is></c>',
    );
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t>_x000D_ carriage</t></is></c>');
    expect(sheet).toContain('<c r="B3" t="inlineStr"><is><t>_x005F_x000D_ literal</t></is></c>');
    expect(sheet).toContain(
      '<c r="C3" t="inlineStr"><is><t xml:space="preserve">crlf_x000D_\n</t></is></c>',
    );
    expect(sheet).toContain('<c r="D3" t="inlineStr"><is><t>_x0001_ control</t></is></c>');
    expect(sheet).toContain('<row r="4"/><row r="5"/>');
    expect(sheet).not.toContain('t="n"');
    expect(sheet).not.toContain('<v>');
  });

  it('gives a template key that reads back the header exactly as written', async () => {
    const key = templateKey(await read(writeWorkbook(SHEETS)), 'Positions');
    expect(key.sheets).toEqual(['Positions', 'Notes & more', 'Empty', 'Only empty rows']);
    expect(key.header).toEqual(['Investment', 'Fair value', 'Note']);
  });
});

describe('writeWorkbook refusals', () => {
  it('validates sheet names the way Excel does', () => {
    expect(sheetNameProblem('Positions')).toBeNull();
    expect(sheetNameProblem('a'.repeat(MAX_SHEET_NAME_LENGTH))).toBeNull();
    expect(sheetNameProblem('')).toBe('a sheet name cannot be empty');
    expect(sheetNameProblem('a'.repeat(MAX_SHEET_NAME_LENGTH + 1))).toBe(
      'a sheet name cannot be longer than 31 characters',
    );
    for (const char of ['\\', '/', '?', '*', '[', ']', ':']) {
      expect(sheetNameProblem(`a${char}b`), char).toBe(`a sheet name cannot contain ${char}`);
    }
    expect(sheetNameProblem("'quoted")).toBe('a sheet name cannot start or end with an apostrophe');
    expect(sheetNameProblem("quoted'")).toBe('a sheet name cannot start or end with an apostrophe');
    expect(sheetNameProblem("it's fine")).toBeNull();
    expect(sheetNameProblem('history')).toBe('Excel reserves the sheet name History');
    expect(sheetNameProblem('a\u0000b')).toBe('a sheet name cannot contain control characters');
    expect(sheetNameProblem('a\ud800b')).toBe(
      'a sheet name holds a lone surrogate, which is not text',
    );
    expect(sheetNameProblem('\udc00')).toBe(
      'a sheet name holds a lone surrogate, which is not text',
    );
    expect(sheetNameProblem('a\ufffeb')).toBe(
      'a sheet name cannot contain a character XML does not allow',
    );
    expect(sheetNameProblem('a\uffffb')).toBe(
      'a sheet name cannot contain a character XML does not allow',
    );
    expect(sheetNameProblem('pair \u{1F600} ok')).toBeNull();
    expect(refusal(() => writeWorkbook([{ name: 'a\ud800', rows: [] }])).code).toBe(
      'invalid_input',
    );
  });

  it('refuses no sheets, a bad name and names that differ only in case', () => {
    expect(refusal(() => writeWorkbook([])).message).toBe('A workbook needs at least one sheet');
    const bad = refusal(() => writeWorkbook([{ name: 'a/b', rows: [] }]));
    expect(bad.code).toBe('invalid_input');
    expect(bad.message).toBe('Sheet name "a/b" is not allowed: a sheet name cannot contain /');
    const twice = refusal(() => validateSheetNames(['Data', 'data']));
    expect(twice.message).toBe('Two sheets are named "data" (Excel ignores case)');
  });

  it('refuses a cell that is not text, so a number can never sneak in as a float', () => {
    const rows = [[12.5 as unknown as string]];
    const error = refusal(() => writeWorkbook([{ name: 'S', rows }]));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toBe(
      'Cell A1 on sheet S is not text; every cell is written as the text given',
    );
  });

  it('refuses text longer than Excel allows, a lone surrogate, and a row wider than the grid', () => {
    expect(
      writeWorkbook([{ name: 'S', rows: [['x'.repeat(MAX_CELL_TEXT_LENGTH)]] }]).length,
    ).toBeGreaterThan(0);
    const long = refusal(() =>
      writeWorkbook([{ name: 'S', rows: [['x'.repeat(MAX_CELL_TEXT_LENGTH + 1)]] }]),
    );
    expect(long.message).toBe(
      'Cell A1 on sheet S is longer than the 32767 characters Excel allows',
    );
    expect(refusal(() => writeWorkbook([{ name: 'S', rows: [['\ud800']] }])).code).toBe(
      'invalid_input',
    );
    const wide = refusal(() =>
      writeWorkbook([{ name: 'S', rows: [new Array<string>(MAX_COLUMNS + 1).fill('')] }]),
    );
    expect(wide.message).toBe(
      'Row 1 of sheet S has more cells than the 16384 columns Excel allows',
    );
  });
});
