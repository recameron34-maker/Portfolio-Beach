import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { WorkbookError } from './errors.js';
import { nodeInflateRaw } from './node.js';
import { READ_LIMITS, readWorkbook, resolvePartPath, type ReadWorkbookOptions } from './read.js';
import { writeWorkbook } from './write.js';
import { writeZip, type ZipWriteEntry } from './zip.js';

const encoder = new TextEncoder();
const read = (bytes: Uint8Array, options: Partial<ReadWorkbookOptions> = {}) =>
  readWorkbook(bytes, { inflateRaw: nodeInflateRaw, ...options });

/**
 * Builds an archive the way an Excel-like writer would: every part deflated (method 8), so each
 * read here also proves the injected inflater path.
 */
function archive(parts: Record<string, string>): Uint8Array {
  const entries: ZipWriteEntry[] = Object.entries(parts).map(([name, xml]) => {
    const data = encoder.encode(xml);
    return { name, data, deflated: new Uint8Array(deflateRawSync(data)) };
  });
  return writeZip(entries);
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = (id: string, kind: string, target: string): string =>
  `<Relationship Id="${id}" Type="${NS_R}/${kind}" Target="${target}"/>`;

/** The parts of a workbook as Excel lays them out, with the sheet XML and shared strings given. */
function excelLike(sheetXml: string, sharedStringsXml?: string): Record<string, string> {
  const parts: Record<string, string> = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': `<Relationships xmlns="${NS_PR}">${REL('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`,
    'xl/workbook.xml':
      `<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets>` +
      '<sheet name="Data" sheetId="1" state="hidden" r:id="rId2"/>' +
      '<sheet name="Chart" sheetId="2" r:id="rId1"/>' +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      `<Relationships xmlns="${NS_PR}">` +
      REL('rId1', 'chartsheet', 'chartsheets/sheet1.xml') +
      REL('rId2', 'worksheet', 'worksheets/sheet1.xml') +
      (sharedStringsXml === undefined ? '' : REL('rId3', 'sharedStrings', 'sharedStrings.xml')) +
      REL('rId4', 'styles', 'styles.xml') +
      '</Relationships>',
    'xl/chartsheets/sheet1.xml': `<chartsheet xmlns="${NS}"><sheetViews/></chartsheet>`,
    'xl/worksheets/sheet1.xml': sheetXml,
  };
  if (sharedStringsXml !== undefined) parts['xl/sharedStrings.xml'] = sharedStringsXml;
  return parts;
}

const SHARED_STRINGS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS}" count="4" uniqueCount="3">` +
  '<si><t>Plain</t></si>' +
  '<si><r><rPr><b/></rPr><t>Rich </t></r><r><t xml:space="preserve">run</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si>' +
  '<si><t>Line_x000D_break</t></si>' +
  '</sst>';

const SHEET =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${NS_R}">` +
  '<dimension ref="A1:F5"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>' +
  '<row r="1" spans="1:6"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>' +
  '<c r="D1" t="b"><v>1</v></c><c r="E1" t="b"><v>0</v></c><c r="F1"><v>0.1</v></c></row>' +
  '<row r="2"><c r="A2"><v>1.0000000000000001E+30</v></c><c r="C2" t="n"><v>42</v></c>' +
  '<c r="D2" t="str"><f>A1&amp;B1</f><v>PlainRich run</v></c><c r="E2"><f>1+1</f><v>2</v></c>' +
  '<c r="F2" t="e"><v>#N/A</v></c></row>' +
  '<row r="3" ht="20" customHeight="1"/>' +
  '<row r="4"><c r="A4" t="inlineStr"><is><t>inline</t></is></c>' +
  '<c r="B4" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r></is></c><c r="C4" s="1"/>' +
  '<c t="n"><v>7</v></c><c><v>8</v></c></row>' +
  '<row><c><v>9</v></c></row>' +
  '</sheetData><pageMargins left="0.7" right="0.7"/></worksheet>';

async function refusal(run: () => Promise<unknown>): Promise<WorkbookError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkbookError);
    return error as WorkbookError;
  }
  throw new Error('expected a WorkbookError');
}

