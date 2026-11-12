import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestQuarterEndOnOrBefore } from '@pb/calc';
import { IF_MATCH_CASES, ROUTES, problemDetails, rowVersionEtag } from '@pb/contracts';
import type { RouteDefinition } from '@pb/contracts';
import type { AppRole } from '@pb/db';
import { ProblemError } from '../common/problem.js';
import { ifMatchVersions, requireFreshRow, withEtag } from '../common/row-version.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

/** The problem a call throws, or undefined when it returns. */
function refusalOf(run: () => unknown): ProblemError | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  return undefined;
}

/**
 * The API's reading of If-Match against the conformance table of the contracts
 * (packages/contracts/src/row-version.ts), which the static preview runs too: the two cannot
 * answer the same header differently (review finding D7-2).
 */
describe('If-Match in the API (docs/17 section 3)', () => {
  it.each(IF_MATCH_CASES.map((c) => [c.name, c] as const))('reads %s', (_name, c) => {
    const header = typeof c.header === 'object' ? [...c.header] : c.header;
    const refusal = refusalOf(() => ifMatchVersions(header));
    if (c.expected === 'invalid') {
      expect(refusal?.getStatus()).toBe(400);
      expect(refusal?.code).toBe('validation');
      expect(refusal?.message).toBe('Invalid If-Match');
      expect(refusal?.errors).toEqual([
        { path: 'If-Match', message: 'Expected the row version as an entity tag' },
      ]);
      return;
    }
    expect(refusal).toBeUndefined();
    expect(ifMatchVersions(header)).toEqual(c.expected === 'any' ? undefined : c.expected);
  });

  it('refuses a stale row version with 412 and names the version the record is at', () => {
    expect(refusalOf(() => requireFreshRow(undefined, 4, 'valuation'))).toBeUndefined();
    expect(refusalOf(() => requireFreshRow([4], 4, 'valuation'))).toBeUndefined();
    expect(refusalOf(() => requireFreshRow([1, 4], 4, 'valuation'))).toBeUndefined();
    const stale = refusalOf(() => requireFreshRow([3], 4, 'valuation'));
    expect(stale?.getStatus()).toBe(412);
    expect(stale?.code).toBe('stale-row-version');
    expect(stale?.message).toBe(
      'valuation: the record changed since it was read (it is now at row version 4); open it again',
    );
    expect(stale?.errors).toBeUndefined();
  });

  it('tags an answer with the row version as a quoted entity tag', () => {
    const set: Record<string, string> = {};
    // The one method withEtag calls; the rest of the Express response is not needed here.
    const res = {
      setHeader: (name: string, value: string) => {
        set[name] = value;
      },
    } as unknown as Response;
    const row = { id: 'x', rowVersion: 7 };
    expect(withEtag(res, row)).toBe(row);
    expect(set).toEqual({ ETag: '"7"' });
    expect(ifMatchVersions(set.ETag)).toEqual([7]);
  });
});

const NIL = '00000000-0000-4000-8000-000000000000';

/** A body each guarded route accepts, so the answer is about the header and not the body. */
const VALID_BODY: Readonly<Record<string, object>> = {
  'POST /api/v1/valuations/{id}/commands': { command: 'prepare' },
  'PATCH /api/v1/valuations/{id}': { fairValue: '1.00' },
  'POST /api/v1/capital-notices/{id}/commands': { command: 'review' },
  'POST /api/v1/wire-instructions/{id}/commands': {
    command: 'reject',
    reason: 'The callback did not confirm the details',
  },
  'POST /api/v1/change-requests/{id}/commands': { command: 'start' },
  'POST /api/v1/opportunities/{id}/commands': { command: 'advance' },
  'POST /api/v1/closings/{id}/commands': { command: 'confirm' },
  'POST /api/v1/report-packages/{id}/commands': { command: 'generate' },
};

/**
 * The contract's `ifMatch` flag against the controllers: the OpenAPI document describes the
 * header from the flag and the static preview parses it on the flagged routes and no other, so
 * the flag has to say what the API does.
 */
