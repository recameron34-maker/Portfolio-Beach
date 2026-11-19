import type { z } from 'zod';
import { IDEMPOTENCY_KEY_HEADER, problemDetails } from '@pb/contracts';
import type { ProblemDetails } from '@pb/contracts';
import { getCredential } from '../app/session.js';
import { idempotencyKeyFor } from './idempotency.js';
import { withoutReferences } from '../lib/references.js';

export class ApiError extends Error {
  /**
   * The message is what a page shows, so it goes without the control or document a refusal
   * cites; `problem` keeps the API's answer word for word.
   */
  constructor(public readonly problem: ProblemDetails) {
    super(withoutReferences(problem.detail ?? problem.title));
    this.name = 'ApiError';
  }
  get status(): number {
    return this.problem.status;
  }
  /** The problem's stable code: the last segment of its `type` ("workflow-transition"). */
  get code(): string {
    return this.problem.type.slice(this.problem.type.lastIndexOf('/') + 1);
  }
}

/**
 * Typed fetch over the shared contracts: every response is validated with its zod schema, every
 * error is an RFC 9457 problem (docs/17 section 3). The credential is added per call, never
 * stored in local storage (SEC-4.5). A write to a route the contract marks idempotent is named
 * with an Idempotency-Key (idempotency.ts): one key per action, the same key when the action is
 * tried again, so a request that is sent twice takes effect once. A caller that sets the header
 * itself keeps its own key.
 */
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const credential = getCredential();
  if (credential !== null) headers.set('authorization', `Bearer ${credential}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  const keyed =
    method === 'GET' || headers.has(IDEMPOTENCY_KEY_HEADER)
      ? undefined
      : idempotencyKeyFor(
          credential,
          method,
          new URL(path, window.location.href).pathname,
          init.body,
        );
  if (keyed !== undefined) headers.set(IDEMPOTENCY_KEY_HEADER, keyed.key);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (error) {
    // No answer came back, so the request may or may not have run: its key is kept for the retry.
    keyed?.settle(null);
    throw error;
  }
  if (!res.ok) {
    let problem: ProblemDetails;
    try {
      problem = problemDetails.parse(await res.json());
    } catch {
      problem = {
        type: 'about:blank',
        title: res.statusText || 'Request failed',
        status: res.status,
        request_id: res.headers.get('x-request-id') ?? 'unknown',
      };
    }
    const error = new ApiError(problem);
    keyed?.settle(res.status, error.code);
    throw error;
  }
  keyed?.settle(res.status);
  return schema.parse(await res.json());
}
