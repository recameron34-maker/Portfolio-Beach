import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import { intakeFilePage, lookthroughReconcileResult, lookthroughRunDetail } from '@pb/contracts';
import type { LookthroughReconcileBody, LookthroughReconcileResult } from '@pb/contracts';
import { api } from '../../api/client.js';
import { LIST_LIMIT } from '../../app/queries.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';

/*
 * Reads and the one write of Data > Look-through (docs/04 M2 lookthrough-reconcile). The runs are
 * intake files of source lookthrough, listed through the shared intake files route; a run's rows
 * come from its own route. Every parameter set is fixed and sorted, as the preview recorder expects.
 */

export const LOOKTHROUGH_SOURCE = 'lookthrough';

export const lookthroughRunsQuery = queryOptions({
  queryKey: ['lookthrough-runs'],
  queryFn: () =>
    api(`/api/v1/intake/files?limit=${LIST_LIMIT}&source=${LOOKTHROUGH_SOURCE}`, intakeFilePage),
  retry: retryUnlessUnavailable,
});

export function lookthroughRunQuery(id: string) {
  return queryOptions({
    queryKey: ['lookthrough-run', id],
    queryFn: () =>
      api(`/api/v1/intake/lookthrough/runs/${encodeURIComponent(id)}`, lookthroughRunDetail),
    retry: retryUnlessUnavailable,
  });
}

/** POST /api/v1/intake/lookthrough/reconcile: operations only; idempotent, so a repeat answers the run made before with duplicate true. */
export function postReconcile(body: LookthroughReconcileBody): Promise<LookthroughReconcileResult> {
  return api('/api/v1/intake/lookthrough/reconcile', lookthroughReconcileResult, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * A run opens data exceptions, which the queue and Data Health count, and is itself an intake
 * file; nothing on record changes, so no portfolio read is refreshed.
 */
const RECONCILE_KEYS: QueryKey[] = [
  ['lookthrough-runs'],
  ['intake-files'],
  ['data-exceptions'],
  ['data-health'],
  ['audit'],
];

function invalidate(queryClient: QueryClient, keys: QueryKey[]): void {
  void Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export function useReconcile(): UseMutationResult<
  LookthroughReconcileResult,
  Error,
  LookthroughReconcileBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LookthroughReconcileBody) => postReconcile(body),
    onSuccess: (result) => {
      // The run page the reconcile navigates to opens on the answer instead of a second read.
      queryClient.setQueryData(['lookthrough-run', result.id], result);
      invalidate(queryClient, RECONCILE_KEYS);
    },
  });
}
