import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, daysBetween, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  dataExceptionPage,
  documentDetail,
  documentIndexResult,
  documentPage,
  documentPages,
  expectedDocumentGenerateResult,
  expectedDocumentPage,
  problemDetails,
} from '@pb/contracts';
import type { DocumentSummary } from '@pb/contracts';
import {
  QUARTERLY_FIELDS,
  UNTAGGED_FILE_NAME,
  generateDataset,
  generateDocuments,
  previewBook,
} from '@pb/synthetic';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { USERS, generatedWorld, problemOf, send, serveSamples } from '../test-fixtures.js';
import { documentSettings, heldOn, indexOrder } from './documents.js';

/**
 * The simulated document hub over the real generator: the small synthetic profile (seed 42) gives
 * the book, the bundled PDFs and what each one carries (the truth sidecars and the set's
 * expectations), so every count here comes from tools/synthetic rather than a hand count. The
 * mock users of the test world decide who may open which investment: wall members see the walled
 * deal, everyone else gets the recorded 404.
 */
const dataset = generateDataset({ profile: 'small', seed: 42 });
const set = generateDocuments(dataset);
// Through JSON, as the build writes it and the shim reads it.
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset, { documents: set }))));
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';
const walled = book.investments.find((i) => i.id === walledId);
const expectations = set.expectations;
const latestQuarter = latestQuarterEndOnOrBefore(book.asOf);
const settings = documentSettings();

const INDEX = '/api/v1/documents/index';
const HUB = '/api/v1/documents?limit=200';
const QUEUE = '/api/v1/documents/review-queue?limit=200';
const EXPECTED = '/api/v1/expected-documents?limit=200';
const GENERATE = '/api/v1/expected-documents/generate';
const detailPath = (id: string): string => `/api/v1/documents/${id}`;
const pagesPath = (id: string): string => `/api/v1/documents/${id}/pages`;
const commandsPath = (id: string): string => `/api/v1/documents/${id}/commands`;

const fixtures = generatedWorld(book, walledId);
/** The static assets beside the page: the bundled PDFs under their store names. */
const assets = serveSamples(new Map(set.documents.map((d) => [d.fileName, d.bytes])));

