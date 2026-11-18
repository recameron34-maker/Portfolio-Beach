import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureExtractor, parseMetadata } from '@pb/ai';
import type { ExtractFn, ExtractionOutput, ExtractionSchema } from '@pb/ai';
import type { MockAiClient } from '@pb/adapters/mocks';
import { latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  documentDetail,
  documentIndexResult,
  documentPage,
  expectedDocumentGenerateResult,
  expectedDocumentPage,
  extractionBatch,
  extractionRunDetail,
  extractionRunPage,
  monitoringBoard,
  problemDetails,
} from '@pb/contracts';
import type {
  DocumentSummary,
  ExpectedDocument,
  ExtractionRun,
  ExtractionRunDetail,
  MonitoringBoardRow,
} from '@pb/contracts';
import { writePdf } from '@pb/pdf';
import { UNTAGGED_FILE_NAME, dateInWords, sha256Hex } from '@pb/synthetic';
import { STATEMENT_HOLD_REASONS } from '@pb/validation';
import { DEFAULT_APPROVAL_REASON } from '../extraction/review.service.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

/*
 * The four guards a capital account statement needs before any schema can extract one (decision
 * 0023, docs/18 section 6): a statement that names a position which does not link is held for a
 * person; only a statement linked to no position fills a fund's expected row; the monitoring
 * board keeps the quarterly report's run when a statement of the position has a newer one; and
 * approving a run whose schema has no record figure promotes nothing, with or without a
 * position. config/extraction_schema.json holds no statement schema yet, so the engine is driven
 * with a test schema over statements written here beside the synthetic set.
 */

const PROBLEM = 'https://portfolio-beach.example/problems/';
const QF = 'doc_type.quarterly_financials';
const CAS = 'doc_type.capital_account_statement';
const PROMPT = 'quarterly_extraction';
const TEST_SCHEMA_ID = 'test_statement';

const money = (key: string, label: string): ExtractionSchema['fields'][number] => ({
  key,
  label,
  kind: 'money',
  required: false,
  target: null,
  bounds: null,
});

/** A statement schema as slice 5 will configure one: the lines of the statement, no record figure, no narrative. */
const TEST_STATEMENT: ExtractionSchema = {
  id: TEST_SCHEMA_ID,
  label: 'Test statement',
  docType: CAS,
  promptId: PROMPT,
  fields: [
    {
      key: 'period_end',
      label: 'Period end',
      kind: 'date',
      required: true,
      target: null,
      bounds: null,
    },
    money('total_commitment', 'Total commitment'),
    money('contributions_to_date', 'Contributions to date'),
    money('distributions_to_date', 'Distributions to date'),
    money('unfunded_commitment', 'Unfunded commitment'),
  ],
  highlights: { bullets: 0 },
  commentary: false,
};

interface Written {
  fileName: string;
  contentHash: string;
  periodLine: string;
  contributionsLine: string;
}

