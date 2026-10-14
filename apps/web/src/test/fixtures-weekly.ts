import type {
  IntakeExportList,
  IntakeFile,
  IntakeFilePage,
  WeeklyFileDetail,
  WeeklyImportResult,
  WeeklyRow,
} from '@pb/contracts';
import { fileFindingsFixture, RECEIVED_AT, RECEIVED_BY } from './fixtures-intake.js';
import { POSITION_ID } from './fixtures-valuations.js';

/* Contract-shaped synthetic fixtures for the weekly values pages (docs/12 section 4: synthetic data only). */

export const WEEKLY_FILE_ID = {
  update: '00000000-0000-4000-8000-000000000701',
  clean: '00000000-0000-4000-8000-000000000702',
  refused: '00000000-0000-4000-8000-000000000703',
} as const;

export const WEEKLY_ROW_ID = {
  unchanged: '00000000-0000-4000-8000-000000000711',
  moved: '00000000-0000-4000-8000-000000000712',
  beyond: '00000000-0000-4000-8000-000000000713',
  unmatched: '00000000-0000-4000-8000-000000000714',
  promoted: '00000000-0000-4000-8000-000000000715',
  rejected: '00000000-0000-4000-8000-000000000716',
  badDate: '00000000-0000-4000-8000-000000000717',
} as const;

export const VALUATION_ID = {
  ashby: '00000000-0000-4000-8000-000000000721',
  meridian: '00000000-0000-4000-8000-000000000722',
  silverline: '00000000-0000-4000-8000-000000000723',
} as const;

export const REPORT_DATE = '2025-06-27';
export const PRIOR_DATE = '2025-03-31';

const ZERO_COUNTS: IntakeFile['counts'] = {
  new: 0,
  validated: 0,
  flagged: 0,
  approved: 0,
  rejected: 0,
  promoted: 0,
};

const matched = (
  investmentId: string,
  investmentNumber: string,
  companyName: string,
): WeeklyRow['link'] => ({
  status: 'matched',
  investmentId,
  investmentNumber,
  companyName,
  candidates: [],
});

/** A matched row whose value equals its prior (the Locked mark), validated; override what a case needs. */
export function weeklyRowFixture(overrides: Partial<WeeklyRow> = {}): WeeklyRow {
  return {
    id: WEEKLY_ROW_ID.unchanged,
    rowNo: 1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    reportDate: REPORT_DATE,
    reportedValue: '27400000.00',
    priorValue: '27400000.00',
    priorSource: 'locked_mark',
    priorDate: PRIOR_DATE,
    variancePct: '0.00000000',
    flag: null,
    link: matched(POSITION_ID.meridian, 'INV-0001', 'Meridian Data Partners'),
    findings: [],
    status: 'validated',
    decision: null,
    decidedBy: null,
    decidedAt: null,
    valuationId: null,
    ...overrides,
  };
}

/**
 * One row of each kind a reviewer meets: an unchanged value and a value moved inside the threshold
 * waiting for approval, a move beyond it flagged, an unmatched name with a near-miss candidate, a
 * promoted row with its Draft valuation, a rejected row whose value was not a number, and a row
 * whose report date was not a day. Rule ids, severities and messages follow packages/validation.
 */
