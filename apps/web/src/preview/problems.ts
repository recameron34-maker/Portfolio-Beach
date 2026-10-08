import type { ZodError } from 'zod';
import { WORKFLOW_REFUSALS } from '@pb/contracts';
import type { ProblemDetails } from '@pb/contracts';
import type { TransitionResult } from '@pb/workflows';

/**
 * The answers the preview builds itself, in the API's shapes: RFC 9457 problems with a stable
 * `type` code (apps/api/src/common/problem.ts) and JSON bodies. Request ids are always "preview".
 */
export const PROBLEM_BASE = 'https://portfolio-beach.example/problems/';

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  412: 'Precondition failed',
  422: 'Unprocessable',
  500: 'Internal error',
  503: 'Service unavailable',
};

export interface ProblemOptions {
  /** The request path, as the API sets `instance`. */
  instance?: string;
  /** Paths and messages only, never the submitted values. */
  errors?: ProblemDetails['errors'];
  /** Overrides the title derived from the status. */
  title?: string;
  /** True when a simulated write route answered (header x-pb-simulated). */
  simulated?: boolean;
}

function headers(contentType: string, simulated: boolean, etag?: number): Headers {
  const h = new Headers({ 'content-type': contentType, 'x-request-id': 'preview' });
  if (simulated) h.set('x-pb-simulated', 'true');
  if (etag !== undefined) h.set('etag', `"${etag}"`);
  return h;
}

export function problemBody(
  status: number,
  code: string,
  detail: string,
  options: ProblemOptions = {},
): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}${code}`,
    title: options.title ?? TITLES[status] ?? 'Error',
    status,
    detail,
    ...(options.instance !== undefined ? { instance: options.instance } : {}),
    request_id: 'preview',
    ...(options.errors !== undefined ? { errors: options.errors } : {}),
  };
}

export function problem(
  status: number,
  code: string,
  detail: string,
  options: ProblemOptions = {},
): Response {
  return new Response(JSON.stringify(problemBody(status, code, detail, options)), {
    status,
    headers: headers('application/problem+json', options.simulated === true),
  });
}

/** 400 `validation` with one entry per zod issue: paths and messages, never the values (docs/17 section 3). */
export function validationProblem(
  error: ZodError,
  what: string,
  options: Omit<ProblemOptions, 'errors'> = {},
): Response {
  const errors = error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
  return problem(400, 'validation', `Invalid ${what}`, { ...options, errors });
}

export type WorkflowFailure = Extract<TransitionResult<string>, { ok: false }>;

/** A refusal from attempt(), mapped through the shared WORKFLOW_REFUSALS table; the detail is the table's message. */
export function workflowProblem(
  failure: WorkflowFailure,
  options: Omit<ProblemOptions, 'title'> = {},
): Response {
  const refusal = WORKFLOW_REFUSALS[failure.code];
  return problem(refusal.status, refusal.code, failure.message, {
    ...options,
    title: refusal.title,
  });
}

export function jsonResponse(
  status: number,
  body: unknown,
  options: { simulated?: boolean; etag?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers('application/json', options.simulated === true, options.etag),
  });
}
