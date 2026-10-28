import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import type { z } from 'zod';
import { closingDetail, opportunityDetail, opportunityPage } from '@pb/contracts';
import type {
  AllocationsPutBody,
  ClosingCommandBody,
  ClosingDetail,
  ClosingItemCommandBody,
  DealStage,
  DiligenceTaskCommandBody,
  DiligenceTaskCreateBody,
  IcDecisionBody,
  LegalTermCommandBody,
  LegalTermCreateBody,
  OpportunityCommandBody,
  OpportunityCreateBody,
  OpportunityDetail,
} from '@pb/contracts';
import { api } from '../../api/client.js';
import { LIST_LIMIT } from '../../app/queries.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';

/*
 * Reads and writes of the pipeline (docs/04 M5), the closing (M8) and the legal terms and
 * allocations (M22), over CONTROL_ROUTES. One file per domain so app/queries.ts and
 * app/mutations.ts are not edited by every Phase 3 agent at once; the shapes follow theirs.
 */

export interface OpportunityFilters {
  stage?: DealStage | undefined;
  ownerId?: string | undefined;
}

/** Opportunities for the board, one page (the board groups them by stage client side). */
export function opportunitiesQuery(filters: OpportunityFilters = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(LIST_LIMIT));
  if (filters.stage) params.set('stage', filters.stage);
  if (filters.ownerId) params.set('ownerId', filters.ownerId);
  return queryOptions({
    queryKey: ['opportunities', filters],
    queryFn: () => api(`/api/v1/opportunities?${params.toString()}`, opportunityPage),
    retry: retryUnlessUnavailable,
  });
}

const opportunityPath = (id: string): string => `/api/v1/opportunities/${encodeURIComponent(id)}`;
const closingPath = (id: string): string => `/api/v1/closings/${encodeURIComponent(id)}`;

/** One opportunity with its history, tasks, decisions, allocations, closing summary and gates (404 when walled). */
export function opportunityQuery(id: string) {
  return queryOptions({
    queryKey: ['opportunity', id],
    queryFn: () => api(opportunityPath(id), opportunityDetail),
    retry: retryUnlessUnavailable,
  });
}

/** One closing record with its checklist, allocations, tie-out and legal terms. */
export function closingQuery(id: string) {
  return queryOptions({
    queryKey: ['closing', id],
    queryFn: () => api(closingPath(id), closingDetail),
    retry: retryUnlessUnavailable,
  });
}

function send<T>(
  method: 'POST' | 'PUT',
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
): Promise<T> {
  return api(path, schema, { method, body: JSON.stringify(body) });
}

/**
 * The reads a pipeline write can change: the board and the detail, the closing the detail
 * summarizes, and the audit trail every command writes to.
 */
const PIPELINE_KEYS: QueryKey[] = [['opportunities'], ['opportunity'], ['closing'], ['audit']];

/**
 * A stage command may convert the deal into a position (Closing to Closed), and a closing
 * command moves the close date every one-pager reads, so both refresh the portfolio reads too:
 * the grid, the detail, the vehicle and sponsor pages and every page that pools positions.
 */
const CONVERSION_KEYS: QueryKey[] = [
  ...PIPELINE_KEYS,
  ['investments'],
  ['investment'],
  ['investment-performance'],
  ['vehicles'],
  ['vehicle'],
  ['sponsors'],
  ['sponsor'],
  ['analytics-summary'],
  ['watchlist'],
  ['weekly-report'],
];

function invalidate(queryClient: QueryClient, keys: QueryKey[]): void {
  void Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/** The answer is the opportunity detail: the page shows it at once instead of waiting for a second read. */
function keepOpportunity(
  queryClient: QueryClient,
  detail: OpportunityDetail,
  keys: QueryKey[],
): void {
  queryClient.setQueryData(['opportunity', detail.id], detail);
  invalidate(queryClient, keys);
}

function keepClosing(queryClient: QueryClient, detail: ClosingDetail, keys: QueryKey[]): void {
  queryClient.setQueryData(['closing', detail.id], detail);
  invalidate(queryClient, keys);
}

export function useCreateOpportunity(): UseMutationResult<
  OpportunityDetail,
  Error,
  OpportunityCreateBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OpportunityCreateBody) =>
      send('POST', '/api/v1/opportunities', opportunityDetail, body),
    onSuccess: (detail) => keepOpportunity(queryClient, detail, PIPELINE_KEYS),
  });
}

export interface OpportunityCommandVariables {
  id: string;
  body: OpportunityCommandBody;
}

