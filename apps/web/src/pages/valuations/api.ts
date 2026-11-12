import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseMutationResult } from '@tanstack/react-query';
import {
  changeRequestPage,
  changeRequestRow,
  quarterEndCheckResult,
  valuationBatchResult,
  valuationDetail,
  valuationRow,
} from '@pb/contracts';
import type {
  ChangeRequestCommandBody,
  ChangeRequestCreateBody,
  ChangeRequestRow,
  ChangeRequestState,
  QuarterEndCheckBody,
  QuarterEndCheckResult,
  ValuationBatchCommandBody,
  ValuationBatchResult,
  ValuationEditBody,
  ValuationRow,
} from '@pb/contracts';
import { api, ApiError } from '../../api/client.js';
import { describeActionError, invalidate, post, VALUATION_KEYS } from '../../app/mutations.js';
import { LIST_LIMIT } from '../../app/queries.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';

/*
 * The reads and writes of the valuation screen (docs/04 M10) and the deal change requests
 * (M11), over the control routes of packages/contracts/src/routes-controls.ts. Query keys start
 * with a fixed word so the invalidation lists in app/mutations.ts and below can name them;
 * every write refreshes the reads it can change and parks the answer where the page reads it.
 */

/**
 * The API writes an audit row for every open of a version's screen (SEC-11.1); a page that
 * re-renders within the minute reads the cache instead of writing another one.
 */
const AUDITED_READ_STALE_MS = 60_000;

/** One version with its approval trail, open change requests and lock text (GET /valuations/{id}; 404 when not visible). */
export function valuationDetailQuery(id: string) {
  return queryOptions({
    queryKey: ['valuation', id],
    queryFn: () => api(`/api/v1/valuations/${encodeURIComponent(id)}`, valuationDetail),
    retry: retryUnlessUnavailable,
    staleTime: AUDITED_READ_STALE_MS,
  });
}

export interface ChangeRequestFilters {
  investmentId?: string | undefined;
  state?: ChangeRequestState | undefined;
}

/**
 * Change requests newest first on the investments the caller can see (GET /change-requests).
 * The queue reads the one unfiltered page and filters in the browser; the deal workspace asks
 * for its own position's requests. Parameters go in a fixed order so each filter set has one
 * request shape.
 */
export function changeRequestsQuery(filters: ChangeRequestFilters = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(LIST_LIMIT));
  if (filters.investmentId) params.set('investmentId', filters.investmentId);
  if (filters.state) params.set('state', filters.state);
  return queryOptions({
    queryKey: ['change-requests', filters],
    queryFn: () => api(`/api/v1/change-requests?${params.toString()}`, changeRequestPage),
    retry: retryUnlessUnavailable,
  });
}

/** One change request (GET /change-requests/{id}; 404 when its investment is not visible). */
export function changeRequestQuery(id: string) {
  return queryOptions({
    queryKey: ['change-request', id],
    queryFn: () => api(`/api/v1/change-requests/${encodeURIComponent(id)}`, changeRequestRow),
    retry: retryUnlessUnavailable,
  });
}

/** POST /valuations/batch-commands: the same approval on several versions, one result per id. */
export function postValuationBatchCommand(
  body: ValuationBatchCommandBody,
): Promise<ValuationBatchResult> {
  return post('/api/v1/valuations/batch-commands', valuationBatchResult, body);
}

/**
 * PATCH /valuations/{id}: operations corrects a Draft (its method, its fair value, its method
 * inputs; any of them, at least one) before preparing it, which is how a reopened valuation
 * comes to carry a corrected value (docs/18 section 1). The If-Match header carries the row
 * version the form was opened on, so an edit made on a version someone changed meanwhile is
 * refused (412) instead of overwriting it; any state but Draft is 409.
 */
export function patchValuation(
  id: string,
  body: ValuationEditBody,
  rowVersion: number,
): Promise<ValuationRow> {
  return api(`/api/v1/valuations/${encodeURIComponent(id)}`, valuationRow, {
    method: 'PATCH',
    headers: { 'if-match': `"${rowVersion}"` },
    body: JSON.stringify(body),
  });
}

/**
 * The API's words when two writers raced for one version number (apps/api workflow.service.ts
 * versionTaken): a 409 with the transition problem code, which a refused command shares, so the
 * detail tells it apart.
 */
const VERSION_TAKEN = 'another version was created first';

/** Whether a failed create or reopen lost the race for a version number: the other version now exists. */
export function isVersionTaken(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.problem.detail ?? '').includes(VERSION_TAKEN)
  );
}

