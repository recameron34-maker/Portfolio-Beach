import * as c from './controls.js';
import type { RouteDefinition } from './route.js';
import { API_PREFIX } from './route.js';
import * as s from './schemas.js';

/**
 * The Phase 3 control routes (decision 0013): valuations, capital notices with the wire register
 * and trade tickets, change requests, opportunities and closings. Wave 1 defines them here so the
 * web, the preview simulation and the API share one contract; since wave 2 the API serves them,
 * ROUTES spreads CONTROL_ROUTES in (routes.ts), the contract parity test requires every one of
 * them and the OpenAPI document lists them. SIMULATED_ROUTES keeps only the preview reset.
 *
 * Every command route is idempotent (docs/17 section 3: an Idempotency-Key repeats the original
 * result). Refusals map through WORKFLOW_REFUSALS (403 role, 409 transition, 422 precondition),
 * 412 is a stale If-Match row version and anything the caller cannot see is 404.
 */

const READ_ROLES = [
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'auditor',
] as const;

const TICKET_ROLES = ['operations', 'approver', 'auditor', 'deal_team'] as const;
const WIRE_ROLES = ['operations', 'approver', 'auditor', 'platform_admin'] as const;
const CHANGE_REQUEST_READ_ROLES = ['deal_team', 'operations', 'approver', 'auditor'] as const;

