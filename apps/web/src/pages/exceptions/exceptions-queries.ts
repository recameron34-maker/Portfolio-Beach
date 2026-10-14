import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import { dataException, dataExceptionPage } from '@pb/contracts';
import type { DataException, DataExceptionCommandBody } from '@pb/contracts';
import { api } from '../../api/client.js';
import { LIST_LIMIT } from '../../app/queries.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';

/*
 * Reads and the one write of Data > Exceptions (docs/04 M1 Data Health, docs/18 section 9). The
 * queue is read with its filters as fixed, sorted parameters; a command posts to the exception's
 * own route and refreshes what it can change.
 */

export interface ExceptionFilters {
  state?: string | undefined;
  source?: string | undefined;
  severity?: string | undefined;
}

export function exceptionsQuery(filters: ExceptionFilters = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(LIST_LIMIT));
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.source) params.set('source', filters.source);
  if (filters.state) params.set('state', filters.state);
  return queryOptions({
    queryKey: ['data-exceptions', filters],
    queryFn: () => api(`/api/v1/data-exceptions?${params.toString()}`, dataExceptionPage),
    retry: retryUnlessUnavailable,
  });
}

export function exceptionQuery(id: string) {
  return queryOptions({
    queryKey: ['data-exception', id],
    queryFn: () => api(`/api/v1/data-exceptions/${encodeURIComponent(id)}`, dataException),
    retry: retryUnlessUnavailable,
  });
}

/** POST /api/v1/data-exceptions/{id}/commands: acknowledge, resolve or wont_fix through docs/18 section 9, or set the external ticket. */
export function postExceptionCommand(
  id: string,
  body: DataExceptionCommandBody,
): Promise<DataException> {
  return api(`/api/v1/data-exceptions/${encodeURIComponent(id)}/commands`, dataException, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface ExceptionCommandVariables {
  id: string;
  body: DataExceptionCommandBody;
}

/** A command changes the queue, the exception, the open count on Data Health and the audit trail. */
const COMMAND_KEYS: QueryKey[] = [
  ['data-exceptions'],
  ['data-exception'],
  ['data-health'],
  ['audit'],
];

function invalidate(queryClient: QueryClient, keys: QueryKey[]): void {
  void Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export function useExceptionCommand(): UseMutationResult<
  DataException,
  Error,
  ExceptionCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: ExceptionCommandVariables) => postExceptionCommand(id, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(['data-exception', updated.id], updated);
      invalidate(queryClient, COMMAND_KEYS);
    },
  });
}
