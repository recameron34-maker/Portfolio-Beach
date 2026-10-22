import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';
import {
  csvText,
  docTypeCode,
  documentCommandBody,
  documentDefinitions,
  documentDetail,
  documentIndexResult,
  documentListQuery,
  documentPages,
  documentSummary,
  expectedDocument,
  expectedDocumentGenerateBody,
  expectedDocumentGenerateResult,
  expectedDocumentListQuery,
  extractedValue,
  extractionBatch,
  extractionBatchBody,
  extractionDefinitions,
  extractionRun,
  extractionRunCommandBody,
  extractionRunDetail,
  extractionRunListQuery,
  MONEY_UNITS,
  monitoringBoard,
  monitoringBoardQuery,
  monitoringBoardRow,
  quarterEndDate,
  realizationOutlookBody,
  realizationOutlookDetail,
  valueFitsUnit,
} from './schemas.js';

const DOC = 'a0000000-0000-4000-8000-000000000001';
const RUN = 'a0000000-0000-4000-8000-000000000005';
const INV = '30000000-0000-4000-8000-000000000001';
const FUND = '20000000-0000-4000-8000-000000000002';
const SPONSOR = '20000000-0000-4000-8000-000000000001';

const summary = {
  id: DOC,
  title: 'Saltmarsh Holdings quarterly report Q2 2024',
  fileName: '2024-06-30 Harborlight Fund IV - Quarterly financials - Saltmarsh Holdings.pdf',
  folder: 'inbox',
  docType: 'doc_type.quarterly_financials',
  reviewStatus: 'Classified',
  sponsorId: SPONSOR,
  sponsorFundId: FUND,
  sponsorFundName: 'Harborlight Fund IV',
  investmentId: INV,
  investmentNumber: 'INV-0001',
  companyName: 'Saltmarsh Holdings',
  periodEnd: '2024-06-30',
  confidentiality: 'confidential',
  contentHash: 'a'.repeat(64),
  sizeBytes: 20480,
  pageCount: 4,
  receivedAt: '2024-08-10T09:00:00.000Z',
  indexedAt: '2024-08-12T09:00:00.000Z',
  classificationConfidence: '0.97',
  classifierEvidence: { keywords: ['quarterly report'], candidates: [{ reason: 'near miss' }] },
  classifiedBy: null,
  classifiedAt: '2024-08-12T09:00:01.000Z',
  duplicateOfId: null,
  latestRun: { id: RUN, state: 'Succeeded' },
};

const value = {
  id: 'a0000000-0000-4000-8000-000000000007',
  field: 'revenue_ltm',
  label: 'LTM revenue',
  kind: 'money',
  required: true,
  value: '120.00',
  unit: 'USD_M',
  page: 2,
  quote: 'LTM revenue 120.00',
  confidence: '0.95',
  validationState: 'clean',
  findings: [],
  decision: null,
  editedValue: null,
  editedUnit: null,
  decidedBy: null,
  decidedAt: null,
};

const run = {
  id: RUN,
  documentId: DOC,
  documentTitle: summary.title,
  fileName: summary.fileName,
  investmentId: INV,
  investmentNumber: 'INV-0001',
  companyName: 'Saltmarsh Holdings',
  periodEnd: '2024-06-30',
  schemaId: 'quarterly_financials',
  promptId: 'quarterly_extraction',
  promptVersion: '1',
  modelId: 'mock',
  state: 'Succeeded',
  batchId: null,
  tokensIn: 1200,
  tokensOut: 300,
  costUsd: '0.0081',
  startedAt: '2024-08-12T10:00:00.000Z',
  finishedAt: '2024-08-12T10:00:05.000Z',
  errorCode: null,
  errorKind: null,
  schemaRetries: 0,
  transientRetries: 0,
  requestedBy: 'Operations One',
  approvedBy: null,
  approvedAt: null,
  promotedRecordId: null,
  counts: { values: 15, clean: 13, flagged: 1, invalid: 1, decided: 0 },
  rowVersion: 1,
};

const expected = {
  id: 'a0000000-0000-4000-8000-000000000003',
  investmentId: INV,
  investmentNumber: 'INV-0001',
  companyName: 'Saltmarsh Holdings',
  sponsorFundId: null,
  sponsorFundName: null,
  periodEnd: '2024-06-30',
  docType: 'doc_type.quarterly_financials',
  dueDate: '2024-08-14',
  receivedDocumentId: DOC,
  status: 'received',
  ageDays: -4,
};

