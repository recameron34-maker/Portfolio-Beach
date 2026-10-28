import { ROUTES, SIMULATED_ROUTES, featureFlagList, taxonomy } from '@pb/contracts';
import type { IntakeFile, IntakeLink, IntakeSource, Person, RouteDefinition } from '@pb/contracts';
import { countsOf, fileStatusOf } from '@pb/validation';
import type { StagingState } from '@pb/workflows';
import type { z } from 'zod';
import type { PreviewBook } from '../book.js';
import type { Recordings } from '../fixtures.js';
import { problem } from '../problems.js';
import { exceptionsOfFile } from '../state.js';
import type {
  PreviewEnv,
  PreviewState,
  SimActor,
  SimAuditEvent,
  SimException,
  SimFileHeader,
} from '../state.js';

/** What a simulated route can read and change. */
export interface SimContext {
  recordings: Recordings;
  /** The system actor's view of the book (preview/book.json); null while a test world has none. */
  book: PreviewBook | null;
  state: PreviewState;
  env: PreviewEnv;
  /** The page's own fetch for a static asset beside it (a bundled sample export), never an API path. */
  fetchAsset: (path: string) => Promise<Response>;
}

export interface SimRequest<B, Q = unknown> {
  credential: string;
  actor: SimActor;
  url: URL;
  headers: Headers;
  /** Path parameters from the contract template, decoded. */
  params: Readonly<Record<string, string>>;
  /** The body, already validated with the contract's zod schema. */
  body: B;
  /** The query string, already validated with the contract's query schema (undefined when the route has none). */
  query: Q;
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
  querySchema: z.ZodTypeAny | null;
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
 * A simulated route: a write, or a read of records that exist only in the simulation (the intake
 * files). It must name a route of the contract (ROUTES or SIMULATED_ROUTES in @pb/contracts) and
 * validate with that route's own body and query schemas, so the preview cannot accept a request
 * the API would refuse, or the other way round.
 */
export function defineSimRoute<B, Q = undefined>(spec: {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  what: string;
  body: z.ZodType<B> | null;
  query?: z.ZodType<Q>;
  idempotent?: boolean;
  handle: (req: SimRequest<B, Q>, ctx: SimContext) => Promise<Response> | Response;
}): SimRoute {
  const definition = CONTRACT.find((r) => r.method === spec.method && r.path === spec.path);
  if (definition === undefined)
    throw new Error(`simulated route ${spec.method} ${spec.path} is not in the contract`);
  if ((definition.body ?? null) !== spec.body)
    throw new Error(
      `simulated route ${spec.method} ${spec.path} must validate with its contract body`,
    );
  if ((definition.query ?? null) !== (spec.query ?? null))
    throw new Error(
      `simulated route ${spec.method} ${spec.path} must validate with its contract query`,
    );
  return {
    method: spec.method,
    path: spec.path,
    definition,
    what: spec.what,
    idempotent: spec.idempotent ?? false,
    bodySchema: spec.body,
    querySchema: spec.query ?? null,
    match: matcher(spec.path),
    // The dispatcher validated the body and query with the schemas above, which are typed as B and Q.
    handle: async (req, ctx) => spec.handle(req as SimRequest<B, Q>, ctx),
  };
}

/** The contract's body schema of a route, for a route whose schema is built by a function (the ops drop upload). */
export function contractBody<B>(method: RouteDefinition['method'], path: string): z.ZodType<B> {
  const definition = CONTRACT.find((r) => r.method === method && r.path === path);
  if (definition?.body === undefined)
    throw new Error(`the contract has no body schema for ${method} ${path}`);
  // The route table types every body as ZodTypeAny; the caller names the type its contract gives.
  return definition.body as z.ZodType<B>;
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

/**
 * The system actor the simulation writes as where the API uses `asSystemActor`: the same id as
 * SYSTEM_USER_ID in @pb/db (not browser code) with the service role, never a sign-in role
 * (decision 0009). The intakes promote with it; the index, the expected-document generation and
 * the extraction runs transition with it.
 */
export const SYSTEM_ACTOR = {
  actorId: '00000000-0000-0000-0000-000000000001',
  actorRoles: ['service'],
} as const;

/** A rule error opens a high exception (core.taxonomy_term exception_severity), as the API opens them. */
export const EXCEPTION_SEVERITY = 'exception_severity.high';

/**
 * Whether a feature flag is on for the simulation: the value a simulated flag change set this
 * session, else the credential's recorded flag list, else the fallback (the migration's default).
 */
export function flagEnabled(
  ctx: SimContext,
  credential: string,
  key: string,
  fallback: boolean,
): boolean {
  const changed = ctx.state.flags.get(key);
  if (changed !== undefined) return changed;
  const recorded = ctx.recordings
    .read(credential, '/api/v1/flags', featureFlagList)
    ?.flags.find((f) => f.key === key);
  return recorded?.enabled ?? fallback;
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

/* ---- What the simulated intakes share: the book, the reader's view, the file header, paging ---- */

/** The answer of every intake route while the preview carries no book (it could not be loaded). */
export const noBook = (instance: string): Response =>
  problem(503, 'unavailable', 'This preview carries no book to check an import against', {
    instance,
    simulated: true,
  });

/** The system actor's book, or null: the caller answers noBook. */
export function bookOf(ctx: SimContext): PreviewBook | null {
  return ctx.book;
}

/** Whether the credential may open the investment: its own recorded detail answered 200, so a wall still hides what it hid; a position a simulated close created is open to everyone. */
export function canOpen(ctx: SimContext, credential: string, investmentId: string): boolean {
  return (
    ctx.state.investments.has(investmentId) ||
    ctx.recordings.status(credential, `/api/v1/investments/${encodeURIComponent(investmentId)}`) ===
      200
  );
}

/** The name shown for a record the caller may not read; the id still travels (apps/api/src/pipeline/rows.ts). */
export const NOT_VISIBLE = 'Not visible';

/** The acting user as a person on a record. */
export const personOf = (actor: SimActor): Person => ({
  id: actor.userId,
  name: actor.displayName,
});

/**
 * Whether a taxonomy code is one the credential's recorded taxonomy lists as active. Without a
 * recorded taxonomy (a test world) every well-formed code passes: the contract's pattern has
 * already checked its shape, and the API's check against the table is what this stands in for.
 */
export function knownCode(ctx: SimContext, credential: string, code: string): boolean {
  const recorded = ctx.recordings.read(credential, '/api/v1/taxonomy', taxonomy);
  if (recorded === undefined) return true;
  const domain = code.slice(0, code.indexOf('.'));
  const terms = recorded.domains.find((d) => d.domain === domain)?.terms;
  if (terms === undefined) return false;
  return terms.some((t) => t.code === code && t.active);
}

/**
 * Whether a document is in the simulated hub and visible to the credential (SEC-5.3): the
 * evidence a diligence task or a closing item names must be one the caller can see, as the
 * API's requireVisibleDocument checks the hub under the caller's own policy.
 */
export function documentVisible(ctx: SimContext, credential: string, documentId: string): boolean {
  const doc = ctx.state.documents.get(documentId);
  return (
    doc !== undefined && (doc.investmentId === null || canOpen(ctx, credential, doc.investmentId))
  );
}

/**
 * A reader's view of staged rows (SEC-5.3): a row linked to an investment they cannot open is
 * left out (and counted by the caller), a candidate they cannot open is dropped from the link, so
 * nothing in an answer reveals a walled position exists. The API reads the same through the
 * caller's row-level security.
 */
export interface ReaderView {
  rowVisible: (investmentId: string | null) => boolean;
  linkFor: (link: IntakeLink) => IntakeLink;
}

export function readerView(
  ctx: SimContext,
  credential: string,
  links: readonly IntakeLink[],
): ReaderView {
  const idOf = new Map((ctx.book?.investments ?? []).map((i) => [i.investmentNumber, i.id]));
  const visibleNumbers = new Set<string>();
  for (const link of links) {
    for (const candidate of link.candidates) {
      const id = idOf.get(candidate.investmentNumber);
      if (id !== undefined && canOpen(ctx, credential, id))
        visibleNumbers.add(candidate.investmentNumber);
    }
  }
  return {
    rowVisible: (investmentId) => investmentId === null || canOpen(ctx, credential, investmentId),
    linkFor: (link) => ({
      ...link,
      candidates: link.candidates.filter((c) => visibleNumbers.has(c.investmentNumber)),
    }),
  };
}

/** The file header as the contract carries it, for any simulated source: counts over every row, exceptions whichever intake opened them. */
export function fileOf(
  ctx: SimContext,
  sim: SimFileHeader & { rows: readonly { status: StagingState }[] },
  source: IntakeSource,
  templateSignature: string | null,
): IntakeFile {
  const counts = countsOf(sim.rows.map((r) => r.status));
  return {
    id: sim.id,
    source,
    fileName: sim.fileName,
    contentHash: sim.contentHash,
    templateSignature,
    receivedAt: sim.receivedAt,
    receivedBy: sim.receivedBy,
    rowCount: sim.rowCount,
    status: fileStatusOf(counts),
    counts,
    fileFindings: sim.fileFindings,
    exceptions: exceptionsOfFile(ctx.state, sim.id).length,
    rowVersion: sim.rowVersion,
  };
}

/** A refused file (the reader rejected it, so it holds no rows) may be staged again once the cause is corrected. */
export const restageable = (sim: { rows: readonly unknown[] }): boolean => sim.rows.length === 0;

/** What an intake records when it opens a data exception about a staged row. */
export interface OpenedExceptionInput {
  source: string;
  entity: SimException['entity'];
  entityId: string;
  ruleId: string;
  expected: string | null;
  actual: string | null;
  severity: string;
  candidates: readonly { reason: string }[];
  /** The staged file and row the exception is about; null for one about a document or an extraction run. */
  file: { id: string; fileName: string } | null;
  rowNo: number | null;
  investmentId: string | null;
}

/** Opens one simulated data exception (ops.data_exception, state open) about a staged row, a document or a run. */
export function openException(ctx: SimContext, input: OpenedExceptionInput): SimException {
  const at = ctx.env.now();
  const sim: SimException = {
    id: ctx.env.newId(),
    source: input.source,
    entity: input.entity,
    entityId: input.entityId,
    ruleId: input.ruleId,
    expected: input.expected,
    actual: input.actual,
    severity: input.severity,
    ownerId: null,
    ownerName: null,
    state: 'open',
    externalTicket: null,
    candidates: input.candidates.map((c) => ({ reason: c.reason })),
    createdAt: at,
    updatedAt: at,
    rowVersion: 1,
    context: {
      intakeFileId: input.file?.id ?? null,
      intakeFileName: input.file?.fileName ?? null,
      rowNo: input.rowNo,
      investmentId: input.investmentId,
    },
  };
  ctx.state.exceptions.set(sim.id, sim);
  return sim;
}

/* ---- Cursor paging, newest first on (time, id), the API's order ---- */

/** A cursor decodes to "time|id" of the last item listed. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\|([0-9a-f-]{36})$/;

export interface SortKey {
  at: string;
  id: string;
}

export const encodeCursor = (key: SortKey): string =>
  btoa(`${key.at}|${key.id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function decodeCursor(cursor: string): SortKey | null {
  let text: string;
  try {
    text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const match = CURSOR.exec(text);
  if (match === null) return null;
  return { at: match[1] ?? '', id: match[2] ?? '' };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * The items newest first (by time, then id), from the cursor on, one page of the limit with the
 * cursor of the next page when more remain; null when the cursor cannot be read (a 400).
 */
export function pageNewestFirst<T>(
  items: readonly T[],
  keyOf: (item: T) => SortKey,
  query: { limit: number; cursor?: string | undefined },
): Page<T> | null {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && after === null) return null;
  const sorted = [...items]
    .map((item) => ({ item, key: keyOf(item) }))
    .sort((a, b) => byText(b.key.at, a.key.at) || byText(b.key.id, a.key.id))
    .filter(
      ({ key }) =>
        after === null || key.at < after.at || (key.at === after.at && key.id < after.id),
    );
  const page = sorted.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((p) => p.item),
    nextCursor: sorted.length > query.limit && last !== undefined ? encodeCursor(last.key) : null,
  };
}
