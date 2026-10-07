import { describe, expect, it } from 'vitest';
import { createPreviewFetch, normalizeKey } from './shim.js';
import type { PreviewFixtures } from './shim.js';

const fixtures: PreviewFixtures = {
  generatedFrom: 'test',
  asOf: '2025-06-30',
  users: [
    { externalId: 'admin.one', roles: ['platform_admin'] },
    { externalId: 'viewer.one', roles: ['viewer'] },
  ],
  responses: {
    '|GET /api/v1/auth/mock-users': {
      status: 200,
      contentType: 'application/json',
      body: '{"users":[]}',
    },
    'viewer.one|GET /api/v1/investments?active=true&limit=100': {
      status: 200,
      contentType: 'application/json',
      body: '{"items":[],"nextCursor":null,"asOf":"2025-06-30"}',
    },
    'admin.one|GET /api/v1/flags': {
      status: 200,
      contentType: 'application/json',
      body: '{"flags":[{"key":"ai.extraction","enabled":false,"description":"x"}]}',
    },
    'viewer.one|GET /api/v1/investments/30000000-0000-4000-8000-000000000002': {
      status: 404,
      contentType: 'application/problem+json',
      body: '{"type":"https://portfolio-beach.example/problems/not-found","title":"Not found","status":404,"request_id":"r"}',
    },
  },
};

const never: typeof fetch = () =>
  Promise.reject(new Error('real fetch must not be called for API routes'));

describe('preview fetch shim', () => {
  it('normalizes query order so the recorder and the app agree on keys', () => {
    expect(normalizeKey('u', 'get', '/api/v1/investments', '?limit=100&active=true')).toBe(
      'u|GET /api/v1/investments?active=true&limit=100',
    );
    expect(normalizeKey('', 'GET', '/health/live', '')).toBe('|GET /health/live');
  });

  it('serves recorded responses per credential and keeps recorded 404s', async () => {
    const f = createPreviewFetch(fixtures, never);
    const page = await f('/api/v1/investments?limit=100&active=true', {
      headers: { authorization: 'Bearer viewer.one' },
    });
    expect(page.status).toBe(200);
    expect(((await page.json()) as { asOf: string }).asOf).toBe('2025-06-30');
    const walled = await f('/api/v1/investments/30000000-0000-4000-8000-000000000002', {
      headers: { authorization: 'Bearer viewer.one' },
    });
    expect(walled.status).toBe(404);
    expect(walled.headers.get('content-type')).toContain('problem+json');
  });

  it('rejects anonymous and unknown credentials on protected routes but serves public ones', async () => {
    const f = createPreviewFetch(fixtures, never);
    expect((await f('/api/v1/investments?limit=100')).status).toBe(401);
    expect(
      (await f('/api/v1/auth/me', { headers: { authorization: 'Bearer nobody' } })).status,
    ).toBe(401);
    expect((await f('/api/v1/auth/mock-users')).status).toBe(200);
  });

  it('simulates flag writes for platform admins only and remembers them for the session', async () => {
    const f = createPreviewFetch(fixtures, never);
    const denied = await f('/api/v1/flags/ai.extraction', {
      method: 'PATCH',
      headers: { authorization: 'Bearer viewer.one' },
      body: JSON.stringify({ enabled: true, reason: 'demo' }),
    });
    expect(denied.status).toBe(403);
    const bad = await f('/api/v1/flags/ai.extraction', {
      method: 'PATCH',
      headers: { authorization: 'Bearer admin.one' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(bad.status).toBe(400);
    const ok = await f('/api/v1/flags/ai.extraction', {
      method: 'PATCH',
      headers: { authorization: 'Bearer admin.one' },
      body: JSON.stringify({ enabled: true, reason: 'demo' }),
    });
    expect(ok.status).toBe(200);
    const list = (await (
      await f('/api/v1/flags', { headers: { authorization: 'Bearer admin.one' } })
    ).json()) as { flags: { enabled: boolean }[] };
    expect(list.flags[0]?.enabled).toBe(true);
    expect(
      (
        await f('/api/v1/flags/does.not.exist', {
          method: 'PATCH',
          headers: { authorization: 'Bearer admin.one' },
          body: JSON.stringify({ enabled: true, reason: 'demo' }),
        })
      ).status,
    ).toBe(404);
  });

  it('passes non-API requests through to the real fetch', async () => {
    const f = createPreviewFetch(fixtures, () =>
      Promise.resolve(new Response('asset', { status: 200 })),
    );
    expect(await (await f('./preview/fixtures.json')).text()).toBe('asset');
  });
});
