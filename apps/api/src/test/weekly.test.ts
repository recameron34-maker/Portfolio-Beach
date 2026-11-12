import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, addDays } from '@pb/calc';
import {
  intakeExportList,
  intakeFilePage,
  problemDetails,
  weeklyFileDetail,
  weeklyImportResult,
} from '@pb/contracts';
import type { WeeklyFileDetail, WeeklyImportResult, WeeklyRow } from '@pb/contracts';
import type { Tx } from '@pb/db';
import { latestLockedMark, weeklyValues } from '@pb/synthetic';
import type { AliasedDataset, WeeklyValues } from '@pb/synthetic';
import { WEEKLY_COLUMNS } from '@pb/validation';
import { WeeklyService } from '../intake/weekly/weekly.service.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

interface DraftOnRecord extends Record<string, unknown> {
  id: string;
  investment_id: string;
  period_end: string;
  version: number;
  method: string;
  inputs: Record<string, unknown>;
  fair_value: string;
  state: string;
  prepared_by: string | null;
  approved_by: string | null;
}

const PROBLEM = 'https://portfolio-beach.example/problems/';
const DECIMAL = /^-?\d+(\.\d+)?$/;

describe('weekly report values intake (M2, SEC-9.1, decision 0010): staging, the prior, approval, then a Draft valuation', () => {
  let h: Harness;
  let clean: WeeklyValues;
  let update: WeeklyValues;
  let defects: WeeklyValues;
  let cleanFile: WeeklyImportResult;
  let updateFile: WeeklyImportResult;
  let defectsFile: WeeklyImportResult;

  /** The seeded dataset with its company aliases, as the weekly generator reads it. */
  const aliased = (): AliasedDataset => ({
    ...h.dataset,
    companyAliases: h.dataset.companyAliases ?? [],
  });

  beforeAll(async () => {
    h = await startHarness();
    // No operations user is on the wall: ops.one imports from outside it, deal.three and head.one
    // are its members, deal.one and ops.two are outside it.
    clean = weeklyValues(aliased(), { scenario: 'clean' });
    update = weeklyValues(aliased(), { scenario: 'update' });
    defects = weeklyValues(aliased(), { scenario: 'defects' });
  });
  afterAll(async () => {
    await h.close();
  });

  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const walledNumber = (): string =>
    h.dataset.investments.find((i) => i.id === walledId())!.investmentNumber;
  const walledCompanyName = (): string => {
    const inv = h.dataset.investments.find((i) => i.id === walledId())!;
    return h.dataset.portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId)!.name;
  };
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql, params))[0]!.n;
  const stagedRows = (): Promise<number> => count('select count(*)::int as n from stg.valuation');
  const valuationRows = (): Promise<number> =>
    count('select count(*)::int as n from mon.valuation');
  const auditCount = (action: string, requestId: string): Promise<number> =>
    count('select count(*)::int as n from audit.event where action = $1 and request_id = $2', [
      action,
      requestId,
    ]);
  const draft = async (id: string): Promise<DraftOnRecord | null> =>
    (
      await h.runtime.db.query<DraftOnRecord>(
        `select id, investment_id, period_end::text as period_end, version, method, inputs,
                fair_value::text as fair_value, state, prepared_by, approved_by
         from mon.valuation where id = $1`,
        [id],
      )
    )[0] ?? null;
  const investmentByNumber = (n: string) =>
    h.dataset.investments.find((i) => i.investmentNumber === n)!;
  /** The Locked mark the generator built a row from: the latest on or before the report date. */
  const markBefore = (investmentId: string, reportDate: string) =>
    latestLockedMark(h.dataset.valuations, investmentId, reportDate)!;
  /** A cell of the file as it wrote it, by data line and column name. */
  const cellOf = (file: WeeklyValues, rowNo: number, column: string): string =>
    file.rows[rowNo - 1]![file.header.indexOf(column)] ?? '';

  const importAs = (who: string, body: object, requestId = 'req-weekly-import') =>
    h
      .http()
      .post('/api/v1/intake/weekly')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const stage = async (
    file: Pick<WeeklyValues, 'fileName' | 'csv'>,
    requestId = 'req-weekly-import',
  ): Promise<WeeklyImportResult> =>
    weeklyImportResult.parse(
      (
        await importAs('operations', { fileName: file.fileName, csv: file.csv }, requestId).expect(
          201,
        )
      ).body,
    );
  const detail = async (
    who: string,
    id: string,
    requestId = 'req-weekly-detail',
  ): Promise<WeeklyFileDetail> =>
    weeklyFileDetail.parse(
      (
        await h
          .http()
          .get(`/api/v1/intake/weekly/files/${id}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );
  const command = (who: string, id: string, body: object, requestId = 'req-weekly-command') =>
    h
      .http()
      .post(`/api/v1/intake/weekly/files/${id}/commands`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  /** The file as a wall member sees it: every row (head.one is an approver on the wall). */
  const fullView = (id: string): Promise<WeeklyFileDetail> => detail('head.one', id);
  const rowNo = (file: WeeklyFileDetail, n: number): WeeklyRow =>
    file.rows.find((r) => r.rowNo === n)!;
  const hasError = (row: WeeklyRow): boolean => row.findings.some((f) => f.severity === 'error');
  /** Versions on record for a position and period end before any weekly approval (the seed). */
  const seededVersions = (investmentId: string, periodEnd: string): number =>
    h.dataset.valuations.filter((v) => v.investmentId === investmentId && v.periodEnd === periodEnd)
      .length;
  /**
   * A line of the clean file for a numbered position outside the wall whose latest Locked mark
   * before `date` is the value the line carries (not the sponsor that closes a few days early,
   * whose mark sits on the report date itself), as cells by column name.
   */
  const plainLine = (date: string): Record<string, string> => {
    const line = clean.rows.find((r) => {
      if (r[0] === '' || r[0] === walledNumber()) return false;
      const mark = latestLockedMark(h.dataset.valuations, investmentByNumber(r[0]!).id, date);
      return mark !== null && mark.periodEnd < date && mark.fairValue === r[3];
    })!;
    return Object.fromEntries(clean.header.map((c, i) => [c, line[i] ?? '']));
  };
  /** A one-row file in the weekly columns, cells by column name; a cell not named is blank. */
  const oneRowCsv = (cells: Record<string, string>): string =>
    `${WEEKLY_COLUMNS.join(',')}\n${WEEKLY_COLUMNS.map((c) => cells[c] ?? '').join(',')}\n`;

  it('lets only operations import; every other role is refused before anything is read', async () => {
    for (const who of ['viewer', 'deal_team', 'approver', 'auditor', 'platform_admin']) {
      const res = await importAs(who, { fileName: clean.fileName, csv: clean.csv }).expect(403);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}forbidden`);
    }
    expect(await stagedRows()).toBe(0);
  });

  it('answers a malformed body with a 400 validation problem that carries paths only', async () => {
    const marker = 'MARKER-NEVER-ECHOED-0002';
    for (const body of [
      {},
      { fileName: 'weekly.csv' },
      { fileName: 'weekly.csv', csv: clean.csv, extra: marker },
      { dropId: marker, fileName: 'x.csv' },
      { exportId: marker },
    ]) {
      const res = await importAs('operations', body).expect(400);
      const problem = problemDetails.parse(res.body);
      expect(problem.type).toBe(`${PROBLEM}validation`);
      expect(problem.errors?.length).toBeGreaterThan(0);
      for (const e of problem.errors ?? [])
        expect(Object.keys(e).sort()).toEqual(['message', 'path']);
      expect(JSON.stringify(res.body)).not.toContain(marker);
    }
    expect(await stagedRows()).toBe(0);
  });

  it('stages a clean file: every row linked, compared with the mark on or before the report date, variance zero, validated; no valuation written', async () => {
    const before = await valuationRows();
    cleanFile = await stage(clean, 'req-weekly-clean-1');
    expect(cleanFile.duplicate).toBe(false);
    expect(cleanFile.source).toBe('weekly');
    expect(cleanFile.templateSignature).toBeNull();
    expect(cleanFile.fileName).toBe(clean.fileName);
    expect(cleanFile.receivedBy).toBe(user('ops.one').displayName);
    expect(cleanFile.rowCount).toBe(clean.expectations.rows);
    // The importer is outside the wall: the walled position's row links all the same (never a
    // "no match") and is left out of their view and counted (decision 0009, SEC-5.3).
    expect(cleanFile.hiddenRows).toBe(clean.expectations.walled.length);
    expect(cleanFile.rows.length).toBe(clean.expectations.rows - clean.expectations.walled.length);
    expect(cleanFile.fileFindings).toEqual([]);
    expect(JSON.stringify(cleanFile)).not.toContain(walledNumber());
    expect(JSON.stringify(cleanFile)).not.toContain(walledCompanyName());
    const everyRow = (await fullView(cleanFile.id)).rows;
    expect(everyRow.length).toBe(clean.expectations.rows);
    expect(clean.expectations.aliased.length).toBe(1);
    for (const row of everyRow) {
      expect(row.link.status, `row ${row.rowNo}`).toBe('matched');
      expect(row.link.candidates).toEqual([]);
      expect(row.reportDate).toBe(clean.reportDate);
      expect(row.reportedValue).toBe(cellOf(clean, row.rowNo, 'ReportedValue'));
      // The prior is the latest Locked mark on or before the report date: never the as-of
      // quarter's mark, which was locked for a later date (decision 0010).
      const mark = markBefore(row.link.investmentId!, clean.reportDate);
      expect(row.priorSource).toBe('locked_mark');
      expect(row.priorDate).toBe(mark.periodEnd);
      expect(row.priorDate! <= row.reportDate!).toBe(true);
      expect(row.priorDate).not.toBe(h.dataset.asOf);
      expect(D(row.priorValue!).eq(D(mark.fairValue))).toBe(true);
      expect(D(row.variancePct!).isZero()).toBe(true);
      expect(row.flag).toBeNull();
      expect(row.status).toBe('validated');
      expect(hasError(row), `row ${row.rowNo}`).toBe(false);
      expect(row.findings).toEqual([]);
      expect(row.decision).toBeNull();
      expect(row.decidedAt).toBeNull();
      expect(row.valuationId).toBeNull();
      // The alias row carries an alias and no number: it links by the alias (docs/03 section 5).
      if (clean.expectations.aliased.includes(row.rowNo)) {
        expect(row.investmentNumber).toBeNull();
        expect(row.companyName).toBe(cellOf(clean, row.rowNo, 'CompanyName'));
        expect(row.link.companyName).not.toBe(row.companyName);
      } else {
        expect(row.link.investmentNumber).toBe(row.investmentNumber);
        expect(row.link.investmentId).toBe(investmentByNumber(row.investmentNumber!).id);
      }
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
    // Nothing reaches mon.valuation before approval (docs/04 M2 AC).
    expect(await valuationRows()).toBe(before);
    expect(await stagedRows()).toBe(clean.expectations.rows);
    // One audit event with counts only: no value from the file travels into the trail.
    expect(await auditCount('intake.import', 'req-weekly-clean-1')).toBe(1);
    const [event] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
      "select details from audit.event where action = 'intake.import' and request_id = 'req-weekly-clean-1'",
    );
    expect(Object.keys(event!.details).sort()).toEqual(['counts', 'fileName', 'rowCount']);
    expect(JSON.stringify(event!.details)).not.toContain(cellOf(clean, 2, 'ReportedValue'));
  });

  it('answers the same content again with the file it staged before and stages nothing', async () => {
    const files = await count('select count(*)::int as n from stg.intake_file');
    const rows = await stagedRows();
    const again = weeklyImportResult.parse(
      (
        await importAs(
          'operations',
          { fileName: 'renamed-copy.csv', csv: clean.csv },
          'req-weekly-duplicate-1',
        ).expect(201)
      ).body,
    );
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(cleanFile.id);
    expect(again.fileName).toBe(clean.fileName);
    expect(again.contentHash).toBe(cleanFile.contentHash);
    expect(await count('select count(*)::int as n from stg.intake_file')).toBe(files);
    expect(await stagedRows()).toBe(rows);
    expect(await auditCount('intake_file.read', 'req-weekly-duplicate-1')).toBe(1);
    expect(await auditCount('intake.import', 'req-weekly-duplicate-1')).toBe(0);
    // The same bytes under the accounting intake are another file: the hash is keyed with the source.
    const accounting = await h
      .http()
      .post('/api/v1/intake/accounting')
      .set('authorization', h.as('operations'))
      .send({ fileName: clean.fileName, csv: clean.csv })
      .expect(201);
    expect(accounting.body.duplicate).toBe(false);
    expect(accounting.body.id).not.toBe(cleanFile.id);
  });

  it('stages an update file: the three moved rows carry their variance inside the threshold and pass', async () => {
    updateFile = await stage(update, 'req-weekly-update-1');
    expect(updateFile.duplicate).toBe(false);
    const everyRow = (await fullView(updateFile.id)).rows;
    expect(everyRow.length).toBe(update.expectations.rows);
    expect(update.expectations.moved.length).toBe(3);
    const moved = new Map(update.expectations.moved.map((m) => [m.investmentNumber, m.pct]));
    for (const row of everyRow) {
      expect(row.link.status).toBe('matched');
      expect(row.status, `row ${row.rowNo}`).toBe('validated');
      expect(row.flag).toBeNull();
      const pct = row.investmentNumber === null ? undefined : moved.get(row.investmentNumber);
      if (pct !== undefined) {
        // The variance is the move the generator applied, to the rounding of the stored value.
        expect(D(row.variancePct!).minus(D(pct)).abs().lt(D('0.0000001'))).toBe(true);
        expect(D(row.variancePct!).abs().lt(D('0.1'))).toBe(true);
        expect(D(row.reportedValue!).eq(D(row.priorValue!))).toBe(false);
      } else {
        expect(D(row.variancePct!).isZero()).toBe(true);
      }
    }
    expect(updateFile.status).toBe('validated');
    expect(updateFile.exceptions).toBe(0);
  });

  it('hides rows linked to a walled investment from everyone outside the wall and counts them; each open is audited without values', async () => {
    const ops = await detail('operations', cleanFile.id, 'req-weekly-detail-ops-1');
    expect(ops.hiddenRows).toBe(1);
    expect(ops.rows.some((r) => r.link.investmentId === walledId())).toBe(false);
    expect(JSON.stringify(ops)).not.toContain(walledId());
    expect(JSON.stringify(ops)).not.toContain(walledCompanyName());
    const outsider = await detail('deal.one', cleanFile.id, 'req-weekly-detail-deal-1');
    expect(outsider.hiddenRows).toBe(1);
    expect(outsider.rows.length).toBe(ops.rows.length);
    expect(outsider.counts).toEqual(ops.counts);
    expect(outsider.rowCount).toBe(ops.rowCount);
    const member = await detail('deal.three', cleanFile.id);
    expect(member.hiddenRows).toBe(0);
    expect(member.rows.length).toBe(ops.rows.length + 1);
    const walledRow = member.rows.find((r) => r.link.investmentId === walledId())!;
    expect(walledRow.rowNo).toBe(clean.expectations.walled[0]);
    expect(walledRow.link.status).toBe('matched');
    expect(walledRow.status).toBe('validated');
    expect(await auditCount('intake_file.read', 'req-weekly-detail-deal-1')).toBe(1);
    const [event] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
      "select details from audit.event where action = 'intake_file.read' and request_id = 'req-weekly-detail-deal-1'",
    );
    expect(event!.details).toEqual({});
    // Naming a hidden row is the same as naming a row of another file: a 400 on rowIds.
    for (const who of ['deal.one', 'operations']) {
      const refused = await command(who, cleanFile.id, {
        command: 'approve',
        rowIds: [walledRow.id],
      }).expect(400);
      expect(problemDetails.parse(refused.body).errors?.map((e) => e.path)).toEqual(['rowIds']);
    }
  });

  it('answers 404 for an id that is not a UUID, an unknown id and a file of another intake', async () => {
    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-00000000abcd']) {
      await h
        .http()
        .get(`/api/v1/intake/weekly/files/${id}`)
        .set('authorization', h.as('operations'))
        .expect(404);
      await command('operations', id, { command: 'approve' }).expect(404);
    }
    // The accounting file staged from the same bytes is not a weekly file.
    const [accounting] = await h.runtime.db.query<{ id: string }>(
      "select id from stg.intake_file where source = 'accounting' order by received_at desc limit 1",
    );
    await h
      .http()
      .get(`/api/v1/intake/weekly/files/${accounting!.id}`)
      .set('authorization', h.as('operations'))
      .expect(404);
    await command('operations', accounting!.id, { command: 'approve' }).expect(404);
  });

  it('the deal team approves the update file: each validated row becomes a Draft valuation of method weekly_report in one transaction, audited; a second approve finds nothing', async () => {
    const before = await valuationRows();
    const visibleBefore = await detail('deal.one', updateFile.id);
    const toPromote = visibleBefore.rows.filter((r) => r.status === 'validated');
    expect(toPromote.length).toBeGreaterThan(0);
    const res = await command(
      'deal_team',
      updateFile.id,
      { command: 'approve' },
      'req-weekly-approve-1',
    ).expect(200);
    const after = weeklyFileDetail.parse(res.body);
    const approver = user('deal.one');
    const now = h.runtime.adapters.clock.now();
    for (const row of after.rows) {
      expect(row.status, `row ${row.rowNo}`).toBe('promoted');
      expect(row.decidedAt).toBe(now);
      expect(row.decidedBy).toBe(approver.displayName);
      expect(row.decision).toBe(`weekly values ${update.fileName}`);
      expect(row.valuationId).not.toBeNull();
      // The Draft: the linked investment at the report date, the next version for that day (the
      // sponsor that closes a few days early has its Locked mark on that very day, so its Draft
      // is version 2), the reported value, the reviewer as preparer, never Locked (decision 0010).
      const created = (await draft(row.valuationId!))!;
      expect(created.investment_id).toBe(row.link.investmentId);
      expect(created.period_end).toBe(row.reportDate);
      expect(created.version).toBe(seededVersions(row.link.investmentId!, row.reportDate!) + 1);
      expect(created.method).toBe('valuation_method.weekly_report');
      expect(created.state).toBe('Draft');
      expect(D(created.fair_value).eq(D(row.reportedValue!))).toBe(true);
      expect(created.prepared_by).toBe(approver.id);
      expect(created.approved_by).toBeNull();
      expect(created.inputs).toEqual({
        source: 'weekly',
        intakeFileId: updateFile.id,
        rowId: row.id,
        reportDate: row.reportDate,
        priorValue: row.priorValue,
        priorSource: 'locked_mark',
      });
    }
    // The walled row stays validated for a reviewer outside the wall: it was never theirs to approve.
    expect(after.hiddenRows).toBe(1);
    expect(after.counts.validated).toBe(1);
    expect(after.counts.promoted).toBe(toPromote.length);
    expect(after.status).toBe('validated');
    expect(await valuationRows()).toBe(before + toPromote.length);
    // The Locked marks are untouched: a weekly value never becomes a mark.
    expect(
      await count(
        "select count(*)::int as n from mon.valuation where state = 'Locked' and method = 'valuation_method.weekly_report'",
      ),
    ).toBe(0);

    // One event per Draft with the staged row, the prior and the value written, and one approve
    // event with counts.
    expect(await auditCount('valuation.create_from_weekly', 'req-weekly-approve-1')).toBe(
      toPromote.length,
    );
    expect(await auditCount('intake.approve', 'req-weekly-approve-1')).toBe(1);
    const movedNumber = update.expectations.moved[0]!.investmentNumber;
    const movedRow = after.rows.find((r) => r.investmentNumber === movedNumber)!;
    const [event] = await h.runtime.db.query<{
      entity_id: string;
      reason: string;
      details: {
        intakeFileId: string;
        intakeRowId: string;
        rowNo: number;
        reportDate: string;
        prior: { value: string; source: string; date: string };
        after: { fairValue: string; version: number; method: string; state: string };
      };
    }>(
      "select entity_id, reason, details from audit.event where action = 'valuation.create_from_weekly' and request_id = 'req-weekly-approve-1' and entity_id = $1",
      [movedRow.valuationId],
    );
    expect(event!.details.intakeFileId).toBe(updateFile.id);
    expect(event!.details.intakeRowId).toBe(movedRow.id);
    expect(event!.details.rowNo).toBe(movedRow.rowNo);
    expect(event!.details.reportDate).toBe(update.reportDate);
    expect(event!.details.prior).toEqual({
      value: movedRow.priorValue,
      source: 'locked_mark',
      date: movedRow.priorDate,
    });
    expect(D(event!.details.after.fairValue).eq(D(movedRow.reportedValue!))).toBe(true);
    expect(event!.details.after).toMatchObject({
      version: seededVersions(movedRow.link.investmentId!, movedRow.reportDate!) + 1,
      method: 'valuation_method.weekly_report',
      state: 'Draft',
    });
    expect(event!.reason).toBe(`weekly values ${update.fileName}`);
    const [approveEvent] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
      "select details from audit.event where action = 'intake.approve' and request_id = 'req-weekly-approve-1'",
    );
    expect(approveEvent!.details).toEqual({
      fileName: update.fileName,
      rows: toPromote.length,
      valuations: toPromote.length,
    });

    // A repeated approve finds nothing left to do and answers the unchanged file.
    const again = weeklyFileDetail.parse(
      (
        await command(
          'deal_team',
          updateFile.id,
          { command: 'approve' },
          'req-weekly-approve-2',
        ).expect(200)
      ).body,
    );
    expect(again.counts).toEqual(after.counts);
    expect(await auditCount('valuation.create_from_weekly', 'req-weekly-approve-2')).toBe(0);
    expect(await valuationRows()).toBe(before + toPromote.length);

    // A wall member finishes the file: the one row left is the walled position's.
    const finished = weeklyFileDetail.parse(
      (
        await command(
          'deal.three',
          updateFile.id,
          { command: 'approve' },
          'req-weekly-approve-wall',
        ).expect(200)
      ).body,
    );
    expect(finished.hiddenRows).toBe(0);
    expect(finished.counts.validated).toBe(0);
    expect(finished.counts.promoted).toBe(update.expectations.rows);
    expect(finished.status).toBe('promoted');
    expect(await auditCount('valuation.create_from_weekly', 'req-weekly-approve-wall')).toBe(1);
    expect(await valuationRows()).toBe(before + update.expectations.rows);
  });

  it('a later report date compares with the weekly value promoted after the mark, and a second file for the same day takes the next version', async () => {
    // The day after the promoted report date, still inside the window the as-of date keeps
    // current: the prior is now the promoted weekly value, not the mark behind it.
    const nextDay = addDays(update.reportDate, 1);
    expect(nextDay <= h.dataset.asOf).toBe(true);
    const later = weeklyValues(aliased(), { scenario: 'clean', reportDate: nextDay });
    const laterFile = await stage(later, 'req-weekly-later-1');
    const everyRow = (await fullView(laterFile.id)).rows;
    expect(everyRow.length).toBe(later.expectations.rows);
    const promoted = (await fullView(updateFile.id)).rows;
    let weeklyPriors = 0;
    for (const row of everyRow) {
      const weekly = promoted.find((p) => p.link.investmentId === row.link.investmentId)!;
      const mark = markBefore(row.link.investmentId!, nextDay);
      if (mark.periodEnd >= update.reportDate) {
        // The sponsor that closes a few days early: its mark sits on the promoted report date, so
        // the weekly value is not after the mark and the mark stays the prior.
        expect(row.priorSource, `row ${row.rowNo}`).toBe('locked_mark');
        expect(row.priorDate).toBe(mark.periodEnd);
      } else {
        weeklyPriors += 1;
        expect(row.priorSource, `row ${row.rowNo}`).toBe('weekly');
        expect(row.priorDate).toBe(update.reportDate);
        expect(D(row.priorValue!).eq(D(weekly.reportedValue!))).toBe(true);
      }
      expect(row.status).toBe('validated');
    }
    expect(weeklyPriors).toBeGreaterThan(later.expectations.rows / 2);
    // The same report date staged again from another file: the Draft takes the next version.
    const line = plainLine(update.reportDate);
    const sameDay = await stage(
      {
        fileName: 'same-day.csv',
        csv: oneRowCsv({
          ...line,
          ReportDate: update.reportDate,
          ReportedValue: D(line.ReportedValue!).plus('1000').toFixed(2),
        }),
      },
      'req-weekly-same-day-1',
    );
    const [sameRow] = sameDay.rows;
    // Its prior is the value promoted for that day (on or before the report date).
    expect(sameRow!.priorSource).toBe('weekly');
    expect(sameRow!.priorDate).toBe(update.reportDate);
    expect(sameRow!.status).toBe('validated');
    const approved = weeklyFileDetail.parse(
      (await command('operations', sameDay.id, { command: 'approve' }).expect(200)).body,
    );
    const created = (await draft(approved.rows[0]!.valuationId!))!;
    expect(created.version).toBe(
      seededVersions(sameRow!.link.investmentId!, update.reportDate) + 2,
    );
    expect(created.period_end).toBe(update.reportDate);
    expect(created.state).toBe('Draft');
  });

  it('stages a defects file: each defect row is flagged by its rule, unresolved names open exceptions that name no position', async () => {
    defectsFile = await stage(defects, 'req-weekly-defects-1');
    const full = await fullView(defectsFile.id);
    expect(full.rows.length).toBe(defects.expectations.rows);
    expect(defects.expectations.flagged.length).toBe(11);
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
    // The move beyond the threshold sets the flag; a move inside it does not.
    const beyond = defects.expectations.flagged.find((f) => f.ruleId === 'WK-BOUND-01')!;
    expect(rowNo(full, beyond.rowNo).flag).toBe('above_threshold');
    expect(D(rowNo(full, beyond.rowNo).variancePct!).abs().gte(D('0.1'))).toBe(true);
    const movedNumber = defects.expectations.moved[0]!.investmentNumber;
    const movedRow = full.rows.find(
      (r) => r.investmentNumber === movedNumber && r.reportDate === defects.reportDate,
    )!;
    expect(movedRow.flag).toBeNull();
    expect(movedRow.status).toBe('validated');
    // Cells the file got wrong stay as written on the row, with the typed column empty.
    const notDecimal = defects.expectations.flagged.find((f) => f.ruleId === 'WK-TYPE-02')!;
    expect(rowNo(full, notDecimal.rowNo).reportedValue).toBe(
      cellOf(defects, notDecimal.rowNo, 'ReportedValue'),
    );
    expect(DECIMAL.test(rowNo(full, notDecimal.rowNo).reportedValue!)).toBe(false);
    expect(rowNo(full, notDecimal.rowNo).variancePct).toBeNull();
    const badDate = defects.expectations.flagged.find((f) => f.ruleId === 'WK-TYPE-01')!;
    expect(rowNo(full, badDate.rowNo).reportDate).toBe(
      cellOf(defects, badDate.rowNo, 'ReportDate'),
    );
    expect(rowNo(full, badDate.rowNo).priorSource).toBeNull();
    const [typed] = await h.runtime.db.query<{
      report_date: string | null;
      reported_value: string | null;
    }>(
      'select report_date::text as report_date, reported_value::text as reported_value from stg.valuation where id = $1',
      [rowNo(full, badDate.rowNo).id],
    );
    expect(typed!.report_date).toBeNull();
    const [typedValue] = await h.runtime.db.query<{ reported_value: string | null }>(
      'select reported_value::text as reported_value from stg.valuation where id = $1',
      [rowNo(full, notDecimal.rowNo).id],
    );
    expect(typedValue!.reported_value).toBeNull();
    // The alias row still links by name, and the walled position's rows are the generator's.
    for (const n of defects.expectations.aliased) {
      expect(rowNo(full, n).link.status).toBe('matched');
      expect(rowNo(full, n).investmentNumber).toBeNull();
    }
    const ops = await detail('operations', defectsFile.id);
    expect(ops.hiddenRows).toBe(defects.expectations.walled.length);
    for (const n of defects.expectations.walled) {
      expect(ops.rows.some((r) => r.rowNo === n)).toBe(false);
      expect(rowNo(full, n).link.investmentId).toBe(walledId());
    }
    expect(JSON.stringify(ops)).not.toContain(walledNumber());
    expect(JSON.stringify(ops)).not.toContain(walledCompanyName());
    const member = await detail('deal.three', defectsFile.id);
    expect(member.hiddenRows).toBe(0);
    for (const n of defects.expectations.walled)
      expect(member.rows.some((r) => r.rowNo === n)).toBe(true);
    // The duplicate row is flagged, not dropped; the row it repeats stands.
    const dup = defects.expectations.flagged.find((f) => f.ruleId === 'WK-DUP-01')!;
    const dupRow = rowNo(full, dup.rowNo);
    const first = full.rows.find(
      (r) =>
        r.rowNo < dup.rowNo &&
        r.link.investmentId === dupRow.link.investmentId &&
        r.reportDate === dupRow.reportDate,
    );
    expect(first).toBeDefined();
    expect(first!.status).toBe('validated');
    // Exceptions: one per unresolved link, each readable by every authenticated user, so it
    // carries a candidate's reason only and never a number or a name of a position (SEC-5.3).
    const unmatched = full.rows.filter((r) => r.link.status === 'unmatched');
    expect(unmatched.length).toBe(2);
    expect(defectsFile.exceptions).toBe(unmatched.length);
    const nearMiss = unmatched.find((r) => r.investmentNumber === null)!;
    expect(nearMiss.link.candidates.length).toBe(1);
    expect(nearMiss.link.candidates[0]!.reason).toBe('near miss');
    const opened = await h.runtime.db.query<{
      rule_id: string;
      state: string;
      severity: string;
      expected: string | null;
      actual: string | null;
      candidates: unknown[];
    }>(
      `select x.rule_id, x.state, x.severity, x.expected, x.actual, x.candidates
       from ops.data_exception x join stg.valuation v on v.id = x.entity_id
       where x.source = 'weekly_intake' and x.entity = 'stg.valuation' and v.intake_file_id = $1
       order by v.row_no`,
      [defectsFile.id],
    );
    expect(opened.length).toBe(unmatched.length);
    expect(opened.map((x) => x.rule_id)).toEqual(['WK-XREF-01', 'WK-XREF-01']);
    expect(
      opened.every((x) => x.state === 'open' && x.severity === 'exception_severity.high'),
    ).toBe(true);
    for (const x of opened)
      for (const candidate of x.candidates)
        expect(Object.keys(candidate as Record<string, unknown>)).toEqual(['reason']);
    expect(JSON.stringify(opened)).not.toContain(walledNumber());
    expect(JSON.stringify(opened)).not.toContain(walledCompanyName());
    for (const row of unmatched)
      expect(JSON.stringify(opened)).not.toContain(cellOf(defects, row.rowNo, 'ReportedValue'));
    expect(defectsFile.status).toBe('flagged');
    expect(defectsFile.counts.flagged).toBe(defects.expectations.flagged.length);
    expect(defectsFile.counts.flagged + defectsFile.counts.validated).toBe(
      defects.expectations.rows,
    );
  });

  it('lists weekly files with the counts and the exceptions their detail reports, like any intake file', async () => {
    const page = intakeFilePage.parse(
      (
        await h
          .http()
          .get('/api/v1/intake/files?source=weekly&limit=50')
          .set('authorization', h.as('auditor'))
          .expect(200)
      ).body,
    );
    expect(defectsFile.exceptions).toBeGreaterThan(0);
    for (const file of [cleanFile, updateFile, defectsFile]) {
      const listed = page.items.find((f) => f.id === file.id);
      const { rows: _rows, hiddenRows: _hidden, ...header } = await detail('auditor', file.id);
      expect(listed, file.fileName).toEqual(header);
    }
    const listedDefects = page.items.find((f) => f.id === defectsFile.id)!;
    expect(listedDefects.exceptions).toBe(defectsFile.exceptions);
    expect(listedDefects.counts.flagged).toBe(defects.expectations.flagged.length);
    expect(listedDefects.rowCount).toBe(defects.expectations.rows);
    // The counts are of the file's rows in stg.valuation; a reader outside the wall gets the same.
    const outsider = intakeFilePage.parse(
      (
        await h
          .http()
          .get('/api/v1/intake/files?source=weekly&limit=50')
          .set('authorization', h.as('deal.one'))
          .expect(200)
      ).body,
    );
    expect(outsider.items.find((f) => f.id === cleanFile.id)?.counts).toEqual(cleanFile.counts);
  });

  it('rejects flagged rows with a reason the machine requires; the deal team may not reject, and a validated row cannot be rejected', async () => {
    const dealTeam = await command('deal_team', defectsFile.id, {
      command: 'reject',
      reason: 'Not ours to decide',
    }).expect(403);
    expect(problemDetails.parse(dealTeam.body).type).toBe(`${PROBLEM}forbidden`);
    const noReason = await command('operations', defectsFile.id, { command: 'reject' }).expect(422);
    const problem = problemDetails.parse(noReason.body);
    expect(problem.type).toBe(`${PROBLEM}workflow-precondition`);
    expect(problem.detail).toContain('a reason is required');
    const current = await detail('operations', defectsFile.id);
    const validated = current.rows.filter((r) => r.status === 'validated');
    const flagged = current.rows.filter((r) => r.status === 'flagged');
    expect(validated.length).toBeGreaterThan(0);
    expect(flagged.length).toBeGreaterThan(0);
    // A validated row has no reject path (docs/18 section 2), nor has a flagged row an approve path.
    for (const [body, rowIds] of [
      [{ command: 'reject', reason: 'Wrong row' }, [validated[0]!.id]],
      [{ command: 'approve' }, [flagged[0]!.id]],
      [{ command: 'approve' }, [validated[0]!.id, flagged[0]!.id]],
      [{ command: 'approve' }, [updateFile.rows[0]!.id]],
    ] as const) {
      const res = await command('operations', defectsFile.id, {
        ...body,
        rowIds: [...rowIds],
      }).expect(400);
      expect(problemDetails.parse(res.body).errors?.map((e) => e.path)).toEqual(['rowIds']);
    }

    const reason = 'Values sent back to the sponsor';
    const res = await command(
      'operations',
      defectsFile.id,
      { command: 'reject', reason },
      'req-weekly-reject-1',
    ).expect(200);
    const rejected = weeklyFileDetail.parse(res.body);
    expect(rejected.counts.rejected).toBe(flagged.length);
    // The walled position's defect row (the report date after the as-of date) is past ops.one's
    // wall: it stays flagged, and so does the file.
    const walledFlagged = defects.expectations.walled.filter((n) =>
      defects.expectations.flagged.some((f) => f.rowNo === n),
    ).length;
    expect(walledFlagged).toBe(1);
    expect(rejected.counts.flagged).toBe(walledFlagged);
    for (const row of rejected.rows.filter((r) => r.status === 'rejected')) {
      expect(row.decision).toBe(reason);
      expect(row.decidedBy).toBe(user('ops.one').displayName);
      expect(row.decidedAt).toBe(h.runtime.adapters.clock.now());
      expect(row.valuationId).toBeNull();
    }
    expect(rejected.status).toBe('flagged');
    expect(await auditCount('intake.reject', 'req-weekly-reject-1')).toBe(1);
    const [event] = await h.runtime.db.query<{ reason: string; details: Record<string, unknown> }>(
      "select reason, details from audit.event where action = 'intake.reject' and request_id = 'req-weekly-reject-1'",
    );
    expect(event!.reason).toBe(reason);
    expect(event!.details).toEqual({
      fileName: defects.fileName,
      rows: flagged.length,
      valuations: 0,
    });
    const again = weeklyFileDetail.parse(
      (await command('operations', defectsFile.id, { command: 'reject', reason }).expect(200)).body,
    );
    expect(again.counts).toEqual(rejected.counts);

    // Approving the rest creates a Draft for each validated row the reviewer sees; the walled
    // position's rows wait for the wall (deal.three approves, ops.two joins it to reject).
    const before = await valuationRows();
    const approved = weeklyFileDetail.parse(
      (
        await command(
          'operations',
          defectsFile.id,
          { command: 'approve', reason: 'Values checked with the sponsor' },
          'req-weekly-approve-3',
        ).expect(200)
      ).body,
    );
    expect(approved.counts.promoted).toBe(validated.length);
    expect(await valuationRows()).toBe(before + validated.length);
    for (const row of approved.rows.filter((r) => r.status === 'promoted'))
      expect(row.decision).toBe('Values checked with the sponsor');
    expect(await auditCount('valuation.create_from_weekly', 'req-weekly-approve-3')).toBe(
      validated.length,
    );
    const wall = h.dataset.walls[0]!;
    await h.runtime.db.query('insert into core.wall_member (wall_id, user_id) values ($1, $2)', [
      wall.id,
      user('ops.two').id,
    ]);
    const walledDone = weeklyFileDetail.parse(
      (await command('ops.two', defectsFile.id, { command: 'approve' }).expect(200)).body,
    );
    expect(walledDone.hiddenRows).toBe(0);
    expect(walledDone.counts.validated).toBe(0);
    const finished = weeklyFileDetail.parse(
      (await command('ops.two', defectsFile.id, { command: 'reject', reason }).expect(200)).body,
    );
    expect(finished.counts.flagged).toBe(0);
    expect(finished.status).toBe('promoted');
  });

  it('refuses a Draft for a position that is not active', async () => {
    const day = addDays(update.reportDate, -1);
    const line = plainLine(day);
    const inv = investmentByNumber(line.InvestmentNumber!);
    const file = await stage(
      { fileName: 'exited.csv', csv: oneRowCsv({ ...line, ReportDate: day }) },
      'req-weekly-exited-1',
    );
    expect(file.rows[0]!.status).toBe('validated');
    await h.runtime.db.query('update core.investment set is_active = false where id = $1', [
      inv.id,
    ]);
    try {
      const res = await command(
        'operations',
        file.id,
        { command: 'approve' },
        'req-weekly-exited-2',
      ).expect(422);
      const problem = problemDetails.parse(res.body);
      expect(problem.type).toBe(`${PROBLEM}workflow-precondition`);
      expect(problem.detail).toContain('not active');
      expect(await auditCount('valuation.create_from_weekly', 'req-weekly-exited-2')).toBe(0);
      expect((await detail('operations', file.id)).rows[0]!.status).toBe('validated');
    } finally {
      await h.runtime.db.query('update core.investment set is_active = true where id = $1', [
        inv.id,
      ]);
    }
  });

  it('keeps commands from auditors and viewers, and reads to the reviewing roles', async () => {
    for (const who of ['auditor', 'viewer', 'approver', 'investor_relations', 'platform_admin']) {
      const res = await command(who, cleanFile.id, { command: 'approve' }).expect(403);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}forbidden`);
    }
    for (const who of ['viewer', 'investor_relations', 'platform_admin']) {
      await h
        .http()
        .get(`/api/v1/intake/weekly/files/${cleanFile.id}`)
        .set('authorization', h.as(who))
        .expect(403);
      await h.http().get('/api/v1/intake/weekly/drops').set('authorization', h.as(who)).expect(403);
    }
    for (const who of ['auditor', 'approver', 'deal_team', 'operations'])
      expect((await detail(who, cleanFile.id)).id).toBe(cleanFile.id);
    // The weekly files are listed by the intake file list under their source.
    const page = intakeFilePage.parse(
      (
        await h
          .http()
          .get('/api/v1/intake/files?source=weekly&limit=50')
          .set('authorization', h.as('auditor'))
          .expect(200)
      ).body,
    );
    expect(page.items.every((f) => f.source === 'weekly')).toBe(true);
    expect(page.items.map((f) => f.id)).toContain(cleanFile.id);
    expect(page.items.map((f) => f.id)).toContain(defectsFile.id);
    expect(page.items.find((f) => f.id === updateFile.id)?.status).toBe('promoted');
  });

  it('lists the drop folder and imports a file by id; an unknown id is not found', async () => {
    const inbox = join(h.runtime.config.PB_DROP_ROOT, 'weekly', 'in');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, clean.fileName), clean.csv);
    const earlier = weeklyValues(aliased(), {
      scenario: 'clean',
      reportDate: addDays(update.reportDate, -3),
    });
    writeFileSync(join(inbox, earlier.fileName), earlier.csv);
    writeFileSync(join(inbox, 'notes.txt'), 'not a weekly file');
    await h
      .http()
      .get('/api/v1/intake/weekly/drops')
      .set('authorization', h.as('deal_team'))
      .expect(403);
    const listed = intakeExportList.parse(
      (
        await h
          .http()
          .get('/api/v1/intake/weekly/drops')
          .set('authorization', h.as('operations'))
          .expect(200)
      ).body,
    );
    expect(listed.items.map((e) => e.name).sort()).toEqual(
      [clean.fileName, earlier.fileName].sort(),
    );
    // The same content as the upload earlier: the drop folder import is the same file.
    const same = weeklyImportResult.parse(
      (await importAs('operations', { dropId: clean.fileName }).expect(201)).body,
    );
    expect(same.duplicate).toBe(true);
    expect(same.id).toBe(cleanFile.id);
    // An earlier report date is new content: staged against the marks on or before that day.
    const staged = weeklyImportResult.parse(
      (await importAs('operations', { dropId: earlier.fileName }).expect(201)).body,
    );
    expect(staged.duplicate).toBe(false);
    expect(staged.fileName).toBe(earlier.fileName);
    expect(staged.rows.length + staged.hiddenRows).toBe(earlier.expectations.rows);
    expect(staged.rows.every((r) => r.priorSource === 'locked_mark')).toBe(true);
    expect(staged.status).toBe('validated');
    for (const dropId of ['missing.csv', '../missing.csv', 'in', 'notes.txt']) {
      const res = await importAs('operations', { dropId }).expect(404);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}not-found`);
    }
  });

  it('refuses a file whose header is not the four columns and stages no rows; the same bytes again are read again', async () => {
    const header = WEEKLY_COLUMNS.join(',');
    const line = clean.rows[1]!.join(',');
    const extra = weeklyImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'extra-column.csv',
          csv: `${header},Extra\n${line},1\n`,
        }).expect(201)
      ).body,
    );
    expect(extra.status).toBe('new');
    expect(extra.rows).toEqual([]);
    expect(extra.rowCount).toBe(0);
    expect(extra.fileFindings.map((f) => [f.ruleId, f.field])).toEqual([['LAYOUT-01', 'Extra']]);
    expect(extra.exceptions).toBe(0);
    const missing = weeklyImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'missing-column.csv',
          csv: `InvestmentNumber,CompanyName,ReportedValue\n${clean.rows[1]![0]},${clean.rows[1]![1]},${clean.rows[1]![3]}\n`,
        }).expect(201)
      ).body,
    );
    expect(missing.status).toBe('new');
    expect(missing.fileFindings.map((f) => f.ruleId)).toEqual(['LAYOUT-02']);
    const empty = weeklyImportResult.parse(
      (await importAs('operations', { fileName: 'empty.csv', csv: `${header}\n` }).expect(201))
        .body,
    );
    expect(empty.fileFindings.map((f) => f.ruleId)).toEqual(['LAYOUT-03']);
    expect(
      await count(
        "select count(*)::int as n from stg.intake_file where source = 'weekly' and status = 'new'",
      ),
    ).toBe(3);
    const again = weeklyImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'extra-column.csv',
          csv: `${header},Extra\n${line},1\n`,
        }).expect(201)
      ).body,
    );
    expect(again.id).toBe(extra.id);
    expect(again.duplicate).toBe(true);
    expect(again.rowCount).toBe(0);
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

  it('shows a near miss on a walled name only to the wall; the exception carries the reason only', async () => {
    const line = clean.rows.find((r) => r[0] === walledNumber())!;
    const staged = weeklyImportResult.parse(
      (
        await importAs('operations', {
          fileName: 'near-miss-walled.csv',
          csv: oneRowCsv({
            CompanyName: walledCompanyName().slice(0, -1),
            ReportDate: clean.reportDate,
            ReportedValue: line[3]!,
          }),
        }).expect(201)
      ).body,
    );
    expect(staged.hiddenRows).toBe(0);
    const row = staged.rows[0]!;
    expect(row.link.status).toBe('unmatched');
    expect(row.link.candidates).toEqual([]);
    expect(row.findings.map((f) => f.ruleId)).toEqual(['WK-XREF-01']);
    expect(row.priorSource).toBeNull();
    expect(JSON.stringify(staged)).not.toContain(walledCompanyName());
    expect(JSON.stringify(staged)).not.toContain(walledNumber());
    const member = await detail('deal.three', staged.id);
    expect(member.rows[0]!.link.candidates).toEqual([
      { investmentNumber: walledNumber(), companyName: walledCompanyName(), reason: 'near miss' },
    ]);
    expect(member.rows[0]!.findings).toEqual(row.findings);
    const [exception] = await h.runtime.db.query<{
      rule_id: string;
      expected: string | null;
      actual: string | null;
      candidates: unknown[];
    }>(
      "select rule_id, expected, actual, candidates from ops.data_exception where entity = 'stg.valuation' and entity_id = $1",
      [row.id],
    );
    expect(exception!.rule_id).toBe('WK-XREF-01');
    expect(exception!.candidates).toEqual([{ reason: 'near miss' }]);
    expect(JSON.stringify(exception)).not.toContain(walledNumber());
    expect(JSON.stringify(exception)).not.toContain(walledCompanyName());
    expect(JSON.stringify(exception)).not.toContain(line[3]!);
  });

  it('answers 409 when another command changed a row between this command reading it and writing it; nothing of the batch is kept', async () => {
    const day = addDays(update.reportDate, -2);
    const line = plainLine(day);
    const waiting = await stage(
      { fileName: 'conflict-validated.csv', csv: oneRowCsv({ ...line, ReportDate: day }) },
      'req-weekly-conflict-stage-1',
    );
    expect(waiting.rows[0]!.status).toBe('validated');
    const flagged = await stage(
      {
        fileName: 'conflict-flagged.csv',
        csv: oneRowCsv({
          InvestmentNumber: 'INV-9998',
          CompanyName: 'Nowhere Example Holdings',
          ReportDate: update.reportDate,
          ReportedValue: line.ReportedValue!,
        }),
      },
      'req-weekly-conflict-stage-2',
    );
    expect(flagged.rows[0]!.status).toBe('flagged');
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
      const seam = h.app.get<WeeklyService, CommandSeam>(WeeklyService);
      const original = seam[method];
      seam[method] = async (tx, ...rest) => {
        await tx.execute(sql`update stg.valuation set status = ${status} where id = ${rowId}`);
        return original.call(seam, tx, ...rest);
      };
      try {
        await run();
      } finally {
        seam[method] = original;
      }
    };
    const valuationsBefore = await valuationRows();
    await changedUnderneath('promote', waiting.rows[0]!.id, 'rejected', async () => {
      const res = await command(
        'operations',
        waiting.id,
        { command: 'approve' },
        'req-weekly-conflict-1',
      ).expect(409);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}conflict`);
    });
    expect((await detail('operations', waiting.id)).rows[0]!.status).toBe('validated');
    expect(await valuationRows()).toBe(valuationsBefore);
    expect(await auditCount('valuation.create_from_weekly', 'req-weekly-conflict-1')).toBe(0);
    expect(await auditCount('intake.approve', 'req-weekly-conflict-1')).toBe(0);
    await changedUnderneath('reject', flagged.rows[0]!.id, 'validated', async () => {
      const res = await command(
        'operations',
        flagged.id,
        { command: 'reject', reason: 'Not on record' },
        'req-weekly-conflict-2',
      ).expect(409);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}conflict`);
    });
    expect((await detail('operations', flagged.id)).rows[0]!.status).toBe('flagged');
    expect(await auditCount('intake.reject', 'req-weekly-conflict-2')).toBe(0);
    // Read and written in one go, the same commands go through.
    const approved = weeklyFileDetail.parse(
      (await command('operations', waiting.id, { command: 'approve' }).expect(200)).body,
    );
    expect(approved.rows[0]!.status).toBe('promoted');
    expect(approved.rows[0]!.valuationId).not.toBeNull();
    const rejected = weeklyFileDetail.parse(
      (
        await command('operations', flagged.id, {
          command: 'reject',
          reason: 'Not on record',
        }).expect(200)
      ).body,
    );
    expect(rejected.rows[0]!.status).toBe('rejected');
  });

  it('answers 409 when another approval took the Draft version first; nothing of the batch is kept, and the next approve takes the version after', async () => {
    // A position and day a Draft was promoted for already: its versions are on record.
    const line = plainLine(update.reportDate);
    const investmentId = investmentByNumber(line.InvestmentNumber!).id;
    const file = await stage(
      {
        fileName: 'version-race.csv',
        csv: oneRowCsv({
          ...line,
          ReportDate: update.reportDate,
          ReportedValue: D(line.ReportedValue!).plus('500').toFixed(2),
        }),
      },
      'req-weekly-version-stage-1',
    );
    expect(file.rows[0]!.status).toBe('validated');
    const taken = (
      await h.runtime.db.query<{ v: number }>(
        'select max(version)::int as v from mon.valuation where investment_id = $1 and period_end = $2',
        [investmentId, update.reportDate],
      )
    )[0]!.v;
    expect(taken).toBeGreaterThanOrEqual(1);
    // The window is the one between reading the highest version on record and writing the Draft
    // at the next one. The test database has one connection, so the other approval's write is
    // stood in for by handing the service the version that approval took (the service's private
    // step, reached as the seam this test needs): the unique key of mon.valuation refuses it.
    interface VersionSeam {
      nextVersion: (...args: unknown[]) => Promise<number>;
    }
    const seam = h.app.get<WeeklyService, VersionSeam>(WeeklyService);
    const original = seam.nextVersion;
    seam.nextVersion = () => Promise.resolve(taken);
    const valuationsBefore = await valuationRows();
    try {
      const res = await command(
        'operations',
        file.id,
        { command: 'approve' },
        'req-weekly-version-1',
      ).expect(409);
      const problem = problemDetails.parse(res.body);
      expect(problem.type).toBe(`${PROBLEM}conflict`);
      expect(problem.detail).toContain('approve the file again');
    } finally {
      seam.nextVersion = original;
    }
    expect(await valuationRows()).toBe(valuationsBefore);
    expect((await detail('operations', file.id)).rows[0]!.status).toBe('validated');
    expect(await auditCount('valuation.create_from_weekly', 'req-weekly-version-1')).toBe(0);
    expect(await auditCount('intake.approve', 'req-weekly-version-1')).toBe(0);
    // Approved again, the Draft takes the version after the one taken.
    const approved = weeklyFileDetail.parse(
      (
        await command('operations', file.id, { command: 'approve' }, 'req-weekly-version-2').expect(
          200,
        )
      ).body,
    );
    const created = (await draft(approved.rows[0]!.valuationId!))!;
    expect(created.version).toBe(taken + 1);
    expect(created.state).toBe('Draft');
  });

  it('is a 500 configuration problem when a threshold is missing from definitions, never a default', async () => {
    const bare = await startHarness({ withoutDefinitions: ['intake'] });
    try {
      const res = await bare
        .http()
        .post('/api/v1/intake/weekly')
        .set('authorization', bare.as('operations'))
        .send({ fileName: clean.fileName, csv: clean.csv })
        .expect(500);
      const problem = problemDetails.parse(res.body);
      expect(problem.type).toBe(`${PROBLEM}configuration`);
      expect(problem.detail).toContain('intake');
    } finally {
      await bare.close();
    }
  });
});
