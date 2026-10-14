import type { DataException, DataExceptionPage } from '@pb/contracts';
import { LT_ROW_ID, RUN_AS_OF, RUN_ID } from './fixtures-lookthrough.js';
import { FILE_ID, ROW_ID } from './fixtures-intake.js';
import { POSITION_ID } from './fixtures-valuations.js';

/* Contract-shaped synthetic fixtures for the exceptions pages (docs/12 section 4: synthetic data only). */

export const EXCEPTION_ID = {
  nav: '00000000-0000-4000-8000-000000000801',
  sector: '00000000-0000-4000-8000-000000000802',
  unmapped: '00000000-0000-4000-8000-000000000803',
  unmatched: '00000000-0000-4000-8000-000000000804',
  accounting: '00000000-0000-4000-8000-000000000805',
  resolved: '00000000-0000-4000-8000-000000000806',
} as const;

export const OPENED_AT = '2025-07-02T10:15:00.000Z';
export const OWNER_NAME = 'Avery Castellanos';

/** An open, high NAV difference from the defects run; override what a case needs. */
export function exceptionFixture(overrides: Partial<DataException> = {}): DataException {
  return {
    id: EXCEPTION_ID.nav,
    source: 'lookthrough_reconcile',
    entity: 'stg.intake_row',
    entityId: LT_ROW_ID.nav,
    ruleId: 'LT-TIE-01',
    expected: '20000000.00',
    actual: '21500000.00',
    severity: 'exception_severity.high',
    owner: null,
    state: 'open',
    externalTicket: null,
    candidates: [],
    createdAt: OPENED_AT,
    updatedAt: OPENED_AT,
    rowVersion: 1,
    context: {
      intakeFileId: RUN_ID.defects,
      intakeFileName: `lookthrough-${RUN_AS_OF}.json`,
      rowNo: 2,
      investmentId: POSITION_ID.silverline,
      investmentNumber: 'INV-0004',
      companyName: 'Silverline Staffing Holdings',
    },
    ...overrides,
  };
}

/**
 * One exception of each kind the queue shows, newest first: the defects run's NAV, sector and
 * label exceptions and its near miss (no position), an older accounting-import exception that is
 * acknowledged with a ticket, and a resolved one.
 */
export function exceptions(): DataException[] {
  return [
    exceptionFixture(),
    exceptionFixture({
      id: EXCEPTION_ID.sector,
      entityId: LT_ROW_ID.sector,
      ruleId: 'LT-DIFF-01',
      expected: 'sector.energy_transition',
      actual: 'Healthcare (sector.healthcare)',
      severity: 'exception_severity.medium',
      context: {
        intakeFileId: RUN_ID.defects,
        intakeFileName: `lookthrough-${RUN_AS_OF}.json`,
        rowNo: 3,
        investmentId: POSITION_ID.cobalt,
        investmentNumber: 'INV-0007',
        companyName: 'Cobalt Energy Group',
      },
    }),
    exceptionFixture({
      id: EXCEPTION_ID.unmapped,
      entityId: LT_ROW_ID.unmapped,
      ruleId: 'LT-MAP-01',
      expected: 'a sector label the mapping lists',
      actual: 'Other',
      severity: 'exception_severity.medium',
      context: {
        intakeFileId: RUN_ID.defects,
        intakeFileName: `lookthrough-${RUN_AS_OF}.json`,
        rowNo: 4,
        investmentId: POSITION_ID.ashby,
        investmentNumber: 'INV-0012',
        companyName: 'Ashby Renewables Group',
      },
    }),
    exceptionFixture({
      id: EXCEPTION_ID.unmatched,
      entityId: LT_ROW_ID.unmatched,
      ruleId: 'LT-XREF-01',
      expected: 'a position on record',
      actual: 'Meridian Data Partner',
      candidates: [{ reason: 'near miss' }],
      context: {
        intakeFileId: RUN_ID.defects,
        intakeFileName: `lookthrough-${RUN_AS_OF}.json`,
        rowNo: 5,
        investmentId: null,
        investmentNumber: null,
        companyName: null,
      },
    }),
    exceptionFixture({
      id: EXCEPTION_ID.accounting,
      source: 'accounting_import',
      entityId: ROW_ID.guarded,
      ruleId: 'XREF-02',
      expected: 'an investment on record',
      actual: 'Summit Services Company',
      owner: OWNER_NAME,
      state: 'acknowledged',
      externalTicket: 'HD-1042',
      candidates: [{ reason: 'match guard' }],
      createdAt: '2025-07-01T09:15:00.000Z',
      updatedAt: '2025-07-01T11:00:00.000Z',
      rowVersion: 3,
      context: {
        intakeFileId: FILE_ID.update,
        intakeFileName: 'accounting-export-2025-06-30-update.csv',
        rowNo: 5,
        investmentId: null,
        investmentNumber: null,
        companyName: null,
      },
    }),
    exceptionFixture({
      id: EXCEPTION_ID.resolved,
      source: 'accounting_import',
      entityId: ROW_ID.rejected,
      ruleId: 'TIE-01',
      expected: null,
      actual: null,
      owner: OWNER_NAME,
      state: 'resolved',
      createdAt: '2025-06-28T11:05:00.000Z',
      updatedAt: '2025-06-30T16:20:00.000Z',
      rowVersion: 4,
      context: {
        intakeFileId: FILE_ID.update,
        intakeFileName: 'accounting-export-2025-06-30-update.csv',
        rowNo: 7,
        investmentId: POSITION_ID.summitCare,
        investmentNumber: 'INV-0015',
        companyName: 'Summit Care Holdings',
      },
    }),
  ];
}

export function exceptionPageFixture(
  items: DataException[] = exceptions(),
  nextCursor: string | null = null,
): DataExceptionPage {
  return { items, nextCursor };
}

/** The exception after a command, as the API answers it. */
export function afterCommandFixture(
  command: 'acknowledge' | 'resolve' | 'wont_fix' | 'set_ticket',
  from: DataException = exceptionFixture(),
): DataException {
  const updatedAt = '2025-07-02T12:00:00.000Z';
  switch (command) {
    case 'acknowledge':
      return {
        ...from,
        state: 'acknowledged',
        owner: OWNER_NAME,
        updatedAt,
        rowVersion: from.rowVersion + 1,
      };
    case 'resolve':
      return { ...from, state: 'resolved', updatedAt, rowVersion: from.rowVersion + 1 };
    case 'wont_fix':
      return { ...from, state: 'wont_fix', updatedAt, rowVersion: from.rowVersion + 1 };
    case 'set_ticket':
      return { ...from, externalTicket: 'HD-2000', updatedAt, rowVersion: from.rowVersion + 1 };
  }
}
