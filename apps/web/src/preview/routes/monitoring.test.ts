import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, daysBetween, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  documentPage,
  extractionRunDetail,
  extractionRunPage,
  monitoringBoard,
  problemDetails,
  realizationOutlookDetail,
} from '@pb/contracts';
import type { MonitoringBoard } from '@pb/contracts';
import { generateDataset, generateDocuments, previewBook } from '@pb/synthetic';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { USERS, generatedWorld, problemOf, send, serveSamples } from '../test-fixtures.js';
import { documentSettings, heldOn } from './documents.js';
import { BOARD_CSV_COLUMNS } from './monitoring.js';

/**
 * The simulated monitoring board and realization outlook over the real generator: the rows come
 * from the book's positions held on the quarter end that the credential may open, the document
 * status from the expected rows generated this session, the runs and approvals from the
 * simulated extraction, and the seeded approvals from the book's quarters.
 */
const dataset = generateDataset({ profile: 'small', seed: 42 });
const set = generateDocuments(dataset);
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset, { documents: set }))));
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';
const walled = book.investments.find((i) => i.id === walledId);
const latestQuarter = latestQuarterEndOnOrBefore(book.asOf);
const settings = documentSettings();
const dueDate = addDays(latestQuarter, settings.expectedDueDaysAfterQuarterEnd);
const fixtures = generatedWorld(book, walledId);
const assets = serveSamples(new Map(set.documents.map((d) => [d.fileName, d.bytes])));
const held = book.investments.filter((i) => heldOn(i, latestQuarter));
const QUARTERLY_FINANCIALS = 'doc_type.quarterly_financials';

const BOARD = '/api/v1/monitoring/board';
const EXPORT = '/api/v1/monitoring/board/export';
const outlookPath = (id: string): string => `/api/v1/monitoring/outlook/${id}`;

