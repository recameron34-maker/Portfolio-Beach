import type { MonitoringBoard, MonitoringBoardRow } from '@pb/contracts';
import { AS_OF, ID } from '../../test/fixtures.js';

/* Contract-shaped synthetic fixtures for the monitoring board tests (docs/12 section 4: synthetic data only). */

export const BOARD_ID = {
  inv4: '00000000-0000-4000-8000-000000000004',
  docMeridian: '00000000-0000-4000-8000-000000000701',
  docStatement: '00000000-0000-4000-8000-000000000702',
  runMeridian: '00000000-0000-4000-8000-000000000711',
  expMeridian: '00000000-0000-4000-8000-000000000721',
  expSummit: '00000000-0000-4000-8000-000000000722',
  expAshby: '00000000-0000-4000-8000-000000000723',
  expStatement: '00000000-0000-4000-8000-000000000724',
} as const;

export const DUE_DATE = '2025-08-14';

/** A received, extracted, unapproved equity position; override what a case needs. */
export function boardRowFixture(overrides: Partial<MonitoringBoardRow> = {}): MonitoringBoardRow {
  return {
    investmentId: ID.inv1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    vehicleName: 'Beach Co-Invest Fund I',
    sponsorFundName: 'Kelpwood Fund IV',
    dealType: 'deal_type.co_invest_equity',
    periodEnd: AS_OF,
    expectedDocumentId: BOARD_ID.expMeridian,
    documentStatus: 'received',
    dueDate: DUE_DATE,
    ageDays: -30,
    documentId: BOARD_ID.docMeridian,
    runId: BOARD_ID.runMeridian,
    runState: 'Succeeded',
    flagsCount: 2,
    approval: 'pending',
    approvedAt: null,
    ...overrides,
  };
}

/**
 * Four positions in the four states a reviewer meets: a received report with a run awaiting
 * approval, a report still expected, a late report whose seeded quarter is approved without a
 * recorded time, and a credit position received on its fund's statement and approved with one.
 */
export function boardRows(): MonitoringBoardRow[] {
  return [
    boardRowFixture(),
    boardRowFixture({
      investmentId: ID.inv2,
      investmentNumber: 'INV-0002',
      companyName: 'Summit Care Holdings',
      vehicleName: 'Beach Co-Invest Fund II',
      sponsorFundName: 'Harborlight Partners III',
      expectedDocumentId: BOARD_ID.expSummit,
      documentStatus: 'expected',
      ageDays: -45,
      documentId: null,
      runId: null,
      runState: null,
      flagsCount: 0,
      approval: 'none',
    }),
    boardRowFixture({
      investmentId: ID.inv3,
      investmentNumber: 'INV-0003',
      companyName: 'Ashby Logistics',
      vehicleName: 'Beach CV Opportunities I',
      sponsorFundName: null,
      dealType: 'deal_type.cv_single_asset',
      expectedDocumentId: BOARD_ID.expAshby,
      documentStatus: 'late',
      ageDays: 16,
      documentId: null,
      runId: null,
      runState: null,
      flagsCount: 0,
      approval: 'approved',
      approvedAt: null,
    }),
    boardRowFixture({
      investmentId: BOARD_ID.inv4,
      investmentNumber: 'INV-0004',
      companyName: 'Tidewater Credit Borrower',
      vehicleName: 'Beach Credit Fund I',
      sponsorFundName: 'Lantern Credit Fund II',
      dealType: 'deal_type.private_credit',
      expectedDocumentId: BOARD_ID.expStatement,
      documentStatus: 'received',
      ageDays: 3,
      documentId: BOARD_ID.docStatement,
      runId: null,
      runState: null,
      flagsCount: 0,
      approval: 'approved',
      approvedAt: '2025-07-20T10:00:00.000Z',
    }),
  ];
}

/** The board as the API answers it: the rows with their counts tallied the way the API tallies them. */
export function boardFixture(
  rows: MonitoringBoardRow[] = boardRows(),
  overrides: Partial<Pick<MonitoringBoard, 'asOf' | 'periodEnd'>> = {},
): MonitoringBoard {
  const counts = { expected: 0, received: 0, late: 0, missing: 0, inReview: 0, approved: 0 };
  for (const row of rows) {
    counts[row.documentStatus] += 1;
    if (row.approval === 'pending') counts.inReview += 1;
    if (row.approval === 'approved') counts.approved += 1;
  }
  return { asOf: AS_OF, periodEnd: AS_OF, rows, counts, ...overrides };
}

/** The export of the fixture rows as the API writes it: a header line, one line per row, LF ends. */
export const BOARD_CSV =
  'investmentNumber,companyName,vehicleName,sponsorFundName,dealType,periodEnd,documentStatus,dueDate,ageDays,runState,flagsCount,approval,approvedAt,investmentId,expectedDocumentId,documentId,runId\n' +
  `INV-0001,Meridian Data Partners,Beach Co-Invest Fund I,Kelpwood Fund IV,deal_type.co_invest_equity,${AS_OF},received,${DUE_DATE},-30,Succeeded,2,pending,,${ID.inv1},${BOARD_ID.expMeridian},${BOARD_ID.docMeridian},${BOARD_ID.runMeridian}\n` +
  `INV-0002,"Summit Care, Holdings",Beach Co-Invest Fund II,Harborlight Partners III,deal_type.co_invest_equity,${AS_OF},expected,${DUE_DATE},-45,,0,none,,${ID.inv2},${BOARD_ID.expSummit},,\n`;
