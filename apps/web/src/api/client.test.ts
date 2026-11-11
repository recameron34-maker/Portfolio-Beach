import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';
import { ROUTES, isIdempotencyKey, valuationPage, valuationRow } from '@pb/contracts';
import { postValuation } from '../app/mutations.js';
import { clearCredential, setCredential } from '../app/session.js';
import { createPreviewFetch } from '../preview/shim.js';
import { createPreviewState } from '../preview/state.js';
import { IDS, USERS, buildWorld } from '../preview/test-fixtures.js';
import { api } from './client.js';
import { RETRY_WINDOW_MS, forgetIdempotencyKeys } from './idempotency.js';

/**
 * The Idempotency-Key the web names its writes with (docs/17 section 3; review findings D7-1,
 * VAL-4 and CR-4, client half): one key per action on every route the contract marks idempotent,
 * the same key when that action is tried again, never the same key for another body.
 */

const NIL = '00000000-0000-4000-8000-000000000000';
const COMMANDS = `/api/v1/valuations/${NIL}/commands`;
const anything = z.unknown();

const ok = (status = 200): Response =>
  new Response(JSON.stringify({ done: true }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const refused = (status: number, code: string): Response =>
  new Response(
    JSON.stringify({
      type: `https://portfolio-beach.example/problems/${code}`,
      title: 'Refused',
      status,
      detail: 'refused',
      request_id: 'test',
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

let fetchSpy: MockInstance<typeof fetch>;

/** The Idempotency-Key header of each request sent so far, null where a request carried none. */
const keysSent = (): (string | null)[] =>
  fetchSpy.mock.calls.map(([, init]) => new Headers(init?.headers).get('idempotency-key'));

const write = (body: unknown, path = COMMANDS, method = 'POST'): Promise<unknown> =>
  api(path, anything, { method, body: JSON.stringify(body) });

/** One write that the mocked fetch answers or fails; the outcome is swallowed, the key returned. */
async function keyOf(body: unknown, path = COMMANDS, method = 'POST'): Promise<string | null> {
  await write(body, path, method).catch(() => undefined);
  return keysSent().at(-1) ?? null;
}

beforeEach(() => {
  setCredential('ops.one');
  forgetIdempotencyKeys();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(ok()));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearCredential();
});

describe('the Idempotency-Key of a write', () => {
  it('is sent on every route the contract marks idempotent, and on no other', async () => {
    const idempotent = ROUTES.filter((r) => r.idempotent === true);
    expect(idempotent.length).toBeGreaterThanOrEqual(20);
    for (const route of ROUTES) {
      const path = route.path.replace(/\{[a-zA-Z]+\}/g, NIL);
      const init: RequestInit =
        route.method === 'GET'
          ? {}
          : { method: route.method, body: JSON.stringify({ command: 'x' }) };
      await api(`${path}?limit=1`, anything, init);
      const key = keysSent().at(-1) ?? null;
      const what = `${route.method} ${route.path}`;
      if (route.idempotent === true) {
        expect(key, what).not.toBeNull();
        expect(isIdempotencyKey(key ?? ''), what).toBe(true);
      } else expect(key, what).toBeNull();
    }
    // Each of those was its own action: no two share a key.
    const keys = keysSent().filter((k) => k !== null);
    expect(new Set(keys).size).toBe(idempotent.length);
  });

  it('is new for each action: another body, another record, or the same command once it has been answered', async () => {
    const prepare = await keyOf({ command: 'prepare' });
    const sendBack = await keyOf({ command: 'sendBack', reason: 'Wrong period' });
    const elsewhere = await keyOf(
      { command: 'prepare' },
      `/api/v1/valuations/${NIL.replace(/0$/, '1')}/commands`,
    );
    const again = await keyOf({ command: 'prepare' });
    expect(new Set([prepare, sendBack, elsewhere, again]).size).toBe(4);
  });

  it('is the same when the action is tried again after no answer came back', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(write({ command: 'prepare' })).rejects.toThrow('Failed to fetch');
    const [first] = keysSent();
    expect(await keyOf({ command: 'prepare' })).toBe(first);
    // That retry was answered, so the action is over: the same command later is a new action.
    expect(await keyOf({ command: 'prepare' })).not.toBe(first);
  });

  it('is the same after a server failure, and while the API says the first request is still running', async () => {
    fetchSpy
      .mockResolvedValueOnce(refused(503, 'unavailable'))
      .mockResolvedValueOnce(refused(409, 'idempotency-key-in-progress'))
      .mockResolvedValueOnce(refused(409, 'idempotency-key-in-progress'));
    const first = await keyOf({ command: 'prepare' });
    expect(await keyOf({ command: 'prepare' })).toBe(first);
    expect(await keyOf({ command: 'prepare' })).toBe(first);
    // The stored answer arrives (the fourth try): the action is over.
    expect(await keyOf({ command: 'prepare' })).toBe(first);
    expect(await keyOf({ command: 'prepare' })).not.toBe(first);
  });

  it('is never reused for a different body, and a key order is not a difference', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const first = await keyOf({ command: 'sendBack', reason: 'Wrong period' });
    const other = await keyOf({ command: 'sendBack', reason: 'Wrong method' });
    expect(other).not.toBe(first);
    // The first action is still unanswered: tried again, in whatever order its keys are written.
    expect(await keyOf({ reason: 'Wrong period', command: 'sendBack' })).toBe(first);
  });

  it('ends with a refusal: the corrected or repeated request is a new action', async () => {
    for (const [status, code] of [
      [400, 'validation'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [409, 'workflow-transition'],
      [412, 'stale-row-version'],
      [422, 'workflow-precondition'],
      [422, 'idempotency-key-reuse'],
    ] as const) {
      fetchSpy.mockResolvedValueOnce(refused(status, code));
      const first = await keyOf({ command: 'prepare' });
      expect(await keyOf({ command: 'prepare' }), code).not.toBe(first);
    }
  });

  it("belongs to the person: another sign-in never sends the first one's key", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const first = await keyOf({ command: 'prepare' });
    setCredential('ops.two');
    expect(await keyOf({ command: 'prepare' })).not.toBe(first);
    setCredential('ops.one');
    expect(await keyOf({ command: 'prepare' })).toBe(first);
  });

  it('is shared by the same request sent twice at once, so a double click runs once', async () => {
    const both = Promise.all([write({ command: 'prepare' }), write({ command: 'prepare' })]);
    await both;
    const [first, second] = keysSent();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('is kept for a retry for five minutes, then the same request is a new action', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-07-01T09:00:00Z'));
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const first = await keyOf({ command: 'prepare' });
    expect(RETRY_WINDOW_MS).toBe(5 * 60_000);
    vi.setSystemTime(new Date(Date.now() + RETRY_WINDOW_MS));
    expect(await keyOf({ command: 'prepare' })).toBe(first);
    vi.setSystemTime(new Date(Date.now() + 1));
    expect(await keyOf({ command: 'prepare' })).not.toBe(first);
  });

  it('leaves a key the caller chose alone, and forgets every held key when asked', async () => {
    await api(COMMANDS, anything, {
      method: 'POST',
      body: JSON.stringify({ command: 'prepare' }),
      headers: { 'Idempotency-Key': 'chosen-by-the-caller' },
    });
    expect(keysSent()).toEqual(['chosen-by-the-caller']);
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const first = await keyOf({ command: 'prepare' });
    forgetIdempotencyKeys();
    expect(await keyOf({ command: 'prepare' })).not.toBe(first);
  });

  it('sends the request as before: the same path, method, body and credential', async () => {
    await write({ command: 'prepare' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(COMMANDS);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ command: 'prepare' }));
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer ops.one');
    expect(headers.get('content-type')).toBe('application/json');
    // The request leaves in the same turn the caller made it, as it did without a key.
    void write({ command: 'lock' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('is not kept past a sign-out', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const first = await keyOf({ command: 'prepare' });
    clearCredential();
    setCredential('ops.one');
    expect(await keyOf({ command: 'prepare' })).not.toBe(first);
  });
});

describe('a write whose answer was lost, tried again', () => {
  it('takes effect once: the store answers the retry with what the first request did', async () => {
    const state = createPreviewState();
    const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
    const store = createPreviewFetch(buildWorld().fixtures, never, { state });
    // The first request reaches the store and runs; its answer never reaches the page.
    let lost = 0;
    const replayed: (string | null)[] = [];
    fetchSpy.mockImplementation(async (input, init) => {
      const answer = await store(input, init);
      if (init?.method === 'POST' && lost++ === 0) throw new TypeError('Failed to fetch');
      replayed.push(answer.headers.get('idempotency-replayed'));
      return answer;
    });
    setCredential(USERS.ops.externalId);
    const body = {
      investmentId: IDS.open,
      periodEnd: '2025-06-30',
      method: 'valuation_method.sponsor_mark',
      fairValue: '1200.00',
    };
    await expect(postValuation(body)).rejects.toThrow('Failed to fetch');
    expect(state.audit).toHaveLength(1);
    // Without the key the second create is refused (the version exists); with it, it is the answer.
    const row = await postValuation(body);
    expect(replayed).toEqual(['true']);
    expect(valuationRow.parse(row)).toMatchObject({ version: 1, state: 'Draft' });
    expect(state.audit).toHaveLength(1);
    const versions = valuationPage
      .parse(
        await (
          await store(`/api/v1/valuations?investmentId=${IDS.open}&limit=200`, {
            headers: { authorization: `Bearer ${USERS.ops.externalId}` },
          })
        ).json(),
      )
      .items.filter((v) => v.periodEnd === '2025-06-30');
    expect(versions).toHaveLength(1);
  });
});
