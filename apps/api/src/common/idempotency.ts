import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Response } from 'express';
import { catchError, from, mergeMap, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import type { Principal } from '@pb/adapters';
import { ROUTES } from '@pb/contracts';
import { schema } from '@pb/db';
import type { FieldCipher } from '@pb/db';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { DbService } from '../db/db.service.js';
import { FIELD_CIPHER } from './fieldCipher.js';
import type { Logger } from './logging.js';
import { pgErrorCode } from './pg-errors.js';
import { ProblemError } from './problem.js';
import { LOGGER } from './tokens.js';

/*
 * The Idempotency-Key header (docs/17 section 3): a command or a create that changes a financial
 * record may be sent again with the same key, and the repeat answers what the first request
 * answered and runs nothing. This is the one copy for the API (CLAUDE.md rule 7): the interceptor
 * applies to every route the contract marks `idempotent: true` (packages/contracts
 * routes-controls.ts) and to no other, so the route table decides, not the controllers. The static
 * preview simulates the same rule in apps/web/src/preview/routes/index.ts.
 *
 * In the order the API answers: identity (401) and the role guard (403) run first; then the key
 * (400 when it is not 1 to 200 visible ASCII characters; no header, no change in behaviour); then
 * the store, before the body is validated or anything runs.
 *
 * A key belongs to the person, the method and the path (two people may choose the same key; the
 * same key on another route is another request). The first use reserves the key in
 * ops.idempotency_key (migration 0015) with no answer yet, runs the command, and completes the
 * row with the status, the body and the ETag of a 2xx answer before the answer goes out. A repeat
 * with the same body answers the stored status and body with `Idempotency-Replayed: true`. The
 * same key with a different body is 422 `idempotency-key-reuse`. A repeat that arrives while the
 * first request is still running is 409 `idempotency-key-in-progress`: it is never run beside
 * it, which is what a retry after a timeout needs. A command that is refused (any answer outside
 * 2xx) releases the key, so the corrected request may use it.
 *
 * The three steps are three transactions (reserve, the command's own, complete), because the
 * services open their own. Should the process stop between the command and the completion, the
 * key stays reserved and a repeat is told the request is in progress: the person reads the
 * record again and sends a new key. The command is never run twice on one key.
 *
 * What the store holds (SEC-6.3, SEC-6.4, SEC-12.2):
 * - The request as a fingerprint only: the SHA-256 of the body as canonical JSON, sealed with
 *   the field cipher. A wire instruction is proposed with its bank details in the body, and a
 *   bare digest would let a reader of the table test guesses of an account number against the
 *   masked form the register shows; sealed, it says nothing without the field key.
 * - The answer as the API sent it, except bank details in clear, which are stored as null. The
 *   replay of a wire instruction answer therefore carries `bankDetails: null` whatever the
 *   caller's role: the details are read again on the instruction itself, where each clear read
 *   is audited. A replay writes nothing, not even an audit event.
 * - Each row is its owner's alone under row-level security; the role guard has run on the
 *   repeat, with the caller's roles as they are now.
 */

/** The header a client names its request with. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Set to "true" on an answer that an earlier request stored. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/** 1 to 200 visible ASCII characters: no space, no control character, nothing outside ASCII. */
const KEY = /^[\x21-\x7e]{1,200}$/;

/** The longest path the store keys a request by (the check on ops.idempotency_key.path). */
const MAX_PATH = 500;

/** "METHOD /path/{param}" of every route the contract marks idempotent. */
const IDEMPOTENT_ROUTES: ReadonlySet<string> = new Set(
  ROUTES.filter((route) => route.idempotent === true).map(
    (route) => `${route.method} ${route.path}`,
  ),
);

/** Whether the contract marks the route idempotent; `routePath` is the server's pattern (":id") or the contract's ("{id}"). */
export function isIdempotentRoute(method: string, routePath: string): boolean {
  return IDEMPOTENT_ROUTES.has(`${method.toUpperCase()} ${routePath.replace(/:(\w+)/g, '{$1}')}`);
}

/** The key a request carries; undefined without the header; 400 (the key never echoed) when malformed. */
export function idempotencyKeyOf(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !KEY.test(header))
    throw new ProblemError(400, 'validation', 'Invalid Idempotency-Key', [
      { path: 'Idempotency-Key', message: 'Expected 1 to 200 visible ASCII characters' },
    ]);
  return header;
}

/** JSON with the keys of every object sorted and no spaces, so a body reads the same in whatever order its keys were sent. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** The fingerprint of a request body: SHA-256, lowercase hex, over its canonical JSON. It is sealed before it is stored. */
export function requestFingerprint(body: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(body ?? null), 'utf8')
    .digest('hex');
}

/**
 * Properties of an answer that never reach the store: bank details in clear, which the contract
 * carries as `bankDetails` (wireInstructionDetail), and its two numbers by their own names should
 * an answer ever carry them outside that object.
 */
const NEVER_STORED: ReadonlySet<string> = new Set(['bankDetails', 'accountNumber', 'routingCode']);

/** The answer as it is stored and replayed: its JSON, with every NEVER_STORED property null. */
export function storableAnswer(body: unknown): unknown {
  const text = JSON.stringify(body ?? null, (key: string, value: unknown) =>
    NEVER_STORED.has(key) ? null : value,
  );
  return JSON.parse(text) as unknown;
}

const keys = schema.idempotencyKey;

interface KeyScope {
  userId: string;
  method: string;
  path: string;
  key: string;
}

interface StoredAnswer {
  status: number;
  body: unknown;
  etag: string | null;
}

/** The one row of a key: the person, the method, the path and the key. */
const ownRow = (scope: KeyScope) =>
  and(
    eq(keys.userId, scope.userId),
    eq(keys.method, scope.method),
    eq(keys.path, scope.path),
    eq(keys.key, scope.key),
  );

