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
 * The positions whose valuation versions are recorded in detail (GET /valuations/{id}): the first
 * ones by investment number. Every version of the small profile is too many; the simulation
 * builds the detail of any other version from its list row.
 */
export const VALUATION_DETAIL_INVESTMENTS = 10;

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
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every request family for one dataset. `public` paths are recorded once without a credential;
 * each family's paths are recorded for every mock user, `recordFirst` families before the rest.
 */
export function buildPlan(dataset, { dealTypes }) {
  const investmentIds = dataset.investments.map((i) => i.id);
  const detailedInvestments = new Set(
    [...dataset.investments]
      .sort((a, b) => byText(a.investmentNumber ?? '', b.investmentNumber ?? ''))
      .slice(0, VALUATION_DETAIL_INVESTMENTS)
      .map((i) => i.id),
  );
  const valuationIds = (dataset.valuations ?? [])
    .filter((v) => detailedInvestments.has(v.investmentId))
    .map((v) => v.id);
  const idsOf = (rows) => (rows ?? []).map((r) => r.id);
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
      // Intake is not recorded: its files, the weekly values files, the look-through runs and the
      // data exceptions exist only once the simulation stages them, so the shim answers every
      // intake, drop folder, run and exception route itself (src/preview/routes/) over
      // preview/book.json and the bundled samples.
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
      // The document hub, the extraction engine and the monitoring board are simulated in the
      // page (src/preview/routes/documents.ts, extraction.ts, monitoring.ts) over the bundled
      // document set, so the shim answers these reads itself. They are still recorded, for every
      // user, so the recordings hold the API's own empty state (the as-built answer of each list
      // before any index, generation or batch) and the simulation can fall back to it, and the
      // realization outlook keeps the seeded rows and the wall's 404 per credential.
      {
        name: 'document hub',
        paths: [
          withQuery('/api/v1/documents', { limit: LIST_LIMIT }),
          withQuery('/api/v1/documents/review-queue', { limit: LIST_LIMIT }),
          withQuery('/api/v1/expected-documents', { limit: LIST_LIMIT }),
          withQuery('/api/v1/extraction/batches', { limit: LIST_LIMIT }),
          withQuery('/api/v1/extraction/runs', { limit: LIST_LIMIT }),
          '/api/v1/monitoring/board',
        ],
      },
      {
        name: 'investment documents',
        paths: investmentIds.map((id) =>
          withQuery('/api/v1/documents', { investmentId: id, limit: LIST_LIMIT }),
        ),
      },
      {
        name: 'realization outlook',
        paths: investmentIds.map((id) => segment('/api/v1/monitoring/outlook', id)),
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
      // The Phase 3 controls (decision 0013). The simulation seeds its register, tickets, change
      // requests, pipeline and closings from these recordings and answers every read and write
      // itself (src/preview/routes/), so each is recorded for every user: the API's own 403 for a
      // role outside a route and 404 past a wall decide what each credential may see. The wire
      // detail is recorded with its bank details stripped (scripts/build-preview.mjs); the book
      // carries the synthetic details for the simulated reveal.
      {
        name: 'valuation detail',
        paths: valuationIds.map((id) => segment('/api/v1/valuations', id)),
      },
      {
        name: 'trade tickets',
        paths: [
          withQuery('/api/v1/trade-tickets', { limit: LIST_LIMIT }),
          ...idsOf(dataset.tradeTickets).map((id) => segment('/api/v1/trade-tickets', id)),
        ],
      },
      {
        name: 'wire register',
        paths: [
          withQuery('/api/v1/wire-instructions', { limit: LIST_LIMIT }),
          ...idsOf(dataset.wireInstructions).map((id) => segment('/api/v1/wire-instructions', id)),
        ],
      },
      {
        name: 'change requests',
        paths: [
          withQuery('/api/v1/change-requests', { limit: LIST_LIMIT }),
          ...idsOf(dataset.changeRequests).map((id) => segment('/api/v1/change-requests', id)),
        ],
      },
      {
        name: 'pipeline',
        paths: [
          withQuery('/api/v1/opportunities', { limit: LIST_LIMIT }),
          ...idsOf(dataset.opportunities).map((id) => segment('/api/v1/opportunities', id)),
        ],
      },
      {
        name: 'closings',
        paths: idsOf(dataset.closings).map((id) => segment('/api/v1/closings', id)),
      },
    ],
  };
}
