import { daysBetween } from '@pb/calc';
import type { ValuationRow } from './metrics.js';

/**
 * Latest Locked valuation whose period end is the target or up to `tolerance` days before it, so a
 * sponsor reporting a few days before the quarter end still counts for that quarter. On equal
 * period ends the first in input order wins. The prior mark of the valuations board and both
 * marks of the weekly report's movers.
 */
export function lockedNear(
  valuations: readonly ValuationRow[],
  target: string,
  tolerance: number,
): ValuationRow | null {
  let best: ValuationRow | null = null;
  for (const v of valuations) {
    if (v.state !== 'Locked') continue;
    const gap = daysBetween(v.periodEnd, target);
    if (gap < 0 || gap > tolerance) continue;
    if (best === null || v.periodEnd > best.periodEnd) best = v;
  }
  return best;
}