const inProgress = (): ProblemError =>
  new ProblemError(
    409,
    'idempotency-key-in-progress',
    'A request with this Idempotency-Key is still running. Wait for its answer, or read the record again and send the request with a new key',
  );

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly db: DbService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithPrincipal>();
    // Express names the pattern the request matched; its type is `any`, so it is read as unknown.
    const pattern = (req as { route?: { path?: unknown } }).route?.path;
    if (typeof pattern !== 'string' || !isIdempotentRoute(req.method, pattern))
      return next.handle();
    const key = idempotencyKeyOf(req.headers[IDEMPOTENCY_KEY_HEADER]);
    const principal = req.principal;
    // No principal cannot happen here (every idempotent route needs a sign-in and the guard ran).
    if (key === undefined || principal === undefined) return next.handle();

    // Every path parameter of these routes is a UUID or a short code: a path this long names no
    // record, and it is answered as one that does not exist before the store is asked to key it.
    if (req.path.length > MAX_PATH) throw new ProblemError(404, 'not-found', 'Not found');

    const res = http.getResponse<Response>();
    const requestId = req.id ?? 'unknown';
    const scope: KeyScope = { userId: principal.userId, method: req.method, path: req.path, key };
    const fingerprint = requestFingerprint(req.body);
    return from(this.reserve(principal, requestId, scope, fingerprint)).pipe(
      mergeMap((earlier) => {
        if (earlier !== null) {
          res.status(earlier.status);
          res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
          if (earlier.etag !== null) res.setHeader('ETag', earlier.etag);
          return of(earlier.body ?? undefined);
        }
        return next.handle().pipe(
          catchError((error: unknown) =>
            from(this.release(principal, requestId, scope)).pipe(
              mergeMap(() => throwError(() => error)),
            ),
          ),
          mergeMap(async (body: unknown) => {
            await this.complete(principal, requestId, scope, res, body);
            return body;
          }),
        );
      }),
    );
  }

  /**
   * Reserves the key for this request: null when this is its first use (the command runs), the
   * stored answer when an earlier request with the same body completed. 422 when the body
   * differs, 409 while the earlier request has not answered yet.
   */
  private reserve(
    principal: Principal,
    requestId: string,
    scope: KeyScope,
    fingerprint: string,
  ): Promise<StoredAnswer | null> {
    return this.db.run(principal, requestId, async (tx) => {
      const reserved = await tx
        .insert(keys)
        .values({ ...scope, requestHash: this.cipher.encrypt(fingerprint) })
        .onConflictDoNothing()
        .returning();
      if (reserved.length > 0) return null;
      const [row] = await tx
        .select({
          requestHash: keys.requestHash,
          status: keys.responseStatus,
          body: keys.responseBody,
          etag: keys.responseEtag,
        })
        .from(keys)
        .where(ownRow(scope));
      // The earlier request was refused and released the key between the two statements.
      if (row === undefined) throw inProgress();
      if (!this.sameRequest(row.requestHash, fingerprint))
        throw new ProblemError(
          422,
          'idempotency-key-reuse',
          'This Idempotency-Key was already used with a different request body',
        );
      if (row.status === null) throw inProgress();
      return { status: row.status, body: row.body, etag: row.etag };
    });
  }

  /** Whether the sealed fingerprint a row holds is this request's. A value this key cannot open is another request. */
  private sameRequest(sealed: string, fingerprint: string): boolean {
    try {
      const stored = Buffer.from(this.cipher.decrypt(sealed), 'utf8');
      const mine = Buffer.from(fingerprint, 'utf8');
      return stored.length === mine.length && timingSafeEqual(stored, mine);
    } catch {
      return false;
    }
  }

  /**
   * Stores the answer of the command that just committed. It never throws: the command stands
   * whatever becomes of the bookkeeping, and its answer goes out. A status outside 2xx is not an
   * answer to replay, so the key is released instead.
   */
  private async complete(
    principal: Principal,
    requestId: string,
    scope: KeyScope,
    res: Response,
    body: unknown,
  ): Promise<void> {
    const status = res.statusCode;
    if (status < 200 || status > 299) return this.release(principal, requestId, scope);
    const etag = res.getHeader('etag');
    try {
      await this.db.run(principal, requestId, async (tx) => {
        await tx
          .update(keys)
          .set({
            responseStatus: status,
            responseBody: storableAnswer(body),
            responseEtag: typeof etag === 'string' ? etag : null,
          })
          .where(and(ownRow(scope), isNull(keys.responseStatus)));
      });
    } catch (error) {
      this.report('idempotency.complete', principal, requestId, error);
    }
  }

  /** Frees the key of a request that was refused, so the corrected request may use it. It never throws. */
  private async release(principal: Principal, requestId: string, scope: KeyScope): Promise<void> {
    try {
      await this.db.run(principal, requestId, async (tx) => {
        await tx.delete(keys).where(and(ownRow(scope), isNull(keys.responseStatus)));
      });
    } catch (error) {
      this.report('idempotency.release', principal, requestId, error);
    }
  }

  /**
   * A content-free log line (docs/17 section 7): the error's name and SQLSTATE only. The
   * message of a failed query carries its parameters, which here are the stored answer.
   */
  private report(action: string, principal: Principal, requestId: string, error: unknown): void {
    this.logger.error(
      {
        request_id: requestId,
        user_id: principal.userId,
        action,
        entity: 'ops.idempotency_key',
        err: {
          name: error instanceof Error ? error.name : 'unknown',
          code: pgErrorCode(error) ?? null,
        },
      },
      'idempotency key bookkeeping failed',
    );
  }
}
