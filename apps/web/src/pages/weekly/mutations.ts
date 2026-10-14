import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseMutationResult } from '@tanstack/react-query';
import { weeklyFileDetail, weeklyImportResult } from '@pb/contracts';
import type {
  IntakeCommandBody,
  WeeklyFileDetail,
  WeeklyImportBody,
  WeeklyImportResult,
} from '@pb/contracts';
import { api } from '../../api/client.js';

/*
 * The writes of the weekly values pages (SEC-9.1): stage a file, approve or reject its rows. An
 * approve creates Draft valuations, which the valuation board and a position's valuations tab
 * read, so those reads are refreshed along with the weekly reads and the audit trail.
 */

/** POST /api/v1/intake/weekly: the CSV as text with its file name, or the id of a file in the drop folder. */
export function postWeeklyImport(body: WeeklyImportBody): Promise<WeeklyImportResult> {
  return api('/api/v1/intake/weekly', weeklyImportResult, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** POST /api/v1/intake/weekly/files/{id}/commands: approve validated rows (each a Draft valuation) or reject flagged ones. */
export function postWeeklyCommand(id: string, body: IntakeCommandBody): Promise<WeeklyFileDetail> {
  return api(`/api/v1/intake/weekly/files/${encodeURIComponent(id)}/commands`, weeklyFileDetail, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const WEEKLY_KEYS: QueryKey[] = [
  ['weekly-files'],
  ['weekly-file'],
  ['weekly-drops'],
  ['intake-files'],
  ['valuations'],
  ['investment'],
  ['data-health'],
  ['audit'],
];

function invalidate(queryClient: ReturnType<typeof useQueryClient>): void {
  void Promise.all(WEEKLY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export function useWeeklyImport(): UseMutationResult<WeeklyImportResult, Error, WeeklyImportBody> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: WeeklyImportBody) => postWeeklyImport(body),
    onSuccess: (result) => {
      // The detail page the import navigates to opens on the answer instead of a second read.
      queryClient.setQueryData(['weekly-file', result.id], result);
      invalidate(queryClient);
    },
  });
}

export interface WeeklyCommandVariables {
  id: string;
  body: IntakeCommandBody;
}

export function useWeeklyCommand(): UseMutationResult<
  WeeklyFileDetail,
  Error,
  WeeklyCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: WeeklyCommandVariables) => postWeeklyCommand(id, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(['weekly-file', updated.id], updated);
      invalidate(queryClient);
    },
  });
}
