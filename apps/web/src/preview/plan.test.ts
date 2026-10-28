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
  documentPagesQuery,
  documentQuery,
  documentsOfInvestmentQuery,
  documentsQuery,
  expectedDocumentsQuery,
  extractionBatchesQuery,
  extractionRunQuery,
  extractionRunsQuery,
  flagsQuery,
  healthReadyQuery,
  intakeExportsQuery,
  intakeFilesQuery,
  investmentPerformanceQuery,
  investmentQuery,
  investmentsQuery,
  meQuery,
  mockUsersQuery,
  monitoringBoardQuery,
  realizationOutlookQuery,
  reviewQueueQuery,
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
import { CREDIT_POSITIONS, REALIZED_POSITIONS } from '../pages/analytics/constants.js';
import { exceptionQuery, exceptionsQuery } from '../pages/exceptions/exceptions-queries.js';
import { opsDropDropsQuery } from '../pages/intake/ops-drop.js';
import {
  lookthroughRunQuery,
  lookthroughRunsQuery,
} from '../pages/lookthrough/lookthrough-queries.js';
import { weeklyDropsQuery, weeklyFileQuery, weeklyFilesQuery } from '../pages/weekly/queries.js';
import { getKey, isPublicPath, normalizeKey } from './keys.js';
import { SIM_ROUTES } from './routes/index.js';
import {
  CHANGE_REQUESTS_PATH,
  NOTICES_PATH,
  OPPORTUNITIES_PATH,
  TICKETS_PATH,
  VALUATIONS_PATH,
  WIRES_PATH,
} from './state.js';

