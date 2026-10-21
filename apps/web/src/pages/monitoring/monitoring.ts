import { containingQuarterEnd, latestQuarterEndOnOrBefore, nextQuarterEnd } from '@pb/calc';
import type {
  ExpectedDocumentStatus,
  ExtractionRunState,
  MonitoringApproval,
  MonitoringBoardRow,
} from '@pb/contracts';
import { isCalendarDate } from '@pb/contracts';
import definitions from '../../../../../config/definitions.json';
import type { Tone } from '../../components/ui.js';
import { formatDate, formatQuarter, MISSING, plural } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';

/*
 * Pure helpers of the monitoring board (docs/04 M9, decision 0012): words and tones for the
 * three statuses a row carries, the age of a report against its due date, the quarters a reader
 * may pick, and the CSV export's file name and row count. Nothing here reads the network or the
 * DOM; the download itself is the one browser call, kept at the bottom.
 */

/** The page header's context line. */
export const MONITORING_META =
  'Expected reports, extraction runs and approvals per active position, judged on the as-of day';

/**
 * The pages a row links to: the document and the run review, which land with this wave's
 * documents and extraction slices. Until router.tsx carries them they are plain path strings
 * (the router accepts a string target and resolves it at run time); once it does, the two can
 * become route literals and the links typed.
 */
export const LINKED_ROUTES: Readonly<Record<'document' | 'run', string>> = {
  document: '/documents/$id',
  run: '/documents/extraction/$id',
};
export const DOCUMENT_ROUTE = LINKED_ROUTES.document;
export const RUN_ROUTE = LINKED_ROUTES.run;

/** docs/04 M3: a report is late this many days after its due date, and missing after this many. */
export const LATE_AFTER_DAYS: number = definitions.documents.lateAfterDays;
export const MISSING_AFTER_DAYS: number = definitions.documents.missingAfterDays;

/** What the thresholds line under the board says, from config, never a copy of the numbers. */
export function thresholdsLine(): string {
  return `A report counts as late ${plural(LATE_AFTER_DAYS, 'day')} after its due date and as missing after ${plural(MISSING_AFTER_DAYS, 'day')} (config/definitions.json documents).`;
}

export const DOCUMENT_STATUS_WORDS: Readonly<Record<ExpectedDocumentStatus, string>> = {
  expected: 'Expected',
  received: 'Received',
  late: 'Late',
  missing: 'Missing',
};

/** docs/06: late and missing are the two states that need a person; received is done; expected is on its way. */
const DOCUMENT_STATUS_TONES: Readonly<Record<ExpectedDocumentStatus, Tone>> = {
  expected: 'neutral',
  received: 'good',
  late: 'watch',
  missing: 'bad',
};

export function documentStatusWord(status: ExpectedDocumentStatus): string {
  return DOCUMENT_STATUS_WORDS[status];
}

export function documentStatusTone(status: ExpectedDocumentStatus): Tone {
  return DOCUMENT_STATUS_TONES[status];
}

/** docs/18 section 7: a run that succeeded is done, a failed one is a refusal, the rest are in flight. */
const RUN_STATE_TONES: Readonly<Record<ExtractionRunState, Tone>> = {
  Queued: 'watch',
  Running: 'watch',
  Succeeded: 'good',
  Failed: 'bad',
  NeedsRetry: 'watch',
};

export function runStateTone(state: ExtractionRunState): Tone {
  return RUN_STATE_TONES[state];
}

/** "Succeeded", "Needs retry". */
export function runStateWord(state: ExtractionRunState): string {
  return humanizeState(state);
}

export const APPROVAL_WORDS: Readonly<Record<MonitoringApproval, string>> = {
  none: 'None',
  pending: 'Pending',
  approved: 'Approved',
};

/** Pending waits for a reviewer; approved reached the record; none is nothing yet. */
const APPROVAL_TONES: Readonly<Record<MonitoringApproval, Tone>> = {
  none: 'neutral',
  pending: 'watch',
  approved: 'good',
};

export function approvalWord(approval: MonitoringApproval): string {
  return APPROVAL_WORDS[approval];
}

export function approvalTone(approval: MonitoringApproval): Tone {
  return APPROVAL_TONES[approval];
}

