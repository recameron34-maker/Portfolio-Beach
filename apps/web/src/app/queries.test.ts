import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { DEAL_ID, DEAL_PATHS, equityPerformanceFixture } from '../test/fixtures-deal.js';
import { failing, mockApi, ok } from '../test/api-mock.js';
import { retryUnlessUnavailable } from '../lib/unavailable.js';
import {
  capitalNoticeQuery,
  capitalNoticesQuery,
  investmentPerformanceQuery,
  sponsorQuery,
  valuationsQuery,
  vehicleQuery,
} from './queries.js';

/** The paths each read asked for, in order. */
function requested(): string[] {
  return vi.mocked(globalThis.fetch).mock.calls.map(([input]) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://test.local');
    return url.pathname + url.search;
  });
}

describe('query options', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries the workflow reads only when a retry can change the answer', () => {
    for (const q of [
      valuationsQuery(),
      valuationsQuery({ investmentId: 'inv-1' }),
      capitalNoticesQuery(),
      capitalNoticesQuery({ investmentId: 'inv-1' }),
      capitalNoticeQuery('notice-1'),
    ]) {
      expect(q.retry).toBe(retryUnlessUnavailable);
    }
  });

  it('keeps the audited reads fresh for a minute and does not retry them', () => {
    for (const q of [
      investmentPerformanceQuery('inv-1'),
      sponsorQuery('sponsor-1'),
      vehicleQuery('vehicle-1'),
    ]) {
      expect(q.staleTime).toBe(60_000);
      expect(q.retry).toBe(false);
    }
  });

  it('keeps the keys the preview records', () => {
    expect(valuationsQuery().queryKey).toEqual(['valuations', {}]);
    expect(valuationsQuery({ investmentId: 'inv-1' }).queryKey).toEqual([
      'valuations',
      { investmentId: 'inv-1' },
    ]);
    expect(capitalNoticesQuery({ investmentId: 'inv-1' }).queryKey).toEqual([
      'capital-notices',
      { investmentId: 'inv-1' },
    ]);
    expect(capitalNoticeQuery('notice-1').queryKey).toEqual(['capital-notice', 'notice-1']);
    expect(investmentPerformanceQuery('inv-1').queryKey).toEqual([
      'investment-performance',
      'inv-1',
    ]);
    expect(sponsorQuery('sponsor-1').queryKey).toEqual(['sponsor', 'sponsor-1']);
    expect(vehicleQuery('vehicle-1').queryKey).toEqual(['vehicle', 'vehicle-1']);
  });

  it('serves a second visit to a deal tab from the cache, so the API audits one read', async () => {
    mockApi({ [DEAL_PATHS.performance]: ok(equityPerformanceFixture()) });
    const client = new QueryClient();
    const first = await client.fetchQuery(investmentPerformanceQuery(DEAL_ID));
    const second = await client.fetchQuery(investmentPerformanceQuery(DEAL_ID));
    expect(second).toBe(first);
    expect(requested()).toEqual([DEAL_PATHS.performance]);
  });

  it('asks for the same URLs as before', async () => {
    mockApi({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(valuationsQuery({ investmentId: 'inv-1' }))).rejects.toThrow();
    await expect(
      client.fetchQuery(capitalNoticesQuery({ investmentId: 'inv-1' })),
    ).rejects.toThrow();
    await expect(client.fetchQuery(capitalNoticeQuery('notice-1'))).rejects.toThrow();
    expect(requested()).toEqual([
      '/api/v1/valuations?limit=200&investmentId=inv-1',
      '/api/v1/capital-notices?limit=200&investmentId=inv-1',
      '/api/v1/capital-notices/notice-1',
    ]);
  });

  it('does not retry a read the role may not see', async () => {
    mockApi({
      '/api/v1/capital-notices/notice-1': failing(403, '/api/v1/capital-notices/notice-1'),
    });
    const client = new QueryClient();
    await expect(client.fetchQuery(capitalNoticeQuery('notice-1'))).rejects.toThrow();
    expect(requested()).toEqual(['/api/v1/capital-notices/notice-1']);
  });
});
