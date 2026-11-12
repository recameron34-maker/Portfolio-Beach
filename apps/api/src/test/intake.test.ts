import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, addMonths, containingQuarterEnd, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  intakeExportList,
  intakeFileDetail,
  intakeFilePage,
  intakeImportResult,
  lookthroughReconcileResult,
  problemDetails,
  weeklyImportResult,
} from '@pb/contracts';
import type { IntakeFileDetail, IntakeImportResult, IntakeRow } from '@pb/contracts';
import type { Tx } from '@pb/db';
import {
  accountingExport,
  accountingExports,
  lookthroughExtract,
  weeklyValues,
} from '@pb/synthetic';
import type { AccountingExport } from '@pb/synthetic';
import { accountingLayout, parseCsv } from '@pb/validation';
import { IntakeService } from '../intake/intake.service.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

interface QuarterOnRecord extends Record<string, unknown> {
  id: string;
  revenue_ltm: string | null;
  ebitda_ltm: string | null;
  ev: string | null;
  net_debt: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  approval_reason: string | null;
  source_locator: string | null;
  is_entry_snapshot: boolean;
}

const PROBLEM = 'https://portfolio-beach.example/problems/';

describe('accounting intake (M2, SEC-9.1): staging, validation, approval, then production', () => {
  let h: Harness;
  let clean: AccountingExport;
  let update: AccountingExport;
  let defects: AccountingExport;
  let cleanFile: IntakeImportResult;
  let updateFile: IntakeImportResult;
  let defectsFile: IntakeImportResult;

  beforeAll(async () => {
    h = await startHarness();
    // No operations user is on the wall: ops.one imports from outside it, deal.three and head.one
    // are its members, deal.one and ops.two are outside it.
    clean = accountingExport(h.dataset, { scenario: 'clean' });
    update = accountingExport(h.dataset, { scenario: 'update' });
    defects = accountingExport(h.dataset, { scenario: 'defects' });
  });
  afterAll(async () => {
    await h.close();
  });

  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const walledCompanyName = (): string => {
    const inv = h.dataset.investments.find((i) => i.id === walledId())!;
    return h.dataset.portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId)!.name;
  };
  const periodEnd = (): string => latestQuarterEndOnOrBefore(h.dataset.asOf);
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql, params))[0]!.n;
  const stagedRows = (): Promise<number> => count('select count(*)::int as n from stg.intake_row');
  const productionRows = (): Promise<number> =>
    count('select count(*)::int as n from mon.quarterly_performance');
  const auditCount = (action: string, requestId: string): Promise<number> =>
    count('select count(*)::int as n from audit.event where action = $1 and request_id = $2', [
      action,
      requestId,
    ]);
  const onRecord = async (investmentId: string, period: string): Promise<QuarterOnRecord | null> =>
    (
      await h.runtime.db.query<QuarterOnRecord>(
        `select id, revenue_ltm::text as revenue_ltm, ebitda_ltm::text as ebitda_ltm, ev::text as ev,
                net_debt::text as net_debt, status, approved_by, approved_at::text as approved_at,
                approval_reason, source_locator, is_entry_snapshot
         from mon.quarterly_performance where investment_id = $1 and period_end = $2`,
        [investmentId, period],
      )
    )[0] ?? null;
  const investmentByNumber = (n: string) =>
    h.dataset.investments.find((i) => i.investmentNumber === n)!;
  const seededQuarter = (investmentId: string, period: string) =>
    h.dataset.quarterlyPerformance.find(
      (q) => q.investmentId === investmentId && q.periodEnd === period && !q.isEntrySnapshot,
    )!;
  /** A cell of the export as the file wrote it, by data line and column name. */
  const cellOf = (file: AccountingExport, rowNo: number, column: string): string => {
    const table = parseCsv(file.csv);
    return table.rows[rowNo - 1]![table.header.indexOf(column)] ?? '';
  };

  const importAs = (who: string, body: object, requestId = 'req-intake-import') =>
    h
      .http()
      .post('/api/v1/intake/accounting')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const stage = async (
    file: AccountingExport,
    requestId = 'req-intake-import',
  ): Promise<IntakeImportResult> =>
    intakeImportResult.parse(
      (
        await importAs('operations', { fileName: file.fileName, csv: file.csv }, requestId).expect(
          201,
        )
      ).body,
    );
  const detail = async (
    who: string,
    id: string,
    requestId = 'req-intake-detail',
  ): Promise<IntakeFileDetail> =>
    intakeFileDetail.parse(
      (
        await h
          .http()
          .get(`/api/v1/intake/files/${id}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );
  const command = (who: string, id: string, body: object, requestId = 'req-intake-command') =>
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
  const hasError = (row: IntakeRow): boolean => row.findings.some((f) => f.severity === 'error');

  it('lets only operations import; every other role is refused before anything is read', async () => {
    for (const who of ['viewer', 'deal_team', 'approver', 'auditor', 'platform_admin']) {
      const res = await importAs(who, { fileName: clean.fileName, csv: clean.csv }).expect(403);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}forbidden`);
    }
    expect(await stagedRows()).toBe(0);
  });

  it('answers a malformed body with a 400 validation problem that carries paths only', async () => {
    const marker = 'MARKER-NEVER-ECHOED-0001';
    for (const body of [
      {},
      { fileName: 'export.csv' },
      { fileName: 'export.csv', csv: clean.csv, extra: marker },
      { exportId: marker, fileName: 'x.csv' },
    ]) {
      const res = await importAs('operations', body).expect(400);
      const problem = problemDetails.parse(res.body);
      expect(problem.type).toBe(`${PROBLEM}validation`);
      expect(problem.errors?.length).toBeGreaterThan(0);
      for (const e of problem.errors ?? [])
        expect(Object.keys(e).sort()).toEqual(['message', 'path']);
      expect(JSON.stringify(res.body)).not.toContain(marker);
      expect(JSON.stringify(res.body)).not.toContain('InvestmentNumber');
    }
    expect(await stagedRows()).toBe(0);
  });

  it('stages a clean export: every row linked by number, unchanged and validated; production untouched', async () => {
    const before = await productionRows();
    cleanFile = await stage(clean, 'req-intake-clean-1');
    expect(cleanFile.duplicate).toBe(false);
    expect(cleanFile.source).toBe('accounting');
    expect(cleanFile.fileName).toBe(clean.fileName);
    expect(cleanFile.receivedBy).toBe(user('ops.one').displayName);
    expect(cleanFile.rowCount).toBe(clean.expectations.rows);
    // The importer is outside the wall: the walled position's row links all the same (never a
    // "no match") and is left out of their view and counted (decision 0009, SEC-5.3).
    expect(cleanFile.hiddenRows).toBe(clean.expectations.walled.length);
    expect(cleanFile.rows.length).toBe(clean.expectations.rows - clean.expectations.walled.length);
    expect(cleanFile.fileFindings).toEqual([]);
    const everyRow = (await fullView(cleanFile.id)).rows;
    expect(everyRow.length).toBe(clean.expectations.rows);
    // The sponsor that closes a few days early is in the file at its own period end, and its
    // row finds its quarter by the same tolerance (docs/08): unchanged, with its target set.
    const shifted = everyRow.filter((r) => r.periodEnd !== periodEnd());
    expect(shifted.length).toBe(1);
    for (const row of everyRow) {
      expect(row.link.status, `row ${row.rowNo}`).toBe('matched');
      expect(row.link.investmentNumber).toBe(row.investmentNumber);
      expect(row.link.investmentId).toBe(investmentByNumber(row.investmentNumber!).id);
      expect(row.link.candidates).toEqual([]);
      expect(row.diff).toEqual({ kind: 'unchanged', changes: [] });
      expect(row.targetId).toBe(seededQuarter(row.link.investmentId!, row.periodEnd!).id);
      expect(row.status).toBe('validated');
      expect(hasError(row), `row ${row.rowNo}`).toBe(false);
      expect(
        row.findings.map((f) => f.ruleId),
        `row ${row.rowNo}`,
      ).not.toContain('TIE-03');
      expect(row.naturalKey).toBe(`${row.investmentNumber}|${row.periodEnd}`);
      expect(row.decision).toBeNull();
      expect(row.promotedAt).toBeNull();
    }
    expect(cleanFile.status).toBe('validated');
    expect(cleanFile.counts).toEqual({
      new: 0,
      validated: clean.expectations.rows,
      flagged: 0,
      approved: 0,
      rejected: 0,
      promoted: 0,
    });
    expect(cleanFile.exceptions).toBe(0);
    // Nothing reaches production before approval (docs/04 M2 AC).
    expect(await productionRows()).toBe(before);
    expect(await stagedRows()).toBe(clean.expectations.rows);
    // One audit event with counts only: no figure from the file travels into the trail.
    expect(await auditCount('intake.import', 'req-intake-clean-1')).toBe(1);
    const [event] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
      "select details from audit.event where action = 'intake.import' and request_id = 'req-intake-clean-1'",
    );
    expect(Object.keys(event!.details).sort()).toEqual(['counts', 'fileName', 'rowCount']);
    expect(JSON.stringify(event!.details)).not.toContain(cellOf(clean, 1, 'RevenueLTM'));
  });

  it('answers the same content again with the file it staged before and stages nothing', async () => {
    const files = await count('select count(*)::int as n from stg.intake_file');
    const rows = await stagedRows();
    const exceptions = await count('select count(*)::int as n from ops.data_exception');
    const again = intakeImportResult.parse(
      (
        await importAs(
          'operations',
          { fileName: 'renamed-copy.csv', csv: clean.csv },
          'req-intake-duplicate-1',
        ).expect(201)
      ).body,
    );
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(cleanFile.id);
    expect(again.fileName).toBe(clean.fileName);
    expect(again.contentHash).toBe(cleanFile.contentHash);
    expect(await count('select count(*)::int as n from stg.intake_file')).toBe(files);
    expect(await stagedRows()).toBe(rows);
    expect(await count('select count(*)::int as n from ops.data_exception')).toBe(exceptions);
    // The answer carries the staged figures, so it is on record as a read of the file, the same
    // event GET writes, and never as an import.
    expect(await auditCount('intake_file.read', 'req-intake-duplicate-1')).toBe(1);
    expect(await auditCount('intake.import', 'req-intake-duplicate-1')).toBe(0);
    const [event] = await h.runtime.db.query<{ entity_id: string; details: unknown }>(
      "select entity_id, details from audit.event where action = 'intake_file.read' and request_id = 'req-intake-duplicate-1'",
    );
    expect(event!.entity_id).toBe(cleanFile.id);
    expect(event!.details).toEqual({});
  });

  it('stages an update export: the restated row and the supplied quarter carry their changes; production untouched', async () => {
    const before = await productionRows();
    updateFile = await stage(update, 'req-intake-update-1');
    expect(updateFile.duplicate).toBe(false);
    const everyRow = (await fullView(updateFile.id)).rows;
    expect(everyRow.length).toBe(update.expectations.rows);
    const changed = new Set(update.expectations.changed);
    const added = new Set(update.expectations.added);
    expect(changed.size).toBeGreaterThan(0);
    expect(added.size).toBeGreaterThan(0);
    for (const row of everyRow) {
      const number = row.investmentNumber!;
      expect(row.link.status).toBe('matched');
      // The supplied quarter is the one row of its investment at an earlier period end.
      if (added.has(number) && row.periodEnd !== periodEnd()) {
        expect(row.diff.kind).toBe('new');
        expect(row.diff.changes.map((c) => c.field)).toEqual([
          'revenueLtm',
          'ebitdaLtm',
          'ev',
          'netDebt',
        ]);
        expect(row.diff.changes.every((c) => c.before === null)).toBe(true);
        expect(row.targetId).toBeNull();
        expect(row.periodEnd).toBe(addMonths(periodEnd(), -12));
      } else if (changed.has(number)) {
        const seeded = seededQuarter(row.link.investmentId!, periodEnd());
        expect(row.diff.kind).toBe('changed');
        expect(row.diff.changes.length).toBeGreaterThan(0);
        for (const change of row.diff.changes) {
          expect(['revenueLtm', 'ebitdaLtm']).toContain(change.field);
          expect(change.before).toBe(seeded[change.field]);
          expect(change.after).toBe(row.figures[change.field]);
          expect(D(change.before!).eq(D(change.after!))).toBe(false);
        }
        expect(row.targetId).toBe(seeded.id);
      } else {
        expect(row.diff, `row ${row.rowNo}`).toEqual({ kind: 'unchanged', changes: [] });
      }
      expect(row.status, `row ${row.rowNo}`).toBe('validated');
    }
    expect(updateFile.status).toBe('validated');
    expect(updateFile.exceptions).toBe(0);
    // Zero production change before approval: the count and the restated row's figures.
    expect(await productionRows()).toBe(before);
    const restated = investmentByNumber(update.expectations.changed[0]!);
    const record = await onRecord(restated.id, periodEnd());
    const seeded = seededQuarter(restated.id, periodEnd());
    expect(record?.revenue_ltm).toBe(seeded.revenueLtm);
    expect(record?.ebitda_ltm).toBe(seeded.ebitdaLtm);
  });

  it('hides rows linked to a walled investment from everyone outside the wall, the importer included, and counts them', async () => {
    // ops.one staged the file from outside the wall: the walled position linked all the same.
    const ops = await detail('operations', cleanFile.id, 'req-intake-detail-ops-1');
    expect(ops.hiddenRows).toBe(1);
    expect(ops.rows.some((r) => r.link.investmentId === walledId())).toBe(false);
    expect(JSON.stringify(ops)).not.toContain(walledId());
    expect(JSON.stringify(ops)).not.toContain(walledCompanyName());
    const outsider = await detail('deal.one', cleanFile.id, 'req-intake-detail-deal-1');
    expect(outsider.hiddenRows).toBe(1);
    expect(outsider.rows.length).toBe(ops.rows.length);
    expect(outsider.rows.some((r) => r.link.investmentId === walledId())).toBe(false);
    expect(JSON.stringify(outsider)).not.toContain(walledId());
    // The file reads the same for everyone: counts cover every row, hidden ones included.
    expect(outsider.counts).toEqual(ops.counts);
    expect(outsider.rowCount).toBe(ops.rowCount);
    const member = await detail('deal.three', cleanFile.id);
    expect(member.hiddenRows).toBe(0);
    expect(member.rows.length).toBe(ops.rows.length + 1);
    const walledRow = member.rows.find((r) => r.link.investmentId === walledId());
    expect(walledRow).toBeDefined();
    expect(walledRow!.link.status).toBe('matched');
    expect(walledRow!.status).toBe('validated');
    // Each open is a sensitive read on record, without values.
    expect(await auditCount('intake_file.read', 'req-intake-detail-deal-1')).toBe(1);
    const [event] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
      "select details from audit.event where action = 'intake_file.read' and request_id = 'req-intake-detail-deal-1'",
    );
    expect(event!.details).toEqual({});
    // Naming a hidden row is the same as naming a row of another file: not one the caller may act on.
    for (const who of ['deal.one', 'operations']) {
      const refused = await command(who, cleanFile.id, {
        command: 'approve',
        rowIds: [walledRow!.id],
      }).expect(400);
      expect(problemDetails.parse(refused.body).errors?.map((e) => e.path)).toEqual(['rowIds']);
    }
  });

  it('answers 404 for a file the caller cannot see and for an id that is not a UUID', async () => {
    await h
      .http()
      .get('/api/v1/intake/files/not-a-uuid')
      .set('authorization', h.as('operations'))
      .expect(404);
    await h
      .http()
      .get('/api/v1/intake/files/00000000-0000-4000-8000-00000000abcd')
      .set('authorization', h.as('operations'))
      .expect(404);
    await command('operations', '00000000-0000-4000-8000-00000000abcd', {
      command: 'approve',
    }).expect(404);
  });

  it('the deal team approves the update file: validated rows are promoted in one transaction with lineage and an audit event each', async () => {
    const before = await productionRows();
    const visibleBefore = await detail('deal.one', updateFile.id);
    const toPromote = visibleBefore.rows.filter((r) => r.status === 'validated');
    expect(toPromote.length).toBeGreaterThan(0);
    const newRows = toPromote.filter((r) => r.diff.kind === 'new').length;
    const res = await command(
      'deal_team',
      updateFile.id,
      { command: 'approve' },
      'req-intake-approve-1',
    ).expect(200);
    const after = intakeFileDetail.parse(res.body);
    const approver = user('deal.one');
    const now = h.runtime.adapters.clock.now();
    for (const row of after.rows) {
      expect(row.status, `row ${row.rowNo}`).toBe('promoted');
      expect(row.promotedAt).toBe(now);
      expect(row.decidedBy).toBe(approver.displayName);
      expect(row.decision).toBe(`accounting import ${update.fileName}`);
      expect(row.targetId).not.toBeNull();
    }
    // The walled row stays validated for a reviewer outside the wall: it was never theirs to approve.
    expect(after.hiddenRows).toBe(1);
    expect(after.counts.validated).toBe(1);
    expect(after.counts.promoted).toBe(toPromote.length);
    expect(after.status).toBe('validated');
    expect(await productionRows()).toBe(before + newRows);

    // The restated quarter holds the file's figures with the approver, the time, the reason and
    // the lineage to the file and row.
    const restatedNumber = update.expectations.changed[0]!;
    const restated = after.rows.find((r) => r.investmentNumber === restatedNumber)!;
    const record = (await onRecord(investmentByNumber(restatedNumber).id, periodEnd()))!;
    expect(D(record.revenue_ltm!).eq(D(restated.figures.revenueLtm!))).toBe(true);
    expect(D(record.ebitda_ltm!).eq(D(restated.figures.ebitdaLtm!))).toBe(true);
    expect(record.status).toBe('record_status.approved');
    expect(record.approved_by).toBe(approver.id);
    expect(new Date(record.approved_at!).toISOString()).toBe(now);
    expect(record.approval_reason).toBe(`accounting import ${update.fileName}`);
    expect(record.source_locator).toBe(`intake_file:${updateFile.id}/row:${restated.rowNo}`);
    expect(record.id).toBe(restated.targetId);
    // The supplied quarter now exists on record, approved, with the same lineage.
    const addedNumber = update.expectations.added[0]!;
    const added = after.rows.find(
      (r) => r.investmentNumber === addedNumber && r.periodEnd !== periodEnd(),
    )!;
    const created = (await onRecord(investmentByNumber(addedNumber).id, added.periodEnd!))!;
    expect(created.id).toBe(added.targetId);
    expect(created.is_entry_snapshot).toBe(false);
    expect(created.status).toBe('record_status.approved');
    expect(D(created.ev!).eq(D(added.figures.ev!))).toBe(true);
    expect(created.source_locator).toBe(`intake_file:${updateFile.id}/row:${added.rowNo}`);

    // One promote event per row with the figures before and after, and one approve event with counts.
    expect(await auditCount('quarterly_performance.promote', 'req-intake-approve-1')).toBe(
      toPromote.length,
    );
    expect(await auditCount('intake.approve', 'req-intake-approve-1')).toBe(1);
    const [event] = await h.runtime.db.query<{
      entity_id: string;
      reason: string;
      details: {
        intakeFileId: string;
        intakeRowId: string;
        rowNo: number;
        before: Record<string, string | null>;
        after: Record<string, string | null>;
      };
    }>(
      "select entity_id, reason, details from audit.event where action = 'quarterly_performance.promote' and request_id = 'req-intake-approve-1' and entity_id = $1",
      [record.id],
    );
    expect(event!.details.intakeFileId).toBe(updateFile.id);
    expect(event!.details.intakeRowId).toBe(restated.id);
    expect(event!.details.rowNo).toBe(restated.rowNo);
    expect(event!.details.before.revenueLtm).toBe(
      seededQuarter(investmentByNumber(restatedNumber).id, periodEnd()).revenueLtm,
    );
    expect(event!.details.after.revenueLtm).toBe(restated.figures.revenueLtm);
    expect(event!.reason).toBe(`accounting import ${update.fileName}`);

    // A repeated approve finds nothing left to do and answers the unchanged file.
    const again = intakeFileDetail.parse(
      (
        await command(
          'deal_team',
          updateFile.id,
          { command: 'approve' },
          'req-intake-approve-2',
        ).expect(200)
      ).body,
    );
    expect(again.counts).toEqual(after.counts);
    expect(await auditCount('quarterly_performance.promote', 'req-intake-approve-2')).toBe(0);
    expect(await productionRows()).toBe(before + newRows);

    // A wall member finishes the file: the one row left is the walled position's, theirs to approve.
    const finished = intakeFileDetail.parse(
      (
        await command(
          'deal.three',
          updateFile.id,
          { command: 'approve' },
          'req-intake-approve-wall',
        ).expect(200)
      ).body,
    );
    expect(finished.hiddenRows).toBe(0);
    expect(finished.counts.validated).toBe(0);
    expect(finished.counts.promoted).toBe(update.expectations.rows);
    expect(finished.status).toBe('promoted');
    expect(await auditCount('quarterly_performance.promote', 'req-intake-approve-wall')).toBe(1);
    expect(await productionRows()).toBe(before + newRows);
  });

  it('stages a defects export: each defect row is flagged by its rule, unresolved names open exceptions', async () => {
    // Staged after the update file was approved: the defects file carries the same restatement,
    // and a diff taken before that approval would be stale (promotion refuses a stale diff, see
    // the clean file at the end of this suite).
    defectsFile = await stage(defects, 'req-intake-defects-1');
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
      const finding = row.findings.find((f) => f.ruleId === ruleId)!;
      expect(finding.severity).toBe('error');
      expect(finding.message).not.toContain(String.fromCharCode(0x2014));
    }
    // Unresolved names: a number the record lacks, and a near miss with candidates for a person.
    const unmatched = full.rows.filter((r) => r.link.status === 'unmatched');
    expect(unmatched.length).toBe(2);
    const nearMiss = unmatched.find((r) => r.investmentNumber === null)!;
    const sample = full.rows[1]!;
    expect(nearMiss.link.candidates).toEqual([
      {
        investmentNumber: sample.investmentNumber,
        companyName: sample.companyName,
        reason: 'near miss',
      },
    ]);
    expect(nearMiss.link.investmentId).toBeNull();
    expect(nearMiss.targetId).toBeNull();
    // A name on the match guard list is never linked, whatever the similarity.
    const guarded = full.rows.filter((r) => r.link.status === 'guarded');
    expect(guarded.length).toBe(1);
    expect(guarded[0]!.status).toBe('flagged');
    expect(guarded[0]!.findings.map((f) => f.ruleId)).toContain('XREF-02');
    expect(guarded[0]!.link.candidates.some((c) => c.reason === 'match guard')).toBe(true);
    expect(guarded[0]!.companyName).toBe(h.dataset.matchGuards[0]!.nameB);
    // The duplicate row shares its natural key with the row it repeats and is flagged, not dropped.
    const dup = defects.expectations.flagged.find((f) => f.ruleId === 'DUP-01')!;
    const dupRow = rowNo(full, dup.rowNo);
    const first = full.rows.find((r) => r.rowNo < dup.rowNo && r.naturalKey === dupRow.naturalKey);
    expect(first).toBeDefined();
    expect(first!.status).toBe('validated');
    // Exceptions: one per unresolved link and one per fair value that does not tie.
    const ties = full.rows.flatMap((r) => r.findings.filter((f) => f.ruleId === 'TIE-01'));
    expect(ties.length).toBe(1);
    const expectedExceptions = unmatched.length + guarded.length + ties.length;
    expect(defectsFile.exceptions).toBe(expectedExceptions);
    const opened = await h.runtime.db.query<{
      rule_id: string;
      state: string;
      severity: string;
      expected: string | null;
      actual: string | null;
      candidates: unknown[];
    }>(
      `select x.rule_id, x.state, x.severity, x.expected, x.actual, x.candidates
       from ops.data_exception x join stg.intake_row r on r.id = x.entity_id
       where x.source = 'accounting_import' and x.entity = 'stg.intake_row' and r.intake_file_id = $1
       order by r.row_no`,
      [defectsFile.id],
    );
    expect(opened.length).toBe(expectedExceptions);
    expect(
      opened.every((x) => x.state === 'open' && x.severity === 'exception_severity.high'),
    ).toBe(true);
    expect(opened.map((x) => x.rule_id).sort()).toEqual(
      ['XREF-01', 'XREF-01', 'XREF-02', 'TIE-01'].sort(),
    );
    // Every authenticated user may read exceptions: a fair value that does not tie opens one with
    // no values (the mark and the figure stay on the staged row), and a candidate is its reason
    // only, never a number or a name.
    const tie = opened.find((x) => x.rule_id === 'TIE-01')!;
    expect(tie.expected).toBeNull();
    expect(tie.actual).toBeNull();
    expect(ties[0]!.expected).not.toBeNull();
    expect(JSON.stringify(opened)).not.toContain(ties[0]!.expected);
    expect(JSON.stringify(opened)).not.toContain(ties[0]!.actual);
    const guardedException = opened.find((x) => x.rule_id === 'XREF-02')!;
    expect(guardedException.candidates.length).toBeGreaterThan(0);
    for (const x of opened)
      for (const candidate of x.candidates)
        expect(Object.keys(candidate as Record<string, unknown>)).toEqual(['reason']);
    expect(defectsFile.status).toBe('flagged');
    expect(defectsFile.counts.flagged).toBe(full.rows.filter((r) => r.status === 'flagged').length);
    expect(defectsFile.counts.flagged + defectsFile.counts.validated).toBe(
      defects.expectations.rows,
    );
  });

  it('approves named rows of the defects file one at a time; flagged rows stay flagged', async () => {
    const current = await detail('operations', defectsFile.id);
    const flagged = current.rows.filter((r) => r.status === 'flagged');
    const validated = current.rows.filter((r) => r.status === 'validated');
    expect(flagged.length).toBeGreaterThan(0);
    expect(validated.length).toBeGreaterThan(1);
    // The walled position has two rows in this file (its quarter and a defect), both past ops.one's wall.
    const everyRow = (await fullView(defectsFile.id)).rows;
    const hiddenValidated =
      everyRow.filter((r) => r.status === 'validated').length - validated.length;
    const hiddenFlagged = everyRow.filter((r) => r.status === 'flagged').length - flagged.length;
    expect(current.hiddenRows).toBe(hiddenValidated + hiddenFlagged);
    // The generator reports the walled position's rows; the before-entry defect is one of them.
    const walledFlagged = defects.expectations.walled.filter((n) =>
      defects.expectations.flagged.some((f) => f.rowNo === n),
    ).length;
    expect(hiddenFlagged).toBe(walledFlagged);
    expect(hiddenValidated).toBe(defects.expectations.walled.length - walledFlagged);
    // A flagged row cannot be approved, nor a row of another file.
    for (const rowIds of [
      [flagged[0]!.id],
      [updateFile.rows[0]!.id],
      [validated[0]!.id, flagged[0]!.id],
    ]) {
      const res = await command('operations', defectsFile.id, {
        command: 'approve',
        rowIds,
      }).expect(400);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}validation`);
    }
    const one = intakeFileDetail.parse(
      (
        await command(
          'operations',
          defectsFile.id,
          {
            command: 'approve',
            rowIds: [validated[0]!.id],
            reason: 'Figures checked with the sponsor',
          },
          'req-intake-approve-3',
        ).expect(200)
      ).body,
    );
    expect(one.counts.promoted).toBe(1);
    expect(one.counts.validated).toBe(validated.length - 1 + hiddenValidated);
    expect(one.counts.flagged).toBe(flagged.length + hiddenFlagged);
    expect(rowNo(one, validated[0]!.rowNo).decision).toBe('Figures checked with the sponsor');
    expect(await auditCount('quarterly_performance.promote', 'req-intake-approve-3')).toBe(1);
    const rest = intakeFileDetail.parse(
      (await command('operations', defectsFile.id, { command: 'approve' }).expect(200)).body,
    );
    expect(rest.counts.promoted).toBe(validated.length);
    expect(rest.counts.validated).toBe(hiddenValidated);
    expect(rest.counts.flagged).toBe(flagged.length + hiddenFlagged);
    expect(rest.status).toBe('flagged');
    for (const f of flagged) expect(rowNo(rest, f.rowNo).status).toBe('flagged');
    // A period end that is not a quarter end within the tolerance is flagged (TYPE-03, an error),
    // so a bulk approve never writes a quarter dated mid-month beside the real one.
    const offQuarter = defects.expectations.flagged.find((f) => f.ruleId === 'TYPE-03')!;
    const offRow = rowNo(rest, offQuarter.rowNo);
    expect(offRow.status).toBe('flagged');
    expect(offRow.periodEnd).not.toBe(containingQuarterEnd(offRow.periodEnd!));
    const quarterEnd = containingQuarterEnd(offRow.periodEnd!);
    const inQuarter = await h.runtime.db.query<{
      period_end: string;
      source_locator: string | null;
    }>(
      'select period_end::text as period_end, source_locator from mon.quarterly_performance where investment_id = $1 and period_end > $2 and period_end <= $3 order by period_end',
      [offRow.link.investmentId, containingQuarterEnd(addMonths(quarterEnd, -3)), quarterEnd],
    );
    expect(inQuarter, JSON.stringify(inQuarter)).toHaveLength(1);
    expect(inQuarter[0]!.period_end).toBe(quarterEnd);
  });

  it('rejects flagged rows with a reason the machine requires; the deal team may not reject', async () => {
    const dealTeam = await command('deal_team', defectsFile.id, {
      command: 'reject',
      reason: 'Not ours to decide',
    }).expect(403);
    expect(problemDetails.parse(dealTeam.body).type).toBe(`${PROBLEM}forbidden`);
    const noReason = await command('operations', defectsFile.id, { command: 'reject' }).expect(422);
    const problem = problemDetails.parse(noReason.body);
    expect(problem.type).toBe(`${PROBLEM}workflow-precondition`);
    expect(problem.detail).toContain('a reason is required');
    const stillFlagged = await detail('operations', defectsFile.id);
    expect(stillFlagged.counts.flagged).toBeGreaterThan(0);

    const reason = 'Names sent back to the accounting team';
    const res = await command(
      'operations',
      defectsFile.id,
      { command: 'reject', reason },
      'req-intake-reject-1',
    ).expect(200);
    const rejected = intakeFileDetail.parse(res.body);
    const visibleFlagged = stillFlagged.rows.filter((r) => r.status === 'flagged').length;
    expect(rejected.counts.rejected).toBe(visibleFlagged);
    // The walled position's defect row is past ops.one's wall: it stays flagged, and so does the file.
    expect(rejected.counts.flagged).toBe(stillFlagged.counts.flagged - visibleFlagged);
    expect(rejected.counts.flagged).toBe(1);
    for (const row of rejected.rows.filter((r) => r.status === 'rejected')) {
      expect(row.decision).toBe(reason);
      expect(row.decidedBy).toBe(user('ops.one').displayName);
      expect(row.promotedAt).toBeNull();
    }
    expect(rejected.status).toBe('flagged');
    expect(await auditCount('intake.reject', 'req-intake-reject-1')).toBe(1);
    const again = intakeFileDetail.parse(
      (await command('operations', defectsFile.id, { command: 'reject', reason }).expect(200)).body,
    );
    expect(again.counts).toEqual(rejected.counts);

    // Rejection is operations' call (docs/18 section 2), so a wall needs an operations member to
    // finish a file that holds a walled position's defect: ops.two joins the wall and does.
    const wall = h.dataset.walls[0]!;
    await h.runtime.db.query('insert into core.wall_member (wall_id, user_id) values ($1, $2)', [
      wall.id,
      user('ops.two').id,
    ]);
    const approvedRest = intakeFileDetail.parse(
      (await command('ops.two', defectsFile.id, { command: 'approve' }).expect(200)).body,
    );
    expect(approvedRest.hiddenRows).toBe(0);
    expect(approvedRest.counts.validated).toBe(0);
    const finished = intakeFileDetail.parse(
      (await command('ops.two', defectsFile.id, { command: 'reject', reason }).expect(200)).body,
    );
    expect(finished.counts.flagged).toBe(0);
    // Every row is now promoted or rejected, so the file is promoted.
    expect(finished.status).toBe('promoted');
  });

  it('keeps commands from auditors and viewers, and reads to the reviewing roles', async () => {
    for (const who of ['auditor', 'viewer', 'approver', 'investor_relations', 'platform_admin']) {
      const res = await command(who, cleanFile.id, { command: 'approve' }).expect(403);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}forbidden`);
    }
    for (const who of ['viewer', 'investor_relations', 'platform_admin']) {
      await h.http().get('/api/v1/intake/files').set('authorization', h.as(who)).expect(403);
      await h
        .http()
        .get(`/api/v1/intake/files/${cleanFile.id}`)
        .set('authorization', h.as(who))
        .expect(403);
    }
    for (const who of ['auditor', 'approver', 'deal_team', 'operations']) {
      const page = intakeFilePage.parse(
        (await h.http().get('/api/v1/intake/files').set('authorization', h.as(who)).expect(200))
          .body,
      );
      expect(page.items.length).toBe(3);
    }
  });

  it('lists files newest first, pages on (receivedAt, id) without overlap and filters by status', async () => {
    const list = async (query: string) =>
      intakeFilePage.parse(
        (
          await h
            .http()
            .get(`/api/v1/intake/files${query}`)
            .set('authorization', h.as('auditor'))
            .expect(200)
        ).body,
      );
    const all = await list('?limit=50');
    expect(all.items.map((f) => f.id)).toEqual([defectsFile.id, updateFile.id, cleanFile.id]);
    expect(all.nextCursor).toBeNull();
    for (let i = 1; i < all.items.length; i++)
      expect(all.items[i - 1]!.receivedAt >= all.items[i]!.receivedAt).toBe(true);
    const first = await list('?limit=2');
    expect(first.items.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(`?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((f) => f.id)).toEqual([cleanFile.id]);
    expect(second.nextCursor).toBeNull();
    // Each item carries the same summary the detail does.
    const summary = all.items.find((f) => f.id === defectsFile.id)!;
    const full = await detail('auditor', defectsFile.id);
    const { rows: _rows, hiddenRows: _hidden, ...header } = full;
    expect(summary).toEqual(header);
    // The update file was finished by a wall member, the defects file by ops.two from inside the wall.
    const promoted = await list('?status=promoted');
    expect(promoted.items.map((f) => f.id).sort()).toEqual([defectsFile.id, updateFile.id].sort());
    expect((await list('?status=flagged')).items).toEqual([]);
    await h
      .http()
      .get('/api/v1/intake/files?cursor=%%%')
      .set('authorization', h.as('auditor'))
      .expect(400);
    await h
      .http()
      .get('/api/v1/intake/files?status=open')
      .set('authorization', h.as('auditor'))
      .expect(400);
  });

  it('lists the drop folder and imports an export by id; an unknown id is not found', async () => {
    const inbox = join(h.runtime.config.PB_ACCOUNTING_ROOT, 'in');
    mkdirSync(inbox, { recursive: true });
    const samples = accountingExports(h.dataset);
    for (const sample of samples) writeFileSync(join(inbox, sample.fileName), sample.csv);
    const prior = accountingExport(h.dataset, {
      scenario: 'clean',
      periodEnd: containingQuarterEnd(addMonths(periodEnd(), -3)),
    });
    writeFileSync(join(inbox, prior.fileName), prior.csv);
    await h
      .http()
      .get('/api/v1/intake/accounting/exports')
      .set('authorization', h.as('deal_team'))
      .expect(403);
    const listed = intakeExportList.parse(
      (
        await h
          .http()
          .get('/api/v1/intake/accounting/exports')
          .set('authorization', h.as('operations'))
          .expect(200)
      ).body,
    );
    expect(listed.items.map((e) => e.name).sort()).toEqual(
      [...samples.map((s) => s.fileName), prior.fileName].sort(),
    );
    // The same content as the upload earlier: the drop folder import is the same file.
    const same = intakeImportResult.parse(
      (await importAs('operations', { exportId: clean.fileName }).expect(201)).body,
    );
    expect(same.duplicate).toBe(true);
    expect(same.id).toBe(cleanFile.id);
    // An earlier quarter is new content: staged and validated against that quarter's record.
    const earlier = intakeImportResult.parse(
      (await importAs('operations', { exportId: prior.fileName }).expect(201)).body,
    );
    expect(earlier.duplicate).toBe(false);
    expect(earlier.fileName).toBe(prior.fileName);
    expect(earlier.rows.length + earlier.hiddenRows).toBe(prior.expectations.rows);
    expect(earlier.rows.every((r) => r.diff.kind === 'unchanged')).toBe(true);
    expect(earlier.status).toBe('validated');
    for (const exportId of ['missing.csv', '../missing.csv', 'in']) {
      const res = await importAs('operations', { exportId }).expect(404);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}not-found`);
    }
  });

  it('refuses a file whose columns the layout does not know and stages no rows', async () => {
    const table = parseCsv(clean.csv);
    const extra = intakeImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'extra-column.csv',
          csv: `${[...table.header, 'Extra'].join(',')}\n${table.rows[0]!.join(',')},1\n`,
        }).expect(201)
      ).body,
    );
    expect(extra.status).toBe('new');
    expect(extra.rows).toEqual([]);
    expect(extra.rowCount).toBe(0);
    expect(extra.fileFindings.map((f) => [f.ruleId, f.field])).toEqual([['LAYOUT-01', 'Extra']]);
    expect(extra.exceptions).toBe(0);
    const without = table.header.indexOf('PeriodEnd');
    const missing = intakeImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'missing-column.csv',
          csv: `${table.header.filter((_, i) => i !== without).join(',')}\n${table.rows[0]!.filter(
            (_, i) => i !== without,
          ).join(',')}\n`,
        }).expect(201)
      ).body,
    );
    expect(missing.status).toBe('new');
    expect(missing.fileFindings.map((f) => f.ruleId)).toEqual(['LAYOUT-02']);
    const empty = intakeImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'empty.csv',
          csv: `${table.header.join(',')}\n`,
        }).expect(201)
      ).body,
    );
    expect(empty.fileFindings.map((f) => f.ruleId)).toEqual(['LAYOUT-03']);
    expect(await count("select count(*)::int as n from stg.intake_file where status = 'new'")).toBe(
      3,
    );
  });

  it('refuses a file larger than the configured byte limit before reading it', async () => {
    const files = await count('select count(*)::int as n from stg.intake_file');
    // Two bytes per character: over the byte limit while within the contract's character limit.
    const csv = `${clean.csv}${'é'.repeat(1_000_000)}`;
    const res = await importAs('operations', { fileName: 'too-large.csv', csv }).expect(400);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}validation`);
    expect(problem.detail).toBe('The file is larger than one import accepts');
    expect(await count('select count(*)::int as n from stg.intake_file')).toBe(files);
  });

  it('shows a near miss on a walled name only to the wall: candidates are filtered per reader, exceptions carry numbers only', async () => {
    const table = parseCsv(clean.csv);
    const inv = h.dataset.investments.find((i) => i.id === walledId())!;
    const line = table.rows.find(
      (r) => r[table.header.indexOf('InvestmentNumber')] === inv.investmentNumber,
    )!;
    const cells = [...line];
    cells[table.header.indexOf('InvestmentNumber')] = '';
    cells[table.header.indexOf('CompanyName')] = walledCompanyName().slice(0, -1);
    const staged = intakeImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'near-miss-walled.csv',
          csv: `${table.header.join(',')}\n${cells.join(',')}\n`,
        }).expect(201)
      ).body,
    );
    // The importer is outside the wall: an unmatched row with nothing to confirm, in words that
    // name no candidate, so the response never says the walled position exists (SEC-5.3).
    expect(staged.hiddenRows).toBe(0);
    const row = staged.rows[0]!;
    expect(row.link.status).toBe('unmatched');
    expect(row.link.candidates).toEqual([]);
    expect(row.findings.map((f) => f.ruleId)).toContain('XREF-01');
    expect(row.findings.find((f) => f.ruleId === 'XREF-01')!.message).not.toMatch(/near miss/i);
    expect(JSON.stringify(staged)).not.toContain(walledCompanyName());
    expect(JSON.stringify(staged)).not.toContain(inv.investmentNumber);
    // A wall member sees the candidate the linker found, and nobody saw it linked: never a near miss.
    const member = await detail('deal.three', staged.id);
    expect(member.rows[0]!.link.candidates).toEqual([
      {
        investmentNumber: inv.investmentNumber,
        companyName: walledCompanyName(),
        reason: 'near miss',
      },
    ]);
    // The findings are the same text for the wall and for everyone else: only the candidates differ.
    expect(member.rows[0]!.findings).toEqual(row.findings);
    // The exception every authenticated user may read carries the candidate's reason only: neither
    // the walled position's number nor its name, nor a figure of the row.
    const [exception] = await h.runtime.db.query<{
      rule_id: string;
      expected: string | null;
      actual: string | null;
      candidates: unknown[];
    }>(
      "select rule_id, expected, actual, candidates from ops.data_exception where entity = 'stg.intake_row' and entity_id = $1",
      [row.id],
    );
    expect(exception!.rule_id).toBe('XREF-01');
    expect(exception!.candidates).toEqual([{ reason: 'near miss' }]);
    expect(JSON.stringify(exception)).not.toContain(inv.investmentNumber);
    expect(JSON.stringify(exception)).not.toContain(walledCompanyName());
    for (const column of ['RevenueLTM', 'EBITDALTM', 'EnterpriseValue', 'NetDebt', 'FairValue'])
      expect(JSON.stringify(exception)).not.toContain(cells[table.header.indexOf(column)]!);
  });

  it('never names a walled position in a match guard finding: the guarded row reads the same for everyone', async () => {
    // A guard pair between the walled company's name and a confusable variant (owner SQL, as
    // operations would add it through the match guard list).
    // A variant that neither contains the walled name (the file's own text must not) nor normalizes
    // to it, nor sits within a near miss of it: only the guard list ties the two.
    const variant = `Twin ${walledCompanyName().split(' ').slice(1).join(' ')}`;
    await h.runtime.db.query(
      'insert into core.match_guard (name_a, name_b, reason) values ($1, $2, $3)',
      [walledCompanyName(), variant, 'Confusable with a position on record'],
    );
    const table = parseCsv(clean.csv);
    const inv = h.dataset.investments.find((i) => i.id === walledId())!;
    const line = table.rows.find(
      (r) => r[table.header.indexOf('InvestmentNumber')] === inv.investmentNumber,
    )!;
    const cells = [...line];
    cells[table.header.indexOf('InvestmentNumber')] = '';
    cells[table.header.indexOf('CompanyName')] = variant;
    const staged = intakeImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'guarded-walled.csv',
          csv: `${table.header.join(',')}\n${cells.join(',')}\n`,
        }).expect(201)
      ).body,
    );
    expect(staged.rows, JSON.stringify(staged)).toHaveLength(1);
    const row = staged.rows[0]!;
    expect(row.link.status).toBe('guarded');
    expect(row.status).toBe('flagged');
    expect(row.link.candidates).toEqual([]);
    const guard = row.findings.find((f) => f.ruleId === 'XREF-02')!;
    expect(guard.message).not.toContain(walledCompanyName());
    expect(JSON.stringify(staged)).not.toContain(walledCompanyName());
    expect(JSON.stringify(staged)).not.toContain(inv.investmentNumber);
    const member = await detail('deal.three', staged.id);
    expect(member.rows[0]!.link.candidates).toEqual([
      {
        investmentNumber: inv.investmentNumber,
        companyName: walledCompanyName(),
        reason: 'match guard',
      },
    ]);
    expect(member.rows[0]!.findings).toEqual(row.findings);
  });

  /* ---- Promotion safety (decision 0009): the record is read again when a row is promoted ---- */

  /** A one-row export in the layout's columns, cells by column name; a cell not named is blank. */
  const oneRowCsv = (cells: Record<string, string>): string => {
    const { header } = parseCsv(clean.csv);
    return `${header.join(',')}\n${header.map((c) => cells[c] ?? '').join(',')}\n`;
  };
  /** The clean export's line for an investment number, as cells by column name. */
  const cleanLine = (investmentNumber: string): Record<string, string> => {
    const table = parseCsv(clean.csv);
    const line = table.rows.find(
      (r) => r[table.header.indexOf('InvestmentNumber')] === investmentNumber,
    )!;
    return Object.fromEntries(table.header.map((c, i) => [c, line[i] ?? '']));
  };
  /** The clean export's positions that are neither walled, restated nor shifted off the quarter end, in file order. */
  const plainNumbers = (): string[] => {
    const table = parseCsv(clean.csv);
    const column = table.header.indexOf('InvestmentNumber');
    const period = table.header.indexOf('PeriodEnd');
    const walledNumber = h.dataset.investments.find((i) => i.id === walledId())!.investmentNumber;
    return table.rows
      .filter((r) => r[period] === periodEnd())
      .map((r) => r[column]!)
      .filter((n) => n !== walledNumber && n !== update.expectations.changed[0]);
  };
  /** The data line (1-based) of the export that carries the investment number. */
  const lineNo = (file: AccountingExport, investmentNumber: string): number => {
    const table = parseCsv(file.csv);
    const column = table.header.indexOf('InvestmentNumber');
    return table.rows.findIndex((r) => r[column] === investmentNumber) + 1;
  };
  const stageOne = async (fileName: string, cells: Record<string, string>): Promise<IntakeRow> => {
    const staged = intakeImportResult.parse(
      (await importAs('operations', { fileName, csv: oneRowCsv(cells) }).expect(201)).body,
    );
    expect(staged.duplicate).toBe(false);
    expect(staged.rows.length).toBe(1);
    return staged.rows[0]!;
  };
  const exceptionsOf = (rowId: string) =>
    h.runtime.db.query<{
      rule_id: string;
      expected: string | null;
      actual: string | null;
      candidates: unknown[];
    }>(
      "select rule_id, expected, actual, candidates from ops.data_exception where entity = 'stg.intake_row' and entity_id = $1",
      [rowId],
    );

  it('ties the fair value to the Locked mark a few days off the quarter end: TIE-01 flags the row and opens one exception with no values', async () => {
    // The period_end_shift position reports three days before each quarter end, and so do its
    // Locked marks; the sample exports carry it at that period end.
    const shiftedId = h.dataset.scenarios.period_end_shift![0]!;
    const inv = h.dataset.investments.find((i) => i.id === shiftedId)!;
    const company = h.dataset.portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId)!;
    const quarters = h.dataset.quarterlyPerformance
      .filter(
        (q) =>
          q.investmentId === shiftedId &&
          !q.isEntrySnapshot &&
          q.status === 'record_status.approved',
      )
      .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
    const quarter = quarters[quarters.length - 1]!;
    expect(quarter.periodEnd).not.toBe(periodEnd());
    expect(cellOf(clean, lineNo(clean, inv.investmentNumber), 'PeriodEnd')).toBe(quarter.periodEnd);
    const mark = h.dataset.valuations
      .filter(
        (v) =>
          v.investmentId === shiftedId && v.state === 'Locked' && v.periodEnd === quarter.periodEnd,
      )
      .sort((a, b) => b.version - a.version)[0]!;
    const cells = {
      InvestmentNumber: inv.investmentNumber,
      CompanyName: company.name,
      RevenueLTM: quarter.revenueLtm ?? '',
      EBITDALTM: quarter.ebitdaLtm ?? '',
      EnterpriseValue: quarter.ev ?? '',
      NetDebt: quarter.netDebt ?? '',
    };
    const offTheMark = D(mark.fairValue).times('1.1').toFixed(2);
    // Reported at the sponsor's own period end, or at the quarter end it stands for: the quarter
    // and the mark are the same ones, by the same tolerance.
    for (const [name, reported] of [
      ['shifted', quarter.periodEnd],
      ['quarter-end', periodEnd()],
    ] as const) {
      const row = await stageOne(`tie-${name}.csv`, {
        ...cells,
        PeriodEnd: reported,
        FairValue: offTheMark,
      });
      expect(row.link.status).toBe('matched');
      expect(row.targetId).toBe(quarter.id);
      expect(row.diff).toEqual({ kind: 'unchanged', changes: [] });
      const tie = row.findings.find((f) => f.ruleId === 'TIE-01')!;
      expect(tie.severity).toBe('error');
      expect(tie.message).toContain(mark.periodEnd);
      expect(D(tie.expected!).eq(D(mark.fairValue))).toBe(true);
      expect(D(tie.actual!).eq(D(offTheMark))).toBe(true);
      expect(row.status).toBe('flagged');
      // The exception everyone may read says which rule, never the mark or the figure.
      const opened = await exceptionsOf(row.id);
      expect(opened).toEqual([{ rule_id: 'TIE-01', expected: null, actual: null, candidates: [] }]);
    }
    // The mark itself ties: no finding, no exception.
    const tied = await stageOne('tie-exact.csv', {
      ...cells,
      PeriodEnd: quarter.periodEnd,
      FairValue: mark.fairValue,
    });
    expect(tied.findings.map((f) => f.ruleId)).not.toContain('TIE-01');
    expect(tied.status).toBe('validated');
    expect(await exceptionsOf(tied.id)).toEqual([]);
  });

  it('audits the figures after promotion as the record stores them, not as the file wrote them', async () => {
    const number = plainNumbers()[1]!;
    const inv = investmentByNumber(number);
    const line = cleanLine(number);
    // The file carries the revenue as a whole number; the record holds every figure to the cent.
    const revenue = D(line.RevenueLTM!).toFixed(0);
    expect(revenue).not.toBe(line.RevenueLTM);
    const previous = (await onRecord(inv.id, periodEnd()))!;
    const row = await stageOne('whole-number-revenue.csv', { ...line, RevenueLTM: revenue });
    expect(row.status).toBe('validated');
    expect(row.figures.revenueLtm).toBe(revenue);
    const fileId = (
      await h.runtime.db.query<{ intake_file_id: string }>(
        'select intake_file_id from stg.intake_row where id = $1',
        [row.id],
      )
    )[0]!.intake_file_id;
    const promoted = intakeFileDetail.parse(
      (
        await command(
          'operations',
          fileId,
          { command: 'approve' },
          'req-intake-audit-after-1',
        ).expect(200)
      ).body,
    );
    expect(promoted.rows[0]!.status).toBe('promoted');
    const record = (await onRecord(inv.id, periodEnd()))!;
    expect(D(record.revenue_ltm!).eq(D(revenue))).toBe(true);
    expect(record.revenue_ltm).not.toBe(revenue);
    const [event] = await h.runtime.db.query<{
      details: { before: Record<string, string | null>; after: Record<string, string | null> };
    }>(
      "select details from audit.event where action = 'quarterly_performance.promote' and request_id = 'req-intake-audit-after-1'",
    );
    expect(event!.details.after).toEqual({
      revenueLtm: record.revenue_ltm,
      ebitdaLtm: record.ebitda_ltm,
      ev: record.ev,
      netDebt: record.net_debt,
    });
    expect(event!.details.before.revenueLtm).toBe(previous.revenue_ltm);
  });

  it('answers 409 when another command changed a row between this command reading it and writing it; nothing of the batch is kept', async () => {
    const waiting = await stageOne('conflict-validated.csv', cleanLine(plainNumbers()[2]!));
    expect(waiting.status).toBe('validated');
    const flagged = await stageOne('conflict-flagged.csv', {
      ...cleanLine(plainNumbers()[2]!),
      InvestmentNumber: 'INV-9998',
      CompanyName: 'Nowhere Example Holdings',
    });
    expect(flagged.status).toBe('flagged');
    const fileOf = async (rowId: string): Promise<string> =>
      (
        await h.runtime.db.query<{ intake_file_id: string }>(
          'select intake_file_id from stg.intake_row where id = $1',
          [rowId],
        )
      )[0]!.intake_file_id;
    // Commands on one file run one at a time (the file row is locked), so the window a second
    // transaction could use is the one between a command reading its rows and writing them. The
    // test database has one connection: the other reviewer's write is replayed inside the
    // command's own transaction, right before its write.
    type CommandSeam = Record<'promote' | 'reject', (tx: Tx, ...rest: unknown[]) => Promise<void>>;
    const changedUnderneath = async (
      method: keyof CommandSeam,
      rowId: string,
      status: string,
      run: () => Promise<void>,
    ): Promise<void> => {
      // The service's private command steps, reached as the seam this test needs and nothing else.
      const seam = h.app.get<IntakeService, CommandSeam>(IntakeService);
      const original = seam[method];
      seam[method] = async (tx, ...rest) => {
        await tx.execute(sql`update stg.intake_row set status = ${status} where id = ${rowId}`);
        return original.call(seam, tx, ...rest);
      };
      try {
        await run();
      } finally {
        seam[method] = original;
      }
    };
    const waitingFile = await fileOf(waiting.id);
    await changedUnderneath('promote', waiting.id, 'rejected', async () => {
      const res = await command(
        'operations',
        waitingFile,
        { command: 'approve' },
        'req-intake-conflict-1',
      ).expect(409);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}conflict`);
    });
    expect((await detail('operations', waitingFile)).rows[0]!.status).toBe('validated');
    expect(await auditCount('quarterly_performance.promote', 'req-intake-conflict-1')).toBe(0);
    expect(await auditCount('intake.approve', 'req-intake-conflict-1')).toBe(0);
    const flaggedFile = await fileOf(flagged.id);
    await changedUnderneath('reject', flagged.id, 'validated', async () => {
      const res = await command(
        'operations',
        flaggedFile,
        { command: 'reject', reason: 'Not on record' },
        'req-intake-conflict-2',
      ).expect(409);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}conflict`);
    });
    expect((await detail('operations', flaggedFile)).rows[0]!.status).toBe('flagged');
    expect(await auditCount('intake.reject', 'req-intake-conflict-2')).toBe(0);
    // Read and written in one go, the same commands go through.
    const approved = intakeFileDetail.parse(
      (await command('operations', waitingFile, { command: 'approve' }).expect(200)).body,
    );
    expect(approved.rows[0]!.status).toBe('promoted');
    const rejected = intakeFileDetail.parse(
      (
        await command('operations', flaggedFile, {
          command: 'reject',
          reason: 'Not on record',
        }).expect(200)
      ).body,
    );
    expect(rejected.rows[0]!.status).toBe('rejected');
  });

  it('never writes the entry snapshot: approving a row for that quarter is refused with 422 and the snapshot keeps its figures', async () => {
    const snapshotOf = (number: string) =>
      h.dataset.quarterlyPerformance.find(
        (q) => q.investmentId === investmentByNumber(number).id && q.isEntrySnapshot,
      );
    const number = plainNumbers().find((n) => {
      const snapshot = snapshotOf(n);
      return snapshot !== undefined && snapshot.revenueLtm !== null;
    })!;
    const inv = investmentByNumber(number);
    const snapshot = snapshotOf(number)!;
    expect(snapshot.status).toBe('record_status.approved');
    expect(snapshot.periodEnd).toBe(containingQuarterEnd(addMonths(inv.entryDate, -3)));
    const row = await stageOne('entry-snapshot.csv', {
      ...cleanLine(number),
      PeriodEnd: snapshot.periodEnd,
      RevenueLTM: D(snapshot.revenueLtm!).times('1.05').toFixed(2),
      EBITDALTM: snapshot.ebitdaLtm ?? '',
      EnterpriseValue: snapshot.ev ?? '',
      NetDebt: snapshot.netDebt ?? '',
      FairValue: '',
    });
    expect(row.targetId).toBe(snapshot.id);
    expect(row.diff.kind).toBe('changed');
    // The row is made to wait for approval whatever the rules said of it: the refusal is the
    // API's own guard, and it holds even when no rule flags the quarter.
    await h.runtime.db.query("update stg.intake_row set status = 'validated' where id = $1", [
      row.id,
    ]);
    const fileId = (
      await h.runtime.db.query<{ intake_file_id: string }>(
        'select intake_file_id from stg.intake_row where id = $1',
        [row.id],
      )
    )[0]!.intake_file_id;
    const before = (await onRecord(inv.id, snapshot.periodEnd))!;
    const res = await command(
      'operations',
      fileId,
      { command: 'approve' },
      'req-intake-snapshot-1',
    ).expect(422);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}workflow-precondition`);
    expect(problem.detail).toContain('entry snapshot');
    const after = (await onRecord(inv.id, snapshot.periodEnd))!;
    expect(after).toEqual(before);
    expect(after.is_entry_snapshot).toBe(true);
    expect(after.revenue_ltm).toBe(snapshot.revenueLtm);
    expect(await auditCount('quarterly_performance.promote', 'req-intake-snapshot-1')).toBe(0);
    expect((await detail('operations', fileId)).rows[0]!.status).toBe('validated');
  });

  it('refuses to promote a row whose quarter on record changed since the file was staged; nothing of the batch is written', async () => {
    // The clean file was staged before the update file restated a position: its row for that
    // position still says "unchanged" against figures the record no longer holds, and approving
    // it would revert the restatement in silence.
    const restatedNumber = update.expectations.changed[0]!;
    const restated = investmentByNumber(restatedNumber);
    const current = (await onRecord(restated.id, periodEnd()))!;
    expect(D(current.revenue_ltm!).eq(D(seededQuarter(restated.id, periodEnd()).revenueLtm!))).toBe(
      false,
    );
    const before = await productionRows();
    const cleanBefore = await detail('deal.one', cleanFile.id);
    const cleanRow = cleanBefore.rows.find((r) => r.investmentNumber === restatedNumber)!;
    expect(cleanRow.diff).toEqual({ kind: 'unchanged', changes: [] });
    expect(cleanRow.status).toBe('validated');
    for (const body of [{ command: 'approve' }, { command: 'approve', rowIds: [cleanRow.id] }]) {
      const res = await command('deal_team', cleanFile.id, body, 'req-intake-stale-1').expect(422);
      const problem = problemDetails.parse(res.body);
      expect(problem.type).toBe(`${PROBLEM}workflow-precondition`);
      expect(problem.detail).toBe(
        'staging: the quarter on record changed since the file was staged; import the file again',
      );
    }
    // The restatement stands, no row of the file was promoted, nothing was audited.
    expect(await productionRows()).toBe(before);
    expect(await onRecord(restated.id, periodEnd())).toEqual(current);
    const cleanAfter = await detail('deal.one', cleanFile.id);
    expect(cleanAfter.counts).toEqual(cleanBefore.counts);
    expect(cleanAfter.status).toBe('validated');
    expect(await auditCount('quarterly_performance.promote', 'req-intake-stale-1')).toBe(0);
    expect(await auditCount('intake.approve', 'req-intake-stale-1')).toBe(0);
  });

  it('links a row by a company alias exactly, never by a near miss of it (docs/03 section 5, migration 0010)', async () => {
    const alias = (h.dataset.companyAliases ?? [])[0];
    if (alias === undefined) return; // a dataset made before migration 0010 carries no aliases
    const inv = h.dataset.investments.find(
      (i) =>
        i.portfolioCompanyId === alias.portfolioCompanyId &&
        i.isActive &&
        i.dealType !== 'deal_type.private_credit' &&
        i.id !== walledId(),
    );
    if (inv === undefined) return; // the first aliased company has no active equity position in this profile
    const table = parseCsv(clean.csv);
    const line = table.rows.find(
      (r) => r[table.header.indexOf('InvestmentNumber')] === inv.investmentNumber,
    );
    if (line === undefined) return;
    const cells = [...line];
    cells[table.header.indexOf('InvestmentNumber')] = '';
    cells[table.header.indexOf('CompanyName')] = alias.alias;
    const byAlias = intakeImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'alias-linked.csv',
          csv: `${table.header.join(',')}\n${cells.join(',')}\n`,
        }).expect(201)
      ).body,
    );
    expect(byAlias.rows[0]!.link).toMatchObject({ status: 'matched', investmentId: inv.id });
    expect(byAlias.rows[0]!.link.investmentNumber).toBe(inv.investmentNumber);
    expect(byAlias.exceptions).toBe(0);
  });

  it('answers 404 on the accounting file pages for a weekly file and a look-through run, whose rows are not accounting-shaped', async () => {
    // A weekly values file and a reconcile run are intake files of their own sources with their
    // own pages: the accounting detail and commands answer the accounting sources only (stage.ts
    // ACCOUNTING_SOURCES), so neither is found here, and no command locks or reads them.
    const aliased = { ...h.dataset, companyAliases: h.dataset.companyAliases ?? [] };
    const weekly = weeklyValues(aliased, { scenario: 'clean' });
    const weeklyFile = weeklyImportResult.parse(
      (
        await h
          .http()
          .post('/api/v1/intake/weekly')
          .set('authorization', h.as('operations'))
          .send({ fileName: weekly.fileName, csv: weekly.csv })
          .expect(201)
      ).body,
    );
    const folder = join(h.runtime.config.PB_DROP_ROOT, 'lookthrough');
    mkdirSync(folder, { recursive: true });
    const extract = lookthroughExtract(aliased, { scenario: 'clean' });
    writeFileSync(join(folder, `${extract.asOf}.json`), extract.json);
    const run = lookthroughReconcileResult.parse(
      (
        await h
          .http()
          .post('/api/v1/intake/lookthrough/reconcile')
          .set('authorization', h.as('operations'))
          .send({ asOf: extract.asOf })
          .expect(201)
      ).body,
    );
    for (const [what, id] of [
      ['weekly file', weeklyFile.id],
      ['look-through run', run.id],
    ] as const) {
      const res = await h
        .http()
        .get(`/api/v1/intake/files/${id}`)
        .set('authorization', h.as('head.one'))
        .expect(404);
      expect(problemDetails.parse(res.body).type, what).toBe(`${PROBLEM}not-found`);
      expect(problemDetails.parse(res.body).detail, what).toBe('Intake file not found');
      await command('operations', id, { command: 'approve' }).expect(404);
      await command('deal.three', id, {
        command: 'reject',
        reason: 'Not an accounting file',
      }).expect(404);
    }
    // Their own pages answer them, and the list carries both under their sources.
    await h
      .http()
      .get(`/api/v1/intake/weekly/files/${weeklyFile.id}`)
      .set('authorization', h.as('operations'))
      .expect(200);
    await h
      .http()
      .get(`/api/v1/intake/lookthrough/runs/${run.id}`)
      .set('authorization', h.as('operations'))
      .expect(200);
    const listed = intakeFilePage.parse(
      (
        await h
          .http()
          .get('/api/v1/intake/files?limit=50')
          .set('authorization', h.as('auditor'))
          .expect(200)
      ).body,
    );
    expect(listed.items.find((f) => f.id === weeklyFile.id)?.source).toBe('weekly');
    expect(listed.items.find((f) => f.id === run.id)?.source).toBe('lookthrough');
  });
});

