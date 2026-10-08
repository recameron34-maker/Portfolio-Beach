import type { VehicleDetail, VehicleSummary } from '@pb/contracts';
import type { BarDatum } from '../../components/charts/index.js';
import { formatDate, MISSING } from '../../lib/format.js';

/**
 * Who may read client (LP) commitments: operations, approvers and auditors see every client, an
 * investor relations user only the clients they are entitled to, a platform admin none (SEC-5.4).
 */
export const CLIENT_DATA_VISIBILITY =
  'Client commitments are visible to operations, approvers, auditors and entitled investor relations users (SEC-5.4)';

/** Under the fund commitments: why a row can show the missing placeholder (docs/08 section 2). */
export const NO_CASH_FLOW_NOTE = `A commitment with no recorded cash flow by the as-of date shows the missing placeholder (${MISSING}) for called, distributed, recallable and unfunded.`;

/**
 * "2025-06-30" to "Q2 2025": the calendar quarter of a quarter-end date. Short period labels keep
 * every tick of the NAV chart readable at phone width; the missing placeholder when not a date.
 */
export function quarterLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
  const year = m?.[1];
  const month = Number(m?.[2]);
  if (year === undefined || !(month >= 1 && month <= 12)) return MISSING;
  return `Q${Math.ceil(month / 3)} ${year}`;
}

export function closingsLabel(count: number): string {
  return count === 1 ? '1 closing' : `${count} closings`;
}

export function finalCloseLabel(date: VehicleDetail['finalCloseDate']): string {
  return date === null ? 'Final close not yet' : `Final close ${formatDate(date)}`;
}

/** Bars for the active position count per vehicle, largest first; ties keep name order. */
export function activePositionBars(items: readonly VehicleSummary[]): BarDatum[] {
  return [...items]
    .sort((a, b) => b.activeInvestments - a.activeInvestments || a.name.localeCompare(b.name))
    .map((v) => ({
      label: v.name,
      value: v.activeInvestments,
      display: String(v.activeInvestments),
    }));
}