/**
 * The sentence for a failed valuation write. The lost race is not a state the person can act
 * on from the general wording ("not allowed from the current state"): it says what happened and
 * what to do, and the page refreshes the list (refreshIfVersionTaken). Anything else is worded
 * as every other refusal.
 */
export function describeValuationError(error: unknown): string {
  if (isVersionTaken(error))
    return 'Another version was created for this position and period first, so nothing was saved. The list is refreshed: continue with the version it shows.';
  return describeActionError(error);
}

/** POST /change-requests: the one form (M11); deal team and operations. */
export function postChangeRequest(body: ChangeRequestCreateBody): Promise<ChangeRequestRow> {
  return post('/api/v1/change-requests', changeRequestRow, body);
}

/** POST /change-requests/{id}/commands: route (deal team), start, apply or reject (operations). */
export function postChangeRequestCommand(
  id: string,
  body: ChangeRequestCommandBody,
): Promise<ChangeRequestRow> {
  return post(`/api/v1/change-requests/${encodeURIComponent(id)}/commands`, changeRequestRow, body);
}

/** POST /change-requests/quarter-end-check: the unapplied requests at a quarter end, each opening a data exception. */
export function postQuarterEndCheck(body: QuarterEndCheckBody): Promise<QuarterEndCheckResult> {
  return post('/api/v1/change-requests/quarter-end-check', quarterEndCheckResult, body);
}

/**
 * A change request write changes the queue, the request, the valuation screen that lists the
 * open requests of its investment, and the audit trail.
 */
export const CHANGE_REQUEST_KEYS: QueryKey[] = [
  ['change-requests'],
  ['change-request'],
  ['valuation'],
  ['audit'],
];

/** The quarter-end check opens data exceptions, which Data Health counts. */
const QUARTER_END_KEYS: QueryKey[] = [...CHANGE_REQUEST_KEYS, ['data-exceptions'], ['data-health']];

/** The batch screen: each version's command is its own write, so the whole valuation read set refreshes. */
export function useValuationBatchCommand(): UseMutationResult<
  ValuationBatchResult,
  Error,
  ValuationBatchCommandBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ValuationBatchCommandBody) => postValuationBatchCommand(body),
    onSuccess: () => invalidate(queryClient, VALUATION_KEYS),
  });
}

export interface ValuationEditVariables {
  id: string;
  body: ValuationEditBody;
  /** The row version the form was opened on (the If-Match the edit carries). */
  rowVersion: number;
}

/** The edit of a Draft changes the version's own screen, the board row and the audit trail: the valuation read set. */
export function useEditValuation(): UseMutationResult<ValuationRow, Error, ValuationEditVariables> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, rowVersion }: ValuationEditVariables) =>
      patchValuation(id, body, rowVersion),
    onSuccess: () => invalidate(queryClient, VALUATION_KEYS),
  });
}

/**
 * After a create or a reopen that lost the race for a version number, the list is out of date
 * (the other version exists): refresh the valuation reads so the person sees it.
 */
export function useRefreshIfVersionTaken(): (error: unknown) => void {
  const queryClient = useQueryClient();
  return (error) => {
    if (isVersionTaken(error)) invalidate(queryClient, VALUATION_KEYS);
  };
}

export function useCreateChangeRequest(): UseMutationResult<
  ChangeRequestRow,
  Error,
  ChangeRequestCreateBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ChangeRequestCreateBody) => postChangeRequest(body),
    onSuccess: (row) => {
      queryClient.setQueryData(['change-request', row.id], row);
      invalidate(queryClient, CHANGE_REQUEST_KEYS);
    },
  });
}

export interface ChangeRequestCommandVariables {
  id: string;
  body: ChangeRequestCommandBody;
}

export function useChangeRequestCommand(): UseMutationResult<
  ChangeRequestRow,
  Error,
  ChangeRequestCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: ChangeRequestCommandVariables) => postChangeRequestCommand(id, body),
    onSuccess: (row) => {
      queryClient.setQueryData(['change-request', row.id], row);
      invalidate(queryClient, CHANGE_REQUEST_KEYS);
    },
  });
}

export function useQuarterEndCheck(): UseMutationResult<
  QuarterEndCheckResult,
  Error,
  QuarterEndCheckBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: QuarterEndCheckBody) => postQuarterEndCheck(body),
    onSuccess: () => invalidate(queryClient, QUARTER_END_KEYS),
  });
}
