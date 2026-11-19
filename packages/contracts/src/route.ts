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
  /**
   * The route reads an If-Match header (docs/17 section 3, row-version.ts): entity tags naming
   * the row version the caller read; a stale one is 412, a malformed one 400, and without the
   * header the command runs on the record as it stands. The value is the kind of record the
   * header guards, as the 412 names it ("valuation").
   */
  ifMatch?: string;
}

export const API_PREFIX = '/api/v1';

/**
 * A matcher for a route's path template ("/api/v1/valuations/{id}/commands"): the path
 * parameters of a concrete path, decoded, or null when the path is not one of the template's. A
 * parameter never spans a slash, and one that cannot be decoded matches nothing.
 */
export function routePathMatcher(
  template: string,
): (pathname: string) => Record<string, string> | null {
  const names: string[] = [];
  const source = template
    .split(/(\{[a-zA-Z]+\})/)
    .map((part) => {
      const name = /^\{([a-zA-Z]+)\}$/.exec(part)?.[1];
      if (name === undefined) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(name);
      return '([^/]+)';
    })
    .join('');
  // eslint-disable-next-line security/detect-non-literal-regexp -- a route template from the route table, its literal parts escaped above
  const pattern = new RegExp(`^${source}$`);
  return (pathname) => {
    const m = pattern.exec(pathname);
    if (m === null) return null;
    const params: Record<string, string> = {};
    for (const [i, name] of names.entries()) {
      try {
        params[name] = decodeURIComponent(m[i + 1] ?? '');
      } catch {
        return null;
      }
    }
    return params;
  };
}
