import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, addDays, daysBetween, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  documentDetail,
  documentIndexResult,
  documentPage,
  documentPages,
  expectedDocumentGenerateResult,
  expectedDocumentPage,
  problemDetails,
} from '@pb/contracts';
import type { DocumentDetail, DocumentSummary, ExpectedDocument } from '@pb/contracts';
import { writePdf } from '@pb/pdf';
import { UNTAGGED_FILE_NAME } from '@pb/synthetic';
import type { SyntheticDocument } from '@pb/synthetic';
import { QUARTERLY_REPORTING_DEAL_TYPES, dueDateFor } from '../documents/expected.js';
import { UNREADABLE_RULE } from '../documents/documents.service.js';
import { documentSettingsOf } from '../documents/settings.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const QF = 'doc_type.quarterly_financials';
const CAS = 'doc_type.capital_account_statement';
const BROKEN = 'broken.pdf';
const LATE_ARRIVAL = 'late-arrival.pdf';
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';

describe('document hub (M3, docs/18 section 6): index, classify, search under the wall, expected documents', () => {
  let h: Harness;
  let everything: DocumentSummary[];

  beforeAll(async () => {
    h = await startHarness();
    // A file the reader refuses sits in the inbox next to the synthetic set.
    writeFileSync(join(h.runtime.config.PB_DOCUMENT_ROOT, 'inbox', BROKEN), 'not a pdf at all');
  });
  afterAll(async () => {
    await h.close();
  });

  const set = () => h.documents;
  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const companyOf = (investmentId: string): string => {
    const inv = h.dataset.investments.find((i) => i.id === investmentId)!;
    return h.dataset.portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId)!.name;
  };
  const quarterEnd = (): string => latestQuarterEndOnOrBefore(h.dataset.asOf);
  const settings = () => documentSettingsOf(h.runtime.definitions);
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql, params))[0]!.n;
  const distinctHashes = (): number =>
    new Set(set().documents.map((d) => d.truth.contentHash)).size;
  /** The synthetic documents that are neither the duplicate copy nor the untagged scan. */
  const titled = (): SyntheticDocument[] =>
    set().documents.filter(
      (d) =>
        d.fileName !== UNTAGGED_FILE_NAME &&
        d.fileName !== set().expectations.scenarioFiles.duplicate_doc[1],
    );

  const get = (who: string, path: string, requestId = 'req-doc-get') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const list = async (who: string, query = ''): Promise<DocumentSummary[]> =>
    documentPage.parse((await get(who, `/api/v1/documents?limit=200${query}`).expect(200)).body)
      .items;
  const detail = async (who: string, id: string): Promise<DocumentDetail> =>
    documentDetail.parse((await get(who, `/api/v1/documents/${id}`).expect(200)).body);
  const index = (who: string, requestId = 'req-doc-index') =>
    h
      .http()
      .post('/api/v1/documents/index')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId);
  const command = (who: string, id: string, body: object, requestId = 'req-doc-command') =>
    h
      .http()
      .post(`/api/v1/documents/${id}/commands`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const generate = (who: string, periodEnd: string, requestId = 'req-doc-generate') =>
    h
      .http()
      .post('/api/v1/expected-documents/generate')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send({ periodEnd });
  const expected = async (who: string, query = ''): Promise<ExpectedDocument[]> =>
    expectedDocumentPage.parse(
      (await get(who, `/api/v1/expected-documents?limit=200${query}`).expect(200)).body,
    ).items;
  const byName = (items: readonly DocumentSummary[], fileName: string): DocumentSummary =>
    items.find((i) => i.fileName === fileName)!;
  const setFlag = (key: string, enabled: boolean) =>
    h
      .http()
      .patch(`/api/v1/flags/${key}`)
      .set('authorization', h.as('platform_admin'))
      .send({ enabled, reason: 'documents test' })
      .expect(200);

  it('guards the writes by role and the reads by sign-in', async () => {
    for (const who of ['viewer', 'deal_team', 'approver', 'auditor', 'platform_admin']) {
      const res = await index(who).expect(403);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}forbidden`);
      await generate(who, quarterEnd()).expect(403);
    }
    for (const who of ['viewer', 'approver', 'auditor'])
      await command(who, NO_SUCH_ID, { command: 'classify', docType: QF }).expect(403);
    await h.http().get('/api/v1/documents').expect(401);
    await h.http().get('/api/v1/documents/review-queue').expect(401);
    await h.http().get('/api/v1/expected-documents').expect(401);
    expect(await count('select count(*)::int as n from doc.document')).toBe(0);
  });

  it('indexes the inbox once: every distinct item, one duplicate, the unreadable file; a second scan changes nothing', async () => {
    const first = documentIndexResult.parse(
      (await index('operations', 'req-doc-index-1').expect(200)).body,
    );
    expect(first).toEqual({
      indexed: distinctHashes() + 1,
      duplicates: set().documents.length - distinctHashes(),
      unchanged: 0,
    });
    expect(first.duplicates).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'document.index' and request_id = 'req-doc-index-1'",
      ),
    ).toBe(first.indexed + first.duplicates);
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'documents.index' and request_id = 'req-doc-index-1'",
      ),
    ).toBe(1);
    const again = documentIndexResult.parse(
      (await index('operations', 'req-doc-index-2').expect(200)).body,
    );
    expect(again).toEqual({ indexed: 0, duplicates: 0, unchanged: set().documents.length + 1 });
    expect(await count('select count(*)::int as n from doc.document')).toBe(
      first.indexed + first.duplicates,
    );
  });

  it('classifies every titled document to its type, period and links as the truth records them', async () => {
    everything = await list('head.one');
    expect(everything.length).toBe(set().documents.length + 1);
    for (const [code, n] of Object.entries(set().expectations.byDocType)) {
      const classified = everything.filter(
        (d) => d.docType === code && d.reviewStatus === 'Classified',
      );
      // The duplicate copy and the untagged scan are counted as reports by the generator.
      expect(classified.length, code).toBe(code === QF ? n - 2 : n);
    }
    for (const doc of titled()) {
      const found = byName(everything, doc.fileName);
      expect(found.reviewStatus, doc.fileName).toBe('Classified');
      expect(found.docType).toBe(doc.truth.docType);
      expect(found.investmentId).toBe(doc.truth.investmentId);
      expect(found.investmentNumber).toBe(doc.truth.investmentNumber);
      expect(found.companyName).toBe(doc.truth.companyName);
      expect(found.sponsorFundId).toBe(doc.truth.sponsorFundId);
      expect(found.sponsorId).toBe(doc.truth.sponsorId);
      expect(found.periodEnd).toBe(doc.truth.periodEnd);
      expect(found.pageCount).toBe(doc.truth.pageCount);
      expect(found.contentHash).toBe(doc.truth.contentHash);
      expect(found.classifiedBy).toBeNull();
      expect(found.classifiedAt).toBe(h.runtime.adapters.clock.now());
      expect(
        D(found.classificationConfidence!).gte(
          D(doc.truth.expectedClassification.confidenceAtLeast),
        ),
      ).toBe(true);
      expect(found.classifierEvidence.keywords.length).toBeGreaterThan(0);
      expect(found.latestRun).toBeNull();
    }
  });

  it('links the duplicate pair: one Duplicate pointing at the original, listed on the original', async () => {
    const [a, b] = set().expectations.scenarioFiles.duplicate_doc as [string, string];
    const pair = [byName(everything, a), byName(everything, b)];
    const duplicate = pair.find((d) => d.reviewStatus === 'Duplicate')!;
    const original = pair.find((d) => d.reviewStatus === 'Classified')!;
    expect(duplicate.duplicateOfId).toBe(original.id);
    expect(duplicate.contentHash).toBe(original.contentHash);
    expect(duplicate.investmentId).toBe(original.investmentId);
    const opened = await detail('head.one', original.id);
    expect(opened.duplicates.map((d) => d.id)).toEqual([duplicate.id]);
    expect((await detail('head.one', duplicate.id)).duplicates).toEqual([]);
  });

  it('sends the untagged scan and the unreadable file to the review queue, with a data exception for the latter', async () => {
    const scan = byName(everything, UNTAGGED_FILE_NAME);
    expect(scan.reviewStatus).toBe('NeedsReview');
    expect(scan.docType).toBeNull();
    expect(scan.investmentId).toBeNull();
    expect(D(scan.classificationConfidence!).lt(D('0.85'))).toBe(true);
    expect(
      scan.classifierEvidence.candidates.some((c) => c.reason.startsWith('classifier suggestion')),
    ).toBe(true);
    const broken = byName(everything, BROKEN);
    expect(broken.reviewStatus).toBe('NeedsReview');
    expect(broken.pageCount).toBeNull();
    expect(broken.title).toBe('broken');
    const [evidence] = await h.runtime.db.query<{ classifier_evidence: Record<string, unknown> }>(
      'select classifier_evidence from doc.document where file_name = $1',
      [BROKEN],
    );
    expect(evidence!.classifier_evidence.reason).toBe('unreadable');
    expect(evidence!.classifier_evidence.code).toBe('not_pdf');
    const exceptions = await h.runtime.db.query<{
      rule_id: string;
      entity: string;
      entity_id: string;
      state: string;
    }>(
      "select rule_id, entity, entity_id, state from ops.data_exception where source = 'documents'",
    );
    expect(exceptions).toEqual([
      { rule_id: UNREADABLE_RULE, entity: 'doc.document', entity_id: broken.id, state: 'open' },
    ]);
    const queue = documentPage.parse(
      (await get('viewer', '/api/v1/documents/review-queue').expect(200)).body,
    );
    expect(queue.items.map((d) => d.fileName).sort()).toEqual([BROKEN, UNTAGGED_FILE_NAME].sort());
    const refused = await get('viewer', `/api/v1/documents/${broken.id}/pages`).expect(422);
    const problem = problemDetails.parse(refused.body);
    expect(problem.type).toBe(`${PROBLEM}unreadable-document`);
    expect(problem.detail).toContain('not_pdf');
  });

  it('hides the walled investment documents from a non-member (list, search, detail) and shows them to a wall member', async () => {
    const walled = set().expectations.walledFiles;
    expect(walled.length).toBeGreaterThan(0);
    const member = await list('deal.three', `&investmentId=${walledId()}`);
    expect(member.map((d) => d.fileName).sort()).toEqual([...walled].sort());
    expect(await list('deal.one', `&investmentId=${walledId()}`)).toEqual([]);
    const outsider = await list('deal.one');
    expect(outsider.length).toBe(everything.length - walled.length);
    expect(outsider.some((d) => walled.includes(d.fileName))).toBe(false);
    expect(JSON.stringify(outsider)).not.toContain(walledId());
    // Search (M3 AC): a company name finds its reports for a member and nothing for a non-member.
    const name = companyOf(walledId());
    const found = await list('deal.three', `&q=${encodeURIComponent(name)}`);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((d) => d.investmentId === walledId())).toBe(true);
    expect(await list('deal.one', `&q=${encodeURIComponent(name)}`)).toEqual([]);
    expect(await list('operations', `&q=${encodeURIComponent(name)}`)).toEqual([]);
    const id = member[0]!.id;
    await detail('deal.three', id);
    await get('deal.one', `/api/v1/documents/${id}`).expect(404);
    await get('deal.one', `/api/v1/documents/${id}/pages`).expect(404);
    await command('deal.one', id, { command: 'classify', docType: QF }).expect(404);
    expect(
      (await get('deal.one', `/api/v1/documents/review-queue`).expect(200)).body.items.length,
    ).toBe(2);
  });

  it('finds an open position by its company name for anyone, and answers 404 for an id that is not one', async () => {
    const report = titled().find(
      (d) => d.truth.docType === QF && d.truth.investmentId !== walledId(),
    )!;
    const found = await list('viewer', `&q=${encodeURIComponent(report.truth.companyName!)}`);
    expect(found.map((d) => d.fileName)).toContain(report.fileName);
    expect(found.every((d) => d.investmentId === report.truth.investmentId)).toBe(true);
    await get('viewer', '/api/v1/documents/not-a-uuid').expect(404);
    await get('viewer', `/api/v1/documents/${NO_SUCH_ID}`).expect(404);
    await get('viewer', `/api/v1/documents/${NO_SUCH_ID}/pages`).expect(404);
  });

  it('pages by (indexedAt, id) without a gap or a repeat', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = documentPage.parse(
        (
          await get(
            'head.one',
            `/api/v1/documents?limit=25${cursor === null ? '' : `&cursor=${cursor}`}`,
          ).expect(200)
        ).body,
      );
      seen.push(...page.items.map((d) => d.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen.length).toBe(everything.length);
    expect(new Set(seen).size).toBe(seen.length);
    await get('head.one', '/api/v1/documents?cursor=bm90LWEtY3Vyc29y').expect(400);
  });

  it('reads the pages of a report from the store: every recorded quote is on its page', async () => {
    const report = titled().find(
      (d) => d.truth.docType === QF && d.truth.investmentId !== walledId(),
    )!;
    const id = byName(everything, report.fileName).id;
    const pages = documentPages.parse(
      (await get('viewer', `/api/v1/documents/${id}/pages`, 'req-doc-pages-1').expect(200)).body,
    );
    expect(pages.documentId).toBe(id);
    expect(pages.pageCount).toBe(report.truth.pageCount);
    expect(pages.pages.map((p) => p.number)).toEqual(pages.pages.map((_, i) => i + 1));
    expect(pages.pages[0]!.lines.some((l) => l.includes('Quarterly Report'))).toBe(true);
    for (const [key, field] of Object.entries(report.truth.fields)) {
      if (field.quote === null || field.page === null) continue;
      expect(pages.pages[field.page - 1]!.lines, key).toContain(field.quote);
    }
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'document.pages.read' and request_id = 'req-doc-pages-1'",
      ),
    ).toBe(1);
  });

  it('lets operations classify the untagged scan from the queue, with links checked and an audit event', async () => {
    const scan = byName(everything, UNTAGGED_FILE_NAME);
    const report = titled().find(
      (d) => d.truth.docType === QF && d.truth.investmentId !== walledId(),
    )!;
    // Links are checked under the caller's own view: a hidden investment or an unknown type is a 400 naming the field.
    const hidden = await command('operations', scan.id, {
      command: 'classify',
      docType: QF,
      investmentId: walledId(),
    }).expect(400);
    expect(problemDetails.parse(hidden.body).errors?.map((e) => e.path)).toEqual(['investmentId']);
    const unknownType = await command('operations', scan.id, {
      command: 'classify',
      docType: 'doc_type.nope',
      sponsorFundId: NO_SUCH_ID,
    }).expect(400);
    expect(
      problemDetails
        .parse(unknownType.body)
        .errors?.map((e) => e.path)
        .sort(),
    ).toEqual(['docType', 'sponsorFundId']);
    const res = await command(
      'operations',
      scan.id,
      {
        command: 'classify',
        docType: QF,
        investmentId: report.truth.investmentId,
        periodEnd: report.truth.periodEnd,
        reason: 'read by hand: a scanned quarterly report',
      },
      'req-doc-classify-1',
    ).expect(200);
    const classified = documentDetail.parse(res.body);
    expect(classified.reviewStatus).toBe('Classified');
    expect(classified.docType).toBe(QF);
    expect(classified.investmentId).toBe(report.truth.investmentId);
    expect(classified.investmentNumber).toBe(report.truth.investmentNumber);
    expect(classified.sponsorFundId).toBe(report.truth.sponsorFundId);
    expect(classified.periodEnd).toBe(report.truth.periodEnd);
    expect(classified.classifiedBy).toBe(user('ops.one').displayName);
    expect(classified.classifiedAt).toBe(h.runtime.adapters.clock.now());
    const [event] = await h.runtime.db.query<{
      reason: string;
      details: Record<string, Record<string, unknown>>;
    }>(
      "select reason, details from audit.event where action = 'document.classify' and request_id = 'req-doc-classify-1'",
    );
    expect(event!.reason).toBe('read by hand: a scanned quarterly report');
    expect(event!.details.before!.reviewStatus).toBe('NeedsReview');
    expect(event!.details.after!.reviewStatus).toBe('Classified');
    expect(event!.details.after!.docType).toBe(QF);
    const queue = documentPage.parse(
      (await get('viewer', '/api/v1/documents/review-queue').expect(200)).body,
    );
    expect(queue.items.map((d) => d.fileName)).toEqual([BROKEN]);
    // Classified is terminal for the machine: a second classify is a forbidden transition.
    const again = await command('deal.one', scan.id, { command: 'classify', docType: QF }).expect(
      409,
    );
    expect(problemDetails.parse(again.body).type).toBe(`${PROBLEM}workflow-transition`);
    await command('operations', NO_SUCH_ID, { command: 'classify', docType: QF }).expect(404);
    const bad = await command('operations', scan.id, { command: 'reclassify' }).expect(400);
    expect(problemDetails.parse(bad.body).type).toBe(`${PROBLEM}validation`);
  });

  it('generates the expected documents of a quarter once, matched with the reports already classified', async () => {
    const periodEnd = quarterEnd();
    const investments = h.dataset.investments.filter(
      (i) =>
        QUARTERLY_REPORTING_DEAL_TYPES.includes(i.dealType) &&
        i.entryDate <= periodEnd &&
        (i.exitDate === null || i.exitDate > periodEnd),
    );
    const funds = new Set(
      h.dataset.commitments
        .filter((c) => c.commitmentDate <= periodEnd)
        .map((c) => c.sponsorFundId),
    );
    const first = expectedDocumentGenerateResult.parse(
      (await generate('operations', periodEnd, 'req-doc-generate-1').expect(201)).body,
    );
    expect(first).toEqual({ periodEnd, created: investments.length + funds.size, existing: 0 });
    const second = expectedDocumentGenerateResult.parse(
      (await generate('operations', periodEnd).expect(201)).body,
    );
    expect(second).toEqual({ periodEnd, created: 0, existing: first.created });
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'expected_documents.generate' and request_id = 'req-doc-generate-1'",
      ),
    ).toBe(1);
    await generate('operations', '2025-05-15').expect(400);

    const rows = await expected('head.one', `&periodEnd=${periodEnd}`);
    expect(rows.length).toBe(first.created);
    expect(rows.every((r) => r.dueDate === dueDateFor(periodEnd, settings()))).toBe(true);
    expect(rows.filter((r) => r.docType === QF).length).toBe(investments.length);
    expect(rows.filter((r) => r.docType === CAS).length).toBe(funds.size);
    // Every report of the quarter that was indexed and classified is matched to its row.
    const reports = titled().filter(
      (d) => d.truth.docType === QF && d.truth.periodEnd === periodEnd,
    );
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      const row = rows.find((r) => r.investmentId === report.truth.investmentId)!;
      const doc = byName(everything, report.fileName);
      expect(row.receivedDocumentId, report.fileName).toBe(doc.id);
      expect(row.status).toBe('received');
      expect(row.ageDays).toBe(daysBetween(row.dueDate, doc.receivedAt.slice(0, 10)));
    }
    const statements = titled().filter(
      (d) => d.truth.docType === CAS && d.truth.periodEnd === periodEnd,
    );
    for (const statement of statements) {
      const row = rows.find((r) => r.sponsorFundId === statement.truth.sponsorFundId)!;
      expect(row.receivedDocumentId).toBe(byName(everything, statement.fileName).id);
      expect(row.investmentNumber).toBeNull();
      expect(row.sponsorFundName).toBe(statement.truth.sponsorFundName);
    }
  });

  it('judges the late_financials investment missing, late or expected by the as-of day, and filters on the derived status', async () => {
    const periodEnd = quarterEnd();
    const late = set().expectations.lateFinancials!;
    const dueDate = dueDateFor(periodEnd, settings());
    const at = async (asOf: string): Promise<ExpectedDocument> =>
      (
        await expected(
          'head.one',
          `&periodEnd=${periodEnd}&investmentId=${late.investmentId}&asOf=${asOf}`,
        )
      )[0]!;
    const onTime = await at(dueDate);
    expect(onTime.receivedDocumentId).toBeNull();
    expect(onTime.companyName).toBe(late.companyName);
    expect(onTime.status).toBe('expected');
    expect(onTime.ageDays).toBe(0);
    expect((await at(addDays(dueDate, -10))).ageDays).toBe(-10);
    const grace = await at(addDays(dueDate, settings().lateAfterDays));
    expect(grace.status).toBe('expected');
    const lateRow = await at(addDays(dueDate, settings().lateAfterDays + 1));
    expect(lateRow.status).toBe('late');
    expect(lateRow.ageDays).toBe(settings().lateAfterDays + 1);
    const missing = await at(addDays(dueDate, settings().missingAfterDays + 1));
    expect(missing.status).toBe('missing');
    expect(missing.ageDays).toBe(settings().missingAfterDays + 1);
    // The status filter applies after derivation and pages still hold.
    const asOf = addDays(dueDate, settings().missingAfterDays + 1);
    const missingRows = await expected(
      'head.one',
      `&periodEnd=${periodEnd}&status=missing&asOf=${asOf}`,
    );
    expect(missingRows.map((r) => r.investmentId)).toContain(late.investmentId);
    expect(missingRows.every((r) => r.status === 'missing')).toBe(true);
    const received = await expected(
      'head.one',
      `&periodEnd=${periodEnd}&status=received&asOf=${asOf}`,
    );
    expect(received.every((r) => r.status === 'received' && r.receivedDocumentId !== null)).toBe(
      true,
    );
    expect(received.length + missingRows.length).toBe(
      (await expected('head.one', `&periodEnd=${periodEnd}`)).length,
    );
    const paged = expectedDocumentPage.parse(
      (
        await get(
          'head.one',
          `/api/v1/expected-documents?limit=3&periodEnd=${periodEnd}&status=missing&asOf=${asOf}`,
        ).expect(200)
      ).body,
    );
    expect(paged.items.length).toBe(Math.min(3, missingRows.length));
    if (paged.nextCursor !== null) {
      const next = expectedDocumentPage.parse(
        (
          await get(
            'head.one',
            `/api/v1/expected-documents?limit=3&periodEnd=${periodEnd}&status=missing&asOf=${asOf}&cursor=${paged.nextCursor}`,
          ).expect(200)
        ).body,
      );
      expect(next.items.every((r) => !paged.items.some((p) => p.id === r.id))).toBe(true);
    }
  });

  it('keeps the walled investment expected row inside the wall', async () => {
    const periodEnd = quarterEnd();
    const member = await expected(
      'deal.three',
      `&periodEnd=${periodEnd}&investmentId=${walledId()}`,
    );
    expect(member.length).toBe(1);
    expect(member[0]!.status).toBe('received');
    expect(
      await expected('deal.one', `&periodEnd=${periodEnd}&investmentId=${walledId()}`),
    ).toEqual([]);
    const outsider = await expected('operations', `&periodEnd=${periodEnd}`);
    expect(outsider.some((r) => r.investmentId === walledId())).toBe(false);
    expect(JSON.stringify(outsider)).not.toContain(companyOf(walledId()));
  });

  it('leaves a new item in Received when the classifier switch is off, and a scan with it on again changes nothing', async () => {
    await setFlag('ai.classifier', false);
    const bytes = writePdf({
      title: 'Quarterly Report: a late arrival',
      pages: [
        {
          items: [
            {
              kind: 'text',
              x: 72,
              y: 720,
              size: 14,
              font: 'Helvetica-Bold',
              text: 'Quarterly Report',
            },
            {
              kind: 'text',
              x: 72,
              y: 700,
              size: 10,
              font: 'Helvetica',
              text: 'A synthetic page with nothing else on it.',
            },
          ],
        },
      ],
    });
    writeFileSync(join(h.runtime.config.PB_DOCUMENT_ROOT, 'inbox', LATE_ARRIVAL), bytes);
    const result = documentIndexResult.parse((await index('operations').expect(200)).body);
    expect(result).toEqual({ indexed: 1, duplicates: 0, unchanged: set().documents.length + 1 });
    const arrived = byName(await list('viewer'), LATE_ARRIVAL);
    expect(arrived.reviewStatus).toBe('Received');
    expect(arrived.docType).toBeNull();
    expect(arrived.title).toBe('Quarterly Report: a late arrival');
    expect(arrived.pageCount).toBe(1);
    const [evidence] = await h.runtime.db.query<{ classifier_evidence: Record<string, unknown> }>(
      'select classifier_evidence from doc.document where file_name = $1',
      [LATE_ARRIVAL],
    );
    expect(evidence!.classifier_evidence.reason).toBe('classifier off');
    await setFlag('ai.classifier', true);
    const again = documentIndexResult.parse((await index('operations').expect(200)).body);
    expect(again).toEqual({ indexed: 0, duplicates: 0, unchanged: set().documents.length + 2 });
    expect(byName(await list('viewer'), LATE_ARRIVAL).reviewStatus).toBe('Received');
    // Received is not a state the classify command works from (docs/18 section 6).
    await command('operations', arrived.id, { command: 'classify', docType: QF }).expect(409);
  });

  it('answers a 500 configuration problem when the documents block is missing', async () => {
    const bare = await startHarness({ withoutDefinitions: ['documents'] });
    try {
      const res = await bare
        .http()
        .get('/api/v1/expected-documents')
        .set('authorization', bare.as('viewer'))
        .expect(500);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}configuration`);
      await bare
        .http()
        .post('/api/v1/documents/index')
        .set('authorization', bare.as('operations'))
        .expect(500);
    } finally {
      await bare.close();
    }
  });
});
