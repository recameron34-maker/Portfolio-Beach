import type { StagingState } from '@pb/workflows';

/**
 * What a staged file's status is made of (docs/18 section 2): the number of its rows in each
 * staging state. The API computes these from stg.intake_row and the preview from its simulated
 * rows, through these same two functions.
 */
export interface StagingCounts {
  new: number;
  validated: number;
  flagged: number;
  approved: number;
  rejected: number;
  promoted: number;
}

export const emptyCounts = (): StagingCounts => ({
  new: 0,
  validated: 0,
  flagged: 0,
  approved: 0,
  rejected: 0,
  promoted: 0,
});

export function countsOf(statuses: readonly StagingState[]): StagingCounts {
  const counts = emptyCounts();
  for (const status of statuses) counts[status] += 1;
  return counts;
}

/**
 * The file status from its rows (the contract's rule): flagged while any row is flagged, validated
 * while any row waits for approval, promoted once every row is promoted or rejected (rejected when
 * all are), and new only while the file holds no rows (it was refused).
 */
export function fileStatusOf(counts: StagingCounts): StagingState {
  const total =
    counts.new +
    counts.validated +
    counts.flagged +
    counts.approved +
    counts.rejected +
    counts.promoted;
  if (total === 0) return 'new';
  if (counts.flagged > 0) return 'flagged';
  if (counts.new + counts.validated + counts.approved > 0) return 'validated';
  return counts.promoted > 0 ? 'promoted' : 'rejected';
}
