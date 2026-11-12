import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureFlagList, problemDetails } from '@pb/contracts';
import { parseFixtures } from './fixtures.js';
import { createPreviewFetch, installPreviewShim } from './shim.js';
import { createPreviewState } from './state.js';
import type { SimValuation } from './state.js';
import { FixtureBuilder, IDS, USERS, buildWorld } from './test-fixtures.js';

const never: typeof fetch = () =>
  Promise.reject(new Error('real fetch must not be called for API routes'));

const as = (credential: string): RequestInit => ({
  headers: { authorization: `Bearer ${credential}` },
});

beforeEach(() => {
  window.__pbPreviewMisses = [];
  window.__pbPreviewActivity = { inflight: 0, total: 0 };
});
afterEach(() => {
  delete window.__pbPreviewMisses;
  delete window.__pbPreviewActivity;
});

describe('preview fetch shim: replay', () => {
  const { fixtures } = buildWorld();

  it('serves recorded responses per credential and keeps recorded 404s', async () => {
    const f = createPreviewFetch(fixtures, never);
    const open = await f(`/api/v1/investments/${IDS.open}`, as(USERS.viewer.externalId));
    expect(open.status).toBe(200);
    expect(open.headers.get('x-request-id')).toBe('preview');
    const walled = await f(`/api/v1/investments/${IDS.walled}`, as(USERS.viewer.externalId));
    expect(walled.status).toBe(404);
    expect(walled.headers.get('content-type')).toContain('problem+json');
    const member = await f(`/api/v1/investments/${IDS.walled}`, as(USERS.dealWall.externalId));
    expect(member.status).toBe(200);
  });

  it('matches recorded keys whatever order the page builds the query in', async () => {
    const f = createPreviewFetch(fixtures, never);
    const a = await f(`/api/v1/valuations?limit=200&investmentId=${IDS.open}`, as('ops.one'));
    const b = await f(`/api/v1/valuations?investmentId=${IDS.open}&limit=200`, as('ops.one'));
    expect(a.status).toBe(200);
    expect(await a.text()).toBe(await b.text());
  });

  it('rejects anonymous and unknown credentials on protected routes but serves public ones', async () => {
    const f = createPreviewFetch(fixtures, never);
    expect((await f('/api/v1/flags')).status).toBe(401);
    expect((await f('/api/v1/auth/me', as('nobody'))).status).toBe(401);
    expect((await f('/api/v1/auth/mock-users')).status).toBe(200);
    expect(
      (
        await f('/api/v1/preview/reset', {
          method: 'POST',
          headers: { authorization: 'Bearer nobody' },
        })
      ).status,
    ).toBe(401);
  });

  it('answers a request outside the recordings with a 404 problem and logs its key for the probe', async () => {
    const f = createPreviewFetch(fixtures, never);
    const miss = await f('/api/v1/investments?limit=7', as('viewer.one'));
    expect(miss.status).toBe(404);
    const body = problemDetails.parse(await miss.json());
    expect(body.detail).toBe('This request is outside the recorded preview');
    const write = await f('/api/v1/valuations/whatever', { ...as('ops.one'), method: 'DELETE' });
    expect(write.status).toBe(404);
    expect(window.__pbPreviewMisses).toEqual([
      'viewer.one|GET /api/v1/investments?limit=7',
      'ops.one|DELETE /api/v1/valuations/whatever',
    ]);
  });

  it('counts the requests it answers so the probe can wait for a quiet page', async () => {
    const f = createPreviewFetch(fixtures, never);
    await Promise.all([f('/api/v1/auth/me', as('viewer.one')), f('/api/v1/flags', as('ops.one'))]);
    expect(window.__pbPreviewActivity).toEqual({ inflight: 0, total: 2 });
  });

  it('answers a 500 problem and logs when the simulation itself fails', async () => {
    const state = createPreviewState();
    // A corrupted session state makes the valuation overlay throw.
    state.valuations = new Map([['broken', null as unknown as SimValuation]]);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = createPreviewFetch(fixtures, never, { state });
    const answer = await f('/api/v1/valuations?limit=200', as('ops.one'));
    expect(answer.status).toBe(500);
    expect(problemDetails.parse(await answer.json()).title).toBe('Internal error');
    expect(logged).toHaveBeenCalledOnce();
    expect(window.__pbPreviewActivity?.inflight).toBe(0);
    logged.mockRestore();
  });

  it('passes non-API requests through to the real fetch', async () => {
    const f = createPreviewFetch(fixtures, () =>
      Promise.resolve(new Response('asset', { status: 200 })),
    );
    expect(await (await f('./preview/fixtures.json')).text()).toBe('asset');
    expect(window.__pbPreviewActivity?.total).toBe(0);
  });
});

