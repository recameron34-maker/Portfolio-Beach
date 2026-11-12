import { alignedQuarterEnd, isCalendarDate, lockedNear } from '@pb/calc';
import type { StagingState } from '@pb/workflows';
import { diffRow } from './diff.js';
import type { CurrentQuarter, RowDiff } from './diff.js';
import type { AccountingRow } from './layout.js';
import { linkInvestment } from './linking.js';
import type {
  InvestmentDirectoryEntry,
  LinkCandidate,
  LinkResult,
  LinkStatus,
  MatchGuardPair,
} from './linking.js';
import { ACCOUNTING_RULES } from './rules/accounting.js';
import type { LinkedRow } from './rules/accounting.js';
import type { IntakeSettings } from './settings.js';
import { runRules, statusFromFindings } from './types.js';
import type { Finding } from './types.js';

/**
 * Preparing an accounting export for staging (docs/04 M2): the pure part the API's intake service
 * and the preview shim share, so the two can never drift (CLAUDE.md rule 7). The API reads the
 * directory, the match guards, the approved quarters and the Locked marks from the database and the
 * preview reads them from its book; both link every row here, align it to its quarter, diff it
 * against the quarter on record, run the rules, open the same exceptions and pick the same rows for
 * a command.
 */

/** An approved quarter on record with the id a staged row would replace, as both sides read them. */
export interface RecordQuarter extends CurrentQuarter {
  id: string;
  isEntrySnapshot: boolean;
}

/** A Locked mark as lockedNear reads it: the state travels so no other state can ever tie. */
export interface LockedMark {
  periodEnd: string;
  fairValue: string;
  state: string;
}

/** What is on record for a linked investment: the API's maps or the preview book, behind one shape. */
export interface RecordLookups {
  /** The investment's approved quarters, oldest first. */
  quartersOf(investmentId: string): readonly RecordQuarter[];
  /** The investment's Locked marks, the highest version first within a period end. */
  marksOf(investmentId: string): readonly LockedMark[];
}

/** The outcome of reading and checking one row before anything is staged. */
export interface PreparedRow {
  row: AccountingRow;
  link: LinkResult;
  /** The calendar quarter end the row reports for (alignedQuarterEnd), when the period end is a real date. */
  quarterEnd: string | null;
  /** The approved quarter the row would replace; null for a quarter the record lacks. */
  targetId: string | null;
  diff: RowDiff;
  findings: Finding[];
  status: 'validated' | 'flagged';
}

/** The link as the contract carries it: ids and names of the matched investment, candidates otherwise. */
export interface LinkSummary {
  status: LinkStatus;
  investmentId: string | null;
  investmentNumber: string | null;
  companyName: string | null;
  candidates: LinkCandidate[];
}

export function linkOf(link: LinkResult): LinkSummary {
  return {
    status: link.status,
    investmentId: link.investment?.id ?? null,
    investmentNumber: link.investment?.investmentNumber ?? null,
    companyName: link.investment?.companyName ?? null,
    candidates: link.candidates,
  };
}

/** What linking reads of a row: the number and the name as the file wrote them (every intake's rows carry both). */
export interface LinkableRow {
  investmentNumber: string | null;
  companyName: string | null;
}

/** Every row of the file with the link the importer made for it, in file order; every intake links its rows here. */
export function linkRows<R extends LinkableRow>(
  rows: readonly R[],
  directory: readonly InvestmentDirectoryEntry[],
  guards: readonly MatchGuardPair[],
): { row: R; link: LinkResult }[] {
  return rows.map((row) => ({ row, link: linkInvestment(row, directory, guards) }));
}

export interface PrepareContext {
  /** Every row of the file with its link: the DUP rules key on each row's link and aligned quarter. */
  file: readonly LinkedRow[];
  /** The linked investment's approved quarters, oldest first; none for a row with no link. */
  quarters: readonly RecordQuarter[];
  /** The linked investment's Locked marks; none for a row with no link. */
  marks: readonly LockedMark[];
  asOf: string;
  settings: IntakeSettings;
}

/**
 * One row aligned, diffed and checked. The quarter it reports for is the calendar quarter end
 * within the tolerance of its period end. The approved quarter it would replace is the one at that
 * quarter end, or one that reports for the same quarter a few days off it (a sponsor closing its
 * books early). The Locked mark that counts is found by the same tolerance (docs/08 rule 7,
 * lockedNear in @pb/calc), so a mark a few days off the quarter end ties.
 */
