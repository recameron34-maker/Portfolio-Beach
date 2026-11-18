import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { IDEMPOTENCY_KEY_HEADER } from '@pb/contracts';
import type { ProblemDetails } from '@pb/contracts';
import { ApiError } from '../../../api/client.js';
import { clearCredential, setCredential } from '../../../app/session.js';
import {
  CLIENT_ID,
  generatedDetailFixture,
  packageDetailFixture,
  packageListFixture,
  PKG_ID,
  PKG_PERIOD,
} from '../../../test/fixtures-packages.js';
import {
  describePackageError,
  PACKAGE_KEYS,
  PACKAGE_READS,
  reportPackageQuery,
  reportPackagesQuery,
  usePackageCommand,
  useStartPackage,
} from './api.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The 412 the API answers a command whose If-Match names a row version that has moved on. */
const STALE: ProblemDetails = {
  type: 'https://portfolio-beach.example/problems/precondition-failed',
  title: 'Precondition failed',
  status: 412,
  detail: 'The record changed since it was read',
  request_id: 'test',
};

/** Renders a hook inside a query client and reports the keys it invalidates. */
function harness<T>(hook: () => T): {
  result: { current: T };
  client: QueryClient;
  keys: () => string[];
} {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  const { result } = renderHook(hook, {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
  return {
    result,
    client,
    keys: () => spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey)),
  };
}

describe('reporting package reads', () => {
  beforeEach(() => setCredential('ir.one'));
  afterEach(() => {
    vi.restoreAllMocks();
    clearCredential();
  });

  it('builds each read with its fixed key', () => {
    expect(reportPackagesQuery().queryKey).toEqual(['report-packages']);
    expect(reportPackageQuery(PKG_ID.draft).queryKey).toEqual(['report-package', PKG_ID.draft]);
  });

  it('asks for the whole list with no parameter, and for one package by its id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, packageListFixture()))
      .mockResolvedValueOnce(json(200, generatedDetailFixture()));
    const client = new QueryClient();
    const list = await client.fetchQuery(reportPackagesQuery());
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/v1/report-packages');
    expect(list.items).toHaveLength(5);
    const detail = await client.fetchQuery(reportPackageQuery(PKG_ID.failed));
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(`/api/v1/report-packages/${PKG_ID.failed}`);
    expect(detail.changeLog).toHaveLength(1);
  });

  it('does not ask twice for a package the caller cannot see', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        json(404, {
          type: 'https://portfolio-beach.example/problems/not-found',
          title: 'Not found',
          status: 404,
          detail: 'Reporting package not found',
          request_id: 'test',
        }),
      ),
    );
    await expect(new QueryClient().fetchQuery(reportPackageQuery(PKG_ID.draft))).rejects.toThrow(
      ApiError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('reporting package writes', () => {
  beforeEach(() => setCredential('ir.one'));
  afterEach(() => {
    vi.restoreAllMocks();
    clearCredential();
  });

  it('starts a package under an idempotency key, opens its page on the answer and refreshes the list and the audit trail', async () => {
    const created = packageDetailFixture({ id: PKG_ID.draft });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(201, created));
    const { result, client, keys } = harness(() => useStartPackage());
    const body = {
      clientId: CLIENT_ID.alpha,
      periodEnd: PKG_PERIOD,
      basis: 'net',
      label: 'preliminary',
    } as const;
    result.current.mutate(body);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/report-packages');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(body));
    const headers = new Headers(init.headers);
    expect(headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(/\S{8,}/);
    // Starting carries no row version: there is no row yet.
    expect(headers.has('if-match')).toBe(false);
    expect(client.getQueryData(['report-package', PKG_ID.draft])).toEqual(created);
    expect(keys().sort()).toEqual(PACKAGE_KEYS.map((key) => JSON.stringify(key)).sort());
    for (const key of ['report-packages', 'report-package', 'audit'])
      expect(keys()).toContain(JSON.stringify([key]));
  });

  it('sends a command with the row version the person was shown as If-Match, and keeps the answer', async () => {
    const answer = generatedDetailFixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, answer));
    const { result, client, keys } = harness(() => usePackageCommand());
    result.current.mutate({ id: PKG_ID.failed, rowVersion: 1, body: { command: 'generate' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/report-packages/${PKG_ID.failed}/commands`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ command: 'generate' }));
    const headers = new Headers(init.headers);
    expect(headers.get('if-match')).toBe('"1"');
    expect(headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(/\S{8,}/);
    // A generation is two writes, so the answer is two row versions on: the page holds the new one.
    expect(client.getQueryData(['report-package', PKG_ID.failed])).toEqual(answer);
    expect(result.current.data?.rowVersion).toBe(3);
    for (const key of ['report-packages', 'report-package', 'audit'])
      expect(keys()).toContain(JSON.stringify([key]));
  });

  it('keeps nothing of a refused command, and reads the package and the list again', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(412, STALE));
    const { result, client, keys } = harness(() => usePackageCommand());
    result.current.mutate({ id: PKG_ID.failed, rowVersion: 2, body: { command: 'submit' } });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(412);
    // The answer of a refusal is not a package: nothing is put in its place.
    expect(client.getQueryData(['report-package', PKG_ID.failed])).toBeUndefined();
    // What refuses a command is most often what somebody else did meanwhile, so the page reads
    // where the package stands now. Nothing was written, so the audit trail is left alone.
    expect(keys().sort()).toEqual(PACKAGE_READS.map((key) => JSON.stringify(key)).sort());
    expect(keys()).not.toContain(JSON.stringify(['audit']));
  });
});

describe('a refused package command in words', () => {
  const refusal = (status: number, detail: string, code = 'workflow-precondition'): ApiError =>
    new ApiError({
      type: `https://portfolio-beach.example/problems/${code}`,
      title: 'Refused',
      status,
      detail,
      request_id: 'test',
    });

  it('says of a stale row version that somebody moved the package first', () => {
    expect(describePackageError(new ApiError(STALE))).toBe(
      'Someone changed this package first, so nothing was done. The page now shows it as it stands.',
    );
  });

  it('shows the rule behind a refusal without the control it cites', () => {
    // The API words the preparer's refusal with its control number; the page drops the number.
    expect(
      describePackageError(
        refusal(422, 'reporting_package: the package preparer cannot approve it (SEC-5.6)'),
      ),
    ).toBe('Blocked by a rule. The package preparer cannot approve it');
    expect(
      describePackageError(
        refusal(
          403,
          'reporting_package: overrideQa from QAFailed requires one of: approver',
          'forbidden',
        ),
      ),
    ).toBe('Your role cannot do this. Override QA from QA failed requires one of: approver');
    expect(
      describePackageError(
        refusal(
          409,
          'reporting_package: submit is not allowed from Released',
          'workflow-transition',
        ),
      ),
    ).toBe('Not allowed from the current state. Submit is not allowed from Released');
    expect(describePackageError(new Error('Failed to fetch'))).toBe('Failed to fetch');
  });
});
