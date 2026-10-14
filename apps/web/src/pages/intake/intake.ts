import type {
  IntakeChange,
  IntakeCounts,
  IntakeFile,
  IntakeFileDetail,
  IntakeFinding,
  IntakeLink,
  IntakeRow,
  IntakeSource,
  StagingState,
} from '@pb/contracts';
import { DECIMAL_PATTERN, ROUTES } from '@pb/contracts';
import { stagingMachine } from '@pb/workflows';
import definitions from '../../../../../config/definitions.json';
import type { Tone } from '../../components/ui.js';
import { formatDate, formatMoneyM, MISSING, plural } from '../../lib/format.js';
import { commandOptions, rolesLabel } from '../../lib/states.js';

/*
 * Pure helpers of the intake pages (docs/04 M2, docs/18 section 2): counts, labels and which rows
 * an action applies to. Nothing here reads the network or the DOM.
 */

/** The page header's context line: the control every staged value passes through (docs/05). */
export const INTAKE_META = 'Staging, validation, approval, then production (SEC-9.1)';

/** What a role the intake routes refuse is told (the API answers 403; viewers, investor relations and platform admins). */
export const INTAKE_FORBIDDEN = {
  title: 'Intake is for operations and reviewers',
  detail:
    'Operations stages accounting exports and operations workbooks; operations, the deal team, approvers and auditors read them. Ask a platform administrator if you need access.',
};

/** The largest upload the API accepts (config/definitions.json intake.maxFileBytes); the page refuses it first. */
export const MAX_UPLOAD_BYTES: number = definitions.intake.maxFileBytes;

/**
 * The largest workbook the API accepts, in bytes: it caps the upload as base64
 * (config/definitions.json intake.maxWorkbookBase64Chars), and base64 writes four characters for
 * every three bytes, so the page refuses a larger file before encoding it.
 */
export const MAX_WORKBOOK_BYTES: number = Math.floor(
  (definitions.intake.maxWorkbookBase64Chars * 3) / 4,
);

/** The file as base64 for the upload body, encoded in slices so a large workbook never overflows the call stack. */
export function base64Of(bytes: Uint8Array): string {
  const SLICE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += SLICE)
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  return btoa(binary);
}

/** Where a file came from, in the words the list and the banner use (docs/04 M2). */
export const SOURCE_WORDS: Readonly<Record<IntakeSource, string>> = {
  accounting: 'Accounting',
  weekly: 'Weekly values',
  lookthrough: 'Look-through',
  ops_drop: 'Ops drop',
};

export function sourceWord(source: IntakeSource): string {
  return SOURCE_WORDS[source];
}

/**
 * "Template: quarterly-figures" for a workbook the ops drop matched, "Template: none matched" for
 * one it refused (its file findings say which templates exist), and nothing for any other source.
 */
export function templateLine(
  file: Pick<IntakeFile, 'source' | 'templateSignature'>,
): string | null {
  if (file.source !== 'ops_drop') return null;
  return `Template: ${file.templateSignature ?? 'none matched'}`;
}

/** The row states a reviewer filters by; new and approved are moments between two of these. */
export const INTAKE_FILTER_STATES: readonly StagingState[] = [
  'validated',
  'flagged',
  'promoted',
  'rejected',
];

export function isStagingState(value: string): value is StagingState {
  return (stagingMachine.states as readonly string[]).includes(value);
}

/** The sample exports the preview ships (scripts/build-preview.mjs publishes preview/samples). */
export const SAMPLE_SCENARIOS = ['clean', 'update', 'defects'] as const;
export type SampleScenario = (typeof SAMPLE_SCENARIOS)[number];

export function sampleFileName(scenario: SampleScenario): string {
  return `accounting-${scenario}.csv`;
}

/** Where the preview serves a bundled sample, relative to the page so the hash-routed preview resolves it against its own folder. */
export function samplePath(fileName: string): string {
  return `preview/samples/${fileName}`;
}

export function sampleUrl(scenario: SampleScenario): string {
  return samplePath(sampleFileName(scenario));
}

/** What the page says of a file with nothing in it; the API would refuse it with a less plain message. */
export const EMPTY_FILE_PROBLEM = 'The file is empty.';

/** "This file is 2.4 MB; the limit is 2 MB.", "The file is empty.", or null when the file may be sent. */
export function uploadSizeProblem(bytes: number, limit: number = MAX_UPLOAD_BYTES): string | null {
  if (bytes === 0) return EMPTY_FILE_PROBLEM;
  if (bytes <= limit) return null;
  const mb = (n: number): string => {
    const value = n / 1_000_000;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  };
  return `This file is ${mb(bytes)} MB; the limit is ${mb(limit)} MB.`;
}

/** "Jul 1, 2025" from an API timestamp: the date part only, as the list and the header show it. */
export function dayOf(iso: string): string {
  return formatDate(iso.slice(0, 10));
}