/** advance, pass or reopen (docs/18 section 4); the conversion on Closed refreshes the portfolio reads. */
export function useOpportunityCommand(): UseMutationResult<
  OpportunityDetail,
  Error,
  OpportunityCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: OpportunityCommandVariables) =>
      send('POST', `${opportunityPath(id)}/commands`, opportunityDetail, body),
    onSuccess: (detail) => keepOpportunity(queryClient, detail, CONVERSION_KEYS),
  });
}

export interface DiligenceTaskCommandVariables {
  id: string;
  taskId: string;
  body: DiligenceTaskCommandBody;
}

export function useDiligenceTaskCommand(): UseMutationResult<
  OpportunityDetail,
  Error,
  DiligenceTaskCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, taskId, body }: DiligenceTaskCommandVariables) =>
      send(
        'POST',
        `${opportunityPath(id)}/diligence-tasks/${encodeURIComponent(taskId)}/commands`,
        opportunityDetail,
        body,
      ),
    onSuccess: (detail) => keepOpportunity(queryClient, detail, PIPELINE_KEYS),
  });
}

export interface DiligenceTaskCreateVariables {
  id: string;
  body: DiligenceTaskCreateBody;
}

export function useCreateDiligenceTask(): UseMutationResult<
  OpportunityDetail,
  Error,
  DiligenceTaskCreateVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: DiligenceTaskCreateVariables) =>
      send('POST', `${opportunityPath(id)}/diligence-tasks`, opportunityDetail, body),
    onSuccess: (detail) => keepOpportunity(queryClient, detail, PIPELINE_KEYS),
  });
}

export interface IcDecisionVariables {
  id: string;
  body: IcDecisionBody;
}

export function useRecordIcDecision(): UseMutationResult<
  OpportunityDetail,
  Error,
  IcDecisionVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: IcDecisionVariables) =>
      send('POST', `${opportunityPath(id)}/ic-decisions`, opportunityDetail, body),
    onSuccess: (detail) => keepOpportunity(queryClient, detail, PIPELINE_KEYS),
  });
}

export interface AllocationsVariables {
  id: string;
  body: AllocationsPutBody;
}

/** Replaces the whole allocation list (M22); the closing's tie-out follows. */
export function usePutAllocations(): UseMutationResult<
  OpportunityDetail,
  Error,
  AllocationsVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: AllocationsVariables) =>
      send('PUT', `${opportunityPath(id)}/allocations`, opportunityDetail, body),
    onSuccess: (detail) => keepOpportunity(queryClient, detail, PIPELINE_KEYS),
  });
}

export interface ClosingItemCommandVariables {
  id: string;
  itemCode: string;
  body: ClosingItemCommandBody;
}

export function useClosingItemCommand(): UseMutationResult<
  ClosingDetail,
  Error,
  ClosingItemCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemCode, body }: ClosingItemCommandVariables) =>
      send(
        'POST',
        `${closingPath(id)}/items/${encodeURIComponent(itemCode)}/commands`,
        closingDetail,
        body,
      ),
    onSuccess: (detail) => keepClosing(queryClient, detail, PIPELINE_KEYS),
  });
}

export interface ClosingCommandVariables {
  id: string;
  body: ClosingCommandBody;
}

/** confirm or changeCloseDate (docs/18 section 12): the close date moves on every one-pager. */
export function useClosingCommand(): UseMutationResult<
  ClosingDetail,
  Error,
  ClosingCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: ClosingCommandVariables) =>
      send('POST', `${closingPath(id)}/commands`, closingDetail, body),
    onSuccess: (detail) => keepClosing(queryClient, detail, CONVERSION_KEYS),
  });
}

export interface LegalTermCreateVariables {
  id: string;
  body: LegalTermCreateBody;
}

export function useCreateLegalTerm(): UseMutationResult<
  ClosingDetail,
  Error,
  LegalTermCreateVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: LegalTermCreateVariables) =>
      send('POST', `${closingPath(id)}/legal-terms`, closingDetail, body),
    onSuccess: (detail) => keepClosing(queryClient, detail, PIPELINE_KEYS),
  });
}

export interface LegalTermCommandVariables {
  id: string;
  termId: string;
  body: LegalTermCommandBody;
}

export function useLegalTermCommand(): UseMutationResult<
  ClosingDetail,
  Error,
  LegalTermCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, termId, body }: LegalTermCommandVariables) =>
      send(
        'POST',
        `${closingPath(id)}/legal-terms/${encodeURIComponent(termId)}/commands`,
        closingDetail,
        body,
      ),
    onSuccess: (detail) => keepClosing(queryClient, detail, PIPELINE_KEYS),
  });
}
