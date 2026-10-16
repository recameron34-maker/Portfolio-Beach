import type {
  DocumentDefinitions,
  ExtractionRunState,
  MonitoringApproval,
  MonitoringBoard,
  MonitoringBoardRow,
} from '@pb/contracts';
import { toCsv } from '@pb/validation';
import { QUARTERLY_REPORTING_DEAL_TYPES, deriveExpected } from '../documents/expected.js';

/*
 * The monitoring board's rules (docs/04 M9, decision 0012), pure so the service, the tests and
 * the preview judge a row the same way. One row per investment held at the period end: its
 * expected document (a quarterly report for the deal types that report quarterly figures, the
 * sponsor fund's capital account statement for the others), the latest extraction run of the
 * investment for that period, and the approval the quarter has reached. Nothing here reads the
 * database or the clock: the service loads the rows under the caller's row-level security and
 * passes the as-of day in.
 */

/** The investment columns the board shows, as the portfolio loaders read them. */
export interface BoardInvestment {
  id: string;
  investmentNumber: string;
  companyName: string;
  vehicleName: string;
  sponsorFundId: string | null;
  sponsorFundName: string | null;
  dealType: string;
}

/** The expected row that answers for the investment this quarter, with the day its document arrived. */
export interface BoardExpected {
  id: string;
  dueDate: string;
  receivedDocumentId: string | null;
  /** The calendar day (UTC) the matched document was received; null when none is matched. */
  receivedOn: string | null;
}

/** The latest extraction run of the investment for the period, with its undecided flags counted. */
export interface BoardRun {
  id: string;
  documentId: string;
  state: ExtractionRunState;
  approvedAt: string | null;
  /** Flagged plus invalid values of the run that nobody has decided yet. */
  flagsCount: number;
}

/** The approved mon.quarterly_performance record of the investment for the period, when one exists. */
export interface BoardRecord {
  approvedAt: string | null;
}

/** Whether a deal type's sponsor reports quarterly figures, so the board expects a report rather than a statement. */
export function reportsQuarterly(dealType: string): boolean {
  return QUARTERLY_REPORTING_DEAL_TYPES.includes(dealType);
}

/**
 * approved when the quarter's record is approved or the run is; pending when a run succeeded
 * and nobody approved it yet; none otherwise. The run's approval time comes first because it is
 * the lineage the record carries; the record's own time answers for figures approved another way.
 */
export function approvalOf(
  run: BoardRun | null,
  record: BoardRecord | null,
): { approval: MonitoringApproval; approvedAt: string | null } {
  if (run !== null && run.approvedAt !== null)
    return { approval: 'approved', approvedAt: run.approvedAt };
  if (record !== null) return { approval: 'approved', approvedAt: record.approvedAt };
  if (run !== null && run.state === 'Succeeded') return { approval: 'pending', approvedAt: null };
  return { approval: 'none', approvedAt: null };
}

/**
 * One board row. Without an expected row (the quarter's rows were not generated, or the sponsor
 * fund has no statement expected) the document is 'expected' with no due date and no age: the
 * board never invents a deadline (rule 10).
 */
export function boardRowOf(
  investment: BoardInvestment,
  periodEnd: string,
  asOf: string,
  settings: Pick<DocumentDefinitions, 'lateAfterDays' | 'missingAfterDays'>,
  inputs: { expected: BoardExpected | null; run: BoardRun | null; record: BoardRecord | null },
): MonitoringBoardRow {
  const { expected, run, record } = inputs;
  const judged = expected === null ? null : deriveExpected(expected, asOf, settings);
  return {
    investmentId: investment.id,
    investmentNumber: investment.investmentNumber,
    companyName: investment.companyName,
    vehicleName: investment.vehicleName,
    sponsorFundName: investment.sponsorFundName,
    dealType: investment.dealType,
    periodEnd,
    expectedDocumentId: expected?.id ?? null,
    documentStatus: judged?.status ?? 'expected',
    dueDate: expected?.dueDate ?? null,
    ageDays: judged?.ageDays ?? null,
    documentId: expected?.receivedDocumentId ?? run?.documentId ?? null,
    runId: run?.id ?? null,
    runState: run?.state ?? null,
    flagsCount: run?.flagsCount ?? 0,
    ...approvalOf(run, record),
  };
}

/** The board's totals: every row counted once by document status, and the rows awaiting or past approval. */
export function boardCounts(rows: readonly MonitoringBoardRow[]): MonitoringBoard['counts'] {
  const counts = { expected: 0, received: 0, late: 0, missing: 0, inReview: 0, approved: 0 };
  for (const row of rows) {
    counts[row.documentStatus] += 1;
    if (row.approval === 'pending') counts.inReview += 1;
    if (row.approval === 'approved') counts.approved += 1;
  }
  return counts;
}

/** The export's columns, in order: the row's fields by their contract names. */
export const BOARD_CSV_COLUMNS: readonly (keyof MonitoringBoardRow)[] = [
  'investmentNumber',
  'companyName',
  'vehicleName',
  'sponsorFundName',
  'dealType',
  'periodEnd',
  'documentStatus',
  'dueDate',
  'ageDays',
  'runState',
  'flagsCount',
  'approval',
  'approvedAt',
  'investmentId',
  'expectedDocumentId',
  'documentId',
  'runId',
];

/** The board's rows as CSV: a header line and one line per row, cells quoted only when they need it; a null is an empty cell. */
export function boardCsv(rows: readonly MonitoringBoardRow[]): string {
  return toCsv(
    BOARD_CSV_COLUMNS,
    rows.map((row) =>
      BOARD_CSV_COLUMNS.map((column) => {
        const value = row[column];
        return value === null ? '' : String(value);
      }),
    ),
  );
}
