import definitions from '../../../../../config/definitions.json';
import styleJson from '../../../../../config/style.json';
import { beforeEach, describe, expect, it } from 'vitest';
import { boundsFrom } from '@pb/ai';
import { addDays, latestQuarterEndOnOrBefore, toDollars } from '@pb/calc';
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
import type { PreviewBook } from '../book.js';
import type { PreviewFixtures } from '../fixtures.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState, quarterKey, valuesOfRun } from '../state.js';
import type { PreviewState, SimRun } from '../state.js';
import { USERS, generatedWorld, problemOf, send, serveSamples } from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';
import {
  DEFAULT_APPROVAL_REASON,
  EXTRACTION_SWITCH,
  KILL_SWITCH_CODE,
  costOf,
  dayTokensOf,
  extractionSchemas,
  extractionSettings,
  schemaForDocType,
  valueProblem,
} from './extraction.js';

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

/** A preview over the world's recordings and the bundled set, or over what a case puts in their place. */
function setup(
  options: {
    samples?: typeof fetch;
    book?: PreviewBook;
    fixtures?: PreviewFixtures;
    state?: PreviewState;
  } = {},
): { f: typeof fetch; state: PreviewState } {
  const state = options.state ?? createPreviewState();
  const f = createPreviewFetch(options.fixtures ?? fixtures, options.samples ?? assets, {
    env,
    state,
    book: options.book ?? book,
  });
  return { f, state };
}

/** The staged document of a bundled file, as the credential lists it. */
async function documentOf(f: typeof fetch, who: string, fileName: string) {
  const docs = documentPage.parse((await send(f, who, 'GET', '/api/v1/documents?limit=200')).json);
  return docs.items.find((d) => d.fileName === fileName);
}

/** The first run of a batch over the one document named, as operations sees it. */
async function runOver(f: typeof fetch, fileName: string): Promise<ExtractionRun> {
  const doc = await documentOf(f, 'ops.one', fileName);
  const answer = await send(f, 'ops.one', 'POST', BATCHES, { documentIds: [doc?.id] });
  expect(answer.status, answer.text).toBe(201);
  const batch = extractionBatch.parse(answer.json);
  return (await runs(f, 'ops.one', `&batchId=${batch.id}`))[0]!;
}

const errorsOf = (answer: Answer) => problemDetails.parse(answer.json).errors;

/** The next calendar quarter end after the latest one (quarters are 90 to 92 days long). */
const nextQuarter = latestQuarterEndOnOrBefore(addDays(latestQuarter, 92));

/**
 * The switch as the simulation reads it per run: armed with a number of reads, it answers as set
 * for those and off after, as an admin turning it off part way through a batch would make it.
 */
class SwitchOffAfter extends Map<string, boolean> {
  remaining: number | null = null;
  override get(key: string): boolean | undefined {
    if (key === EXTRACTION_SWITCH && this.remaining !== null) {
      if (this.remaining === 0) return false;
      this.remaining -= 1;
    }
    return super.get(key);
  }
}

