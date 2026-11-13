import { queryOptions } from '@tanstack/react-query';
import { underwritingRead } from '@pb/contracts';
import { api } from '../../api/client.js';

/*
 * The reads and writes of a position's underwritten base case, beside the card that shows them
 * (the pattern of pages/valuations/api.ts and pages/pipeline/api.ts).
 */

export const underwritingPath = (investmentId: string): string =>
  `/api/v1/investments/${encodeURIComponent(investmentId)}/underwriting`;

/**
 * A position against its base case: every version of the case and the comparison with the entry
 * case, or with the version named. The API audits every open, so the answer stays fresh for a
 * minute and a tab switch reads the cache. The key sits under the position's
 * 'investment-performance' key, so every write that refreshes its performance (promoted
 * quarterly figures, a Locked valuation) refreshes this read with it.
 */
export function underwritingQuery(investmentId: string, version?: number) {
  const path = underwritingPath(investmentId);
  return queryOptions({
    queryKey: ['investment-performance', investmentId, 'underwriting', version ?? null],
    queryFn: () =>
      api(version === undefined ? path : `${path}?version=${version}`, underwritingRead),
    retry: false,
    staleTime: 60_000,
  });
}
