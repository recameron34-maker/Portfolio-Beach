import type {
  IntakeExportList,
  IntakeFile,
  IntakeFileDetail,
  IntakeFilePage,
  IntakeFinding,
  IntakeImportResult,
  IntakeRow,
} from '@pb/contracts';
import { POSITION_ID } from './fixtures-valuations.js';

/* Contract-shaped synthetic fixtures for the intake pages (docs/12 section 4: synthetic data only). */

export const FILE_ID = {
  update: '00000000-0000-4000-8000-000000000601',
  clean: '00000000-0000-4000-8000-000000000602',
  refused: '00000000-0000-4000-8000-000000000603',
  opsDrop: '00000000-0000-4000-8000-000000000604',
  opsDropRefused: '00000000-0000-4000-8000-000000000605',
} as const;

export const ROW_ID = {
  unchanged: '00000000-0000-4000-8000-000000000611',
  changed: '00000000-0000-4000-8000-000000000612',
  added: '00000000-0000-4000-8000-000000000613',
  unmatched: '00000000-0000-4000-8000-000000000614',
  guarded: '00000000-0000-4000-8000-000000000615',
  promoted: '00000000-0000-4000-8000-000000000616',
  rejected: '00000000-0000-4000-8000-000000000617',
} as const;

const TARGET_ID = {
  meridian: '00000000-0000-4000-8000-000000000621',
  silverline: '00000000-0000-4000-8000-000000000622',
  ashby: '00000000-0000-4000-8000-000000000623',
  summitCare: '00000000-0000-4000-8000-000000000624',
} as const;

export const RECEIVED_AT = '2025-07-01T09:15:00.000Z';
export const RECEIVED_BY = 'Avery Castellanos';
export const PERIOD = '2025-06-30';

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
): IntakeRow['link'] => ({
  status: 'matched',
  investmentId,
  investmentNumber,
  companyName,
  candidates: [],
});

const figures = (overrides: Partial<IntakeRow['figures']> = {}): IntakeRow['figures'] => ({
  revenueLtm: '20100000.00',
  ebitdaLtm: '4140000.00',
  ev: '52000000.00',
  netDebt: '12500000.00',
  fairValue: '27400000.00',
  ...overrides,
});

/** A matched, unchanged, validated row; override what a case needs. */
export function intakeRowFixture(overrides: Partial<IntakeRow> = {}): IntakeRow {
  return {
    id: ROW_ID.unchanged,
    rowNo: 1,
    naturalKey: `INV-0001|${PERIOD}`,
    targetEntity: 'quarterly_performance',
    targetId: TARGET_ID.meridian,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    periodEnd: PERIOD,
    figures: figures(),
    link: matched(POSITION_ID.meridian, 'INV-0001', 'Meridian Data Partners'),
    diff: { kind: 'unchanged', changes: [] },
    findings: [],
    status: 'validated',
    decision: null,
    decidedBy: null,
    promotedAt: null,
    ...overrides,
  };
}

/** The diff of a row with no quarter on record: every figure is new, nothing is before it (diffRow). */
const newDiff = (f: IntakeRow['figures']): IntakeRow['diff'] => ({
  kind: 'new',
  changes: [
    { field: 'revenueLtm', before: null, after: f.revenueLtm },
    { field: 'ebitdaLtm', before: null, after: f.ebitdaLtm },
    { field: 'ev', before: null, after: f.ev },
    { field: 'netDebt', before: null, after: f.netDebt },
  ],
});

/**
 * One row of each kind a reviewer meets: unchanged and changed rows waiting for approval, a new
 * quarter flagged for a period end off the quarter end, an unmatched name with a near-miss
 * candidate, a name on the match guard list, a promoted row with its decision and a rejected row
 * with its reason. Rule ids, severities, messages and diff shapes follow packages/validation.
 */
