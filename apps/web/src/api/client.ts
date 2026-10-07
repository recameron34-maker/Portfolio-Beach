import type { z } from 'zod';
import { problemDetails } from '@pb/contracts';
import type { ProblemDetails } from '@pb/contracts';
import { getCredential } from '../app/session.js';

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }
  get status(): number {
    return this.problem.status;
  }
}

/**
 * Typed fetch over the shared contracts: every response is validated with its zod schema, every
 * error is an RFC 9457 problem (docs/17 section 3). The credential is added per call, never
 * stored in local storage (SEC-4.5).
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
  const res = await fetch(path, { ...init, headers });
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
    throw new ApiError(problem);
  }
  return schema.parse(await res.json());
}
