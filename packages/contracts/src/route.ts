import type { z } from 'zod';

/*
 * The shape of one route and the API prefix, on their own so every route table (routes.ts,
 * routes-controls.ts, simulated.ts) can import them without importing each other: ROUTES spreads
 * CONTROL_ROUTES in, so routes-controls.ts must not depend on routes.ts (an ESM cycle would read
 * API_PREFIX before it is initialised).
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  summary: string;
  tags: string[];
  /** Roles that may call the route; empty means any authenticated user. */
  roles: readonly string[];
  auth: boolean;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  responseStatus?: number;
  /** The success body's media type; application/json unless a route serves a file such as a CSV export. */
  responseContentType?: 'application/json' | 'text/csv';
  /**
   * The route accepts an Idempotency-Key header and a repeat returns the original result (docs/17
   * section 3): every command and create that changes a financial record.
   */
  idempotent?: boolean;
}

export const API_PREFIX = '/api/v1';