describe('installPreviewShim: the recordings are required, the book is not', () => {
  const { fixtures } = buildWorld();
  const realFetch = window.fetch.bind(window);
  const NO_BOOK = 'This preview carries no book to check an import against';
  /** The static files beside the page, by the URL the shim asks for; anything else is 404. */
  const serve =
    (files: Record<string, string>): typeof fetch =>
    (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = files[url];
      return Promise.resolve(
        body === undefined
          ? new Response('', { status: 404 })
          : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    };
  const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  afterEach(() => {
    window.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('installs without the book: the recordings answer, only Data > Intake answers 503', async () => {
    const warned = warnings();
    window.fetch = serve({ 'fixtures.json': JSON.stringify(fixtures) });
    await installPreviewShim('fixtures.json', 'book.json');
    expect(warned).toHaveBeenCalledOnce();
    expect(warned.mock.calls[0]?.[0]).toContain('preview book not found at book.json');
    const open = await window.fetch(`/api/v1/investments/${IDS.open}`, as(USERS.viewer.externalId));
    expect(open.status).toBe(200);
    const exports = await window.fetch(
      '/api/v1/intake/accounting/exports',
      as(USERS.ops.externalId),
    );
    expect(exports.status).toBe(503);
    expect(problemDetails.parse(await exports.json()).detail).toBe(NO_BOOK);
  });

  it('installs with a book in the wrong format, warning with the parse message', async () => {
    const warned = warnings();
    window.fetch = serve({ 'fixtures.json': JSON.stringify(fixtures), 'book.json': '{"asOf":1}' });
    await installPreviewShim('fixtures.json', 'book.json');
    expect(warned).toHaveBeenCalledOnce();
    expect(warned.mock.calls[0]?.[0]).toMatch(/not in the expected format at .*build:preview/);
    const exports = await window.fetch(
      '/api/v1/intake/accounting/exports',
      as(USERS.ops.externalId),
    );
    expect(exports.status).toBe(503);
    expect(problemDetails.parse(await exports.json()).detail).toBe(NO_BOOK);
  });

  it('installs with a book that is not JSON, warning with the parse message', async () => {
    const warned = warnings();
    window.fetch = serve({ 'fixtures.json': JSON.stringify(fixtures), 'book.json': '{not json' });
    await installPreviewShim('fixtures.json', 'book.json');
    expect(warned).toHaveBeenCalledOnce();
    expect(warned.mock.calls[0]?.[0]).toContain('JSON');
    expect(
      (await window.fetch('/api/v1/intake/accounting/exports', as(USERS.ops.externalId))).status,
    ).toBe(503);
  });

  it('fails without the recordings and installs nothing', async () => {
    const warned = warnings();
    window.fetch = serve({});
    await expect(installPreviewShim('fixtures.json', 'book.json')).rejects.toThrow(
      'preview fixtures not found at fixtures.json',
    );
    // Nothing was installed: a route the shim would answer still goes to the network, which has nothing.
    expect((await window.fetch('/api/v1/auth/mock-users')).status).toBe(404);
    expect(warned).toHaveBeenCalledOnce();
  });
});

describe('preview fixtures file', () => {
  it('accepts the content-addressed format', () => {
    const { fixtures } = buildWorld();
    expect(parseFixtures(JSON.parse(JSON.stringify(fixtures))).users).toHaveLength(8);
  });

  it('refuses the older inline format with a message that says how to rebuild', () => {
    const old = {
      generatedFrom: 'x',
      asOf: '2025-06-30',
      users: [{ externalId: 'viewer.one', roles: ['viewer'] }],
      responses: {
        '|GET /health/live': { status: 200, contentType: 'application/json', body: '{}' },
      },
    };
    expect(() => parseFixtures(old)).toThrow(/build:preview/);
  });

  it('refuses a response that points at a missing body', () => {
    const fixtures = new FixtureBuilder([USERS.viewer]).add('', '/health/live', {}).build();
    fixtures.bodies = {};
    expect(() => parseFixtures(fixtures)).toThrow(/no body for \|GET \/health\/live/);
  });
});

describe('simulated flag writes', () => {
  const { fixtures } = buildWorld();
  const patch = (credential: string, key: string, body: unknown): RequestInit => ({
    method: 'PATCH',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('lets platform admins change a flag for the session, labelled as simulated', async () => {
    const f = createPreviewFetch(fixtures, never);
    const denied = await f(
      '/api/v1/flags/ai.extraction',
      patch('viewer.one', 'ai.extraction', { enabled: true, reason: 'demo' }),
    );
    expect(denied.status).toBe(403);
    const bad = await f(
      '/api/v1/flags/ai.extraction',
      patch('admin.one', 'ai.extraction', { enabled: true }),
    );
    expect(bad.status).toBe(400);
    const ok = await f(
      '/api/v1/flags/ai.extraction',
      patch('admin.one', 'ai.extraction', { enabled: true, reason: 'demo' }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-pb-simulated')).toBe('true');
    // Every role sees the new value until the page reloads.
    for (const credential of ['admin.one', 'viewer.one']) {
      const list = featureFlagList.parse(await (await f('/api/v1/flags', as(credential))).json());
      expect(list.flags[0]?.enabled).toBe(true);
    }
    const unknown = await f(
      '/api/v1/flags/does.not.exist',
      patch('admin.one', 'does.not.exist', { enabled: true, reason: 'demo' }),
    );
    expect(unknown.status).toBe(404);
  });
});
