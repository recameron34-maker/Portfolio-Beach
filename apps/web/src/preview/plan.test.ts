import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: the plan is plain JavaScript shared with the build scripts; its shape is declared below
import * as untypedPlan from '../../scripts/preview-plan.mjs';
import {
  analyticsQuery,
  auditQuery,
  capitalNoticeQuery,
  capitalNoticesQuery,
  clientsQuery,
  commitmentsQuery,
  dataDictionaryQuery,
  dataHealthQuery,
  flagsQuery,
  healthReadyQuery,
  investmentPerformanceQuery,
  investmentQuery,
  investmentsQuery,
  meQuery,
  mockUsersQuery,
  sponsorQuery,
  sponsorsQuery,
  taxonomyQuery,
  valuationsQuery,
  vehicleQuery,
  vehiclesQuery,
  wallsQuery,
  watchlistQuery,
  weeklyReportQuery,
} from '../app/queries.js';
import {
  ACTIVE_POSITIONS,
  CREDIT_POSITIONS,
  REALIZED_POSITIONS,
} from '../pages/analytics/constants.js';
import { getKey, isPublicPath, normalizeKey } from './keys.js';
import { NOTICES_PATH, VALUATIONS_PATH } from './state.js';

/** The shape of scripts/preview-plan.mjs, checked by the tests below. */
interface PlanFamily {
  name: string;
  paths: string[];
  recordFirst?: boolean;
}
interface PlanModule {
  ACTIVE_FILTERS: readonly (string | undefined)[];
  INVESTMENT_LIMITS: readonly number[];
  buildPlan: (
    dataset: Record<'investments' | 'vehicles' | 'sponsors' | 'capitalNotices', { id: string }[]>,
    options: { dealTypes: readonly string[] },
  ) => { public: string[]; families: PlanFamily[] };
  dealTypeCodes: (taxonomy: {
    domains: { domain: string; terms: { code: string; active: boolean }[] }[];
  }) => string[];
  keyFor: (credential: string, method: string, path: string) => string;
  normalizeKey: (credential: string, method: string, pathname: string, search: string) => string;
}
const {
  ACTIVE_FILTERS,
  INVESTMENT_LIMITS,
  buildPlan,
  dealTypeCodes,
  keyFor: planKeyFor,
  normalizeKey: planNormalizeKey,
} = untypedPlan as unknown as PlanModule;

const INV = '30000000-0000-4000-8000-000000000001';
const VEH = '30000000-0000-4000-8000-000000000002';
const SPO = '30000000-0000-4000-8000-000000000003';
const NOT = '30000000-0000-4000-8000-000000000004';
const DEAL_TYPES = ['deal_type.co_invest_equity', 'deal_type.private_credit'];

const plan = buildPlan(
  {
    investments: [{ id: INV }],
    vehicles: [{ id: VEH }],
    sponsors: [{ id: SPO }],
    capitalNotices: [{ id: NOT }],
  },
  { dealTypes: DEAL_TYPES },
);
const planned = new Set([
  ...plan.public.map((p) => planKeyFor('', 'GET', p)),
  ...plan.families.flatMap((f) => f.paths.map((p) => planKeyFor('u', 'GET', p))),
]);

/** The path a query option requests, captured at fetch. */
async function pathOf(options: { queryFn?: unknown }): Promise<string> {
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 404, statusText: 'Not Found' }));
  try {
    await (options.queryFn as () => Promise<unknown>)().catch(() => undefined);
    const input = spy.mock.calls[0]?.[0];
    if (input === undefined) throw new Error('the query did not call fetch');
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  } finally {
    spy.mockRestore();
  }
}

const keyOf = (path: string): string => {
  const pathname = new URL(path, 'http://x.invalid').pathname;
  return getKey(isPublicPath(pathname) ? '' : 'u', path);
};

