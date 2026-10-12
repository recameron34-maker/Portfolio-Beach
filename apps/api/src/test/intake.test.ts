import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, addMonths, containingQuarterEnd, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  intakeExportList,
  intakeFileDetail,
  intakeFilePage,
  intakeImportResult,
  problemDetails,
} from '@pb/contracts';
import type { IntakeFileDetail, IntakeImportResult, IntakeRow } from '@pb/contracts';
import { accountingExport, accountingExports } from '@pb/synthetic';
import type { AccountingExport } from '@pb/synthetic';
import { parseCsv } from '@pb/validation';
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
    // The seed puts no operations user on the wall, so the importer could never link the walled
    // position. ops.one joins it for this suite; ops.two stays outside, as does deal.one.
    const wall = h.dataset.walls[0]!;
    await h.runtime.db.query('insert into core.wall_member (wall_id, user_id) values ($1, $2)', [
      wall.id,
      user('ops.one').id,
    ]);
    clean = accountingExport(h.dataset, { scenario: 'clean' });
    update = accountingExport(h.dataset, { scenario: 'update' });
    defects = accountingExport(h.dataset, { scenario: 'defects' });
  });
  afterAll(async () => {
    await h.close();
  });

  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
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
    expect(cleanFile.rows.length).toBe(clean.expectations.rows);
    expect(cleanFile.rowCount).toBe(clean.expectations.rows);
    expect(cleanFile.hiddenRows).toBe(0);
    expect(cleanFile.fileFindings).toEqual([]);
    for (const row of cleanFile.rows) {
      expect(row.link.status, `row ${row.rowNo}`).toBe('matched');
      expect(row.link.investmentNumber).toBe(row.investmentNumber);
      expect(row.link.investmentId).toBe(investmentByNumber(row.investmentNumber!).id);
      expect(row.link.candidates).toEqual([]);
      expect(row.diff).toEqual({ kind: 'unchanged', changes: [] });
      expect(row.targetId).toBe(seededQuarter(row.link.investmentId!, periodEnd()).id);
      expect(row.status).toBe('validated');
      expect(hasError(row), `row ${row.rowNo}`).toBe(false);
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
      (await importAs('operations', { fileName: 'renamed-copy.csv', csv: clean.csv }).expect(201))
        .body,
    );
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(cleanFile.id);
    expect(again.fileName).toBe(clean.fileName);
    expect(again.contentHash).toBe(cleanFile.contentHash);
    expect(await count('select count(*)::int as n from stg.intake_file')).toBe(files);
    expect(await stagedRows()).toBe(rows);
    expect(await count('select count(*)::int as n from ops.data_exception')).toBe(exceptions);
  });

  it('stages an update export: the restated row and the supplied quarter carry their changes; production untouched', async () => {
    const before = await productionRows();
    updateFile = await stage(update, 'req-intake-update-1');
    expect(updateFile.duplicate).toBe(false);
    expect(updateFile.rows.length).toBe(update.expectations.rows);
    const changed = new Set(update.expectations.changed);
    const added = new Set(update.expectations.added);
    expect(changed.size).toBeGreaterThan(0);
    expect(added.size).toBeGreaterThan(0);
    for (const row of updateFile.rows) {
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

  it('stages a defects export: each defect row is flagged by its rule, unresolved names open exceptions', async () => {
    defectsFile = await stage(defects, 'req-intake-defects-1');
    expect(defectsFile.rows.length).toBe(defects.expectations.rows);
    expect(defects.expectations.flagged.length).toBeGreaterThanOrEqual(6);
    for (const { rowNo: n, ruleId } of defects.expectations.flagged) {
      const row = rowNo(defectsFile, n);
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
    const unmatched = defectsFile.rows.filter((r) => r.link.status === 'unmatched');
    expect(unmatched.length).toBe(2);
    const nearMiss = unmatched.find((r) => r.investmentNumber === null)!;
    const sample = defectsFile.rows[1]!;
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
    const guarded = defectsFile.rows.filter((r) => r.link.status === 'guarded');
    expect(guarded.length).toBe(1);
    expect(guarded[0]!.status).toBe('flagged');
    expect(guarded[0]!.findings.map((f) => f.ruleId)).toContain('XREF-02');
    expect(guarded[0]!.link.candidates.some((c) => c.reason === 'match guard')).toBe(true);
    expect(guarded[0]!.companyName).toBe(h.dataset.matchGuards[0]!.nameB);
    // The duplicate row shares its natural key with the row it repeats and is flagged, not dropped.
    const dup = defects.expectations.flagged.find((f) => f.ruleId === 'DUP-01')!;
    const dupRow = rowNo(defectsFile, dup.rowNo);
    const first = defectsFile.rows.find(
      (r) => r.rowNo < dup.rowNo && r.naturalKey === dupRow.naturalKey,
    );
    expect(first).toBeDefined();
    expect(first!.status).toBe('validated');
    // Exceptions: one per unresolved link and one per fair value that does not tie.
    const ties = defectsFile.rows.flatMap((r) => r.findings.filter((f) => f.ruleId === 'TIE-01'));
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
    const tie = opened.find((x) => x.rule_id === 'TIE-01')!;
    expect(tie.expected).toBe(ties[0]!.expected);
    expect(tie.actual).toBe(ties[0]!.actual);
    expect(opened.find((x) => x.rule_id === 'XREF-02')!.candidates.length).toBeGreaterThan(0);
    expect(defectsFile.status).toBe('flagged');
    expect(defectsFile.counts.flagged).toBe(
      defectsFile.rows.filter((r) => r.status === 'flagged').length,
    );
    expect(defectsFile.counts.flagged + defectsFile.counts.validated).toBe(
      defects.expectations.rows,
    );
  });

  it('hides rows linked to a walled investment from a reviewer outside the wall and counts them', async () => {
    const ops = await detail('operations', cleanFile.id, 'req-intake-detail-ops-1');
    expect(ops.hiddenRows).toBe(0);
    const walledRow = ops.rows.find((r) => r.link.investmentId === walledId());
    expect(walledRow).toBeDefined();
    const outsider = await detail('deal.one', cleanFile.id, 'req-intake-detail-deal-1');
    expect(outsider.hiddenRows).toBe(1);
    expect(outsider.rows.length).toBe(ops.rows.length - 1);
    expect(outsider.rows.some((r) => r.link.investmentId === walledId())).toBe(false);
    expect(JSON.stringify(outsider)).not.toContain(walledId());
    // The file reads the same for everyone: counts cover every row, hidden ones included.
    expect(outsider.counts).toEqual(ops.counts);
    expect(outsider.rowCount).toBe(ops.rowCount);
    const member = await detail('deal.three', cleanFile.id);
    expect(member.hiddenRows).toBe(0);
    expect(member.rows.length).toBe(ops.rows.length);
    // Each open is a sensitive read on record, without values.
    expect(await auditCount('intake_file.read', 'req-intake-detail-deal-1')).toBe(1);
    const [event] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
      "select details from audit.event where action = 'intake_file.read' and request_id = 'req-intake-detail-deal-1'",
    );
    expect(event!.details).toEqual({});
    // Naming a hidden row is the same as naming a row of another file: not one the caller may act on.
    const refused = await command('deal.one', cleanFile.id, {
      command: 'approve',
      rowIds: [walledRow!.id],
    }).expect(400);
    expect(problemDetails.parse(refused.body).errors?.map((e) => e.path)).toEqual(['rowIds']);
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
  });

  it('approves named rows of the defects file one at a time; flagged rows stay flagged', async () => {
    const current = await detail('operations', defectsFile.id);
    const flagged = current.rows.filter((r) => r.status === 'flagged');
    const validated = current.rows.filter((r) => r.status === 'validated');
    expect(flagged.length).toBeGreaterThan(0);
    expect(validated.length).toBeGreaterThan(1);
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
    expect(one.counts.validated).toBe(validated.length - 1);
    expect(one.counts.flagged).toBe(flagged.length);
    expect(rowNo(one, validated[0]!.rowNo).decision).toBe('Figures checked with the sponsor');
    expect(await auditCount('quarterly_performance.promote', 'req-intake-approve-3')).toBe(1);
    const rest = intakeFileDetail.parse(
      (await command('operations', defectsFile.id, { command: 'approve' }).expect(200)).body,
    );
    expect(rest.counts.promoted).toBe(validated.length);
    expect(rest.counts.validated).toBe(0);
    expect(rest.counts.flagged).toBe(flagged.length);
    expect(rest.status).toBe('flagged');
    for (const f of flagged) expect(rowNo(rest, f.rowNo).status).toBe('flagged');
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
    expect(rejected.counts.flagged).toBe(0);
    expect(rejected.counts.rejected).toBe(stillFlagged.counts.flagged);
    for (const row of rejected.rows.filter((r) => r.status === 'rejected')) {
      expect(row.decision).toBe(reason);
      expect(row.decidedBy).toBe(user('ops.one').displayName);
      expect(row.promotedAt).toBeNull();
    }
    // Every row is now promoted or rejected, so the file is promoted.
    expect(rejected.status).toBe('promoted');
    expect(await auditCount('intake.reject', 'req-intake-reject-1')).toBe(1);
    const again = intakeFileDetail.parse(
      (await command('operations', defectsFile.id, { command: 'reject', reason }).expect(200)).body,
    );
    expect(again.counts).toEqual(rejected.counts);
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
    const promoted = await list('?status=promoted');
    expect(promoted.items.map((f) => f.id)).toEqual([defectsFile.id]);
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
    expect(earlier.rows.length).toBe(prior.expectations.rows);
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