/** "3 validated, 2 flagged, 1 promoted": the counts that tell a reviewer what is left to do. */
export function countsLine(counts: IntakeCounts): string {
  return `${counts.validated} validated, ${counts.flagged} flagged, ${counts.promoted} promoted`;
}

export const DIFF_TONES: Readonly<Record<IntakeRow['diff']['kind'], Tone>> = {
  new: 'brand',
  changed: 'watch',
  unchanged: 'neutral',
};

export const DIFF_WORDS: Readonly<Record<IntakeRow['diff']['kind'], string>> = {
  new: 'New',
  changed: 'Changed',
  unchanged: 'Unchanged',
};

/** The figures a row can change, in the words the deal team uses. */
export const FIELD_LABELS: Readonly<Record<IntakeChange['field'], string>> = {
  revenueLtm: 'Revenue',
  ebitdaLtm: 'EBITDA',
  ev: 'EV',
  netDebt: 'Net debt',
};

/** Dollars to the cent, grouped and prefixed the way every other figure on these pages is written (docs/06). */
const EXACT_DOLLARS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * "$4,141,000.00": a figure exactly as the record or the file holds it, which is what the audit
 * trail will store (CLAUDE.md rule 6). Text that is not a decimal number is shown as the file
 * said it, since the reviewer must see what will be refused; null is the missing placeholder.
 */
export function exactMoney(value: string | null): string {
  if (value === null) return MISSING;
  const text = value.trim();
  return DECIMAL_PATTERN.test(text) ? EXACT_DOLLARS.format(Number(text)) : text;
}

/**
 * "EBITDA $4,140,000.00 to $4,141,000.00": the record's figure, then the file's, to the cent, so
 * a small restatement never reads as two equal numbers. The millions scale ("EBITDA $4.1M to
 * $4.1M") is the secondary label only.
 */
export function describeChange(
  change: IntakeChange,
  scale: 'exact' | 'millions' = 'exact',
): string {
  const money = scale === 'exact' ? exactMoney : formatMoneyM;
  return `${FIELD_LABELS[change.field]} ${money(change.before)} to ${money(change.after)}`;
}

export function findingTone(severity: IntakeFinding['severity']): Tone {
  return severity === 'error' ? 'bad' : 'watch';
}

/** "Expected 2025-06-30, actual 2025-06-16" when a finding carries both, else what it carries. */
export function findingDetail(finding: IntakeFinding): string | null {
  const parts: string[] = [];
  if (finding.expected !== null) parts.push(`Expected ${finding.expected}`);
  if (finding.actual !== null)
    parts.push(`${parts.length === 0 ? 'Actual' : 'actual'} ${finding.actual}`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** The investment number and company a row is about: the linked record's when linked, else the file's. */
export function rowSubject(row: Pick<IntakeRow, 'investmentNumber' | 'companyName' | 'link'>): {
  investmentNumber: string | null;
  companyName: string | null;
} {
  if (row.link.status === 'matched') {
    return {
      investmentNumber: row.link.investmentNumber ?? row.investmentNumber,
      companyName: row.link.companyName ?? row.companyName,
    };
  }
  return { investmentNumber: row.investmentNumber, companyName: row.companyName };
}

/** The short note beside an unlinked name: why the row has no investment (docs/03 section 5). */
export function linkNote(link: IntakeLink): string | null {
  switch (link.status) {
    case 'matched':
      return null;
    case 'guarded':
      return 'match guard';
    case 'ambiguous':
      return 'ambiguous';
    case 'unmatched':
      return 'no match';
  }
}

/** "Candidates: INV-0004 Silverline Staffing Holdings (near miss)" for a person to decide; never a link. */
export function candidatesText(candidates: IntakeLink['candidates']): string | null {
  if (candidates.length === 0) return null;
  return `Candidates: ${candidates
    .map((c) => `${c.investmentNumber} ${c.companyName} (${c.reason})`)
    .join('; ')}`;
}

export interface RowFilters {
  state: StagingState | '';
  search: string;
}

/** What the filters and the action gates read of a row; the accounting and the weekly rows both carry it. */
export type FilterableRow = Pick<IntakeRow, 'investmentNumber' | 'companyName' | 'link' | 'status'>;

/** Client-side filters over the one list the page reads: a state, and a search over number and company. */
export function filterRows<Row extends FilterableRow>(
  rows: readonly Row[],
  filters: RowFilters,
): Row[] {
  const needle = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.state !== '' && row.status !== filters.state) return false;
    if (needle === '') return true;
    const subject = rowSubject(row);
    const haystack = [
      subject.investmentNumber,
      subject.companyName,
      row.investmentNumber,
      row.companyName,
    ];
    return haystack.some((text) => text?.toLowerCase().includes(needle) ?? false);
  });
}

/** The rows an approve applies to: every validated row (docs/18 section 2). */
export function approvableRows<Row extends Pick<IntakeRow, 'status'>>(rows: readonly Row[]): Row[] {
  return rows.filter((r) => r.status === 'validated');
}