export function intakeRows(): IntakeRow[] {
  const cobalt = figures({ fairValue: null });
  return [
    intakeRowFixture(),
    intakeRowFixture({
      id: ROW_ID.changed,
      rowNo: 2,
      naturalKey: `INV-0004|${PERIOD}`,
      targetId: TARGET_ID.silverline,
      investmentNumber: 'INV-0004',
      companyName: 'Silverline Staffing Holdings',
      figures: figures({ revenueLtm: '20502000.00', ebitdaLtm: '3970000.00' }),
      link: matched(POSITION_ID.silverline, 'INV-0004', 'Silverline Staffing Holdings'),
      diff: {
        kind: 'changed',
        changes: [
          { field: 'revenueLtm', before: '20100000.00', after: '20502000.00' },
          { field: 'ebitdaLtm', before: '4140000.00', after: '3970000.00' },
        ],
      },
    }),
    intakeRowFixture({
      id: ROW_ID.added,
      rowNo: 3,
      naturalKey: 'INV-0007|2024-06-16',
      targetId: null,
      investmentNumber: 'INV-0007',
      companyName: 'Cobalt Energy Group',
      periodEnd: '2024-06-16',
      figures: cobalt,
      link: matched(POSITION_ID.cobalt, 'INV-0007', 'Cobalt Energy Group'),
      diff: newDiff(cobalt),
      findings: [
        {
          ruleId: 'TYPE-03',
          severity: 'error',
          message: 'The period end is more than a few days from a calendar quarter end',
          field: 'PeriodEnd',
          expected: 'a quarter end',
          actual: '2024-06-16',
        },
      ],
      status: 'flagged',
    }),
    intakeRowFixture({
      id: ROW_ID.unmatched,
      rowNo: 4,
      naturalKey: `|${PERIOD}`,
      targetId: null,
      investmentNumber: null,
      companyName: 'Meridian Data Partner',
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
      diff: newDiff(figures()),
      findings: [
        {
          ruleId: 'XREF-01',
          severity: 'error',
          message: 'No investment on record matches the number or the name',
          field: 'CompanyName',
          expected: null,
          actual: null,
        },
      ],
      status: 'flagged',
    }),
    intakeRowFixture({
      id: ROW_ID.guarded,
      rowNo: 5,
      naturalKey: `|${PERIOD}`,
      targetId: null,
      investmentNumber: null,
      companyName: 'Summit Services Company',
      link: {
        status: 'guarded',
        investmentId: null,
        investmentNumber: null,
        companyName: null,
        candidates: [
          {
            investmentNumber: 'INV-0013',
            companyName: 'Summit Services Co',
            reason: 'match guard',
          },
        ],
      },
      diff: newDiff(figures()),
      findings: [
        {
          ruleId: 'XREF-02',
          severity: 'error',
          message:
            'The name Summit Services Company is on the match guard list against 1 name on record; it is never linked automatically',
          field: 'CompanyName',
          expected: null,
          actual: null,
        },
      ],
      status: 'flagged',
    }),
    intakeRowFixture({
      id: ROW_ID.promoted,
      rowNo: 6,
      naturalKey: `INV-0012|${PERIOD}`,
      targetId: TARGET_ID.ashby,
      investmentNumber: 'INV-0012',
      companyName: 'Ashby Renewables Group',
      figures: figures({ ev: '97500000.00', fairValue: '79062720.52' }),
      link: matched(POSITION_ID.ashby, 'INV-0012', 'Ashby Renewables Group'),
      diff: {
        kind: 'changed',
        changes: [{ field: 'ev', before: '95000000.00', after: '97500000.00' }],
      },
      status: 'promoted',
      decision: 'Approved',
      decidedBy: RECEIVED_BY,
      promotedAt: '2025-07-01T09:20:00.000Z',
    }),
    intakeRowFixture({
      id: ROW_ID.rejected,
      rowNo: 7,
      naturalKey: `INV-0015|${PERIOD}`,
      targetId: TARGET_ID.summitCare,
      investmentNumber: 'INV-0015',
      companyName: 'Summit Care Holdings',
      figures: figures({ fairValue: '45100000.00' }),
      link: matched(POSITION_ID.summitCare, 'INV-0015', 'Summit Care Holdings'),
      findings: [
        {
          ruleId: 'TIE-01',
          severity: 'error',
          message: `FairValue differs from the Locked mark for ${PERIOD} by 4100000.00 dollars`,
          field: 'FairValue',
          expected: '41000000.00',
          actual: '45100000.00',
        },
      ],
      status: 'rejected',
      decision: 'Fair value restated by the sponsor; waiting for a new mark',
      decidedBy: RECEIVED_BY,
    }),
  ];
}

/** The counts of intakeRows(): two waiting, three flagged, one promoted, one rejected. */
const UPDATE_COUNTS: IntakeFile['counts'] = {
  new: 0,
  validated: 2,
  flagged: 3,
  approved: 0,
  rejected: 1,
  promoted: 1,
};

export function intakeFileFixture(overrides: Partial<IntakeFile> = {}): IntakeFile {
  return {
    id: FILE_ID.update,
    source: 'accounting',
    templateSignature: null,
    fileName: 'accounting-export-2025-06-30-update.csv',
    contentHash: 'a3f1c9e2b7d4506f8e1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
    receivedAt: RECEIVED_AT,
    receivedBy: RECEIVED_BY,
    rowCount: 7,
    status: 'flagged',
    counts: UPDATE_COUNTS,
    fileFindings: [],
    exceptions: 3,
    rowVersion: 2,
    ...overrides,
  };
}

/** A header the layout refuses (LAYOUT-02, a column the layout needs is missing): no rows, the file stays new. */
export function fileFindingsFixture(): IntakeFinding[] {
  return [
    {
      ruleId: 'LAYOUT-02',
      severity: 'error',
      message: 'The file lacks the column PeriodEnd',
      field: 'PeriodEnd',
      expected: 'PeriodEnd',
      actual: null,
    },
  ];
}

/** A workbook the ops drop matched to the quarterly-figures template: every row validated, waiting. */
export function opsDropFileFixture(overrides: Partial<IntakeFile> = {}): IntakeFile {
  return intakeFileFixture({
    id: FILE_ID.opsDrop,
    source: 'ops_drop',
    templateSignature: 'quarterly-figures',
    fileName: 'ops-drop-2025-06-30-clean.xlsx',
    contentHash: 'd6a4f2b5e0c7839213b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6',
    receivedAt: '2025-07-02T08:30:00.000Z',
    rowCount: 9,
    status: 'validated',
    counts: { ...ZERO_COUNTS, validated: 9 },
    fileFindings: [],
    exceptions: 0,
    rowVersion: 1,
    ...overrides,
  });
}

