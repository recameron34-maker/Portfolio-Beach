import { principal } from '@pb/contracts';
import { problem, validationProblem } from '../problems.js';
import type { SimActor } from '../state.js';
import { capitalNoticeCommandRoute } from './capitalNotices.js';
import {
  changeRequestCommandRoute,
  changeRequestRoute,
  changeRequestsRoute,
  createChangeRequestRoute,
  quarterEndCheckRoute,
} from './changeRequests.js';
import {
  closingCommandRoute,
  closingItemCommandRoute,
  closingRoute,
  createLegalTermRoute,
  legalTermCommandRoute,
} from './closings.js';
import type { SimContext, SimRoute } from './common.js';
import {
  documentCommandRoute,
  documentPagesRoute,
  documentRoute,
  documentsRoute,
  expectedDocumentsRoute,
  generateExpectedDocumentsRoute,
  indexDocumentsRoute,
  reviewQueueRoute,
} from './documents.js';
import { exceptionCommandRoute, exceptionRoute, exceptionsRoute } from './exceptions.js';
import {
  batchesRoute,
  createBatchRoute,
  runCommandRoute,
  runRoute,
  runsRoute,
} from './extraction.js';
import { flagRoute } from './flags.js';
import {
  intakeCommandRoute,
  intakeExportsRoute,
  intakeFileRoute,
  intakeFilesRoute,
  intakeImportRoute,
} from './intake.js';
import { lookthroughReconcileRoute, lookthroughRunRoute } from './lookthrough.js';
import { boardExportRoute, boardRoute, outlookRoute, setOutlookRoute } from './monitoring.js';
import { opsDropDropsRoute, opsDropImportRoute } from './opsDrop.js';
import {
  createDiligenceTaskRoute,
  createOpportunityRoute,
  diligenceTaskCommandRoute,
  icDecisionRoute,
  investmentDetailRoute,
  opportunitiesRoute,
  opportunityCommandRoute,
  opportunityRoute,
  putAllocationsRoute,
} from './pipeline.js';
import { resetRoute } from './reset.js';
import { tradeTicketRoute, tradeTicketsRoute } from './tickets.js';
import {
  createValuationRoute,
  valuationBatchCommandRoute,
  valuationCommandRoute,
  valuationDetailRoute,
} from './valuations.js';
import {
  weeklyCommandRoute,
  weeklyDropsRoute,
  weeklyFileRoute,
  weeklyImportRoute,
} from './weekly.js';
import {
  proposeWireInstructionRoute,
  wireInstructionCommandRoute,
  wireInstructionRoute,
  wireInstructionsRoute,
} from './wires.js';

export type { SimContext, SimRoute } from './common.js';

/**
 * Simulated routes, checked before the recordings: the writes, and the reads of records that
 * exist only once the simulation stages them (the intake files of every source, the reconcile
 * runs, the data exceptions, the documents, the expected documents, the extraction batches and
 * runs, the monitoring board) or that it seeds from the recordings and changes in the session
 * (the valuation detail, the wire register, the trade tickets, the change requests, the pipeline,
 * the closings, the one-pager of a position a simulated close created). A literal path is listed
 * before the parameterized path it would also match (the review queue before the document, the
 * batch commands before a version's commands, the quarter-end check before a request's commands).
 * Anything else that is not a GET is a miss.
 */
export const SIM_ROUTES: readonly SimRoute[] = [
  flagRoute,
  createValuationRoute,
  valuationBatchCommandRoute,
  valuationCommandRoute,
  valuationDetailRoute,
  capitalNoticeCommandRoute,
  tradeTicketsRoute,
  tradeTicketRoute,
  wireInstructionsRoute,
  proposeWireInstructionRoute,
  wireInstructionRoute,
  wireInstructionCommandRoute,
  changeRequestsRoute,
  createChangeRequestRoute,
  quarterEndCheckRoute,
  changeRequestRoute,
  changeRequestCommandRoute,
  opportunitiesRoute,
  createOpportunityRoute,
  opportunityRoute,
  opportunityCommandRoute,
  createDiligenceTaskRoute,
  diligenceTaskCommandRoute,
  icDecisionRoute,
  putAllocationsRoute,
  closingRoute,
  closingItemCommandRoute,
  closingCommandRoute,
  createLegalTermRoute,
  legalTermCommandRoute,
  investmentDetailRoute,
  intakeExportsRoute,
  intakeImportRoute,
  intakeFilesRoute,
  intakeFileRoute,
  intakeCommandRoute,
  weeklyDropsRoute,
  weeklyImportRoute,
  weeklyFileRoute,
  weeklyCommandRoute,
  lookthroughReconcileRoute,
  lookthroughRunRoute,
  opsDropDropsRoute,
  opsDropImportRoute,
  exceptionsRoute,
  exceptionRoute,
  exceptionCommandRoute,
  documentsRoute,
  reviewQueueRoute,
  indexDocumentsRoute,
  documentRoute,
  documentPagesRoute,
  documentCommandRoute,
  expectedDocumentsRoute,
  generateExpectedDocumentsRoute,
  createBatchRoute,
  batchesRoute,
  runsRoute,
  runRoute,
  runCommandRoute,
  boardRoute,
  boardExportRoute,
  outlookRoute,
  setOutlookRoute,
  resetRoute,
];