let ids = 0;
let ticks = 0;
const env = {
  newId: (): string => `60000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  // A clock that moves a second per call, so the index order is the newest-first order.
  now: (): string => new Date(Date.UTC(2025, 6, 1, 9, 0, 0) + ++ticks * 1000).toISOString(),
};

function setup(options: { book?: boolean; samples?: typeof fetch } = {}): {
  f: typeof fetch;
  state: PreviewState;
} {
  const state = createPreviewState();
  const f = createPreviewFetch(fixtures, options.samples ?? assets, {
    env,
    state,
    ...(options.book === false ? {} : { book }),
  });
  return { f, state };
}

const CLASSIFIER = '/api/v1/flags/ai.classifier';
const EXCEPTIONS = '/api/v1/data-exceptions?limit=200';

/** The exceptions the credential may see, by the document they are about. */
async function exceptionsAbout(f: typeof fetch, who: string, documentId: string) {
  const answer = await send(f, who, 'GET', EXCEPTIONS);
  expect(answer.status, answer.text).toBe(200);
  return dataExceptionPage.parse(answer.json).items.filter((x) => x.entityId === documentId);
}

async function index(f: typeof fetch, who = 'ops.one') {
  const answer = await send(f, who, 'POST', INDEX);
  expect(answer.status, answer.text).toBe(200);
  expect(answer.headers.get('x-pb-simulated')).toBe('true');
  return documentIndexResult.parse(answer.json);
}

async function hub(f: typeof fetch, who: string, query = ''): Promise<DocumentSummary[]> {
  const answer = await send(f, who, 'GET', `${HUB}${query}`);
  expect(answer.status, answer.text).toBe(200);
  return documentPage.parse(answer.json).items;
}

const truthOf = (fileName: string) => set.documents.find((d) => d.fileName === fileName)?.truth;
const [duplicateOriginal = '', duplicateCopy = ''] = expectations.scenarioFiles.duplicate_doc;

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('the simulated document index (docs/04 M3) over the bundled set and the book', () => {
  it('has a walled deal, a duplicate pair, an untagged scan and an absent report to work with', () => {
    expect(walled).toBeDefined();
    expect(expectations.walledFiles.length).toBeGreaterThan(0);
    expect(duplicateOriginal).not.toBe('');
    expect(duplicateCopy).toMatch(/ \(1\)\.pdf$/);
    expect(expectations.scenarioFiles.untagged_doc).toEqual([UNTAGGED_FILE_NAME]);
    expect(expectations.lateFinancials).not.toBeNull();
    expect(book.documents).toHaveLength(expectations.total);
  });

  it('takes the inbox in a locale-free order where a plainly named item precedes its renamed copy', () => {
    const ordered = indexOrder(book.documents).map((d) => d.fileName);
    expect(ordered.indexOf(duplicateOriginal)).toBe(ordered.indexOf(duplicateCopy) - 1);
    expect(
      indexOrder([{ fileName: 'b.pdf' }, { fileName: 'a (1).pdf' }, { fileName: 'a.pdf' }]),
    ).toEqual([{ fileName: 'a.pdf' }, { fileName: 'a (1).pdf' }, { fileName: 'b.pdf' }]);
  });

  it('indexes every item once, marks the copy a duplicate, and changes nothing on a second scan', async () => {
    const { f, state } = setup();
    expect((await send(f, 'viewer.one', 'POST', INDEX)).status).toBe(403);
    expect((await send(f, 'deal.one', 'POST', INDEX)).status).toBe(403);
    const first = await index(f);
    expect(first).toEqual({ indexed: expectations.total - 1, duplicates: 1, unchanged: 0 });
    expect(state.documents.size).toBe(expectations.total);
    const again = await index(f);
    expect(again).toEqual({ indexed: 0, duplicates: 0, unchanged: expectations.total });
    expect(state.documents.size).toBe(expectations.total);
    // One activity entry per document written, then the counts.
    const actions = state.audit.map((e) => e.action);
    expect(actions.filter((a) => a === 'document.index')).toHaveLength(expectations.total);
    expect(actions.filter((a) => a === 'documents.index')).toHaveLength(2);
    expect(state.audit.find((e) => e.action === 'documents.index')?.details).toEqual(first);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('classifies every titled document from its own text with the links the book gives it', async () => {
    const { f } = setup();
    await index(f);
    // deal.three is on the wall and sees the whole set.
    const all = await hub(f, 'deal.three');
    expect(all).toHaveLength(expectations.total);
    for (const doc of all) {
      const truth = truthOf(doc.fileName);
      expect(truth, doc.fileName).toBeDefined();
      expect(doc.contentHash).toBe(truth?.contentHash);
      expect(doc.folder).toBe('inbox');
      expect(doc.sizeBytes).toBeGreaterThan(0);
      expect(doc.pageCount).toBe(truth?.pageCount);
      expect(doc.receivedAt.startsWith(book.asOf)).toBe(true);
      expect(doc.latestRun).toBeNull();
      if (doc.fileName === UNTAGGED_FILE_NAME) {
        expect(doc.reviewStatus).toBe('NeedsReview');
        expect(doc.docType).toBeNull();
        expect(doc.classificationConfidence).toBe('0.3');
        expect(doc.classifierEvidence.keywords).toEqual([]);
        expect(doc.classifierEvidence.candidates.map((c) => c.reason)).toContain(
          'classifier suggestion: doc_type.other',
        );
        expect(doc.title).toBe('scan_0042');
        continue;
      }
      if (doc.fileName === duplicateCopy) {
        expect(doc.reviewStatus).toBe('Duplicate');
        expect(doc.docType).toBeNull();
        expect(doc.duplicateOfId).toBe(all.find((d) => d.fileName === duplicateOriginal)?.id);
        expect(doc.investmentId).toBe(truth?.investmentId);
        expect(doc.periodEnd).toBe(truth?.periodEnd);
        continue;
      }
      expect(doc.reviewStatus, doc.fileName).toBe('Classified');
      expect(doc.docType).toBe(truth?.docType);
      expect(doc.classificationConfidence).toBe('0.97');
      expect(doc.classifierEvidence.keywords.length).toBeGreaterThan(0);
      expect(doc.investmentId).toBe(truth?.investmentId);
      expect(doc.investmentNumber).toBe(truth?.investmentNumber);
      expect(doc.companyName).toBe(truth?.companyName);
      expect(doc.sponsorFundId).toBe(truth?.sponsorFundId);
      expect(doc.sponsorFundName).toBe(truth?.sponsorFundName);
      expect(doc.sponsorId).toBe(truth?.sponsorId);
      expect(doc.periodEnd).toBe(truth?.periodEnd);
      expect(doc.classifiedBy).toBeNull();
      expect(doc.classifiedAt).not.toBeNull();
      expect(doc.title.length).toBeGreaterThan(0);
    }
    // The walled investment's documents carry its id; nothing else does.
    expect(
      all
        .filter((d) => d.investmentId === walledId)
        .map((d) => d.fileName)
        .sort(),
    ).toEqual([...expectations.walledFiles].sort());
    for (const doc of all)
      documentDetail.parse((await send(f, 'deal.three', 'GET', detailPath(doc.id))).json);
  });

  it('hides the walled documents from everyone outside the wall: the list, the search, the detail, the pages', async () => {
    const { f } = setup();
    await index(f);
    const outside = await hub(f, 'ops.one');
    expect(outside).toHaveLength(expectations.total - expectations.walledFiles.length);
    expect(outside.some((d) => d.investmentId === walledId)).toBe(false);
    const text = (await send(f, 'ops.one', 'GET', HUB)).text;
    expect(text).not.toContain(walled?.companyName ?? '');
    expect(text).not.toContain(walled?.investmentNumber ?? '');
    // The walled company's name finds nothing outside the wall and its files inside it (M3 AC).
    const q = `&q=${encodeURIComponent(walled?.companyName ?? '')}`;
    expect(await hub(f, 'deal.one', q)).toEqual([]);
    expect(await hub(f, 'viewer.one', q)).toEqual([]);
    const found = await hub(f, 'deal.three', q);
    expect(found.map((d) => d.fileName).sort()).toEqual([...expectations.walledFiles].sort());
    const walledDoc = found[0];
    expect((await send(f, 'ops.one', 'GET', detailPath(walledDoc?.id ?? ''))).status).toBe(404);
    expect((await send(f, 'ops.one', 'GET', pagesPath(walledDoc?.id ?? ''))).status).toBe(404);
    expect((await send(f, 'head.one', 'GET', detailPath(walledDoc?.id ?? ''))).status).toBe(200);
    expect((await send(f, 'ops.one', 'GET', detailPath('not-a-uuid'))).status).toBe(404);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('filters by type, status, period, investment and fund, searches whole words, and pages on a cursor', async () => {
    const { f } = setup();
    await index(f);
    const all = await hub(f, 'deal.three');
    const byType = (code: string) => all.filter((d) => d.docType === code);
    expect(byType('doc_type.capital_call')).toHaveLength(
      expectations.byDocType['doc_type.capital_call'] ?? 0,
    );
    expect(await hub(f, 'deal.three', '&docType=doc_type.capital_call')).toEqual(
      byType('doc_type.capital_call'),
    );
    const queue = await hub(f, 'deal.three', '&reviewStatus=NeedsReview');
    expect(queue.map((d) => d.fileName)).toEqual([UNTAGGED_FILE_NAME]);
    const latest = await hub(f, 'deal.three', `&periodEnd=${latestQuarter}`);
    expect(latest.length).toBeGreaterThan(0);
    expect(latest.every((d) => d.periodEnd === latestQuarter)).toBe(true);
    const inv = all.find((d) => d.investmentId !== null && d.investmentId !== walledId);
    const ofInvestment = await hub(f, 'ops.one', `&investmentId=${inv?.investmentId ?? ''}`);
    expect(ofInvestment.length).toBeGreaterThan(0);
    expect(ofInvestment.every((d) => d.investmentId === inv?.investmentId)).toBe(true);
    const ofFund = await hub(f, 'deal.three', `&sponsorFundId=${inv?.sponsorFundId ?? ''}`);
    expect(ofFund.every((d) => d.sponsorFundId === inv?.sponsorFundId)).toBe(true);
    // A search matches whole words of the title, the file name and the excerpt, every word required.
    expect((await hub(f, 'deal.three', '&q=Quarterly%20Report')).length).toBe(
      all.filter((d) => d.title.startsWith('Quarterly Report')).length,
    );
    expect(await hub(f, 'deal.three', '&q=Quarterl')).toEqual([]);
    // Newest first, then a cursor to the rest.
    const page1 = await send(f, 'deal.three', 'GET', '/api/v1/documents?limit=10');
    const first = documentPage.parse(page1.json);
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).not.toBeNull();
    const seen = [...first.items];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = documentPage.parse(
        (await send(f, 'deal.three', 'GET', `/api/v1/documents?limit=10&cursor=${cursor}`)).json,
      );
      seen.push(...next.items);
      cursor = next.nextCursor;
    }
    expect(seen.map((d) => d.id)).toEqual(all.map((d) => d.id));
    for (let i = 1; i < seen.length; i++)
      expect(seen[i - 1]!.indexedAt >= seen[i]!.indexedAt).toBe(true);
    expect(
      (await send(f, 'deal.three', 'GET', '/api/v1/documents?limit=10&cursor=junk')).status,
    ).toBe(400);
    expect((await send(f, 'deal.three', 'GET', '/api/v1/documents?limit=0')).status).toBe(400);
  });

  it('serves the review queue, the detail with its duplicates, and the pages read from the PDF', async () => {
    const { f } = setup();
    await index(f);
    const queue = documentPage.parse((await send(f, 'viewer.one', 'GET', QUEUE)).json);
    expect(queue.items.map((d) => d.fileName)).toEqual([UNTAGGED_FILE_NAME]);
    expect(queue.nextCursor).toBeNull();
    const all = await hub(f, 'deal.three');
    const original = all.find((d) => d.fileName === duplicateOriginal);
    const detail = documentDetail.parse(
      (await send(f, 'ops.one', 'GET', detailPath(original?.id ?? ''))).json,
    );
    expect(detail.duplicates.map((d) => d.fileName)).toEqual([duplicateCopy]);
    expect(detail.duplicates[0]?.reviewStatus).toBe('Duplicate');
    const copy = documentDetail.parse(
      (await send(f, 'ops.one', 'GET', detailPath(detail.duplicates[0]?.id ?? ''))).json,
    );
    expect(copy.duplicateOfId).toBe(original?.id);
    expect(copy.duplicates).toEqual([]);
    const truth = truthOf(duplicateOriginal);
    for (const id of [original?.id ?? '', copy.id]) {
      const pages = documentPages.parse((await send(f, 'viewer.one', 'GET', pagesPath(id))).json);
      expect(pages.documentId).toBe(id);
      expect(pages.pageCount).toBe(truth?.pageCount);
      expect(pages.pages.map((p) => p.number)).toEqual(
        Array.from({ length: truth?.pageCount ?? 0 }, (_, i) => i + 1),
      );
      // The truth's quotes are lines of the pages they cite.
      for (const key of QUARTERLY_FIELDS) {
        const field = truth?.fields[key];
        if (field?.quote === null || field?.page === null || field === undefined) continue;
        expect(pages.pages[field.page - 1]?.lines, `${key} on page ${field.page}`).toContain(
          field.quote,
        );
      }
    }
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('classifies the scan by hand through the table for the roles the contract names, with checked links', async () => {
    const { f, state } = setup();
    await index(f);
    const scan = (await hub(f, 'ops.one', '&reviewStatus=NeedsReview'))[0];
    const truth = truthOf(UNTAGGED_FILE_NAME);
    expect(scan).toBeDefined();
    expect(truth?.investmentId).not.toBeNull();
    const classify = (who: string, body: unknown) =>
      send(f, who, 'POST', commandsPath(scan?.id ?? ''), body);
    const valid = {
      command: 'classify',
      docType: 'doc_type.quarterly_financials',
      investmentId: truth?.investmentId,
      periodEnd: truth?.periodEnd,
      reason: 'The financial summary names the company and the quarter',
    };
    expect((await classify('viewer.one', valid)).status).toBe(403);
    expect((await classify('head.one', valid)).status).toBe(403);
    // A Classified document is not NeedsReview: the table refuses (409).
    const classified = (await hub(f, 'ops.one', '&reviewStatus=Classified'))[0];
    const settled = await send(f, 'ops.one', 'POST', commandsPath(classified?.id ?? ''), valid);
    expect(settled.status).toBe(409);
    expect(problemOf(settled).code).toBe('workflow-transition');
    // The type and the links are checked under the caller's own view.
    const badType = await classify('ops.one', { ...valid, docType: 'doc_type.unknown' });
    expect(badType.status).toBe(400);
    expect(problemDetails.parse(badType.json).errors?.map((e) => e.path)).toEqual(['docType']);
    const hidden = await classify('ops.one', { ...valid, investmentId: walledId });
    expect(hidden.status).toBe(400);
    expect(problemDetails.parse(hidden.json).errors?.map((e) => e.path)).toEqual(['investmentId']);
    const badFund = await classify('ops.one', { ...valid, sponsorFundId: env.newId() });
    expect(problemDetails.parse(badFund.json).errors?.map((e) => e.path)).toEqual([
      'sponsorFundId',
    ]);
    expect((await classify('ops.one', { command: 'classify' })).status).toBe(400);
    const done = await classify('ops.one', valid);
    expect(done.status, done.text).toBe(200);
    const after = documentDetail.parse(done.json);
    expect(after.reviewStatus).toBe('Classified');
    expect(after.docType).toBe('doc_type.quarterly_financials');
    expect(after.investmentId).toBe(truth?.investmentId);
    expect(after.investmentNumber).toBe(truth?.investmentNumber);
    expect(after.companyName).toBe(truth?.companyName);
    expect(after.sponsorFundId).toBe(
      book.investments.find((i) => i.id === truth?.investmentId)?.sponsorFundId,
    );
    expect(after.periodEnd).toBe(truth?.periodEnd);
    expect(after.classifiedBy).toBe(USERS.ops.displayName);
    expect(after.classifiedAt).not.toBeNull();
    expect(await hub(f, 'ops.one', '&reviewStatus=NeedsReview')).toEqual([]);
    const event = state.audit.find((e) => e.action === 'document.classify');
    expect(event?.from).toBe('NeedsReview');
    expect(event?.to).toBe('Classified');
    expect(event?.reason).toBe(valid.reason);
    // Once classified, a second command is refused from the terminal state.
    expect((await classify('deal.one', valid)).status).toBe(409);
  });

  it('generates the expected documents of a quarter from the book, matches the indexed reports and judges them on the as-of day', async () => {
    const { f, state } = setup();
    expect((await send(f, 'deal.one', 'POST', GENERATE, { periodEnd: latestQuarter })).status).toBe(
      403,
    );
    expect((await send(f, 'ops.one', 'POST', GENERATE, { periodEnd: '2025-06-15' })).status).toBe(
      400,
    );
    const generated = await send(f, 'ops.one', 'POST', GENERATE, { periodEnd: latestQuarter });
    expect(generated.status, generated.text).toBe(201);
    const result = expectedDocumentGenerateResult.parse(generated.json);
    const reporting = book.investments.filter(
      (i) =>
        heldOn(i, latestQuarter) &&
        book.expectedDocumentDefaults.reportingDealTypes.includes(i.dealType),
    );
    const funds = book.expectedDocumentDefaults.fundCommitments.filter(
      (c) => c.commitmentDate <= latestQuarter,
    );
    expect(result).toEqual({
      periodEnd: latestQuarter,
      created: reporting.length + funds.length,
      existing: 0,
    });
    expect(reporting.length).toBeGreaterThan(0);
    expect(funds.length).toBeGreaterThan(0);
    const again = expectedDocumentGenerateResult.parse(
      (await send(f, 'ops.one', 'POST', GENERATE, { periodEnd: latestQuarter })).json,
    );
    expect(again).toEqual({ periodEnd: latestQuarter, created: 0, existing: result.created });
    expect(state.audit.filter((e) => e.action === 'expected_documents.generate')).toHaveLength(2);

    // Before any index: every row is expected, due 45 days after the quarter end, not yet due.
    const dueDate = addDays(latestQuarter, settings.expectedDueDaysAfterQuarterEnd);
    const before = expectedDocumentPage.parse((await send(f, 'ops.one', 'GET', EXPECTED)).json);
    expect(before.items).toHaveLength(result.created - 1);
    expect(before.items.some((r) => r.investmentId === walledId)).toBe(false);
    expect(before.items.every((r) => r.status === 'expected' && r.dueDate === dueDate)).toBe(true);
    expect(before.items.every((r) => r.ageDays === daysBetween(dueDate, book.asOf))).toBe(true);
    for (let i = 1; i < before.items.length; i++)
      expect(before.items[i - 1]!.dueDate >= before.items[i]!.dueDate).toBe(true);
    const member = expectedDocumentPage.parse((await send(f, 'deal.three', 'GET', EXPECTED)).json);
    expect(member.items).toHaveLength(result.created);

    // After the index the reports and statements are matched, the absent report stays expected.
    await index(f);
    const after = expectedDocumentPage.parse((await send(f, 'deal.three', 'GET', EXPECTED)).json);
    const late = expectations.lateFinancials;
    const lateRow = after.items.find((r) => r.investmentId === late?.investmentId);
    expect(lateRow?.status).toBe('expected');
    expect(lateRow?.receivedDocumentId).toBeNull();
    expect(lateRow?.investmentNumber).toBe(late?.investmentNumber);
    expect(lateRow?.companyName).toBe(late?.companyName);
    const received = after.items.filter((r) => r.status === 'received');
    expect(received.length).toBeGreaterThan(0);
    const docs = await hub(f, 'deal.three');
    for (const row of received) {
      const doc = docs.find((d) => d.id === row.receivedDocumentId);
      expect(doc?.docType).toBe(row.docType);
      expect(doc?.periodEnd).toBe(row.periodEnd);
      if (row.investmentId !== null) expect(doc?.investmentId).toBe(row.investmentId);
      else expect(doc?.sponsorFundId).toBe(row.sponsorFundId);
      // Received on the record's as-of day, 45 days before the due date.
      expect(row.ageDays).toBe(daysBetween(dueDate, book.asOf));
    }
    expect(received.filter((r) => r.sponsorFundId !== null)).toHaveLength(funds.length);
    const statusOf = async (asOf: string) =>
      expectedDocumentPage
        .parse((await send(f, 'ops.one', 'GET', `${EXPECTED}&asOf=${asOf}`)).json)
        .items.find((r) => r.investmentId === late?.investmentId)?.status;
    expect(await statusOf(addDays(dueDate, settings.lateAfterDays))).toBe('expected');
    expect(await statusOf(addDays(dueDate, settings.lateAfterDays + 1))).toBe('late');
    expect(await statusOf(addDays(dueDate, settings.missingAfterDays + 1))).toBe('missing');
    const missing = expectedDocumentPage.parse(
      (
        await send(
          f,
          'ops.one',
          'GET',
          `${EXPECTED}&status=missing&asOf=${addDays(dueDate, settings.missingAfterDays + 1)}`,
        )
      ).json,
    );
    expect(missing.items.every((r) => r.status === 'missing')).toBe(true);
    expect(missing.items.some((r) => r.investmentId === late?.investmentId)).toBe(true);
    expect(
      expectedDocumentPage.parse(
        (await send(f, 'ops.one', 'GET', `${EXPECTED}&periodEnd=2024-03-31`)).json,
      ).items,
    ).toEqual([]);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('matches a document classified after its row existed, by hand too', async () => {
    // The absent report's row stays empty after the index; classifying the scan as that report
    // by hand fills it, as the API's classify command matches the expected row.
    const { f } = setup();
    await index(f);
    const scan = (await hub(f, 'ops.one', '&reviewStatus=NeedsReview'))[0];
    const late = expectations.lateFinancials;
    await send(f, 'ops.one', 'POST', GENERATE, { periodEnd: late?.periodEnd ?? '' });
    const rowOf = async () =>
      expectedDocumentPage
        .parse(
          (
            await send(
              f,
              'deal.three',
              'GET',
              `${EXPECTED}&investmentId=${late?.investmentId ?? ''}`,
            )
          ).json,
        )
        .items.find((r) => r.periodEnd === late?.periodEnd);
    expect((await rowOf())?.status).toBe('expected');
    const done = await send(f, 'deal.one', 'POST', commandsPath(scan?.id ?? ''), {
      command: 'classify',
      docType: 'doc_type.quarterly_financials',
      investmentId: late?.investmentId,
      periodEnd: late?.periodEnd,
    });
    expect(done.status, done.text).toBe(200);
    const rowAfter = await rowOf();
    expect(rowAfter?.status).toBe('received');
    expect(rowAfter?.receivedDocumentId).toBe(scan?.id);
  });

  it('with the classifier off, flags every item for review with the links its file name gives it, inside the wall (W1, WF-5)', async () => {
    const { f, state } = setup();
    const off = await send(f, 'admin.one', 'PATCH', CLASSIFIER, {
      enabled: false,
      reason: 'the switch off for the test',
    });
    expect(off.status, off.text).toBe(200);
    const first = await index(f);
    expect(first).toEqual({ indexed: expectations.total - 1, duplicates: 1, unchanged: 0 });
    const all = await hub(f, 'deal.three');
    expect(all).toHaveLength(expectations.total);
    // Nothing stays in Received: every readable item queues for a person, linked from its name.
    expect(all.some((d) => d.reviewStatus === 'Received')).toBe(false);
    for (const doc of all) {
      const truth = truthOf(doc.fileName);
      expect(truth, doc.fileName).toBeDefined();
      expect(doc.docType).toBeNull();
      expect(doc.classificationConfidence).toBeNull();
      expect(doc.classifierEvidence.keywords).toEqual([]);
      expect(doc.classifiedAt).toBeNull();
      if (doc.fileName === duplicateCopy) {
        expect(doc.reviewStatus).toBe('Duplicate');
        expect(doc.investmentId).toBe(truth?.investmentId);
        continue;
      }
      expect(doc.reviewStatus, doc.fileName).toBe('NeedsReview');
      expect(doc.periodEnd).toBeNull();
      if (doc.fileName === UNTAGGED_FILE_NAME) {
        // A generic file name names no position: unlinked, for a person to place.
        expect(doc.investmentId).toBeNull();
        expect(doc.sponsorFundId).toBeNull();
        continue;
      }
      expect(doc.investmentId, doc.fileName).toBe(truth?.investmentId);
      expect(doc.sponsorFundId, doc.fileName).toBe(truth?.sponsorFundId);
      expect(doc.sponsorId, doc.fileName).toBe(truth?.sponsorId);
    }
    expect(
      all
        .filter((d) => d.investmentId === walledId)
        .map((d) => d.fileName)
        .sort(),
    ).toEqual([...expectations.walledFiles].sort());
    // The wall holds from the first write: the list, the search and the review queue.
    const outside = await hub(f, 'ops.one');
    expect(outside).toHaveLength(expectations.total - expectations.walledFiles.length);
    expect((await send(f, 'ops.one', 'GET', HUB)).text).not.toContain(walled?.companyName ?? '');
    const q = `&q=${encodeURIComponent(walled?.companyName ?? '')}`;
    expect(await hub(f, 'deal.one', q)).toEqual([]);
    expect((await hub(f, 'deal.three', q)).map((d) => d.fileName).sort()).toEqual(
      [...expectations.walledFiles].sort(),
    );
    const queue = (who: string) =>
      send(f, who, 'GET', QUEUE).then((a) => documentPage.parse(a.json).items);
    expect(await queue('ops.one')).toHaveLength(
      expectations.total - expectations.walledFiles.length - 1,
    );
    expect(await queue('deal.three')).toHaveLength(expectations.total - 1);
    // Each item was flagged through the table, with the switch as the reason.
    const flagged = state.audit.filter(
      (e) => e.action === 'document.index' && e.to === 'NeedsReview',
    );
    expect(flagged).toHaveLength(expectations.total - 1);
    expect(flagged.every((e) => e.reason === 'classifier off' && e.from === 'Received')).toBe(true);
    // A person classifies from the queue: operations outside the wall, a member inside it.
    const open = (await queue('ops.one')).find((d) => d.fileName !== UNTAGGED_FILE_NAME);
    const classified = await send(f, 'ops.one', 'POST', commandsPath(open?.id ?? ''), {
      command: 'classify',
      docType: truthOf(open?.fileName ?? '')?.docType,
      periodEnd: truthOf(open?.fileName ?? '')?.periodEnd,
    });
    expect(classified.status, classified.text).toBe(200);
    expect(documentDetail.parse(classified.json).reviewStatus).toBe('Classified');
    expect(documentDetail.parse(classified.json).investmentId).toBe(open?.investmentId);
    const walledDoc = (await queue('deal.three')).find((d) => d.investmentId === walledId);
    const body = {
      command: 'classify',
      docType: truthOf(walledDoc?.fileName ?? '')?.docType,
      periodEnd: truthOf(walledDoc?.fileName ?? '')?.periodEnd,
    };
    expect((await send(f, 'ops.one', 'POST', commandsPath(walledDoc?.id ?? ''), body)).status).toBe(
      404,
    );
    const member = await send(f, 'deal.three', 'POST', commandsPath(walledDoc?.id ?? ''), body);
    expect(member.status, member.text).toBe(200);
    // A scan with the switch on again changes nothing.
    expect(
      (await send(f, 'admin.one', 'PATCH', CLASSIFIER, { enabled: true, reason: 'on again' }))
        .status,
    ).toBe(200);
    expect(await index(f)).toEqual({ indexed: 0, duplicates: 0, unchanged: expectations.total });
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('keeps a walled report the reader cannot read inside the wall: the links and the exception come from the file name (W1, W2)', async () => {
    const walledReport = expectations.walledFiles[0] ?? '';
    expect(walledReport).not.toBe('');
    const files = new Map<string, string | Uint8Array>(
      set.documents.map((d) => [d.fileName, d.bytes]),
    );
    files.set(walledReport, new TextEncoder().encode('not a PDF at all'));
    const { f, state } = setup({ samples: serveSamples(files) });
    await index(f);
    const truth = truthOf(walledReport);
    const inside = (await hub(f, 'deal.three')).find((d) => d.fileName === walledReport);
    expect(inside?.reviewStatus).toBe('NeedsReview');
    expect(inside?.investmentId).toBe(walledId);
    expect(inside?.sponsorFundId).toBe(truth?.sponsorFundId);
    expect(inside?.pageCount).toBeNull();
    expect(inside?.classifierEvidence.candidates.map((c) => c.reason)).toContain(
      'unreadable (not_pdf)',
    );
    const id = inside?.id ?? '';
    for (const who of ['ops.one', 'viewer.one', 'deal.one']) {
      expect(
        (await hub(f, who)).some((d) => d.id === id),
        who,
      ).toBe(false);
      expect(await hub(f, who, '&reviewStatus=NeedsReview')).not.toContainEqual(
        expect.objectContaining({ id }),
      );
      expect((await send(f, who, 'GET', detailPath(id))).status, who).toBe(404);
      expect((await send(f, who, 'GET', pagesPath(id))).status, who).toBe(404);
    }
    // The exception about the item follows the item's wall: the reviewers outside it (a viewer
    // may not list exceptions at all) never see it, the members do (W2).
    for (const who of ['ops.one', 'deal.one'])
      expect(await exceptionsAbout(f, who, id)).toEqual([]);
    expect((await send(f, 'deal.three', 'GET', detailPath(id))).status).toBe(200);
    const pages = await send(f, 'deal.three', 'GET', pagesPath(id));
    expect(pages.status).toBe(422);
    expect(problemOf(pages).code).toBe('unreadable-document');
    for (const who of ['deal.three', 'head.one']) {
      const exception = await exceptionsAbout(f, who, id);
      expect(
        exception.map((x) => x.ruleId),
        who,
      ).toEqual(['DOC-READ-01']);
      expect(exception[0]?.context.investmentId).toBe(walledId);
    }
    expect([...state.exceptions.values()].filter((x) => x.entityId === id)).toHaveLength(1);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('answers that the preview carries no book when it could not be loaded, and resets everything', async () => {
    const noBook = setup({ book: false });
    const refused = await send(noBook.f, 'ops.one', 'POST', INDEX);
    expect(refused.status).toBe(503);
    expect(problemOf(refused).code).toBe('unavailable');
    expect((await send(noBook.f, 'ops.one', 'GET', EXPECTED)).status).toBe(503);
    // Without a book the hub still answers the empty state.
    expect(documentPage.parse((await send(noBook.f, 'ops.one', 'GET', HUB)).json).items).toEqual(
      [],
    );

    const { f, state } = setup();
    await index(f);
    await send(f, 'ops.one', 'POST', GENERATE, { periodEnd: latestQuarter });
    expect(state.documents.size).toBeGreaterThan(0);
    expect(state.expectedDocuments.size).toBeGreaterThan(0);
    expect((await send(f, 'viewer.one', 'POST', '/api/v1/preview/reset')).status).toBe(200);
    expect(state.documents.size).toBe(0);
    expect(state.expectedDocuments.size).toBe(0);
    expect(state.audit).toEqual([]);
    expect(await hub(f, 'deal.three')).toEqual([]);
    expect(
      expectedDocumentPage.parse((await send(f, 'ops.one', 'GET', EXPECTED)).json).items,
    ).toEqual([]);
  });
});