describe('an API whose accounting layout is malformed', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ accountingLayout: { export: { format: 'xlsx' } } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers the import with a 500 configuration problem and stages nothing', async () => {
    const file = accountingExport(h.dataset, { scenario: 'clean' });
    const res = await h
      .http()
      .post('/api/v1/intake/accounting')
      .set('authorization', h.as('operations'))
      .send({ fileName: file.fileName, csv: file.csv })
      .expect(500);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}configuration`);
    expect(problem.detail).toBe('config/accounting_layout.json is not a usable accounting layout');
    const rows = await h.runtime.db.query<{ n: number }>(
      'select count(*)::int as n from stg.intake_file',
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe('an API whose config lacks the intake block', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ withoutDefinitions: ['intake'] });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers the import with a 500 configuration problem naming the key, never a default', async () => {
    const file = accountingExport(h.dataset, { scenario: 'clean' });
    const res = await h
      .http()
      .post('/api/v1/intake/accounting')
      .set('authorization', h.as('operations'))
      .send({ fileName: file.fileName, csv: file.csv })
      .expect(500);
    expect(problemDetails.parse(res.body).detail).toBe(
      'config/definitions.json is missing a usable intake',
    );
    // The reads that need no threshold still answer.
    await h.http().get('/api/v1/intake/files').set('authorization', h.as('operations')).expect(200);
  });
});

describe('an API whose accounting layout is corrected after it refused an export', () => {
  let h: Harness;
  // The layout the API starts with lacks the CompanyName column the export carries (the accounting
  // system added a column the layout does not know yet). The object is the one the API reads on
  // every import, so correcting it in place is the config change operations would make.
  const layout = accountingLayout.parse(
    JSON.parse(
      readFileSync(new URL('../../../../config/accounting_layout.json', import.meta.url), 'utf8'),
    ),
  );
  const companyColumn = layout.export.columns.findIndex((c) => c.name === 'CompanyName');
  const [dropped] = layout.export.columns.splice(companyColumn, 1);
  beforeAll(async () => {
    h = await startHarness({ accountingLayout: layout });
  });
  afterAll(async () => {
    await h.close();
  });

  it('stages the same bytes once the layout knows the column, under the file row the refusal left behind', async () => {
    expect(h.runtime.accountingLayout).toBe(layout);
    const file = accountingExport(h.dataset, { scenario: 'clean' });
    const importAs = async (who: string, requestId: string): Promise<IntakeImportResult> =>
      intakeImportResult.parse(
        (
          await h
            .http()
            .post('/api/v1/intake/accounting')
            .set('authorization', h.as(who))
            .set('x-request-id', requestId)
            .send({ fileName: file.fileName, csv: file.csv })
            .expect(201)
        ).body,
      );
    const files = async (): Promise<number> =>
      (
        await h.runtime.db.query<{ n: number }>('select count(*)::int as n from stg.intake_file')
      )[0]!.n;
    const rowsOf = async (fileId: string): Promise<number> =>
      (
        await h.runtime.db.query<{ n: number }>(
          'select count(*)::int as n from stg.intake_row where intake_file_id = $1',
          [fileId],
        )
      )[0]!.n;
    const audited = async (action: string, requestId: string): Promise<number> =>
      (
        await h.runtime.db.query<{ n: number }>(
          'select count(*)::int as n from audit.event where action = $1 and request_id = $2',
          [action, requestId],
        )
      )[0]!.n;

    const refused = await importAs('ops.one', 'req-restage-1');
    expect(refused.duplicate).toBe(false);
    expect(refused.status).toBe('new');
    expect(refused.rowCount).toBe(0);
    expect(refused.rows).toEqual([]);
    expect(refused.fileFindings.map((f) => [f.ruleId, f.field])).toEqual([
      ['LAYOUT-01', 'CompanyName'],
    ]);
    // Refused again under the same layout: the same file, nothing staged, the findings current.
    const again = await importAs('ops.one', 'req-restage-2');
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(refused.id);
    expect(again.status).toBe('new');
    expect(again.rowCount).toBe(0);
    expect(again.fileFindings).toEqual(refused.fileFindings);
    expect(await files()).toBe(1);
    expect(await rowsOf(refused.id)).toBe(0);
    expect(await audited('intake.import', 'req-restage-2')).toBe(1);

    // Operations corrects the layout (config, no code change) and imports the same bytes again:
    // the file is staged, not answered as a duplicate, and keeps its id and hash.
    layout.export.columns.splice(companyColumn, 0, dropped!);
    const staged = await importAs('ops.two', 'req-restage-3');
    expect(staged.duplicate).toBe(false);
    expect(staged.id).toBe(refused.id);
    expect(staged.contentHash).toBe(refused.contentHash);
    expect(staged.fileName).toBe(file.fileName);
    expect(staged.status).toBe('validated');
    expect(staged.rowCount).toBe(file.expectations.rows);
    expect(staged.rows.length + staged.hiddenRows).toBe(file.expectations.rows);
    expect(staged.rows.every((r) => r.status === 'validated')).toBe(true);
    expect(staged.fileFindings).toEqual([]);
    // This receipt is the one on record.
    expect(staged.receivedBy).toBe(
      h.dataset.users.find((u) => u.externalId === 'ops.two')!.displayName,
    );
    expect(new Date(staged.receivedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(refused.receivedAt).getTime(),
    );
    expect(await files()).toBe(1);
    expect(await rowsOf(refused.id)).toBe(file.expectations.rows);
    expect(await audited('intake.import', 'req-restage-3')).toBe(1);
    // From here on the content is a duplicate like any other: answered, audited as a read, unchanged.
    const duplicate = await importAs('ops.one', 'req-restage-4');
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.id).toBe(refused.id);
    expect(duplicate.receivedBy).toBe(staged.receivedBy);
    expect(await rowsOf(refused.id)).toBe(file.expectations.rows);
    expect(await audited('intake_file.read', 'req-restage-4')).toBe(1);
    expect(await audited('intake.import', 'req-restage-4')).toBe(0);
  });
});
