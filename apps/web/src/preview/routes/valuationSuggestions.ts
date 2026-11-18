import { valuationSuggestionCommandBody, valuationSuggestionListQuery } from '@pb/contracts';
import type { ValuationSuggestionPage } from '@pb/contracts';
import { jsonResponse, problem } from '../problems.js';
import { defineSimRoute } from './common.js';

/*
 * Valuation suggestions in the static preview (docs/18 section 14, decision 0023). Nothing is
 * recorded: a suggestion exists only once a statement or a sponsor report is approved in the
 * session. The session keeps none yet (the derivation is not mirrored here), so these routes
 * answer as the API answers a book that holds no suggestion: an empty list for the roles that
 * read, 404 for any id, and the contract's own role guard and validation before that, which the
 * dispatcher applies. The pages therefore show their empty states and send no request the
 * preview cannot answer.
 */

/** The API's words for a suggestion the caller cannot see (apps/api/src/suggestions/rows.ts). */
const NOT_FOUND = 'Valuation suggestion not found';

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

/** GET /api/v1/valuation-suggestions: no suggestion is open, and no run of the session produced one. */
export const valuationSuggestionsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/valuation-suggestions',
  what: 'query',
  body: null,
  query: valuationSuggestionListQuery,
  handle: () => {
    const body: ValuationSuggestionPage = {
      items: [],
      nextCursor: null,
      openCount: 0,
      runOutcome: null,
    };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/valuation-suggestions/{id}: 404, as for any suggestion that does not exist. */
export const valuationSuggestionRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/valuation-suggestions/{id}',
  what: 'valuation suggestion',
  body: null,
  handle: (req) => notFound(req.url.pathname),
});

/** POST /api/v1/valuation-suggestions/{id}/commands: 404, since there is no suggestion to decide. */
export const valuationSuggestionCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/valuation-suggestions/{id}/commands',
  what: 'command',
  body: valuationSuggestionCommandBody,
  idempotent: true,
  handle: (req) => notFound(req.url.pathname),
});
