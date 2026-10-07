import { z } from 'zod';
import type { RouteDefinition } from './routes.js';
import { API_PREFIX } from './routes.js';
import * as s from './schemas.js';

/**
 * Write routes the static preview simulates in the browser through the @pb/workflows transition
 * tables. The API does not implement them yet (Phase 3: staging plus human approval, docs/18);
 * they are listed here so the preview, the future controllers and the docs share one contract.
 * They are deliberately not part of ROUTES: the contract parity test and the OpenAPI document
 * cover only what the API serves.
 */

export const valuationCommand = z.enum([
  'prepare',
  'sendBack',
  'dealTeamApprove',
  'lock',
  'reopen',
]);
export type ValuationCommand = z.infer<typeof valuationCommand>;

export const valuationCreateBody = z
  .object({
    investmentId: s.uuid,
    periodEnd: s.isoDate,
    method: z.string().min(1),
    fairValue: s.decimalString,
  })
  .strict();

export const valuationCommandBody = z
  .object({ command: valuationCommand, reason: z.string().min(3).optional() })
  .strict();

export const capitalNoticeCommand = z.enum([
  'extract',
  'review',
  'draftTicket',
  'approveTicket',
  'wireChanged',
  'confirmFunding',
  'reconcile',
]);
export type CapitalNoticeCommand = z.infer<typeof capitalNoticeCommand>;

export const capitalNoticeCommandBody = z
  .object({ command: capitalNoticeCommand, reason: z.string().min(3).optional() })
  .strict();

export const previewResetResult = z.object({ reset: z.literal(true) });

export const SIMULATED_ROUTES: readonly RouteDefinition[] = [
  {
    method: 'POST',
    path: `${API_PREFIX}/valuations`,
    summary: 'Create a Draft valuation version (simulated in the preview; Phase 3 in the API)',
    tags: ['valuations'],
    roles: ['operations'],
    auth: true,
    body: valuationCreateBody,
    response: s.valuationRow,
    responseStatus: 201,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/valuations/{id}/commands`,
    summary:
      'Move a valuation through docs/18 section 1 (simulated in the preview; Phase 3 in the API)',
    tags: ['valuations'],
    roles: [],
    auth: true,
    body: valuationCommandBody,
    response: s.valuationRow,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/capital-notices/{id}/commands`,
    summary:
      'Move a capital notice through docs/18 section 3 (simulated in the preview; Phase 3 in the API)',
    tags: ['capital'],
    roles: [],
    auth: true,
    body: capitalNoticeCommandBody,
    response: s.capitalNoticeRow,
  },
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
