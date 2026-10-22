import { beforeEach, describe, expect, it } from 'vitest';
import { latestQuarterEndOnOrBefore, toDollars } from '@pb/calc';
import {
  documentPage,
  extractionBatch,
  extractionBatchPage,
  extractionRunDetail,
  extractionRunPage,
  investmentPerformance,
  problemDetails,
} from '@pb/contracts';
import type { ExtractionRun, ExtractionRunDetail } from '@pb/contracts';
import { writePdf } from '@pb/pdf';
import {
  INJECTION_TEXT,
  QUARTERLY_FIELDS,
  UNTAGGED_FILE_NAME,
  generateDataset,
  generateDocuments,
  previewBook,
} from '@pb/synthetic';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState, quarterKey } from '../state.js';
import type { PreviewState } from '../state.js';
import { USERS, generatedWorld, problemOf, send, serveSamples } from '../test-fixtures.js';
import { costOf, extractionSettings } from './extraction.js';

/**
 * The simulated extraction engine over the real generator and the bundled PDFs: the fixture
 * extractor answers each report's truth, the validator judges it with the config, the review
 * commands run as the API runs them and an approval promotes into the quarters the Performance
 * tab overlay reads. Every count here comes from the set's expectations and the truths.
 */
const dataset = generateDataset({ profile: 'small', seed: 42 });
const set = generateDocuments(dataset);
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset, { documents: set }))));
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';
const expectations = set.expectations;
const latestQuarter = latestQuarterEndOnOrBefore(book.asOf);
const QUARTERLY_FINANCIALS = 'doc_type.quarterly_financials';
const fixtures = generatedWorld(book, walledId);
const assets = serveSamples(new Map(set.documents.map((d) => [d.fileName, d.bytes])));

const INDEX = '/api/v1/documents/index';
const BATCHES = '/api/v1/extraction/batches';
const BATCH_LIST = `${BATCHES}?limit=200`;
const RUNS = '/api/v1/extraction/runs?limit=200';
const runPath = (id: string): string => `/api/v1/extraction/runs/${id}`;
const commandsPath = (id: string): string => `/api/v1/extraction/runs/${id}/commands`;
const FLAG = '/api/v1/flags/ai.extraction';

/** The reports of the latest quarter a batch over it covers: Classified only, so neither the scan nor the duplicate copy. */
const latestReports = book.documents.filter(
  (d) =>
    d.truth.docType === QUARTERLY_FINANCIALS &&
    d.truth.periodEnd === latestQuarter &&
    d.fileName !== UNTAGGED_FILE_NAME &&
    d.fileName !== expectations.scenarioFiles.duplicate_doc[1],
);
const walledReports = latestReports.filter((d) => d.truth.investmentId === walledId);

