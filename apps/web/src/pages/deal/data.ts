import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { API_PREFIX, ROUTES } from '@pb/contracts';
import type {
  CapitalNoticeRow,
  InvestmentDetail,
  InvestmentPerformance,
  QuarterRow,
} from '@pb/contracts';
import definitions from '../../../../../config/definitions.json';
import { investmentQuery } from '../../app/queries.js';
import { formatDate, formatMoneyM, labelOf } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';

/* Data helpers shared by the deal workspace tabs. Pure functions and hooks only: components live in .tsx files. */

/** The position id from the workspace route; every tab sits under /portfolio/$id. */
export function useDealId(): string {
  return useParams({ from: '/app/portfolio/$id' }).id;
}

/**
 * The position the workspace already loaded. DealWorkspace holds the query for as long as the
 * workspace is open, so a tab reads the cache and never refetches on mount: each fetch of the
 * detail is an audited read (SEC-11.1), and switching tabs is not a reason to read it again.
 */
export function useDealDetail(): UseQueryResult<InvestmentDetail> {
  return useQuery({ ...investmentQuery(useDealId()), refetchOnMount: false });
}

/** Alert window for due dates (config capitalActivity.alertDaysBeforeDue), never hard-coded. */
export const ALERT_DAYS_BEFORE_DUE: readonly number[] =
  definitions.capitalActivity.alertDaysBeforeDue;

/** Roles the audit route admits, read from the contract's route table so the list lives in one place. */
const AUDIT_ROUTE = ROUTES.find(
  (r) => r.method === 'GET' && r.path === `${API_PREFIX}/audit/events`,
);
export const AUDIT_ROLES: readonly string[] = AUDIT_ROUTE?.roles ?? [];

/** True when the signed-in roles may read the audit trail; an empty role list means any signed-in user. */
export function canReadAudit(roles: readonly string[]): boolean {
  return AUDIT_ROLES.length === 0 || roles.some((r) => AUDIT_ROLES.includes(r));
}

/** Numbers feed chart geometry only; every displayed figure is formatted from the API's decimal string. */
export const toNumber = (value: string | null): number | null =>
  value === null ? null : Number(value);

/** "record_status.approved" and "approved" both count; any other status is still in review. */
export function isApproved(status: string): boolean {
  return status.slice(status.indexOf('.') + 1) === 'approved';
}

export function newestFirst<T extends { periodEnd: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
}

export function oldestFirst<T extends { periodEnd: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

/** Quarterly rows newest first with the entry snapshot placed by its own date (docs/08 section 5: pinned by flag). */
export function quarterRowsNewestFirst(perf: InvestmentPerformance): QuarterRow[] {
  const rows = perf.entry === null ? [...perf.quarters] : [...perf.quarters, perf.entry];
  return rows.sort(
    (a, b) =>
      b.periodEnd.localeCompare(a.periodEnd) ||
      Number(a.isEntrySnapshot) - Number(b.isEntrySnapshot),
  );
}

/** Quarters the LTM chart may plot: approved rows only, oldest first. */
export function approvedQuarters(perf: InvestmentPerformance): QuarterRow[] {
  return oldestFirst(perf.quarters.filter((q) => isApproved(q.status)));
}

/** How many of the latest quarters the Highlights card lists. */
export const HIGHLIGHT_QUARTERS = 4;

/** Why growth since entry is not shown: no snapshot, a snapshot after the as-of date, or no approved quarter yet. */
export type SinceEntryGap = 'no_entry' | 'forward_entry' | 'no_quarter';

export function sinceEntryGap(perf: InvestmentPerformance): SinceEntryGap | null {
  if (perf.sinceEntry !== null) return null;
  if (perf.entry === null) return 'no_entry';
  if (perf.entry.periodEnd > perf.asOf) return 'forward_entry';
  return 'no_quarter';
}

/** One valuation version as both the detail and the valuation list carry it. */
export interface VersionPoint {
  periodEnd: string;
  version: number;
  state: string;
  fairValue: string;
}

/** Newest period first, then the highest version first within a period. */
export function versionsNewestFirst<T extends VersionPoint>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.version - a.version);
}

/** Locked versions only, oldest first, one per period (the highest Locked version if a period has two). */
export function lockedSeries<T extends VersionPoint>(rows: readonly T[]): T[] {
  const byPeriod = new Map<string, T>();
  for (const r of rows) {
    if (r.state !== 'Locked') continue;
    const held = byPeriod.get(r.periodEnd);
    if (held === undefined || r.version > held.version) byPeriod.set(r.periodEnd, r);
  }
  return oldestFirst([...byPeriod.values()]);
}

/** The date part of an ISO timestamp ("2025-07-15T09:30:00Z" to "2025-07-15"); formatDate rejects anything else. */
export const datePart = (iso: string): string => iso.slice(0, 10);

export type TimelineKind = 'Cash flow' | 'Valuation' | 'Notice';

export interface TimelineEntry {
  key: string;
  date: string;
  kind: TimelineKind;
  text: string;
  /** Order among entries of the same date and kind: the version, or the position in the record. */
  rank: number;
}

/** The Activity tab shows at most this many entries, newest first. */
export const TIMELINE_LIMIT = 40;

const KIND_ORDER: Record<TimelineKind, number> = { Notice: 0, 'Cash flow': 1, Valuation: 2 };

/**
 * The position's history assembled only from records the user can already open: its cash flows,
 * its valuation versions and, when the endpoint answers, its capital notices. Newest first.
 */
export function timelineEntries(
  detail: InvestmentDetail,
  notices: readonly CapitalNoticeRow[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...detail.cashFlows.map((f, i): TimelineEntry => ({
      key: `flow-${f.date}-${i}`,
      date: f.date,
      kind: 'Cash flow',
      text: `${labelOf(f.flowType)} of ${formatMoneyM(f.amount)}`,
      rank: i,
    })),
    ...detail.valuations.map((v): TimelineEntry => ({
      key: `valuation-${v.periodEnd}-${v.version}`,
      date: v.periodEnd,
      kind: 'Valuation',
      text: `Valuation ${formatDate(v.periodEnd)} v${v.version}: ${humanizeState(v.state)}`,
      rank: v.version,
    })),
    ...notices.map((n, i): TimelineEntry => ({
      key: `notice-${n.id}`,
      date: n.issueDate,
      kind: 'Notice',
      text: `${labelOf(n.noticeType)} issued, due ${formatDate(n.dueDate)}`,
      rank: i,
    })),
  ];
  // Same date and kind: the later entry first (a higher version, a later recorded flow).
  return entries.sort(
    (a, b) =>
      b.date.localeCompare(a.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.rank - a.rank,
  );
}

/** Settled notices no longer carry a due-date badge (docs/18 section 3). */
export function isSettled(state: string): boolean {
  return state === 'Funded' || state === 'Reconciled';
}
