import {
  IDEMPOTENCY_KEY_IN_PROGRESS,
  canonicalRequestBody,
  idempotentRouteOf,
} from '@pb/contracts';

/*
 * The Idempotency-Key the web names its writes with (docs/17 section 3). The API keeps the
 * answer of a keyed request and answers a repeat with it instead of running the command again
 * (apps/api/src/common/idempotency.ts), so a write that is sent twice (a second click, a retry
 * after the connection dropped) takes effect once. The client's part is to name each action
 * once and to keep the name while the action is still the same one:
 *
 * - Which requests: those the contract marks idempotent (`idempotent: true` on the route), read
 *   from the route table, so no page chooses.
 * - One key per action. An action is a person's request to one path with one body: the key is
 *   new unless the same person is sending the same method, path and body again (the body
 *   compared as canonical JSON, as the API compares it).
 * - The key is kept while the outcome is unknown: the request is still on its way, no answer came
 *   back, the server failed (5xx), or the API said the first request is still running (409
 *   idempotency-key-in-progress). Sent again then, the request carries the same key, and the API
 *   answers what the first one did.
 * - The key is dropped once the action has an answer: a success, or a refusal (the API keeps
 *   nothing of a refused request). The same command after that is a new action with a new key.
 * - A kept key is used for five minutes from its first request, then dropped. A retry comes
 *   soon; later, the same body on the same path is more likely a new action (advance a deal one
 *   stage, then the next), and a key the API never completed must not block the action for good.
 *
 * What is kept is a fingerprint and the key, in this page's memory only: never the body (a wire
 * instruction is proposed with its bank details in it), and nothing in browser storage.
 */

/** How long a key is kept for a retry while the outcome of its request is unknown. */
export const RETRY_WINDOW_MS = 5 * 60_000;

interface HeldKey {
  key: string;
  /** When the key was first sent (epoch milliseconds). */
  since: number;
}

/** The keys of the actions whose outcome is unknown, by the fingerprint of their request. */
const held = new Map<string, HeldKey>();

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Mixed into every fingerprint, so one says nothing outside this page session. */
const SESSION_SALT = randomHex(16);

/**
 * A fingerprint of a request for the lookup above: two 32-bit FNV-1a sums with different
 * primes, as hex. It is not a cryptographic hash and does not need to be one: should two
 * different requests ever share a fingerprint, the second goes out with the first one's key and
 * the API refuses it (422 idempotency-key-reuse) without running anything.
 */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    a = Math.imul(a ^ unit, 0x01000193);
    b = Math.imul(b ^ unit, 0x85ebca6b);
  }
  return [a, b].map((sum) => (sum >>> 0).toString(16).padStart(8, '0')).join('');
}

/** A JSON body as its canonical text; undefined for a body that is not JSON text (never an idempotent route's). */
function contentOf(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) return canonicalRequestBody(undefined);
  if (typeof body !== 'string') return undefined;
  try {
    return canonicalRequestBody(JSON.parse(body));
  } catch {
    return undefined;
  }
}

/** The key of one request, and what to tell it once the request has an outcome. */
export interface KeyedRequest {
  key: string;
  /**
   * Reports the outcome: the status and the problem code of the answer, or null when no answer
   * came back. The key is dropped unless the outcome is still unknown.
   */
  settle(status: number | null, problemCode?: string): void;
}

/**
 * The Idempotency-Key for a request, or undefined when its route is not one the contract marks
 * idempotent. `pathname` is the concrete path without the query string.
 */
export function idempotencyKeyFor(
  credential: string | null,
  method: string,
  pathname: string,
  body: BodyInit | null | undefined,
): KeyedRequest | undefined {
  if (idempotentRouteOf(method, pathname) === undefined) return undefined;
  const content = contentOf(body);
  // A body that cannot be compared is its own action every time.
  if (content === undefined) return { key: randomHex(16), settle: () => undefined };

  const now = Date.now();
  for (const [print, entry] of held) if (now - entry.since > RETRY_WINDOW_MS) held.delete(print);
  const print = fingerprint(
    [SESSION_SALT, credential ?? '', method.toUpperCase(), pathname, content].join('\n'),
  );
  const entry = held.get(print) ?? { key: randomHex(16), since: now };
  held.set(print, entry);
  return {
    key: entry.key,
    settle: (status, problemCode) => {
      const unknown =
        status === null ||
        status >= 500 ||
        (status === IDEMPOTENCY_KEY_IN_PROGRESS.status &&
          problemCode === IDEMPOTENCY_KEY_IN_PROGRESS.code);
      // Another request may have replaced the key since (it expired): only this one's is dropped.
      if (!unknown && held.get(print) === entry) held.delete(print);
    },
  };
}

/** Forgets every held key: the next request of any action is a new one. */
export function forgetIdempotencyKeys(): void {
  held.clear();
}
