import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { problemDetails } from '@pb/contracts';
import { configDecimal, configInteger } from '../common/definitions.js';
import { ProblemError } from '../common/problem.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const MISSING_TOLERANCE =
  'config/definitions.json is missing a usable priorYearPeriodEndToleranceDays';

describe('config readers: a missing or malformed key is a configuration problem', () => {
  const problemOf = (read: () => unknown): ProblemError => {
    try {
      read();
    } catch (error) {
      if (error instanceof ProblemError) return error;
      throw error;
    }
    throw new Error('expected a configuration problem');
  };

  it('reads whole numbers of zero or more and names the key otherwise', () => {
    expect(configInteger(7, 'k')).toBe(7);
    expect(configInteger(0, 'k')).toBe(0);
    for (const bad of [undefined, null, -1, 7.5, '7', Number.NaN]) {
      const problem = problemOf(() => configInteger(bad, 'priorYearPeriodEndToleranceDays'));
      expect(problem.getStatus()).toBe(500);
      expect(problem.code).toBe('configuration');
      expect(problem.message).toBe(MISSING_TOLERANCE);
    }
  });

  it('reads decimals from numbers and decimal strings, never from anything else', () => {
    expect(configDecimal(6, 'k').toString()).toBe('6');
    expect(configDecimal(0.15, 'k').toString()).toBe('0.15');
    expect(configDecimal('0.2', 'k').toString()).toBe('0.2');
    for (const bad of [undefined, null, '1e3', 'abc', Number.POSITIVE_INFINITY, {}]) {
      expect(problemOf(() => configDecimal(bad, 'watchlist.markdownPct')).code).toBe(
        'configuration',
      );
    }
  });
});

describe('an API whose config lacks priorYearPeriodEndToleranceDays', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ withoutDefinitions: ['priorYearPeriodEndToleranceDays'] });
  });
  afterAll(async () => {
    await h.close();
  });

  const investmentId = (): string => h.dataset.investments[0]!.id;

  it('answers the investment detail with a 500 configuration problem and audits nothing', async () => {
    expect(h.runtime.definitions.priorYearPeriodEndToleranceDays).toBeUndefined();
    const res = await h
      .http()
      .get(`/api/v1/investments/${investmentId()}?asOf=${h.dataset.asOf}`)
      .set('authorization', h.as('viewer'))
      .set('x-request-id', 'req-config-detail-1')
      .expect(500);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe('https://portfolio-beach.example/problems/configuration');
    expect(problem.status).toBe(500);
    expect(problem.detail).toBe(MISSING_TOLERANCE);
    expect(problem.request_id).toBe('req-config-detail-1');
    // Nothing was disclosed, so no sensitive read is on record.
    const audit = await h.runtime.db.query<{ n: number }>(
      "select count(*)::int as n from audit.event where request_id = 'req-config-detail-1'",
    );
    expect(audit[0]?.n).toBe(0);
  });

  it('fails every read the tolerance drives, never with a default, and serves the rest', async () => {
    const get = (path: string): ReturnType<ReturnType<Harness['http']>['get']> =>
      h.http().get(path).set('authorization', h.as('viewer'));
    const vehicleId = h.dataset.investments[0]!.vehicleId;
    for (const path of [
      `/api/v1/investments/${investmentId()}/performance`,
      `/api/v1/vehicles/${vehicleId}`,
      '/api/v1/analytics/summary',
      '/api/v1/monitoring/watchlist',
    ]) {
      const res = await get(path).expect(500);
      expect(problemDetails.parse(res.body).detail, path).toBe(MISSING_TOLERANCE);
    }
    // The grid needs no tolerance and still answers; walls and 404s are unaffected.
    await get('/api/v1/investments?limit=5').expect(200);
    await get('/api/v1/investments/not-a-uuid').expect(404);
  });
});
