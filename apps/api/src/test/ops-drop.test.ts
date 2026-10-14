import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
});
