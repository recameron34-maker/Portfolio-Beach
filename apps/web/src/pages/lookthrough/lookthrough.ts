import type {
  IntakeFile,
  LookthroughDifference,
  LookthroughField,
  LookthroughRow,
  LookthroughRunDetail,
} from '@pb/contracts';
import { isCalendarDate } from '@pb/calc';
import type { Tone } from '../../components/ui.js';
import { labelOf, MISSING, plural } from '../../lib/format.js';
import { exactMoney } from '../intake/intake.js';

/*
 * Pure helpers of the look-through pages (docs/04 M2 lookthrough-reconcile, decision 0010):
 * labels, counts and the words of a difference. Nothing here reads the network or the DOM. The
 * finding, link and money helpers are the intake page's own (pages/intake/intake.ts), reused.
 */

/** The page header's context line: what a reconcile does and never does (docs/04 M1). */
export const LOOKTHROUGH_META =
  'Outside exposures against the taxonomy and the approved values; differences open exceptions and change nothing';

/** What a role the look-through routes refuse is told (the API answers 403). */
export const LOOKTHROUGH_FORBIDDEN = {
  title: 'Look-through is for operations and reviewers',
  detail:
    'Operations reconciles the provider extract; operations, the deal team, approvers and auditors read the runs. Ask a platform administrator if you need access.',
};

/** The as-of date typed in the run card: a real calendar date of the form YYYY-MM-DD. */
export function isReconcileDate(value: string): boolean {
  return isCalendarDate(value.trim());
}

/** The fields a reconcile compares, in the words the team uses. */
export const DIFFERENCE_LABELS: Readonly<Record<LookthroughField, string>> = {
  sector: 'Sector',
  geography: 'Geography',
  exposureAtCost: 'Cost',
  exposureAtNav: 'NAV',
};

const MONEY_FIELDS: ReadonlySet<LookthroughField> = new Set(['exposureAtCost', 'exposureAtNav']);

/**
 * "NAV $27,400,000.00 on record, provider $28,000,000.00" or "Sector sector.software on record,
 * provider Healthcare (sector.healthcare)": the record first, then what the provider sent, so the
 * reader never mistakes which side would change (nothing does).
 */
export function describeDifference(difference: LookthroughDifference): string {
  const label = DIFFERENCE_LABELS[difference.field];
  const money = MONEY_FIELDS.has(difference.field);
  const text = (value: string | null): string =>
    value === null ? MISSING : money ? exactMoney(value) : value;
  return `${label} ${text(difference.expected)} on record, provider ${text(difference.actual)}`;
}

/** "Technology (Software)": the provider's label with the taxonomy term it mapped to, or "unmapped". */
export function mappedLabel(label: string, code: string | null): string {
  if (code === null) return `${label} (unmapped)`;
  return `${label} (${labelOf(code)})`;
}

/** The record's figure beside the provider's: "$27,400,000.00" or the missing placeholder when the record has none. */
export function approvedText(value: string | null): string {
  return value === null ? MISSING : exactMoney(value);
}

export interface RunSummary {
  rows: number;
  matched: number;
  differences: number;
  exceptions: number;
}

/**
 * The run's tiles. Rows and exceptions are facts of the run, the same for every reader; matched
 * and differences are counted over the rows this reader sees (a walled row is in hiddenRows).
 */
export function runSummary(
  run: Pick<LookthroughRunDetail, 'rowCount' | 'rows' | 'exceptions'>,
): RunSummary {
  return {
    rows: run.rowCount,
    matched: run.rows.filter((r) => r.link.status === 'matched').length,
    differences: run.rows.reduce((n, r) => n + r.differences.length, 0),
    exceptions: run.exceptions,
  };
}

export const RUN_STATUS_TONES: Readonly<Record<string, Tone>> = {
  flagged: 'watch',
  validated: 'good',
  new: 'neutral',
};

/** A run's status in words: a run with a flagged row holds differences or defects for a person; a validated one agrees. */
export function runStatusWord(status: IntakeFile['status']): string {
  switch (status) {
    case 'flagged':
      return 'Differences';
    case 'validated':
      return 'Agrees';
    case 'new':
      return 'No extract';
    case 'approved':
    case 'promoted':
    case 'rejected':
      return status;
  }
}

export function runStatusTone(status: IntakeFile['status']): Tone {
  return RUN_STATUS_TONES[status] ?? 'neutral';
}

/** "2 validated, 1 flagged": what the run list says of a run's rows. */
export function runCountsLine(counts: IntakeFile['counts']): string {
  return `${counts.validated} agree, ${counts.flagged} flagged`;
}

/** The exceptions a row opened, as its badge count reads: "1 exception" or null for none. */
export function rowExceptionsText(row: Pick<LookthroughRow, 'exceptions'>): string | null {
  return row.exceptions === 0 ? null : plural(row.exceptions, 'exception');
}

/** The as-of date a run reports for, from its file name when the list has no date column: "lookthrough-2025-06-30.json". */
export function asOfFromFileName(fileName: string): string | null {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(fileName);
  const date = match?.[1];
  return date !== undefined && isCalendarDate(date) ? date : null;
}

/** What the run list says when there is nothing in it. */
export const NO_RUNS = {
  ops: 'Pick an as-of date above and reconcile the provider extract; the run appears here with its rows and differences.',
  others:
    'Operations reconciles the provider extract; each run appears here with its rows and differences.',
};
