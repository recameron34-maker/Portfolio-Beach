import type { RouteDefinition } from './route.js';
import { API_PREFIX } from './route.js';
import * as u from './underwriting.js';

/**
 * The routes of a position's underwritten base case (docs/04 M9, docs/18 section 13, decision
 * 0022). A base case follows its position: whoever can open the position reads it, and a
 * position the caller cannot see is 404, its base case with it (SEC-5.3).
 */
export const UNDERWRITING_ROUTES: readonly RouteDefinition[] = [
  {
    method: 'GET',
    path: `${API_PREFIX}/investments/{id}/underwriting`,
    summary:
      "A position against the sponsor's underwritten base case: every version of the case, and the comparison with the entry case or the version named (revenue, EBITDA and net debt against plan, value creation against plan, gross IRR and MOIC against underwriting; 404 when not visible)",
    tags: ['analytics'],
    roles: [],
    auth: true,
    query: u.underwritingQuery,
    response: u.underwritingRead,
  },
];
