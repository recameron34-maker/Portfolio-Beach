import type {
  DocumentDetail,
  DocumentDuplicate,
  DocumentIndexResult,
  DocumentPage,
  DocumentPages,
  DocumentSummary,
  ExpectedDocument,
  ExpectedDocumentGenerateResult,
  ExpectedDocumentPage,
  Taxonomy,
} from '@pb/contracts';
import { ID } from '../../test/fixtures.js';
import { POSITION_ID } from '../../test/fixtures-valuations.js';
import { VS_ID } from '../../test/fixtures-vehicles-sponsors.js';

/* Contract-shaped synthetic fixtures for the documents pages (docs/12 section 4: synthetic data only). */

export const DOC_ID = {
  report: '00000000-0000-4000-8000-000000000901',
  scan: '00000000-0000-4000-8000-000000000902',
  copy: '00000000-0000-4000-8000-000000000903',
  statement: '00000000-0000-4000-8000-000000000904',
  notice: '00000000-0000-4000-8000-000000000905',
} as const;

export const RUN_ID_FIXTURE = '00000000-0000-4000-8000-000000000911';

export const EXPECTED_ID = {
  received: '00000000-0000-4000-8000-000000000921',
  late: '00000000-0000-4000-8000-000000000922',
  missing: '00000000-0000-4000-8000-000000000923',
  fund: '00000000-0000-4000-8000-000000000924',
} as const;

export const INDEXED_AT = '2025-07-01T09:15:00.000Z';
export const RECEIVED_AT = '2025-07-01T08:00:00.000Z';
export const FUND_NAME = 'Kelpwood Fund IV';
export const REPORT_FILE = `2025-06-30 ${FUND_NAME} - Quarterly financials - Meridian Data Partners.pdf`;
export const REPORT_TITLE = 'Quarterly Report: Meridian Data Partners, quarter ended 30 June 2025';
export const CONTENT_HASH = 'a3f1c9d2e4b56789a3f1c9d2e4b56789a3f1c9d2e4b56789a3f1c9d2e4b56789';

/** A classified quarterly report linked to its position, with a succeeded run; override what a case needs. */
export function documentFixture(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: DOC_ID.report,
    title: REPORT_TITLE,
    fileName: REPORT_FILE,
    folder: 'inbox',
    docType: 'doc_type.quarterly_financials',
    reviewStatus: 'Classified',
    sponsorId: ID.sponsor1,
    sponsorFundId: VS_ID.fundOne,
    sponsorFundName: FUND_NAME,
    investmentId: POSITION_ID.meridian,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    periodEnd: '2025-06-30',
    confidentiality: 'confidential',
    contentHash: CONTENT_HASH,
    sizeBytes: 9_814,
    pageCount: 4,
    receivedAt: RECEIVED_AT,
    indexedAt: INDEXED_AT,
    classificationConfidence: '0.9700',
    classifierEvidence: {
      keywords: ['quarterly report', 'period end'],
      candidates: [],
    },
    classifiedBy: null,
    classifiedAt: INDEXED_AT,
    duplicateOfId: null,
    latestRun: { id: RUN_ID_FIXTURE, state: 'Succeeded' },
    ...overrides,
  };
}

/** The untagged scan the classifier was not sure about: no type, no links, a candidate by reason. */
export function scanFixture(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return documentFixture({
    id: DOC_ID.scan,
    title: 'scan_0042',
    fileName: 'scan_0042.pdf',
    docType: null,
    reviewStatus: 'NeedsReview',
    sponsorId: null,
    sponsorFundId: null,
    sponsorFundName: null,
    investmentId: null,
    investmentNumber: null,
    companyName: null,
    periodEnd: null,
    contentHash: 'b4e2d0c3f5a67890b4e2d0c3f5a67890b4e2d0c3f5a67890b4e2d0c3f5a67890',
    sizeBytes: 7_210,
    pageCount: 4,
    indexedAt: '2025-07-01T09:16:00.000Z',
    classificationConfidence: '0.3000',
    classifierEvidence: {
      keywords: [],
      candidates: [{ reason: 'suggested doc_type.other below the threshold' }],
    },
    classifiedAt: null,
    latestRun: null,
    ...overrides,
  });
}

/** A second copy of the report under another name: a Duplicate pointing at the original. */
export function copyFixture(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return documentFixture({
    id: DOC_ID.copy,
    title: `${REPORT_FILE.slice(0, -4)} (1)`,
    fileName: `${REPORT_FILE.slice(0, -4)} (1).pdf`,
    docType: null,
    reviewStatus: 'Duplicate',
    indexedAt: '2025-07-01T09:17:00.000Z',
    classificationConfidence: null,
    classifierEvidence: { keywords: [], candidates: [] },
    classifiedAt: null,
    duplicateOfId: DOC_ID.report,
    latestRun: null,
    ...overrides,
  });
}

/** A capital account statement of the fund: linked to the sponsor fund, to no position. */
export function statementFixture(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return documentFixture({
    id: DOC_ID.statement,
    title: `Capital Account Statement: ${FUND_NAME}, quarter ended 30 June 2025`,
    fileName: `2025-06-30 ${FUND_NAME} - Capital account statement.pdf`,
    docType: 'doc_type.capital_account_statement',
    investmentId: null,
    investmentNumber: null,
    companyName: null,
    contentHash: 'c5f3e1d4a6b78901c5f3e1d4a6b78901c5f3e1d4a6b78901c5f3e1d4a6b78901',
    sizeBytes: 3_102,
    pageCount: 1,
    indexedAt: '2025-07-01T09:18:00.000Z',
    latestRun: null,
    ...overrides,
  });
}

