import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import type { z } from 'zod';
import { capitalNoticeRow, featureFlag, previewResetResult, valuationRow } from '@pb/contracts';
import type {
  CapitalNoticeCommand,
  CapitalNoticeRow,
  ValuationCommand,
  ValuationRow,
} from '@pb/contracts';
import type { z as zod } from 'zod';
import { api, ApiError } from '../api/client.js';
import { commandLabel, humanizeState } from '../lib/states.js';
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

export type FeatureFlag = zod.infer<typeof featureFlag>;

export interface FlagChange {
  key: string;
  enabled: boolean;
  /** Required by the API (at least three characters) and kept in the audit trail. */
  reason: string;
}

/** PATCH /api/v1/flags/{key}: platform admins only; audited by the API, simulated in the preview. */
export function patchFlag({ key, enabled, reason }: FlagChange): Promise<FeatureFlag> {
  return api(`/api/v1/flags/${encodeURIComponent(key)}`, featureFlag, {
    method: 'PATCH',
    body: JSON.stringify({ enabled, reason }),
  });
}

export function useFlagChange(): UseMutationResult<FeatureFlag, Error, FlagChange> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: FlagChange) => patchFlag(change),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['flags'] }),
  });
}

export function postPreviewReset(): Promise<{ reset: true }> {
  return post('/api/v1/preview/reset', previewResetResult);
}

const NOT_IN_THIS_BUILD = 'Workflow actions arrive with Phase 3; this build reads only.';

/**
 * The transition tables word their refusals for engineers ("valuation: lock from DealTeamApproved
 * requires one of: approver"). The user needs the rule only: drop the machine name, spell out state
 * and command names and start with a capital ("Lock from Deal team approved requires one of:
 * approver", "Confirm funding is not allowed from Ticket drafted").
 */
export function plainRule(detail: string): string {
  const rule = detail
    .replace(/^[a-z_]+: /, '')
    .replace(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, (state) => humanizeState(state))
    .replace(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g, (command) => commandLabel(command).toLowerCase());
  return rule.charAt(0).toUpperCase() + rule.slice(1);
}

/**
 * One sentence the user can act on, from an RFC 9457 problem (docs/17 section 3). The status codes
 * follow the mapping the workflow controller and the preview simulation share: 403 role, 409
 * transition not in the table, 422 precondition, 412 stale row version. Values are never echoed.
 */
export function describeActionError(error: unknown): string {
  if (!(error instanceof ApiError))
    return error instanceof Error ? error.message : 'The action failed.';
  const detail = plainRule(error.problem.detail ?? error.problem.title);
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

/**
 * The reads a write can change. A Locked valuation moves NAV wherever it is pooled (grid, one-pager,
 * performance, vehicle, sponsor, analytics, watchlist, weekly report); a funded notice moves called
 * and unfunded amounts and the report's capital activity. In the static preview these reads replay
 * their recordings (metrics are never recomputed), so refreshing them costs nothing; in Phase 3 it
 * keeps every page true after a write, including the reads held fresh for a minute.
 */
const VALUATION_KEYS: QueryKey[] = [
  ['valuations'],
  ['investment'],
  ['investments'],
  ['investment-performance'],
  ['vehicle'],
  ['vehicles'],
  ['sponsor'],
  ['analytics-summary'],
  ['watchlist'],
  ['weekly-report'],
  ['audit'],
];
const NOTICE_KEYS: QueryKey[] = [
  ['capital-notices'],
  ['capital-notice'],
  ['investment'],
  ['commitments'],
  ['vehicle'],
  ['sponsor'],
  ['clients'],
  ['weekly-report'],
  ['audit'],
];

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
