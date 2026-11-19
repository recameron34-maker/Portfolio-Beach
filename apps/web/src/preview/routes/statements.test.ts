import { beforeEach, describe, expect, it } from 'vitest';
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
import {
  STATEMENT_EXAMPLES,
  STATEMENT_FIELDS,
  SYNTHETIC_DOC_TYPES,
  generateDataset,
  generateDocuments,
  positionStatementDocument,
  previewBook,
} from '@pb/synthetic';
import type { DocumentSet, SyntheticDocument } from '@pb/synthetic';
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
 * approving a statement run promotes nothing. The simulation runs with the statement schema of
 * config/extraction_schema.json over the seeded statements and over statements written beside
 * them with the generator's own builder.
 */

const QF = SYNTHETIC_DOC_TYPES.quarterlyFinancials;
const CAS = SYNTHETIC_DOC_TYPES.capitalAccountStatement;
const STATEMENT_SCHEMA_ID = 'capital_account_statement';

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
const numberOf = (scenario: string): string =>
  dataset.investments.find((i) => i.id === dataset.scenarios[scenario]?.[0])?.investmentNumber ??
  '';
const walledNumber = numberOf('walled_deal');
const staleNumber = numberOf('stale_valuation');
const fundStatementName = (fundName: string): string =>
  `${quarter} ${fundName} - Capital account statement.pdf`;
/** The seeded position-level statement of a position for the latest quarter. */
const seededName = (number: string): string =>
  generated.expectations.positionStatements.find(
    (p) => p.investmentNumber === number && p.periodEnd === quarter,
  )?.fileName ?? '';

const written = new Map<string, SyntheticDocument>();

/**
 * A position-level statement of the latest quarter written beside the set, from the fund and
 * the vehicle of a position, naming what the case asks, with the lines of docs/08 section 12,
 * example 1. Every one differs in its contributions to date, so none is a duplicate of another.
 */
function statement(
  key: string,
  from: string,
  names: { linkedTo: string | null; fileCompany: string; reference: string | null },
  contributionsToDate: string,
): void {
  const position = investment(from);
  const linked = names.linkedTo === null ? null : investment(names.linkedTo);
  written.set(
    key,
    positionStatementDocument({
      periodEnd: quarter,
      fund: fundOf(from),
      vehicleName: dataset.vehicles.find((v) => v.id === position.vehicleId)?.name ?? '',
      investment:
        linked === null
          ? null
          : {
              id: linked.id,
              investmentNumber: linked.investmentNumber,
              companyName: companyOf(linked.investmentNumber),
            },
      fileCompany: names.fileCompany,
      reference: names.reference,
      lines: { ...STATEMENT_EXAMPLES.ties.lines, contributionsToDate },
    }),
  );
}
const own = (number: string, reference: string | null) => ({
  linkedTo: number,
  fileCompany: companyOf(number),
  reference,
});

// Linked by the company in the file name alone.
statement('byName', 'INV-0002', own('INV-0002', null), '8.10');
// A position with no report for the quarter (late_financials).
statement('noReport', 'INV-0001', own('INV-0001', 'INV-0001'), '6.25');
// A name that links to nothing.
statement(
  'unknown',
  'INV-0002',
  { linkedTo: null, fileCompany: 'Northgate Holdco', reference: null },
  '3.30',
);
// A company two positions hold (the second position is added to the book below).
statement('twoPositions', 'INV-0005', { ...own('INV-0005', null), linkedTo: null }, '4.40');
// A reference that is no number on record, beside a name that links.
statement('badReference', 'INV-0003', own('INV-0003', 'INV-9999'), '5.50');
// A reference and a name that belong to two positions.
statement('disagree', 'INV-0004', { ...own('INV-0004', 'INV-0006'), linkedTo: 'INV-0006' }, '7.70');

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
    // The seeded position-level statements name their position twice over, and so do two here.
    const seeded = generated.expectations.positionStatements;
    expect(seeded.length).toBeGreaterThanOrEqual(6);
    for (const [fileName, number] of [
      ...seeded.map((p) => [p.fileName, p.investmentNumber] as const),
      [written.get('byName')?.fileName, 'INV-0002'] as const,
      [written.get('noReport')?.fileName, 'INV-0001'] as const,
    ]) {
      const found = everything.find((d) => d.fileName === fileName);
      expect(found?.reviewStatus, fileName).toBe('Classified');
      expect(found?.docType, fileName).toBe(CAS);
      expect(found?.investmentNumber, fileName).toBe(number);
    }
    const { notLinked, disagree } = STATEMENT_HOLD_REASONS;
    for (const [key, reason, linkedTo] of [
      ['unknown', notLinked, null],
      ['twoPositions', notLinked, null],
      ['badReference', notLinked, 'INV-0003'],
      ['disagree', disagree, 'INV-0006'],
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
      (d) => d.fileName === fundStatementName(fundOf(staleNumber).name),
    );
    expect(fundLevel?.reviewStatus).toBe('Classified');
    expect(fundLevel?.investmentId).toBeNull();
    // The walled position's statements are behind its wall.
    const outside = (await hub(f, 'ops.one')).map((d) => d.fileName);
    const walledStatements = seeded.filter((p) => p.investmentNumber === walledNumber);
    expect(walledStatements).toHaveLength(2);
    for (const p of walledStatements) expect(outside).not.toContain(p.fileName);
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
    for (const number of [staleNumber, walledNumber]) {
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
    const fundName = fundOf(staleNumber).name;
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
      linked: await boardRow(f, staleNumber),
      byName: await boardRow(f, 'INV-0002'),
      walled: await boardRow(f, walledNumber),
      noReport: await boardRow(f, 'INV-0001'),
    };
    expect(before.linked.runId).toBe(reportRunOf(staleNumber));
    expect(before.walled.runId).toBe(reportRunOf(walledNumber));
    expect(before.noReport.runId).toBeNull();

    const statementRuns = await batch(f, CAS);
    const everything = await hub(f, 'deal.three');
    for (const fileName of [
      seededName(staleNumber),
      seededName(walledNumber),
      written.get('byName')?.fileName,
      written.get('noReport')?.fileName,
    ]) {
      const run = statementRuns.find((r) => r.fileName === fileName);
      expect(run?.state, fileName).toBe('Succeeded');
      expect(run?.schemaId, fileName).toBe(STATEMENT_SCHEMA_ID);
      expect(run?.promptId, fileName).toBe('capital_account_extraction');
      expect(run?.investmentId, fileName).toBe(
        everything.find((d) => d.fileName === fileName)?.investmentId,
      );
      // The eleven lines of the schema are staged, and no narrative with them.
      expect(run?.counts.values, fileName).toBe(STATEMENT_FIELDS.length);
    }
    expect(await boardRow(f, staleNumber)).toEqual(before.linked);
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
    const boardBefore = await boardRow(f, staleNumber);

    for (const fileName of [seededName(staleNumber), fundStatementName(fundOf(staleNumber).name)]) {
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
    expect(state.promotedQuarters.has(quarterKey(investment(staleNumber).id, quarter))).toBe(false);
    expect(state.audit.some((entry) => entry.action === 'quarterly_performance.promote')).toBe(
      false,
    );
    expect(await boardRow(f, staleNumber)).toEqual(boardBefore);
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
