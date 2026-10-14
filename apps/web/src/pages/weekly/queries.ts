import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { intakeExportList, intakeFilePage, weeklyFileDetail } from '@pb/contracts';
import type { StagingState } from '@pb/contracts';
import { api } from '../../api/client.js';
import { LIST_LIMIT } from '../../app/queries.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';

/*
 * The reads of the weekly values pages (docs/04 M2 weekly-report-intake). The file list is the
 * shared intake list filtered by source; the detail and the drop folder are the weekly routes.
 * The keys start with "weekly" so a weekly detail is never mistaken for an accounting one.
 */

export interface WeeklyFileFilters {
  status?: StagingState | undefined;
}

/** Weekly files newest first, a page at a time on the API's cursor (GET /intake/files?source=weekly). */
export function weeklyFilesQuery(filters: WeeklyFileFilters = {}) {
  return infiniteQueryOptions({
    queryKey: ['weekly-files', filters],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set('limit', String(LIST_LIMIT));
      params.set('source', 'weekly');
      if (filters.status) params.set('status', filters.status);
      if (pageParam !== null) params.set('cursor', pageParam);
      return api(`/api/v1/intake/files?${params.toString()}`, intakeFilePage);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: retryUnlessUnavailable,
  });
}

export function weeklyFileQuery(id: string) {
  return queryOptions({
    queryKey: ['weekly-file', id],
    queryFn: () => api(`/api/v1/intake/weekly/files/${encodeURIComponent(id)}`, weeklyFileDetail),
    retry: retryUnlessUnavailable,
  });
}

/** Files waiting in the weekly drop folder; operations only. */
export const weeklyDropsQuery = queryOptions({
  queryKey: ['weekly-drops'],
  queryFn: () => api('/api/v1/intake/weekly/drops', intakeExportList),
  retry: retryUnlessUnavailable,
});
