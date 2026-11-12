import { vi } from 'vitest';
import type { ProblemDetails } from '@pb/contracts';

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Fixtures keyed by path, or by path plus query string when a route needs to tell them apart. */
export type MockRoutes = Record<string, MockResponse | ((url: URL) => MockResponse)>;

export const ok = (body: unknown): MockResponse => ({ status: 200, body });

const CODES: Record<number, string> = {
  403: 'forbidden',
  404: 'not-found',
  501: 'not-implemented',
};
const TITLES: Record<number, string> = {
  403: 'Forbidden',
  404: 'Not found',
  501: 'Not implemented',
};

/** An RFC 9457 problem as the API sends it (docs/17 section 3). */
export function problemFixture(status: 403 | 404 | 501, instance: string): ProblemDetails {
  return {
    type: `https://portfolio-beach.example/problems/${CODES[status] ?? 'http'}`,
    title: TITLES[status] ?? 'Error',
    status,
    detail:
      status === 501
        ? 'This endpoint is not implemented yet'
        : status === 403
          ? 'Your role may not read this'
          : 'Not found',
    instance,
    request_id: 'test',
  };
}

export const failing = (status: 403 | 404 | 501, instance: string): MockResponse => ({
  status,
  body: problemFixture(status, instance),
});

/** Answers fetch from the fixtures; a path the routes do not name answers 404. Restore with vi.restoreAllMocks(). */
export function mockApi(routes: MockRoutes): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://test.local');
    const route = routes[url.pathname + url.search] ?? routes[url.pathname];
    const { status, body } =
      route === undefined
        ? failing(404, url.pathname)
        : typeof route === 'function'
          ? route(url)
          : route;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        },
      }),
    );
  });
}