/** A run as the session holds it, Running since the start of the test's day unless a case says otherwise. */
function runFixture(n: number, overrides: Partial<SimRun> = {}): SimRun {
  return {
    id: `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    documentId: `90000000-0000-4000-8000-ffffffffffff`,
    investmentId: null,
    periodEnd: latestQuarter,
    schemaId: 'quarterly_financials',
    promptId: 'quarterly_extraction',
    promptVersion: '1',
    modelId: null,
    state: 'Running',
    batchId: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    startedAt: '2025-07-01T00:00:00.000Z',
    finishedAt: null,
    errorCode: null,
    errorKind: null,
    schemaRetries: 0,
    transientRetries: 0,
    requestedById: null,
    requestedBy: null,
    approvedById: null,
    approvedBy: null,
    approvedAt: null,
    promotedRecordId: null,
    createdAt: '2025-07-01T00:00:00.000Z',
    rowVersion: 1,
    ...overrides,
  };
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
    // 12,500 thousand dollars: inside the configured ebitda range (FIN-1), in the edit's own unit.
    const edited = extractionRunDetail.parse(
      (
        await command(f, 'ops.one', run.id, {
          command: 'edit',
          field: 'ebitda_ltm',
          value: '12500',
          unit: 'USD_K',
          reason: 'restated by the sponsor',
        })
      ).json,
    );
    const editedEbitda = edited.values.find((v) => v.field === 'ebitda_ltm');
    expect(editedEbitda?.decision).toBe('edited');
    expect(editedEbitda?.editedValue).toBe('12500');
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
    expect(promoted?.figures.ebitdaLtm).toBe(toDollars('12500', 'USD_K').toFixed());
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

  it('refuses to accept an invalid period end, to edit it off the period the run covers, and to approve one slipped onto the row (FIN-2)', async () => {
    const { f, state } = setup();
    await prepare(f);
    // The period_end_shift reports carry a period end that is not a quarter end: EXT-DATE-01, invalid.
    const shifted = book.documents.find(
      (d) => d.truth.docType === QUARTERLY_FINANCIALS && d.truth.periodEnd.endsWith('27'),
    );
    expect(shifted).toBeDefined();
    const run = await runOver(f, shifted?.fileName ?? '');
    expect(run.counts.invalid).toBe(1);
    expect(run.periodEnd).toBe(shifted?.truth.periodEnd);
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
    // The run covers the document's own period: an edit to the quarter the report should have
    // been filed under is a reclassification of the document, not a value edit (FIN-2), and a
    // date that is no quarter end is refused before that.
    const reclassified = await command(f, 'ops.one', run.id, {
      command: 'edit',
      field: 'period_end',
      value: latestQuarter,
      reason: 'the quarter the report is for',
    });
    expect(reclassified.status).toBe(400);
    expect(errorsOf(reclassified)).toEqual([
      {
        path: 'value',
        message: `The run covers ${run.periodEnd}; a report for another quarter is reclassified, not edited`,
      },
    ]);
    const midQuarter = await command(f, 'ops.one', run.id, {
      command: 'edit',
      field: 'period_end',
      value: '2025-06-15',
      reason: 'typed from the report',
    });
    expect(midQuarter.status).toBe(400);
    expect(errorsOf(midQuarter)).toEqual([
      { path: 'value', message: 'The date must be a quarter end' },
    ]);
    // Slipped onto the row past the edit rule (the API test stages it by SQL): the approval
    // refuses the quarter the run does not cover, and nothing is promoted.
    const row = valuesOfRun(state, run.id).find((v) => v.field === 'period_end');
    expect(row).toBeDefined();
    Object.assign(row ?? {}, {
      decision: 'edited',
      editedValue: latestQuarter,
      editedUnit: 'DATE',
    });
    const slipped = await command(f, 'ops.one', run.id, { command: 'approve' });
    expect(slipped.status).toBe(422);
    expect(problemOf(slipped)).toEqual({
      code: 'workflow-precondition',
      detail: `extraction: the period end ${latestQuarter} is not the quarter the run covers (${run.periodEnd}); edit it`,
    });
    expect(state.promotedQuarters.size).toBe(0);
    expect((await detail(f, 'ops.one', run.id)).run.approvedBy).toBeNull();
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('holds a reviewer to the rules the validator applies to the model: a money edit outside the range and a date off the quarter the run covers are refused (FIN-1, FIN-2)', async () => {
    const { f } = setup();
    await prepare(f);
    await batchLatest(f);
    const run = (await runs(f, 'ops.one'))[0]!;
    const edit = (body: Record<string, unknown>) =>
      command(f, 'ops.one', run.id, { command: 'edit', reason: 'typed from the report', ...body });
    const bounds = boundsFrom(definitions);
    // Dollars typed with the $M unit convert to a figure no company reports: refused naming the range.
    const dollarsAsMillions = await edit({
      field: 'revenue_ltm',
      value: '125400000',
      unit: 'USD_M',
    });
    expect(dollarsAsMillions.status).toBe(400);
    expect(problemOf(dollarsAsMillions).code).toBe('validation');
    expect(errorsOf(dollarsAsMillions)).toEqual([
      {
        path: 'value',
        message: `The value converts to ${toDollars('125400000', 'USD_M').toFixed()} dollars, outside the revenue range ${bounds.revenue.minUsd} to ${bounds.revenue.maxUsd}; check the unit`,
      },
    ]);
    const tooSmall = await edit({ field: 'ebitda_ltm', value: '0.001', unit: 'USD_K' });
    expect(tooSmall.status).toBe(400);
    expect(errorsOf(tooSmall)?.map((e) => e.path)).toEqual(['value']);
    expect(errorsOf(tooSmall)?.[0]?.message).toContain(
      `outside the ebitda range ${bounds.ebitda.minUsd} to ${bounds.ebitda.maxUsd}`,
    );
    const taken = await edit({ field: 'revenue_ltm', value: '125.40', unit: 'USD_M' });
    expect(taken.status, taken.text).toBe(200);
    const revenue = extractionRunDetail
      .parse(taken.json)
      .values.find((v) => v.field === 'revenue_ltm');
    expect(revenue?.decision).toBe('edited');
    expect(revenue?.editedValue).toBe('125.40');
    expect(revenue?.editedUnit).toBe('USD_M');
    // A date must be a quarter end, and the quarter the run was opened for.
    const midQuarter = await edit({ field: 'period_end', value: '2025-06-15' });
    expect(midQuarter.status).toBe(400);
    expect(errorsOf(midQuarter)).toEqual([
      { path: 'value', message: 'The date must be a quarter end' },
    ]);
    expect(nextQuarter).not.toBe(latestQuarter);
    const otherQuarter = await edit({ field: 'period_end', value: nextQuarter });
    expect(otherQuarter.status).toBe(400);
    expect(errorsOf(otherQuarter)).toEqual([
      {
        path: 'value',
        message: `The run covers ${latestQuarter}; a report for another quarter is reclassified, not edited`,
      },
    ]);
    const own = await edit({ field: 'period_end', value: latestQuarter });
    expect(own.status, own.text).toBe(200);
    expect(
      extractionRunDetail.parse(own.json).values.find((v) => v.field === 'period_end')?.editedUnit,
    ).toBe('DATE');
    // The rule on its own: a run opened without a period takes any quarter end, and a field
    // without bounds takes any money figure.
    const schema = schemaForDocType(extractionSchemas(), QUARTERLY_FINANCIALS);
    const periodField = schema?.fields.find((x) => x.key === 'period_end');
    const evField = schema?.fields.find((x) => x.key === 'enterprise_value');
    expect(periodField).toBeDefined();
    expect(evField?.bounds).toBeNull();
    expect(valueProblem({ periodEnd: null }, periodField!, nextQuarter, 'DATE')).toBeNull();
    expect(valueProblem({ periodEnd: null }, periodField!, '2025-06-15', 'DATE')).toBe(
      'The date must be a quarter end',
    );
    expect(valueProblem({ periodEnd: null }, evField!, '125400000', 'USD_M')).toBeNull();
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('refuses to accept a highlight or a commentary that breaks the house style, leaves them out of acceptClean, and promotes without them once rejected (AI-4)', async () => {
    // A book whose report carries the first configured banned phrase in highlight 1 and an em
    // dash in the commentary, both read from config so the style scan never sees them spelled.
    const altered = parseBook(JSON.parse(JSON.stringify(previewBook(dataset, { documents: set }))));
    const report = latestReports.find((d) => d.truth.investmentId !== walledId)!;
    const truth = altered.documents.find((d) => d.fileName === report.fileName)?.truth;
    expect(truth).toBeDefined();
    const banned = styleJson.highlights.bannedPhrases[0] ?? '';
    expect(banned).not.toBe('');
    const emDash = String.fromCharCode(0x2014);
    truth!.highlights[0] = `${truth!.highlights[0] ?? ''} with ${banned} ahead`;
    truth!.commentary = `${truth!.commentary ?? 'Performance held.'} ${emDash} as noted.`;
    const { f, state } = setup({ book: altered });
    await prepare(f);
    const run = await runOver(f, report.fileName);
    // The narrative rows are judged beside the values, never counted among them.
    expect(run.counts.flagged).toBe(0);
    const narrative = valuesOfRun(state, run.id).filter(
      (v) => v.field === 'highlights' || v.field === 'commentary',
    );
    expect(
      narrative
        .map((v) => `${v.field}:${v.validationState}:${v.findings.map((x) => x.ruleId).join('+')}`)
        .sort(),
    ).toEqual(['commentary:flagged:EXT-TEXT-01', 'highlights:flagged:EXT-STYLE-01']);
    const highlights = await command(f, 'ops.one', run.id, {
      command: 'accept',
      field: 'highlights',
    });
    expect(highlights.status).toBe(409);
    expect(problemOf(highlights)).toEqual({
      code: 'review-blocked',
      detail: `extraction: Highlights breaks the house style and cannot be accepted: Highlight 1 contains the banned phrase "${banned}"; reject it`,
    });
    const commentary = await command(f, 'ops.one', run.id, {
      command: 'accept',
      field: 'commentary',
    });
    expect(commentary.status).toBe(409);
    expect(problemOf(commentary).detail).toBe(
      'extraction: Commentary breaks the house style and cannot be accepted: The commentary contains an em dash; reject it',
    );
    const clean = extractionRunDetail.parse(
      (await command(f, 'ops.one', run.id, { command: 'acceptClean' })).json,
    );
    expect(clean.values.every((v) => v.decision === 'accepted')).toBe(true);
    expect(narrative.every((v) => v.decision === null)).toBe(true);
    expect(state.audit.find((e) => e.action === 'extraction_run.acceptClean')?.details).toEqual({
      fields: QUARTERLY_FIELDS.length,
    });
    for (const field of ['highlights', 'commentary']) {
      const rejected = await command(f, 'ops.one', run.id, {
        command: 'reject',
        field,
        reason: 'breaks the house style',
      });
      expect(rejected.status, rejected.text).toBe(200);
    }
    const approved = await command(f, 'ops.one', run.id, { command: 'approve' });
    expect(approved.status, approved.text).toBe(200);
    const promoted = state.promotedQuarters.get(quarterKey(run.investmentId ?? '', latestQuarter));
    expect(promoted?.figures.revenueLtm).toBeDefined();
    expect(promoted?.highlights).toBeUndefined();
    expect(promoted?.commentary).toBeUndefined();
    // The text never reaches the Performance tab.
    const perf = (
      await send(f, 'ops.one', 'GET', `/api/v1/investments/${run.investmentId}/performance`)
    ).text;
    expect(perf).not.toContain(banned);
    expect(perf).not.toContain(emDash);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('names an undecided record figure at approval, cites the first accepted figure, and records the fixed approval reason that never names the file (W3)', async () => {
    const { f, state } = setup();
    await prepare(f);
    await batchLatest(f);
    const [run, other] = await runs(f, 'ops.one');
    expect(run).toBeDefined();
    expect(other).toBeDefined();
    await command(f, 'ops.one', run!.id, { command: 'acceptClean' });
    // Cash back to undecided (the API test resets it by SQL): a record figure nobody decided is
    // named, never silently left out of the record.
    const cash = valuesOfRun(state, run!.id).find((v) => v.field === 'cash');
    expect(cash?.validationState).toBe('clean');
    Object.assign(cash ?? {}, {
      decision: null,
      decidedBy: null,
      decidedAt: null,
      reviewerId: null,
    });
    const undecided = await command(f, 'deal.one', run!.id, { command: 'approve' });
    expect(undecided.status).toBe(409);
    expect(problemOf(undecided)).toEqual({
      code: 'review-blocked',
      detail: 'extraction: Cash is a record figure and undecided; accept, edit or reject it',
    });
    expect(
      (await command(f, 'deal.one', run!.id, { command: 'accept', field: 'cash' })).status,
    ).toBe(200);
    // Revenue edited: the citation moves to the next promoted figure read from the document.
    const ebitda = (await detail(f, 'ops.one', run!.id)).values.find(
      (v) => v.field === 'ebitda_ltm',
    );
    expect(ebitda?.page).not.toBeNull();
    const edited = await command(f, 'ops.one', run!.id, {
      command: 'edit',
      field: 'revenue_ltm',
      value: '125.40',
      unit: 'USD_M',
      reason: 'restated by the sponsor',
    });
    expect(edited.status, edited.text).toBe(200);
    const approved = await command(f, 'deal.one', run!.id, { command: 'approve' });
    expect(approved.status, approved.text).toBe(200);
    const promoted = state.promotedQuarters.get(quarterKey(run!.investmentId ?? '', latestQuarter));
    expect(promoted?.source).toEqual({
      documentId: run!.documentId,
      runId: run!.id,
      page: ebitda?.page,
      locator: 'field:ebitda_ltm',
    });
    expect(promoted?.approvalReason).toBe(DEFAULT_APPROVAL_REASON);
    const events = state.audit.filter(
      (e) => e.action === 'extraction_run.approve' || e.action === 'quarterly_performance.promote',
    );
    expect(events.map((e) => e.reason)).toEqual([DEFAULT_APPROVAL_REASON, DEFAULT_APPROVAL_REASON]);
    const trail = JSON.stringify(state.audit);
    expect(trail).not.toContain(run!.fileName);
    expect(run!.companyName).not.toBeNull();
    expect(trail).not.toContain(run!.companyName ?? '');
    // Every record figure edited: nothing read from the document is cited.
    await command(f, 'ops.one', other!.id, { command: 'acceptClean' });
    const targets = schemaForDocType(extractionSchemas(), QUARTERLY_FINANCIALS)?.fields.filter(
      (x) => x.target !== null,
    );
    expect(targets?.length).toBeGreaterThan(1);
    for (const v of (await detail(f, 'ops.one', other!.id)).values) {
      if (!targets?.some((t) => t.key === v.field)) continue;
      const decided =
        v.value === null
          ? await command(f, 'ops.one', other!.id, {
              command: 'reject',
              field: v.field,
              reason: 'not stated in the report',
            })
          : await command(f, 'ops.one', other!.id, {
              command: 'edit',
              field: v.field,
              value: v.value,
              unit: v.unit,
              reason: 'checked against the report',
            });
      expect(decided.status, `${v.field}: ${decided.text}`).toBe(200);
    }
    const allEdited = await command(f, 'ops.one', other!.id, { command: 'approve' });
    expect(allEdited.status, allEdited.text).toBe(200);
    expect(
      state.promotedQuarters.get(quarterKey(other!.investmentId ?? '', latestQuarter))?.source,
    ).toEqual({ documentId: other!.documentId, runId: other!.id, page: null, locator: null });
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('refuses to revive a superseded quarter, as the promotion does (422)', async () => {
    const report = latestReports.find(
      (d) =>
        d.truth.investmentId !== walledId &&
        (book.quarters[d.truth.investmentId ?? ''] ?? []).some(
          (q) => q.periodEnd === latestQuarter,
        ),
    );
    expect(report).toBeDefined();
    const investmentId = report?.truth.investmentId ?? '';
    const { f, state } = setup({
      fixtures: generatedWorld(book, walledId, [
        { investmentId, periodEnd: latestQuarter, status: 'record_status.superseded' },
      ]),
    });
    await prepare(f);
    const perf = investmentPerformance.parse(
      (await send(f, 'ops.one', 'GET', `/api/v1/investments/${investmentId}/performance`)).json,
    );
    expect(perf.quarters.find((q) => q.periodEnd === latestQuarter)?.status).toBe(
      'record_status.superseded',
    );
    const run = await runOver(f, report?.fileName ?? '');
    await command(f, 'ops.one', run.id, { command: 'acceptClean' });
    const refused = await command(f, 'ops.one', run.id, { command: 'approve' });
    expect(refused.status).toBe(422);
    expect(problemOf(refused)).toEqual({
      code: 'workflow-precondition',
      detail: 'extraction: the quarter on record is superseded, which a promotion never revives',
    });
    expect(state.promotedQuarters.size).toBe(0);
    expect((await detail(f, 'ops.one', run.id)).run.approvedBy).toBeNull();
    expect(state.audit.some((e) => e.action === 'extraction_run.approve')).toBe(false);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('stops the runs of a batch as soon as the switch is turned off, with no model call for the rest (AI-6)', async () => {
    const flags = new SwitchOffAfter();
    const state = createPreviewState();
    state.flags = flags;
    const { f } = setup({ state });
    await prepare(f);
    // The batch's own check and the first run's attempt read the switch on; from the second run
    // on it reads off, as an admin turning it off part way would make it.
    flags.remaining = 2;
    const batch = await batchLatest(f);
    expect(batch.state).toBe('failed');
    expect(batch.errorCode).toBe('runs_failed');
    const member = extractionBatchPage.parse((await send(f, 'deal.three', 'GET', BATCH_LIST)).json)
      .items[0];
    expect(member?.runs).toEqual({
      total: latestReports.length,
      queued: 0,
      running: 0,
      succeeded: 1,
      failed: latestReports.length - 1,
      needsRetry: 0,
    });
    expect(member?.tokensOut).toBe(64);
    const stopped = await runs(f, 'deal.three', '&state=Failed');
    expect(stopped).toHaveLength(latestReports.length - 1);
    for (const run of stopped) {
      expect(run.errorCode).toBe(KILL_SWITCH_CODE);
      expect(run.errorKind).toBeNull();
      expect(run.tokensIn).toBeNull();
      expect(run.costUsd).toBeNull();
      expect(run.modelId).toBeNull();
      expect(run.counts.values).toBe(0);
      expect(
        [...state.exceptions.values()].filter((x) => x.entityId === run.id).map((x) => x.ruleId),
      ).toEqual(['EXT-RUN-01']);
    }
    expect(state.audit.filter((e) => e.action === 'extraction_run.succeed')).toHaveLength(1);
    expect(state.audit.filter((e) => e.action === 'extraction_run.fail')).toHaveLength(
      latestReports.length - 1,
    );
    // A hand retry while the switch is off is refused before anything is queued.
    const retried = await command(f, 'deal.three', stopped[0]?.id ?? '', { command: 'retry' });
    expect(problemOf(retried).code).toBe('kill-switch');
    expect(state.runs.size).toBe(latestReports.length);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('reserves a run budget for every run still Running against the day budget, so runs driven together cannot overshoot it (budget note)', async () => {
    const settings = extractionSettings();
    const today = '2025-07-01';
    // The rule: the other runs' recorded tokens plus a whole run budget per run still Running;
    // yesterday's runs, a run not started and the run itself do not count.
    const me = runFixture(5, { tokensIn: 9, tokensOut: 9 });
    expect(
      dayTokensOf(
        [
          runFixture(1, { state: 'Succeeded', tokensIn: 1000, tokensOut: 64 }),
          runFixture(2),
          runFixture(3, {
            state: 'Succeeded',
            tokensIn: 500,
            tokensOut: 64,
            startedAt: '2025-06-30T23:59:59.000Z',
          }),
          runFixture(4, { state: 'Queued', startedAt: null }),
          me,
        ],
        me.id,
        today,
        settings,
      ),
    ).toBe(1064 + settings.runTokenBudget);
    // Enough runs still Running to reserve the whole day budget: the next run fails before any
    // model call, with nothing used and its data exception.
    const state = createPreviewState();
    const running = Math.ceil((settings.dayTokenBudget + 1) / settings.runTokenBudget);
    for (let n = 1; n <= running; n += 1) {
      const held = runFixture(n);
      state.runs.set(held.id, held);
    }
    const { f } = setup({ state });
    await prepare(f);
    const report = latestReports.find((d) => d.truth.investmentId !== walledId)!;
    const run = await runOver(f, report.fileName);
    expect(run.state).toBe('Failed');
    expect(run.errorCode).toBe('day_budget');
    expect(run.errorKind).toBeNull();
    expect(run.tokensIn).toBeNull();
    expect(run.tokensOut).toBeNull();
    expect(run.costUsd).toBeNull();
    expect(run.counts.values).toBe(0);
    expect(state.audit.some((e) => e.action === 'extraction_run.succeed')).toBe(false);
    expect(
      [...state.exceptions.values()].filter((x) => x.entityId === run.id).map((x) => x.actual),
    ).toEqual(['the run failed (day_budget)']);
    expect(window.__pbPreviewMisses).toEqual([]);
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
    const { f, state } = setup({ samples: serveSamples(files) });
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
