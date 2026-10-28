import { z } from 'zod';
import type { RouteDefinition } from './route.js';
import { API_PREFIX } from './route.js';

/**
 * Routes that exist only in the static preview. The valuation and capital notice commands the
 * preview once simulated from here moved to CONTROL_ROUTES (routes-controls.ts) and are served by
 * the API since Phase 3 wave 2 (decision 0013); the preview still simulates them in the browser
 * through the @pb/workflows transition tables, reading their definitions from ROUTES. Only the
 * preview reset stays here, deliberately outside ROUTES: the contract parity test and the OpenAPI
 * document cover only what the API serves.
 */

/**
 * The valuation and capital notice bodies live in controls.ts since Phase 3 (decision 0013) and
 * are re-exported here so nothing that imported them from this module breaks.
 */
export {
  capitalNoticeCommand,
  capitalNoticeCommandBody,
  valuationCommand,
  valuationCommandBody,
  valuationCreateBody,
} from './controls.js';
export type { CapitalNoticeCommand, ValuationCommand } from './controls.js';

export const previewResetResult = z.object({ reset: z.literal(true) });

/** One refused workflow command as an RFC 9457 problem (docs/17 section 3). */
export interface WorkflowRefusal {
  status: 403 | 409 | 422;
  /** The problem `type` code, appended to the problem base URL. */
  code: string;
  title: string;
}

/**
 * How a refusal from `attempt()` in @pb/workflows answers over HTTP, keyed by its failure code. The
 * API's workflow controllers and the preview simulation share this one mapping so they cannot
 * drift: a role the table does not allow is 403, a command the table does not list from the
 * current state is 409, a failed precondition (segregation of duties, missing reason, unverified
 * wire) is 422. 412 stays reserved for a stale If-Match row version.
 */
export const WORKFLOW_REFUSALS = {
  role: { status: 403, code: 'forbidden', title: 'Forbidden' },
  forbidden: { status: 409, code: 'workflow-transition', title: 'Conflict' },
  precondition: { status: 422, code: 'workflow-precondition', title: 'Unprocessable' },
} as const satisfies Record<'role' | 'forbidden' | 'precondition', WorkflowRefusal>;
export type WorkflowRefusalCode = keyof typeof WORKFLOW_REFUSALS;

export const SIMULATED_ROUTES: readonly RouteDefinition[] = [
  {
    method: 'POST',
    path: `${API_PREFIX}/preview/reset`,
    summary: 'Forget every simulated change in this page session (preview only)',
    tags: ['preview'],
    roles: [],
    auth: true,
    response: previewResetResult,
  },
];
