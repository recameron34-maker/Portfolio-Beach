import { describe, expect, it } from 'vitest';
import { IF_MATCH_CASES, ROUTES, problemDetails } from '@pb/contracts';
import type { IfMatchCase } from '@pb/contracts';
import { defineSimRoute, staleIfMatch } from './common.js';

const ID = '30000000-0000-4000-8000-000000000101';
const INSTANCE = `/api/v1/valuations/${ID}/commands`;

/** The header as a browser carries it: a repeated header reads as one comma-separated list. */
function headersOf(header: IfMatchCase['header']): Headers {
  const headers = new Headers();
  if (typeof header === 'string') headers.set('if-match', header);
  else for (const value of header ?? []) headers.append('if-match', value);
  return headers;
}

async function problemOf(
  response: Response | null,
): Promise<ReturnType<typeof problemDetails.parse>> {
  if (response === null) throw new Error('expected a problem');
  return problemDetails.parse(await response.json());
}

/**
 * The preview's reading of If-Match against the conformance table of the contracts
 * (packages/contracts/src/row-version.ts), which the API runs too
 * (apps/api/src/test/row-version.test.ts): review finding D7-2.
 */
describe('staleIfMatch (docs/17 section 3)', () => {
  it.each(IF_MATCH_CASES.map((c) => [c.name, c] as const))(
    'reads %s as the API does',
    async (_name, c) => {
      const headers = headersOf(c.header);
      if (c.expected === 'invalid') {
        const refused = staleIfMatch(headers, 1, INSTANCE);
        expect(refused?.status).toBe(400);
        expect(refused?.headers.get('x-pb-simulated')).toBe('true');
        expect(await problemOf(refused)).toMatchObject({
          type: 'https://portfolio-beach.example/problems/validation',
          title: 'Bad request',
          detail: 'Invalid If-Match',
          instance: INSTANCE,
          errors: [{ path: 'If-Match', message: 'Expected the row version as an entity tag' }],
        });
        return;
      }
      if (c.expected === 'any') {
        expect(staleIfMatch(headers, 1, INSTANCE)).toBeNull();
        expect(staleIfMatch(headers, 77, INSTANCE)).toBeNull();
        return;
      }
      for (const version of c.expected) expect(staleIfMatch(headers, version, INSTANCE)).toBeNull();
      const now = Math.max(...c.expected) + 1;
      const stale = staleIfMatch(headers, now, INSTANCE);
      expect(stale?.status).toBe(412);
      expect(stale?.headers.get('x-pb-simulated')).toBe('true');
      expect(await problemOf(stale)).toMatchObject({
        type: 'https://portfolio-beach.example/problems/stale-row-version',
        title: 'Precondition failed',
        detail: `valuation: the record changed since it was read (it is now at row version ${now}); open it again`,
        instance: INSTANCE,
      });
    },
  );

  it('names the record kind the contract gives the route, as the API names it', async () => {
    const guarded = ROUTES.filter((r) => r.ifMatch !== undefined);
    expect(guarded.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'PATCH /api/v1/underwriting-cases/{id}',
      'PATCH /api/v1/valuations/{id}',
      'POST /api/v1/capital-notices/{id}/commands',
      'POST /api/v1/change-requests/{id}/commands',
      'POST /api/v1/closings/{id}/commands',
      'POST /api/v1/opportunities/{id}/commands',
      'POST /api/v1/report-packages/{id}/commands',
      'POST /api/v1/underwriting-cases/{id}/commands',
      'POST /api/v1/valuations/{id}/commands',
      'POST /api/v1/wire-instructions/{id}/commands',
    ]);
    for (const route of guarded) {
      const instance = route.path.replace('{id}', ID);
      const stale = staleIfMatch(headersOf('"1"'), 2, instance);
      expect((await problemOf(stale)).detail, route.path).toBe(
        `${route.ifMatch}: the record changed since it was read (it is now at row version 2); open it again`,
      );
    }
    // A caller that guards another record than the path names says which.
    expect(
      (await problemOf(staleIfMatch(headersOf('"1"'), 2, INSTANCE, 'closing'))).detail,
    ).toMatch(/^closing: /);
  });

  it('refuses to guess the record kind on a path the contract does not mark', () => {
    expect(() => staleIfMatch(headersOf('"1"'), 2, `/api/v1/valuations`)).toThrow(/If-Match/);
    // No header, no check, and so no question of the kind.
    expect(staleIfMatch(new Headers(), 2, '/api/v1/valuations')).toBeNull();
  });
});

describe('defineSimRoute', () => {
  it('takes idempotency from the contract, never from the route file', () => {
    const contract = (method: string, path: string) =>
      ROUTES.find((r) => r.method === method && r.path === path);
    const command = contract('POST', '/api/v1/valuations/{id}/commands');
    if (command?.body === undefined) throw new Error('the contract lost the valuation command');
    const spec = {
      method: 'POST' as const,
      path: '/api/v1/valuations/{id}/commands',
      what: 'command',
      body: command.body,
      handle: () => new Response(null),
    };
    expect(command.idempotent).toBe(true);
    expect(defineSimRoute(spec).idempotent).toBe(true);
    expect(defineSimRoute({ ...spec, idempotent: true }).idempotent).toBe(true);
    expect(() => defineSimRoute({ ...spec, idempotent: false })).toThrow(/idempotent/);

    const flag = contract('PATCH', '/api/v1/flags/{key}');
    if (flag?.body === undefined) throw new Error('the contract lost the flag change');
    const other = {
      method: 'PATCH' as const,
      path: '/api/v1/flags/{key}',
      what: 'flag change',
      body: flag.body,
      handle: () => new Response(null),
    };
    expect(flag.idempotent).toBeUndefined();
    expect(defineSimRoute(other).idempotent).toBe(false);
    expect(() => defineSimRoute({ ...other, idempotent: true })).toThrow(/idempotent/);
  });
});
