import type {
  IntakeFile,
  IntakeFilePage,
  LookthroughReconcileResult,
  LookthroughRow,
  LookthroughRunDetail,
} from '@pb/contracts';
import { POSITION_ID } from './fixtures-valuations.js';

/* Contract-shaped synthetic fixtures for the look-through pages (docs/12 section 4: synthetic data only). */

export const RUN_ID = {
  defects: '00000000-0000-4000-8000-000000000701',
  clean: '00000000-0000-4000-8000-000000000702',
  empty: '00000000-0000-4000-8000-000000000703',
} as const;

export const LT_ROW_ID = {
  matched: '00000000-0000-4000-8000-000000000711',
  nav: '00000000-0000-4000-8000-000000000712',
  sector: '00000000-0000-4000-8000-000000000713',
  unmapped: '00000000-0000-4000-8000-000000000714',
  unmatched: '00000000-0000-4000-8000-000000000715',
  stale: '00000000-0000-4000-8000-000000000716',
  alias: '00000000-0000-4000-8000-000000000717',
} as const;

export const RUN_AS_OF = '2025-06-30';
export const RUN_RECEIVED_AT = '2025-07-02T10:15:00.000Z';
export const RUN_RECEIVED_BY = 'Avery Castellanos';

const matched = (
  investmentId: string,
  investmentNumber: string,
  companyName: string,
): LookthroughRow['link'] => ({
  status: 'matched',
  investmentId,
  investmentNumber,
  companyName,
  candidates: [],
});

/** A matched, validated row that maps and ties; override what a case needs. */
export function lookthroughRowFixture(overrides: Partial<LookthroughRow> = {}): LookthroughRow {
  return {
    id: LT_ROW_ID.matched,
    rowNo: 1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    asOf: RUN_AS_OF,
    provider: {
      sector: 'Technology',
      geography: 'North America',
      exposureAtCost: '25000000.00',
      exposureAtNav: '27400000.00',
    },
    mapped: { sector: 'sector.software', geography: 'geography.north_america' },
    approved: { exposureAtCost: '25000000.00', exposureAtNav: '27400000.00' },
    differences: [],
    link: matched(POSITION_ID.meridian, 'INV-0001', 'Meridian Data Partners'),
    findings: [],
    status: 'validated',
    exceptions: 0,
    ...overrides,
  };
}

/**
 * One row of each kind a reader meets: a row that agrees, a NAV beyond the tolerance, a sector
 * that maps onto another code, a label the mapping does not list, a near miss with no number, a
 * row reporting for an older date and a row by alias. Rule ids, messages and difference shapes
 * follow packages/validation rules/lookthrough.ts.
 */
export function lookthroughRows(): LookthroughRow[] {
  return [
    lookthroughRowFixture(),
    lookthroughRowFixture({
      id: LT_ROW_ID.nav,
      rowNo: 2,
      investmentNumber: 'INV-0004',
      companyName: 'Silverline Staffing Holdings',
      provider: {
        sector: 'Business Services',
        geography: 'North America',
        exposureAtCost: '18000000.00',
        exposureAtNav: '21500000.00',
      },
      mapped: { sector: 'sector.business_services', geography: 'geography.north_america' },
      approved: { exposureAtCost: '18000000.00', exposureAtNav: '20000000.00' },
      differences: [{ field: 'exposureAtNav', expected: '20000000.00', actual: '21500000.00' }],
      link: matched(POSITION_ID.silverline, 'INV-0004', 'Silverline Staffing Holdings'),
      findings: [
        {
          ruleId: 'LT-TIE-01',
          severity: 'error',
          message:
            'The exposure at NAV differs from the latest Locked mark by 1500000.00 dollars, beyond 2.0% of the mark',
          field: 'exposureAtNav',
          expected: '20000000.00',
          actual: '21500000.00',
        },
      ],
      status: 'flagged',
      exceptions: 1,
    }),
    lookthroughRowFixture({
      id: LT_ROW_ID.sector,
      rowNo: 3,
      investmentNumber: 'INV-0007',
      companyName: 'Cobalt Energy Group',
      provider: {
        sector: 'Healthcare',
        geography: 'Europe',
        exposureAtCost: '30000000.00',
        exposureAtNav: '33000000.00',
      },
      mapped: { sector: 'sector.healthcare', geography: 'geography.europe' },
      approved: { exposureAtCost: '30000000.00', exposureAtNav: '33000000.00' },
      differences: [
        {
          field: 'sector',
          expected: 'sector.energy_transition',
          actual: 'Healthcare (sector.healthcare)',
        },
      ],
      link: matched(POSITION_ID.cobalt, 'INV-0007', 'Cobalt Energy Group'),
      findings: [
        {
          ruleId: 'LT-DIFF-01',
          severity: 'error',
          message:
            "The provider's sector maps to sector.healthcare; on record the company is sector.energy_transition",
          field: 'sector',
          expected: 'sector.energy_transition',
          actual: 'Healthcare (sector.healthcare)',
        },
      ],
      status: 'flagged',
      exceptions: 1,
    }),
    lookthroughRowFixture({
      id: LT_ROW_ID.unmapped,
      rowNo: 4,
      investmentNumber: 'INV-0012',
      companyName: 'Ashby Renewables Group',
      provider: {
        sector: 'Other',
        geography: 'Europe',
        exposureAtCost: '40000000.00',
        exposureAtNav: '79062720.52',
      },
      mapped: { sector: null, geography: 'geography.europe' },
      approved: { exposureAtCost: '40000000.00', exposureAtNav: '79062720.52' },
      link: matched(POSITION_ID.ashby, 'INV-0012', 'Ashby Renewables Group'),
      findings: [
        {
          ruleId: 'LT-MAP-01',
          severity: 'error',
          message:
            'The sector label is not in config/lookthrough_mapping.json; the taxonomy is never guessed from a label',
          field: 'sector',
          expected: 'a sector label the mapping lists',
          actual: 'Other',
        },
      ],
      status: 'flagged',
      exceptions: 1,
    }),
    lookthroughRowFixture({
      id: LT_ROW_ID.unmatched,
      rowNo: 5,
      investmentNumber: null,
      companyName: 'Meridian Data Partner',
      mapped: { sector: 'sector.software', geography: 'geography.north_america' },
      approved: { exposureAtCost: null, exposureAtNav: null },
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
          ruleId: 'LT-XREF-01',
          severity: 'error',
          message:
            'No position on record matches the number or the name; any candidates a person may see are listed on the row',
          field: 'companyName',
          expected: null,
          actual: null,
        },
      ],
      status: 'flagged',
      exceptions: 1,
    }),
    lookthroughRowFixture({
      id: LT_ROW_ID.stale,
      rowNo: 6,
      investmentNumber: 'INV-0015',
      companyName: 'Summit Care Holdings',
      asOf: '2025-03-31',
      provider: {
        sector: 'Healthcare',
        geography: 'North America',
        exposureAtCost: '35000000.00',
        exposureAtNav: '41000000.00',
      },
      mapped: { sector: 'sector.healthcare', geography: 'geography.north_america' },
      approved: { exposureAtCost: '35000000.00', exposureAtNav: '41000000.00' },
      link: matched(POSITION_ID.summitCare, 'INV-0015', 'Summit Care Holdings'),
      findings: [
        {
          ruleId: 'LT-STALE-01',
          severity: 'error',
          message:
            "The row reports as of 2025-03-31, before the run's as-of date 2025-06-30: the provider sent an older position",
          field: 'asOf',
          expected: RUN_AS_OF,
          actual: '2025-03-31',
        },
      ],
      status: 'flagged',
      exceptions: 0,
    }),
    lookthroughRowFixture({
      id: LT_ROW_ID.alias,
      rowNo: 7,
      investmentNumber: null,
      companyName: 'Meridian Data',
      link: matched(POSITION_ID.meridian, 'INV-0001', 'Meridian Data Partners'),
      findings: [
        {
          ruleId: 'LT-DUP-01',
          severity: 'error',
          message: 'Row 1 already carries this position for 2025-06-30',
          field: null,
          expected: 'one row per position and date',
          actual: 'rows 1 and 7',
        },
      ],
      status: 'flagged',
      exceptions: 0,
    }),
  ];
}

