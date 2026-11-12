import { D, ZERO, alignedQuarterEnd, containingQuarterEnd, nextQuarterEnd } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import type { SyntheticDataset } from '@pb/db';

/**
 * The NAV series a test expects, worked out straight from the seed rather than through the API's
 * code path: at every calendar quarter end on or before the as-of date, each given investment held
 * on that date counts at its latest Locked mark (dated on or before the as-of date) reporting for
 * that quarter or an earlier one; a quarter end at which one of them has no such mark is null. The
 * latest `quarters` points, oldest first.
 */
export function expectedNavSeries(
  dataset: SyntheticDataset,
  investmentIds: ReadonlySet<string>,
  quarters: number,
  toleranceDays: number,
): { periodEnd: string; value: Decimal | null }[] {
  const investments = dataset.investments.filter((i) => investmentIds.has(i.id));
  const marks = dataset.valuations
    .filter(
      (v) =>
        investmentIds.has(v.investmentId) && v.state === 'Locked' && v.periodEnd <= dataset.asOf,
    )
    .map((v) => ({ ...v, reportsFor: alignedQuarterEnd(v.periodEnd, toleranceDays) }));
  if (marks.length === 0 || quarters === 0) return [];
  const first = marks.reduce((a, m) => (m.reportsFor < a ? m.reportsFor : a), marks[0]!.reportsFor);
  const ends: string[] = [];
  for (let q = containingQuarterEnd(first); q <= dataset.asOf; q = nextQuarterEnd(q)) ends.push(q);
  return ends.slice(-quarters).map((periodEnd) => {
    let total: Decimal | null = ZERO;
    for (const inv of investments) {
      if (inv.entryDate > periodEnd || (inv.exitDate !== null && inv.exitDate <= periodEnd))
        continue;
      const own = marks
        .filter((m) => m.investmentId === inv.id && m.reportsFor <= periodEnd)
        .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
      if (own[0] === undefined) {
        total = null;
        break;
      }
      total = total.plus(D(own[0].fairValue));
    }
    return { periodEnd, value: total };
  });
}