/** The file finding of a workbook that matched no template (LAYOUT-05): the templates known, the signature seen, never a cell. */
export function opsDropRefusedFindingsFixture(): IntakeFinding[] {
  return [
    {
      ruleId: 'LAYOUT-05',
      severity: 'error',
      message: 'No template matches this workbook',
      field: null,
      expected: 'quarterly-figures',
      actual:
        'sheets: Figures, Notes; header hash: 84a93c700300a189d9dd888623cd10ba790a21b9f5c551177500ff4db2b3cb51 (Figures)',
    },
  ];
}

/** A workbook the ops drop refused: no template, no rows, the file stays new. */
export function opsDropRefusedFileFixture(): IntakeFile {
  return opsDropFileFixture({
    id: FILE_ID.opsDropRefused,
    templateSignature: null,
    fileName: 'ops-drop-2025-06-30-unknown-template.xlsx',
    contentHash: 'e7b5a3c6f1d8940324c5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7',
    receivedAt: '2025-07-02T08:35:00.000Z',
    rowCount: 0,
    status: 'new',
    counts: ZERO_COUNTS,
    fileFindings: opsDropRefusedFindingsFixture(),
  });
}

export function opsDropDropListFixture(
  items: IntakeExportList['items'] = [
    {
      id: 'ops-drop-2025-06-30-update.xlsx',
      name: 'ops-drop-2025-06-30-update.xlsx',
      receivedAt: '2025-07-02T08:00:00.000Z',
    },
  ],
): IntakeExportList {
  return { items };
}

/** Newest first: the update file with work left, a clean file fully promoted, a refused file. */
export function intakeFiles(): IntakeFile[] {
  return [
    intakeFileFixture(),
    intakeFileFixture({
      id: FILE_ID.clean,
      fileName: 'accounting-export-2025-06-30-clean.csv',
      contentHash: 'b4e2d0f3c8a5617091f2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4',
      receivedAt: '2025-06-30T17:40:00.000Z',
      rowCount: 9,
      status: 'promoted',
      counts: { ...ZERO_COUNTS, promoted: 9 },
      exceptions: 0,
      rowVersion: 3,
    }),
    intakeFileFixture({
      id: FILE_ID.refused,
      fileName: 'accounting-export-bad-header.csv',
      contentHash: 'c5f3e1a4d9b6728102a3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5',
      receivedAt: '2025-06-28T11:05:00.000Z',
      receivedBy: null,
      rowCount: 0,
      status: 'new',
      counts: ZERO_COUNTS,
      fileFindings: fileFindingsFixture(),
      exceptions: 0,
      rowVersion: 1,
    }),
  ];
}

export function intakeFilePageFixture(
  items: IntakeFile[] = intakeFiles(),
  nextCursor: string | null = null,
): IntakeFilePage {
  return { items, nextCursor };
}

export function intakeFileDetailFixture(
  overrides: Partial<IntakeFileDetail> = {},
): IntakeFileDetail {
  return { ...intakeFileFixture(), rows: intakeRows(), hiddenRows: 0, ...overrides };
}

/** The detail after "approve": every validated row promoted in the same transaction. */
export function approvedDetailFixture(): IntakeFileDetail {
  const rows = intakeRows().map((r) =>
    r.status === 'validated'
      ? {
          ...r,
          status: 'promoted' as const,
          decision: 'Approved',
          decidedBy: RECEIVED_BY,
          promotedAt: '2025-07-01T10:00:00.000Z',
        }
      : r,
  );
  return intakeFileDetailFixture({
    rows,
    status: 'flagged',
    counts: { ...UPDATE_COUNTS, validated: 0, promoted: 3 },
    rowVersion: 3,
  });
}

/** The detail after "reject": every flagged row rejected with the reason. */
export function rejectedDetailFixture(reason: string): IntakeFileDetail {
  const rows = intakeRows().map((r) =>
    r.status === 'flagged'
      ? { ...r, status: 'rejected' as const, decision: reason, decidedBy: RECEIVED_BY }
      : r,
  );
  return intakeFileDetailFixture({
    rows,
    status: 'validated',
    counts: { ...UPDATE_COUNTS, flagged: 0, rejected: 4 },
    rowVersion: 3,
  });
}

export function intakeImportResultFixture(
  duplicate = false,
  overrides: Partial<IntakeFileDetail> = {},
): IntakeImportResult {
  return { ...intakeFileDetailFixture(overrides), duplicate };
}

export function intakeExportListFixture(
  items: IntakeExportList['items'] = [
    {
      id: 'accounting-export-2025-06-30-update.csv',
      name: 'accounting-export-2025-06-30-update.csv',
      receivedAt: '2025-07-01T08:00:00.000Z',
    },
  ],
): IntakeExportList {
  return { items };
}
