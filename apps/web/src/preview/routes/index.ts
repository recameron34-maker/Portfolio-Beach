import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_ISSUE,
  IDEMPOTENCY_KEY_REUSE,
  IDEMPOTENCY_MAX_PATH,
  IDEMPOTENCY_REPLAYED_HEADER,
  IF_MATCH_HEADER,
  INVALID_IDEMPOTENCY_KEY_DETAIL,
  canonicalRequestBody,
  isIdempotencyKey,
  parseIfMatch,
  principal,
  storableAnswer,
} from '@pb/contracts';
import { jsonResponse, problem, validationProblem } from '../problems.js';
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
import { invalidIfMatch } from './common.js';
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
  editValuationRoute,
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
  editValuationRoute,
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
    // The entitlements the sign-in recorded: which client lines of a deal this reader is shown.
    clientIds: me.clientIds,
  };
}

export interface SimCall {
  credential: string;
  url: URL;
  headers: Headers;
  bodyText: () => Promise<string>;
}

/** A request body as text, read as JSON once: for the fingerprint of an Idempotency-Key and for validation. */
function jsonOf(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Runs one simulated route in the API's order: identity (401), the contract's role guard (403),
 * the Idempotency-Key (400 when malformed, then the replay or the 422), query and body validation
 * (400 with paths only), the If-Match header of a route the contract marks (400 when malformed),
 * then the handler (404, 412, the table's 409, 403 and 422).
 *
 * The Idempotency-Key follows the API's store (apps/api/src/common/idempotency.ts), with the
 * rules both share in @pb/contracts: the contract's route table decides which routes take the
 * header; a key is 1 to 200 visible ASCII characters and belongs to the credential, the method
 * and the path; a 2xx answer is kept as the API keeps it (its JSON without bank details in clear,
 * and its ETag) and replayed for the same body, compared as canonical JSON, with
 * `Idempotency-Replayed: true`; the same key with another body is 422; a refused request keeps
 * nothing. One thing the API answers cannot arise here: 409 `idempotency-key-in-progress`, for a
 * repeat that arrives while the first request is still running. The preview answers one request
 * at a time, so a repeat always finds the first one finished.
 */
export async function runSimRoute(
  route: SimRoute,
  params: Record<string, string>,
  call: SimCall,
  ctx: SimContext,
): Promise<Response> {
  const instance = call.url.pathname;
  const refusal = { instance, simulated: true } as const;
  const actor = actorFor(ctx, call.credential);
  if (actor === undefined) return problem(401, 'unauthenticated', 'Sign in to continue', refusal);
  const roles = route.definition.roles;
  if (roles.length > 0 && !roles.some((r) => actor.roles.includes(r)))
    return problem(403, 'forbidden', 'This operation needs a role you do not hold', refusal);

  const key = route.idempotent ? call.headers.get(IDEMPOTENCY_KEY_HEADER) : null;
  if (key !== null) {
    if (!isIdempotencyKey(key))
      return problem(400, 'validation', INVALID_IDEMPOTENCY_KEY_DETAIL, {
        ...refusal,
        errors: [{ ...IDEMPOTENCY_KEY_ISSUE }],
      });
    if (instance.length > IDEMPOTENCY_MAX_PATH)
      return problem(404, 'not-found', 'Not found', refusal);
  }

  const json = jsonOf(await call.bodyText());
  // A body that is not JSON has no fingerprint: it is refused below, and nothing is kept for it.
  const keyed =
    key === null || !json.ok
      ? null
      : {
          scope: `${call.credential}|${route.method} ${instance}|${key}`,
          request: canonicalRequestBody(json.value),
        };
  const stored = keyed === null ? undefined : ctx.state.idempotency.get(keyed.scope);
  if (keyed !== null && stored !== undefined) {
    if (stored.requestBody !== keyed.request)
      return problem(
        IDEMPOTENCY_KEY_REUSE.status,
        IDEMPOTENCY_KEY_REUSE.code,
        IDEMPOTENCY_KEY_REUSE.detail,
        refusal,
      );
    const replay = jsonResponse(stored.status, JSON.parse(stored.body) as unknown, {
      simulated: true,
    });
    for (const [name, value] of stored.headers) replay.headers.set(name, value);
    replay.headers.set(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return replay;
  }

  let query: unknown;
  if (route.querySchema !== null) {
    const parsed = route.querySchema.safeParse(Object.fromEntries(call.url.searchParams.entries()));
    if (!parsed.success) return validationProblem(parsed.error, 'query', refusal);
    query = parsed.data;
  }

  let body: unknown;
  if (route.bodySchema !== null) {
    if (!json.ok)
      return problem(400, 'validation', `Invalid ${route.what}`, {
        ...refusal,
        errors: [{ path: '(root)', message: 'The body is not valid JSON' }],
      });
    const parsed = route.bodySchema.safeParse(json.value);
    if (!parsed.success) return validationProblem(parsed.error, route.what, refusal);
    body = parsed.data;
  }

  // A controller reads If-Match once the body is valid and before its service looks for the
  // record, so a malformed header is 400 even for a record that does not exist.
  if (route.definition.ifMatch !== undefined && !parseIfMatch(call.headers.get(IF_MATCH_HEADER)).ok)
    return invalidIfMatch(instance);

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
  if (keyed !== null && response.ok) {
    // What the API stores: the status, the answer without bank details in clear, and the ETag.
    const etag = response.headers.get('etag');
    ctx.state.idempotency.set(keyed.scope, {
      status: response.status,
      headers: etag === null ? [] : [['etag', etag]],
      body: JSON.stringify(storableAnswer(await response.clone().json())),
      requestBody: keyed.request,
    });
  }
  return response;
}