/** The rows a reject applies to: every flagged row. */
export function rejectableRows<Row extends Pick<IntakeRow, 'status'>>(rows: readonly Row[]): Row[] {
  return rows.filter((r) => r.status === 'flagged');
}

export interface ActionGate {
  /** The button is offered at all: the signed-in roles may issue intake commands. */
  offered: boolean;
  /** Live right now: the roles may issue it and a row is in the state it applies to. */
  enabled: boolean;
  /** Why it is disabled, for the button's title; null when enabled. */
  title: string | null;
}

export interface IntakeActions {
  approve: ActionGate;
  reject: ActionGate;
}

/** The contract's route for intake commands: POST /intake/files/{id}/commands. */
const COMMANDS_ROUTE_SUFFIX = '/intake/files/{id}/commands';

/**
 * Roles that may issue intake commands at all, read from the commands route in the contract
 * (packages/contracts routes.ts) so the page never keeps its own copy of that list. Were the
 * route missing, nobody would be offered a command, which the unit test catches.
 */
export const COMMAND_ROLES: readonly string[] =
  ROUTES.find((r) => r.method === 'POST' && r.path.endsWith(COMMANDS_ROUTE_SUFFIX))?.roles ?? [];

function gate(
  roles: readonly string[],
  from: StagingState,
  command: 'approve' | 'reject',
  count: number,
  nothing: string,
): ActionGate {
  const offered = roles.some((r) => COMMAND_ROLES.includes(r));
  const option = commandOptions(stagingMachine, from, roles).find((o) => o.command === command);
  if (!offered || option === undefined) return { offered, enabled: false, title: null };
  if (!option.allowed)
    return { offered, enabled: false, title: `Needs ${rolesLabel(option.roles)}` };
  if (count === 0) return { offered, enabled: false, title: nothing };
  return { offered, enabled: true, title: null };
}

/**
 * Which actions the signed-in roles may take on a file, from the staging transition table
 * (docs/18 section 2): approve from validated for operations and the deal team, reject from
 * flagged for operations. A command acts on the rows the reviewer sees, so the gate counts those,
 * not the file's counts: a validated row past the reviewer's wall is counted in hiddenRows and
 * waits for a wall member. A button with nothing to act on is disabled and says so.
 */
export function intakeActions(
  roles: readonly string[],
  rows: readonly Pick<IntakeRow, 'status'>[],
): IntakeActions {
  return {
    approve: gate(
      roles,
      'validated',
      'approve',
      approvableRows(rows).length,
      'No validated rows you can see to approve',
    ),
    reject: gate(
      roles,
      'flagged',
      'reject',
      rejectableRows(rows).length,
      'No flagged rows you can see to reject',
    ),
  };
}

/** "3 rows promoted": what an approve or reject did, from the counts before and after it. */
export function commandResult(
  before: IntakeCounts,
  after: IntakeCounts,
  command: 'approve' | 'reject',
): string {
  const key = command === 'approve' ? 'promoted' : 'rejected';
  const moved = Math.max(0, after[key] - before[key]);
  return `${plural(moved, 'row')} ${key}`;
}

/** "2 rows are linked to positions you cannot see": the wall, said without naming what is behind it. */
export function hiddenRowsNote(hiddenRows: number): string | null {
  if (hiddenRows <= 0) return null;
  return `${plural(hiddenRows, 'row')} ${hiddenRows === 1 ? 'is' : 'are'} linked to positions you cannot see`;
}

export interface NoRowsState {
  title: string;
  detail: string;
}

/**
 * What the rows card says when the reviewer sees no row at all, or null when there are rows to
 * show: nothing was staged (a refused file, or one with no data lines), or every staged row is
 * linked to a position behind a wall, which the file's counts still cover.
 */
export function noRowsState(
  file: Pick<IntakeFileDetail, 'rowCount' | 'hiddenRows' | 'fileFindings'> & {
    rows: readonly unknown[];
  },
): NoRowsState | null {
  if (file.rowCount === 0) {
    return {
      title: 'No rows were staged',
      detail:
        file.fileFindings.length > 0
          ? 'The file was refused before any row was read; the file findings above say why.'
          : 'The file holds no data lines.',
    };
  }
  if (file.rows.length > 0) return null;
  return file.hiddenRows > 0
    ? {
        title: 'Every row in this file is linked to positions you cannot see',
        detail:
          'The tiles above count every row in the file. Someone with access to those positions reviews them.',
      }
    : {
        title: 'No rows in this file are visible to you',
        detail: `The file holds ${plural(file.rowCount, 'row')}; none of them is in your view.`,
      };
}

/** The exceptions column: a count, or the placeholder for a file that staged no rows. */
export function exceptionsText(file: Pick<IntakeFile, 'exceptions' | 'rowCount'>): string {
  return file.rowCount === 0 && file.exceptions === 0 ? MISSING : String(file.exceptions);
}
