import type {
  IntakeChange,
  IntakeCounts,
  IntakeFile,
  IntakeFinding,
  IntakeLink,
  IntakeRow,
  StagingState,
} from '@pb/contracts';
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
    'Operations stages accounting exports; operations, the deal team, approvers and auditors read them. Ask a platform administrator if you need access.',
};

/** The largest upload the API accepts (config/definitions.json intake.maxFileBytes); the page refuses it first. */
export const MAX_UPLOAD_BYTES: number = definitions.intake.maxFileBytes;

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

/** "This file is 2.4 MB; the limit is 2 MB." or null when the file may be sent. */
export function uploadSizeProblem(bytes: number, limit: number = MAX_UPLOAD_BYTES): string | null {
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

/** "EBITDA $4.1M to $4.0M": the record's figure, then the file's, both in $M. */
export function describeChange(change: IntakeChange): string {
  return `${FIELD_LABELS[change.field]} ${formatMoneyM(change.before)} to ${formatMoneyM(change.after)}`;
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

/** Client-side filters over the one list the page reads: a state, and a search over number and company. */
export function filterRows(rows: readonly IntakeRow[], filters: RowFilters): IntakeRow[] {
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
export function approvableRows(rows: readonly IntakeRow[]): IntakeRow[] {
  return rows.filter((r) => r.status === 'validated');
}

/** The rows a reject applies to: every flagged row. */
export function rejectableRows(rows: readonly IntakeRow[]): IntakeRow[] {
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

/** Roles that may issue intake commands at all (the commands route, packages/contracts routes.ts). */
const COMMAND_ROLES: readonly string[] = ['operations', 'deal_team'];

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
export function intakeActions(roles: readonly string[], rows: readonly IntakeRow[]): IntakeActions {
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

/** The exceptions column: a count, or the placeholder for a file that staged no rows. */
export function exceptionsText(file: Pick<IntakeFile, 'exceptions' | 'rowCount'>): string {
  return file.rowCount === 0 && file.exceptions === 0 ? MISSING : String(file.exceptions);
}