export function prepareRow(
  row: AccountingRow,
  link: LinkResult,
  context: PrepareContext,
): PreparedRow {
  const tolerance = context.settings.toleranceDays;
  const period = row.periodEnd !== null && isCalendarDate(row.periodEnd) ? row.periodEnd : null;
  const quarterEnd = period === null ? null : alignedQuarterEnd(period, tolerance);
  const investmentId = link.investment?.id ?? null;
  const onRecord = investmentId === null ? [] : context.quarters;
  const current =
    quarterEnd === null
      ? null
      : (onRecord.find((q) => q.periodEnd === quarterEnd) ??
        onRecord.find((q) => alignedQuarterEnd(q.periodEnd, tolerance) === quarterEnd) ??
        null);
  const locked =
    quarterEnd === null || investmentId === null
      ? null
      : lockedNear(context.marks, quarterEnd, tolerance);
  const findings = runRules(ACCOUNTING_RULES, {
    row,
    file: context.file,
    link,
    current: {
      quarters: onRecord,
      lockedFairValue:
        locked === null ? null : { periodEnd: locked.periodEnd, fairValue: locked.fairValue },
    },
    asOf: context.asOf,
    config: context.settings.rules,
  });
  return {
    row,
    link,
    quarterEnd,
    targetId: current?.id ?? null,
    diff: diffRow(row, current),
    findings,
    status: statusFromFindings(findings),
  };
}

/** Every linked row of a file prepared against what is on record for the investment it links to. */
export function prepareRows(
  file: readonly LinkedRow[],
  lookups: RecordLookups,
  settings: IntakeSettings,
  asOf: string,
): PreparedRow[] {
  return file.map(({ row, link }) => {
    const investmentId = link.investment?.id ?? null;
    return prepareRow(row, link, {
      file,
      quarters: investmentId === null ? [] : lookups.quartersOf(investmentId),
      marks: investmentId === null ? [] : lookups.marksOf(investmentId),
      asOf,
      settings,
    });
  });
}

/** The rules whose findings open a data exception, named by the exception's rule id. */
export type ExceptionRuleId = 'XREF-01' | 'XREF-02' | 'XREF-03' | 'TIE-01';

/**
 * A data exception a prepared row opens. Every authenticated user may read exceptions, so a
 * candidate travels as its reason only, never as a number or a name that would say a position
 * exists (SEC-5.3); the candidates themselves stay on the staged row, shown to those who may see
 * them. A fair value that does not tie opens one with no values: the Locked mark and the file's
 * figure stay on the staged row, past the walls, not on a row everyone may read.
 */
export interface OpenedException {
  ruleId: ExceptionRuleId;
  expected: string | null;
  actual: string | null;
  candidates: { reason: LinkCandidate['reason'] }[];
}

const LINK_EXCEPTION: Record<Exclude<LinkStatus, 'matched'>, ExceptionRuleId> = {
  unmatched: 'XREF-01',
  guarded: 'XREF-02',
  ambiguous: 'XREF-03',
};

/** What the exception rule reads of a prepared row; a PreparedRow is one, and so is a staged weekly value. */
export interface ExceptionSource {
  row: LinkableRow;
  link: LinkResult;
  findings: readonly Finding[];
}

/** One exception per unresolved link, then one per fair value that does not tie, in that order. */
export function exceptionsOpenedBy(prepared: ExceptionSource): OpenedException[] {
  const out: OpenedException[] = [];
  if (prepared.link.status !== 'matched') {
    const ruleId = LINK_EXCEPTION[prepared.link.status];
    const finding = prepared.findings.find((f) => f.ruleId === ruleId);
    out.push({
      ruleId,
      expected: finding?.expected ?? 'an investment on record',
      actual: finding?.actual ?? prepared.row.investmentNumber ?? prepared.row.companyName ?? '',
      candidates: prepared.link.candidates.map((c) => ({ reason: c.reason })),
    });
  }
  for (const finding of prepared.findings) {
    if (finding.ruleId === 'TIE-01')
      out.push({ ruleId: 'TIE-01', expected: null, actual: null, candidates: [] });
  }
  return out;
}

/** Why a command's rowIds are refused: the callers answer it as a 400 on that field. */
export interface TargetRefusal {
  path: 'rowIds';
  message: string;
}

export type TargetSelection<Row> =
  { ok: true; rows: Row[] } | { ok: false; refusal: TargetRefusal };

/**
 * The rows a command acts on: the ones named, each a row of this file the caller sees and in the
 * state the command needs, or every such row when none is named. Naming a row the caller cannot
 * see is the same as naming a row of another file, so a wall never shows through a refusal.
 */
export function selectTargets<Row extends { id: string; status: StagingState }>(
  visible: readonly Row[],
  rowIds: readonly string[] | undefined,
  wanted: StagingState,
): TargetSelection<Row> {
  if (rowIds === undefined) return { ok: true, rows: visible.filter((r) => r.status === wanted) };
  const byId = new Map(visible.map((r) => [r.id, r]));
  const rows: Row[] = [];
  for (const id of new Set(rowIds)) {
    const found = byId.get(id);
    if (found?.status !== wanted)
      return {
        ok: false,
        refusal: {
          path: 'rowIds',
          message: `Every row must belong to this file and be ${wanted}`,
        },
      };
    rows.push(found);
  }
  return { ok: true, rows };
}