export function weeklyRows(): WeeklyRow[] {
  return [
    weeklyRowFixture(),
    weeklyRowFixture({
      id: WEEKLY_ROW_ID.moved,
      rowNo: 2,
      investmentNumber: 'INV-0004',
      companyName: 'Silverline Staffing Holdings',
      reportedValue: '21630000.00',
      priorValue: '21000000.00',
      variancePct: '0.03000000',
      link: matched(POSITION_ID.silverline, 'INV-0004', 'Silverline Staffing Holdings'),
    }),
    weeklyRowFixture({
      id: WEEKLY_ROW_ID.beyond,
      rowNo: 3,
      investmentNumber: 'INV-0007',
      companyName: 'Cobalt Energy Group',
      reportedValue: '15000000.00',
      priorValue: '10000000.00',
      variancePct: '0.50000000',
      flag: 'above_threshold',
      link: matched(POSITION_ID.cobalt, 'INV-0007', 'Cobalt Energy Group'),
      findings: [
        {
          ruleId: 'WK-BOUND-01',
          severity: 'error',
          message:
            'ReportedValue moved 50.00% against the Locked mark of 2025-03-31, at or beyond the 10.00% threshold; a person confirms the move',
          field: 'ReportedValue',
          expected: 'within 10.00% of 10000000.00',
          actual: '15000000.00',
        },
      ],
      status: 'flagged',
    }),
    weeklyRowFixture({
      id: WEEKLY_ROW_ID.unmatched,
      rowNo: 4,
      investmentNumber: null,
      companyName: 'Meridian Data Partner',
      reportedValue: '27400000.00',
      priorValue: null,
      priorSource: null,
      priorDate: null,
      variancePct: null,
      link: {
        status: 'unmatched',
        investmentId: null,
        investmentNumber: null,
        companyName: null,
        candidates: [
          {
            investmentNumber: 'INV-0001',
            companyName: 'Meridian Data Partners',
            reason: 'near miss',
          },
        ],
      },
      findings: [
        {
          ruleId: 'WK-XREF-01',
          severity: 'error',
          message:
            'No investment on record matches the number or the name; any candidates a person may see are listed on the row',
          field: 'CompanyName',
          expected: null,
          actual: null,
        },
      ],
      status: 'flagged',
    }),
    weeklyRowFixture({
      id: WEEKLY_ROW_ID.promoted,
      rowNo: 5,
      investmentNumber: 'INV-0012',
      companyName: 'Ashby Renewables Group',
      reportedValue: '78272093.31',
      priorValue: '79062720.52',
      priorSource: 'weekly',
      priorDate: '2025-06-20',
      variancePct: '-0.01000000',
      link: matched(POSITION_ID.ashby, 'INV-0012', 'Ashby Renewables Group'),
      status: 'promoted',
      decision: 'Approved',
      decidedBy: RECEIVED_BY,
      decidedAt: '2025-07-01T09:20:00.000Z',
      valuationId: VALUATION_ID.ashby,
    }),
    weeklyRowFixture({
      id: WEEKLY_ROW_ID.rejected,
      rowNo: 6,
      investmentNumber: 'INV-0015',
      companyName: 'Summit Care Holdings',
      reportedValue: '45.1m',
      priorValue: '41000000.00',
      variancePct: null,
      link: matched(POSITION_ID.summitCare, 'INV-0015', 'Summit Care Holdings'),
      findings: [
        {
          ruleId: 'WK-TYPE-02',
          severity: 'error',
          message: 'ReportedValue is not a plain number (digits, a sign and a decimal point only)',
          field: 'ReportedValue',
          expected: 'a decimal number',
          actual: '45.1m',
        },
      ],
      status: 'rejected',
      decision: 'Value sent back to the sponsor as a number',
      decidedBy: RECEIVED_BY,
      decidedAt: '2025-07-01T09:25:00.000Z',
    }),
    weeklyRowFixture({
      id: WEEKLY_ROW_ID.badDate,
      rowNo: 7,
      investmentNumber: 'INV-0002',
      companyName: 'Juniper Financial Group',
      reportDate: '27/06/2025',
      reportedValue: '29081464.91',
      priorValue: null,
      priorSource: null,
      priorDate: null,
      variancePct: null,
      link: matched(POSITION_ID.summit, 'INV-0002', 'Juniper Financial Group'),
      findings: [
        {
          ruleId: 'WK-TYPE-01',
          severity: 'error',
          message: 'The report date is not a date of the form YYYY-MM-DD',
          field: 'ReportDate',
          expected: 'YYYY-MM-DD',
          actual: '27/06/2025',
        },
      ],
      status: 'flagged',
    }),
  ];
}

/** The counts of weeklyRows(): two waiting, three flagged, one promoted, one rejected. */
const UPDATE_COUNTS: IntakeFile['counts'] = {
  new: 0,
  validated: 2,
  flagged: 3,
  approved: 0,
  rejected: 1,
  promoted: 1,
};

export function weeklyFileFixture(overrides: Partial<IntakeFile> = {}): IntakeFile {
  return {
    id: WEEKLY_FILE_ID.update,
    source: 'weekly',
    templateSignature: null,
    fileName: 'weekly-values-2025-06-27-update.csv',
    contentHash: 'd6a4f2b5e0c7839213b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6',
    receivedAt: RECEIVED_AT,
    receivedBy: RECEIVED_BY,
    rowCount: 7,
    status: 'flagged',
    counts: UPDATE_COUNTS,
    fileFindings: [],
    exceptions: 1,
    rowVersion: 2,
    ...overrides,
  };
}

