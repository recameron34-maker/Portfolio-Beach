import type { RouteDefinition } from './route.js';
import { API_PREFIX } from './route.js';
import * as u from './underwriting.js';

/**
 * The routes of a position's underwritten base case (docs/04 M9, docs/18 section 13, decision
 * 0022). A base case follows its position: whoever can open the position reads it, and a
 * position the caller cannot see is 404, its base case with it (SEC-5.3). The deal team records
 * and edits a Draft; the deal team and approvers move a case on, each command narrowed to its
 * role by the state machine. Refusals map as on the control routes: 403 role, 409 transition,
 * 422 precondition, 412 a stale If-Match. Every write answers the version it wrote, with its row
 * version as the ETag.
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
  {
    method: 'POST',
    path: `${API_PREFIX}/investments/{id}/underwriting`,
    summary:
      'Record a Draft of the base case of a position: the first version, a correction dated as a Confirmed case, or a re-underwriting dated later, with a reason from version 2 (one Draft per position; a second person confirms it)',
    tags: ['analytics'],
    roles: ['deal_team'],
    auth: true,
    body: u.underwritingCaseBody,
    response: u.underwritingCaseVersion,
    responseStatus: 201,
    idempotent: true,
  },
  {
    method: 'PATCH',
    path: `${API_PREFIX}/underwriting-cases/{id}`,
    summary:
      'Replace a Draft base case and its plan points; whoever edits it becomes the person who last changed the figures, and so cannot confirm it',
    tags: ['analytics'],
    roles: ['deal_team'],
    auth: true,
    body: u.underwritingCaseBody,
    response: u.underwritingCaseVersion,
    idempotent: true,
    ifMatch: 'underwriting_case',
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/underwriting-cases/{id}/commands`,
    summary:
      'Move a base case through docs/18 section 13: confirm a Draft (never the person who last changed the figures; a correction supersedes the case it corrects), withdraw a Draft with a reason, retire a Confirmed case with a reason (approver)',
    tags: ['analytics'],
    roles: ['deal_team', 'approver'],
    auth: true,
    body: u.underwritingCommandBody,
    response: u.underwritingCaseVersion,
    idempotent: true,
    ifMatch: 'underwriting_case',
  },
];
