import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ApiError } from '../../api/client.js';
import { describeActionError } from '../../app/mutations.js';
import { clearCredential, setCredential } from '../../app/session.js';
import {
  changeRequestRowFixture,
  CR_ID,
  POSITION_ID,
  quarterEndCheckFixture,
  USER_ID,
  VAL_ID,
  valuationRowFixture,
} from '../../test/fixtures-valuations.js';
import {
  changeRequestQuery,
  changeRequestsQuery,
  describeValuationError,
  isVersionTaken,
  useChangeRequestCommand,
  useCreateChangeRequest,
  useEditValuation,
  useQuarterEndCheck,
  useRefreshIfVersionTaken,
  useValuationBatchCommand,
  valuationDetailQuery,
} from './api.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Renders a hook inside a fresh query client and reports the keys it invalidates. */
function harness<T>(hook: () => T): { result: { current: T }; keys: () => string[] } {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  const { result } = renderHook(hook, {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
  return {
    result,
    keys: () => spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey)),
  };
}

describe('valuation and change request reads', () => {
  it('builds each read with its fixed key and request shape', () => {
    expect(valuationDetailQuery(VAL_ID.locked).queryKey).toEqual(['valuation', VAL_ID.locked]);
    expect(changeRequestsQuery().queryKey).toEqual(['change-requests', {}]);
    expect(
      changeRequestsQuery({ investmentId: POSITION_ID.meridian, state: 'Routed' }).queryKey,
    ).toEqual(['change-requests', { investmentId: POSITION_ID.meridian, state: 'Routed' }]);
    expect(changeRequestQuery(CR_ID.routed).queryKey).toEqual(['change-request', CR_ID.routed]);
  });

  it('sends the filters in a fixed order after the limit', async () => {
    setCredential('ops.one');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json(200, { items: [], nextCursor: null }));
    await new QueryClient().fetchQuery(
      changeRequestsQuery({ state: 'Applied', investmentId: POSITION_ID.cobalt }),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      `/api/v1/change-requests?limit=200&investmentId=${POSITION_ID.cobalt}&state=Applied`,
    );
    clearCredential();
  });
});

describe('valuation and change request writes', () => {
  beforeEach(() => setCredential('ops.one'));
  afterEach(() => {
    vi.restoreAllMocks();
    clearCredential();
  });

  it('posts a batch command and refreshes every valuation read', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        json(200, { results: [{ id: VAL_ID.prepared, ok: true, state: 'DealTeamApproved' }] }),
      );
    const { result, keys } = harness(() => useValuationBatchCommand());
    result.current.mutate({ command: 'dealTeamApprove', ids: [VAL_ID.prepared] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/valuations/batch-commands');
    expect(init.body).toBe(JSON.stringify({ command: 'dealTeamApprove', ids: [VAL_ID.prepared] }));
    for (const key of ['valuations', 'valuation', 'investment', 'weekly-report', 'audit'])
      expect(keys()).toContain(JSON.stringify([key]));
  });

  it('patches a Draft with the row version it was read at as If-Match, and refreshes every valuation read (VAL-1)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        json(200, valuationRowFixture({ id: VAL_ID.draft, state: 'Draft', rowVersion: 5 })),
      );
    const { result, keys } = harness(() => useEditValuation());
    const body = { fairValue: '28000000.50', inputs: { multiple: 12 } };
    result.current.mutate({ id: VAL_ID.draft, body, rowVersion: 4 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/valuations/${VAL_ID.draft}`);
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify(body));
    expect(new Headers(init.headers).get('if-match')).toBe('"4"');
    expect(result.current.data?.rowVersion).toBe(5);
    for (const key of ['valuations', 'valuation', 'investment', 'audit'])
      expect(keys()).toContain(JSON.stringify([key]));
  });

  it('tells the lost race for a version number from every other refusal, and refreshes the list only then', () => {
    const refusal = (status: number, detail: string): ApiError =>
      new ApiError({
        type: 'https://portfolio-beach.example/problems/workflow-transition',
        title: 'Conflict',
        status,
        detail,
        request_id: 'test',
      });
    const taken = refusal(409, 'valuation: another version was created first; open the list again');
    const notAllowed = refusal(409, 'valuation: lock is not allowed from Draft');
    expect(isVersionTaken(taken)).toBe(true);
    expect(isVersionTaken(notAllowed)).toBe(false);
    expect(isVersionTaken(new Error('offline'))).toBe(false);
    expect(describeValuationError(taken)).toBe(
      'Another version was created for this position and period first, so nothing was saved. The list is refreshed: continue with the version it shows.',
    );
    // Every other refusal keeps the words the rest of the app uses.
    expect(describeValuationError(notAllowed)).toBe(describeActionError(notAllowed));
    const { result, keys } = harness(() => useRefreshIfVersionTaken());
    result.current(notAllowed);
    expect(keys()).toEqual([]);
    result.current(taken);
    expect(keys()).toContain(JSON.stringify(['valuations']));
  });

  it('submits the form, parks the answer under its id and refreshes the queue and the version screen', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(201, changeRequestRowFixture()));
    const { result, keys } = harness(() => useCreateChangeRequest());
    result.current.mutate({
      investmentId: POSITION_ID.meridian,
      changeType: 'change_type.add_on_acquisition',
      effectiveDate: '2025-05-15',
      summary: 'Add-on acquisition of a regional competitor closed',
      details: {},
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    for (const key of ['change-requests', 'change-request', 'valuation', 'audit'])
      expect(keys()).toContain(JSON.stringify([key]));
  });

  it('posts a command body as given and refreshes the same reads', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json(200, changeRequestRowFixture({ state: 'Routed' })));
    const { result, keys } = harness(() => useChangeRequestCommand());
    result.current.mutate({
      id: CR_ID.submitted,
      body: { command: 'route', ownerId: USER_ID.ops },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/change-requests/${CR_ID.submitted}/commands`);
    expect(init.body).toBe(JSON.stringify({ command: 'route', ownerId: USER_ID.ops }));
    expect(keys()).toContain(JSON.stringify(['change-requests']));
  });

  it('runs the quarter-end check and refreshes the exceptions that it opens', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json(200, quarterEndCheckFixture()));
    const { result, keys } = harness(() => useQuarterEndCheck());
    result.current.mutate({ periodEnd: '2025-06-30' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/v1/change-requests/quarter-end-check');
    for (const key of ['change-requests', 'data-exceptions', 'data-health', 'audit'])
      expect(keys()).toContain(JSON.stringify([key]));
  });
});
