/**
 * Preview mode: the built app runs against responses recorded from the real API over the small
 * synthetic dataset, so a static page can show every screen without a server. Only requests to
 * /api and /health are intercepted; everything else (assets, the recordings file) goes to the
 * network.
 *
 * Order for each request: the credential check (401), the simulated write routes (routes/), the
 * recorded response with this session's simulated changes laid over it (overlay.ts), and finally
 * a 404 problem for anything the recordings do not cover, which is also logged for the probe.
 */
import { Recordings, parseFixtures } from './fixtures.js';
import type { PreviewFixtures } from './fixtures.js';
import { isApiPath, isPublicPath, normalizeKey } from './keys.js';
import { recordMiss, requestFinished, requestStarted } from './monitor.js';
import { overlayRecordedBody } from './overlay.js';
import { problem } from './problems.js';
import { findSimRoute, runSimRoute } from './routes/index.js';
import type { SimContext } from './routes/index.js';
import { createPreviewState, defaultEnv } from './state.js';
import type { PreviewEnv, PreviewState } from './state.js';

export { normalizeKey } from './keys.js';
export type { PreviewFixtures, PreviewUser, RecordedResponse } from './fixtures.js';

export interface PreviewFetchOptions {
  /** Ids and clock for simulated records (tests pass deterministic ones). */
  env?: Partial<PreviewEnv>;
  /** The session state; tests pass one to inspect it. A fresh one by default. */
  state?: PreviewState;
}

function requestUrl(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, window.location.href);
}

export function createPreviewFetch(
  fixtures: PreviewFixtures,
  realFetch: typeof fetch,
  options: PreviewFetchOptions = {},
): typeof fetch {
  const ctx: SimContext = {
    recordings: new Recordings(fixtures),
    state: options.state ?? createPreviewState(),
    env: { ...defaultEnv, ...options.env },
  };
  const known = new Set(fixtures.users.filter((u) => u.roles.length > 0).map((u) => u.externalId));

  async function answer(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const url = requestUrl(input);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const auth = headers.get('authorization') ?? '';
    const credential = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const isPublic = isPublicPath(url.pathname);
    if (!isPublic && !known.has(credential))
      return problem(401, 'unauthenticated', 'Sign in to continue', { instance: url.pathname });

    const sim = isPublic ? undefined : findSimRoute(method, url.pathname);
    if (sim !== undefined) {
      const bodyText = async (): Promise<string> => {
        if (init?.body !== undefined && init.body !== null)
          return typeof init.body === 'string' ? init.body : new Response(init.body).text();
        return input instanceof Request ? input.text() : '';
      };
      return runSimRoute(sim.route, sim.params, { credential, url, headers, bodyText }, ctx);
    }

    const key = normalizeKey(isPublic ? '' : credential, method, url.pathname, url.search);
    const recorded = ctx.recordings.byKey(key);
    if (recorded === undefined) {
      recordMiss(key);
      return problem(404, 'not-found', 'This request is outside the recorded preview', {
        instance: url.pathname,
      });
    }
    const text =
      method === 'GET' && recorded.status === 200 && !isPublic
        ? overlayRecordedBody(url, recorded.text, {
            credential,
            recordings: ctx.recordings,
            state: ctx.state,
          })
        : recorded.text;
    return new Response(text, {
      status: recorded.status,
      headers: { 'content-type': recorded.contentType, 'x-request-id': 'preview' },
    });
  }

  return async (input, init) => {
    const pathname = requestUrl(input).pathname;
    if (!isApiPath(pathname)) return realFetch(input, init);
    requestStarted();
    try {
      return await answer(input, init);
    } catch (error) {
      // A fault in the simulation must show rather than leave a request hanging: it is logged (the
      // probe fails on console errors) and answered as a problem, never with recorded data.
      console.error('preview: the shim could not answer', pathname, error);
      return problem(500, 'internal', 'The preview could not answer this request', {
        instance: pathname,
      });
    } finally {
      requestFinished();
    }
  };
}

/** Loads the recorded fixtures and installs the fetch shim. Called only in preview builds. */
export async function installPreviewShim(fixturesUrl: string): Promise<PreviewFixtures> {
  const realFetch = window.fetch.bind(window);
  const response = await realFetch(fixturesUrl);
  if (!response.ok) throw new Error(`preview fixtures not found at ${fixturesUrl}`);
  const fixtures = parseFixtures(await response.json());
  window.__pbPreviewMisses ??= [];
  window.fetch = createPreviewFetch(fixtures, realFetch);
  return fixtures;
}