const boardRow = {
  investmentId: INV,
  investmentNumber: 'INV-0001',
  companyName: 'Saltmarsh Holdings',
  vehicleName: 'Beach Co-Invest Fund I',
  sponsorFundName: 'Harborlight Fund IV',
  dealType: 'deal_type.co_invest_equity',
  periodEnd: '2024-06-30',
  expectedDocumentId: expected.id,
  documentStatus: 'received',
  dueDate: '2024-08-14',
  ageDays: -4,
  documentId: DOC,
  runId: RUN,
  runState: 'Succeeded',
  flagsCount: 2,
  approval: 'pending',
  approvedAt: null,
};

const operation = (method: string, path: string): Record<string, unknown> => {
  const op = buildOpenApi('0.1.0').paths[path]?.[method] as Record<string, unknown> | undefined;
  if (op === undefined) throw new Error(`no ${method.toUpperCase()} ${path}`);
  return op;
};

describe('quarter ends', () => {
  it('accepts the four quarter ends and refuses any other day, with one plain message', () => {
    for (const day of ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31', '2000-12-31']) {
      expect(quarterEndDate.safeParse(day).success, day).toBe(true);
    }
    for (const day of ['2024-06-29', '2024-02-29', '2024-07-01', '2024-12-30']) {
      const result = quarterEndDate.safeParse(day);
      expect(result.success, day).toBe(false);
      expect(result.error?.issues.map((i) => i.message)).toEqual(['Not a quarter end']);
    }
    // An impossible date is reported once, as a date, never as a quarter end.
    const impossible = quarterEndDate.safeParse('2024-06-31');
    expect(impossible.success).toBe(false);
    expect(impossible.error?.issues.map((i) => i.message)).toEqual(['Not a real calendar date']);
  });
});

