/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript shared by the build scripts; src/preview/plan.test.ts declares and checks its shape */
// The declarative recording plan of the static preview.
//
// scripts/build-preview.mjs records every path below from the real API over the small synthetic
// profile; scripts/probe-preview.mjs and src/preview/plan.test.ts read the same plan. A family is
// one request shape the pages send through the builders in src/app/queries.ts, with the same fixed
// parameters. Ids come from the dataset and the deal-type codes from the seeded taxonomy, so nothing
// is listed by hand. Every per-user family is recorded for every mock user, so the API's own role
// guard and row-level security decide between 200, 403 and 404 for each credential (a viewer
// replays the real 404 for the walled deal and the real 403 for the audit trail).
//
// The API audits reads (SEC-11) with the wall-clock time and a fresh request id. Families marked
// `recordFirst` (the audit trail) are recorded for every user before any audited read, so the
// recorded trail holds only what the seeded database holds, never the recorder's own reads, and
// stays byte-stable from build to build.

/** Page size of the workflow lists and the sponsor directory; must match LIST_LIMIT in src/app/queries.ts. */
export const LIST_LIMIT = 200;
/** Page size of the audit trail (auditQuery in src/app/queries.ts). */
export const AUDIT_LIMIT = 100;
/** Page sizes investmentsQuery sends: the grid default (100) and the position views (200). */
export const INVESTMENT_LIMITS = [100, 200];
/** The active filter: absent (all positions), active only, realized only. */
export const ACTIVE_FILTERS = [undefined, 'true', 'false'];
/** Routes the API serves without a credential; recorded once with an empty credential. */
export const PUBLIC_PATHS = ['/health/live', '/health/ready', '/api/v1/auth/mock-users'];

/**
 * `${credential}|${METHOD} ${pathname}?${sorted query}`. Parameters are sorted by name in code
 * point order (not locale order, so every runtime agrees) and re-encoded, so the order a page
 * builds them in does not matter. src/preview/keys.ts implements the same rule; a unit test keeps
 * the two in step.
 */
export function normalizeKey(credential, method, pathname, search) {
  const params = new URLSearchParams(search);
  const sorted = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query =
    sorted.length === 0
      ? ''
      : `?${sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
  return `${credential}|${method.toUpperCase()} ${pathname}${query}`;
}

/** Key of a path that may carry a query string. */
export function keyFor(credential, method, path) {
  const url = new URL(path, 'http://preview.invalid');
  return normalizeKey(credential, method, url.pathname, url.search);
}

/** A path with the given parameters; undefined or empty values are left out, as the builders do. */
export function withQuery(pathname, params = {}) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(name, String(value));
  }
  const query = search.toString();
  return query === '' ? pathname : `${pathname}?${query}`;
}

/** Active deal-type codes from a recorded GET /api/v1/taxonomy body. */
export function dealTypeCodes(taxonomy) {
  const domain = taxonomy.domains.find((d) => d.domain === 'deal_type');
  if (domain === undefined) throw new Error('the taxonomy has no deal_type domain');
  const codes = domain.terms.filter((t) => t.active).map((t) => t.code);
  if (codes.length === 0) throw new Error('the taxonomy lists no active deal types');
  return codes;
}

const segment = (prefix, id, suffix = '') => `${prefix}/${encodeURIComponent(id)}${suffix}`;

/**
 * Every request family for one dataset. `public` paths are recorded once without a credential;
 * each family's paths are recorded for every mock user, `recordFirst` families before the rest.
 */
export function buildPlan(dataset, { dealTypes }) {
  const investmentIds = dataset.investments.map((i) => i.id);
  const investmentLists = [];
  for (const limit of INVESTMENT_LIMITS) {
    for (const dealType of [undefined, ...dealTypes]) {
      for (const active of ACTIVE_FILTERS) {
        investmentLists.push(withQuery('/api/v1/investments', { limit, dealType, active }));
      }
    }
  }
  return {
    public: [...PUBLIC_PATHS],
    families: [
      {
        name: 'session and reference data',
        paths: [
          '/api/v1/auth/me',
          '/api/v1/flags',
          '/api/v1/taxonomy',
          '/api/v1/walls',
          '/api/v1/data-health',
          '/api/v1/data-dictionary',
        ],
      },
      {
        name: 'portfolio aggregates',
        paths: [
          '/api/v1/vehicles',
          withQuery('/api/v1/sponsors', { limit: LIST_LIMIT }),
          '/api/v1/analytics/summary',
          '/api/v1/monitoring/watchlist',
          '/api/v1/reports/weekly',
          '/api/v1/commitments',
          '/api/v1/clients',
        ],
      },
      {
        name: 'audit trail',
        recordFirst: true,
        paths: [
          withQuery('/api/v1/audit/events', { limit: AUDIT_LIMIT }),
          ...investmentIds.map((id) =>
            withQuery('/api/v1/audit/events', { entityId: id, limit: AUDIT_LIMIT }),
          ),
        ],
      },
      {
        name: 'workflow lists',
        paths: [
          withQuery('/api/v1/valuations', { limit: LIST_LIMIT }),
          withQuery('/api/v1/capital-notices', { limit: LIST_LIMIT }),
        ],
      },
      { name: 'investment lists', paths: investmentLists },
      {
        name: 'investment detail',
        paths: investmentIds.map((id) => segment('/api/v1/investments', id)),
      },
      {
        name: 'investment performance',
        paths: investmentIds.map((id) => segment('/api/v1/investments', id, '/performance')),
      },
      {
        name: 'investment valuations',
        paths: investmentIds.map((id) =>
          withQuery('/api/v1/valuations', { investmentId: id, limit: LIST_LIMIT }),
        ),
      },
      {
        name: 'investment capital notices',
        paths: investmentIds.map((id) =>
          withQuery('/api/v1/capital-notices', { investmentId: id, limit: LIST_LIMIT }),
        ),
      },
      {
        name: 'vehicle detail',
        paths: dataset.vehicles.map((v) => segment('/api/v1/vehicles', v.id)),
      },
      {
        name: 'sponsor detail',
        paths: dataset.sponsors.map((s) => segment('/api/v1/sponsors', s.id)),
      },
      {
        name: 'capital notice detail',
        paths: dataset.capitalNotices.map((n) => segment('/api/v1/capital-notices', n.id)),
      },
    ],
  };
}
