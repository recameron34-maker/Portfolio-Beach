import type { CapitalNoticeRow, CapitalNoticeState, FundCommitmentRow } from '@pb/contracts';
import { capitalNoticeMachine } from '@pb/workflows';
import definitions from '../../../../../config/definitions.json';
import type { BarDatum } from '../../components/charts/index.js';
import type { Tone } from '../../components/ui.js';
import { formatMoneyM, labelOf, MISSING } from '../../lib/format.js';

/**
 * Reminder days before a due date (config/definitions.json capitalActivity). The list endpoint
 * reports its own window; a single notice does not, so its page reads the configured list.
 */
export const ALERT_DAYS_BEFORE_DUE: readonly number[] =
  definitions.capitalActivity.alertDaysBeforeDue;

/** The seven states in the order of docs/18 section 3. */
export const NOTICE_STATES: readonly CapitalNoticeState[] = capitalNoticeMachine.states;

export function isNoticeState(value: string): value is CapitalNoticeState {
  return (NOTICE_STATES as readonly string[]).includes(value);
}

/** Money has moved: a Funded or Reconciled notice is no longer due, so it carries no due-date alert. */
export function isSettled(state: CapitalNoticeState): boolean {
  return state === 'Funded' || state === 'Reconciled';
}

/** Who the notice is about: the company for a deal notice, the sponsor fund for a commitment notice. */
export function noticeSubject(
  n: Pick<CapitalNoticeRow, 'companyName' | 'sponsorFundName' | 'vehicleName'>,
): string {
  return n.companyName ?? n.sponsorFundName ?? n.vehicleName;
}

/** $M for dollars; another currency keeps its code in place of the dollar sign ("EUR 2.5M"). */
export function noticeAmount(amount: string | null, currency: string): string {
  const text = formatMoneyM(amount);
  if (currency === 'USD' || text === MISSING) return text;
  return text.replace('$', `${currency} `);
}

/** "2 days" or "1 day". */
export function dayCount(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

export interface NoticeCounts {
  overdue: number;
  dueSoon: number;
  inFlight: number;
  reconciled: number;
}

/** Tile counts (counts of notices, never money): due-date alerts apply until the money moves. */
export function noticeCounts(
  items: readonly CapitalNoticeRow[],
  alertDaysBeforeDue: number,
): NoticeCounts {
  const counts: NoticeCounts = { overdue: 0, dueSoon: 0, inFlight: 0, reconciled: 0 };
  for (const n of items) {
    if (n.state === 'Reconciled') counts.reconciled += 1;
    else counts.inFlight += 1;
    if (isSettled(n.state)) continue;
    if (n.daysToDue < 0) counts.overdue += 1;
    else if (n.daysToDue <= alertDaysBeforeDue) counts.dueSoon += 1;
  }
  return counts;
}

export interface NoticeFilters {
  state: CapitalNoticeState | '';
  noticeType: string;
  vehicle: string;
  includeReconciled: boolean;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The full table: client-side filters over one unfiltered page, latest due date first. */
export function filterNotices(
  items: readonly CapitalNoticeRow[],
  f: NoticeFilters,
): CapitalNoticeRow[] {
  return items
    .filter(
      (n) =>
        (f.state === '' || n.state === f.state) &&
        (f.noticeType === '' || n.noticeType === f.noticeType) &&
        (f.vehicle === '' || n.vehicleName === f.vehicle) &&
        (f.includeReconciled || n.state !== 'Reconciled'),
    )
    .sort(
      (a, b) =>
        compareText(b.dueDate, a.dueDate) ||
        compareText(b.issueDate, a.issueDate) ||
        compareText(a.id, b.id),
    );
}

/** Needs attention: the most urgent due date first. */
export function byDueDate(items: readonly CapitalNoticeRow[]): CapitalNoticeRow[] {
  return [...items].sort((a, b) => compareText(a.dueDate, b.dueDate) || compareText(a.id, b.id));
}

/** Distinct notice type codes, ordered by their label. */
export function noticeTypes(items: readonly CapitalNoticeRow[]): string[] {
  return [...new Set(items.map((n) => n.noticeType))].sort((a, b) =>
    labelOf(a).localeCompare(labelOf(b)),
  );
}

export function distinctNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** Cash flow status codes ("record_status.approved"): approved or promoted is good, rejected bad, anything else waits. */
export function cashFlowTone(status: string): Tone {
  const tail = status.slice(status.indexOf('.') + 1);
  if (tail === 'approved' || tail === 'promoted') return 'good';
  if (tail === 'rejected') return 'bad';
  return 'watch';
}

export type StepStatus = 'done' | 'current' | 'upcoming';

/** The progress strip: every state before the current one is done, the rest are still to come. */
export function progressSteps(
  state: CapitalNoticeState,
): { state: CapitalNoticeState; status: StepStatus }[] {
  const at = NOTICE_STATES.indexOf(state);
  return NOTICE_STATES.map((s, i) => ({
    state: s,
    status: i < at ? 'done' : i === at ? 'current' : 'upcoming',
  }));
}

/* ---- Commitments and unfunded ---- */

export function isOverCalled(row: Pick<FundCommitmentRow, 'unfunded'>): boolean {
  return row.unfunded !== null && Number(row.unfunded) < 0;
}

export interface UnfundedChart {
  bars: BarDatum[];
  /** Commitments left out because no cash flow is recorded, so unfunded is not known. */
  omitted: number;
  /** Labels of the bars that read below zero: called beyond the commitment. */
  overCalled: string[];
}

/**
 * Unfunded per commitment for the chart, largest first. Number is used for bar geometry only; each
 * label shows the API's figure. A fund committed to from two vehicles or accounts keeps one bar
 * each, named with the account so the bars stay distinct.
 */
export function unfundedChart(rows: readonly FundCommitmentRow[]): UnfundedChart {
  const known = rows.filter((r) => r.unfunded !== null);
  const perFund = new Map<string, number>();
  for (const r of known) perFund.set(r.sponsorFundName, (perFund.get(r.sponsorFundName) ?? 0) + 1);
  const used = new Set<string>();
  const labelled = known.map((r) => {
    const base =
      (perFund.get(r.sponsorFundName) ?? 0) > 1
        ? `${r.sponsorFundName} (${r.clientName ?? r.vehicleName})`
        : r.sponsorFundName;
    let label = base;
    for (let n = 2; used.has(label); n += 1) label = `${base} ${n}`;
    used.add(label);
    return { row: r, label };
  });
  const bars = labelled
    .map(({ row, label }) => ({
      label,
      value: Number(row.unfunded),
      display: formatMoneyM(row.unfunded),
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return {
    bars,
    omitted: rows.length - known.length,
    overCalled: labelled.filter(({ row }) => isOverCalled(row)).map(({ label }) => label),
  };
}

/** The plain-language caveats under the chart: what is left out and what reads below zero. */
export function unfundedCaveats(chart: UnfundedChart): string[] {
  const out: string[] = [];
  if (chart.omitted > 0) {
    out.push(
      chart.omitted === 1
        ? '1 commitment has no recorded cash flow, so its unfunded is not known and it is left out.'
        : `${chart.omitted} commitments have no recorded cash flow, so their unfunded is not known and they are left out.`,
    );
  }
  if (chart.overCalled.length > 0) {
    const names = chart.overCalled.join(', ');
    out.push(
      chart.overCalled.length === 1
        ? `${names} is called beyond its commitment, so its unfunded reads below zero.`
        : `${names} are called beyond their commitments, so their unfunded reads below zero.`,
    );
  }
  return out;
}
