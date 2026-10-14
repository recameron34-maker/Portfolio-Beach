import type { SyntheticDataset } from '@pb/db';

type Valuation = SyntheticDataset['valuations'][number];
type Investment = SyntheticDataset['investments'][number];

/**
 * The Locked mark that stands for a position on a date: the latest period end on or before it,
 * and the latest version of that period (the NAV date rule, docs/03 section 4). Null when the
 * position has no Locked mark by then.
 */
export function latestLockedMark(
  valuations: readonly Valuation[],
  investmentId: string,
  onOrBefore: string,
): Valuation | null {
  let best: Valuation | null = null;
  for (const v of valuations) {
    if (v.investmentId !== investmentId || v.state !== 'Locked' || v.periodEnd > onOrBefore)
      continue;
    if (
      best === null ||
      v.periodEnd > best.periodEnd ||
      (v.periodEnd === best.periodEnd && v.version > best.version)
    )
      best = v;
  }
  return best;
}

/** Active positions in investment number order: every deal type, or the equity and CV ones only. */
export function activePositions(
  dataset: SyntheticDataset,
  which: 'all' | 'equity' = 'all',
): Investment[] {
  return dataset.investments
    .filter((i) => i.isActive && (which === 'all' || i.dealType !== 'deal_type.private_credit'))
    .sort((a, b) => a.investmentNumber.localeCompare(b.investmentNumber));
}

/** The investment the walled_deal scenario tags, when the dataset has one. */
export function walledInvestment(dataset: SyntheticDataset): Investment | undefined {
  const id = dataset.scenarios.walled_deal?.[0];
  return dataset.investments.find((i) => i.id === id);
}

/**
 * The first `want` row indexes below `count` that a defect or a move may change in place, never
 * one in `taken`; the indexes given are added to `taken`, so every row is changed once at most.
 */
export function takeRows(
  count: number,
  taken: Set<number>,
  want: number,
  fits: (index: number) => boolean = () => true,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < count && out.length < want; i++) {
    if (taken.has(i) || !fits(i)) continue;
    taken.add(i);
    out.push(i);
  }
  return out;
}
