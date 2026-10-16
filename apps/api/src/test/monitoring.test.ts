import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, daysBetween, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  documentPage,
  monitoringBoard,
  problemDetails,
  realizationOutlookDetail,
} from '@pb/contracts';
import type { DocumentSummary, MonitoringBoard, MonitoringBoardRow } from '@pb/contracts';
import { SYSTEM_USER_ID, schema, withUserContext } from '@pb/db';
import type { Tx } from '@pb/db';
import { parseCsv } from '@pb/validation';
import { QUARTERLY_REPORTING_DEAL_TYPES, dueDateFor } from '../documents/expected.js';
import { documentSettingsOf } from '../documents/settings.js';
import { BOARD_CSV_COLUMNS } from '../monitoring/board.js';
import { OUTLOOK_GUARD_PROBLEM } from '../monitoring/monitoring.service.js';
import { OUTLOOK_GUARD_KEY } from '../monitoring/settings.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const QF = 'doc_type.quarterly_financials';
const CREDIT = 'deal_type.private_credit';
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
const EDIT = {
  outlook: 'partial',
  horizonMonths: 12,
  note: 'Sponsor started a sale process.',
  reason: 'Sponsor update call',
};

describe('monitoring (M9, decision 0012): the board, the export and the realization outlook', () => {
  let h: Harness;
  let documents: DocumentSummary[];

  beforeAll(async () => {
    h = await startHarness();
    await h
      .http()
      .post('/api/v1/documents/index')
      .set('authorization', h.as('operations'))
      .expect(200);
    await h
      .http()
      .post('/api/v1/expected-documents/generate')
      .set('authorization', h.as('operations'))
      .send({ periodEnd: latestQuarterEndOnOrBefore(h.dataset.asOf) })
      .expect(201);
    documents = documentPage.parse(
      (await get('deal.three', '/api/v1/documents?limit=200').expect(200)).body,
    ).items;
  });
  afterAll(async () => {
    await h.close();
  });

  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const quarterEnd = (): string => latestQuarterEndOnOrBefore(h.dataset.asOf);
  const settings = () => documentSettingsOf(h.runtime.definitions);
  const dueDate = (): string => dueDateFor(quarterEnd(), settings());
  const companyOf = (investmentId: string): string => {
    const inv = h.dataset.investments.find((i) => i.id === investmentId)!;
    return h.dataset.portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId)!.name;
  };
  /** The investments held on the quarter end, as the loaders judge them: entered by then and not exited by then. */
  const held = () =>
    h.dataset.investments.filter(
      (i) => i.entryDate <= quarterEnd() && (i.exitDate === null || i.exitDate > quarterEnd()),
    );
  /** The investments whose quarterly record for the quarter is approved in the seed. */
  const approvedIds = (): Set<string> =>
    new Set(
      h.dataset.quarterlyPerformance
        .filter((q) => q.periodEnd === quarterEnd() && q.status === 'record_status.approved')
        .map((q) => q.investmentId),
    );
  const get = (who: string, path: string, requestId = 'req-mon-get') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const board = async (who: string, query = ''): Promise<MonitoringBoard> =>
    monitoringBoard.parse((await get(who, `/api/v1/monitoring/board${query}`).expect(200)).body);
  const rowOf = (b: MonitoringBoard, investmentId: string): MonitoringBoardRow =>
    b.rows.find((r) => r.investmentId === investmentId)!;
  const put = (who: string, investmentId: string, body: object, requestId = 'req-mon-put') =>
    h
      .http()
      .put(`/api/v1/monitoring/outlook/${investmentId}`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const outlook = async (who: string, investmentId: string) =>
    realizationOutlookDetail.parse(
      (await get(who, `/api/v1/monitoring/outlook/${investmentId}`).expect(200)).body,
    );
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql, params))[0]!.n;

  it('guards the outlook edit by role and the reads by sign-in', async () => {
    for (const who of ['viewer', 'operations', 'approver', 'auditor', 'platform_admin']) {
      const res = await put(who, NO_SUCH_ID, EDIT).expect(403);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}forbidden`);
    }
    await h.http().get('/api/v1/monitoring/board').expect(401);
    await h.http().get('/api/v1/monitoring/board/export').expect(401);
    await h.http().get(`/api/v1/monitoring/outlook/${NO_SUCH_ID}`).expect(401);
    await h.http().put(`/api/v1/monitoring/outlook/${NO_SUCH_ID}`).send(EDIT).expect(401);
  });

  it('shows one row per investment held at the quarter end, with its expected document, its record and counts that add up', async () => {
    const b = await board('deal.three', '');
    expect(b.periodEnd).toBe(quarterEnd());
    expect(b.asOf).toBe(h.dataset.asOf);
    const investments = held();
    expect(b.rows.map((r) => r.investmentId).sort()).toEqual(investments.map((i) => i.id).sort());
    expect(b.rows.map((r) => r.investmentNumber)).toEqual(
      [...b.rows.map((r) => r.investmentNumber)].sort(),
    );
    const { expected, received, late, missing, inReview, approved } = b.counts;
    expect(expected + received + late + missing).toBe(b.rows.length);
    expect(inReview).toBe(0);
    expect(approved).toBe(b.rows.filter((r) => r.approval === 'approved').length);
    const approvedRecords = approvedIds();
    for (const row of b.rows) {
      const inv = investments.find((i) => i.id === row.investmentId)!;
      expect(row.dealType).toBe(inv.dealType);
      expect(row.companyName).toBe(companyOf(inv.id));
      expect(row.vehicleName).toBe(h.dataset.vehicles.find((v) => v.id === inv.vehicleId)!.name);
      expect(row.periodEnd).toBe(quarterEnd());
      expect(row.runId).toBeNull();
      expect(row.runState).toBeNull();
      expect(row.flagsCount).toBe(0);
      // Approval comes from the quarter's approved record when no run exists; the seed stamps no approval time.
      expect(row.approval, row.investmentNumber).toBe(
        approvedRecords.has(inv.id) ? 'approved' : 'none',
      );
      expect(row.approvedAt).toBeNull();
      // Every reporting investment has its generated row; a credit position reads its fund's statement row.
      expect(row.expectedDocumentId).not.toBeNull();
      expect(row.dueDate).toBe(dueDate());
      if (!QUARTERLY_REPORTING_DEAL_TYPES.includes(inv.dealType)) {
        expect(inv.dealType).toBe(CREDIT);
        expect(row.documentStatus).toBe('received');
        const statement = documents.find((d) => d.id === row.documentId)!;
        expect(statement.docType).toBe('doc_type.capital_account_statement');
        expect(statement.sponsorFundId).toBe(inv.sponsorFundId);
      }
    }
    // A classified report of the quarter shows received, with the document and its age from the due date.
    const reports = documents.filter(
      (d) => d.docType === QF && d.reviewStatus === 'Classified' && d.periodEnd === quarterEnd(),
    );
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      const row = rowOf(b, report.investmentId!);
      expect(row.documentStatus, report.fileName).toBe('received');
      expect(row.documentId).toBe(report.id);
      expect(row.ageDays).toBe(daysBetween(dueDate(), report.receivedAt.slice(0, 10)));
    }
    expect(received).toBe(reports.length + b.rows.filter((r) => r.dealType === CREDIT).length);
    expect(approvedRecords.size).toBeGreaterThan(0);
    expect(b.rows.some((r) => r.approval === 'none')).toBe(true);
  });

  it('judges the late_financials investment expected, late or missing by the as-of day, and defaults the quarter from it', async () => {
    const late = h.documents.expectations.lateFinancials!;
    const at = async (
      asOf: string,
    ): Promise<{ row: MonitoringBoardRow; counts: MonitoringBoard['counts'] }> => {
      const b = await board('deal.three', `?periodEnd=${quarterEnd()}&asOf=${asOf}`);
      expect(b.asOf).toBe(asOf);
      return { row: rowOf(b, late.investmentId), counts: b.counts };
    };
    const onTime = await at(dueDate());
    expect(onTime.row.companyName).toBe(late.companyName);
    expect(onTime.row.documentStatus).toBe('expected');
    expect(onTime.row.documentId).toBeNull();
    expect(onTime.row.ageDays).toBe(0);
    expect(onTime.counts.expected).toBeGreaterThan(0);
    const lateDay = addDays(dueDate(), settings().lateAfterDays + 1);
    const lateRow = await at(lateDay);
    expect(lateRow.row.documentStatus).toBe('late');
    expect(lateRow.row.ageDays).toBe(settings().lateAfterDays + 1);
    expect(lateRow.counts.late).toBeGreaterThan(0);
    const missingDay = addDays(dueDate(), settings().missingAfterDays + 1);
    const missing = await at(missingDay);
    expect(missing.row.documentStatus).toBe('missing');
    expect(missing.row.ageDays).toBe(settings().missingAfterDays + 1);
    expect(missing.counts.missing).toBeGreaterThan(0);
    expect(missing.counts.expected).toBe(0);
    // Without a period the board shows the latest quarter end on or before the as-of day; a
    // quarter whose rows were never generated expects everything, with no due date invented.
    const earlier = await board('deal.three', '?asOf=2025-05-15');
    expect(earlier.periodEnd).toBe('2025-03-31');
    expect(earlier.rows.length).toBeGreaterThan(0);
    for (const row of earlier.rows) {
      expect(row.expectedDocumentId).toBeNull();
      expect(row.documentStatus).toBe('expected');
      expect(row.dueDate).toBeNull();
      expect(row.ageDays).toBeNull();
    }
    expect(earlier.counts.expected).toBe(earlier.rows.length);
    const bad = await get('viewer', '/api/v1/monitoring/board?periodEnd=2025-05-15').expect(400);
    expect(problemDetails.parse(bad.body).errors?.map((e) => e.path)).toEqual(['periodEnd']);
    await get('viewer', '/api/v1/monitoring/board?asOf=not-a-day').expect(400);
    await get('viewer', '/api/v1/monitoring/board?limit=5').expect(400);
  });

  it('keeps the walled investment inside the wall: a non-member has no row, a member and the approver do', async () => {
    const member = await board('deal.three', '');
    expect(rowOf(member, walledId())).toBeDefined();
    expect(rowOf(member, walledId()).companyName).toBe(companyOf(walledId()));
    for (const who of ['deal.one', 'operations', 'viewer']) {
      const outsider = await board(who, '');
      expect(outsider.rows.length, who).toBe(member.rows.length - 1);
      expect(outsider.rows.some((r) => r.investmentId === walledId())).toBe(false);
      expect(JSON.stringify(outsider)).not.toContain(companyOf(walledId()));
      const total = outsider.counts;
      expect(total.expected + total.received + total.late + total.missing).toBe(
        outsider.rows.length,
      );
    }
    expect((await board('head.one', '')).rows.length).toBe(member.rows.length);
  });

  it('reads the latest run of the quarter with its undecided flags: pending until approved, then approved with its time', async () => {
    // The one reporting investment the seed leaves without an approved record this quarter.
    const investment = held().find(
      (i) => QUARTERLY_REPORTING_DEAL_TYPES.includes(i.dealType) && !approvedIds().has(i.id),
    )!;
    expect(investment).toBeDefined();
    expect(rowOf(await board('deal.one', ''), investment.id).approval).toBe('none');
    const document =
      documents.find((d) => d.investmentId === investment.id && d.docType === QF) ??
      documents.find((d) => d.docType === QF && d.investmentId !== walledId())!;
    const asService = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
      withUserContext(h.runtime.db.db, { userId: SYSTEM_USER_ID, roles: ['service'] }, fn);
    const runId = await asService(async (tx) => {
      const [run] = await tx
        .insert(schema.extractionRun)
        .values({
          documentId: document.id,
          investmentId: investment.id,
          periodEnd: quarterEnd(),
          schemaId: 'quarterly_financials',
          promptId: 'quarterly_extraction',
          promptVersion: '1',
          state: 'Succeeded',
          requestedBy: user('ops.one').id,
        })
        .returning();
      const values: {
        field: string;
        validationState: 'clean' | 'flagged' | 'invalid';
        decision: 'accepted' | null;
      }[] = [
        { field: 'revenue_ltm', validationState: 'flagged', decision: null },
        { field: 'ebitda_ltm', validationState: 'invalid', decision: null },
        { field: 'net_debt', validationState: 'flagged', decision: 'accepted' },
        { field: 'cash', validationState: 'clean', decision: null },
      ];
      await tx.insert(schema.extractedValue).values(
        values.map((v) => ({
          runId: run!.id,
          investmentId: investment.id,
          field: v.field,
          value: '1.00',
          unit: 'USD_M',
          validationState: v.validationState,
          decision: v.decision,
        })),
      );
      return run!.id;
    });
    const pending = await board('deal.one', '');
    const row = rowOf(pending, investment.id);
    expect(row.runId).toBe(runId);
    expect(row.runState).toBe('Succeeded');
    expect(row.flagsCount).toBe(2);
    expect(row.approval).toBe('pending');
    expect(row.approvedAt).toBeNull();
    if (row.documentStatus !== 'received') expect(row.documentId).toBe(document.id);
    expect(pending.counts.inReview).toBe(1);
    const approvedAt = '2025-08-01T09:30:00.000Z';
    await asService(async (tx) => {
      await tx
        .update(schema.extractionRun)
        .set({ approvedBy: user('head.one').id, approvedAt: new Date(approvedAt) })
        .where(eq(schema.extractionRun.id, runId));
    });
    const approved = await board('deal.one', '');
    expect(rowOf(approved, investment.id).approval).toBe('approved');
    expect(rowOf(approved, investment.id).approvedAt).toBe(approvedAt);
    expect(approved.counts.inReview).toBe(0);
    expect(approved.counts.approved).toBe(pending.counts.approved + 1);
    // A newer run of the same quarter is the one the board reads, whatever its state.
    const newer = await asService(async (tx) => {
      const [run] = await tx
        .insert(schema.extractionRun)
        .values({
          documentId: document.id,
          investmentId: investment.id,
          periodEnd: quarterEnd(),
          schemaId: 'quarterly_financials',
          promptId: 'quarterly_extraction',
          promptVersion: '1',
          state: 'Queued',
        })
        .returning();
      return run!.id;
    });
    const latest = rowOf(await board('deal.one', ''), investment.id);
    expect(latest.runId).toBe(newer);
    expect(latest.runState).toBe('Queued');
    expect(latest.flagsCount).toBe(0);
    expect(latest.approval).toBe('none');
  });

  it('exports the rows the caller sees as CSV: a header line, one line per row, text/csv', async () => {
    const b = await board('deal.three', '');
    const res = await get(
      'deal.three',
      '/api/v1/monitoring/board/export',
      'req-mon-export-1',
    ).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="monitoring-board-${quarterEnd()}.csv"`,
    );
    const text = res.text;
    const lines = text.trimEnd().split('\n');
    expect(lines.length).toBe(b.rows.length + 1);
    expect(lines[0]).toBe(BOARD_CSV_COLUMNS.join(','));
    const table = parseCsv(text);
    expect(table.header).toEqual([...BOARD_CSV_COLUMNS]);
    expect(table.rows.length).toBe(b.rows.length);
    for (const [i, row] of b.rows.entries()) {
      const cells = table.rows[i]!;
      expect(cells.length).toBe(BOARD_CSV_COLUMNS.length);
      for (const [j, column] of BOARD_CSV_COLUMNS.entries()) {
        const value = row[column];
        expect(cells[j], `${row.investmentNumber} ${column}`).toBe(
          value === null ? '' : String(value),
        );
      }
    }
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'monitoring.board.export' and request_id = 'req-mon-export-1'",
      ),
    ).toBe(1);
    const outsider = await get('deal.one', '/api/v1/monitoring/board/export').expect(200);
    expect(outsider.text).not.toContain(companyOf(walledId()));
    expect(outsider.text.trimEnd().split('\n').length).toBe(b.rows.length);
  });

  it('answers the default outlook for an investment nobody has set, the seeded one otherwise, and 404 past the wall', async () => {
    const seeded = h.dataset.realizationOutlooks.find((o) =>
      held().some((i) => i.id === o.investmentId),
    )!;
    const unset = held().find(
      (i) =>
        i.id !== walledId() && !h.dataset.realizationOutlooks.some((o) => o.investmentId === i.id),
    )!;
    const fresh = await outlook('viewer', unset.id);
    expect(fresh).toEqual({
      investmentId: unset.id,
      investmentNumber: unset.investmentNumber,
      companyName: companyOf(unset.id),
      outlook: 'none',
      horizonMonths: 18,
      note: null,
      setBy: null,
      setAt: null,
    });
    const set = await outlook('viewer', seeded.investmentId);
    expect(set.outlook).toBe(seeded.outlook.replace('realization_outlook.', ''));
    expect(set.horizonMonths).toBe(seeded.horizonMonths);
    expect(set.note).toBe(seeded.note);
    expect(set.setAt).toBe(new Date(seeded.setAt).toISOString());
    expect(set.setBy).toBeNull();
    await get('viewer', '/api/v1/monitoring/outlook/not-a-uuid').expect(404);
    await get('viewer', `/api/v1/monitoring/outlook/${NO_SUCH_ID}`).expect(404);
    await get('deal.one', `/api/v1/monitoring/outlook/${walledId()}`).expect(404);
    expect((await outlook('deal.three', walledId())).investmentId).toBe(walledId());
  });

  it('sets the outlook by hand with an audit event carrying before, after and the reason', async () => {
    const target = held().find(
      (i) =>
        i.id !== walledId() && !h.dataset.realizationOutlooks.some((o) => o.investmentId === i.id),
    )!;
    const first = realizationOutlookDetail.parse(
      (await put('deal.one', target.id, EDIT, 'req-mon-put-1').expect(200)).body,
    );
    expect(first).toEqual({
      investmentId: target.id,
      investmentNumber: target.investmentNumber,
      companyName: companyOf(target.id),
      outlook: 'partial',
      horizonMonths: 12,
      note: EDIT.note,
      setBy: user('deal.one').displayName,
      setAt: h.runtime.adapters.clock.now(),
    });
    expect(await outlook('viewer', target.id)).toEqual(first);
    const [row] = await h.runtime.db.query<{ id: string; outlook: string; set_by: string }>(
      'select id, outlook, set_by from mon.realization_outlook where investment_id = $1',
      [target.id],
    );
    expect(row!.outlook).toBe('realization_outlook.partial');
    expect(row!.set_by).toBe(user('deal.one').id);
    const [event] = await h.runtime.db.query<{
      entity: string;
      entity_id: string;
      reason: string;
      details: Record<string, unknown>;
    }>(
      "select entity, entity_id, reason, details from audit.event where action = 'realization_outlook.set' and request_id = 'req-mon-put-1'",
    );
    expect(event!.entity).toBe('mon.realization_outlook');
    expect(event!.entity_id).toBe(row!.id);
    expect(event!.reason).toBe(EDIT.reason);
    expect(event!.details).toEqual({
      investmentId: target.id,
      investmentNumber: target.investmentNumber,
      before: null,
      after: { outlook: 'partial', horizonMonths: 12, note: EDIT.note },
    });
    // A second edit replaces the one row and records what it replaced.
    const second = realizationOutlookDetail.parse(
      (
        await put(
          'deal.two',
          target.id,
          { outlook: 'full', horizonMonths: 6, note: null, reason: 'Signed sale agreement' },
          'req-mon-put-2',
        ).expect(200)
      ).body,
    );
    expect(second.outlook).toBe('full');
    expect(second.horizonMonths).toBe(6);
    expect(second.note).toBeNull();
    expect(second.setBy).toBe(user('deal.two').displayName);
    expect(
      await count(
        'select count(*)::int as n from mon.realization_outlook where investment_id = $1',
        [target.id],
      ),
    ).toBe(1);
    const [again] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
      "select details from audit.event where action = 'realization_outlook.set' and request_id = 'req-mon-put-2'",
    );
    expect(again!.details.before).toEqual({
      outlook: 'partial',
      horizonMonths: 12,
      note: EDIT.note,
    });
    expect(again!.details.after).toEqual({ outlook: 'full', horizonMonths: 6, note: null });
    // The body is checked at the boundary: every refusal names the field and changes nothing.
    for (const body of [
      { ...EDIT, horizonMonths: 0 },
      { ...EDIT, horizonMonths: 121 },
      { ...EDIT, outlook: 'maybe' },
      { ...EDIT, reason: 'no' },
      { outlook: 'none', horizonMonths: 18, reason: 'missing the note key' },
      { ...EDIT, extra: true },
    ]) {
      const res = await put('deal.one', target.id, body).expect(400);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}validation`);
    }
    expect((await outlook('viewer', target.id)).outlook).toBe('full');
    await put('deal.one', 'not-a-uuid', EDIT).expect(404);
    await put('deal.one', NO_SUCH_ID, EDIT).expect(404);
  });

  it('lets only a wall member set the outlook of a walled investment', async () => {
    await put('deal.one', walledId(), EDIT).expect(404);
    expect(
      await count(
        'select count(*)::int as n from mon.realization_outlook where investment_id = $1',
        [walledId()],
      ),
    ).toBe(0);
    const set = realizationOutlookDetail.parse(
      (await put('deal.three', walledId(), EDIT, 'req-mon-put-wall').expect(200)).body,
    );
    expect(set.outlook).toBe('partial');
    expect(set.setBy).toBe(user('deal.three').displayName);
    await get('deal.one', `/api/v1/monitoring/outlook/${walledId()}`).expect(404);
    expect((await outlook('deal.three', walledId())).outlook).toBe('partial');
  });

  it('refuses the edit while config switches the manual edit off, and answers 500 when the key is missing', async () => {
    const target = held().find((i) => i.id !== walledId())!;
    const before = await outlook('viewer', target.id);
    const definitions = h.runtime.definitions;
    const saved = definitions[OUTLOOK_GUARD_KEY];
    try {
      definitions[OUTLOOK_GUARD_KEY] = false;
      const off = await put('deal.one', target.id, EDIT).expect(409);
      const problem = problemDetails.parse(off.body);
      expect(problem.type).toBe(`${PROBLEM}${OUTLOOK_GUARD_PROBLEM}`);
      expect(problem.detail).toContain(OUTLOOK_GUARD_KEY);
      delete definitions[OUTLOOK_GUARD_KEY];
      const missing = await put('deal.one', target.id, EDIT).expect(500);
      expect(problemDetails.parse(missing.body).type).toBe(`${PROBLEM}configuration`);
    } finally {
      definitions[OUTLOOK_GUARD_KEY] = saved;
    }
    expect(await outlook('viewer', target.id)).toEqual(before);
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'realization_outlook.set'",
      ),
    ).toBe(3);
  });
});
