import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseMutationResult } from '@tanstack/react-query';
import { intakeExportList, intakeImportResult } from '@pb/contracts';
import type { IntakeImportResult, OpsDropImportBody } from '@pb/contracts';
import { api } from '../../api/client.js';
import { intakeFileQuery, intakeFilesQuery } from '../../app/queries.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';

/*
 * The reads and the one write of the operations workbook drop (docs/04 M2 ops-drop-import), kept
 * beside the intake page that uses them. The staged file is the same intake file the accounting
 * import produces, so its detail, its list and its commands are the shared intake queries and
 * mutations (app/queries.ts, app/mutations.ts).
 */

/** Workbooks waiting in the folder the ops drop adapter watches; operations only. */
export const opsDropDropsQuery = queryOptions({
  queryKey: ['intake-ops-drops'],
  queryFn: () => api('/api/v1/intake/ops-drop/drops', intakeExportList),
  retry: retryUnlessUnavailable,
});

/**
 * POST /api/v1/intake/ops-drop: stage an operations workbook (SEC-9.1). The body carries the
 * workbook as base64, or the id of one the drop folder lists; the API matches it to a template
 * and stages it like an accounting export, or refuses an unknown template with a file finding.
 */
export function postOpsDropImport(body: OpsDropImportBody): Promise<IntakeImportResult> {
  return api('/api/v1/intake/ops-drop', intakeImportResult, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * The reads a staged workbook changes: the intake list and the file itself, the drop folder (a
 * workbook staged from it may be removed), the exceptions Data Health counts and the audit trail.
 * Promotion happens later through the shared intake command, which refreshes the figures.
 */
const STAGED_WORKBOOK_KEYS: QueryKey[] = [
  intakeFilesQuery.queryKey,
  intakeFileQuery('').queryKey.slice(0, 1),
  opsDropDropsQuery.queryKey,
  ['data-health'],
  ['audit'],
];

export function useOpsDropImport(): UseMutationResult<
  IntakeImportResult,
  Error,
  OpsDropImportBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OpsDropImportBody) => postOpsDropImport(body),
    onSuccess: (result) => {
      // The detail page the import navigates to opens on the answer instead of a second read.
      queryClient.setQueryData(intakeFileQuery(result.id).queryKey, result);
      void Promise.all(
        STAGED_WORKBOOK_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}
