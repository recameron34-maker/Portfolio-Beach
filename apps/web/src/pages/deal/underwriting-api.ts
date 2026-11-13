import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import { rowVersionEtag, underwritingCaseVersion, underwritingRead } from '@pb/contracts';
import type {
  UnderwritingCaseBody,
  UnderwritingCaseVersion,
  UnderwritingCommandBody,
} from '@pb/contracts';
import { api, ApiError } from '../../api/client.js';
import { invalidate, post } from '../../app/mutations.js';

/*
 * The reads and writes of a position's underwritten base case, beside the card that shows them
 * (the pattern of pages/valuations/api.ts and pages/pipeline/api.ts).
 */

export const underwritingPath = (investmentId: string): string =>
  `/api/v1/investments/${encodeURIComponent(investmentId)}/underwriting`;

const casePath = (id: string): string => `/api/v1/underwriting-cases/${encodeURIComponent(id)}`;

/** The key every read of one position's base case sits under, whichever version it compares. */
const readKey = (investmentId: string): QueryKey => [
  'investment-performance',
  investmentId,
  'underwriting',
];

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
    queryKey: [...readKey(investmentId), version ?? null],
    queryFn: () =>
      api(version === undefined ? path : `${path}?version=${version}`, underwritingRead),
    retry: false,
    staleTime: 60_000,
  });
}

/** The If-Match of a write: the row version the reader opened, so a change made meanwhile is refused, never overwritten. */
const ifMatch = (rowVersion: number): HeadersInit => ({ 'if-match': rowVersionEtag(rowVersion) });

/** POST /investments/{id}/underwriting: a new Draft, the first version or a revision (deal team). */
export function postUnderwritingCase(
  investmentId: string,
  body: UnderwritingCaseBody,
): Promise<UnderwritingCaseVersion> {
  return post(underwritingPath(investmentId), underwritingCaseVersion, body);
}

/** PATCH /underwriting-cases/{id}: replaces a Draft and its plan whole; its sender becomes the person who last changed the figures. */
export function patchUnderwritingCase(
  id: string,
  body: UnderwritingCaseBody,
  rowVersion: number,
): Promise<UnderwritingCaseVersion> {
  return api(casePath(id), underwritingCaseVersion, {
    method: 'PATCH',
    headers: ifMatch(rowVersion),
    body: JSON.stringify(body),
  });
}

/** POST /underwriting-cases/{id}/commands: confirm or withdraw a Draft, retire a Confirmed case. */
export function postUnderwritingCommand(
  id: string,
  body: UnderwritingCommandBody,
  rowVersion: number,
): Promise<UnderwritingCaseVersion> {
  return api(`${casePath(id)}/commands`, underwritingCaseVersion, {
    method: 'POST',
    headers: ifMatch(rowVersion),
    body: JSON.stringify(body),
  });
}

/** Whether a write was refused because the case changed since the reader opened it (412). */
export const isStaleCase = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 412;

/** A write to a base case changes every read of its position's base case, and the audit trail. */
function refresh(queryClient: QueryClient, investmentId: string): void {
  invalidate(queryClient, [readKey(investmentId), ['audit']]);
}

export interface SaveCaseVariables {
  body: UnderwritingCaseBody;
  /** The Draft being replaced, with the row version the form was opened on; left out for a new Draft. */
  draft?: { id: string; rowVersion: number } | undefined;
}

/**
 * Records a new Draft or replaces the one being edited. A refusal refreshes the read too: what
 * refuses a save is most often what somebody else did to the case meanwhile.
 */
export function useSaveUnderwritingCase(
  investmentId: string,
): UseMutationResult<UnderwritingCaseVersion, Error, SaveCaseVariables> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, draft }: SaveCaseVariables) =>
      draft === undefined
        ? postUnderwritingCase(investmentId, body)
        : patchUnderwritingCase(draft.id, body, draft.rowVersion),
    onSettled: () => refresh(queryClient, investmentId),
  });
}

export interface CaseCommandVariables {
  id: string;
  rowVersion: number;
  body: UnderwritingCommandBody;
}

/** Confirms, withdraws or retires a case; the read is refreshed whether it went through or not. */
export function useUnderwritingCommand(
  investmentId: string,
): UseMutationResult<UnderwritingCaseVersion, Error, CaseCommandVariables> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rowVersion, body }: CaseCommandVariables) =>
      postUnderwritingCommand(id, body, rowVersion),
    onSettled: () => refresh(queryClient, investmentId),
  });
}
