import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import type { z } from 'zod';
import { capitalNoticeRow, previewResetResult, valuationRow } from '@pb/contracts';
import type {
  CapitalNoticeCommand,
  CapitalNoticeRow,
  ValuationCommand,
  ValuationRow,
} from '@pb/contracts';
import { api, ApiError } from '../api/client.js';
import { previewMode } from './env.js';

/**
 * Workflow writes (docs/18). The API serves them in Phase 3; the static preview simulates them in
 * the browser through the same transition tables (packages/contracts/src/simulated.ts). Pages go
 * through these helpers, never through fetch, so both paths share one request shape and one
 * vocabulary for refusals.
 */
export interface CommandBody<C extends string> {
  command: C;
  reason?: string;
}

export interface ValuationCreateBody {
  investmentId: string;
  periodEnd: string;
  method: string;
  fairValue: string;
}

function post<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  return api(path, schema, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function postValuation(body: ValuationCreateBody): Promise<ValuationRow> {
  return post('/api/v1/valuations', valuationRow, body);
}

export function postValuationCommand(
  id: string,
  body: CommandBody<ValuationCommand>,
): Promise<ValuationRow> {
  return post(`/api/v1/valuations/${encodeURIComponent(id)}/commands`, valuationRow, body);
}

export function postCapitalNoticeCommand(
  id: string,
  body: CommandBody<CapitalNoticeCommand>,
): Promise<CapitalNoticeRow> {
  return post(`/api/v1/capital-notices/${encodeURIComponent(id)}/commands`, capitalNoticeRow, body);
}

export function postPreviewReset(): Promise<{ reset: true }> {
  return post('/api/v1/preview/reset', previewResetResult);
}

const NOT_IN_THIS_BUILD = 'Workflow actions arrive with Phase 3; this build reads only.';

/**
 * One sentence the user can act on, from an RFC 9457 problem (docs/17 section 3). The status codes
 * follow the mapping the workflow controller and the preview simulation share: 403 role, 409
 * transition not in the table, 422 precondition, 412 stale row version. Values are never echoed.
 */
export function describeActionError(error: unknown): string {
  if (!(error instanceof ApiError))
    return error instanceof Error ? error.message : 'The action failed.';
  const detail = error.problem.detail ?? error.problem.title;
  switch (error.status) {
    case 400:
      return `The request was not valid. ${detail}`;
    case 401:
      return 'Your session is no longer valid. Sign in again.';
    case 403:
      return `Your role cannot do this. ${detail}`;
    case 404:
      return previewMode ? detail : NOT_IN_THIS_BUILD;
    case 409:
      return `Not allowed from the current state. ${detail}`;
    case 412:
      return 'Someone changed this record first. Reload and try again.';
    case 422:
      return `Blocked by a rule. ${detail}`;
    case 501:
      return NOT_IN_THIS_BUILD;
    default:
      return detail;
  }
}

export interface CommandVariables<C extends string> {
  id: string;
  body: CommandBody<C>;
}

const VALUATION_KEYS: QueryKey[] = [['valuations'], ['investment']];
const NOTICE_KEYS: QueryKey[] = [['capital-notices'], ['capital-notice'], ['investment']];

function invalidate(queryClient: QueryClient, keys: QueryKey[]): void {
  void Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export function useValuationCommand(): UseMutationResult<
  ValuationRow,
  Error,
  CommandVariables<ValuationCommand>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: CommandVariables<ValuationCommand>) =>
      postValuationCommand(id, body),
    onSuccess: () => invalidate(queryClient, VALUATION_KEYS),
  });
}

export function useCreateValuation(): UseMutationResult<ValuationRow, Error, ValuationCreateBody> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ValuationCreateBody) => postValuation(body),
    onSuccess: () => invalidate(queryClient, VALUATION_KEYS),
  });
}

export function useCapitalNoticeCommand(): UseMutationResult<
  CapitalNoticeRow,
  Error,
  CommandVariables<CapitalNoticeCommand>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: CommandVariables<CapitalNoticeCommand>) =>
      postCapitalNoticeCommand(id, body),
    onSuccess: () => invalidate(queryClient, NOTICE_KEYS),
  });
}

/** Preview only: forgets every simulated change in this page session. */
export function usePreviewReset(): UseMutationResult<{ reset: true }, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postPreviewReset(),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
}
