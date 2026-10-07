/**
 * Preview mode: the built app runs against responses recorded from the real API over the small
 * synthetic dataset, so a static page can show every screen without a server. Only requests to
 * /api and /health are intercepted. Writes are simulated in memory for the page session.
 *
 * Keys are `${credential}|${METHOD} ${path}?${sorted query}`; the recorder in scripts/build-preview.mjs
 * uses the same normalization.
 */
export interface RecordedResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface PreviewFixtures {
  generatedFrom: string;
  asOf: string;
  users: { externalId: string; roles: string[] }[];
  responses: Record<string, RecordedResponse>;
}

export function normalizeKey(
  credential: string,
  method: string,
  pathname: string,
  search: string,
): string {
  const params = new URLSearchParams(search);
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const query =
    sorted.length === 0
      ? ''
      : `?${sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
  return `${credential}|${method.toUpperCase()} ${pathname}${query}`;
}

function problem(status: number, code: string, title: string, detail: string): Response {
  const body = JSON.stringify({
    type: `https://portfolio-beach.example/problems/${code}`,
    title,
    status,
    detail,
    request_id: 'preview',
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/problem+json', 'x-request-id': 'preview' },
  });
}

export function createPreviewFetch(
  fixtures: PreviewFixtures,
  realFetch: typeof fetch,
): typeof fetch {
  const flagOverrides = new Map<string, boolean>();
  const rolesOf = (credential: string): string[] =>
    fixtures.users.find((u) => u.externalId === credential)?.roles ?? [];

  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/health/'))
      return realFetch(input, init);

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const auth = headers.get('authorization') ?? '';
    const credential = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const bodyText = async (): Promise<string> => {
      if (init?.body !== undefined && init.body !== null) {
        return typeof init.body === 'string' ? init.body : new Response(init.body).text();
      }
      return input instanceof Request ? input.text() : '';
    };
    const isPublic =
      url.pathname === '/api/v1/auth/mock-users' || url.pathname.startsWith('/health/');
    if (!isPublic && (credential === '' || rolesOf(credential).length === 0)) {
      return problem(401, 'unauthenticated', 'Authentication required', 'Sign in to continue');
    }

    // Simulated write: feature flags (platform admins only, reason required), kept for this page session.
    const flagMatch = /^\/api\/v1\/flags\/([a-z0-9_.]{3,64})$/.exec(url.pathname);
    if (method === 'PATCH' && flagMatch !== null) {
      if (!rolesOf(credential).includes('platform_admin'))
        return problem(
          403,
          'forbidden',
          'Forbidden',
          'This operation needs a role you do not hold',
        );
      let payload: { enabled?: unknown; reason?: unknown } = {};
      try {
        payload = JSON.parse(await bodyText()) as typeof payload;
      } catch {
        return problem(400, 'validation', 'Bad request', 'Invalid flag update');
      }
      if (
        typeof payload.enabled !== 'boolean' ||
        typeof payload.reason !== 'string' ||
        payload.reason.length < 3
      ) {
        return problem(400, 'validation', 'Bad request', 'Invalid flag update');
      }
      const list = fixtures.responses[normalizeKey(credential, 'GET', '/api/v1/flags', '')];
      const flags =
        list === undefined
          ? []
          : (
              JSON.parse(list.body) as {
                flags: { key: string; enabled: boolean; description: string }[];
              }
            ).flags;
      const flag = flags.find((f) => f.key === flagMatch[1]);
      if (flag === undefined) return problem(404, 'not-found', 'Not found', 'Unknown flag');
      flagOverrides.set(flag.key, payload.enabled);
      return new Response(JSON.stringify({ ...flag, enabled: payload.enabled }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'preview' },
      });
    }

    const key = normalizeKey(isPublic ? '' : credential, method, url.pathname, url.search);
    const recorded = fixtures.responses[key];
    if (recorded === undefined) {
      return problem(404, 'not-found', 'Not found', 'This request is outside the recorded preview');
    }
    let body = recorded.body;
    if (url.pathname === '/api/v1/flags' && method === 'GET' && flagOverrides.size > 0) {
      const parsed = JSON.parse(body) as {
        flags: { key: string; enabled: boolean; description: string }[];
      };
      body = JSON.stringify({
        flags: parsed.flags.map((f) =>
          flagOverrides.has(f.key) ? { ...f, enabled: flagOverrides.get(f.key) === true } : f,
        ),
      });
    }
    return new Response(body, {
      status: recorded.status,
      headers: { 'content-type': recorded.contentType, 'x-request-id': 'preview' },
    });
  };
}

/** Loads the recorded fixtures and installs the fetch shim. Called only in preview builds. */
export async function installPreviewShim(fixturesUrl: string): Promise<PreviewFixtures> {
  const realFetch = window.fetch.bind(window);
  const response = await realFetch(fixturesUrl);
  if (!response.ok) throw new Error(`preview fixtures not found at ${fixturesUrl}`);
  const fixtures = (await response.json()) as PreviewFixtures;
  window.fetch = createPreviewFetch(fixtures, realFetch);
  return fixtures;
}