/**
 * The age of a report against its due date, in words: "due in 45 days" and "due today" before and
 * on the due date, "16 days past due" after it, and for a received report how early or late it
 * came. Null when the board has no due date for the row (the quarter's expected rows were not
 * generated): the board never invents a deadline, so the cell shows the missing placeholder.
 */
export function ageLabel(status: ExpectedDocumentStatus, ageDays: number | null): string | null {
  if (ageDays === null) return null;
  if (status === 'received') {
    if (ageDays < 0) return `received ${plural(-ageDays, 'day')} early`;
    if (ageDays === 0) return 'received on the due date';
    return `received ${plural(ageDays, 'day')} late`;
  }
  if (ageDays < 0) return `due in ${plural(-ageDays, 'day')}`;
  if (ageDays === 0) return 'due today';
  return `${plural(ageDays, 'day')} past due`;
}

/** "Due Aug 14, 2025" when the row has a due date; null otherwise. */
export function dueLabel(dueDate: string | null): string | null {
  return dueDate === null ? null : `Due ${formatDate(dueDate)}`;
}

/** The flags column: undecided flagged and invalid values of the latest run; the placeholder when no run exists. */
export function flagsText(row: Pick<MonitoringBoardRow, 'runId' | 'flagsCount'>): string {
  return row.runId === null ? MISSING : String(row.flagsCount);
}

/**
 * The day a quarter was approved. The synthetic seed approves quarters without a time, so a
 * row can be approved with no date: the placeholder, never an error (wave 2 as built).
 */
export function approvedOnText(approvedAt: string | null): string {
  return approvedAt === null ? MISSING : formatDate(approvedAt.slice(0, 10));
}

/** "Q2 2025 (Jun 30, 2025)": how the quarter picker names a quarter end. */
export function quarterLabel(periodEnd: string): string {
  return `${formatQuarter(periodEnd)} (${formatDate(periodEnd)})`;
}

/** Every calendar quarter end from the one containing `first` to the one on or before `last`, oldest first. */
export function quarterEndsBetween(first: string, last: string): string[] {
  const stop = latestQuarterEndOnOrBefore(last);
  const ends: string[] = [];
  let end = containingQuarterEnd(first);
  while (end <= stop) {
    ends.push(end);
    end = nextQuarterEnd(end);
  }
  return ends;
}

/**
 * The quarters a reader may pick, newest first: from the quarter the earliest position entered
 * through the latest quarter end on or before the as-of day, always including the quarter the
 * board answered (so the picker names it even when the positions list has not loaded).
 */
export function periodOptions(
  entryDates: readonly string[],
  asOf: string,
  answered: string,
): string[] {
  const ends = new Set<string>([answered]);
  const earliest = [...entryDates].sort()[0];
  if (earliest !== undefined) for (const end of quarterEndsBetween(earliest, asOf)) ends.add(end);
  return [...ends].sort((a, b) => b.localeCompare(a));
}

/** A complete calendar day the as-of control may send; a partial or cleared value falls back to the API's today. */
export function isAsOfDate(value: string): boolean {
  return isCalendarDate(value.trim());
}

/** The file the export saves as; the same name the API puts in its Content-Disposition. */
export function exportFileName(periodEnd: string): string {
  return `monitoring-board-${periodEnd}.csv`;
}

/**
 * The rows in a CSV text: its lines beyond the header, with a line break inside a quoted cell
 * (RFC 4180) not counted as a row and a trailing line break not counted as an empty row.
 */
export function csvRowCount(text: string): number {
  let lines = 0;
  let quoted = false;
  let lineHasText = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === '\n' && !quoted) {
      if (lineHasText) lines += 1;
      lineHasText = false;
      continue;
    }
    if (char !== '\r') lineHasText = true;
  }
  if (lineHasText) lines += 1;
  return Math.max(0, lines - 1);
}

/** "Exported 15 rows to monitoring-board-2025-06-30.csv": what the export did. */
export function exportResult(rows: number, fileName: string): string {
  return `Exported ${plural(rows, 'row')} to ${fileName}`;
}

/**
 * Offers a text as a file download: a Blob behind an object URL on an anchor that is clicked,
 * then removed. The one browser call of this module; the URL is released once the click has
 * been handed to the browser.
 */
export function downloadText(fileName: string, text: string, mediaType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mediaType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