/** The hub's first page, newest first: the statement, the copy, the scan, then the report. */
export function documents(): DocumentSummary[] {
  return [statementFixture(), copyFixture(), scanFixture(), documentFixture()];
}

export function documentPageFixture(
  items: DocumentSummary[] = documents(),
  nextCursor: string | null = null,
): DocumentPage {
  return { items, nextCursor };
}

export function duplicateFixture(overrides: Partial<DocumentDuplicate> = {}): DocumentDuplicate {
  const copy = copyFixture();
  return {
    id: copy.id,
    fileName: copy.fileName,
    folder: copy.folder,
    indexedAt: copy.indexedAt,
    reviewStatus: copy.reviewStatus,
    ...overrides,
  };
}

/** The report's detail: its duplicate listed. */
export function documentDetailFixture(overrides: Partial<DocumentDetail> = {}): DocumentDetail {
  return { ...documentFixture(), duplicates: [duplicateFixture()], ...overrides };
}

export function scanDetailFixture(overrides: Partial<DocumentDetail> = {}): DocumentDetail {
  return { ...scanFixture(), duplicates: [], ...overrides };
}

/** The scan as the API answers after operations classifies it as a quarterly report of the position. */
export function classifiedScanFixture(): DocumentDetail {
  return scanDetailFixture({
    docType: 'doc_type.quarterly_financials',
    reviewStatus: 'Classified',
    investmentId: POSITION_ID.meridian,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    sponsorId: ID.sponsor1,
    sponsorFundId: VS_ID.fundOne,
    sponsorFundName: FUND_NAME,
    periodEnd: '2025-06-30',
    classifiedBy: 'Avery Castellanos',
    classifiedAt: '2025-07-02T10:00:00.000Z',
  });
}

export function documentPagesFixture(overrides: Partial<DocumentPages> = {}): DocumentPages {
  return {
    documentId: DOC_ID.report,
    pageCount: 4,
    pages: [
      {
        number: 1,
        lines: [
          FUND_NAME,
          'Quarterly Report',
          'for the quarter ended 30 June 2025',
          'Meridian Data Partners',
          'Prepared for Beach Co-Invest Fund I, reference INV-0001',
          'Period end 2025-06-30',
        ],
      },
      { number: 2, lines: ['Financial summary', 'LTM revenue 125.40', 'LTM EBITDA 31.20'] },
      { number: 3, lines: ['Position summary', 'Sponsor ownership 62.50%', 'Headcount 410'] },
      {
        number: 4,
        lines: ['Notes', 'Synthetic prototype document. No real company, fund or figure.'],
      },
    ],
    ...overrides,
  };
}

export function indexResultFixture(
  overrides: Partial<DocumentIndexResult> = {},
): DocumentIndexResult {
  return { indexed: 77, duplicates: 1, unchanged: 0, ...overrides };
}

/** A received quarterly report row of the position; override what a case needs. */
export function expectedDocumentFixture(
  overrides: Partial<ExpectedDocument> = {},
): ExpectedDocument {
  return {
    id: EXPECTED_ID.received,
    investmentId: POSITION_ID.meridian,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    sponsorFundId: null,
    sponsorFundName: null,
    periodEnd: '2025-06-30',
    docType: 'doc_type.quarterly_financials',
    dueDate: '2025-08-14',
    receivedDocumentId: DOC_ID.report,
    status: 'received',
    ageDays: -45,
    ...overrides,
  };
}

/** The tracker's rows: a received report, a late one, a missing one and a fund statement still expected. */
export function expectedDocuments(): ExpectedDocument[] {
  return [
    expectedDocumentFixture(),
    expectedDocumentFixture({
      id: EXPECTED_ID.late,
      investmentId: POSITION_ID.silverline,
      investmentNumber: 'INV-0004',
      companyName: 'Silverline Staffing Holdings',
      receivedDocumentId: null,
      status: 'late',
      ageDays: 16,
    }),
    expectedDocumentFixture({
      id: EXPECTED_ID.missing,
      investmentId: POSITION_ID.cobalt,
      investmentNumber: 'INV-0007',
      companyName: 'Cobalt Ridge Logistics',
      receivedDocumentId: null,
      status: 'missing',
      ageDays: 76,
    }),
    expectedDocumentFixture({
      id: EXPECTED_ID.fund,
      investmentId: null,
      investmentNumber: null,
      companyName: null,
      sponsorFundId: VS_ID.fundOne,
      sponsorFundName: FUND_NAME,
      docType: 'doc_type.capital_account_statement',
      receivedDocumentId: null,
      status: 'expected',
      ageDays: -45,
    }),
  ];
}

export function expectedPageFixture(
  items: ExpectedDocument[] = expectedDocuments(),
  nextCursor: string | null = null,
): ExpectedDocumentPage {
  return { items, nextCursor };
}

export function generateResultFixture(
  overrides: Partial<ExpectedDocumentGenerateResult> = {},
): ExpectedDocumentGenerateResult {
  return { periodEnd: '2025-06-30', created: 18, existing: 0, ...overrides };
}

/** The doc_type domain of the taxonomy, three terms in order, one retired. */
export function docTypeTaxonomyFixture(): Taxonomy {
  const term = (
    code: string,
    label: string,
    sortOrder: number,
    active = true,
  ): Taxonomy['domains'][number]['terms'][number] => ({
    code,
    label,
    parentCode: null,
    active,
    sortOrder,
  });
  return {
    domains: [
      {
        domain: 'doc_type',
        terms: [
          term('doc_type.capital_call', 'Capital call', 3),
          term('doc_type.quarterly_financials', 'Quarterly financials', 1),
          term('doc_type.capital_account_statement', 'Capital account statement', 5),
          term('doc_type.other', 'Other', 16),
          term('doc_type.cim', 'CIM', 8, false),
        ],
      },
    ],
  };
}