describe('capital account statements: held for review, expected rows, the board and approval (decision 0023)', () => {
  let h: Harness;
  let ai: MockAiClient;
  let fixtures: ExtractFn;
  const written = new Map<string, Written>();
  let everything: DocumentSummary[];
  let reportRuns: ExtractionRun[];
  let statementRuns: ExtractionRun[];

  const quarterEnd = (): string => latestQuarterEndOnOrBefore(h.dataset.asOf);
  const inbox = (): string => join(h.runtime.config.PB_DOCUMENT_ROOT, 'inbox');
  const investment = (number: string) =>
    h.dataset.investments.find((i) => i.investmentNumber === number)!;
  const companyOf = (number: string): string =>
    h.dataset.portfolioCompanies.find((c) => c.id === investment(number).portfolioCompanyId)!.name;
  const fundOf = (number: string) =>
    h.dataset.sponsorFunds.find((f) => f.id === investment(number).sponsorFundId)!;
  const walledNumber = (): string =>
    h.dataset.investments.find((i) => i.id === h.dataset.scenarios.walled_deal![0])!
      .investmentNumber;
  const fundStatementName = (fundName: string): string =>
    `${quarterEnd()} ${fundName} - Capital account statement.pdf`;

  /**
   * Writes a one-page position-level statement into the inbox: the fund's letterhead, the title
   * the classifier reads, the reference line when one is given, and our account's lines. Every
   * file differs in its text, so none is a duplicate of another.
   */
  const writeStatement = (
    key: string,
    fundName: string,
    company: string,
    reference: string | null,
    contributions: string,
  ): Written => {
    const fileName = `${quarterEnd()} ${fundName} - Capital account statement - ${company}.pdf`;
    const periodLine = `Period end ${quarterEnd()}`;
    const contributionsLine = `Contributions to date ${contributions}`;
    const lines = [
      fundName,
      'Capital Account Statement',
      `for the quarter ended ${dateInWords(quarterEnd())}`,
      reference === null
        ? `Prepared for our account (${key})`
        : `Prepared for our account, reference ${reference}`,
      periodLine,
      'Account US$ millions',
      contributionsLine,
      'Distributions to date 0.00',
    ];
    const bytes = writePdf({
      title: `Capital Account Statement (${key})`,
      pages: [
        {
          items: lines.map((text, i) => ({
            kind: 'text' as const,
            x: 72,
            y: 720 - i * 18,
            size: i === 1 ? 18 : 10,
            font: i === 1 ? ('Helvetica-Bold' as const) : ('Helvetica' as const),
            text,
          })),
        },
      ],
    });
    writeFileSync(join(inbox(), fileName), bytes);
    const entry = { fileName, contentHash: sha256Hex(bytes), periodLine, contributionsLine };
    written.set(key, entry);
    return entry;
  };

  /** The mock model for the test: the recorded truths, and for a statement written here the lines it carries. */
  const extractor: ExtractFn = (input) => {
    const hash = parseMetadata(input).content_hash;
    const mine = [...written.values()].find((w) => w.contentHash === hash);
    if (mine === undefined) return fixtures(input);
    const absent = { value: null, unit: null, page: null, quote: null, confidence: '1' };
    const output: ExtractionOutput = {
      fields: {
        period_end: {
          value: quarterEnd(),
          unit: 'DATE',
          page: 1,
          quote: mine.periodLine,
          confidence: '1',
        },
        total_commitment: absent,
        contributions_to_date: {
          value: mine.contributionsLine.split(' ').at(-1)!,
          unit: 'USD_M',
          page: 1,
          quote: mine.contributionsLine,
          confidence: '1',
        },
        distributions_to_date: {
          value: '0.00',
          unit: 'USD_M',
          page: 1,
          quote: 'Distributions to date 0.00',
          confidence: '1',
        },
        unfunded_commitment: absent,
      },
      highlights: [],
      commentary: null,
    };
    return output;
  };

  beforeAll(async () => {
    h = await startHarness({
      enableFlags: ['ai.extraction'],
      extraExtractionSchemas: { [TEST_SCHEMA_ID]: TEST_STATEMENT },
    });
    ai = h.runtime.adapters.ai as MockAiClient;
    fixtures = fixtureExtractor(h.runtime.truths);
    ai.register(PROMPT, extractor);
    // A second position on a company the book already holds, through another vehicle: the name
    // alone then fits two positions.
    const twin = investment('INV-0005');
    const otherVehicle = h.dataset.vehicles.find((v) => v.id !== twin.vehicleId)!;
    await h.runtime.db.query(
      `insert into core.investment (investment_number, vehicle_id, portfolio_company_id, sponsor_fund_id, sponsor_id, deal_type, entry_date)
       values ('INV-0921', $1, $2, $3, $4, $5, $6)`,
      [
        otherVehicle.id,
        twin.portfolioCompanyId,
        twin.sponsorFundId,
        twin.sponsorId,
        twin.dealType,
        twin.entryDate,
      ],
    );
    // The fund-level statement of one fund never arrives, so its expected row can only be filled
    // by mistake: three position-level statements of that fund do arrive.
    rmSync(join(inbox(), fundStatementName(fundOf('INV-0002').name)));

    // Linked by our reference and by the company in the file name.
    writeStatement('linked', fundOf('INV-0007').name, companyOf('INV-0007'), 'INV-0007', '12.40');
    // Linked by the company in the file name alone.
    writeStatement('byName', fundOf('INV-0002').name, companyOf('INV-0002'), null, '8.10');
    // A position with no report for the quarter (late_financials).
    writeStatement('noReport', fundOf('INV-0001').name, companyOf('INV-0001'), 'INV-0001', '6.25');
    // The walled position.
    writeStatement(
      'walled',
      fundOf(walledNumber()).name,
      companyOf(walledNumber()),
      walledNumber(),
      '9.90',
    );
    // A name that links to nothing.
    writeStatement('unknown', fundOf('INV-0002').name, 'Northgate Holdco', null, '3.30');
    // A company two positions hold.
    writeStatement('twoPositions', fundOf('INV-0005').name, companyOf('INV-0005'), null, '4.40');
    // A reference that is no number on record, beside a name that links.
    writeStatement(
      'badReference',
      fundOf('INV-0003').name,
      companyOf('INV-0003'),
      'INV-9999',
      '5.50',
    );
    // A reference and a name that belong to two positions.
    writeStatement('disagree', fundOf('INV-0008').name, companyOf('INV-0008'), 'INV-0004', '7.70');
  });
  afterAll(async () => {
    await h.close();
  });

  const get = (who: string, path: string, requestId = 'req-stg-get') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const post = (who: string, path: string, body: object, requestId: string) =>
    h.http().post(path).set('authorization', h.as(who)).set('x-request-id', requestId).send(body);
  const list = async (who: string, query = ''): Promise<DocumentSummary[]> =>
    documentPage.parse((await get(who, `/api/v1/documents?limit=200${query}`).expect(200)).body)
      .items;
  const doc = (key: string): DocumentSummary =>
    everything.find((d) => d.fileName === written.get(key)!.fileName)!;
  const refresh = async (): Promise<void> => {
    everything = await list('deal.three');
  };
  const expectedOf = async (who: string, fundName: string): Promise<ExpectedDocument> =>
    expectedDocumentPage
      .parse(
        (
          await get(who, `/api/v1/expected-documents?limit=200&periodEnd=${quarterEnd()}`).expect(
            200,
          )
        ).body,
      )
      .items.find((r) => r.sponsorFundName === fundName && r.docType === CAS)!;
  const runsOf = async (who: string, query = ''): Promise<ExtractionRun[]> =>
    extractionRunPage.parse(
      (await get(who, `/api/v1/extraction/runs?limit=200${query}`).expect(200)).body,
    ).items;
  const runCommand = (who: string, id: string, body: object, requestId = 'req-stg-run') =>
    post(who, `/api/v1/extraction/runs/${id}/commands`, body, requestId);
  const boardRow = async (who: string, number: string): Promise<MonitoringBoardRow> =>
    monitoringBoard
      .parse((await get(who, '/api/v1/monitoring/board').expect(200)).body)
      .rows.find((r) => r.investmentNumber === number)!;
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql, params))[0]!.n;
  /** The quarter on record with every column, lineage and bookkeeping included, as text. */
  const quarterRow = async (investmentId: string): Promise<string> =>
    JSON.stringify(
      await h.runtime.db.query(
        'select * from mon.quarterly_performance where investment_id = $1 and period_end = $2',
        [investmentId, quarterEnd()],
      ),
    );
  const evidenceOf = async (fileName: string): Promise<Record<string, unknown>> =>
    (
      await h.runtime.db.query<{ classifier_evidence: Record<string, unknown> }>(
        'select classifier_evidence from doc.document where file_name = $1',
        [fileName],
      )
    )[0]!.classifier_evidence;

  it('classifies a statement that names one position to that position, and holds the rest for a person', async () => {
    const result = documentIndexResult.parse(
      (await post('operations', '/api/v1/documents/index', {}, 'req-stg-index').expect(200)).body,
    );
    expect(result.indexed).toBe(h.documents.documents.length - 2 + written.size);
    await refresh();

    for (const [key, number] of [
      ['linked', 'INV-0007'],
      ['byName', 'INV-0002'],
      ['noReport', 'INV-0001'],
      ['walled', walledNumber()],
    ] as const) {
      const found = doc(key);
      expect(found.reviewStatus, key).toBe('Classified');
      expect(found.docType, key).toBe(CAS);
      expect(found.investmentNumber, key).toBe(number);
      expect(found.sponsorFundName, key).toBe(fundOf(number).name);
      expect(found.periodEnd, key).toBe(quarterEnd());
    }

    const { notLinked, disagree } = STATEMENT_HOLD_REASONS;
    for (const [key, reason, linkedTo] of [
      ['unknown', notLinked, null],
      ['twoPositions', notLinked, null],
      // The links stay as the document names them: the name where the reference is unknown, the
      // reference where both link.
      ['badReference', notLinked, 'INV-0003'],
      ['disagree', disagree, 'INV-0004'],
    ] as const) {
      const found = doc(key);
      expect(found.reviewStatus, key).toBe('NeedsReview');
      expect(found.docType, key).toBeNull();
      expect(found.classifiedAt, key).toBeNull();
      expect(found.investmentNumber, key).toBe(linkedTo);
      expect(found.classificationConfidence, key).toBe('0.9700');
      expect(
        found.classifierEvidence.candidates.map((c) => c.reason),
        key,
      ).toContain(reason);
      expect(
        found.classifierEvidence.candidates.map((c) => c.reason),
        key,
      ).toContain(`classifier suggestion: ${CAS}`);
      // The evidence says why and names nothing: no company, no investment number.
      const evidence = await evidenceOf(found.fileName);
      expect(evidence.reason, key).toBe(reason);
      const text = JSON.stringify(evidence);
      expect(text, key).not.toMatch(/INV-\d/);
      for (const company of h.dataset.portfolioCompanies)
        expect(text, key).not.toContain(company.name);
      expect(text, key).not.toContain('Northgate');
    }
    const queue = documentPage.parse(
      (await get('deal.three', '/api/v1/documents/review-queue?limit=200').expect(200)).body,
    );
    for (const key of ['unknown', 'twoPositions', 'badReference', 'disagree'])
      expect(queue.items.map((d) => d.fileName)).toContain(written.get(key)!.fileName);

    // The index's audit event of a held statement gives the reason and the transition taken.
    const events = await h.runtime.db.query<{
      reason: string | null;
      details: Record<string, unknown>;
    }>(
      "select reason, details from audit.event where action = 'document.index' and request_id = 'req-stg-index' and entity_id = $1",
      [doc('disagree').id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe(disagree);
    expect(events[0]!.details.command).toBe('flagForReview');

    // A fund statement names no position and is classified as before.
    const fundLevel = everything.find(
      (d) => d.fileName === fundStatementName(fundOf('INV-0007').name),
    )!;
    expect(fundLevel.reviewStatus).toBe('Classified');
    expect(fundLevel.investmentId).toBeNull();
    // The walled position's statement is behind its wall.
    expect(
      (await list('operations')).some((d) => d.fileName === written.get('walled')!.fileName),
    ).toBe(false);
  });

  it('never fills a fund expected row with a position-level statement, at generation or at the index', async () => {
    const result = expectedDocumentGenerateResult.parse(
      (
        await post(
          'operations',
          '/api/v1/expected-documents/generate',
          { periodEnd: quarterEnd() },
          'req-stg-generate',
        ).expect(201)
      ).body,
    );
    expect(result.created).toBeGreaterThan(0);
    // The fund whose own statement never arrived: its classified position-level statement
    // carries the fund's id and still does not answer for the fund.
    const missingFund = fundOf('INV-0002').name;
    expect(doc('byName').sponsorFundName).toBe(missingFund);
    expect((await expectedOf('operations', missingFund)).receivedDocumentId).toBeNull();
    // A fund with both kinds: its row takes the fund-level statement.
    for (const number of ['INV-0007', walledNumber()]) {
      const fundName = fundOf(number).name;
      const fundLevel = everything.find((d) => d.fileName === fundStatementName(fundName))!;
      const row = await expectedOf('operations', fundName);
      expect(row.receivedDocumentId, fundName).toBe(fundLevel.id);
      expect(row.status, fundName).toBe('received');
    }
    // A position-level statement indexed after the rows exist: classified, and the row stays empty.
    const late = writeStatement('late', missingFund, companyOf('INV-0011'), 'INV-0011', '2.20');
    expect(fundOf('INV-0011').name).toBe(missingFund);
    documentIndexResult.parse(
      (await post('operations', '/api/v1/documents/index', {}, 'req-stg-index-2').expect(200)).body,
    );
    await refresh();
    expect(doc('late').reviewStatus).toBe('Classified');
    expect(doc('late').investmentNumber).toBe('INV-0011');
    expect(late.fileName).toBe(doc('late').fileName);
    expect((await expectedOf('operations', missingFund)).receivedDocumentId).toBeNull();
  });

  it('fills no row from a statement held for review, and lets the reviewer say which kind it is', async () => {
    const missingFund = fundOf('INV-0002').name;
    const classify = (key: string, body: object, requestId: string) =>
      post(
        'operations',
        `/api/v1/documents/${doc(key).id}/commands`,
        { command: 'classify', docType: CAS, ...body },
        requestId,
      );
    // Held: nothing was matched, whatever links the statement carries.
    expect(doc('unknown').sponsorFundName).toBe(missingFund);
    expect(doc('badReference').sponsorFundName).toBe(missingFund);
    expect(
      await count(
        'select count(*)::int as n from doc.expected_document where received_document_id = any($1::uuid[])',
        [['unknown', 'twoPositions', 'badReference', 'disagree'].map((key) => doc(key).id)],
      ),
    ).toBe(0);

    // The reviewer keeps the position the statement names: it is position-level, the row stays empty.
    const kept = documentDetail.parse(
      (await classify('badReference', {}, 'req-stg-classify-1').expect(200)).body,
    );
    expect(kept.reviewStatus).toBe('Classified');
    expect(kept.investmentNumber).toBe('INV-0003');
    expect((await expectedOf('operations', missingFund)).receivedDocumentId).toBeNull();

    // The reviewer chooses the position of the company two positions hold.
    const chosen = documentDetail.parse(
      (
        await classify(
          'twoPositions',
          { investmentId: investment('INV-0005').id },
          'req-stg-classify-2',
        ).expect(200)
      ).body,
    );
    expect(chosen.investmentNumber).toBe('INV-0005');
    expect((await expectedOf('operations', fundOf('INV-0005').name)).receivedDocumentId).not.toBe(
      chosen.id,
    );

    // The reviewer leaves the position empty: a fund statement, which fills the fund's row.
    const fundLevel = documentDetail.parse(
      (await classify('unknown', {}, 'req-stg-classify-3').expect(200)).body,
    );
    expect(fundLevel.reviewStatus).toBe('Classified');
    expect(fundLevel.investmentId).toBeNull();
    const row = await expectedOf('operations', missingFund);
    expect(row.receivedDocumentId).toBe(fundLevel.id);
    expect(row.status).toBe('received');
    await refresh();
  });

  it('keeps the report run on the monitoring board when a statement of the position has a newer run', async () => {
    const reports = extractionBatch.parse(
      (
        await post(
          'operations',
          '/api/v1/extraction/batches',
          { periodEnd: quarterEnd(), docType: QF },
          'req-stg-batch-reports',
        ).expect(201)
      ).body,
    );
    expect(reports.state).toBe('succeeded');
    reportRuns = await runsOf('deal.three', `&batchId=${reports.id}`);
    const reportRunOf = (number: string): ExtractionRun =>
      reportRuns.find((r) => r.investmentNumber === number)!;
    const before = {
      linked: await boardRow('deal.three', 'INV-0007'),
      byName: await boardRow('deal.three', 'INV-0002'),
      walled: await boardRow('deal.three', walledNumber()),
      noReport: await boardRow('deal.three', 'INV-0001'),
    };
    expect(before.linked.runId).toBe(reportRunOf('INV-0007').id);
    expect(before.walled.runId).toBe(reportRunOf(walledNumber()).id);
    expect(before.noReport.runId).toBeNull();

    // Every classified statement of the quarter is extracted with the test schema.
    const statements = extractionBatch.parse(
      (
        await post(
          'operations',
          '/api/v1/extraction/batches',
          { periodEnd: quarterEnd(), docType: CAS },
          'req-stg-batch-statements',
        ).expect(201)
      ).body,
    );
    expect(statements.state).toBe('succeeded');
    expect(statements.runs.failed).toBe(0);
    statementRuns = await runsOf('deal.three', `&batchId=${statements.id}`);
    for (const key of ['linked', 'byName', 'noReport', 'walled', 'late']) {
      const run = statementRuns.find((r) => r.fileName === written.get(key)!.fileName)!;
      expect(run.state, key).toBe('Succeeded');
      expect(run.schemaId, key).toBe(TEST_SCHEMA_ID);
      expect(run.investmentId, key).toBe(doc(key).investmentId);
    }
    // Each position's statement run is newer than its report run, and the board does not move.
    expect(await boardRow('deal.three', 'INV-0007')).toEqual(before.linked);
    expect(await boardRow('deal.three', 'INV-0002')).toEqual(before.byName);
    expect(await boardRow('deal.three', walledNumber())).toEqual(before.walled);
    // A position with a statement run and no report run has no run on the board.
    const noReport = await boardRow('deal.three', 'INV-0001');
    expect(noReport).toEqual(before.noReport);
    expect(noReport.runState).toBeNull();
    expect(noReport.documentId).toBeNull();
  });

  it('approves a position-level statement run without touching the quarter on record, lineage included', async () => {
    const run = statementRuns.find((r) => r.fileName === written.get('linked')!.fileName)!;
    const position = investment('INV-0007');
    const before = await quarterRow(position.id);
    expect(JSON.parse(before)).toHaveLength(1);
    const historyBefore = await count(
      "select count(*)::int as n from mon.quarterly_performance_history where row_image ->> 'investment_id' = $1",
      [position.id],
    );
    const boardBefore = await boardRow('operations', 'INV-0007');

    const reviewed = extractionRunDetail.parse(
      (await runCommand('operations', run.id, { command: 'acceptClean' }).expect(200)).body,
    );
    expect(reviewed.values.find((v) => v.field === 'period_end')!.decision).toBe('accepted');
    const approved: ExtractionRunDetail = extractionRunDetail.parse(
      (
        await runCommand('operations', run.id, { command: 'approve' }, 'req-stg-approve-1').expect(
          200,
        )
      ).body,
    );
    const approver = h.dataset.users.find((u) => u.externalId === 'ops.one')!;
    expect(approved.run.approvedBy).toBe(approver.displayName);
    expect(approved.run.approvedAt).toBe(h.runtime.adapters.clock.now());
    expect(approved.run.promotedRecordId).toBeNull();

    // The quarter on record is the row it was, to the last column.
    expect(await quarterRow(position.id)).toBe(before);
    expect(
      await count(
        "select count(*)::int as n from mon.quarterly_performance_history where row_image ->> 'investment_id' = $1",
        [position.id],
      ),
    ).toBe(historyBefore);
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'quarterly_performance.promote' and request_id = 'req-stg-approve-1'",
      ),
    ).toBe(0);
    const [event] = await h.runtime.db.query<{
      reason: string | null;
      details: Record<string, unknown>;
    }>(
      "select reason, details from audit.event where action = 'extraction_run.approve' and request_id = 'req-stg-approve-1'",
    );
    expect(event!.reason).toBe(DEFAULT_APPROVAL_REASON);
    expect(event!.details).toMatchObject({
      investmentId: position.id,
      periodEnd: quarterEnd(),
      schemaId: TEST_SCHEMA_ID,
      promoted: false,
      before: { approvedBy: null, promotedRecordId: null },
      after: { approvedBy: approver.id, promotedRecordId: null },
    });
    // The board still follows the report: its run, its approval.
    expect(await boardRow('operations', 'INV-0007')).toEqual(boardBefore);

    const again = await runCommand('operations', run.id, { command: 'approve' }).expect(409);
    expect(problemDetails.parse(again.body).detail).toBe(
      'extraction: the run is already approved and promoted',
    );
  });

  it('approves a fund-level statement run with no position, and writes nothing to the quarterly record', async () => {
    const fundName = fundOf('INV-0007').name;
    const run = statementRuns.find((r) => r.fileName === fundStatementName(fundName))!;
    expect(run.investmentId).toBeNull();
    const snapshot = async (): Promise<string> =>
      JSON.stringify(
        await h.runtime.db.query(
          'select count(*)::int as n, max(updated_at) as latest, sum(row_version)::int as versions from mon.quarterly_performance',
        ),
      );
    const before = await snapshot();
    await runCommand('operations', run.id, { command: 'acceptClean' }).expect(200);
    const approved = extractionRunDetail.parse(
      (
        await runCommand(
          'operations',
          run.id,
          { command: 'approve', reason: 'Read against the statement' },
          'req-stg-approve-2',
        ).expect(200)
      ).body,
    );
    expect(approved.run.approvedBy).not.toBeNull();
    expect(approved.run.promotedRecordId).toBeNull();
    expect(await snapshot()).toBe(before);
    const [event] = await h.runtime.db.query<{ reason: string; details: Record<string, unknown> }>(
      "select reason, details from audit.event where action = 'extraction_run.approve' and request_id = 'req-stg-approve-2'",
    );
    expect(event!.reason).toBe('Read against the statement');
    expect(event!.details).toMatchObject({ investmentId: null, promoted: false });
  });

  it('still refuses a statement run whose period end is not accepted, and one of another quarter', async () => {
    const run = statementRuns.find((r) => r.fileName === written.get('byName')!.fileName)!;
    const unreviewed = await runCommand('operations', run.id, { command: 'approve' }).expect(409);
    expect(problemDetails.parse(unreviewed.body).detail).toBe(
      'extraction: Period end is required and not accepted or edited',
    );
    // The statement's quarter is its own period end, never another (docs/08 section 5).
    await h.runtime.db.query('update doc.extraction_run set period_end = $1 where id = $2', [
      '2025-03-31',
      run.id,
    ]);
    await runCommand('operations', run.id, { command: 'acceptClean' }).expect(200);
    const refused = await runCommand('operations', run.id, { command: 'approve' }).expect(422);
    expect(problemDetails.parse(refused.body).detail).toMatch(
      /is not the quarter the run covers \(2025-03-31\); edit it$/,
    );
    expect(
      await count(
        'select count(*)::int as n from doc.extraction_run where id = $1 and approved_by is null',
        [run.id],
      ),
    ).toBe(1);
  });

  it('still needs a position to approve a run of a schema that writes to the quarterly record', async () => {
    // The untagged scan is a quarterly report the classifier could not link: a person classifies
    // it with a type and no position, and its run cannot be approved.
    const scan = everything.find((d) => d.fileName === UNTAGGED_FILE_NAME)!;
    expect(scan.reviewStatus).toBe('NeedsReview');
    expect(scan.investmentId).toBeNull();
    await post(
      'operations',
      `/api/v1/documents/${scan.id}/commands`,
      { command: 'classify', docType: QF, periodEnd: quarterEnd() },
      'req-stg-classify-scan',
    ).expect(200);
    const batch = extractionBatch.parse(
      (
        await post(
          'operations',
          '/api/v1/extraction/batches',
          { documentIds: [scan.id] },
          'req-stg-batch-scan',
        ).expect(201)
      ).body,
    );
    const [run] = await runsOf('operations', `&batchId=${batch.id}`);
    expect(run!.state).toBe('Succeeded');
    expect(run!.investmentId).toBeNull();
    for (const value of extractionRunDetail.parse(
      (await get('operations', `/api/v1/extraction/runs/${run!.id}`).expect(200)).body,
    ).values) {
      if (value.decision !== null || value.validationState === 'clean') continue;
      await runCommand('operations', run!.id, {
        command: 'reject',
        field: value.field,
        reason: 'not reviewed in this test',
      }).expect(200);
    }
    await runCommand('operations', run!.id, { command: 'acceptClean' }).expect(200);
    const refused = await runCommand('operations', run!.id, { command: 'approve' }).expect(422);
    expect(problemDetails.parse(refused.body)).toMatchObject({
      type: `${PROBLEM}workflow-precondition`,
      detail: 'extraction: the document is not linked to an investment; classify it with one first',
    });
  });
});