describe('documents', () => {
  it('names a document type by its taxonomy code', () => {
    expect(docTypeCode.safeParse('doc_type.quarterly_financials').success).toBe(true);
    expect(docTypeCode.safeParse('doc_type.k1').success).toBe(true);
    expect(docTypeCode.safeParse('sector.software').success).toBe(false);
    expect(docTypeCode.safeParse('doc_type.K-1').success).toBe(false);
    expect(docTypeCode.safeParse('quarterly_financials').success).toBe(false);
  });

  it('carries metadata, links, evidence and the latest run, with confidence as decimal text', () => {
    expect(documentSummary.safeParse(summary).success).toBe(true);
    expect(
      documentSummary.safeParse({
        ...summary,
        docType: null,
        reviewStatus: 'NeedsReview',
        sponsorId: null,
        sponsorFundId: null,
        sponsorFundName: null,
        investmentId: null,
        investmentNumber: null,
        companyName: null,
        periodEnd: null,
        pageCount: null,
        classificationConfidence: '0.6',
        classifiedAt: null,
        latestRun: null,
      }).success,
    ).toBe(true);
    expect(documentSummary.safeParse({ ...summary, classificationConfidence: 0.97 }).success).toBe(
      false,
    );
    expect(documentSummary.safeParse({ ...summary, reviewStatus: 'Pending' }).success).toBe(false);
    expect(documentSummary.safeParse({ ...summary, confidentiality: 'public' }).success).toBe(
      false,
    );
    expect(documentSummary.safeParse({ ...summary, periodEnd: '2024-06-31' }).success).toBe(false);
    expect(
      documentSummary.safeParse({ ...summary, latestRun: { id: RUN, state: 'Done' } }).success,
    ).toBe(false);
    // Evidence names candidates by reason only, never by value.
    expect(
      documentSummary.safeParse({
        ...summary,
        classifierEvidence: { keywords: [], candidates: [{ reason: 'x', value: '1' }] },
      }).success,
    ).toBe(true);
    const { latestRun: _run, ...withoutRun } = summary;
    expect(documentSummary.safeParse(withoutRun).success).toBe(false);
  });

  it('gives the detail its duplicates and the pages route its lines per page', () => {
    expect(documentDetail.safeParse(summary).success).toBe(false);
    expect(
      documentDetail.safeParse({
        ...summary,
        duplicates: [
          {
            id: 'a0000000-0000-4000-8000-000000000002',
            fileName: 'copy.pdf',
            folder: 'inbox',
            indexedAt: '2024-08-13T09:00:00.000Z',
            reviewStatus: 'Duplicate',
          },
        ],
      }).success,
    ).toBe(true);
    const pages = { documentId: DOC, pageCount: 1, pages: [{ number: 1, lines: ['Letter'] }] };
    expect(documentPages.safeParse(pages).success).toBe(true);
    expect(documentPages.safeParse({ ...pages, pages: [{ number: 0, lines: [] }] }).success).toBe(
      false,
    );
    expect(documentPages.safeParse({ ...pages, pages: [{ number: 1, lines: 'x' }] }).success).toBe(
      false,
    );
  });

  it('filters the list by query, type, status, links and period, and refuses unknown fields', () => {
    const query = documentListQuery.parse({
      q: 'quarterly',
      docType: 'doc_type.quarterly_financials',
      reviewStatus: 'Classified',
      investmentId: INV,
      sponsorFundId: FUND,
      periodEnd: '2024-06-30',
    });
    expect(query.limit).toBe(50);
    expect(query.q).toBe('quarterly');
    expect(documentListQuery.safeParse({ q: `a${String.fromCharCode(0)}` }).success).toBe(false);
    expect(documentListQuery.safeParse({ q: '' }).success).toBe(false);
    expect(documentListQuery.safeParse({ docType: 'sector.software' }).success).toBe(false);
    expect(documentListQuery.safeParse({ reviewStatus: 'Pending' }).success).toBe(false);
    expect(documentListQuery.safeParse({ periodEnd: '2024-02-30' }).success).toBe(false);
    expect(documentListQuery.safeParse({ title: 'x' }).success).toBe(false);
    expect(documentListQuery.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('counts what a scan of the store did', () => {
    expect(
      documentIndexResult.safeParse({ indexed: 3, duplicates: 1, unchanged: 40 }).success,
    ).toBe(true);
    expect(documentIndexResult.safeParse({ indexed: 3, duplicates: 1 }).success).toBe(false);
    expect(
      documentIndexResult.safeParse({ indexed: '3', duplicates: 1, unchanged: 0 }).success,
    ).toBe(false);
  });

  it("takes a person's classify command and no other", () => {
    expect(
      documentCommandBody.safeParse({ command: 'classify', docType: 'doc_type.capital_call' })
        .success,
    ).toBe(true);
    const full = documentCommandBody.parse({
      command: 'classify',
      docType: 'doc_type.quarterly_financials',
      investmentId: INV,
      sponsorFundId: FUND,
      periodEnd: '2024-06-30',
      reason: 'Title names the company',
    });
    expect(full.command).toBe('classify');
    expect(documentCommandBody.safeParse({ command: 'classify' }).success).toBe(false);
    expect(
      documentCommandBody.safeParse({ command: 'classify', docType: 'sector.software' }).success,
    ).toBe(false);
    expect(
      documentCommandBody.safeParse({
        command: 'classify',
        docType: 'doc_type.other',
        periodEnd: '2024-06-31',
      }).success,
    ).toBe(false);
    expect(
      documentCommandBody.safeParse({ command: 'classify', docType: 'doc_type.other', force: true })
        .success,
    ).toBe(false);
    // The service's own transitions never arrive through the body.
    for (const command of ['autoClassify', 'flagForReview', 'markDuplicate', 'delete'])
      expect(documentCommandBody.safeParse({ command }).success, command).toBe(false);
  });
});

describe('expected documents', () => {
  it('carries the derived status and the age in days, negative while not yet due', () => {
    expect(expectedDocument.safeParse(expected).success).toBe(true);
    expect(
      expectedDocument.safeParse({
        ...expected,
        investmentId: null,
        investmentNumber: null,
        companyName: null,
        sponsorFundId: FUND,
        sponsorFundName: 'Harborlight Fund IV',
        docType: 'doc_type.capital_account_statement',
        receivedDocumentId: null,
        status: 'missing',
        ageDays: 80,
      }).success,
    ).toBe(true);
    expect(expectedDocument.safeParse({ ...expected, status: 'overdue' }).success).toBe(false);
    expect(expectedDocument.safeParse({ ...expected, ageDays: '4' }).success).toBe(false);
    expect(expectedDocument.safeParse({ ...expected, dueDate: '2024-08-32' }).success).toBe(false);
    const { ageDays: _age, ...withoutAge } = expected;
    expect(expectedDocument.safeParse(withoutAge).success).toBe(false);
  });

  it('lists by period, status, links and the as-of day, and generates for a quarter end only', () => {
    expect(
      expectedDocumentListQuery.parse({
        periodEnd: '2024-06-30',
        status: 'late',
        investmentId: INV,
        asOf: '2024-09-15',
      }).status,
    ).toBe('late');
    expect(expectedDocumentListQuery.safeParse({ status: 'overdue' }).success).toBe(false);
    expect(expectedDocumentListQuery.safeParse({ asOf: '2024-13-01' }).success).toBe(false);
    expect(expectedDocumentListQuery.safeParse({ docType: 'doc_type.other' }).success).toBe(false);
    expect(expectedDocumentGenerateBody.safeParse({ periodEnd: '2024-06-30' }).success).toBe(true);
    const midQuarter = expectedDocumentGenerateBody.safeParse({ periodEnd: '2024-06-15' });
    expect(midQuarter.success).toBe(false);
    expect(midQuarter.error?.issues.map((i) => i.path.join('.'))).toEqual(['periodEnd']);
    expect(expectedDocumentGenerateBody.safeParse({}).success).toBe(false);
    expect(
      expectedDocumentGenerateBody.safeParse({ periodEnd: '2024-06-30', force: true }).success,
    ).toBe(false);
    expect(
      expectedDocumentGenerateResult.safeParse({
        periodEnd: '2024-06-30',
        created: 12,
        existing: 3,
      }).success,
    ).toBe(true);
    expect(
      expectedDocumentGenerateResult.safeParse({ periodEnd: '2024-06-30', created: 12 }).success,
    ).toBe(false);
  });
});

describe('extraction', () => {
  it('knows which values fit which unit', () => {
    expect(MONEY_UNITS).toEqual(['USD', 'USD_K', 'USD_M', 'USD_B']);
    expect(valueFitsUnit('120.00', 'USD_M')).toBe(true);
    expect(valueFitsUnit('-3.5', 'USD')).toBe(true);
    expect(valueFitsUnit('120,000', 'USD_K')).toBe(false);
    expect(valueFitsUnit('abc', 'USD_B')).toBe(false);
    expect(valueFitsUnit('0.4250', 'PCT')).toBe(true);
    expect(valueFitsUnit('42.5%', 'PCT')).toBe(false);
    expect(valueFitsUnit('412', 'COUNT')).toBe(true);
    expect(valueFitsUnit('412.0', 'COUNT')).toBe(false);
    expect(valueFitsUnit('2024-06-30', 'DATE')).toBe(true);
    expect(valueFitsUnit('2024-06-31', 'DATE')).toBe(false);
  });

  it('keeps every value with its citation, confidence, verdict and decision', () => {
    expect(extractedValue.safeParse(value).success).toBe(true);
    expect(
      extractedValue.safeParse({
        ...value,
        value: null,
        unit: null,
        page: null,
        quote: null,
        confidence: null,
        validationState: 'invalid',
        findings: [
          { ruleId: 'EXT-REQ-01', severity: 'invalid', message: 'A required field is missing' },
        ],
        decision: 'edited',
        editedValue: '118.50',
        editedUnit: 'USD_K',
        decidedBy: 'Deal Team One',
        decidedAt: '2024-08-13T09:00:00.000Z',
      }).success,
    ).toBe(true);
    // The edit's own unit is a key of its own, beside the model's (WF-1, migration 0012).
    const { editedUnit: _omitted, ...withoutEditedUnit } = value;
    expect(extractedValue.safeParse(withoutEditedUnit).success).toBe(false);
    expect(extractedValue.safeParse({ ...value, editedUnit: 'EUR' }).success).toBe(false);
    expect(extractedValue.safeParse({ ...value, quote: 'x'.repeat(151) }).success).toBe(false);
    expect(extractedValue.safeParse({ ...value, quote: 'x'.repeat(150) }).success).toBe(true);
    expect(extractedValue.safeParse({ ...value, page: 0 }).success).toBe(false);
    expect(extractedValue.safeParse({ ...value, confidence: 0.95 }).success).toBe(false);
    expect(extractedValue.safeParse({ ...value, unit: 'EUR' }).success).toBe(false);
    expect(extractedValue.safeParse({ ...value, kind: 'text' }).success).toBe(false);
    expect(extractedValue.safeParse({ ...value, decision: 'approved' }).success).toBe(false);
    expect(
      extractedValue.safeParse({
        ...value,
        findings: [{ ruleId: 'EXT-CONF-01', severity: 'warning', message: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('keeps a run with its bookkeeping, cost as decimal text and the counts of its values', () => {
    expect(extractionRun.safeParse(run).success).toBe(true);
    expect(
      extractionRun.safeParse({
        ...run,
        state: 'Failed',
        errorCode: 'schema_invalid',
        errorKind: 'schema',
        schemaRetries: 1,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        finishedAt: null,
      }).success,
    ).toBe(true);
    expect(extractionRun.safeParse({ ...run, costUsd: 0.0081 }).success).toBe(false);
    expect(extractionRun.safeParse({ ...run, state: 'Done' }).success).toBe(false);
    expect(extractionRun.safeParse({ ...run, errorKind: 'fatal' }).success).toBe(false);
    expect(extractionRun.safeParse({ ...run, periodEnd: '2024-06-31' }).success).toBe(false);
    const { counts: _counts, ...withoutCounts } = run;
    expect(extractionRun.safeParse(withoutCounts).success).toBe(false);
  });

  it('answers the review page with the run, its document, values, drafts and page layouts', () => {
    const detail = {
      run,
      document: summary,
      values: [value],
      highlights: ['Revenue grew with the new contract.'],
      commentary: null,
      pages: [
        {
          number: 1,
          width: 612,
          height: 792,
          runs: [{ x: 72, y: 700.5, size: 11, text: 'LTM revenue 120.00' }],
        },
      ],
    };
    expect(extractionRunDetail.safeParse(detail).success).toBe(true);
    expect(extractionRunDetail.safeParse({ ...detail, pages: [] }).success).toBe(true);
    expect(extractionRunDetail.safeParse({ ...run, document: summary }).success).toBe(false);
    expect(
      extractionRunDetail.safeParse({
        ...detail,
        pages: [{ number: 1, width: 612, height: 792, runs: [{ x: 1, y: 2, text: 'no size' }] }],
      }).success,
    ).toBe(false);
    const { highlights: _h, ...withoutHighlights } = detail;
    expect(extractionRunDetail.safeParse(withoutHighlights).success).toBe(false);
  });

  it('lists runs by state, document, investment and batch, newest first', () => {
    expect(
      extractionRunListQuery.parse({ state: 'NeedsRetry', documentId: DOC, investmentId: INV })
        .state,
    ).toBe('NeedsRetry');
    expect(extractionRunListQuery.safeParse({ batchId: RUN }).success).toBe(true);
    expect(extractionRunListQuery.safeParse({ state: 'Done' }).success).toBe(false);
    expect(extractionRunListQuery.safeParse({ documentId: 'doc-1' }).success).toBe(false);
    expect(extractionRunListQuery.safeParse({ schemaId: 'x' }).success).toBe(false);
  });

  it('starts a batch from named documents or from a type and quarter, never both or neither', () => {
    expect(extractionBatchBody.safeParse({ documentIds: [DOC] }).success).toBe(true);
    expect(
      extractionBatchBody.safeParse({
        periodEnd: '2024-06-30',
        docType: 'doc_type.quarterly_financials',
      }).success,
    ).toBe(true);
    expect(extractionBatchBody.safeParse({ documentIds: [] }).success).toBe(false);
    expect(extractionBatchBody.safeParse({ documentIds: ['x'] }).success).toBe(false);
    expect(
      extractionBatchBody.safeParse({ periodEnd: '2024-06-15', docType: 'doc_type.other' }).success,
    ).toBe(false);
    expect(extractionBatchBody.safeParse({ periodEnd: '2024-06-30' }).success).toBe(false);
    expect(
      extractionBatchBody.safeParse({
        documentIds: [DOC],
        periodEnd: '2024-06-30',
        docType: 'doc_type.other',
      }).success,
    ).toBe(false);
    expect(extractionBatchBody.safeParse({}).success).toBe(false);
    const batch = {
      id: 'a0000000-0000-4000-8000-00000000000b',
      state: 'running',
      progress: 50,
      requestedBy: 'Operations One',
      createdAt: '2024-08-12T10:00:00.000Z',
      startedAt: '2024-08-12T10:00:01.000Z',
      finishedAt: null,
      errorCode: null,
      runs: { total: 2, queued: 0, running: 1, succeeded: 1, failed: 0, needsRetry: 0 },
      tokensIn: 1200,
      tokensOut: 300,
      costUsd: '0.0081',
    };
    expect(extractionBatch.safeParse(batch).success).toBe(true);
    expect(extractionBatch.safeParse({ ...batch, progress: 101 }).success).toBe(false);
    expect(extractionBatch.safeParse({ ...batch, state: 'Running' }).success).toBe(false);
    expect(extractionBatch.safeParse({ ...batch, costUsd: 0.0081 }).success).toBe(false);
  });

  it('takes the six review commands and refuses any other, with the field key checked', () => {
    const body = extractionRunCommandBody();
    expect(body.safeParse({ command: 'accept', field: 'revenue_ltm' }).success).toBe(true);
    expect(body.safeParse({ command: 'reject', field: 'ebitda_ltm' }).success).toBe(true);
    expect(
      body.safeParse({ command: 'reject', field: 'ebitda_ltm', reason: 'Not in the report' })
        .success,
    ).toBe(true);
    expect(body.safeParse({ command: 'reject', field: 'ebitda_ltm', reason: 'no' }).success).toBe(
      false,
    );
    expect(body.safeParse({ command: 'acceptClean' }).success).toBe(true);
    expect(body.safeParse({ command: 'approve' }).success).toBe(true);
    expect(body.safeParse({ command: 'approve', reason: 'Reviewed every flag' }).success).toBe(
      true,
    );
    expect(body.safeParse({ command: 'retry' }).success).toBe(true);
    expect(body.safeParse({ command: 'accept' }).success).toBe(false);
    expect(body.safeParse({ command: 'accept', field: 'Revenue LTM' }).success).toBe(false);
    expect(body.safeParse({ command: 'accept', field: 'revenue_ltm', reason: 'x' }).success).toBe(
      false,
    );
    expect(body.safeParse({ command: 'acceptClean', field: 'revenue_ltm' }).success).toBe(false);
    expect(body.safeParse({ command: 'retry', field: 'revenue_ltm' }).success).toBe(false);
    for (const command of ['promote', 'start', 'succeed', 'fail', 'delete'])
      expect(body.safeParse({ command }).success, command).toBe(false);
    expect(body.safeParse({}).success).toBe(false);
  });

  it('needs a value to edit, a value that fits the unit, and a money unit on a money field', () => {
    const documented = extractionRunCommandBody();
    expect(
      documented.safeParse({
        command: 'edit',
        field: 'revenue_ltm',
        value: '118.50',
        unit: 'USD_M',
      }).success,
    ).toBe(true);
    // The route table documents the shape without the schema's money fields.
    expect(
      documented.safeParse({ command: 'edit', field: 'revenue_ltm', value: '118.50' }).success,
    ).toBe(true);
    const blank = documented.safeParse({ command: 'edit', field: 'revenue_ltm', value: '   ' });
    expect(blank.success).toBe(false);
    expect(blank.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'value: A value is required',
    ]);
    expect(documented.safeParse({ command: 'edit', field: 'revenue_ltm' }).success).toBe(false);
    const misfit = documented.safeParse({
      command: 'edit',
      field: 'revenue_ltm',
      value: '118.5m',
      unit: 'USD_M',
    });
    expect(misfit.success).toBe(false);
    expect(misfit.error?.issues.map((i) => i.message)).toEqual(['The value does not fit the unit']);
    expect(
      documented.safeParse({
        command: 'edit',
        field: 'period_end',
        value: '2024-06-31',
        unit: 'DATE',
      }).success,
    ).toBe(false);
    expect(
      documented.safeParse({ command: 'edit', field: 'headcount', value: '412', unit: 'COUNT' })
        .success,
    ).toBe(true);
    expect(
      documented.safeParse({ command: 'edit', field: 'revenue_ltm', value: '1', unit: 'EUR' })
        .success,
    ).toBe(false);
    // The API builds the body with the money fields of the run's schema (config over code).
    const configured = extractionRunCommandBody(['revenue_ltm', 'ebitda_ltm']);
    expect(
      configured.safeParse({
        command: 'edit',
        field: 'revenue_ltm',
        value: '118.50',
        unit: 'USD_M',
      }).success,
    ).toBe(true);
    const noUnit = configured.safeParse({ command: 'edit', field: 'revenue_ltm', value: '118.50' });
    expect(noUnit.success).toBe(false);
    expect(noUnit.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'unit: A money edit needs a money unit',
    ]);
    expect(
      configured.safeParse({ command: 'edit', field: 'ebitda_ltm', value: '0.25', unit: 'PCT' })
        .success,
    ).toBe(false);
    expect(
      configured.safeParse({
        command: 'edit',
        field: 'sponsor_ownership_pct',
        value: '0.25',
        unit: 'PCT',
      }).success,
    ).toBe(true);
    expect(
      configured.safeParse({ command: 'edit', field: 'headcount', value: '412' }).success,
    ).toBe(true);
  });
});

describe('monitoring', () => {
  it('shows per investment and quarter the expected report, the run and the approval', () => {
    expect(monitoringBoardRow.safeParse(boardRow).success).toBe(true);
    expect(
      monitoringBoardRow.safeParse({
        ...boardRow,
        sponsorFundName: null,
        expectedDocumentId: null,
        documentStatus: 'missing',
        dueDate: null,
        ageDays: null,
        documentId: null,
        runId: null,
        runState: null,
        flagsCount: 0,
        approval: 'none',
      }).success,
    ).toBe(true);
    expect(monitoringBoardRow.safeParse({ ...boardRow, approval: 'done' }).success).toBe(false);
    expect(monitoringBoardRow.safeParse({ ...boardRow, documentStatus: 'open' }).success).toBe(
      false,
    );
    expect(monitoringBoardRow.safeParse({ ...boardRow, flagsCount: '2' }).success).toBe(false);
    const board = {
      asOf: '2024-08-20',
      periodEnd: '2024-06-30',
      rows: [boardRow],
      counts: { expected: 0, received: 1, late: 0, missing: 0, inReview: 1, approved: 0 },
    };
    expect(monitoringBoard.safeParse(board).success).toBe(true);
    expect(monitoringBoard.safeParse({ ...board, counts: { received: 1 } }).success).toBe(false);
  });

  it('takes a quarter end and an as-of day for the board, and documents the export as CSV', () => {
    expect(monitoringBoardQuery.parse({}).periodEnd).toBeUndefined();
    expect(
      monitoringBoardQuery.safeParse({ periodEnd: '2024-06-30', asOf: '2024-08-20' }).success,
    ).toBe(true);
    expect(monitoringBoardQuery.safeParse({ periodEnd: '2024-06-15' }).success).toBe(false);
    expect(monitoringBoardQuery.safeParse({ asOf: '2024-02-30' }).success).toBe(false);
    expect(monitoringBoardQuery.safeParse({ limit: 50 }).success).toBe(false);
    expect(
      csvText.safeParse('investmentNumber,companyName\nINV-0001,Saltmarsh Holdings\n').success,
    ).toBe(true);
    expect(csvText.safeParse(['a', 'b']).success).toBe(false);
    const op = operation('get', '/api/v1/monitoring/board/export') as {
      responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
    };
    expect(Object.keys(op.responses['200']?.content ?? {})).toEqual(['text/csv']);
    expect(op.responses['200']?.content['text/csv']?.schema.type).toBe('string');
    expect(op.responses['200']?.content['text/csv']?.schema.contentMediaType).toBe('text/csv');
    const board = operation('get', '/api/v1/monitoring/board') as {
      responses: Record<string, { content: Record<string, unknown> }>;
    };
    expect(Object.keys(board.responses['200']?.content ?? {})).toEqual(['application/json']);
  });

  it('sets the realization outlook by hand with a horizon, a note and a reason', () => {
    const detail = {
      investmentId: INV,
      investmentNumber: 'INV-0001',
      companyName: 'Saltmarsh Holdings',
      outlook: 'partial',
      horizonMonths: 18,
      note: 'Sponsor is running a process for a minority stake',
      setBy: 'Deal Team One',
      setAt: '2024-08-20T09:00:00.000Z',
    };
    expect(realizationOutlookDetail.safeParse(detail).success).toBe(true);
    expect(
      realizationOutlookDetail.safeParse({
        ...detail,
        outlook: 'none',
        note: null,
        setBy: null,
        setAt: null,
      }).success,
    ).toBe(true);
    expect(
      realizationOutlookDetail.safeParse({ ...detail, outlook: 'realization_outlook.partial' })
        .success,
    ).toBe(false);
    const body = { outlook: 'full', horizonMonths: 12, note: null, reason: 'Signed agreement' };
    expect(realizationOutlookBody.safeParse(body).success).toBe(true);
    expect(
      realizationOutlookBody.safeParse({ ...body, note: 'Expected to close in Q4' }).success,
    ).toBe(true);
    expect(realizationOutlookBody.safeParse({ ...body, horizonMonths: 0 }).success).toBe(false);
    expect(realizationOutlookBody.safeParse({ ...body, horizonMonths: 121 }).success).toBe(false);
    expect(realizationOutlookBody.safeParse({ ...body, horizonMonths: 12.5 }).success).toBe(false);
    expect(realizationOutlookBody.safeParse({ ...body, reason: 'ok' }).success).toBe(false);
    expect(realizationOutlookBody.safeParse({ ...body, outlook: 'likely' }).success).toBe(false);
    const { note: _note, ...withoutNote } = body;
    expect(realizationOutlookBody.safeParse(withoutNote).success).toBe(false);
    const { reason: _reason, ...withoutReason } = body;
    expect(realizationOutlookBody.safeParse(withoutReason).success).toBe(false);
    expect(realizationOutlookBody.safeParse({ ...body, setBy: 'me' }).success).toBe(false);
  });
});

describe('config blocks (rule 9: config over code)', () => {
  const definitions = JSON.parse(
    readFileSync(new URL('../../../config/definitions.json', import.meta.url), 'utf8'),
  ) as { documents: unknown; extraction: unknown };

  it('reads the documents and extraction blocks of config/definitions.json as committed', () => {
    const documents = documentDefinitions.parse(definitions.documents);
    expect(documents.expectedDueDaysAfterQuarterEnd).toBe(45);
    expect(documents.lateAfterDays).toBeLessThan(documents.missingAfterDays);
    const extraction = extractionDefinitions.parse(definitions.extraction);
    expect(extraction.costPerThousandTokensUsd).toEqual({ in: '0.003', out: '0.015' });
    expect(extraction.quoteMaxChars).toBe(150);
    expect(extraction.schemaRetries).toBe(1);
    expect(extraction.transientRetries).toBe(3);
  });

  it('refuses a block that is inconsistent, uses floats for money or carries an unknown key', () => {
    const documents = documentDefinitions.parse(definitions.documents);
    expect(documentDefinitions.safeParse({ ...documents, missingAfterDays: 15 }).success).toBe(
      false,
    );
    expect(documentDefinitions.safeParse({ ...documents, searchPageSize: 0 }).success).toBe(false);
    expect(documentDefinitions.safeParse({ ...documents, maxPages: '200' }).success).toBe(false);
    expect(documentDefinitions.safeParse({ ...documents, semanticSearch: true }).success).toBe(
      false,
    );
    const extraction = extractionDefinitions.parse(definitions.extraction);
    expect(
      extractionDefinitions.safeParse({
        ...extraction,
        costPerThousandTokensUsd: { in: 0.003, out: '0.015' },
      }).success,
    ).toBe(false);
    expect(
      extractionDefinitions.safeParse({ ...extraction, confidenceFlagBelow: 1.5 }).success,
    ).toBe(false);
    expect(extractionDefinitions.safeParse({ ...extraction, quoteMaxChars: 151 }).success).toBe(
      false,
    );
    expect(extractionDefinitions.safeParse({ ...extraction, batchConcurrency: 0 }).success).toBe(
      false,
    );
    expect(extractionDefinitions.safeParse({ ...extraction, model: 'x' }).success).toBe(false);
  });
});

describe('routes', () => {
  it('documents every document, extraction and monitoring route with the roles the brief fixes', () => {
    const roles = (method: string, path: string): string[] | undefined =>
      operation(method, `/api/v1${path}`)['x-roles'] as string[] | undefined;
    for (const [method, path] of [
      ['get', '/documents'],
      ['get', '/documents/review-queue'],
      ['get', '/documents/{id}'],
      ['get', '/documents/{id}/pages'],
      ['get', '/expected-documents'],
      ['get', '/extraction/batches'],
      ['get', '/extraction/runs'],
      ['get', '/extraction/runs/{id}'],
      ['get', '/monitoring/board'],
      ['get', '/monitoring/board/export'],
      ['get', '/monitoring/outlook/{investmentId}'],
    ] as const) {
      // Any authenticated user: row-level security filters what comes back.
      expect(roles(method, path), `${method} ${path}`).toBeUndefined();
      expect(operation(method, `/api/v1${path}`).security).toEqual([{ bearer: [] }]);
    }
    expect(roles('post', '/documents/index')).toEqual(['operations']);
    expect(roles('post', '/documents/{id}/commands')).toEqual(['deal_team', 'operations']);
    expect(roles('post', '/expected-documents/generate')).toEqual(['operations']);
    expect(roles('post', '/extraction/batches')).toEqual(['operations']);
    expect(roles('post', '/extraction/runs/{id}/commands')).toEqual(['deal_team', 'operations']);
    expect(roles('put', '/monitoring/outlook/{investmentId}')).toEqual(['deal_team']);
    const generate = ROUTES.find((r) => r.path.endsWith('/expected-documents/generate'));
    expect(generate?.responseStatus).toBe(201);
    const batches = ROUTES.find(
      (r) => r.method === 'POST' && r.path.endsWith('/extraction/batches'),
    );
    expect(batches?.responseStatus).toBe(201);
    // The index scan takes no body; the commands do.
    expect(operation('post', '/api/v1/documents/index').requestBody).toBeUndefined();
    expect(operation('post', '/api/v1/documents/{id}/commands').requestBody).toBeDefined();
    expect(operation('post', '/api/v1/extraction/runs/{id}/commands').requestBody).toBeDefined();
  });
});
