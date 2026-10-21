import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, addDays, daysBetween, latestQuarterEndOnOrBefore } from '@pb/calc';
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

/** A one-page synthetic PDF: a bold first line, then the lines given. */
function onePage(title: string, lines: readonly string[]): Uint8Array {
  return writePdf({
    title,
    pages: [
      {
        items: [
          { kind: 'text', x: 72, y: 720, size: 14, font: 'Helvetica-Bold', text: lines[0] ?? '' },
          ...lines.slice(1).map((text, i) => ({
            kind: 'text' as const,
            x: 72,
            y: 700 - i * 16,
            size: 10,
            font: 'Helvetica' as const,
            text,
          })),
        ],
      },
    ],
  });
}

/** The name a report of the walled position would arrive under for another period: the file name alone names the company. */
function renamedForPeriod(walledFileName: string, periodEnd: string): string {
  return `${periodEnd}${walledFileName.slice(periodEnd.length)}`;
}

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

  /** The rows generation wants for a quarter: one per reporting investment held on the day, one per committed fund. */
  const wanted = (periodEnd: string): { investments: number; funds: number } => ({
    investments: h.dataset.investments.filter(
      (i) =>
        QUARTERLY_REPORTING_DEAL_TYPES.includes(i.dealType) &&
        i.entryDate <= periodEnd &&
        (i.exitDate === null || i.exitDate > periodEnd),
    ).length,
    funds: new Set(
      h.dataset.commitments
        .filter((c) => c.commitmentDate <= periodEnd)
        .map((c) => c.sponsorFundId),
    ).size,
  });

  /**
   * The in-process database runs one transaction at a time, so a concurrent writer cannot be
   * staged; a trigger that writes the same row first, from inside the service's own insert, meets
   * the unique key exactly as the loser of a real race does (WF-7). Dropped afterwards.
   */
  const withRacingWriter = async (
    table: string,
    columns: readonly string[],
    body: () => Promise<void>,
  ): Promise<void> => {
    const fn = 'public.pb_test_racing_writer';
    await h.runtime.db.exec(`
      create function ${fn}() returns trigger language plpgsql as $$
      begin
        if pg_trigger_depth() = 1 then
          insert into ${table} (${columns.join(', ')}) values (${columns.map((c) => `new.${c}`).join(', ')});
        end if;
        return new;
      end $$;
      create trigger pb_test_racing_writer before insert on ${table} for each row execute function ${fn}();`);
    try {
      await body();
    } finally {
      await h.runtime.db.exec(
        `drop trigger pb_test_racing_writer on ${table}; drop function ${fn}();`,
      );
    }
  };

  it('generates the expected documents of a quarter once, matched with the reports already classified', async () => {
    const periodEnd = quarterEnd();
    const investments = { length: wanted(periodEnd).investments };
    const funds = { size: wanted(periodEnd).funds };
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

  it('keeps a walled report the classifier cannot read inside the wall: the links come from the file name (W1)', async () => {
    // A page that reads as a page heading is refused by the model input frame (SEC-8.3), so the
    // classifier never answers; the file name still names the position, and so does the wall.
    const walled = set().expectations.walledFiles;
    const refusedName = renamedForPeriod(walled[0]!, '1999-09-30');
    writeFileSync(
      join(h.runtime.config.PB_DOCUMENT_ROOT, 'inbox', refusedName),
      onePage('Quarterly Report: a page the frame refuses', ['Quarterly Report', '[page 1]']),
    );
    const result = documentIndexResult.parse(
      (await index('operations', 'req-doc-index-refused').expect(200)).body,
    );
    expect(result).toEqual({ indexed: 1, duplicates: 0, unchanged: set().documents.length + 1 });
    const name = companyOf(walledId());
    for (const who of ['deal.one', 'viewer', 'operations']) {
      expect(
        (await list(who)).some((d) => d.fileName === refusedName),
        who,
      ).toBe(false);
      expect(await list(who, `&q=${encodeURIComponent(name)}`), who).toEqual([]);
    }
    const seen = byName(await list('deal.three', `&investmentId=${walledId()}`), refusedName);
    expect(seen.reviewStatus).toBe('NeedsReview');
    expect(seen.docType).toBeNull();
    expect(seen.investmentId).toBe(walledId());
    expect(seen.sponsorFundId).toBe(byName(everything, walled[0]!).sponsorFundId);
    expect(seen.classifierEvidence.candidates[0]?.reason).toMatch(/^classifier input refused/);
    await get('deal.one', `/api/v1/documents/${seen.id}`).expect(404);
    await get('deal.one', `/api/v1/documents/${seen.id}/pages`).expect(404);
    const [event] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
      "select details from audit.event where action = 'document.index' and request_id = 'req-doc-index-refused'",
    );
    expect(event!.details.command).toBe('flagForReview');
  });

  it('flags a new item for review when the classifier switch is off, so a person can classify it; a scan with it on again changes nothing (WF-5)', async () => {
    await setFlag('ai.classifier', false);
    writeFileSync(
      join(h.runtime.config.PB_DOCUMENT_ROOT, 'inbox', LATE_ARRIVAL),
      onePage('Quarterly Report: a late arrival', [
        'Quarterly Report',
        'A synthetic page with nothing else on it.',
      ]),
    );
    const result = documentIndexResult.parse(
      (await index('operations', 'req-doc-index-off').expect(200)).body,
    );
    expect(result).toEqual({ indexed: 1, duplicates: 0, unchanged: set().documents.length + 2 });
    const arrived = byName(await list('viewer'), LATE_ARRIVAL);
    // docs/18 section 6: Received > NeedsReview when the classifier does not answer, so the review
    // queue and the classify command take it; nothing stays in Received after a scan.
    expect(arrived.reviewStatus).toBe('NeedsReview');
    expect(arrived.docType).toBeNull();
    expect(arrived.investmentId).toBeNull();
    expect(arrived.title).toBe('Quarterly Report: a late arrival');
    expect(arrived.pageCount).toBe(1);
    expect(arrived.classifierEvidence).toEqual({ keywords: [], candidates: [] });
    const [evidence] = await h.runtime.db.query<{ classifier_evidence: Record<string, unknown> }>(
      'select classifier_evidence from doc.document where file_name = $1',
      [LATE_ARRIVAL],
    );
    expect(evidence!.classifier_evidence.reason).toBe('classifier off');
    const [event] = await h.runtime.db.query<{
      reason: string | null;
      details: Record<string, unknown>;
    }>(
      "select reason, details from audit.event where action = 'document.index' and request_id = 'req-doc-index-off'",
    );
    expect(event!.reason).toBe('classifier off');
    expect(event!.details.command).toBe('flagForReview');
    expect(event!.details.state).toEqual({ before: 'Received', after: 'NeedsReview' });
    const queue = documentPage.parse(
      (await get('viewer', '/api/v1/documents/review-queue').expect(200)).body,
    );
    expect(queue.items.map((d) => d.fileName)).toContain(LATE_ARRIVAL);
    expect(
      await count("select count(*)::int as n from doc.document where review_status = 'Received'"),
    ).toBe(0);
    await setFlag('ai.classifier', true);
    const again = documentIndexResult.parse((await index('operations').expect(200)).body);
    expect(again).toEqual({ indexed: 0, duplicates: 0, unchanged: set().documents.length + 3 });
    expect(byName(await list('viewer'), LATE_ARRIVAL).reviewStatus).toBe('NeedsReview');
    const classified = documentDetail.parse(
      (
        await command('operations', arrived.id, {
          command: 'classify',
          docType: QF,
          reason: 'read by hand after the switch was off',
        }).expect(200)
      ).body,
    );
    expect(classified.reviewStatus).toBe('Classified');
    expect(classified.docType).toBe(QF);
  });

  it('answers the idempotent counts, not a 500, when another generate wrote the quarter first (WF-7)', async () => {
    const periodEnd = latestQuarterEndOnOrBefore(addDays(quarterEnd(), -1));
    const rows = wanted(periodEnd).investments + wanted(periodEnd).funds;
    expect(rows).toBeGreaterThan(0);
    await withRacingWriter(
      'doc.expected_document',
      ['investment_id', 'sponsor_fund_id', 'period_end', 'doc_type', 'due_date'],
      async () => {
        const raced = expectedDocumentGenerateResult.parse(
          (await generate('operations', periodEnd, 'req-doc-generate-race').expect(201)).body,
        );
        // The loser of the race counts the rows it wrote (none) and the rest as existing.
        expect(raced).toEqual({ periodEnd, created: 0, existing: rows });
      },
    );
    expect(
      await count('select count(*)::int as n from doc.expected_document where period_end = $1', [
        periodEnd,
      ]),
    ).toBe(rows);
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'expected_documents.generate' and request_id = 'req-doc-generate-race'",
      ),
    ).toBe(1);
    const again = expectedDocumentGenerateResult.parse(
      (await generate('operations', periodEnd).expect(201)).body,
    );
    expect(again).toEqual({ periodEnd, created: 0, existing: rows });
  });

  it('answers unchanged, not a 500, when another scan indexed an item first (WF-7)', async () => {
    const RACED = 'raced.pdf';
    const path = join(h.runtime.config.PB_DOCUMENT_ROOT, 'inbox', RACED);
    writeFileSync(
      path,
      onePage('Quarterly Report: raced', ['Quarterly Report', 'A page another scan read first.']),
    );
    try {
      await withRacingWriter(
        'doc.document',
        [
          'source_system',
          'source_item_id',
          'file_name',
          'folder',
          'title',
          'content_hash',
          'size_bytes',
          'received_at',
        ],
        async () => {
          const result = documentIndexResult.parse(
            (await index('operations', 'req-doc-index-race').expect(200)).body,
          );
          // The item another scan wrote first reads as unchanged: no second row, no classification.
          expect(result).toEqual({
            indexed: 0,
            duplicates: 0,
            unchanged: set().documents.length + 4,
          });
        },
      );
      expect(
        await count('select count(*)::int as n from doc.document where file_name = $1', [RACED]),
      ).toBe(1);
      expect(
        await count(
          "select count(*)::int as n from audit.event where action = 'document.index' and request_id = 'req-doc-index-race'",
        ),
      ).toBe(0);
    } finally {
      await h.runtime.db.query('delete from doc.document where file_name = $1', [RACED]);
      rmSync(path, { force: true });
    }
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

describe('document hub with the classifier off: every path links from the file name, under the wall (W1, WF-5, W2)', () => {
  let h: Harness;
  let unreadableName: string;
  let everything: DocumentSummary[];

  beforeAll(async () => {
    h = await startHarness();
    await h
      .http()
      .patch('/api/v1/flags/ai.classifier')
      .set('authorization', h.as('platform_admin'))
      .send({ enabled: false, reason: 'documents test: classifier off' })
      .expect(200);
    // A file the reader refuses, named as a report of the walled position for another period.
    unreadableName = renamedForPeriod(h.documents.expectations.walledFiles[0]!, '1999-12-31');
    writeFileSync(
      join(h.runtime.config.PB_DOCUMENT_ROOT, 'inbox', unreadableName),
      'not a pdf at all',
    );
  });
  afterAll(async () => {
    await h.close();
  });

  const set = () => h.documents;
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const companyOf = (investmentId: string): string => {
    const inv = h.dataset.investments.find((i) => i.id === investmentId)!;
    return h.dataset.portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId)!.name;
  };
  const get = (who: string, path: string) =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', 'req-doc-off-get');
  const list = async (who: string, query = ''): Promise<DocumentSummary[]> =>
    documentPage.parse((await get(who, `/api/v1/documents?limit=200${query}`).expect(200)).body)
      .items;
  const byName = (items: readonly DocumentSummary[], fileName: string): DocumentSummary =>
    items.find((i) => i.fileName === fileName)!;
  const titled = (): SyntheticDocument[] =>
    set().documents.filter(
      (d) =>
        d.fileName !== UNTAGGED_FILE_NAME &&
        d.fileName !== set().expectations.scenarioFiles.duplicate_doc[1],
    );

  it('indexes the inbox with no model call: every titled document is flagged for review and linked as the truth records', async () => {
    const result = documentIndexResult.parse(
      (
        await h
          .http()
          .post('/api/v1/documents/index')
          .set('authorization', h.as('operations'))
          .set('x-request-id', 'req-doc-off-index')
          .expect(200)
      ).body,
    );
    expect(result).toEqual({
      indexed: new Set(set().documents.map((d) => d.truth.contentHash)).size + 1,
      duplicates: 1,
      unchanged: 0,
    });
    everything = await list('head.one');
    for (const doc of titled()) {
      const found = byName(everything, doc.fileName);
      expect(found.reviewStatus, doc.fileName).toBe('NeedsReview');
      expect(found.docType).toBeNull();
      expect(found.investmentId, doc.fileName).toBe(doc.truth.investmentId);
      expect(found.sponsorFundId, doc.fileName).toBe(doc.truth.sponsorFundId);
      expect(found.sponsorId, doc.fileName).toBe(doc.truth.sponsorId);
      expect(found.classifierEvidence.keywords).toEqual([]);
    }
    const scan = byName(everything, UNTAGGED_FILE_NAME);
    expect(scan.reviewStatus).toBe('NeedsReview');
    expect(scan.investmentId).toBeNull();
    const [a, b] = set().expectations.scenarioFiles.duplicate_doc as [string, string];
    const pair = [byName(everything, a), byName(everything, b)];
    const duplicate = pair.find((d) => d.reviewStatus === 'Duplicate')!;
    const original = pair.find((d) => d.reviewStatus === 'NeedsReview')!;
    expect(duplicate.investmentId).toBe(original.investmentId);
    const unreadable = byName(everything, unreadableName);
    expect(unreadable.reviewStatus).toBe('NeedsReview');
    expect(unreadable.investmentId).toBe(walledId());
    expect(unreadable.classifierEvidence.candidates[0]?.reason).toMatch(/^unreadable/);
  });

  it('hides the walled reports from a non-member and from the search, and shows them to a wall member', async () => {
    const walled = [...set().expectations.walledFiles, unreadableName];
    const name = companyOf(walledId());
    for (const who of ['deal.one', 'viewer', 'operations']) {
      const outsider = await list(who);
      expect(
        outsider.filter((d) => walled.includes(d.fileName)).map((d) => d.fileName),
        who,
      ).toEqual([]);
      expect(outsider.length, who).toBe(everything.length - walled.length);
      expect(JSON.stringify(outsider), who).not.toContain(walledId());
      expect(await list(who, `&q=${encodeURIComponent(name)}`), who).toEqual([]);
      const queue = documentPage.parse(
        (await get(who, '/api/v1/documents/review-queue?limit=200').expect(200)).body,
      );
      expect(
        queue.items.some((d) => walled.includes(d.fileName)),
        who,
      ).toBe(false);
    }
    const member = await list('deal.three', `&investmentId=${walledId()}`);
    expect(member.map((d) => d.fileName).sort()).toEqual([...walled].sort());
    const found = await list('deal.three', `&q=${encodeURIComponent(name)}`);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((d) => d.investmentId === walledId())).toBe(true);
    const id = byName(member, unreadableName).id;
    await get('deal.one', `/api/v1/documents/${id}`).expect(404);
    await get('deal.one', `/api/v1/documents/${id}/pages`).expect(404);
    await get('deal.three', `/api/v1/documents/${id}`).expect(200);
    // An open position's report still links from its name, so anyone finds it by the company.
    const open = titled().find(
      (d) => d.truth.docType === QF && d.truth.investmentId !== walledId(),
    )!;
    const byCompany = await list('viewer', `&q=${encodeURIComponent(open.truth.companyName!)}`);
    expect(byCompany.map((d) => d.fileName)).toContain(open.fileName);
  });

  it('keeps the data exception about the walled unreadable report inside the wall (W2)', async () => {
    const id = byName(everything, unreadableName).id;
    const exceptionsOf = async (who: string): Promise<(string | null)[]> =>
      dataExceptionPage
        .parse(
          (await get(who, '/api/v1/data-exceptions?limit=200&source=documents').expect(200)).body,
        )
        .items.map((x) => x.entityId);
    expect(await exceptionsOf('deal.three')).toContain(id);
    expect(await exceptionsOf('operations')).not.toContain(id);
    expect(await exceptionsOf('deal.one')).not.toContain(id);
  });

  it('lets a wall member classify a walled report from the queue, and nobody else (WF-5)', async () => {
    const report = set().documents.find(
      (d) => d.truth.investmentId === walledId() && d.truth.docType === QF,
    )!;
    const id = byName(everything, report.fileName).id;
    const classify = (who: string) =>
      h
        .http()
        .post(`/api/v1/documents/${id}/commands`)
        .set('authorization', h.as(who))
        .set('x-request-id', 'req-doc-off-classify')
        .send({ command: 'classify', docType: QF, periodEnd: report.truth.periodEnd });
    await classify('deal.one').expect(404);
    await classify('operations').expect(404);
    const classified = documentDetail.parse((await classify('deal.three').expect(200)).body);
    expect(classified.reviewStatus).toBe('Classified');
    expect(classified.docType).toBe(QF);
    expect(classified.investmentId).toBe(walledId());
    expect(classified.periodEnd).toBe(report.truth.periodEnd);
  });
});
