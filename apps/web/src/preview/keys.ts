/**
 * Request keys: `${credential}|${METHOD} ${pathname}?${sorted query}`. Public routes use an empty
 * credential. Parameters are sorted by name in code point order (every runtime agrees on it) and
 * re-encoded, so the order a page builds them in does not matter. scripts/preview-plan.mjs
 * implements the same rule for the recorder; plan.test.ts keeps the two in step.
 */
export function normalizeKey(
  credential: string,
  method: string,
  pathname: string,
  search: string,
): string {
  const params = new URLSearchParams(search);
  const sorted = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query =
    sorted.length === 0
      ? ''
      : `?${sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
  return `${credential}|${method.toUpperCase()} ${pathname}${query}`;
}

/** Key of a GET for a path that may carry a query string, as the recorder stores it. */
export function getKey(credential: string, path: string): string {
  const url = new URL(path, 'http://preview.invalid');
  return normalizeKey(credential, 'GET', url.pathname, url.search);
}

/** Routes the API serves without a credential (health and the mock sign-in list). */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/api/v1/auth/mock-users' || pathname.startsWith('/health/');
}

/** Only these prefixes are answered from the recordings; everything else is a static asset. */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/health/');
}