describe('readWorkbook on a workbook an Excel-like writer produced (deflated parts)', () => {
  it('reads every cell type as text, in workbook order, with sparse cells filled', async () => {
    const workbook = await read(archive(excelLike(SHEET, SHARED_STRINGS)));
    expect(workbook.sheets.map((s) => s.name)).toEqual(['Data', 'Chart']);
    expect(workbook.sheets[0]?.rows).toEqual([
      ['Plain', 'Rich run', 'Line\rbreak', 'TRUE', 'FALSE', '0.1'],
      ['1.0000000000000001E+30', '', '42', 'PlainRich run', '2', '#N/A'],
      [],
      ['inline', 'ab', '', '7', '8'],
      ['9'],
    ]);
    expect(workbook.sheets[1]?.rows).toEqual([]);
  });

  it('reads a workbook with no shared strings part and an empty sheetData', async () => {
    const parts = excelLike(`<worksheet xmlns="${NS}"><sheetData/></worksheet>`);
    const workbook = await read(archive(parts));
    expect(workbook.sheets[0]?.rows).toEqual([]);
  });

  it('places rows and cells by their references whatever order the file lists them in', async () => {
    const sheet =
      `<worksheet xmlns="${NS}"><sheetData>` +
      '<row r="3"><c r="B3" t="inlineStr"><is><t>b3</t></is></c><c r="A3" t="inlineStr"><is><t>a3</t></is></c></row>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>a1</t></is></c></row>' +
      '</sheetData></worksheet>';
    const workbook = await read(archive(excelLike(sheet)));
    expect(workbook.sheets[0]?.rows).toEqual([['a1'], [], ['a3', 'b3']]);
  });

  it('follows the root relationships to a workbook that is not at xl/workbook.xml', async () => {
    const parts: Record<string, string> = {
      '_rels/.rels': `<Relationships xmlns="${NS_PR}">${REL('rId1', 'officeDocument', '/book/wb.xml')}</Relationships>`,
      'book/wb.xml': `<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'book/_rels/wb.xml.rels': `<Relationships xmlns="${NS_PR}">${REL('rId1', 'worksheet', '../parts/s1.xml')}</Relationships>`,
      'parts/s1.xml': `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
    };
    const workbook = await read(archive(parts));
    expect(workbook.sheets).toEqual([{ name: 'S', rows: [['1']] }]);
    expect(resolvePartPath('xl/', 'worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
    expect(resolvePartPath('xl/', '/xl/sharedStrings.xml')).toBe('xl/sharedStrings.xml');
    expect(resolvePartPath('a/b/', '../c/./d.xml')).toBe('a/c/d.xml');
  });

  it('reads a workbook that prefixes the main namespace', async () => {
    const parts = excelLike(
      `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row x:r="1"><x:c x:r="A1" x:t="inlineStr"><x:is><x:t>p</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`,
    );
    expect((await read(archive(parts))).sheets[0]?.rows).toEqual([['p']]);
  });
});

describe('readWorkbook refusals', () => {
  it('refuses input that is not a zip, and an encrypted workbook', async () => {
    expect((await refusal(() => read(encoder.encode('Investment,Value\nINV-1,10\n')))).code).toBe(
      'not_zip',
    );
    const ole = new Uint8Array(1024);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const error = await refusal(() => read(ole));
    expect(error.code).toBe('encrypted');
    expect(error.message).toBe(
      'The file is an encrypted workbook or an old binary Excel file; save it as an unencrypted .xlsx',
    );
  });

  it('refuses a zip without a workbook part', async () => {
    const error = await refusal(() => read(archive({ 'readme.txt': 'not a workbook' })));
    expect(error.code).toBe('missing_part');
    expect(error.message).toBe(
      'The file has no workbook part (xl/workbook.xml), so it is not an Excel workbook',
    );
  });

  it('refuses a workbook whose relationships, sheet part or shared strings part is missing', async () => {
    const base = excelLike(SHEET, SHARED_STRINGS);
    const { 'xl/_rels/workbook.xml.rels': _rels, ...withoutRels } = base;
    expect((await refusal(() => read(archive(withoutRels)))).code).toBe('missing_part');
    const { 'xl/worksheets/sheet1.xml': _sheet, ...withoutSheet } = base;
    const sheet = await refusal(() => read(archive(withoutSheet)));
    expect(sheet.code).toBe('missing_part');
    expect(sheet.message).toBe(
      'Sheet Data points at xl/worksheets/sheet1.xml, which is not in the file',
    );
    const { 'xl/sharedStrings.xml': _strings, ...withoutStrings } = base;
    expect((await refusal(() => read(archive(withoutStrings)))).code).toBe('missing_part');
  });

  it('refuses a sheet past the cell limit, counting each row as one slot plus its cells', async () => {
    const sheets = [
      {
        name: 'S',
        rows: [
          ['a', 'b', 'c', 'd'],
          ['e', 'f', 'g', 'h'],
          ['i', 'j', 'k', 'l'],
        ],
      },
    ];
    const bytes = writeWorkbook(sheets);
    expect((await read(bytes, { maxCells: 15 })).sheets[0]?.rows).toHaveLength(3);
    const error = await refusal(() => read(bytes, { maxCells: 14 }));
    expect(error.code).toBe('too_large');
    expect(error.message).toBe('Sheet S has more than 14 cells');
    expect(READ_LIMITS.maxCells).toBe(200_000);
  });

  it('refuses a far-away cell reference before filling the grid up to it', async () => {
    const far = `<worksheet xmlns="${NS}"><sheetData><row r="1000000"><c r="XFD1000000"><v>1</v></c></row></sheetData></worksheet>`;
    const error = await refusal(() => read(archive(excelLike(far))));
    expect(error.code).toBe('too_large');
    const wide = `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="XFD1"><v>1</v></c></row></sheetData></worksheet>`;
    expect((await read(archive(excelLike(wide)))).sheets[0]?.rows[0]).toHaveLength(16_384);
    expect((await refusal(() => read(archive(excelLike(wide)), { maxCells: 16_000 }))).code).toBe(
      'too_large',
    );
  });

  it('refuses a part deeper than the nesting limit and a part larger than the part limit', async () => {
    const bytes = archive(excelLike(SHEET, SHARED_STRINGS));
    const deep = await refusal(() => read(bytes, { maxDepth: 3 }));
    expect(deep.code).toBe('too_large');
    expect(deep.message).toContain('nests elements deeper than 3 levels');
    const large = await refusal(() => read(bytes, { maxPartBytes: 100 }));
    expect(large.code).toBe('too_large');
    expect(large.message).toContain('more than the 100 the reader accepts');
  });

  it('refuses cells it does not understand rather than guessing', async () => {
    const cell = async (xml: string, strings?: string): Promise<WorkbookError> =>
      refusal(() =>
        read(
          archive(
            excelLike(
              `<worksheet xmlns="${NS}"><sheetData><row r="1">${xml}</row></sheetData></worksheet>`,
              strings,
            ),
          ),
        ),
      );
    const unknown = await cell('<c r="A1" t="x"><v>1</v></c>');
    expect(unknown.code).toBe('malformed');
    expect(unknown.message).toBe(
      'Cell A1 on sheet Data has a type the reader does not understand: x',
    );
    expect((await cell('<c r="A1" t="s"><v>7</v></c>', SHARED_STRINGS)).message).toBe(
      'Cell A1 on sheet Data points at shared string 7, which the workbook does not have',
    );
    expect((await cell('<c r="A1" t="s"><v>x</v></c>', SHARED_STRINGS)).code).toBe('malformed');
    expect((await cell('<c r="A1" t="b"><v>yes</v></c>')).message).toBe(
      'Cell A1 on sheet Data holds yes where a boolean cell holds 0 or 1',
    );
    expect((await cell('<c r="A2"><v>1</v></c>')).message).toBe(
      'Sheet Data places cell A2 in row 1',
    );
    expect((await cell('<c r="A1"><v>1</v></c><c r="A1"><v>2</v></c>')).message).toBe(
      'Sheet Data holds cell A1 twice',
    );
    expect((await cell('<c r="1A"><v>1</v></c>')).message).toContain(
      'not a reference Excel accepts',
    );
    const row = await refusal(() =>
      read(
        archive(
          excelLike(`<worksheet xmlns="${NS}"><sheetData><row r="0"/></sheetData></worksheet>`),
        ),
      ),
    );
    expect(row.message).toBe('Sheet Data has a row numbered "0"');
  });

  it('refuses a part that is not well-formed, a sheet of a kind it does not know, and a bad sheet list', async () => {
    const broken = await refusal(() =>
      read(archive(excelLike('<worksheet><sheetData></worksheet>'))),
    );
    expect(broken.code).toBe('malformed');
    expect(broken.message).toContain('xl/worksheets/sheet1.xml is not well-formed XML');
    const dialog = await refusal(() => read(archive(excelLike('<dialogsheet/>'))));
    expect(dialog.code).toBe('unsupported');
    expect(dialog.message).toBe(
      'Sheet Data is a dialogsheet, which the reader does not understand',
    );
    const parts = excelLike(SHEET);
    parts['xl/workbook.xml'] =
      `<workbook xmlns="${NS}"><sheets><sheet name="NoId" sheetId="1"/></sheets></workbook>`;
    expect((await refusal(() => read(archive(parts)))).code).toBe('malformed');
    parts['xl/workbook.xml'] =
      `<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets><sheet name="Lost" sheetId="1" r:id="rId9"/></sheets></workbook>`;
    const lost = await refusal(() => read(archive(parts)));
    expect(lost.message).toBe(
      'Sheet Lost points at relationship rId9, which the workbook does not define',
    );
    parts['xl/workbook.xml'] = `<notes xmlns="${NS}"/>`;
    expect((await refusal(() => read(archive(parts)))).message).toBe(
      'xl/workbook.xml is not a workbook part',
    );
  });
});