/** The counts of lookthroughRows(): one agrees, six flagged. */
const DEFECTS_COUNTS: IntakeFile['counts'] = {
  new: 0,
  validated: 1,
  flagged: 6,
  approved: 0,
  rejected: 0,
  promoted: 0,
};

export function lookthroughRunFixture(overrides: Partial<IntakeFile> = {}): IntakeFile {
  return {
    id: RUN_ID.defects,
    source: 'lookthrough',
    templateSignature: null,
    fileName: `lookthrough-${RUN_AS_OF}.json`,
    contentHash: 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5',
    receivedAt: RUN_RECEIVED_AT,
    receivedBy: RUN_RECEIVED_BY,
    rowCount: 7,
    status: 'flagged',
    counts: DEFECTS_COUNTS,
    fileFindings: [],
    exceptions: 4,
    rowVersion: 1,
    ...overrides,
  };
}

/** Newest first: the defects run with work on the queue, a clean run that agrees, a run with no extract. */
export function lookthroughRuns(): IntakeFile[] {
  return [
    lookthroughRunFixture(),
    lookthroughRunFixture({
      id: RUN_ID.clean,
      fileName: 'lookthrough-2025-03-31.json',
      contentHash: 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6',
      receivedAt: '2025-04-03T09:00:00.000Z',
      rowCount: 16,
      status: 'validated',
      counts: { ...DEFECTS_COUNTS, validated: 16, flagged: 0 },
      exceptions: 0,
    }),
    lookthroughRunFixture({
      id: RUN_ID.empty,
      fileName: 'lookthrough-2025-05-30.json',
      contentHash: 'f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7',
      receivedAt: '2025-06-02T08:30:00.000Z',
      receivedBy: null,
      rowCount: 0,
      status: 'new',
      counts: { ...DEFECTS_COUNTS, validated: 0, flagged: 0 },
      fileFindings: [
        {
          ruleId: 'LT-FILE-01',
          severity: 'error',
          message: 'No extract for 2025-05-30: the look-through folder holds no rows for this date',
          field: null,
          expected: '2025-05-30.json',
          actual: null,
        },
      ],
      exceptions: 0,
    }),
  ];
}

export function lookthroughRunPageFixture(
  items: IntakeFile[] = lookthroughRuns(),
  nextCursor: string | null = null,
): IntakeFilePage {
  return { items, nextCursor };
}

export function lookthroughRunDetailFixture(
  overrides: Partial<LookthroughRunDetail> = {},
): LookthroughRunDetail {
  return {
    ...lookthroughRunFixture(),
    asOf: RUN_AS_OF,
    rows: lookthroughRows(),
    hiddenRows: 0,
    ...overrides,
  };
}

export function lookthroughReconcileResultFixture(
  duplicate = false,
  overrides: Partial<LookthroughRunDetail> = {},
): LookthroughReconcileResult {
  return { ...lookthroughRunDetailFixture(overrides), duplicate };
}