/** The shape of scripts/preview-plan.mjs, checked by the tests below. */
interface PlanFamily {
  name: string;
  paths: string[];
  recordFirst?: boolean;
}
interface PlanModule {
  ACTIVE_FILTERS: readonly (string | undefined)[];
  INVESTMENT_LIMITS: readonly number[];
  VALUATION_DETAIL_INVESTMENTS: number;
  buildPlan: (
    dataset: Record<'vehicles' | 'sponsors' | 'capitalNotices', { id: string }[]> & {
      investments: { id: string; investmentNumber: string }[];
      valuations?: { id: string; investmentId: string }[];
      wireInstructions?: { id: string }[];
      tradeTickets?: { id: string }[];
      changeRequests?: { id: string }[];
      opportunities?: { id: string }[];
      closings?: { id: string }[];
    },
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
  VALUATION_DETAIL_INVESTMENTS,
  buildPlan,
  dealTypeCodes,
  keyFor: planKeyFor,
  normalizeKey: planNormalizeKey,
} = untypedPlan as unknown as PlanModule;

const INV = '30000000-0000-4000-8000-000000000001';
const VEH = '30000000-0000-4000-8000-000000000002';
const SPO = '30000000-0000-4000-8000-000000000003';
const NOT = '30000000-0000-4000-8000-000000000004';
const VAL = '30000000-0000-4000-8000-000000000005';
const WIRE = '30000000-0000-4000-8000-000000000006';
const TICKET = '30000000-0000-4000-8000-000000000007';
const REQUEST = '30000000-0000-4000-8000-000000000008';
const OPP = '30000000-0000-4000-8000-000000000009';
const CLOSING = '30000000-0000-4000-8000-000000000010';
/** A position past the first ten by number: its versions are not recorded in detail. */
const LATER = '30000000-0000-4000-8000-000000000011';
const DEAL_TYPES = ['deal_type.co_invest_equity', 'deal_type.private_credit'];

/** The positions of the planned dataset: the first, nine more inside the detailed ten, and one past them. */
const INVESTMENTS = [
  { id: INV, investmentNumber: 'INV-0001' },
  ...Array.from({ length: VALUATION_DETAIL_INVESTMENTS - 1 }, (_, i) => ({
    id: `30000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`,
    investmentNumber: `INV-${String(i + 2).padStart(4, '0')}`,
  })),
  { id: LATER, investmentNumber: 'INV-0099' },
];
const plan = buildPlan(
  {
    investments: INVESTMENTS,
    vehicles: [{ id: VEH }],
    sponsors: [{ id: SPO }],
    capitalNotices: [{ id: NOT }],
    valuations: [
      { id: VAL, investmentId: INV },
      { id: '30000000-0000-4000-8000-000000000012', investmentId: LATER },
    ],
    wireInstructions: [{ id: WIRE }],
    tradeTickets: [{ id: TICKET }],
    changeRequests: [{ id: REQUEST }],
    opportunities: [{ id: OPP }],
    closings: [{ id: CLOSING }],
  },
  { dealTypes: DEAL_TYPES },
);
const planned = new Set([
  ...plan.public.map((p) => planKeyFor('', 'GET', p)),
  ...plan.families.flatMap((f) => f.paths.map((p) => planKeyFor('u', 'GET', p))),
]);

/** The path a query option requests, captured at fetch (an infinite query reads its first page). */
async function pathOf(options: { queryFn?: unknown }): Promise<string> {
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 404, statusText: 'Not Found' }));
  try {
    await (options.queryFn as (context: { pageParam: null }) => Promise<unknown>)({
      pageParam: null,
    }).catch(() => undefined);
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

/** A GET the shim answers itself (records that exist only in the simulation) needs no recording. */
const simulatedGet = (path: string): boolean => {
  const pathname = new URL(path, 'http://x.invalid').pathname;
  return SIM_ROUTES.some((r) => r.method === 'GET' && r.match(pathname) !== null);
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
      intakeFilesQuery,
      intakeExportsQuery,
      weeklyDropsQuery,
      weeklyFilesQuery(),
      weeklyFileQuery(INV),
      lookthroughRunsQuery,
      lookthroughRunQuery(INV),
      exceptionsQuery(),
      exceptionQuery(INV),
      opsDropDropsQuery,
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
      investmentsQuery(CREDIT_POSITIONS),
      investmentsQuery(REALIZED_POSITIONS),
      documentsQuery(),
      documentsQuery({ q: 'report', reviewStatus: 'NeedsReview' }),
      documentsOfInvestmentQuery(INV),
      documentQuery(INV),
      documentPagesQuery(INV),
      reviewQueueQuery,
      expectedDocumentsQuery(),
      expectedDocumentsQuery({ periodEnd: '2025-06-30', status: 'late', asOf: '2025-09-30' }),
      extractionBatchesQuery,
      extractionRunsQuery(),
      extractionRunsQuery({ state: 'Succeeded' }),
      extractionRunQuery(INV),
      monitoringBoardQuery(),
      monitoringBoardQuery({ periodEnd: '2025-06-30', asOf: '2025-09-30' }),
      realizationOutlookQuery(INV),
    ];
    for (const limit of [undefined, ...INVESTMENT_LIMITS])
      for (const dealType of [undefined, ...DEAL_TYPES])
        for (const active of ACTIVE_FILTERS)
          options.push(
            investmentsQuery({ limit, dealType, active: active as 'true' | 'false' | undefined }),
          );
    const missing: string[] = [];
    const simulated: string[] = [];
    for (const option of options) {
      const path = await pathOf(option);
      if (simulatedGet(path)) simulated.push(path);
      else if (!planned.has(keyOf(path))) missing.push(path);
    }
    expect(missing).toEqual([]);
    // Intake files, reconcile runs and data exceptions exist only once the simulation stages
    // them, so the shim answers those reads (every source, every drop folder, the queue); the
    // document hub, the extraction engine and the monitoring board are simulated the same way
    // over the bundled document set.
    expect(simulated).toEqual([
      '/api/v1/intake/files?limit=200',
      '/api/v1/intake/accounting/exports',
      '/api/v1/intake/weekly/drops',
      '/api/v1/intake/files?limit=200&source=weekly',
      `/api/v1/intake/weekly/files/${INV}`,
      '/api/v1/intake/files?limit=200&source=lookthrough',
      `/api/v1/intake/lookthrough/runs/${INV}`,
      '/api/v1/data-exceptions?limit=200',
      `/api/v1/data-exceptions/${INV}`,
      '/api/v1/intake/ops-drop/drops',
      // The one-pager is simulated too, so a position a simulated close created has one; every
      // recorded position still answers from its recording through the same route.
      `/api/v1/investments/${INV}`,
      '/api/v1/documents?limit=200',
      '/api/v1/documents?limit=200&q=report&reviewStatus=NeedsReview',
      `/api/v1/documents?limit=200&investmentId=${INV}`,
      `/api/v1/documents/${INV}`,
      `/api/v1/documents/${INV}/pages`,
      '/api/v1/documents/review-queue?limit=200',
      '/api/v1/expected-documents?limit=200',
      '/api/v1/expected-documents?limit=200&periodEnd=2025-06-30&status=late&asOf=2025-09-30',
      '/api/v1/extraction/batches?limit=200',
      '/api/v1/extraction/runs?limit=200',
      '/api/v1/extraction/runs?limit=200&state=Succeeded',
      `/api/v1/extraction/runs/${INV}`,
      '/api/v1/monitoring/board',
      '/api/v1/monitoring/board?asOf=2025-09-30&periodEnd=2025-06-30',
      `/api/v1/monitoring/outlook/${INV}`,
    ]);
    // The hub's empty state, each investment's documents and its outlook are recorded all the
    // same, so the recordings hold the API's own answer before the simulation adds anything.
    for (const path of [
      '/api/v1/documents?limit=200',
      '/api/v1/documents/review-queue?limit=200',
      '/api/v1/expected-documents?limit=200',
      '/api/v1/extraction/batches?limit=200',
      '/api/v1/extraction/runs?limit=200',
      '/api/v1/monitoring/board',
      `/api/v1/documents?limit=200&investmentId=${INV}`,
      `/api/v1/monitoring/outlook/${INV}`,
    ])
      expect(planned.has(keyOf(path)), path).toBe(true);
  });

  it('records every id for every family that takes one, and the audit trail first', () => {
    const paths = (name: string): string[] =>
      plan.families.find((f) => f.name === name)?.paths ?? [];
    const each = (make: (id: string) => string): string[] => INVESTMENTS.map((i) => make(i.id));
    expect(paths('investment detail')).toEqual(each((id) => `/api/v1/investments/${id}`));
    expect(paths('investment performance')).toEqual(
      each((id) => `/api/v1/investments/${id}/performance`),
    );
    expect(paths('vehicle detail')).toEqual([`/api/v1/vehicles/${VEH}`]);
    expect(paths('sponsor detail')).toEqual([`/api/v1/sponsors/${SPO}`]);
    expect(paths('capital notice detail')).toEqual([`/api/v1/capital-notices/${NOT}`]);
    expect(paths('investment documents')).toEqual(
      each((id) => `/api/v1/documents?investmentId=${id}&limit=200`),
    );
    expect(paths('realization outlook')).toEqual(each((id) => `/api/v1/monitoring/outlook/${id}`));
    // The Phase 3 controls (decision 0013): the versions of the first positions by number in
    // detail, every ticket, instruction, request, deal and closing, and the lists they seed from.
    expect(paths('valuation detail')).toEqual([`/api/v1/valuations/${VAL}`]);
    expect(paths('trade tickets')).toEqual([TICKETS_PATH, `/api/v1/trade-tickets/${TICKET}`]);
    expect(paths('wire register')).toEqual([WIRES_PATH, `/api/v1/wire-instructions/${WIRE}`]);
    expect(paths('change requests')).toEqual([
      CHANGE_REQUESTS_PATH,
      `/api/v1/change-requests/${REQUEST}`,
    ]);
    expect(paths('pipeline')).toEqual([OPPORTUNITIES_PATH, `/api/v1/opportunities/${OPP}`]);
    expect(paths('closings')).toEqual([`/api/v1/closings/${CLOSING}`]);
    expect(plan.families.map((f) => f.name)).not.toContain('intake');
    expect(paths('investment lists')).toHaveLength(
      INVESTMENT_LIMITS.length * (DEAL_TYPES.length + 1) * ACTIVE_FILTERS.length,
    );
    expect(plan.families.filter((f) => f.recordFirst === true).map((f) => f.name)).toEqual([
      'audit trail',
    ]);
    expect(paths('audit trail').every((p) => p.startsWith('/api/v1/audit/events?'))).toBe(true);
  });

  it('records the unfiltered lists the simulation seeds from', () => {
    for (const path of [
      VALUATIONS_PATH,
      NOTICES_PATH,
      WIRES_PATH,
      TICKETS_PATH,
      CHANGE_REQUESTS_PATH,
      OPPORTUNITIES_PATH,
    ])
      expect(planned.has(getKey('u', path)), path).toBe(true);
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
