import type { ExposureBucket, InvestmentSummary } from '@pb/contracts';
import type { BarDatum, StackDatum } from '../../components/charts/index.js';
import { sumDecimals } from '../../lib/decimal.js';
import { formatMoneyM, labelOf } from '../../lib/format.js';

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

export interface VehicleDealTypeBreakdown {
  data: StackDatum[];
  segmentNames: string[];
  /** Active positions left out because they have no Locked valuation. */
  excluded: number;
}

/**
 * NAV per vehicle split by deal type over the active rows. Segment totals are exact decimal
 * sums (never floats); Number is used for bar geometry only. Deal types keep the API's order
 * (largest NAV first) and vehicles sort by total NAV.
 */
export function vehicleByDealType(
  rows: readonly InvestmentSummary[],
  dealTypes: readonly ExposureBucket[],
): VehicleDealTypeBreakdown {
  const rank = (code: string): number => {
    const i = dealTypes.findIndex((b) => b.key === code);
    return i === -1 ? dealTypes.length : i;
  };
  const labelFor = (code: string): string =>
    dealTypes.find((b) => b.key === code)?.label ?? labelOf(code);
  const vehicles = new Map<string, Map<string, string[]>>();
  let excluded = 0;
  for (const r of rows) {
    if (r.nav === null) {
      excluded += 1;
      continue;
    }
    const byType = vehicles.get(r.vehicleName) ?? new Map<string, string[]>();
    const navs = byType.get(r.dealType) ?? [];
    navs.push(r.nav);
    byType.set(r.dealType, navs);
    vehicles.set(r.vehicleName, byType);
  }
  const codes = [...new Set(rows.filter((r) => r.nav !== null).map((r) => r.dealType))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  const data = [...vehicles.entries()]
    .map(([label, byType]) => {
      const segments = codes.flatMap((code) => {
        const navs = byType.get(code);
        if (navs === undefined) return [];
        const total = sumDecimals(navs);
        return [
          { name: labelFor(code), value: Number(total ?? '0'), display: formatMoneyM(total) },
        ];
      });
      return { label, segments, total: segments.reduce((s, seg) => s + seg.value, 0) };
    })
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
    .map(({ label, segments }) => ({ label, segments }));
  return { data, segmentNames: codes.map(labelFor), excluded };
}
