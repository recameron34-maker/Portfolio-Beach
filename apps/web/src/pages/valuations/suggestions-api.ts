import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseMutationResult } from '@tanstack/react-query';
import { rowVersionEtag, valuationSuggestionPage, valuationSuggestionRow } from '@pb/contracts';
import type { ValuationSuggestionCommandBody, ValuationSuggestionRow } from '@pb/contracts';
import {
  SUGGESTION_BUSY_REFUSAL,
  SUGGESTION_CHANGED_REFUSAL,
  SUGGESTIONS_OFF_REFUSAL,
} from '@pb/workflows';
import { api, ApiError } from '../../api/client.js';
import { invalidate, VALUATION_KEYS } from '../../app/mutations.js';
import { LIST_LIMIT } from '../../app/queries.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';
import { describeValuationError } from './api.js';
import type { SuggestionStateFilter } from './suggestions.js';

/*
 * The reads and writes of the valuation suggestions (decision 0023), beside the pages that show
 * them (the pattern of pages/valuations/api.ts). Only the roles that read suggestions ask: a page
 * shown to anyone else leaves these queries disabled, so no request is sent for them.
 */

const BASE = '/api/v1/valuation-suggestions';

export interface SuggestionFilters {
  /** Open unless given; `all` lists every state. */
  state?: SuggestionStateFilter | undefined;
  investmentId?: string | undefined;
  /** A calendar quarter end. */
  periodEnd?: string | undefined;
  /** The approved run whose suggestions are asked for; the answer then says what that run did. */
  extractionRunId?: string | undefined;
}

/**
 * Suggestions newest first (GET /valuation-suggestions): Open unless a state is given. Parameters
 * go in a fixed order, so each filter set has one request shape. The first page only; the page
 * says when more exist.
 */
export function suggestionsQuery(filters: SuggestionFilters = {}) {
  const params = new URLSearchParams();
  if (filters.extractionRunId) params.set('extractionRunId', filters.extractionRunId);
  if (filters.investmentId) params.set('investmentId', filters.investmentId);
  params.set('limit', String(LIST_LIMIT));
  if (filters.periodEnd) params.set('periodEnd', filters.periodEnd);
  if (filters.state) params.set('state', filters.state);
  return queryOptions({
    queryKey: ['valuation-suggestions', filters],
    queryFn: () => api(`${BASE}?${params.toString()}`, valuationSuggestionPage),
    retry: retryUnlessUnavailable,
  });
}

/**
 * One suggestion with everything worked out beside it (GET /valuation-suggestions/{id}; 404 when
 * its position is not visible). The API audits every open, so the answer stays fresh for a minute.
 */
export function suggestionQuery(id: string) {
  return queryOptions({
    queryKey: ['valuation-suggestion', id],
    queryFn: () => api(`${BASE}/${encodeURIComponent(id)}`, valuationSuggestionRow),
    retry: retryUnlessUnavailable,
    staleTime: 60_000,
  });
}

/**
 * POST /valuation-suggestions/{id}/commands: accept, applyToDraft or dismiss (operations). The
 * If-Match header carries the row version the person was shown, so a suggestion somebody decided
 * or the system replaced meanwhile is refused instead of being decided twice.
 */
export function postSuggestionCommand(
  id: string,
  body: ValuationSuggestionCommandBody,
  rowVersion: number,
): Promise<ValuationSuggestionRow> {
  return api(`${BASE}/${encodeURIComponent(id)}/commands`, valuationSuggestionRow, {
    method: 'POST',
    headers: { 'if-match': rowVersionEtag(rowVersion) },
    body: JSON.stringify(body),
  });
}

/**
 * A decision changes the suggestions, and an accepted one opens or corrects a draft valuation:
 * the valuation read set, which holds the suggestions too.
 */
export const SUGGESTION_KEYS: QueryKey[] = VALUATION_KEYS;

export interface SuggestionCommandVariables {
  id: string;
  rowVersion: number;
  body: ValuationSuggestionCommandBody;
}

/**
 * Decides a suggestion. The reads are refreshed whether it went through or not: what refuses a
 * decision is most often that the suggestion was replaced, closed or decided meanwhile, and the
 * list must then show what stands.
 */
export function useSuggestionCommand(): UseMutationResult<
  ValuationSuggestionRow,
  Error,
  SuggestionCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rowVersion, body }: SuggestionCommandVariables) =>
      postSuggestionCommand(id, body, rowVersion),
    onSuccess: (row) => queryClient.setQueryData(['valuation-suggestion', row.id], row),
    onSettled: () => invalidate(queryClient, SUGGESTION_KEYS),
  });
}

/** The refusals that are whole sentences of their own: they say what happened and need no lead-in. */
const OWN_SENTENCES: readonly string[] = [
  SUGGESTION_CHANGED_REFUSAL,
  SUGGESTION_BUSY_REFUSAL,
  SUGGESTIONS_OFF_REFUSAL,
];

/**
 * The sentence for a refused decision. The three refusals of the suggestion workflow read as they
 * are (the figures changed, another approval is running, the switch is off); a stale row version
 * says the list was refreshed; anything else, the valuation workflow's own refusals included, is
 * worded as it is on the valuation board.
 */
export function describeSuggestionError(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.problem.detail ?? '';
    const own = OWN_SENTENCES.find((sentence) => detail.includes(sentence));
    if (own !== undefined)
      return own === SUGGESTION_CHANGED_REFUSAL ? `${own} The list is refreshed.` : own;
    if (error.status === 412)
      return 'Someone changed this suggestion first, so nothing was done. The list is refreshed: open it again.';
  }
  return describeValuationError(error);
}