export function findSimRoute(
  method: string,
  pathname: string,
): { route: SimRoute; params: Record<string, string> } | undefined {
  for (const route of SIM_ROUTES) {
    if (route.method !== method) continue;
    const params = route.match(pathname);
    if (params !== null) return { route, params };
  }
  return undefined;
}

/** The acting user as the API reports it: the credential's recorded GET /api/v1/auth/me. */
export function actorFor(ctx: SimContext, credential: string): SimActor | undefined {
  const me = ctx.recordings.read(credential, '/api/v1/auth/me', principal);
  if (me === undefined) return undefined;
  return {
    userId: me.userId,
    externalId: me.externalId,
    displayName: me.displayName,
    roles: me.roles,
  };
}

export interface SimCall {
  credential: string;
  url: URL;
  headers: Headers;
  bodyText: () => Promise<string>;
}

/**
 * Runs one simulated route in the API's order: identity (401), the contract's role guard (403),
 * Idempotency-Key replay, query and body validation (400 with paths only), then the handler (404,
 * 412, the table's 409, 403 and 422). Successful answers to a request with an Idempotency-Key are
 * kept and replayed for the same key and body; the same key with another body is refused.
 */
export async function runSimRoute(
  route: SimRoute,
  params: Record<string, string>,
  call: SimCall,
  ctx: SimContext,
): Promise<Response> {
  const instance = call.url.pathname;
  const actor = actorFor(ctx, call.credential);
  if (actor === undefined)
    return problem(401, 'unauthenticated', 'Sign in to continue', { instance, simulated: true });
  const roles = route.definition.roles;
  if (roles.length > 0 && !roles.some((r) => actor.roles.includes(r)))
    return problem(403, 'forbidden', 'This operation needs a role you do not hold', {
      instance,
      simulated: true,
    });

  const text = await call.bodyText();
  const idempotencyKey = route.idempotent ? call.headers.get('idempotency-key') : null;
  const scope =
    idempotencyKey === null || idempotencyKey === ''
      ? null
      : `${call.credential}|${route.method} ${instance}|${idempotencyKey}`;
  const stored = scope === null ? undefined : ctx.state.idempotency.get(scope);
  if (stored !== undefined) {
    if (stored.requestBody !== text)
      return problem(
        422,
        'idempotency-key-reuse',
        'This Idempotency-Key was already used with a different request body',
        { instance, simulated: true },
      );
    return new Response(stored.body, { status: stored.status, headers: stored.headers });
  }

  let query: unknown;
  if (route.querySchema !== null) {
    const parsed = route.querySchema.safeParse(Object.fromEntries(call.url.searchParams.entries()));
    if (!parsed.success)
      return validationProblem(parsed.error, 'query', { instance, simulated: true });
    query = parsed.data;
  }

  let body: unknown;
  if (route.bodySchema !== null) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return problem(400, 'validation', `Invalid ${route.what}`, {
        instance,
        simulated: true,
        errors: [{ path: '(root)', message: 'The body is not valid JSON' }],
      });
    }
    const parsed = route.bodySchema.safeParse(json);
    if (!parsed.success)
      return validationProblem(parsed.error, route.what, { instance, simulated: true });
    body = parsed.data;
  }

  const response = await route.handle(
    {
      credential: call.credential,
      actor,
      url: call.url,
      headers: call.headers,
      params,
      body,
      query,
    },
    ctx,
  );
  if (scope !== null && response.ok) {
    ctx.state.idempotency.set(scope, {
      status: response.status,
      headers: [...response.headers.entries()],
      body: await response.clone().text(),
      requestBody: text,
    });
  }
  return response;
}
