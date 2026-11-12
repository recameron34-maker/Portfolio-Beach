import { addDays, daysBetween } from '@pb/calc';
import type { DocumentDefinitions, ExpectedDocumentStatus } from '@pb/contracts';

/*
 * The expected-document tracker's rules (docs/04 M3, decision 0012), pure so the list, the
 * monitoring board and the preview derive the same status from the same row. A status is never
 * stored: it is judged on an as-of day against the due date and the two aging thresholds of
 * config/definitions.json documents.*, so changing a threshold changes every row at once.
 */

/** The deal types whose sponsors report quarterly figures, so a quarterly_financials row is expected each quarter. */
export const QUARTERLY_REPORTING_DEAL_TYPES: readonly string[] = [
  'deal_type.co_invest_equity',
  'deal_type.cv_single_asset',
  'deal_type.cv_multi_asset',
];

/** The two document types the tracker expects: a report per investment, a statement per sponsor fund. */
export const EXPECTED_DOC_TYPES = {
  quarterlyFinancials: 'doc_type.quarterly_financials',
  capitalAccountStatement: 'doc_type.capital_account_statement',
} as const;

/** When a quarter's document is due: the period end plus the configured days. */
export function dueDateFor(
  periodEnd: string,
  settings: Pick<DocumentDefinitions, 'expectedDueDaysAfterQuarterEnd'>,
): string {
  return addDays(periodEnd, settings.expectedDueDaysAfterQuarterEnd);
}

/** What the derivation reads of an expected row: its due date and, when matched, the document and the day it was received. */
export interface ExpectedTiming {
  dueDate: string;
  receivedDocumentId: string | null;
  /** The calendar day (UTC) the matched document was received; null when none is matched. */
  receivedOn: string | null;
}

/**
 * received when a document is matched; otherwise expected until lateAfterDays past the due
 * date, late until missingAfterDays past it, missing after that.
 */
export function expectedStatusOf(
  row: ExpectedTiming,
  asOf: string,
  settings: Pick<DocumentDefinitions, 'lateAfterDays' | 'missingAfterDays'>,
): ExpectedDocumentStatus {
  if (row.receivedDocumentId !== null) return 'received';
  const overdue = daysBetween(row.dueDate, asOf);
  if (overdue <= settings.lateAfterDays) return 'expected';
  if (overdue <= settings.missingAfterDays) return 'late';
  return 'missing';
}

/**
 * Whole days from the due date to the as-of day (negative while not yet due); for a received
 * document, from the due date to the day it was received, so a late receipt keeps its age.
 */
export function expectedAgeDays(row: ExpectedTiming, asOf: string): number {
  const judged = row.receivedDocumentId !== null && row.receivedOn !== null ? row.receivedOn : asOf;
  return daysBetween(row.dueDate, judged);
}

/** The status and the age together, as the contract carries them on every expected row. */
export function deriveExpected(
  row: ExpectedTiming,
  asOf: string,
  settings: Pick<DocumentDefinitions, 'lateAfterDays' | 'missingAfterDays'>,
): { status: ExpectedDocumentStatus; ageDays: number } {
  return { status: expectedStatusOf(row, asOf, settings), ageDays: expectedAgeDays(row, asOf) };
}
