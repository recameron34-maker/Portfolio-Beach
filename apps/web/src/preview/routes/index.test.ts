import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetails, valuationRow, wireInstructionDetail } from '@pb/contracts';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import { FUND_NAME, IDS, USERS, buildWorld, problemOf, send, testBook } from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';
import { SIM_ROUTES } from './index.js';

/**
 * The dispatcher of the simulated routes against the API's own order and words (docs/17 section
 * 3): the Idempotency-Key store as apps/api/src/common/idempotency.ts keeps it (review findings
 * D7-1, VAL-4 and CR-4; the API's test is apps/api/src/test/idempotency.test.ts) and the If-Match
 * header read at the boundary of the routes the contract marks (D7-2).
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const VALUATIONS = '/api/v1/valuations';
const WIRES = '/api/v1/wire-instructions';
const REPLAYED = 'idempotency-replayed';
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
const commands = (id: string): string => `${VALUATIONS}/${id}/commands`;
const keyOf = (key: string): Record<string, string> => ({ 'idempotency-key': key });

let ids = 0;
const env = {
  newId: (): string => `57000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

function setup(): { f: typeof fetch; state: PreviewState } {
  const state = createPreviewState();
  const f = createPreviewFetch(buildWorld().fixtures, never, { env, state, book: testBook() });
  return { f, state };
}

const createBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  investmentId: IDS.open,
  periodEnd: '2025-06-30',
  method: 'valuation_method.sponsor_mark',
  fairValue: '1200.00',
  ...overrides,
});

const typedDetails = {
  bankName: 'Meridian Clearing',
  accountName: FUND_NAME,
  accountNumber: '5550001234567',
  routingCode: '026009593',
};

function expectKeyRefused(answer: Answer, key: string): void {
  expect(answer.status, key).toBe(400);
  expect(problemDetails.parse(answer.json), key).toMatchObject({
    type: 'https://portfolio-beach.example/problems/validation',
    title: 'Bad request',
    detail: 'Invalid Idempotency-Key',
    errors: [{ path: 'Idempotency-Key', message: 'Expected 1 to 200 visible ASCII characters' }],
  });
}

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('Idempotency-Key in the preview, as the API keeps it', () => {
  it('takes the header on every route the contract marks idempotent, and on no other', () => {
    expect(SIM_ROUTES.filter((r) => r.idempotent).length).toBeGreaterThanOrEqual(19);
    for (const route of SIM_ROUTES)
      expect(route.idempotent, `${route.method} ${route.path}`).toBe(
        route.definition.idempotent === true,
      );
  });

  it('answers 400 for a malformed or empty key, after the role guard and before the body, never echoing it', async () => {
    const { f, state } = setup();
    const bad = [
      '',
      'two words',
      `k${'x'.repeat(200)}`,
      `caf${String.fromCharCode(0xe9)}`,
      'tab\tkey',
    ];
    for (const key of bad) {
      const answer = await send(
        f,
        USERS.ops.externalId,
        'POST',
        VALUATIONS,
        createBody(),
        keyOf(key),
      );
      expectKeyRefused(answer, key);
      expect(answer.headers.get('x-pb-simulated')).toBe('true');
      if (key.length > 0) expect(answer.text).not.toContain(key);
    }
    expect(state.audit).toHaveLength(0);
    // The key is checked before the body, and after identity and the role guard.
    expectKeyRefused(
      await send(f, USERS.ops.externalId, 'POST', VALUATIONS, { nope: true }, keyOf('a b')),
      'a b',
    );
    expect(
      (await send(f, USERS.viewer.externalId, 'POST', VALUATIONS, createBody(), keyOf('a b')))
        .status,
    ).toBe(403);
    expect((await send(f, 'nobody', 'POST', VALUATIONS, createBody(), keyOf('a b'))).status).toBe(
      401,
    );
    // The longest key is a key, and a route that is not idempotent ignores the header.
    const longest = await send(
      f,
      USERS.ops.externalId,
      'POST',
      VALUATIONS,
      createBody(),
      keyOf('k'.repeat(200)),
    );
    expect(longest.status).toBe(201);
    const flag = await send(
      f,
      USERS.admin.externalId,
      'PATCH',
      '/api/v1/flags/ai.extraction',
      { enabled: true, reason: 'demo' },
      keyOf('a b'),
    );
    expect(flag.status).toBe(200);
  });

  it('replays the stored status, body and ETag with Idempotency-Replayed, and runs nothing', async () => {
    const { f, state } = setup();
    const first = await send(
      f,
      USERS.ops.externalId,
      'POST',
      VALUATIONS,
      createBody(),
      keyOf('c-1'),
    );
    expect(first.status).toBe(201);
    expect(first.headers.get(REPLAYED)).toBeNull();
    const again = await send(
      f,
      USERS.ops.externalId,
      'POST',
      VALUATIONS,
      createBody(),
      keyOf('c-1'),
    );
    expect(again.status).toBe(201);
    expect(again.headers.get(REPLAYED)).toBe('true');
    expect(again.json).toEqual(first.json);
    expect(again.headers.get('etag')).toBe(first.headers.get('etag'));
    expect(again.headers.get('etag')).toBe('"1"');
    expect(again.headers.get('content-type')).toBe('application/json');
    expect(again.headers.get('x-request-id')).toBe('preview');
    expect(again.headers.get('x-pb-simulated')).toBe('true');
    expect(state.audit).toHaveLength(1);

    // A command, with the row version it was read at: the repeat names a version that is stale
    // by then, and is still the answer to the request already made, not a 412.
    const id = valuationRow.parse(first.json).id;
    const headers = { ...keyOf('p-1'), 'if-match': '"1"' };
    const prepared = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commands(id),
      { command: 'prepare' },
      headers,
    );
    expect(prepared.status).toBe(200);
    const replayed = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commands(id),
      { command: 'prepare' },
      headers,
    );
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get(REPLAYED)).toBe('true');
    expect(replayed.json).toEqual(prepared.json);
    expect(replayed.headers.get('etag')).toBe('"2"');
    expect(state.audit).toHaveLength(2);
    // Without the key the same command is evaluated again, and the table refuses it.
    expect(
      (await send(f, USERS.ops.externalId, 'POST', commands(id), { command: 'prepare' })).status,
    ).toBe(409);
  });

  it('reads the same body in another key order, or spaced differently, as the same request', async () => {
    const { f, state } = setup();
    const body = createBody();
    const first = await send(f, USERS.ops.externalId, 'POST', VALUATIONS, body, keyOf('order-1'));
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(body));
    for (const text of [JSON.stringify(reordered), JSON.stringify(body, null, 2)]) {
      const again = await send(f, USERS.ops.externalId, 'POST', VALUATIONS, text, keyOf('order-1'));
      expect(again.status).toBe(201);
      expect(again.headers.get(REPLAYED)).toBe('true');
      expect(again.json).toEqual(first.json);
    }
    expect(state.audit).toHaveLength(1);
  });

  it('refuses the same key with another body with 422 in the words of the API, and runs nothing', async () => {
    const { f, state } = setup();
    await send(f, USERS.ops.externalId, 'POST', VALUATIONS, createBody(), keyOf('reuse-1'));
    const reused = await send(
      f,
      USERS.ops.externalId,
      'POST',
      VALUATIONS,
      createBody({ fairValue: '9.00' }),
      keyOf('reuse-1'),
    );
    expect(reused.status).toBe(422);
    expect(problemDetails.parse(reused.json)).toMatchObject({
      type: 'https://portfolio-beach.example/problems/idempotency-key-reuse',
      title: 'Unprocessable',
      detail: 'This Idempotency-Key was already used with a different request body',
    });
    expect(reused.headers.get(REPLAYED)).toBeNull();
    expect(state.audit).toHaveLength(1);
  });

  it('scopes a key to its user and its path, and keeps nothing of a refused request', async () => {
    const { f } = setup();
    // A refused request stores nothing: the key is free for the corrected body.
    const wrong = await send(
      f,
      USERS.ops.externalId,
      'POST',
      VALUATIONS,
      createBody({ fairValue: '0.00' }),
      keyOf('shared-1'),
    );
    expect(wrong.status).toBe(400);
    const mine = await send(
      f,
      USERS.ops.externalId,
      'POST',
      VALUATIONS,
      createBody(),
      keyOf('shared-1'),
    );
    expect(mine.status).toBe(201);
    expect(mine.headers.get(REPLAYED)).toBeNull();
    // Two people may choose the same key: the second runs their own request (refused here,
    // because the version exists by now), never reads the first one's answer.
    const theirs = await send(
      f,
      USERS.all.externalId,
      'POST',
      VALUATIONS,
      createBody(),
      keyOf('shared-1'),
    );
    expect(theirs.status).toBe(422);
    expect(problemOf(theirs).code).not.toBe('idempotency-key-reuse');
    // The same key on another path is another request.
    const id = valuationRow.parse(mine.json).id;
    const moved = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commands(id),
      { command: 'prepare' },
      keyOf('shared-1'),
    );
    expect(moved.status).toBe(200);
    expect(moved.headers.get(REPLAYED)).toBeNull();
  });

  it('never replays bank details: the repeat of both wire instruction routes carries bankDetails null', async () => {
    const { f, state } = setup();
    const body = {
      sponsorFundId: IDS.fund,
      counterpartyName: FUND_NAME,
      bankDetails: typedDetails,
    };
    const first = await send(f, USERS.ops.externalId, 'POST', WIRES, body, keyOf('wire-1'));
    expect(first.status).toBe(201);
    const created = wireInstructionDetail.parse(first.json);
    const versions = state.wires?.size;
    const again = await send(f, USERS.ops.externalId, 'POST', WIRES, body, keyOf('wire-1'));
    expect(again.status).toBe(201);
    expect(again.headers.get(REPLAYED)).toBe('true');
    expect(again.json).toEqual({ ...created, bankDetails: null });
    expect(again.text).not.toContain(typedDetails.accountNumber);
    expect(again.text).not.toContain(typedDetails.routingCode);
    expect(state.wires?.size).toBe(versions);
    // The fingerprint covers the details: the same key with another account is refused.
    const other = { ...body, bankDetails: { ...typedDetails, accountNumber: '5550001234568' } };
    const reused = await send(f, USERS.ops.externalId, 'POST', WIRES, other, keyOf('wire-1'));
    expect(reused.status).toBe(422);
    expect(problemOf(reused).code).toBe('idempotency-key-reuse');

    // The command route: a second person rejects the version, and repeats the request.
    const reject = { command: 'reject', reason: 'The callback did not confirm the details' };
    const path = `${WIRES}/${created.id}/commands`;
    const rejected = await send(f, USERS.ops2.externalId, 'POST', path, reject, keyOf('wire-2'));
    expect(rejected.status).toBe(200);
    const detail = wireInstructionDetail.parse(rejected.json);
    expect(detail.state).toBe('Rejected');
    const replayed = await send(f, USERS.ops2.externalId, 'POST', path, reject, keyOf('wire-2'));
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get(REPLAYED)).toBe('true');
    expect(replayed.json).toEqual({ ...detail, bankDetails: null });
    expect(replayed.text).not.toContain(typedDetails.accountNumber);
  });

  it('answers 404 for a path too long to name a record when it carries a key', async () => {
    const { f } = setup();
    const endless = `/api/v1/closings/${NO_SUCH_ID}/items/${'x'.repeat(600)}/commands`;
    const lost = await send(
      f,
      USERS.ops.externalId,
      'POST',
      endless,
      { command: 'reopen' },
      keyOf('endless-1'),
    );
    expect(lost.status).toBe(404);
    expect(problemOf(lost)).toEqual({ code: 'not-found', detail: 'Not found' });
  });
});

describe('If-Match in the preview, read at the boundary as the API reads it', () => {
  it('answers 400 for a malformed header after the body and before the record is looked for', async () => {
    const { f } = setup();
    const malformed = { 'if-match': 'latest' };
    const absent = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commands(NO_SUCH_ID),
      { command: 'prepare' },
      malformed,
    );
    expect(absent.status).toBe(400);
    expect(problemDetails.parse(absent.json)).toMatchObject({
      type: 'https://portfolio-beach.example/problems/validation',
      detail: 'Invalid If-Match',
      instance: commands(NO_SUCH_ID),
      errors: [{ path: 'If-Match', message: 'Expected the row version as an entity tag' }],
    });
    // A readable header on the same request reaches the record, which does not exist.
    expect(
      (
        await send(
          f,
          USERS.ops.externalId,
          'POST',
          commands(NO_SUCH_ID),
          { command: 'prepare' },
          { 'if-match': '"1"' },
        )
      ).status,
    ).toBe(404);
    // The body is validated first, as the controllers do.
    const badBody = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commands(NO_SUCH_ID),
      { nope: true },
      malformed,
    );
    expect(badBody.status).toBe(400);
    expect(problemOf(badBody).detail).toBe('Invalid command');
  });

  it('ignores the header on a route the contract does not mark', async () => {
    const { f } = setup();
    const created = await send(f, USERS.ops.externalId, 'POST', VALUATIONS, createBody(), {
      'if-match': 'latest',
    });
    expect(created.status).toBe(201);
  });

  it('names the row version the record is at in the 412, as the API does', async () => {
    const { f } = setup();
    const stale = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commands(IDS.valuation.Draft),
      { command: 'prepare' },
      { 'if-match': '"2"' },
    );
    expect(stale.status).toBe(412);
    expect(problemOf(stale)).toEqual({
      code: 'stale-row-version',
      detail:
        'valuation: the record changed since it was read (it is now at row version 1); open it again',
    });
    // The weak form in lower case and leading zeros read as the API reads them.
    const fresh = await send(
      f,
      USERS.ops.externalId,
      'POST',
      commands(IDS.valuation.Draft),
      { command: 'prepare' },
      { 'if-match': 'w/"01"' },
    );
    expect(fresh.status).toBe(200);
  });
});
