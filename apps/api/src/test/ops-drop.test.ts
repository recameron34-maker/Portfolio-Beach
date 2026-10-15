import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  intakeExportList,
  intakeFileDetail,
  intakeFilePage,
  intakeImportResult,
} from '@pb/contracts';
import { problemDetails } from '@pb/contracts';
import type { IntakeFileDetail, IntakeImportResult, IntakeRow } from '@pb/contracts';
import { OPS_DROP_FIGURES_HEADER, opsDropSheets, opsDropWorkbook } from '@pb/synthetic';
import type { OpsDropWorkbook } from '@pb/synthetic';
import { writeWorkbook } from '@pb/xlsx';
import { startHarness } from './harness.js';

/** The limits the API reads from config/definitions.json, so the tests cross them by one. */
const definitions = z
  .object({
    intake: z.object({
      maxWorkbookBase64Chars: z.number().int(),
      workbookMaxSheets: z.number().int(),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('../../../../config/definitions.json', import.meta.url), 'utf8'),
    ),
  );
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const TEMPLATE = 'quarterly-figures';

/*
 * A workbook built by hand, cell by cell, for what the XLSX writer never writes: a typed numeric
 * cell. The parts are zipped stored (method 0), the shape readWorkbook opens; the zip writer of
 * @pb/xlsx is private to it, so the few header fields a stored archive needs are written here.
 */
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const column = (i: number): string => String.fromCharCode(65 + i);
/** An inline string cell, as the writer stores every cell. */
const inlineCell = (ref: string, text: string): string =>
  `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
/** A typed numeric cell, as Excel stores a number or a date (a serial day count). */
const numberCell = (ref: string, value: string): string =>
  `<c r="${ref}" t="n"><v>${value}</v></c>`;
const sheetXml = (rows: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}"><sheetData>` +
  rows.map((cells, i) => `<row r="${i + 1}">${cells}</row>`).join('') +
  '</sheetData></worksheet>';
const REL = (id: string, kind: string, target: string): string =>
  `<Relationship Id="${id}" Type="${NS_R}/${kind}" Target="${target}"/>`;
/** The parts of a two-sheet workbook (Figures, Notes) as Excel lays them out, with the sheet XML given. */
function workbookParts(figures: string, notes: string): Record<string, string> {
  return {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': `<Relationships xmlns="${NS_PR}">${REL('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`,
    'xl/workbook.xml':
      `<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets>` +
      '<sheet name="Figures" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Notes" sheetId="2" r:id="rId2"/>' +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      `<Relationships xmlns="${NS_PR}">` +
      REL('rId1', 'worksheet', 'worksheets/sheet1.xml') +
      REL('rId2', 'worksheet', 'worksheets/sheet2.xml') +
      '</Relationships>',
    'xl/worksheets/sheet1.xml': figures,
    'xl/worksheets/sheet2.xml': notes,
  };
}
/** A stored zip of the parts given, in order: local headers, the central directory, the end record. */
function storedZip(parts: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(parts)) {
    const name = encoder.encode(path);
    const data = encoder.encode(text);
    const crc = crc32(data);
    const header = new Uint8Array(30);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    const entry = new Uint8Array(46);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    local.push(header, name, data);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, central.length / 2, true);
  e.setUint16(10, central.length / 2, true);
  e.setUint32(12, directory.length, true);
  e.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

describe('ops-drop intake (M2 ops-drop-import, SEC-9.1): workbooks by template signature onto the accounting layout', () => {
  let h: Harness;
  let clean: OpsDropWorkbook;
  let update: OpsDropWorkbook;
  let defects: OpsDropWorkbook;
  let unknown: OpsDropWorkbook;
  let cleanFile: IntakeImportResult;
  let defectsFile: IntakeImportResult;
  let unknownFile: IntakeImportResult;

  beforeAll(async () => {
    h = await startHarness();
    clean = opsDropWorkbook(h.dataset, { scenario: 'clean' });
    update = opsDropWorkbook(h.dataset, { scenario: 'update' });
    defects = opsDropWorkbook(h.dataset, { scenario: 'defects' });
    unknown = opsDropWorkbook(h.dataset, { scenario: 'unknown-template' });
  });
  afterAll(async () => {
    await h.close();
  });

  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql, params))[0]!.n;
  const files = (): Promise<number> => count('select count(*)::int as n from stg.intake_file');
  const stagedRows = (): Promise<number> => count('select count(*)::int as n from stg.intake_row');
  const productionRows = (): Promise<number> =>
    count('select count(*)::int as n from mon.quarterly_performance');
  const auditCount = (action: string, requestId: string): Promise<number> =>
    count('select count(*)::int as n from audit.event where action = $1 and request_id = $2', [
      action,
      requestId,
    ]);
  const investmentByNumber = (n: string) =>
    h.dataset.investments.find((i) => i.investmentNumber === n)!;
  /** The Figures sheet's data cells by line and header cell, as the workbook holds them. */
  const cellOf = (file: OpsDropWorkbook, rowNo: number, header: string): string => {
    const figures = opsDropSheets(h.dataset, { scenario: file.scenario }).sheets[0]!;
    return figures.rows[rowNo]![OPS_DROP_FIGURES_HEADER.indexOf(header)] ?? '';
  };

  const importAs = (who: string, body: object, requestId = 'req-ops-drop-import') =>
    h
      .http()
      .post('/api/v1/intake/ops-drop')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const stage = async (
    file: OpsDropWorkbook,
    requestId = 'req-ops-drop-import',
    fileName = file.fileName,
  ): Promise<IntakeImportResult> =>
    intakeImportResult.parse(
      (
        await importAs(
          'operations',
          { fileName, workbookBase64: base64(file.bytes) },
          requestId,
        ).expect(201)
      ).body,
    );
  const detail = async (who: string, id: string): Promise<IntakeFileDetail> =>
    intakeFileDetail.parse(
      (await h.http().get(`/api/v1/intake/files/${id}`).set('authorization', h.as(who)).expect(200))
        .body,
    );
  const command = (who: string, id: string, body: object, requestId = 'req-ops-drop-command') =>
    h
      .http()
      .post(`/api/v1/intake/files/${id}/commands`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  /** The file as a wall member sees it: every row (head.one is an approver on the wall). */
  const fullView = (id: string): Promise<IntakeFileDetail> => detail('head.one', id);
  const rowNo = (file: IntakeFileDetail, n: number): IntakeRow =>
    file.rows.find((r) => r.rowNo === n)!;

  it('lets only operations import a workbook or list the drop folder', async () => {
    for (const who of ['viewer', 'deal_team', 'approver', 'auditor', 'platform_admin']) {
      const res = await importAs(who, {
        fileName: clean.fileName,
        workbookBase64: base64(clean.bytes),
      }).expect(403);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}forbidden`);
      await h
        .http()
        .get('/api/v1/intake/ops-drop/drops')
        .set('authorization', h.as(who))
        .expect(403);
    }
    expect(await files()).toBe(0);
  });

  it('answers a malformed body with a 400 validation problem that carries paths only', async () => {
    const marker = 'MARKER-NEVER-ECHOED-0011';
    for (const body of [
      {},
      { fileName: 'book.xlsx' },
      { fileName: 'book.xlsx', workbookBase64: base64(clean.bytes), dropId: marker },
      { dropId: marker, fileName: 'book.xlsx' },
      { fileName: 'book.xlsx', workbookBase64: '' },
    ]) {
      const res = await importAs('operations', body).expect(400);
      const problem = problemDetails.parse(res.body);
      expect(problem.type).toBe(`${PROBLEM}validation`);
      expect(problem.errors?.length).toBeGreaterThan(0);
      for (const e of problem.errors ?? [])
        expect(Object.keys(e).sort()).toEqual(['message', 'path']);
      expect(JSON.stringify(res.body)).not.toContain(marker);
    }
    expect(await files()).toBe(0);
  });

  it('refuses an upload past the configured base64 limit before reading it', async () => {
    const limit = definitions.intake.maxWorkbookBase64Chars;
    const res = await importAs('operations', {
      fileName: 'big.xlsx',
      workbookBase64: 'A'.repeat(limit + 1),
    }).expect(400);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}validation`);
    expect(problem.errors?.map((e) => e.path)).toContain('workbookBase64');
    expect(await files()).toBe(0);
  });

  it('refuses bytes that are not a workbook with a plain 422 detail, and a workbook past a read limit with a 413', async () => {
    const notZip = await importAs('operations', {
      fileName: 'notes.xlsx',
      workbookBase64: Buffer.from('InvestmentNumber,PeriodEnd\nINV-0001,2025-06-30\n').toString(
        'base64',
      ),
    }).expect(422);
    const refused = problemDetails.parse(notZip.body);
    expect(refused.type).toBe(`${PROBLEM}workbook-refused`);
    expect(refused.detail).toBe('The file is not a zip archive, so not an .xlsx workbook');
    // More sheets than intake.workbookMaxSheets allows: the parser stops before reading them.
    const tooMany = writeWorkbook(
      Array.from({ length: definitions.intake.workbookMaxSheets + 1 }, (_, i) => ({
        name: `Sheet${i + 1}`,
        rows: [['x']],
      })),
    );
    const large = await importAs('operations', {
      fileName: 'many-sheets.xlsx',
      workbookBase64: base64(tooMany),
    }).expect(413);
    const problem = problemDetails.parse(large.body);
    expect(problem.type).toBe(`${PROBLEM}too-large`);
    expect(problem.detail).toContain(`more than the ${definitions.intake.workbookMaxSheets}`);
    expect(await files()).toBe(0);
    expect(await stagedRows()).toBe(0);
  });

  it('stages the clean workbook: every row read as text through the template, matched, unchanged and validated; production untouched', async () => {
    const before = await productionRows();
    cleanFile = await stage(clean, 'req-ops-drop-clean-1');
    expect(cleanFile.duplicate).toBe(false);
    expect(cleanFile.source).toBe('ops_drop');
    expect(cleanFile.templateSignature).toBe(TEMPLATE);
    expect(cleanFile.fileName).toBe(clean.fileName);
    expect(cleanFile.receivedBy).toBe(user('ops.one').displayName);
    expect(cleanFile.rowCount).toBe(clean.expectations.rows);
    expect(cleanFile.fileFindings).toEqual([]);
    // The importer is outside the wall: the walled position's row links all the same and is
    // left out of their view and counted (decision 0009, SEC-5.3).
    expect(cleanFile.hiddenRows).toBe(clean.expectations.walled.length);
    const everyRow = (await fullView(cleanFile.id)).rows;
    expect(everyRow.length).toBe(clean.expectations.rows);
    for (const row of everyRow) {
      expect(row.link.status, `row ${row.rowNo}`).toBe('matched');
      expect(row.link.investmentId).toBe(investmentByNumber(row.investmentNumber!).id);
      expect(row.diff).toEqual({ kind: 'unchanged', changes: [] });
      expect(row.status).toBe('validated');
      expect(row.findings.some((f) => f.severity === 'error')).toBe(false);
      // Each cell arrives as the workbook stored it, under the accounting layout's column names.
      expect(row.investmentNumber).toBe(cellOf(clean, row.rowNo, 'Investment number'));
      expect(row.periodEnd).toBe(cellOf(clean, row.rowNo, 'Period end'));
      expect(row.figures.revenueLtm).toBe(cellOf(clean, row.rowNo, 'Revenue LTM'));
      // A blank cell is null on the row, as the accounting reader reads a blank CSV cell.
      expect(row.figures.fairValue ?? '').toBe(cellOf(clean, row.rowNo, 'Fair value'));
      expect(row.naturalKey).toBe(`${row.investmentNumber}|${row.periodEnd}`);
    }
    expect(cleanFile.status).toBe('validated');
    expect(cleanFile.counts.validated).toBe(clean.expectations.rows);
    expect(cleanFile.exceptions).toBe(0);
    expect(await productionRows()).toBe(before);
    expect(await stagedRows()).toBe(clean.expectations.rows);
    // One audit event naming the template, with counts only: no cell travels into the trail.
    expect(await auditCount('intake.import', 'req-ops-drop-clean-1')).toBe(1);
    const [event] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
      "select details from audit.event where action = 'intake.import' and request_id = 'req-ops-drop-clean-1'",
    );
    expect(Object.keys(event!.details).sort()).toEqual([
      'counts',
      'fileName',
      'rowCount',
      'templateSignature',
    ]);
    expect(event!.details.templateSignature).toBe(TEMPLATE);
    expect(JSON.stringify(event!.details)).not.toContain(cellOf(clean, 1, 'Revenue LTM'));
  });

  it('answers the same bytes again, under any name, with the file staged before and stages nothing', async () => {
    const fileCount = await files();
    const rows = await stagedRows();
    const again = await stage(clean, 'req-ops-drop-duplicate-1', 'renamed-copy.xlsx');
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(cleanFile.id);
    expect(again.fileName).toBe(clean.fileName);
    expect(again.contentHash).toBe(cleanFile.contentHash);
    expect(await files()).toBe(fileCount);
    expect(await stagedRows()).toBe(rows);
    expect(await auditCount('intake_file.read', 'req-ops-drop-duplicate-1')).toBe(1);
    expect(await auditCount('intake.import', 'req-ops-drop-duplicate-1')).toBe(0);
  });

  it('stages the defects workbook: each defect row is flagged by the rule the accounting expectations name, exceptions open for the ops drop', async () => {
    defectsFile = await stage(defects, 'req-ops-drop-defects-1');
    expect(defectsFile.templateSignature).toBe(TEMPLATE);
    const full = await fullView(defectsFile.id);
    expect(full.rows.length).toBe(defects.expectations.rows);
    expect(defects.expectations.flagged.length).toBeGreaterThanOrEqual(6);
    for (const { rowNo: n, ruleId } of defects.expectations.flagged) {
      const row = rowNo(full, n);
      expect(row.status, `row ${n} (${ruleId})`).toBe('flagged');
      expect(
        row.findings.map((f) => f.ruleId),
        `row ${n}`,
      ).toContain(ruleId);
    }
    const unmatched = full.rows.filter((r) => r.link.status === 'unmatched');
    const guarded = full.rows.filter((r) => r.link.status === 'guarded');
    const ties = full.rows.flatMap((r) => r.findings.filter((f) => f.ruleId === 'TIE-01'));
    expect(unmatched.length).toBe(2);
    expect(guarded.length).toBe(1);
    expect(ties.length).toBe(1);
    expect(defectsFile.exceptions).toBe(unmatched.length + guarded.length + ties.length);
    const opened = await h.runtime.db.query<{ source: string; rule_id: string; state: string }>(
      `select x.source, x.rule_id, x.state
       from ops.data_exception x join stg.intake_row r on r.id = x.entity_id
       where x.entity = 'stg.intake_row' and r.intake_file_id = $1 order by r.row_no`,
      [defectsFile.id],
    );
    expect(opened.length).toBe(defectsFile.exceptions);
    expect(opened.every((x) => x.source === 'ops_drop_import' && x.state === 'open')).toBe(true);
    expect(opened.map((x) => x.rule_id).sort()).toEqual(
      ['XREF-01', 'XREF-01', 'XREF-02', 'TIE-01'].sort(),
    );
    expect(defectsFile.status).toBe('flagged');
  });

  it('refuses a workbook that matches no template: LAYOUT-05 names the templates, the sheets and the header hash, never a cell', async () => {
    const rows = await stagedRows();
    unknownFile = await stage(unknown, 'req-ops-drop-unknown-1');
    expect(unknownFile.duplicate).toBe(false);
    expect(unknownFile.source).toBe('ops_drop');
    expect(unknownFile.templateSignature).toBeNull();
    expect(unknownFile.status).toBe('new');
    expect(unknownFile.rowCount).toBe(0);
    expect(unknownFile.rows).toEqual([]);
    expect(unknownFile.exceptions).toBe(0);
    expect(unknownFile.fileFindings).toHaveLength(1);
    const finding = unknownFile.fileFindings[0]!;
    expect(finding.ruleId).toBe('LAYOUT-05');
    expect(finding.severity).toBe('error');
    expect(finding.message).toBe('No template matches this workbook');
    expect(finding.field).toBeNull();
    expect(finding.expected).toBe(TEMPLATE);
    expect(finding.actual).toContain('sheets: Figures, Notes');
    expect(finding.actual).toMatch(/header hash: [0-9a-f]{64} \(Figures\)/);
    // The signature is reported as a hash: no header cell and no data cell of the workbook
    // travels in the findings (the file name is the uploader's, not the workbook's).
    const figures = opsDropSheets(h.dataset, { scenario: 'unknown-template' }).sheets[0]!;
    const findings = JSON.stringify(unknownFile.fileFindings);
    for (const cell of figures.rows[0]!) expect(findings).not.toContain(cell);
    for (const cell of figures.rows[1]!) expect(findings).not.toContain(cell);
    expect(unknownFile.rows).toEqual([]);
    expect(await stagedRows()).toBe(rows);
    expect(await auditCount('intake.import', 'req-ops-drop-unknown-1')).toBe(1);
    // The same bytes again are read again (a template may have been added meanwhile) and,
    // refused again, answer the file the refusal left behind.
    const again = await stage(unknown, 'req-ops-drop-unknown-2');
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(unknownFile.id);
    expect(again.status).toBe('new');
    expect(again.fileFindings.map((f) => f.ruleId)).toEqual(['LAYOUT-05']);
  });

  it('lists ops-drop files with their template among every intake file, filtered by source, to the reviewing roles', async () => {
    const list = async (who: string, query = '') =>
      intakeFilePage.parse(
        (
          await h
            .http()
            .get(`/api/v1/intake/files${query}`)
            .set('authorization', h.as(who))
            .expect(200)
        ).body,
      );
    const all = await list('auditor', '?limit=50');
    expect(all.items.map((f) => f.id)).toEqual([unknownFile.id, defectsFile.id, cleanFile.id]);
    expect(all.items.map((f) => f.source)).toEqual(['ops_drop', 'ops_drop', 'ops_drop']);
    expect(all.items.map((f) => f.templateSignature)).toEqual([null, TEMPLATE, TEMPLATE]);
    const byDrop = await list('deal_team', '?source=ops_drop');
    expect(byDrop.items.length).toBe(3);
    expect((await list('operations', '?source=accounting')).items).toEqual([]);
    for (const who of ['viewer', 'investor_relations', 'platform_admin'])
      await h.http().get('/api/v1/intake/files').set('authorization', h.as(who)).expect(403);
  });

  it('the deal team approves the clean workbook through the intake commands: promoted with lineage to the file and row, audited', async () => {
    const before = await productionRows();
    const visible = await detail('deal.one', cleanFile.id);
    const toPromote = visible.rows.filter((r) => r.status === 'validated');
    expect(toPromote.length).toBe(clean.expectations.rows - clean.expectations.walled.length);
    const res = await command(
      'deal_team',
      cleanFile.id,
      { command: 'approve' },
      'req-ops-drop-approve-1',
    ).expect(200);
    const after = intakeFileDetail.parse(res.body);
    const now = h.runtime.adapters.clock.now();
    for (const row of after.rows) {
      expect(row.status, `row ${row.rowNo}`).toBe('promoted');
      expect(row.promotedAt).toBe(now);
      expect(row.decidedBy).toBe(user('deal.one').displayName);
      expect(row.decision).toBe(`ops drop import ${clean.fileName}`);
    }
    expect(after.counts.promoted).toBe(toPromote.length);
    expect(after.counts.validated).toBe(clean.expectations.walled.length);
    // Unchanged figures: nothing new on record, but every promoted quarter now carries the
    // workbook as its lineage, by file and row (SEC-9.4).
    expect(await productionRows()).toBe(before);
    const sample = after.rows[0]!;
    const [record] = await h.runtime.db.query<{
      source_locator: string | null;
      approval_reason: string | null;
      approved_by: string | null;
    }>(
      'select source_locator, approval_reason, approved_by from mon.quarterly_performance where id = $1',
      [sample.targetId],
    );
    expect(record!.source_locator).toBe(`intake_file:${cleanFile.id}/row:${sample.rowNo}`);
    expect(record!.approval_reason).toBe(`ops drop import ${clean.fileName}`);
    expect(record!.approved_by).toBe(user('deal.one').id);
    expect(await auditCount('quarterly_performance.promote', 'req-ops-drop-approve-1')).toBe(
      toPromote.length,
    );
    expect(await auditCount('intake.approve', 'req-ops-drop-approve-1')).toBe(1);
    // A wall member finishes the file.
    const finished = intakeFileDetail.parse(
      (await command('deal.three', cleanFile.id, { command: 'approve' }).expect(200)).body,
    );
    expect(finished.counts.promoted).toBe(clean.expectations.rows);
    expect(finished.status).toBe('promoted');
  });

  it('keeps the sheet row numbering across a blank separator row: the blank row stages flagged, the rows below keep their numbers and their lineage', async () => {
    const sample = opsDropSheets(h.dataset, { scenario: 'clean' });
    const figures = sample.sheets[0]!;
    // A blank row between the first and the second row of figures, and a cell past the header on
    // the last row: every sheet row below the header becomes one data line of the header's width.
    const rows = [figures.rows[0]!, figures.rows[1]!, [], ...figures.rows.slice(2)];
    const lastLine = rows.length - 1;
    rows[lastLine] = [...rows[lastLine]!, 'a note past the last column'];
    const bytes = writeWorkbook([{ name: figures.name, rows }, sample.sheets[1]!]);
    const staged = intakeImportResult.parse(
      (
        await importAs(
          'operations',
          { fileName: 'separator.xlsx', workbookBase64: base64(bytes) },
          'req-ops-drop-separator-1',
        ).expect(201)
      ).body,
    );
    expect(staged.templateSignature).toBe(TEMPLATE);
    expect(staged.rowCount).toBe(clean.expectations.rows + 1);
    const full = await fullView(staged.id);
    expect(full.rows.map((r) => r.rowNo)).toEqual(rows.slice(1).map((_, i) => i + 1));
    // Data line n is sheet row n + 1 for every row: the blank row is line 2, flagged for what it
    // lacks, and the second row of figures is line 3, not line 2.
    const blank = rowNo(full, 2);
    expect(blank.investmentNumber).toBeNull();
    expect(blank.companyName).toBeNull();
    expect(blank.periodEnd).toBeNull();
    expect(blank.status).toBe('flagged');
    expect(blank.findings.map((f) => f.ruleId)).toEqual(
      expect.arrayContaining(['REQ-01', 'REQ-02', 'REQ-03']),
    );
    for (let line = 3; line <= lastLine; line += 1) {
      const row = rowNo(full, line);
      expect(row.investmentNumber, `line ${line}`).toBe(rows[line]![0]);
      expect(row.periodEnd, `line ${line}`).toBe(rows[line]![2]);
      expect(row.figures.revenueLtm, `line ${line}`).toBe(rows[line]![3]);
    }
    // The cell past the header is dropped knowingly: the last row reads like the others.
    const last = rowNo(full, lastLine);
    expect(last.status).toBe('validated');
    expect(JSON.stringify(full)).not.toContain('a note past the last column');
    // Promoted, the lineage names the sheet row the figures came from (SEC-9.4).
    const approved = intakeFileDetail.parse(
      (
        await command('deal.three', staged.id, { command: 'approve', rowIds: [last.id] }).expect(
          200,
        )
      ).body,
    );
    const promoted = rowNo(approved, lastLine);
    expect(promoted.status).toBe('promoted');
    const [record] = await h.runtime.db.query<{ source_locator: string | null }>(
      'select source_locator from mon.quarterly_performance where id = $1',
      [promoted.targetId],
    );
    expect(record!.source_locator).toBe(`intake_file:${staged.id}/row:${lastLine}`);
  });

  it('reads a typed numeric cell as the number it holds and a serial date as the number it is, which the date rule refuses', async () => {
    // The template's header as inline strings, then one row with the figure and the period end
    // typed as numbers, the way Excel stores a number and a date (a serial day count).
    const number = cellOf(clean, 1, 'Investment number');
    const company = cellOf(clean, 1, 'Company');
    const header = OPS_DROP_FIGURES_HEADER.map((cell, i) => inlineCell(`${column(i)}1`, cell)).join(
      '',
    );
    const line =
      inlineCell('A2', number) +
      inlineCell('B2', company) +
      numberCell('C2', '45838') +
      numberCell('D2', '12345.5') +
      inlineCell('E2', '1000.00') +
      inlineCell('F2', '50000.00') +
      inlineCell('G2', '2500.00') +
      inlineCell('H2', '');
    const bytes = storedZip(
      workbookParts(sheetXml([header, line]), sheetXml([inlineCell('A1', 'Prepared by hand')])),
    );
    const staged = intakeImportResult.parse(
      (
        await importAs(
          'operations',
          { fileName: 'typed-cells.xlsx', workbookBase64: base64(bytes) },
          'req-ops-drop-typed-1',
        ).expect(201)
      ).body,
    );
    expect(staged.templateSignature).toBe(TEMPLATE);
    expect(staged.rowCount).toBe(1);
    const [row] = (await fullView(staged.id)).rows;
    expect(row!.investmentNumber).toBe(number);
    expect(row!.link.status).toBe('matched');
    // The number arrives as its text, never rounded or reformatted (CLAUDE.md rule 10).
    expect(row!.figures.revenueLtm).toBe('12345.5');
    expect(row!.figures.ebitdaLtm).toBe('1000.00');
    // Read as a decimal: the unit floor (TYPE-04) may question its size, never its form (TYPE-05).
    expect(row!.findings.some((f) => f.ruleId === 'TYPE-05')).toBe(false);
    expect(row!.findings.find((f) => f.ruleId === 'TYPE-04')?.actual).toBe('12345.50');
    // A serial date is a number, not a date of the layout's form: TYPE-01 names the cell as read.
    expect(row!.periodEnd).toBe('45838');
    expect(row!.status).toBe('flagged');
    const typed = row!.findings.find((f) => f.ruleId === 'TYPE-01');
    expect(typed?.field).toBe('PeriodEnd');
    expect(typed?.actual).toBe('45838');
    expect(typed?.expected).toBe('YYYY-MM-DD');
    expect(row!.naturalKey).toBe(`${number}|45838`);
  });

  it('lists the drop folder and imports a workbook by id; an unknown id is not found', async () => {
    const inbox = join(h.runtime.config.PB_DROP_ROOT, 'ops-drop', 'in');
    mkdirSync(inbox, { recursive: true });
    for (const file of [clean, update, defects, unknown])
      writeFileSync(join(inbox, file.fileName), file.bytes);
    writeFileSync(join(inbox, 'notes.txt'), 'not a workbook');
    const listed = intakeExportList.parse(
      (
        await h
          .http()
          .get('/api/v1/intake/ops-drop/drops')
          .set('authorization', h.as('operations'))
          .expect(200)
      ).body,
    );
    expect(listed.items.map((e) => e.name).sort()).toEqual(
      [clean.fileName, update.fileName, defects.fileName, unknown.fileName].sort(),
    );
    // The same bytes as the upload earlier: the drop folder import is the same file.
    const same = intakeImportResult.parse(
      (await importAs('operations', { dropId: clean.fileName }).expect(201)).body,
    );
    expect(same.duplicate).toBe(true);
    expect(same.id).toBe(cleanFile.id);
    // New content: staged and validated against the record, named as the folder lists it.
    const staged = intakeImportResult.parse(
      (await importAs('operations', { dropId: update.fileName }).expect(201)).body,
    );
    expect(staged.duplicate).toBe(false);
    expect(staged.fileName).toBe(update.fileName);
    expect(staged.templateSignature).toBe(TEMPLATE);
    expect(staged.rows.length + staged.hiddenRows).toBe(update.expectations.rows);
    expect(staged.status).toBe('validated');
    const changed = new Set(update.expectations.changed);
    expect(
      staged.rows.filter((r) => changed.has(r.investmentNumber!) && r.diff.kind === 'changed')
        .length,
    ).toBeGreaterThan(0);
    for (const dropId of ['missing.xlsx', '../missing.xlsx', 'in', 'notes.txt']) {
      const res = await importAs('operations', { dropId }).expect(404);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}not-found`);
    }
  });

  it('refuses a drop-folder workbook larger than the configured limit with a 413 before reading it, and stages nothing', async () => {
    const inbox = join(h.runtime.config.PB_DROP_ROOT, 'ops-drop', 'in');
    mkdirSync(inbox, { recursive: true });
    // One byte past the bytes the base64 limit allows: never parsed, never staged.
    const limit = Math.floor((definitions.intake.maxWorkbookBase64Chars * 3) / 4);
    writeFileSync(join(inbox, 'oversized.xlsx'), Buffer.alloc(limit + 1, 0x50));
    const before = await files();
    const res = await importAs('operations', { dropId: 'oversized.xlsx' }).expect(413);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}too-large`);
    expect(problem.detail).toBe('The workbook is larger than one import accepts');
    expect(await files()).toBe(before);
  });
});