export const CONTROL_ROUTES: readonly RouteDefinition[] = [
  // ---- Valuations (M10, docs/18 section 1) ----
  {
    method: 'POST',
    path: `${API_PREFIX}/valuations`,
    summary: 'Create a Draft valuation version for an investment and period (docs/18 section 1)',
    tags: ['valuations'],
    roles: ['operations'],
    auth: true,
    body: c.valuationCreateBody,
    response: s.valuationRow,
    responseStatus: 201,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/valuations/{id}/commands`,
    summary:
      'Move a valuation through docs/18 section 1: prepare, send back, deal-team approve, lock with the hash (SEC-5.6), reopen into a new Draft',
    tags: ['valuations'],
    roles: ['operations', 'deal_team', 'approver'],
    auth: true,
    body: c.valuationCommandBody,
    response: s.valuationRow,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/valuations/batch-commands`,
    summary:
      'Approve or lock several versions at once (the batch approval screen); one result per id',
    tags: ['valuations'],
    roles: ['deal_team', 'approver'],
    auth: true,
    body: c.valuationBatchCommandBody,
    response: c.valuationBatchResult,
    idempotent: true,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/valuations/{id}`,
    summary:
      'A valuation version with its approval trail, the open change requests (M11) and the lock text',
    tags: ['valuations'],
    roles: READ_ROLES,
    auth: true,
    response: c.valuationDetail,
  },

  // ---- Capital notices (M16, docs/18 section 3) ----
  {
    method: 'POST',
    path: `${API_PREFIX}/capital-notices/{id}/commands`,
    summary:
      'Move a capital notice through docs/18 section 3: review, draft and approve the ticket under dual control (SEC-12.3), confirm funding, reconcile',
    tags: ['capital'],
    roles: ['operations', 'approver', 'service'],
    auth: true,
    body: c.capitalNoticeCommandBody,
    response: c.capitalNoticeControlDetail,
    idempotent: true,
  },

  // ---- Trade tickets (M16, SEC-12.3) ----
  {
    method: 'GET',
    path: `${API_PREFIX}/trade-tickets`,
    summary: 'Trade tickets with their release blockers (SEC-12.3)',
    tags: ['capital'],
    roles: TICKET_ROLES,
    auth: true,
    query: c.tradeTicketListQuery,
    response: c.tradeTicketPage,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/trade-tickets/{id}`,
    summary: 'One trade ticket (404 when its notice is not visible)',
    tags: ['capital'],
    roles: TICKET_ROLES,
    auth: true,
    response: c.tradeTicketRow,
  },

  // ---- Wire instruction register (M16, SEC-12.2) ----
  {
    method: 'GET',
    path: `${API_PREFIX}/wire-instructions`,
    summary: 'The wire instruction register, masked: every version per counterparty',
    tags: ['capital'],
    roles: WIRE_ROLES,
    auth: true,
    query: c.wireInstructionListQuery,
    response: c.wireInstructionPage,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/wire-instructions/{id}`,
    summary:
      'One instruction version; bank details in clear for operations and approvers only, null for every other role',
    tags: ['capital'],
    roles: WIRE_ROLES,
    auth: true,
    response: c.wireInstructionDetail,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/wire-instructions`,
    summary:
      'Propose a new instruction version for a counterparty, typed by a person from a verified source (SEC-12.1); encrypted at rest',
    tags: ['capital'],
    roles: ['operations'],
    auth: true,
    body: c.wireInstructionProposeBody,
    response: c.wireInstructionDetail,
    responseStatus: 201,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/wire-instructions/{id}/commands`,
    summary:
      'Record the callback: verify (by a person other than the proposer, SEC-12.2) or reject with a reason',
    tags: ['capital'],
    roles: ['operations', 'approver'],
    auth: true,
    body: c.wireInstructionCommandBody,
    response: c.wireInstructionDetail,
    idempotent: true,
  },

  // ---- Deal change requests (M11, docs/18 section 8) ----
  {
    method: 'GET',
    path: `${API_PREFIX}/change-requests`,
    summary: 'Deal change requests on the investments the caller can see',
    tags: ['change-requests'],
    roles: CHANGE_REQUEST_READ_ROLES,
    auth: true,
    query: c.changeRequestListQuery,
    response: c.changeRequestPage,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/change-requests/{id}`,
    summary: 'One change request (404 when its investment is not visible)',
    tags: ['change-requests'],
    roles: CHANGE_REQUEST_READ_ROLES,
    auth: true,
    response: c.changeRequestRow,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/change-requests`,
    summary: 'Submit a change request from the one form (docs/04 M11)',
    tags: ['change-requests'],
    roles: ['deal_team', 'operations'],
    auth: true,
    body: c.changeRequestCreateBody,
    response: c.changeRequestRow,
    responseStatus: 201,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/change-requests/{id}/commands`,
    summary:
      'Move a change request through docs/18 section 8: route to an owner (deal team), start, apply in a period or reject with a reason (operations)',
    tags: ['change-requests'],
    roles: ['deal_team', 'operations'],
    auth: true,
    body: c.changeRequestCommandBody,
    response: c.changeRequestRow,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/change-requests/quarter-end-check`,
    summary:
      'List every request not Applied by the quarter end and open a data exception for each (docs/18 section 8)',
    tags: ['change-requests'],
    roles: ['operations'],
    auth: true,
    body: c.quarterEndCheckBody,
    response: c.quarterEndCheckResult,
    idempotent: true,
  },

  // ---- Pipeline: opportunities (M5 skeleton, docs/18 section 4) ----
  {
    method: 'GET',
    path: `${API_PREFIX}/opportunities`,
    summary: 'Opportunities by stage for the pipeline board (grouped client side)',
    tags: ['pipeline'],
    roles: READ_ROLES,
    auth: true,
    query: c.opportunityListQuery,
    response: c.opportunityPage,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/opportunities/{id}`,
    summary:
      'An opportunity with its stage history, diligence tasks, IC decisions, allocations, closing and gates (404 when walled)',
    tags: ['pipeline'],
    roles: READ_ROLES,
    auth: true,
    response: c.opportunityDetail,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/opportunities`,
    summary: 'Create an opportunity at Sourced with the diligence template of its deal type',
    tags: ['pipeline'],
    roles: ['deal_team'],
    auth: true,
    body: c.opportunityCreateBody,
    response: c.opportunityDetail,
    responseStatus: 201,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/opportunities/{id}/commands`,
    summary:
      'Move an opportunity through docs/18 section 4: advance through the gates, pass with a reason code, reopen; closing converts it into an investment',
    tags: ['pipeline'],
    roles: ['deal_team', 'operations', 'approver'],
    auth: true,
    body: c.opportunityCommandBody,
    response: c.opportunityDetail,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/opportunities/{id}/diligence-tasks`,
    summary: 'Add a diligence task beside the template ones',
    tags: ['pipeline'],
    roles: ['deal_team'],
    auth: true,
    body: c.diligenceTaskCreateBody,
    response: c.opportunityDetail,
    responseStatus: 201,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/opportunities/{id}/diligence-tasks/{taskId}/commands`,
    summary: 'Complete a diligence task with its evidence, waive it with a reason, or reopen it',
    tags: ['pipeline'],
    roles: ['deal_team', 'approver'],
    auth: true,
    body: c.diligenceTaskCommandBody,
    response: c.opportunityDetail,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/opportunities/{id}/ic-decisions`,
    summary: 'Record an IC decision (a new row supersedes; the gate from IC to Approved)',
    tags: ['pipeline'],
    roles: ['approver'],
    auth: true,
    body: c.icDecisionBody,
    response: c.opportunityDetail,
    responseStatus: 201,
    idempotent: true,
  },
  {
    method: 'PUT',
    path: `${API_PREFIX}/opportunities/{id}/allocations`,
    summary: 'Replace the allocations by vehicle and client (requested against received, M22)',
    tags: ['pipeline'],
    roles: ['deal_team', 'operations'],
    auth: true,
    body: c.allocationsPutBody,
    response: c.opportunityDetail,
    idempotent: true,
  },

  // ---- Closing (M8) and legal terms (M22) ----
  {
    method: 'GET',
    path: `${API_PREFIX}/closings/{id}`,
    summary:
      'A closing record: the close date (single source), the checklist, legal terms and the allocation tie-out',
    tags: ['closings'],
    roles: READ_ROLES,
    auth: true,
    response: c.closingDetail,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/closings/{id}/items/{itemCode}/commands`,
    summary:
      'Mark a checklist item received with its document, waive it with a reason, or reopen it',
    tags: ['closings'],
    roles: ['operations', 'deal_team'],
    auth: true,
    body: c.closingItemCommandBody,
    response: c.closingDetail,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/closings/{id}/commands`,
    summary:
      'Operations confirmation once the required items are in and allocations tie out; a close-date change after it needs a reason and re-confirmation (audited)',
    tags: ['closings'],
    roles: ['operations'],
    auth: true,
    body: c.closingCommandBody,
    response: c.closingDetail,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/closings/{id}/legal-terms`,
    summary: 'Add a structured legal term in draft (M22)',
    tags: ['closings'],
    roles: ['deal_team', 'operations'],
    auth: true,
    body: c.legalTermCreateBody,
    response: c.closingDetail,
    responseStatus: 201,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/closings/{id}/legal-terms/{termId}/commands`,
    summary: 'Confirm a legal term against its source document',
    tags: ['closings'],
    roles: ['deal_team', 'operations'],
    auth: true,
    body: c.legalTermCommandBody,
    response: c.closingDetail,
    idempotent: true,
  },
];