describe('the routes the contract marks ifMatch', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    // The synthetic book seeds no reporting package: one is started here so that its read can
    // be checked with the others below.
    const clientId = h.dataset.users.find((u) => u.externalId === 'ir.one')?.clientIds[0];
    await h
      .http()
      .post('/api/v1/report-packages')
      .set('authorization', h.as('ir.one'))
      .set('idempotency-key', 'row-version-test-package')
      .send({
        clientId,
        periodEnd: latestQuarterEndOnOrBefore(h.dataset.asOf),
        basis: 'gross',
        label: 'preliminary',
      })
      .expect(201);
  });
  afterAll(async () => {
    await h.close();
  });

  const guarded = ROUTES.filter((route) => route.ifMatch !== undefined);
  const call = (route: RouteDefinition, ifMatch: string) => {
    const role = route.roles.find((r) =>
      h.dataset.users.some((u) => u.roles.includes(r as AppRole)),
    );
    if (role === undefined) throw new Error(`no synthetic user for ${route.path}`);
    const body = VALID_BODY[`${route.method} ${route.path}`];
    if (body === undefined) throw new Error(`no body for ${route.method} ${route.path}`);
    const method = route.method.toLowerCase() as 'post' | 'patch';
    return h
      .http()
      [method](route.path.replace(/\{[a-zA-Z]+\}/g, NIL))
      .set('authorization', h.as(role))
      .set('if-match', ifMatch)
      .send(body);
  };

  it('read the header: a malformed one is 400 before the record is looked for, a well-formed one goes on to the record', async () => {
    expect(guarded.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      Object.keys(VALID_BODY).sort(),
    );
    for (const route of guarded) {
      const what = `${route.method} ${route.path}`;
      const malformed = await call(route, 'latest');
      expect(malformed.status, what).toBe(400);
      expect(problemDetails.parse(malformed.body), what).toMatchObject({
        type: 'https://portfolio-beach.example/problems/validation',
        detail: 'Invalid If-Match',
        errors: [{ path: 'If-Match', message: 'Expected the row version as an entity tag' }],
      });
      // The same request with a readable header reaches the record, which does not exist.
      const absent = await call(route, '"1"');
      expect(absent.status, what).toBe(404);
    }
  });

  /** Where each guarded record kind is read, and the table a seeded one comes from. */
  const READS: Readonly<Record<string, { path: string; table: string }>> = {
    valuation: { path: '/api/v1/valuations/{id}', table: 'mon.valuation' },
    capital_notice: { path: '/api/v1/capital-notices/{id}', table: 'mon.capital_notice' },
    wire_instruction: { path: '/api/v1/wire-instructions/{id}', table: 'mon.wire_instruction' },
    change_request: { path: '/api/v1/change-requests/{id}', table: 'mon.deal_change_request' },
    opportunity: { path: '/api/v1/opportunities/{id}', table: 'deal.opportunity' },
    closing: { path: '/api/v1/closings/{id}', table: 'deal.closing' },
    reporting_package: { path: '/api/v1/report-packages/{id}', table: 'rpt.package' },
  };

  it('tag the record they guard: its read answers the row version as the ETag a command may carry back', async () => {
    expect(Object.keys(READS).sort()).toEqual([...new Set(guarded.map((r) => r.ifMatch))].sort());
    for (const [kind, read] of Object.entries(READS)) {
      const ids = await h.runtime.db.query<{ id: string }>(
        `select id from ${read.table} order by id limit 20`,
      );
      let tagged = false;
      for (const { id } of ids) {
        const res = await h
          .http()
          .get(read.path.replace('{id}', id))
          .set('authorization', h.as('operations'));
        if (res.status !== 200) continue; // behind a wall operations is not on
        const body = res.body as { rowVersion: number };
        expect(res.headers.etag, kind).toBe(rowVersionEtag(body.rowVersion));
        // The tag is a concurrency token, not a cache validator: a detail carries child rows the
        // row version does not cover (tasks, items, alerts, open change requests). So a
        // conditional read is answered in full, never 304, and no answer may be stored.
        expect(res.headers['cache-control'], kind).toBe('no-store');
        const again = await h
          .http()
          .get(read.path.replace('{id}', id))
          .set('authorization', h.as('operations'))
          .set('if-none-match', String(res.headers.etag));
        expect(again.status, kind).toBe(200);
        expect((again.body as { rowVersion: number }).rowVersion, kind).toBe(body.rowVersion);
        tagged = true;
        break;
      }
      expect(tagged, kind).toBe(true);
    }
  });

  it('tag every answer of the controllers that read the header, so the tag never lags the record', () => {
    // A handler that answers one of the guarded records hands it to withEtag: as many calls as
    // there are handlers answering a record with a row version in that controller.
    const src = fileURLToPath(new URL('..', import.meta.url));
    for (const file of readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.controller.ts'),
    )) {
      const text = readFileSync(`${src}/${file}`, 'utf8');
      if (!text.includes('ifMatchVersions(')) continue;
      const answers = text.match(
        /\): Promise<(ValuationRow|ValuationDetail|CapitalNoticeControlDetail|TradeTicketRow|WireInstructionDetail|ChangeRequestRow|ChangeRequestDetail|OpportunityDetail|ClosingDetail|ReportPackageDetail)> \{/g,
      );
      expect(text.split('withEtag(').length - 1, file).toBe(answers?.length ?? 0);
    }
  });

  it('are every route whose controller reads the header', () => {
    // A controller reads the header with ifMatchVersions and nothing else: one call per handler.
    const src = fileURLToPath(new URL('..', import.meta.url));
    const calls = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.controller.ts'))
      .map((file) => readFileSync(`${src}/${file}`, 'utf8').split('ifMatchVersions(').length - 1)
      .reduce((sum, n) => sum + n, 0);
    expect(calls).toBe(guarded.length);
    // The header guards one record, and every guarded route is a command or a correction of it.
    for (const route of guarded) {
      expect(route.ifMatch, route.path).toMatch(/^[a-z_]+$/);
      expect(route.idempotent, route.path).toBe(true);
    }
  });
});