let ids = 0;
let ticks = 0;
const env = {
  newId: (): string => `70000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => new Date(Date.UTC(2025, 6, 1, 9, 0, 0) + ++ticks * 1000).toISOString(),
};

function setup(sampleFetch: typeof fetch = assets): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  const f = createPreviewFetch(fixtures, sampleFetch, { env, state, book });
  return { f, state };
}

async function prepare(f: typeof fetch): Promise<void> {
  expect((await send(f, 'ops.one', 'POST', INDEX)).status).toBe(200);
  const on = await send(f, 'admin.one', 'PATCH', FLAG, {
    enabled: true,
    reason: 'enabled by the test',
  });
  expect(on.status, on.text).toBe(200);
}

async function batchLatest(f: typeof fetch) {
  const answer = await send(f, 'ops.one', 'POST', BATCHES, {
    periodEnd: latestQuarter,
    docType: QUARTERLY_FINANCIALS,
  });
  expect(answer.status, answer.text).toBe(201);
  expect(answer.headers.get('x-pb-simulated')).toBe('true');
  return extractionBatch.parse(answer.json);
}

async function runs(f: typeof fetch, who: string, query = ''): Promise<ExtractionRun[]> {
  const answer = await send(f, who, 'GET', `${RUNS}${query}`);
  expect(answer.status, answer.text).toBe(200);
  return extractionRunPage.parse(answer.json).items;
}

async function detail(f: typeof fetch, who: string, id: string): Promise<ExtractionRunDetail> {
  const answer = await send(f, who, 'GET', runPath(id));
  expect(answer.status, answer.text).toBe(200);
  return extractionRunDetail.parse(answer.json);
}

const command = (f: typeof fetch, who: string, id: string, body: unknown) =>
  send(f, who, 'POST', commandsPath(id), body);

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('the simulated extraction engine (docs/04 M4) over the bundled set', () => {
  it('has reports of the latest quarter to extract, one of them walled', () => {
    expect(latestReports.length).toBeGreaterThan(2);
    expect(walledReports).toHaveLength(1);
    expect(expectations.scenarioFiles.injection_doc).toHaveLength(1);
  });

  it('refuses a batch while the kill switch is off, for the wrong roles, and for documents it cannot extract', async () => {
    const { f } = setup();
    expect((await send(f, 'ops.one', 'POST', INDEX)).status).toBe(200);
    const off = await send(f, 'ops.one', 'POST', BATCHES, {
      periodEnd: latestQuarter,
      docType: QUARTERLY_FINANCIALS,
    });
    expect(off.status).toBe(409);
    expect(problemOf(off)).toEqual({
      code: 'kill-switch',
      detail: 'AI extraction is switched off (ai.extraction)',
    });
    expect(
      (await send(f, 'admin.one', 'PATCH', FLAG, { enabled: true, reason: 'test' })).status,
    ).toBe(200);
    for (const who of ['viewer.one', 'deal.one', 'head.one'])
      expect(
        (
          await send(f, who, 'POST', BATCHES, {
            periodEnd: latestQuarter,
            docType: QUARTERLY_FINANCIALS,
          })
        ).status,
        who,
      ).toBe(403);
    const docs = documentPage.parse(
      (await send(f, 'deal.three', 'GET', '/api/v1/documents?limit=200')).json,
    ).items;
    const scan = docs.find((d) => d.fileName === UNTAGGED_FILE_NAME);
    const notice = docs.find((d) => d.docType === 'doc_type.capital_call');
    const walledReport = docs.find((d) => d.fileName === walledReports[0]?.fileName);
    const review = await send(f, 'ops.one', 'POST', BATCHES, { documentIds: [scan?.id] });
    expect(review.status).toBe(422);
    expect(problemOf(review).detail).toBe(
      `extraction: ${UNTAGGED_FILE_NAME} is NeedsReview, not Classified; classify it first`,
    );
    const noSchema = await send(f, 'ops.one', 'POST', BATCHES, { documentIds: [notice?.id] });
    expect(noSchema.status).toBe(422);
    expect(problemOf(noSchema).detail).toContain('no extraction schema for');
    const hidden = await send(f, 'ops.one', 'POST', BATCHES, {
      documentIds: [walledReport?.id],
    });
    expect(hidden.status).toBe(404);
    const none = await send(f, 'ops.one', 'POST', BATCHES, {
      periodEnd: '2010-03-31',
      docType: QUARTERLY_FINANCIALS,
    });
    expect(none.status).toBe(422);
    expect(problemOf(none).detail).toContain('for 2010-03-31');
    expect((await send(f, 'ops.one', 'POST', BATCHES, { periodEnd: '2025-06-15' })).status).toBe(
      400,
    );
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('runs every report of the latest quarter through the fixture extractor and the validator, as the caller sees it', async () => {
    const { f, state } = setup();
    await prepare(f);
    const batch = await batchLatest(f);
    expect(batch.state).toBe('succeeded');
    expect(batch.progress).toBe(100);
    expect(batch.errorCode).toBeNull();
    expect(batch.requestedBy).toBe(USERS.ops.displayName);
    expect(batch.startedAt).not.toBeNull();
    expect(batch.finishedAt).not.toBeNull();
    // Operations stands outside the wall: the walled run is not counted for it.
    const outside = latestReports.length - walledReports.length;
    expect(batch.runs).toEqual({
      total: outside,
      queued: 0,
      running: 0,
      succeeded: outside,
      failed: 0,
      needsRetry: 0,
    });
    expect(batch.tokensIn).toBeGreaterThan(0);
    expect(batch.tokensOut).toBe(64 * outside);
    // The batch's cost is the sum of each run's cost to four places, as the API sums cost_usd.
    const visibleRuns = await runs(f, 'ops.one');
    expect(batch.costUsd).toBe(
      visibleRuns.reduce((sum, r) => sum + Number(r.costUsd ?? '0'), 0).toFixed(4),
    );
    const member = extractionBatchPage.parse((await send(f, 'deal.three', 'GET', BATCH_LIST)).json)
      .items[0];
    expect(member?.id).toBe(batch.id);
    expect(member?.runs.total).toBe(latestReports.length);
    expect(state.runs.size).toBe(latestReports.length);

    const opsRuns = await runs(f, 'ops.one');
    expect(opsRuns).toHaveLength(outside);
    expect((await runs(f, 'deal.three')).map((r) => r.fileName).sort()).toEqual(
      latestReports.map((d) => d.fileName).sort(),
    );
    expect(await runs(f, 'viewer.one', '&state=Failed')).toEqual([]);
    expect(await runs(f, 'ops.one', `&batchId=${batch.id}`)).toHaveLength(outside);
    for (const run of opsRuns) {
      expect(run.state).toBe('Succeeded');
      expect(run.batchId).toBe(batch.id);
      expect(run.schemaId).toBe('quarterly_financials');
      expect(run.promptId).toBe('quarterly_extraction');
      expect(run.promptVersion).toBe('1');
      expect(run.modelId).toBe('mock');
      expect(run.periodEnd).toBe(latestQuarter);
      expect(run.investmentId).not.toBeNull();
      expect(run.counts.values).toBe(QUARTERLY_FIELDS.length);
      expect(run.counts.invalid).toBe(0);
      expect(run.counts.decided).toBe(0);
      expect(run.approvedBy).toBeNull();
      expect(run.errorCode).toBeNull();
      expect(run.tokensOut).toBe(64);
      expect(run.costUsd).toBe(costOf(run.tokensIn ?? 0, 64, extractionSettings()));
    }
    // Each document now names its latest run.
    const docs = documentPage.parse(
      (await send(f, 'ops.one', 'GET', `/api/v1/documents?limit=200&periodEnd=${latestQuarter}`))
        .json,
    ).items;
    for (const doc of docs.filter((d) => d.docType === QUARTERLY_FINANCIALS))
      expect(doc.latestRun?.id).toBe(opsRuns.find((r) => r.documentId === doc.id)?.id);
    expect(state.audit.filter((e) => e.action === 'extraction_run.succeed')).toHaveLength(
      latestReports.length,
    );
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('answers each run with the truth of its document, in schema order, with the page layouts, and hides a walled run', async () => {
    const { f } = setup();
    await prepare(f);
    await batchLatest(f);
    for (const run of await runs(f, 'deal.three')) {
      const d = await detail(f, 'deal.three', run.id);
      const truth = book.documents.find((x) => x.fileName === run.fileName)?.truth;
      expect(truth).toBeDefined();
      expect(d.run.id).toBe(run.id);
      expect(d.document.id).toBe(run.documentId);
      expect(d.document.latestRun?.id).toBe(run.id);
      expect(d.values.map((v) => v.field)).toEqual([...QUARTERLY_FIELDS]);
      for (const v of d.values) {
        const t = truth?.fields[v.field];
        expect(v.value, `${run.fileName} ${v.field}`).toBe(t?.value ?? null);
        expect(v.unit).toBe(t?.unit ?? null);
        expect(v.page).toBe(t?.page ?? null);
        expect(v.quote).toBe(t?.quote ?? null);
        expect(v.confidence).toBe('1');
        expect(v.decision).toBeNull();
        expect(v.label.length).toBeGreaterThan(0);
        expect(v.validationState).not.toBe('invalid');
        expect(v.findings.every((x) => x.severity === 'flagged')).toBe(true);
      }
      expect(d.highlights).toEqual(truth?.highlights);
      expect(d.commentary).toBe(truth?.commentary);
      expect(d.pages.map((p) => p.number)).toEqual(
        Array.from({ length: truth?.pageCount ?? 0 }, (_, i) => i + 1),
      );
      expect(d.pages.every((p) => p.width > 0 && p.height > 0 && p.runs.length > 0)).toBe(true);
      // Every cited quote is found among the runs of its page, joined by spaces.
      for (const v of d.values) {
        if (v.quote === null || v.page === null) continue;
        const text = d.pages[v.page - 1]?.runs.map((r) => r.text).join(' ') ?? '';
        expect(text, `${v.field} quote`).toContain(v.quote.split(' ')[0] ?? '');
      }
    }
    // The injection document's run shows the real figures, never the instruction's.
    const injected = (await runs(f, 'ops.one')).find(
      (r) => r.fileName === expectations.scenarioFiles.injection_doc[0],
    );
    const d = await detail(f, 'ops.one', injected?.id ?? '');
    expect(d.values.find((v) => v.field === 'revenue_ltm')?.value).not.toBe('999.00');
    expect(JSON.stringify(d.values)).not.toContain('999.00');
    expect(
      d.pages.some((p) => p.runs.some((r) => r.text.includes(INJECTION_TEXT.slice(0, 20)))),
    ).toBe(true);
    const walledRun = (await runs(f, 'deal.three')).find((r) => r.investmentId === walledId);
    expect(walledRun).toBeDefined();
    expect((await send(f, 'ops.one', 'GET', runPath(walledRun?.id ?? ''))).status).toBe(404);
    expect((await send(f, 'viewer.one', 'GET', runPath(walledRun?.id ?? ''))).status).toBe(404);
    expect((await send(f, 'head.one', 'GET', runPath(walledRun?.id ?? ''))).status).toBe(200);
    expect((await send(f, 'ops.one', 'GET', runPath('not-a-uuid'))).status).toBe(404);
  });

  it('reviews by exception: accept, reject, edit, accept clean, the blockers, then the approval promotes in dollars', async () => {
    const { f, state } = setup();
    await prepare(f);
    await batchLatest(f);
    const run = (await runs(f, 'ops.one'))[0]!;
    const before = await detail(f, 'ops.one', run.id);
    const revenue = before.values.find((v) => v.field === 'revenue_ltm')!;
    const ebitda = before.values.find((v) => v.field === 'ebitda_ltm')!;
    expect(revenue.value).not.toBeNull();
    expect(revenue.unit).toBe('USD_M');

    expect((await command(f, 'viewer.one', run.id, { command: 'acceptClean' })).status).toBe(403);
    expect((await command(f, 'head.one', run.id, { command: 'acceptClean' })).status).toBe(403);
    const unknown = await command(f, 'ops.one', run.id, { command: 'accept', field: 'nothing' });
    expect(unknown.status).toBe(400);
    expect(problemDetails.parse(unknown.json).errors?.map((e) => e.path)).toEqual(['field']);
    expect((await command(f, 'ops.one', run.id, { command: 'nonsense' })).status).toBe(400);

    // Approval before any decision names the first required field.
    const early = await command(f, 'ops.one', run.id, { command: 'approve' });
    expect(early.status).toBe(409);
    expect(problemOf(early)).toEqual({
      code: 'review-blocked',
      detail: 'extraction: Period end is required and not accepted or edited',
    });

    const accepted = extractionRunDetail.parse(
      (await command(f, 'deal.one', run.id, { command: 'accept', field: 'revenue_ltm' })).json,
    );
    const acceptedRevenue = accepted.values.find((v) => v.field === 'revenue_ltm');
    expect(acceptedRevenue?.decision).toBe('accepted');
    expect(acceptedRevenue?.decidedBy).toBe(USERS.deal.displayName);
    expect(accepted.run.counts.decided).toBe(1);

    const noUnit = await command(f, 'ops.one', run.id, {
      command: 'edit',
      field: 'ebitda_ltm',
      value: '12.50',
      reason: 'restated',
    });
    expect(noUnit.status).toBe(400);
    expect(problemDetails.parse(noUnit.json).errors?.map((e) => e.path)).toEqual(['unit']);
    const badValue = await command(f, 'ops.one', run.id, {
      command: 'edit',
      field: 'headcount',
      value: '12.5',
      reason: 'restated',
    });
    expect(badValue.status).toBe(400);
    expect(problemDetails.parse(badValue.json).errors?.map((e) => e.path)).toEqual(['value']);
    const narrative = await command(f, 'ops.one', run.id, {
      command: 'edit',
      field: 'highlights',
      value: 'x',
      reason: 'restated',
    });
    expect(narrative.status).toBe(400);
    const edited = extractionRunDetail.parse(
      (
        await command(f, 'ops.one', run.id, {
          command: 'edit',
          field: 'ebitda_ltm',
          value: '12.50',
          unit: 'USD_K',
          reason: 'restated by the sponsor',
        })
      ).json,
    );
    const editedEbitda = edited.values.find((v) => v.field === 'ebitda_ltm');
    expect(editedEbitda?.decision).toBe('edited');
    expect(editedEbitda?.editedValue).toBe('12.50');
    // The edit carries its own unit; the model's value and unit stay on the row (WF-1).
    expect(editedEbitda?.editedUnit).toBe('USD_K');
    expect(editedEbitda?.unit).toBe(ebitda.unit);
    expect(editedEbitda?.value).toBe(ebitda.value);

    const rejected = extractionRunDetail.parse(
      (
        await command(f, 'ops.one', run.id, {
          command: 'reject',
          field: 'enterprise_value',
          reason: 'not in the report',
        })
      ).json,
    );
    expect(rejected.values.find((v) => v.field === 'enterprise_value')?.decision).toBe('rejected');

    const clean = extractionRunDetail.parse(
      (await command(f, 'ops.one', run.id, { command: 'acceptClean' })).json,
    );
    // Every undecided clean value is accepted; the three decided before keep their decision.
    expect(clean.values.every((v) => v.decision !== null)).toBe(true);
    expect(clean.values.find((v) => v.field === 'enterprise_value')?.decision).toBe('rejected');
    expect(clean.run.counts.decided).toBe(QUARTERLY_FIELDS.length);
    expect(state.audit.find((e) => e.action === 'extraction_run.acceptClean')?.details).toEqual({
      fields: QUARTERLY_FIELDS.length - 3 + 2,
    });

    const approved = await command(f, 'deal.one', run.id, {
      command: 'approve',
      reason: 'Checked against the report',
    });
    expect(approved.status, approved.text).toBe(200);
    const after = extractionRunDetail.parse(approved.json);
    expect(after.run.approvedBy).toBe(USERS.deal.displayName);
    expect(after.run.approvedAt).not.toBeNull();
    expect(after.run.promotedRecordId).not.toBeNull();
    const promoted = state.promotedQuarters.get(quarterKey(run.investmentId ?? '', latestQuarter));
    expect(promoted?.id).toBe(after.run.promotedRecordId);
    expect(promoted?.figures.revenueLtm).toBe(toDollars(revenue.value ?? '0', 'USD_M').toFixed());
    expect(promoted?.figures.ebitdaLtm).toBe(toDollars('12.50', 'USD_K').toFixed());
    expect(promoted?.figures.ev).toBeUndefined();
    expect(promoted?.highlights).toEqual(before.highlights);
    expect(promoted?.commentary).toBe(before.commentary);
    expect(promoted?.source).toEqual({
      documentId: run.documentId,
      runId: run.id,
      page: revenue.page,
      locator: 'field:revenue_ltm',
    });
    expect(promoted?.approvalReason).toBe('Checked against the report');
    // The quarter on record was replaced when the book holds it, created otherwise.
    const onRecord = (book.quarters[run.investmentId ?? ''] ?? []).find(
      (q) => q.periodEnd === latestQuarter,
    );
    expect(promoted?.created).toBe(onRecord === undefined);
    if (onRecord !== undefined) expect(promoted?.id).toBe(onRecord.id);
    expect(state.audit.map((e) => e.action)).toContain('quarterly_performance.promote');
    expect(state.audit.map((e) => e.action)).toContain('extraction_run.approve');

    // Once approved, every later command is refused.
    const again = await command(f, 'ops.one', run.id, { command: 'approve' });
    expect(again.status).toBe(409);
    expect(problemOf(again).detail).toBe('extraction: the run is already approved and promoted');
    expect(
      (await command(f, 'ops.one', run.id, { command: 'accept', field: 'revenue_ltm' })).status,
    ).toBe(409);
    const retried = await command(f, 'ops.one', run.id, { command: 'retry' });
    expect(retried.status).toBe(409);
    expect(problemOf(retried)).toEqual({
      code: 'workflow-transition',
      detail: 'extraction_run: retry is not allowed from Succeeded',
    });

    // The Performance tab reads the promoted quarter with its source; a reader outside the wall
    // reads it through their own recording, and a hidden position stays hidden.
    const perf = investmentPerformance.parse(
      (await send(f, 'viewer.one', 'GET', `/api/v1/investments/${run.investmentId}/performance`))
        .json,
    );
    const quarter = perf.quarters.find((q) => q.periodEnd === latestQuarter);
    expect(quarter?.revenueLtm).toBe(promoted?.figures.revenueLtm);
    expect(quarter?.ebitdaLtm).toBe(promoted?.figures.ebitdaLtm);
    expect(quarter?.status).toBe('record_status.approved');
    expect(quarter?.source).toEqual(promoted?.source);
    expect(quarter?.highlights).toEqual(before.highlights);
    expect(quarter?.ebitdaMargin).not.toBeNull();
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('refuses to accept an invalid value, to approve with a flagged one undecided, and to promote without an investment', async () => {
    const { f } = setup();
    await prepare(f);
    // The period_end_shift reports carry a period end that is not a quarter end: EXT-DATE-01, invalid.
    const shifted = book.documents.find(
      (d) => d.truth.docType === QUARTERLY_FINANCIALS && d.truth.periodEnd.endsWith('27'),
    );
    expect(shifted).toBeDefined();
    const docs = documentPage.parse(
      (await send(f, 'ops.one', 'GET', '/api/v1/documents?limit=200')).json,
    ).items;
    const doc = docs.find((d) => d.fileName === shifted?.fileName);
    const batch = extractionBatch.parse(
      (await send(f, 'ops.one', 'POST', BATCHES, { documentIds: [doc?.id] })).json,
    );
    expect(batch.runs.total).toBe(1);
    const run = (await runs(f, 'ops.one', `&batchId=${batch.id}`))[0]!;
    expect(run.counts.invalid).toBe(1);
    const d = await detail(f, 'ops.one', run.id);
    const periodEnd = d.values.find((v) => v.field === 'period_end');
    expect(periodEnd?.validationState).toBe('invalid');
    expect(periodEnd?.findings.map((x) => x.ruleId)).toEqual(['EXT-DATE-01']);
    const accept = await command(f, 'ops.one', run.id, { command: 'accept', field: 'period_end' });
    expect(accept.status).toBe(409);
    expect(problemOf(accept).detail).toMatch(
      /^extraction: Period end is invalid and cannot be accepted: .*; edit or reject it$/,
    );
    await command(f, 'ops.one', run.id, { command: 'acceptClean' });
    const blockedInvalid = await command(f, 'ops.one', run.id, { command: 'approve' });
    expect(problemOf(blockedInvalid).detail).toBe(
      'extraction: Period end is required and not accepted or edited',
    );
    const fixed = await command(f, 'ops.one', run.id, {
      command: 'edit',
      field: 'period_end',
      value: latestQuarter,
      reason: 'the quarter the report is for',
    });
    expect(fixed.status, fixed.text).toBe(200);
    expect(
      extractionRunDetail.parse(fixed.json).values.find((v) => v.field === 'period_end')?.unit,
    ).toBe('DATE');
    const promoted = await command(f, 'ops.one', run.id, { command: 'approve' });
    expect(promoted.status, promoted.text).toBe(200);
    expect(extractionRunDetail.parse(promoted.json).run.approvedBy).toBe(USERS.ops.displayName);
  });

  it('retries a schema failure once and then fails with a data exception; a hand retry queues a fresh run', async () => {
    // One report is served with other bytes than the book records: its hash has no truth, so the
    // fixture extractor refuses (no_fixture), a schema failure the budget retries once.
    const target = latestReports.find((d) => d.truth.investmentId !== walledId)!;
    const other = writePdf({
      title: `Quarterly Report: ${target.truth.companyName ?? ''}, quarter ended June 2025`,
      pages: [
        {
          items: [
            {
              kind: 'text',
              x: 72,
              y: 720,
              size: 14,
              font: 'Helvetica-Bold',
              text: target.truth.sponsorFundName,
            },
            { kind: 'text', x: 72, y: 700, size: 12, font: 'Helvetica', text: 'Quarterly Report' },
            {
              kind: 'text',
              x: 72,
              y: 680,
              size: 10,
              font: 'Helvetica',
              text: `Period end ${latestQuarter}`,
            },
            {
              kind: 'text',
              x: 72,
              y: 660,
              size: 10,
              font: 'Helvetica',
              text: `Prepared for the investor, reference ${target.truth.investmentNumber ?? ''}`,
            },
          ],
        },
      ],
    });
    const files = new Map(set.documents.map((d) => [d.fileName, d.bytes]));
    files.set(target.fileName, other);
    const { f, state } = setup(serveSamples(files));
    await prepare(f);
    const batch = await batchLatest(f);
    expect(batch.state).toBe('failed');
    expect(batch.errorCode).toBe('runs_failed');
    expect(batch.runs.failed).toBe(1);
    const failed = (await runs(f, 'ops.one', '&state=Failed'))[0]!;
    expect(failed.fileName).toBe(target.fileName);
    expect(failed.errorKind).toBe('schema');
    expect(failed.errorCode).toBe('ai_no_fixture');
    expect(failed.schemaRetries).toBe(extractionSettings().schemaRetries);
    expect(failed.counts.values).toBe(0);
    const exception = [...state.exceptions.values()].find((x) => x.entityId === failed.id);
    expect(exception?.ruleId).toBe('EXT-RUN-01');
    expect(exception?.entity).toBe('doc.extraction_run');
    expect(exception?.context.intakeFileId).toBeNull();
    const audited = state.audit.filter((e) => e.entityId === failed.id).map((e) => e.action);
    expect(audited).toEqual([
      'extraction_run.queue',
      'extraction_run.start',
      'extraction_run.scheduleRetry',
      'extraction_run.retry',
      'extraction_run.fail',
    ]);
    // A review command on a Failed run is refused; a retry queues a fresh run that fails the same way.
    const review = await command(f, 'ops.one', failed.id, { command: 'acceptClean' });
    expect(problemOf(review).detail).toBe(
      'extraction: acceptClean needs a Succeeded run; this one is Failed',
    );
    const retried = await command(f, 'deal.one', failed.id, { command: 'retry' });
    expect(retried.status, retried.text).toBe(200);
    const fresh = extractionRunDetail.parse(retried.json);
    expect(fresh.run.id).not.toBe(failed.id);
    expect(fresh.run.batchId).toBeNull();
    expect(fresh.run.state).toBe('Failed');
    expect(fresh.run.requestedBy).toBe(USERS.deal.displayName);
    expect(fresh.document.latestRun?.id).toBe(fresh.run.id);
    expect(state.exceptions.size).toBe(2);
    expect(
      (await send(f, 'admin.one', 'PATCH', FLAG, { enabled: false, reason: 'test' })).status,
    ).toBe(200);
    expect(problemOf(await command(f, 'ops.one', failed.id, { command: 'retry' })).code).toBe(
      'kill-switch',
    );
  });
});
