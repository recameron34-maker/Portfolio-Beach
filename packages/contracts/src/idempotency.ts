import { canonicalJson } from './lock.js';
import type { RouteDefinition } from './route.js';
import { routePathMatcher } from './route.js';
import { ROUTES } from './routes.js';

/*
 * The Idempotency-Key header (docs/17 section 3): a command or a create that changes a financial
 * record may be sent again with the same key, and the repeat answers what the first request
 * answered and runs nothing. These are the rules every side shares (CLAUDE.md rule 7): the API's
 * store (apps/api/src/common/idempotency.ts), the static preview's simulation of it
 * (apps/web/src/preview/routes/index.ts), the web client that names its requests
 * (apps/web/src/api/idempotency.ts) and the OpenAPI document. What differs per side stays there:
 * the API seals a SHA-256 of the canonical body and keeps the answers in a table, the preview
 * keeps both in the page's memory.
 *
 * The route table decides which routes take the header: `idempotent: true` on the route, and no
 * other. On those, in the order the API answers: identity (401) and the role guard (403) first;
 * then the key (400 when malformed, an empty one included; no header, no change in behaviour);
 * then the store, before the body is validated or anything runs. A key belongs to the person,
 * the method and the path. A repeat with the same body answers the stored status and body with
 * `Idempotency-Replayed: true` and the stored ETag; the same key with another body is 422; a
 * repeat while the first request is still running is 409. A request that is refused (any answer
 * outside 2xx) stores nothing, so the corrected request may use the key.
 */

/** The header a client names its request with, as fetch and Node report it. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Set to "true" on an answer that an earlier request stored. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/** The key's shape as a pattern source, for the OpenAPI document. */
export const IDEMPOTENCY_KEY_PATTERN = '^[\\x21-\\x7e]{1,200}$';
const KEY = new RegExp(IDEMPOTENCY_KEY_PATTERN);

/** Whether a header value is a key: 1 to 200 visible ASCII characters (no space, no control character). */
export function isIdempotencyKey(value: string): boolean {
  return KEY.test(value);
}

/** The detail of the 400 `validation` problem a malformed key is refused with; the key is never echoed. */
export const INVALID_IDEMPOTENCY_KEY_DETAIL = 'Invalid Idempotency-Key';

/** The one entry of that problem's `errors` list. */
export const IDEMPOTENCY_KEY_ISSUE: { readonly path: string; readonly message: string } = {
  path: 'Idempotency-Key',
  message: 'Expected 1 to 200 visible ASCII characters',
};

/** The same key with a different request body: refused, and nothing runs. */
export const IDEMPOTENCY_KEY_REUSE = {
  status: 422,
  code: 'idempotency-key-reuse',
  detail: 'This Idempotency-Key was already used with a different request body',
} as const;

/** A repeat that arrives while the first request is still running, or whose completion was never recorded. */
export const IDEMPOTENCY_KEY_IN_PROGRESS = {
  status: 409,
  code: 'idempotency-key-in-progress',
  detail:
    'A request with this Idempotency-Key is still running. Wait for its answer, or read the record again and send the request with a new key',
} as const;

/**
 * The longest path a request is keyed by. Every path parameter of the idempotent routes is a
 * UUID or a short code, so a longer path names no record: with a key it is answered 404
 * `not-found` ("Not found") before the store is asked.
 */
export const IDEMPOTENCY_MAX_PATH = 500;

/**
 * A request body as the text its fingerprint covers: its canonical JSON (keys sorted at every
 * depth, lock.ts), so a body reads the same in whatever order its keys were sent. An absent body
 * is null, and an entry with no value is no entry, as on the wire.
 */
export function canonicalRequestBody(body: unknown): string {
  return canonicalJson(body === undefined ? null : (JSON.parse(JSON.stringify(body)) as unknown));
}

/**
 * Properties of an answer that never reach the store: bank details in clear, which the contract
 * carries as `bankDetails` (wireInstructionDetail), and its two numbers by their own names should
 * an answer ever carry them outside that object (SEC-6.3, SEC-12.2).
 */
const NEVER_STORED: ReadonlySet<string> = new Set(['bankDetails', 'accountNumber', 'routingCode']);

/**
 * An answer as it is stored and replayed: its JSON, with every NEVER_STORED property null at any
 * depth. The replay of a wire instruction answer therefore carries `bankDetails: null` whatever
 * the caller's role: the details are read again on the instruction itself, where each clear read
 * is audited.
 */
export function storableAnswer(body: unknown): unknown {
  const text = JSON.stringify(body ?? null, (key: string, value: unknown) =>
    NEVER_STORED.has(key) ? null : value,
  );
  return JSON.parse(text) as unknown;
}

const IDEMPOTENT_ROUTES = ROUTES.filter((route) => route.idempotent === true).map((route) => ({
  route,
  match: routePathMatcher(route.path),
}));

/**
 * The contract route a request is for, when the contract marks it idempotent; undefined for
 * every other request. The path is the concrete one ("/api/v1/valuations/<id>/commands"),
 * without the query string.
 */
export function idempotentRouteOf(method: string, pathname: string): RouteDefinition | undefined {
  const wanted = method.toUpperCase();
  return IDEMPOTENT_ROUTES.find(
    ({ route, match }) => route.method === wanted && match(pathname) !== null,
  )?.route;
}
