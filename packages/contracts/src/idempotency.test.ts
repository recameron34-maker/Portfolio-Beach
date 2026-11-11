import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_IN_PROGRESS,
  IDEMPOTENCY_KEY_ISSUE,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_KEY_REUSE,
  IDEMPOTENCY_MAX_PATH,
  IDEMPOTENCY_REPLAYED_HEADER,
  INVALID_IDEMPOTENCY_KEY_DETAIL,
  canonicalRequestBody,
  idempotentRouteOf,
  isIdempotencyKey,
  storableAnswer,
} from './idempotency.js';
import { routePathMatcher } from './route.js';
import { ROUTES } from './routes.js';

const NIL = '00000000-0000-4000-8000-000000000000';
const concrete = (template: string): string => template.replace(/\{[a-zA-Z]+\}/g, NIL);

describe('Idempotency-Key (docs/17 section 3)', () => {
  it('accepts 1 to 200 visible ASCII characters and nothing else', () => {
    for (const key of ['7c0e9c1e-6f0e-4a57-9d0c-2a4f8a5d1b11', 'k', 'k'.repeat(200), '!~', 'a:b/c'])
      expect(isIdempotencyKey(key), key).toBe(true);
    for (const key of [
      '',
      ' ',
      'two words',
      `k${'x'.repeat(200)}`,
      `caf${String.fromCharCode(0xe9)}`,
      'tab\tkey',
      'line\nbreak',
      String.fromCharCode(0x7f),
    ])
      expect(isIdempotencyKey(key), JSON.stringify(key)).toBe(false);
    expect(new RegExp(IDEMPOTENCY_KEY_PATTERN).test('a b')).toBe(false);
  });

  it('words the header names and the three refusals as the API answers them', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('idempotency-key');
    expect(IDEMPOTENCY_REPLAYED_HEADER).toBe('Idempotency-Replayed');
    expect(INVALID_IDEMPOTENCY_KEY_DETAIL).toBe('Invalid Idempotency-Key');
    expect(IDEMPOTENCY_KEY_ISSUE).toEqual({
      path: 'Idempotency-Key',
      message: 'Expected 1 to 200 visible ASCII characters',
    });
    expect(IDEMPOTENCY_KEY_REUSE).toEqual({
      status: 422,
      code: 'idempotency-key-reuse',
      detail: 'This Idempotency-Key was already used with a different request body',
    });
    expect(IDEMPOTENCY_KEY_IN_PROGRESS).toEqual({
      status: 409,
      code: 'idempotency-key-in-progress',
      detail:
        'A request with this Idempotency-Key is still running. Wait for its answer, or read the record again and send the request with a new key',
    });
    expect(IDEMPOTENCY_MAX_PATH).toBe(500);
  });

  it('reads a body by its content, whatever the order of its keys', () => {
    const a = { command: 'draftTicket', amount: '10.00', nested: { x: 1, y: [1, { b: 2, a: 1 }] } };
    const b = { nested: { y: [1, { a: 1, b: 2 }], x: 1 }, amount: '10.00', command: 'draftTicket' };
    expect(canonicalRequestBody(a)).toBe(
      '{"amount":"10.00","command":"draftTicket","nested":{"x":1,"y":[1,{"a":1,"b":2}]}}',
    );
    expect(canonicalRequestBody(b)).toBe(canonicalRequestBody(a));
    // An absent body is null, and an entry with no value is no entry, as on the wire.
    expect(canonicalRequestBody(undefined)).toBe('null');
    expect(canonicalRequestBody(null)).toBe('null');
    expect(canonicalRequestBody({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalRequestBody({})).toBe('{}');
    // Array order and values are content.
    expect(canonicalRequestBody({ ids: [1, 2] })).not.toBe(canonicalRequestBody({ ids: [2, 1] }));
    expect(canonicalRequestBody({ amount: '10.00' })).not.toBe(
      canonicalRequestBody({ amount: '10.0' }),
    );
  });

  it('stores an answer as its JSON with bank details removed at any depth', () => {
    const details = { bankName: 'Meridian Clearing', accountNumber: '5550001234567' };
    expect(
      storableAnswer({
        id: 'x',
        bankDetails: details,
        bankDetailsMasked: 'Meridian Clearing ****4567',
        items: [{ bankDetails: details, version: 2 }],
        loose: { accountNumber: '5550001234567', routingCode: '026009593', accountName: 'x' },
        at: new Date('2025-06-30T12:00:00Z'),
        skipped: undefined,
      }),
    ).toEqual({
      id: 'x',
      bankDetails: null,
      bankDetailsMasked: 'Meridian Clearing ****4567',
      items: [{ bankDetails: null, version: 2 }],
      loose: { accountNumber: null, routingCode: null, accountName: 'x' },
      at: '2025-06-30T12:00:00.000Z',
    });
    expect(storableAnswer(undefined)).toBeNull();
  });

  it('knows a request of an idempotent route by its method and concrete path, and no other', () => {
    const idempotent = ROUTES.filter((r) => r.idempotent === true);
    expect(idempotent.length).toBeGreaterThanOrEqual(20);
    for (const route of ROUTES)
      expect(
        idempotentRouteOf(route.method, concrete(route.path)),
        `${route.method} ${route.path}`,
      ).toBe(route.idempotent === true ? route : undefined);
    // The method in any case; the path without its query string; a GET of the same path is a read.
    expect(idempotentRouteOf('post', '/api/v1/valuations')?.path).toBe('/api/v1/valuations');
    expect(idempotentRouteOf('POST', '/api/v1/valuations?x=1')).toBeUndefined();
    expect(idempotentRouteOf('GET', `/api/v1/valuations/${NIL}`)).toBeUndefined();
    expect(idempotentRouteOf('PATCH', `/api/v1/valuations/${NIL}`)?.method).toBe('PATCH');
    expect(idempotentRouteOf('PATCH', '/api/v1/flags/ai.extraction')).toBeUndefined();
    // Every idempotent route carries a body, so its fingerprint always covers something.
    for (const route of idempotent) expect(route.body, route.path).toBeDefined();
  });
});

describe('routePathMatcher', () => {
  it('reads the path parameters of a template, decoded, and matches nothing else', () => {
    const match = routePathMatcher('/api/v1/closings/{id}/items/{itemCode}/commands');
    expect(match(`/api/v1/closings/${NIL}/items/closing_item.side_letter/commands`)).toEqual({
      id: NIL,
      itemCode: 'closing_item.side_letter',
    });
    expect(match('/api/v1/closings/a%20b/items/x/commands')).toEqual({ id: 'a b', itemCode: 'x' });
    expect(match(`/api/v1/closings/${NIL}/items/a/b/commands`)).toBeNull();
    expect(match(`/api/v1/closings/${NIL}/items//commands`)).toBeNull();
    expect(match(`/api/v1/closings/${NIL}/items/x/commands/`)).toBeNull();
    expect(match('/api/v1/closings/%E0%A4%A/items/x/commands')).toBeNull();
    // A literal dot in a template is a dot, not any character.
    expect(routePathMatcher('/health/live.json')('/health/livexjson')).toBeNull();
    expect(routePathMatcher('/health/live')('/health/live')).toEqual({});
  });
});
