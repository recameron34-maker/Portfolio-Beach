import { beforeEach, describe, expect, it, vi } from 'vitest';
import { latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  documentDetail,
  documentPage,
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
  MonitoringBoardRow,
} from '@pb/contracts';
import { writePdf } from '@pb/pdf';
import {
  SYNTHETIC_DOC_TYPES,
  dateInWords,
  generateDataset,
  generateDocuments,
  previewBook,
  sha256Hex,
} from '@pb/synthetic';
import type { DocumentSet, SyntheticDocument, TruthField } from '@pb/synthetic';
import { STATEMENT_HOLD_REASONS } from '@pb/validation';
import { parseBook } from '../book.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState, quarterKey } from '../state.js';
import type { PreviewState } from '../state.js';
import { generatedWorld, send, serveSamples } from '../test-fixtures.js';

/**
 * The four guards of a capital account statement in the simulation, as the API holds them
 * (apps/api/src/test/statement-guards.test.ts, decision 0023, docs/18 section 6): a statement
 * that names a position which does not link is held for a person; only a statement linked to no
 * position fills a fund's expected row; the monitoring board keeps the report's run; and
 * approving a run whose schema has no record figure promotes nothing. config holds no statement
 * schema yet, so the config file is read here with a test schema added, and the statements are
 * written beside the synthetic set.
 */
vi.mock('../../../../../config/extraction_schema.json', async (importOriginal) => {
  const real = await importOriginal<{ default: { schemas: Record<string, unknown> } }>();
  const line = (key: string, label: string) => ({
    key,
    label,
    kind: 'money',
    required: false,
    target: null,
    bounds: null,
  });
  return {
    default: {
      ...real.default,
      schemas: {
        ...real.default.schemas,
        test_statement: {
          label: 'Test statement',
          docType: 'doc_type.capital_account_statement',
          promptId: 'quarterly_extraction',
          fields: [
            {
              key: 'period_end',
              label: 'Period end',
              kind: 'date',
              required: true,
              target: null,
              bounds: null,
            },
            line('total_commitment', 'Total commitment'),
            line('contributions_to_date', 'Contributions to date'),
            line('distributions_to_date', 'Distributions to date'),
            line('unfunded_commitment', 'Unfunded commitment'),
          ],
          highlights: { bullets: 0 },
          commentary: false,
        },
      },
    },
  };
});

const QF = SYNTHETIC_DOC_TYPES.quarterlyFinancials;
const CAS = SYNTHETIC_DOC_TYPES.capitalAccountStatement;
const TEST_SCHEMA_ID = 'test_statement';

const dataset = generateDataset({ profile: 'small', seed: 42 });
const generated = generateDocuments(dataset);
const quarter = latestQuarterEndOnOrBefore(dataset.asOf);
const walledId = dataset.scenarios.walled_deal?.[0] ?? '';

const investment = (number: string) => {
  const found = dataset.investments.find((i) => i.investmentNumber === number);
  if (found === undefined) throw new Error(`no investment ${number}`);
  return found;
};
const companyOf = (number: string): string =>
  dataset.portfolioCompanies.find((c) => c.id === investment(number).portfolioCompanyId)?.name ??
  '';
const fundOf = (number: string) => {
  const found = dataset.sponsorFunds.find((f) => f.id === investment(number).sponsorFundId);
  if (found === undefined) throw new Error(`no fund for ${number}`);
  return found;
};
const walledNumber = dataset.investments.find((i) => i.id === walledId)?.investmentNumber ?? '';
const fundStatementName = (fundName: string): string =>
  `${quarter} ${fundName} - Capital account statement.pdf`;

const written = new Map<string, SyntheticDocument>();

/**
 * A one-page position-level statement with its truth sidecar: the fund's letterhead, the title
 * the classifier reads, the reference line when one is given, and our account's lines. Every
 * file differs in its text, so none is a duplicate of another.
 */
