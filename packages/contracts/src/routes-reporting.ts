import * as r from './reporting.js';
import type { RouteDefinition } from './route.js';
import { API_PREFIX } from './route.js';

/**
 * The reporting package routes (docs/04 M14, docs/18 section 5). A package is client data: the
 * role lists here admit the roles that may ever read one, and row-level security then shows each
 * caller only the clients it reads (SEC-5.2). Anything the caller cannot see is 404. Refusals
 * map as on the control routes: 403 role, 409 transition, 422 precondition, 412 a stale If-Match.
 */

const PACKAGE_READ_ROLES = [
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'auditor',
] as const;

export const REPORTING_ROUTES: readonly RouteDefinition[] = [
  {
    method: 'GET',
    path: `${API_PREFIX}/report-packages`,
    summary: 'Reporting packages of the clients the caller reads, newest period first',
    tags: ['reporting'],
    roles: PACKAGE_READ_ROLES,
    auth: true,
    response: r.reportPackageList,
  },
  {
    method: 'GET',
    path: `${API_PREFIX}/report-packages/{id}`,
    summary: 'One package with the snapshot it shows and the findings of its latest QA run',
    tags: ['reporting'],
    roles: PACKAGE_READ_ROLES,
    auth: true,
    response: r.reportPackageDetail,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/report-packages`,
    summary:
      'Start a package for a client, a quarter and a basis; a new version when one was Released, with a reason',
    tags: ['reporting'],
    roles: ['investor_relations'],
    auth: true,
    body: r.reportPackageCreateBody,
    response: r.reportPackageDetail,
    responseStatus: 201,
    idempotent: true,
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/report-packages/{id}/commands`,
    summary:
      'Move a package through docs/18 section 5: generate and run QA, regenerate after a fix, override a failed QA with a reason (approver), submit, approve (never the preparer), release',
    tags: ['reporting'],
    roles: ['investor_relations', 'approver', 'operations'],
    auth: true,
    body: r.reportPackageCommandBody,
    response: r.reportPackageDetail,
    idempotent: true,
    ifMatch: 'reporting_package',
  },
];
