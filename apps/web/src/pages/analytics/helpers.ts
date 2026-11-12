import type { ExposureBucket, VehicleDealTypeRow } from '@pb/contracts';
import type { BarDatum, StackDatum } from '../../components/charts/index.js';
import { formatMoneyM } from '../../lib/format.js';

/** Bars for one money field of the exposure buckets: Number for geometry, the formatted API figure as the label. */
export function bucketBars(
  buckets: readonly ExposureBucket[],
  field: 'nav' | 'invested',
): BarDatum[] {
  return buckets.map((b) => ({
    label: b.label,
    value: Number(b[field] ?? '0'),
    display: formatMoneyM(b[field]),
  }));
}

export interface VehicleDealTypeStack {
  data: StackDatum[];
  segmentNames: string[];
  /** Active positions left out because they have no Locked valuation. */
  excluded: number;
}

/**
 * The API's NAV per vehicle and deal type as stacked bars. The API sums every figure as a Decimal
 * and orders the vehicles and their segments (docs/08); here Number is for bar geometry only and
 * every label is the formatted API figure. The legend lists the deal types that appear, in the
 * order of the deal type buckets (the contract keys every segment by one of them); the excluded
 * count compares position counts, never money.
 */
export function vehicleDealTypeStack(
  rows: readonly VehicleDealTypeRow[],
  dealTypes: readonly ExposureBucket[],
  activeInvestments: number,
): VehicleDealTypeStack {
  const present = new Set(rows.flatMap((r) => r.segments.map((s) => s.key)));
  const segmentNames = dealTypes.filter((b) => present.has(b.key)).map((b) => b.label);
  const included = rows.reduce((n, r) => n + r.segments.reduce((m, s) => m + s.count, 0), 0);
  return {
    data: rows.map((r) => ({
      label: r.label,
      segments: r.segments.map((s) => ({
        name: s.label,
        value: Number(s.nav ?? '0'),
        display: formatMoneyM(s.nav),
      })),
    })),
    segmentNames,
    excluded: Math.max(0, activeInvestments - included),
  };
}