let ids = 0;
let ticks = 0;
const env = {
  newId: (): string => `80000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => new Date(Date.UTC(2025, 6, 1, 9, 0, 0) + ++ticks * 1000).toISOString(),
};

function setup(): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  const f = createPreviewFetch(fixtures, assets, { env, state, book });
  return { f, state };
}

async function board(f: typeof fetch, who: string, query = ''): Promise<MonitoringBoard> {
  const answer = await send(f, who, 'GET', `${BOARD}${query}`);
  expect(answer.status, answer.text).toBe(200);
  expect(answer.headers.get('x-pb-simulated')).toBe('true');
  return monitoringBoard.parse(answer.json);
}

async function stage(f: typeof fetch): Promise<void> {
  expect((await send(f, 'ops.one', 'POST', '/api/v1/documents/index')).status).toBe(200);
  expect(
    (
      await send(f, 'ops.one', 'POST', '/api/v1/expected-documents/generate', {
        periodEnd: latestQuarter,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await send(f, 'admin.one', 'PATCH', '/api/v1/flags/ai.extraction', {
        enabled: true,
        reason: 'test',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send(f, 'ops.one', 'POST', '/api/v1/extraction/batches', {
        periodEnd: latestQuarter,
        docType: QUARTERLY_FINANCIALS,
      })
    ).status,
  ).toBe(201);
}

/**
 * Reviews a run as the reviewer would: the clean values in one go, whatever the validator left
 * undecided edited to the quarter (the scan's own period differs from the quarter it was filed
 * under), then the approval; answers the approval time.
 */
async function reviewAndApprove(f: typeof fetch, runId: string): Promise<string | null> {
  const commands = `/api/v1/extraction/runs/${runId}/commands`;
  await send(f, 'ops.one', 'POST', commands, { command: 'acceptClean' });
  const open = extractionRunDetail
    .parse((await send(f, 'ops.one', 'GET', `/api/v1/extraction/runs/${runId}`)).json)
    .values.filter((v) => v.decision === null);
  for (const v of open) {
    const edit = await send(f, 'ops.one', 'POST', commands, {
      command: 'edit',
      field: v.field,
      value: v.kind === 'date' ? latestQuarter : (v.value ?? '1'),
      ...(v.unit === null ? {} : { unit: v.unit }),
      reason: 'filed under the quarter',
    });
    expect(edit.status, edit.text).toBe(200);
  }
  const approved = await send(f, 'ops.one', 'POST', commands, { command: 'approve' });
  expect(approved.status, approved.text).toBe(200);
  return extractionRunDetail.parse(approved.json).run.approvedAt;
}

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('the simulated monitoring board (docs/04 M9) over the book and the session', () => {
  it('has positions held on the latest quarter end, one of them walled, and one with a late report', () => {
    expect(held.length).toBeGreaterThan(2);
    expect(held.some((i) => i.id === walledId)).toBe(true);
    expect(set.expectations.lateFinancials).not.toBeNull();
  });

  it('answers the empty board for the latest quarter: every position expected with no deadline, the seeded approvals, the wall', async () => {
    const { f } = setup();
    const ops = await board(f, 'ops.one');
    expect(ops.asOf).toBe(book.asOf);
    expect(ops.periodEnd).toBe(latestQuarter);
    expect(ops.rows.map((r) => r.investmentId)).toEqual(
      held
        .filter((i) => i.id !== walledId)
        .sort((a, b) => (a.investmentNumber < b.investmentNumber ? -1 : 1))
        .map((i) => i.id),
    );
    for (const row of ops.rows) {
      const inv = book.investments.find((i) => i.id === row.investmentId);
      expect(row.investmentNumber).toBe(inv?.investmentNumber);
      expect(row.companyName).toBe(inv?.companyName);
      expect(row.vehicleName).toBe(inv?.vehicleName);
      expect(row.sponsorFundName).toBe(
        book.sponsorFunds.find((x) => x.id === inv?.sponsorFundId)?.name ?? null,
      );
      expect(row.dealType).toBe(inv?.dealType);
      expect(row.periodEnd).toBe(latestQuarter);
      expect(row.documentStatus).toBe('expected');
      expect(row.dueDate).toBeNull();
      expect(row.ageDays).toBeNull();
      expect(row.expectedDocumentId).toBeNull();
      expect(row.documentId).toBeNull();
      expect(row.runId).toBeNull();
      expect(row.runState).toBeNull();
      expect(row.flagsCount).toBe(0);
      const seeded = (book.quarters[row.investmentId] ?? []).some(
        (q) => q.periodEnd === latestQuarter,
      );
      expect(row.approval, row.investmentNumber).toBe(seeded ? 'approved' : 'none');
      expect(row.approvedAt).toBeNull();
    }
    expect(ops.counts).toEqual({
      expected: ops.rows.length,
      received: 0,
      late: 0,
      missing: 0,
      inReview: 0,
      approved: ops.rows.filter((r) => r.approval === 'approved').length,
    });
    expect(ops.counts.approved).toBeGreaterThan(0);
    expect(ops.counts.approved).toBeLessThan(ops.rows.length);
    const text = (await send(f, 'ops.one', 'GET', BOARD)).text;
    expect(text).not.toContain(walled?.companyName ?? '');
    const member = await board(f, 'deal.three');
    expect(member.rows).toHaveLength(ops.rows.length + 1);
    expect(member.rows.some((r) => r.investmentId === walledId)).toBe(true);
    // An earlier quarter end, and the query's refusals.
    const earlier = await board(f, 'viewer.one', '?asOf=2025-05-15');
    expect(earlier.periodEnd).toBe('2025-03-31');
    expect(earlier.rows.every((r) => r.documentStatus === 'expected')).toBe(true);
    expect((await send(f, 'viewer.one', 'GET', `${BOARD}?periodEnd=2025-06-15`)).status).toBe(400);
    expect((await send(f, 'viewer.one', 'GET', `${BOARD}?other=1`)).status).toBe(400);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('judges the generated rows on the as-of day, reads the runs and approvals, and exports the same rows as CSV', async () => {
    const { f } = setup();
    await stage(f);
    const ops = await board(f, 'ops.one');
    const late = set.expectations.lateFinancials;
    const lateRow = ops.rows.find((r) => r.investmentId === late?.investmentId);
    expect(lateRow?.documentStatus).toBe('expected');
    expect(lateRow?.dueDate).toBe(dueDate);
    expect(lateRow?.ageDays).toBe(daysBetween(dueDate, book.asOf));
    expect(lateRow?.expectedDocumentId).not.toBeNull();
    expect(lateRow?.documentId).toBeNull();
    expect(lateRow?.runId).toBeNull();
    const received = ops.rows.filter((r) => r.documentStatus === 'received');
    expect(received.length).toBeGreaterThan(0);
    for (const row of received) expect(row.documentId).not.toBeNull();
    // A private credit position reads its sponsor fund's statement.
    const credit = ops.rows.find((r) => r.dealType === 'deal_type.private_credit');
    expect(credit?.documentStatus).toBe('received');
    expect(credit?.runId).toBeNull();
    // Every reporting position of the quarter with a report has a Succeeded run, waiting in
    // review whatever the seed holds for the quarter: a newer run is judged before the approved
    // record (FIN-5). A seeded quarter with no run of its own still reads approved from the record.
    const runs = extractionRunPage.parse(
      (await send(f, 'ops.one', 'GET', '/api/v1/extraction/runs?limit=200')).json,
    ).items;
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const row = ops.rows.find((r) => r.investmentId === run.investmentId);
      expect(row?.runId, run.fileName).toBe(run.id);
      expect(row?.runState).toBe('Succeeded');
      expect(row?.flagsCount).toBe(run.counts.flagged + run.counts.invalid);
      expect(row?.approval, run.fileName).toBe('pending');
      expect(row?.approvedAt).toBeNull();
    }
    expect(ops.counts.inReview).toBe(runs.length);
    expect(ops.counts.inReview).toBe(ops.rows.filter((r) => r.approval === 'pending').length);
    const seededOnly = ops.rows.filter(
      (r) =>
        r.runId === null &&
        (book.quarters[r.investmentId] ?? []).some((q) => q.periodEnd === latestQuarter),
    );
    expect(seededOnly.every((r) => r.approval === 'approved')).toBe(true);
    expect(ops.counts.approved).toBe(seededOnly.length);
    expect(ops.counts.received).toBe(received.length);

    // The as-of day moves the absent report to late, then missing.
    const lateDay = addDays(dueDate, settings.lateAfterDays + 1);
    const asLate = await board(f, 'ops.one', `?asOf=${lateDay}&periodEnd=${latestQuarter}`);
    const lateThen = asLate.rows.find((r) => r.investmentId === late?.investmentId);
    expect(lateThen?.documentStatus).toBe('late');
    expect(lateThen?.ageDays).toBe(settings.lateAfterDays + 1);
    expect(asLate.counts.late).toBeGreaterThan(0);
    const missingDay = addDays(dueDate, settings.missingAfterDays + 1);
    const asMissing = await board(f, 'ops.one', `?asOf=${missingDay}&periodEnd=${latestQuarter}`);
    expect(asMissing.rows.find((r) => r.investmentId === late?.investmentId)?.documentStatus).toBe(
      'missing',
    );
    expect(asMissing.counts.missing).toBeGreaterThan(0);
    // A received row keeps the day it arrived, whenever it is judged.
    expect(asMissing.rows.find((r) => r.investmentId === received[0]?.investmentId)?.ageDays).toBe(
      received[0]?.ageDays,
    );

    // The position with no approved quarter and no report yet: the scan is classified as its
    // report and extracted, and waits in review like the others.
    const none = ops.rows.find((r) => r.approval === 'none' && r.runId === null);
    expect(none).toBeDefined();
    const scan = documentPage.parse(
      (await send(f, 'ops.one', 'GET', '/api/v1/documents?limit=200&reviewStatus=NeedsReview'))
        .json,
    ).items[0];
    expect(
      (
        await send(f, 'ops.one', 'POST', `/api/v1/documents/${scan?.id}/commands`, {
          command: 'classify',
          docType: QUARTERLY_FINANCIALS,
          investmentId: none?.investmentId,
          periodEnd: latestQuarter,
        })
      ).status,
    ).toBe(200);
    expect(
      (await send(f, 'ops.one', 'POST', '/api/v1/extraction/batches', { documentIds: [scan?.id] }))
        .status,
    ).toBe(201);
    const withPending = await board(f, 'ops.one');
    const pendingRow = withPending.rows.find((r) => r.investmentId === none?.investmentId);
    expect(pendingRow?.approval).toBe('pending');
    expect(pendingRow?.runState).toBe('Succeeded');
    expect(pendingRow?.documentStatus).toBe('received');
    expect(pendingRow?.documentId).toBe(scan?.id);
    expect(withPending.counts.inReview).toBe(ops.counts.inReview + 1);
    const pending = pendingRow?.runId ?? '';
    const approvedAt = await reviewAndApprove(f, pending);
    const afterApproval = await board(f, 'ops.one');
    const approvedRow = afterApproval.rows.find((r) => r.investmentId === none?.investmentId);
    expect(approvedRow?.approval).toBe('approved');
    expect(approvedRow?.approvedAt).toBe(approvedAt);
    expect(approvedRow?.flagsCount).toBe(0);
    expect(afterApproval.counts.inReview).toBe(ops.counts.inReview);
    expect(afterApproval.counts.approved).toBe(ops.counts.approved + 1);

    // The export: the header line, then one line per row the caller sees.
    const exported = await send(f, 'ops.one', 'GET', EXPORT, undefined, { accept: 'text/csv' });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('text/csv');
    expect(exported.headers.get('content-disposition')).toBe(
      `attachment; filename="monitoring-board-${latestQuarter}.csv"`,
    );
    const lines = exported.text.split('\n');
    expect(lines[0]).toBe(BOARD_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(afterApproval.rows.length + 2);
    expect(lines[lines.length - 1]).toBe('');
    expect(exported.text).not.toContain(walled?.companyName ?? '');
    const first = lines[1]?.split(',');
    expect(first?.[0]).toBe(afterApproval.rows[0]?.investmentNumber);
    expect(first?.[6]).toBe(afterApproval.rows[0]?.documentStatus);
    const memberExport = await send(f, 'deal.three', 'GET', EXPORT);
    expect(memberExport.text.split('\n')).toHaveLength(afterApproval.rows.length + 3);
    expect(memberExport.text).toContain(walled?.companyName ?? '');

    // A revised report: a newer Succeeded run on the approved quarter waits in review before the
    // approved record is read (FIN-5), and reads approved again with its own time once approved.
    const again = await send(f, 'ops.one', 'POST', '/api/v1/extraction/batches', {
      documentIds: [scan?.id],
    });
    expect(again.status, again.text).toBe(201);
    const revised = await board(f, 'ops.one');
    const revisedRow = revised.rows.find((r) => r.investmentId === none?.investmentId);
    expect(revisedRow?.runId).not.toBe(pending);
    expect(revisedRow?.runState).toBe('Succeeded');
    expect(revisedRow?.approval).toBe('pending');
    expect(revisedRow?.approvedAt).toBeNull();
    expect(revisedRow?.flagsCount).toBe(pendingRow?.flagsCount);
    expect(revised.counts.inReview).toBe(afterApproval.counts.inReview + 1);
    expect(revised.counts.approved).toBe(afterApproval.counts.approved - 1);
    const revisedAt = await reviewAndApprove(f, revisedRow?.runId ?? '');
    const revisedApproved = await board(f, 'ops.one');
    const settled = revisedApproved.rows.find((r) => r.investmentId === none?.investmentId);
    expect(settled?.runId).toBe(revisedRow?.runId);
    expect(settled?.approval).toBe('approved');
    expect(settled?.approvedAt).toBe(revisedAt);
    expect(settled?.approvedAt).not.toBe(approvedAt);
    expect(revisedApproved.counts).toEqual(afterApproval.counts);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('reads the recorded outlook until the deal team sets one, guards the edit and keeps the wall', async () => {
    const { f, state } = setup();
    const open = book.investments.find((i) => i.id !== walledId)!;
    const path = outlookPath(open.id);
    const recorded = realizationOutlookDetail.parse(
      (await send(f, 'viewer.one', 'GET', path)).json,
    );
    expect(recorded.outlook).toBe('none');
    expect(recorded.horizonMonths).toBe(18);
    expect(recorded.setBy).toBeNull();
    expect((await send(f, 'ops.one', 'GET', outlookPath(walledId))).status).toBe(404);
    expect((await send(f, 'deal.three', 'GET', outlookPath(walledId))).status).toBe(200);
    expect((await send(f, 'ops.one', 'GET', outlookPath('not-a-uuid'))).status).toBe(404);

    const body = {
      outlook: 'partial',
      horizonMonths: 12,
      note: 'Sponsor has engaged advisors.',
      reason: 'Sale process started',
    };
    expect((await send(f, 'ops.one', 'PUT', path, body)).status).toBe(403);
    expect((await send(f, 'head.one', 'PUT', path, body)).status).toBe(403);
    const invalid = await send(f, 'deal.one', 'PUT', path, { ...body, horizonMonths: 0 });
    expect(invalid.status).toBe(400);
    expect(problemDetails.parse(invalid.json).errors?.map((e) => e.path)).toEqual([
      'horizonMonths',
    ]);
    expect(
      (await send(f, 'deal.one', 'PUT', path, { outlook: 'full', horizonMonths: 6, reason: 'x' }))
        .status,
    ).toBe(400);
    expect((await send(f, 'deal.one', 'PUT', outlookPath(walledId), body)).status).toBe(404);

    const set = await send(f, 'deal.one', 'PUT', path, body);
    expect(set.status, set.text).toBe(200);
    expect(set.headers.get('x-pb-simulated')).toBe('true');
    const detail = realizationOutlookDetail.parse(set.json);
    expect(detail).toEqual({
      investmentId: open.id,
      investmentNumber: open.investmentNumber,
      companyName: open.companyName,
      outlook: 'partial',
      horizonMonths: 12,
      note: 'Sponsor has engaged advisors.',
      setBy: USERS.deal.displayName,
      setAt: detail.setAt,
    });
    expect(realizationOutlookDetail.parse((await send(f, 'viewer.one', 'GET', path)).json)).toEqual(
      detail,
    );
    const event = state.audit.find((e) => e.action === 'realization_outlook.set');
    expect(event?.reason).toBe('Sale process started');
    expect(event?.from).toBeNull();
    expect(event?.to).toBe('partial');
    // The wall member sets the walled position's outlook; nobody else reads it.
    const walledSet = await send(f, 'deal.three', 'PUT', outlookPath(walledId), {
      ...body,
      outlook: 'full',
    });
    expect(walledSet.status, walledSet.text).toBe(200);
    expect((await send(f, 'deal.one', 'GET', outlookPath(walledId))).status).toBe(404);
    expect(
      realizationOutlookDetail.parse((await send(f, 'head.one', 'GET', outlookPath(walledId))).json)
        .outlook,
    ).toBe('full');
    // Reset forgets the edits.
    expect((await send(f, 'viewer.one', 'POST', '/api/v1/preview/reset')).status).toBe(200);
    expect(
      realizationOutlookDetail.parse((await send(f, 'viewer.one', 'GET', path)).json).outlook,
    ).toBe('none');
    expect(problemOf(await send(f, 'ops.one', 'GET', outlookPath(walledId))).code).toBe(
      'not-found',
    );
  });
});