/** Newest first: the update file with work left, a clean file fully promoted, a refused file. */
export function weeklyFiles(): IntakeFile[] {
  return [
    weeklyFileFixture(),
    weeklyFileFixture({
      id: WEEKLY_FILE_ID.clean,
      fileName: 'weekly-values-2025-06-20-clean.csv',
      contentHash: 'e7b5a3c6f1d8940324c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7',
      receivedAt: '2025-06-23T08:40:00.000Z',
      rowCount: 9,
      status: 'promoted',
      counts: { ...ZERO_COUNTS, promoted: 9 },
      exceptions: 0,
      rowVersion: 3,
    }),
    weeklyFileFixture({
      id: WEEKLY_FILE_ID.refused,
      fileName: 'weekly-values-bad-header.csv',
      contentHash: 'f8c6b4d7a2e9051435d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8',
      receivedAt: '2025-06-16T11:05:00.000Z',
      receivedBy: null,
      rowCount: 0,
      status: 'new',
      counts: ZERO_COUNTS,
      fileFindings: fileFindingsFixture().map((f) => ({
        ...f,
        message: 'The file lacks the column ReportDate',
        field: 'ReportDate',
        expected: 'ReportDate',
      })),
      exceptions: 0,
      rowVersion: 1,
    }),
  ];
}

export function weeklyFilePageFixture(
  items: IntakeFile[] = weeklyFiles(),
  nextCursor: string | null = null,
): IntakeFilePage {
  return { items, nextCursor };
}

export function weeklyFileDetailFixture(
  overrides: Partial<WeeklyFileDetail> = {},
): WeeklyFileDetail {
  return { ...weeklyFileFixture(), rows: weeklyRows(), hiddenRows: 0, ...overrides };
}

/** The detail after "approve": every validated row promoted, each with the Draft valuation it created. */
export function approvedWeeklyDetailFixture(): WeeklyFileDetail {
  const valuationOf: Record<string, string> = {
    [WEEKLY_ROW_ID.unchanged]: VALUATION_ID.meridian,
    [WEEKLY_ROW_ID.moved]: VALUATION_ID.silverline,
  };
  const rows = weeklyRows().map((r) =>
    r.status === 'validated'
      ? {
          ...r,
          status: 'promoted' as const,
          decision: 'weekly values weekly-values-2025-06-27-update.csv',
          decidedBy: RECEIVED_BY,
          decidedAt: '2025-07-01T10:00:00.000Z',
          valuationId: valuationOf[r.id] ?? null,
        }
      : r,
  );
  return weeklyFileDetailFixture({
    rows,
    status: 'flagged',
    counts: { ...UPDATE_COUNTS, validated: 0, promoted: 3 },
    rowVersion: 3,
  });
}

/** The detail after "reject": every flagged row rejected with the reason. */
export function rejectedWeeklyDetailFixture(reason: string): WeeklyFileDetail {
  const rows = weeklyRows().map((r) =>
    r.status === 'flagged'
      ? {
          ...r,
          status: 'rejected' as const,
          decision: reason,
          decidedBy: RECEIVED_BY,
          decidedAt: '2025-07-01T10:05:00.000Z',
        }
      : r,
  );
  return weeklyFileDetailFixture({
    rows,
    status: 'validated',
    counts: { ...UPDATE_COUNTS, flagged: 0, rejected: 4 },
    rowVersion: 3,
  });
}

export function weeklyImportResultFixture(
  duplicate = false,
  overrides: Partial<WeeklyFileDetail> = {},
): WeeklyImportResult {
  return { ...weeklyFileDetailFixture(overrides), duplicate };
}

export function weeklyDropListFixture(
  items: IntakeExportList['items'] = [
    {
      id: 'weekly-values-2025-06-27-update.csv',
      name: 'weekly-values-2025-06-27-update.csv',
      receivedAt: '2025-06-30T08:00:00.000Z',
    },
  ],
): IntakeExportList {
  return { items };
}