describe('the recording plan', () => {
  it('normalizes keys exactly as the shim does', () => {
    const cases: [string, string, string, string][] = [
      ['u', 'get', '/api/v1/investments', '?limit=100&active=true&dealType=deal_type.x'],
      ['', 'GET', '/health/live', ''],
      ['ops.one', 'post', '/api/v1/valuations', '?b=2&a=1&a=0'],
      ['u', 'GET', '/api/v1/x', '?Zeta=1&alpha=2&beta=a%20b&gamma=%C3%A9'],
    ];
    for (const [c, m, p, s] of cases)
      expect(planNormalizeKey(c, m, p, s)).toBe(normalizeKey(c, m, p, s));
    expect(normalizeKey('u', 'get', '/api/v1/investments', '?limit=100&active=true')).toBe(
      'u|GET /api/v1/investments?active=true&limit=100',
    );
  });

  it('covers every request the query builders send', async () => {
    const options = [
      meQuery,
      mockUsersQuery,
      vehiclesQuery,
      flagsQuery,
      dataHealthQuery,
      dataDictionaryQuery,
      analyticsQuery,
      watchlistQuery,
      weeklyReportQuery,
      commitmentsQuery,
      clientsQuery,
      sponsorsQuery,
      taxonomyQuery,
      wallsQuery,
      healthReadyQuery,
      investmentQuery(INV),
      investmentPerformanceQuery(INV),
      sponsorQuery(SPO),
      vehicleQuery(VEH),
      capitalNoticeQuery(NOT),
      valuationsQuery(),
      valuationsQuery({ investmentId: INV }),
      capitalNoticesQuery(),
      capitalNoticesQuery({ investmentId: INV }),
      auditQuery(),
      auditQuery({ entityId: INV }),
      investmentsQuery(ACTIVE_POSITIONS),
      investmentsQuery(CREDIT_POSITIONS),
      investmentsQuery(REALIZED_POSITIONS),
    ];
    for (const limit of [undefined, ...INVESTMENT_LIMITS])
      for (const dealType of [undefined, ...DEAL_TYPES])
        for (const active of ACTIVE_FILTERS)
          options.push(
            investmentsQuery({ limit, dealType, active: active as 'true' | 'false' | undefined }),
          );
    const missing: string[] = [];
    for (const option of options) {
      const path = await pathOf(option);
      if (!planned.has(keyOf(path))) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  it('records every id for every family that takes one, and the audit trail first', () => {
    const paths = (name: string): string[] =>
      plan.families.find((f) => f.name === name)?.paths ?? [];
    expect(paths('investment detail')).toEqual([`/api/v1/investments/${INV}`]);
    expect(paths('investment performance')).toEqual([`/api/v1/investments/${INV}/performance`]);
    expect(paths('vehicle detail')).toEqual([`/api/v1/vehicles/${VEH}`]);
    expect(paths('sponsor detail')).toEqual([`/api/v1/sponsors/${SPO}`]);
    expect(paths('capital notice detail')).toEqual([`/api/v1/capital-notices/${NOT}`]);
    expect(paths('investment lists')).toHaveLength(
      INVESTMENT_LIMITS.length * (DEAL_TYPES.length + 1) * ACTIVE_FILTERS.length,
    );
    expect(plan.families.filter((f) => f.recordFirst === true).map((f) => f.name)).toEqual([
      'audit trail',
    ]);
    expect(paths('audit trail').every((p) => p.startsWith('/api/v1/audit/events?'))).toBe(true);
  });

  it('records the unfiltered lists the simulation seeds from', () => {
    expect(planned.has(getKey('u', VALUATIONS_PATH))).toBe(true);
    expect(planned.has(getKey('u', NOTICES_PATH))).toBe(true);
  });

  it('takes the active deal-type codes from the taxonomy', () => {
    expect(
      dealTypeCodes({
        domains: [
          { domain: 'sector', terms: [{ code: 'sector.software', active: true }] },
          {
            domain: 'deal_type',
            terms: [
              { code: 'deal_type.a', active: true },
              { code: 'deal_type.b', active: false },
            ],
          },
        ],
      }),
    ).toEqual(['deal_type.a']);
    expect(() => dealTypeCodes({ domains: [] })).toThrow(/deal_type/);
  });
});