function statement(
  key: string,
  fundNumber: string,
  company: string,
  reference: string | null,
  contributions: string,
  linkedTo: string | null,
): SyntheticDocument {
  const fund = fundOf(fundNumber);
  const fileName = `${quarter} ${fund.name} - Capital account statement - ${company}.pdf`;
  const periodLine = `Period end ${quarter}`;
  const contributionsLine = `Contributions to date ${contributions}`;
  const lines = [
    fund.name,
    'Capital Account Statement',
    `for the quarter ended ${dateInWords(quarter)}`,
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
  const absent: TruthField = { value: null, unit: null, page: null, quote: null };
  const position = linkedTo === null ? null : investment(linkedTo);
  const document: SyntheticDocument = {
    fileName,
    folder: 'inbox',
    bytes,
    truth: {
      fileName,
      fileNames: [fileName],
      contentHash: sha256Hex(bytes),
      docType: CAS,
      sponsorId: fund.sponsorId,
      sponsorFundId: fund.id,
      sponsorFundName: fund.name,
      investmentId: position?.id ?? null,
      investmentNumber: position?.investmentNumber ?? null,
      companyName: position === null ? null : company,
      periodEnd: quarter,
      currency: 'USD',
      unit: 'USD_M',
      pageCount: 1,
      fields: {
        period_end: { value: quarter, unit: 'DATE', page: 1, quote: periodLine },
        total_commitment: absent,
        contributions_to_date: {
          value: contributions,
          unit: 'USD_M',
          page: 1,
          quote: contributionsLine,
        },
        distributions_to_date: {
          value: '0.00',
          unit: 'USD_M',
          page: 1,
          quote: 'Distributions to date 0.00',
        },
        unfunded_commitment: absent,
      },
      highlights: [],
      commentary: null,
      scenarios: [],
      expectedClassification: { docType: CAS, confidenceAtLeast: '0.97' },
    },
  };
  written.set(key, document);
  return document;
}

// Linked by our reference and by the company in the file name.
statement('linked', 'INV-0007', companyOf('INV-0007'), 'INV-0007', '12.40', 'INV-0007');
// Linked by the company in the file name alone.
statement('byName', 'INV-0002', companyOf('INV-0002'), null, '8.10', 'INV-0002');
// A position with no report for the quarter (late_financials).
statement('noReport', 'INV-0001', companyOf('INV-0001'), 'INV-0001', '6.25', 'INV-0001');
// The walled position.
statement('walled', walledNumber, companyOf(walledNumber), walledNumber, '9.90', walledNumber);
// A name that links to nothing.
statement('unknown', 'INV-0002', 'Northgate Holdco', null, '3.30', null);
// A company two positions hold.
statement('twoPositions', 'INV-0005', companyOf('INV-0005'), null, '4.40', null);
// A reference that is no number on record, beside a name that links.
statement('badReference', 'INV-0003', companyOf('INV-0003'), 'INV-9999', '5.50', 'INV-0003');
// A reference and a name that belong to two positions.
statement('disagree', 'INV-0008', companyOf('INV-0008'), 'INV-0004', '7.70', 'INV-0004');

/** The fund whose own statement never arrives: three position-level statements of it do. */
const missingFund = fundOf('INV-0002').name;
const set: DocumentSet = {
  documents: [
    ...generated.documents.filter((d) => d.fileName !== fundStatementName(missingFund)),
    ...written.values(),
  ],
  expectations: generated.expectations,
};
const built = JSON.parse(JSON.stringify(previewBook(dataset, { documents: set }))) as {
  investments: Record<string, unknown>[];
};
// A second position on a company the book already holds, through another vehicle: the name
// alone then fits two positions.
const twin = built.investments.find((i) => i.investmentNumber === 'INV-0005');
built.investments.push({
  ...twin,
  id: '30000000-0000-4000-8000-000000000921',
  investmentNumber: 'INV-0921',
});
const book = parseBook(built);
const fixtures = generatedWorld(book, walledId);
const assets = serveSamples(new Map(set.documents.map((d) => [d.fileName, d.bytes])));

let ids = 0;
let ticks = 0;
const env = {
  newId: (): string => `70000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => new Date(Date.UTC(2025, 6, 1, 9, 0, 0) + ++ticks * 1000).toISOString(),
};

function setup(): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  const f = createPreviewFetch(fixtures, assets, { env, state, book });
  return { f, state };
}

const ok = async (
  f: typeof fetch,
  who: string,
  method: string,
  path: string,
  body?: unknown,
  status = 200,
): Promise<unknown> => {
  const answer = await send(f, who, method, path, body);
  expect(answer.status, `${method} ${path}: ${answer.text}`).toBe(status);
  return answer.json;
};
const index = (f: typeof fetch): Promise<unknown> =>
  ok(f, 'ops.one', 'POST', '/api/v1/documents/index');
const generate = (f: typeof fetch): Promise<unknown> =>
  ok(f, 'ops.one', 'POST', '/api/v1/expected-documents/generate', { periodEnd: quarter }, 201);
const hub = async (f: typeof fetch, who: string): Promise<DocumentSummary[]> =>
  documentPage.parse(await ok(f, who, 'GET', '/api/v1/documents?limit=200')).items;
const docOf = (items: readonly DocumentSummary[], key: string): DocumentSummary => {
  const found = items.find((d) => d.fileName === written.get(key)?.fileName);
  if (found === undefined) throw new Error(`no document for ${key}`);
  return found;
};
const expectedOf = async (f: typeof fetch, fundName: string): Promise<ExpectedDocument> => {
  const rows = expectedDocumentPage.parse(
    await ok(f, 'ops.one', 'GET', `/api/v1/expected-documents?limit=200&periodEnd=${quarter}`),
  ).items;
  const found = rows.find((r) => r.sponsorFundName === fundName && r.docType === CAS);
  if (found === undefined) throw new Error(`no expected statement for ${fundName}`);
  return found;
};
const boardRow = async (f: typeof fetch, number: string): Promise<MonitoringBoardRow> => {
  const rows = monitoringBoard.parse(
    await ok(f, 'deal.three', 'GET', '/api/v1/monitoring/board'),
  ).rows;
  const found = rows.find((r) => r.investmentNumber === number);
  if (found === undefined) throw new Error(`no board row for ${number}`);
  return found;
};
const batch = async (f: typeof fetch, docType: string): Promise<ExtractionRun[]> => {
  const created = extractionBatch.parse(
    await ok(
      f,
      'ops.one',
      'POST',
      '/api/v1/extraction/batches',
      { periodEnd: quarter, docType },
      201,
    ),
  );
  expect(created.state).toBe('succeeded');
  expect(created.runs.failed).toBe(0);
  return extractionRunPage.parse(
    await ok(f, 'deal.three', 'GET', `/api/v1/extraction/runs?limit=200&batchId=${created.id}`),
  ).items;
};
const extractionOn = (f: typeof fetch): Promise<unknown> =>
  ok(f, 'admin.one', 'PATCH', '/api/v1/flags/ai.extraction', { enabled: true, reason: 'test' });

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('the simulated review rule of a capital account statement (docs/18 section 6)', () => {
  it('classifies a statement that names one position to that position, and holds the rest for a person', async () => {
    const { f, state } = setup();
    await index(f);
    const everything = await hub(f, 'deal.three');
    for (const [key, number] of [
      ['linked', 'INV-0007'],
      ['byName', 'INV-0002'],
      ['noReport', 'INV-0001'],
      ['walled', walledNumber],
    ] as const) {
      const found = docOf(everything, key);
      expect(found.reviewStatus, key).toBe('Classified');
      expect(found.docType, key).toBe(CAS);
      expect(found.investmentNumber, key).toBe(number);
      expect(found.periodEnd, key).toBe(quarter);
    }
    const { notLinked, disagree } = STATEMENT_HOLD_REASONS;
    for (const [key, reason, linkedTo] of [
      ['unknown', notLinked, null],
      ['twoPositions', notLinked, null],
      ['badReference', notLinked, 'INV-0003'],
      ['disagree', disagree, 'INV-0004'],
    ] as const) {
      const found = docOf(everything, key);
      expect(found.reviewStatus, key).toBe('NeedsReview');
      expect(found.docType, key).toBeNull();
      expect(found.classifiedAt, key).toBeNull();
      expect(found.investmentNumber, key).toBe(linkedTo);
      const reasons = found.classifierEvidence.candidates.map((c) => c.reason);
      expect(reasons, key).toContain(reason);
      expect(reasons, key).toContain(`classifier suggestion: ${CAS}`);
      // The evidence says why and names nothing: no company, no investment number.
      const text = JSON.stringify(state.documents.get(found.id)?.classifierEvidence);
      expect(text, key).not.toMatch(/INV-\d/);
      for (const company of dataset.portfolioCompanies)
        expect(text, key).not.toContain(company.name);
      expect(text, key).not.toContain('Northgate');
    }
    const queue = documentPage
      .parse(await ok(f, 'deal.three', 'GET', '/api/v1/documents/review-queue?limit=200'))
      .items.map((d) => d.fileName);
    for (const key of ['unknown', 'twoPositions', 'badReference', 'disagree'])
      expect(queue).toContain(written.get(key)?.fileName);
    // A fund statement names no position and is classified as before.
    const fundLevel = everything.find(
      (d) => d.fileName === fundStatementName(fundOf('INV-0007').name),
    );
    expect(fundLevel?.reviewStatus).toBe('Classified');
    expect(fundLevel?.investmentId).toBeNull();
    // The walled position's statement is behind its wall.
    expect(
      (await hub(f, 'ops.one')).some((d) => d.fileName === written.get('walled')?.fileName),
    ).toBe(false);
  });
});

describe('the simulated expected documents: a position-level statement answers for no fund', () => {
  it('leaves the fund row empty at generation, and takes the fund-level statement where both exist', async () => {
    const { f } = setup();
    await index(f);
    await generate(f);
    const everything = await hub(f, 'deal.three');
    expect(docOf(everything, 'byName').sponsorFundName).toBe(missingFund);
    expect(docOf(everything, 'byName').reviewStatus).toBe('Classified');
    expect((await expectedOf(f, missingFund)).receivedDocumentId).toBeNull();
    for (const number of ['INV-0007', walledNumber]) {
      const fundName = fundOf(number).name;
      const fundLevel = everything.find((d) => d.fileName === fundStatementName(fundName));
      const row = await expectedOf(f, fundName);
      expect(row.receivedDocumentId, fundName).toBe(fundLevel?.id);
      expect(row.status, fundName).toBe('received');
    }
  });

  it('leaves the fund row empty when the statement is classified after the rows exist', async () => {
    const { f } = setup();
    await generate(f);
    await index(f);
    const everything = await hub(f, 'deal.three');
    expect(docOf(everything, 'byName').reviewStatus).toBe('Classified');
    expect((await expectedOf(f, missingFund)).receivedDocumentId).toBeNull();
    const fundName = fundOf('INV-0007').name;
    expect((await expectedOf(f, fundName)).receivedDocumentId).toBe(
      everything.find((d) => d.fileName === fundStatementName(fundName))?.id,
    );
  });

  it('fills no row from a statement held for review, and lets the reviewer say which kind it is', async () => {
    const { f } = setup();
    await index(f);
    await generate(f);
    const everything = await hub(f, 'deal.three');
    const classify = async (key: string, body: object) =>
      documentDetail.parse(
        await ok(f, 'ops.one', 'POST', `/api/v1/documents/${docOf(everything, key).id}/commands`, {
          command: 'classify',
          docType: CAS,
          ...body,
        }),
      );
    expect(docOf(everything, 'unknown').sponsorFundName).toBe(missingFund);
    expect(docOf(everything, 'badReference').sponsorFundName).toBe(missingFund);
    // The reviewer keeps the position the statement names: position-level, the row stays empty.
    const kept = await classify('badReference', {});
    expect(kept.reviewStatus).toBe('Classified');
    expect(kept.investmentNumber).toBe('INV-0003');
    expect((await expectedOf(f, missingFund)).receivedDocumentId).toBeNull();
    // The reviewer chooses the position of the company two positions hold.
    const chosen = await classify('twoPositions', { investmentId: investment('INV-0005').id });
    expect(chosen.investmentNumber).toBe('INV-0005');
    expect((await expectedOf(f, fundOf('INV-0005').name)).receivedDocumentId).not.toBe(chosen.id);
    // The reviewer leaves the position empty: a fund statement, which fills the fund's row.
    const fundLevel = await classify('unknown', {});
    expect(fundLevel.reviewStatus).toBe('Classified');
    expect(fundLevel.investmentId).toBeNull();
    const row = await expectedOf(f, missingFund);
    expect(row.receivedDocumentId).toBe(fundLevel.id);
    expect(row.status).toBe('received');
  });
});

describe('the simulated board and approval: a statement run promotes nothing and answers for no quarter', () => {
  it('keeps the report run on the board when a statement of the position has a newer run', async () => {
    const { f } = setup();
    await index(f);
    await extractionOn(f);
    const reportRuns = await batch(f, QF);
    const reportRunOf = (number: string): string | undefined =>
      reportRuns.find((r) => r.investmentNumber === number)?.id;
    const before = {
      linked: await boardRow(f, 'INV-0007'),
      byName: await boardRow(f, 'INV-0002'),
      walled: await boardRow(f, walledNumber),
      noReport: await boardRow(f, 'INV-0001'),
    };
    expect(before.linked.runId).toBe(reportRunOf('INV-0007'));
    expect(before.walled.runId).toBe(reportRunOf(walledNumber));
    expect(before.noReport.runId).toBeNull();

    const statementRuns = await batch(f, CAS);
    const everything = await hub(f, 'deal.three');
    for (const key of ['linked', 'byName', 'noReport', 'walled']) {
      const run = statementRuns.find((r) => r.fileName === written.get(key)?.fileName);
      expect(run?.state, key).toBe('Succeeded');
      expect(run?.schemaId, key).toBe(TEST_SCHEMA_ID);
      expect(run?.investmentId, key).toBe(docOf(everything, key).investmentId);
    }
    expect(await boardRow(f, 'INV-0007')).toEqual(before.linked);
    expect(await boardRow(f, 'INV-0002')).toEqual(before.byName);
    expect(await boardRow(f, walledNumber)).toEqual(before.walled);
    const noReport = await boardRow(f, 'INV-0001');
    expect(noReport).toEqual(before.noReport);
    expect(noReport.runState).toBeNull();
  });

  it('approves a position-level and a fund-level statement run without touching the simulated quarters', async () => {
    const { f, state } = setup();
    await index(f);
    await extractionOn(f);
    const statementRuns = await batch(f, CAS);
    const commands = (id: string): string => `/api/v1/extraction/runs/${id}/commands`;
    const boardBefore = await boardRow(f, 'INV-0007');

    for (const fileName of [
      written.get('linked')?.fileName,
      fundStatementName(fundOf('INV-0007').name),
    ]) {
      const run = statementRuns.find((r) => r.fileName === fileName);
      if (run === undefined) throw new Error(`no run for ${fileName}`);
      await ok(f, 'ops.one', 'POST', commands(run.id), { command: 'acceptClean' });
      const approved = extractionRunDetail.parse(
        await ok(f, 'ops.one', 'POST', commands(run.id), { command: 'approve' }),
      );
      expect(approved.run.approvedBy, fileName).toBe('Test Operator');
      expect(approved.run.approvedAt, fileName).not.toBeNull();
      expect(approved.run.promotedRecordId, fileName).toBeNull();
      const again = await send(f, 'ops.one', 'POST', commands(run.id), { command: 'approve' });
      expect(again.status).toBe(409);
      expect(problemDetails.parse(again.json).detail).toBe(
        'extraction: the run is already approved and promoted',
      );
    }
    // Nothing was promoted: no quarter of the session, for the position or any other.
    expect(state.promotedQuarters.size).toBe(0);
    expect(state.promotedQuarters.has(quarterKey(investment('INV-0007').id, quarter))).toBe(false);
    expect(state.audit.some((entry) => entry.action === 'quarterly_performance.promote')).toBe(
      false,
    );
    expect(await boardRow(f, 'INV-0007')).toEqual(boardBefore);
  });

  it('still refuses a statement run whose period end is not accepted', async () => {
    const { f } = setup();
    await index(f);
    await extractionOn(f);
    const statementRuns = await batch(f, CAS);
    const run = statementRuns.find((r) => r.fileName === written.get('byName')?.fileName);
    const refused = await send(
      f,
      'ops.one',
      'POST',
      `/api/v1/extraction/runs/${run?.id}/commands`,
      {
        command: 'approve',
      },
    );
    expect(refused.status).toBe(409);
    expect(problemDetails.parse(refused.json).detail).toBe(
      'extraction: Period end is required and not accepted or edited',
    );
  });
});
