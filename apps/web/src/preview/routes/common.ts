import { ROUTES, SIMULATED_ROUTES } from '@pb/contracts';
import type { RouteDefinition } from '@pb/contracts';
import type { z } from 'zod';
import type { Recordings } from '../fixtures.js';
import { problem } from '../problems.js';
import type { PreviewEnv, PreviewState, SimActor, SimAuditEvent } from '../state.js';

/** What a simulated route can read and change. */
export interface SimContext {
  recordings: Recordings;
  state: PreviewState;
  env: PreviewEnv;
}

export interface SimRequest<B> {
  credential: string;
  actor: SimActor;
  url: URL;
  headers: Headers;
  /** Path parameters from the contract template, decoded. */
  params: Readonly<Record<string, string>>;
  /** The body, already validated with the contract's zod schema. */
  body: B;
}

export interface SimRoute {
  method: string;
  /** The contract path template, such as /api/v1/valuations/{id}/commands. */
  path: string;
  definition: RouteDefinition;
  /** Noun for validation problems ("Invalid command"). */
  what: string;
  /** Honours Idempotency-Key (docs/17 section 3). */
  idempotent: boolean;
  bodySchema: z.ZodTypeAny | null;
  match(pathname: string): Record<string, string> | null;
  handle(req: SimRequest<unknown>, ctx: SimContext): Promise<Response>;
}

const CONTRACT: readonly RouteDefinition[] = [...ROUTES, ...SIMULATED_ROUTES];

function matcher(template: string): (pathname: string) => Record<string, string> | null {
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

/**
 * A simulated write. It must name a route of the contract (ROUTES or SIMULATED_ROUTES in
 * @pb/contracts) and validate with that route's own body schema, so the preview cannot accept a
 * request the API would refuse, or the other way round.
 */
export function defineSimRoute<B>(spec: {
  method: 'POST' | 'PATCH';
  path: string;
  what: string;
  body: z.ZodType<B> | null;
  idempotent?: boolean;
  handle: (req: SimRequest<B>, ctx: SimContext) => Promise<Response> | Response;
}): SimRoute {
  const definition = CONTRACT.find((r) => r.method === spec.method && r.path === spec.path);
  if (definition === undefined)
    throw new Error(`simulated route ${spec.method} ${spec.path} is not in the contract`);
  if ((definition.body ?? null) !== spec.body)
    throw new Error(
      `simulated route ${spec.method} ${spec.path} must validate with its contract body`,
    );
  return {
    method: spec.method,
    path: spec.path,
    definition,
    what: spec.what,
    idempotent: spec.idempotent ?? false,
    bodySchema: spec.body,
    match: matcher(spec.path),
    // The dispatcher validated the body with `bodySchema`, which is the schema typed as B.
    handle: async (req, ctx) => spec.handle(req as SimRequest<B>, ctx),
  };
}

/** 412 when an If-Match header names another row version (docs/17 section 3). No header, no check. */
export function staleIfMatch(
  headers: Headers,
  rowVersion: number,
  instance: string,
): Response | null {
  const raw = headers.get('if-match');
  if (raw === null) return null;
  const tags = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tags.includes('*')) return null;
  const versions = tags.map((t) => t.replace(/^W\//, '').replace(/^"(.*)"$/, '$1'));
  if (versions.includes(String(rowVersion))) return null;
  return problem(
    412,
    'precondition',
    'The record changed since it was read. Reload it and try again.',
    {
      instance,
      simulated: true,
    },
  );
}

/** Appends one simulated change to this session's activity list. */
export function recordActivity(
  ctx: SimContext,
  actor: SimActor,
  event: Omit<SimAuditEvent, 'at' | 'actorId' | 'actorExternalId' | 'actorName'>,
): void {
  ctx.state.audit.push({
    at: ctx.env.now(),
    actorId: actor.userId,
    actorExternalId: actor.externalId,
    actorName: actor.displayName,
    ...event,
  });
}
