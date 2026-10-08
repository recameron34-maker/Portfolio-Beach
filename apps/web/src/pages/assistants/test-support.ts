import { createElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AnalyticsSummary,
  AuditPage,
  CapitalNoticePage,
  CapitalNoticeRow,
  ClientList,
  PooledMetrics,
  Principal,
  Taxonomy,
  WallList,
  Watchlist,
  WeeklyReport,
} from '@pb/contracts';

/**
 * Contract-shaped fixtures for the reporting, assistant and admin page tests, plus a fetch mock
 * keyed by pathname. Every fixture is synthetic and parses against packages/contracts (checked in
 * the tests), so a contract change breaks these tests before it breaks the pages.
 */

export const uuid = (n: number): string => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const AS_OF = '2025-06-30';

export const pooled = (over: Partial<PooledMetrics> = {}): PooledMetrics => ({
  count: 3,
  invested: '30000000.00',
  distributions: '5000000.00',
  nav: '40000000.00',
  dpi: '0.166667',
  rvpi: '1.333333',
  tvpi: '1.5',
  grossMoic: '1.5',
  grossIrr: '0.142',
  irrFlag: null,
  ...over,
});

export const notice = (over: Partial<CapitalNoticeRow> = {}): CapitalNoticeRow => ({
  id: uuid(701),
  noticeType: 'notice_type.capital_call',
  state: 'Reviewed',
  vehicleId: uuid(11),
  vehicleName: 'Beach Co-Invest Fund I',
  investmentId: uuid(31),
  investmentNumber: 'PB-0007',
  companyName: 'Harbor Analytics',
  commitmentId: null,
  sponsorFundName: null,
  issueDate: '2025-06-20',
  dueDate: '2025-07-05',
  amount: '2500000.00',
  currency: 'USD',
  split: { principal: '2500000.00' },
  scenarioTag: null,
  settledAmount: null,
  daysToDue: 5,
  rowVersion: 1,
  ...over,
});

export const weeklyReportFixture = (over: Partial<WeeklyReport> = {}): WeeklyReport => ({
  asOf: AS_OF,
  periodEnd: AS_OF,
  preparedFor: 'Viewer One',
  summary: { ...pooled(), activeInvestments: 3 },
  byVehicle: [
    {
      vehicleId: uuid(11),
      vehicleName: 'Beach Co-Invest Fund I',
      vehicleType: 'vehicle_type.co_invest_fund',
      count: 2,
      invested: '20000000.00',
      distributions: '5000000.00',
      nav: '30000000.00',
      grossMoic: '1.75',
    },
    {
      vehicleId: uuid(12),
      vehicleName: 'Beach Credit Partners',
      vehicleType: 'vehicle_type.credit_fund',
      count: 1,
      invested: '10000000.00',
      distributions: null,
      nav: '10000000.00',
      grossMoic: null,
    },
  ],
  movers: [
    {
      investmentId: uuid(31),
      investmentNumber: 'PB-0007',
      companyName: 'Harbor Analytics',
      periodEnd: AS_OF,
      priorFairValue: '10000000.00',
      fairValue: '11200000.00',
      changePct: '0.12',
    },
    {
      investmentId: uuid(32),
      investmentNumber: 'PB-0012',
      companyName: 'Dune Logistics',
      periodEnd: AS_OF,
      priorFairValue: '8000000.00',
      fairValue: '7360000.00',
      changePct: '-0.08',
    },
  ],
  staleValuations: [
    {
      investmentId: uuid(33),
      investmentNumber: 'PB-0015',
      companyName: 'Tidewater Foods',
      latestLockedPeriodEnd: '2025-03-31',
      footnote:
        'Carried at the latest Locked valuation of Mar 31, 2025; no Locked mark for Jun 30, 2025.',
    },
  ],
  capitalActivity: [notice()],
  commentary: {
    paragraphs: [
      'The portfolio holds 3 active positions with a NAV of $40.0M as of Jun 30, 2025.',
      'Harbor Analytics moved up 12.0% against the prior quarter; Dune Logistics moved down 8.0%.',
    ],
    source: 'template',
    aiDraft: false,
  },
  footnotes: [
    'PB-0015 Tidewater Foods: Carried at the latest Locked valuation of Mar 31, 2025; no Locked mark for Jun 30, 2025.',
    'Figures are gross, before fees and carry.',
  ],
  calcVersion: '0.1.0',
  ...over,
});

export const clientListFixture = (over: Partial<ClientList> = {}): ClientList => ({
  asOf: AS_OF,
  items: [
    {
      id: uuid(51),
      name: 'Client Alpha Pension',
      reportingBases: ['gross', 'net'],
      reportingCadence: 'quarterly',
      vehicles: [
        {
          vehicleId: uuid(11),
          vehicleName: 'Beach Co-Invest Fund I',
          vehicleType: 'vehicle_type.co_invest_fund',
          commitment: '25000000.00',
          closingNumber: 1,
          ownershipPct: '0.25',
          commitmentDate: '2021-03-31',
          invested: '7500000.00',
          distributions: '1250000.00',
          nav: '10000000.00',
          grossMoic: '1.5',
        },
        {
          vehicleId: uuid(12),
          vehicleName: 'Beach Credit Partners',
          vehicleType: 'vehicle_type.credit_fund',
          commitment: '10000000.00',
          closingNumber: 2,
          ownershipPct: null,
          commitmentDate: '2024-01-15',
          invested: null,
          distributions: null,
          nav: null,
          grossMoic: null,
        },
      ],
      totals: {
        commitment: '35000000.00',
        invested: '7500000.00',
        distributions: '1250000.00',
        nav: '10000000.00',
        grossMoic: '1.5',
      },
    },
  ],
  calcVersion: '0.1.0',
  ...over,
});

export const auditPageFixture = (over: Partial<AuditPage> = {}): AuditPage => ({
  items: [
    {
      id: '42',
      at: '2025-06-30T12:00:00.000Z',
      actorName: 'Admin One',
      actorType: 'user',
      action: 'flag.update',
      entity: 'ops.feature_flag',
      entityId: null,
      reason: 'Enable the assistant for the demo',
      requestId: 'req-0042',
    },
    {
      id: '41',
      at: '2025-06-29T08:15:30.000Z',
      actorName: null,
      actorType: 'system',
      action: 'seed.load',
      entity: 'core.investment',
      entityId: uuid(31),
      reason: null,
      requestId: null,
    },
  ],
  nextCursor: null,
  ...over,
});

export const wallListFixture = (over: Partial<WallList> = {}): WallList => ({
  walls: [
    {
      id: uuid(81),
      name: 'Project Dune',
      description: 'Restricted: named members only (SEC-5.3).',
      members: [
        { userId: uuid(91), displayName: 'Deal Three' },
        { userId: uuid(92), displayName: 'Head One' },
      ],
      records: [
        { entity: 'investment', entityId: uuid(32), label: 'Dune Logistics' },
        { entity: 'investment', entityId: uuid(39), label: null },
      ],
    },
  ],
  ...over,
});

export const healthReadyFixture = (): {
  status: 'ok' | 'degraded';
  version: string;
  checks: Record<string, { ok: boolean; detail?: string }>;
} => ({
  status: 'degraded',
  version: '0.1.0',
  checks: {
    database: { ok: true },
    mail: { ok: false, detail: 'adapter disabled by kill switch' },
    documents: { ok: true, detail: 'mock' },
  },
});

export const flagsFixture = (
  assistant: boolean,
): { flags: { key: string; enabled: boolean; description: string }[] } => ({
  flags: [
    { key: 'ai.extraction', enabled: false, description: 'Kill switch for AI extraction calls' },
    { key: 'ai.assistant', enabled: assistant, description: 'Kill switch for Ask Portfolio Beach' },
    { key: 'adapter.mail', enabled: false, description: 'Mail and calendar capture adapter' },
    { key: 'adapter.documents', enabled: true, description: 'Document hub adapter' },
    {
      key: 'adapter.accounting',
      enabled: true,
      description: 'Accounting import and export adapter',
    },
  ],
});

export const taxonomyFixture = (): Taxonomy => ({
  domains: [
    {
      domain: 'deal_type',
      terms: [
        {
          code: 'deal_type.co_invest_equity',
          label: 'Co-investment (equity)',
          parentCode: null,
          active: true,
          sortOrder: 1,
        },
        {
          code: 'deal_type.cv_single_asset',
          label: 'CV single asset',
          parentCode: 'deal_type.co_invest_equity',
          active: false,
          sortOrder: 2,
        },
      ],
    },
    {
      domain: 'sector',
      terms: [
        {
          code: 'sector.healthcare',
          label: 'Healthcare',
          parentCode: null,
          active: true,
          sortOrder: 1,
        },
      ],
    },
  ],
});

export const analyticsFixture = (over: Partial<AnalyticsSummary> = {}): AnalyticsSummary => ({
  asOf: AS_OF,
  activeInvestments: 3,
  realizedInvestments: 1,
  totals: pooled({ count: 4 }),
  active: pooled(),
  realized: pooled({
    count: 1,
    invested: '5000000.00',
    distributions: '9250000.00',
    nav: null,
    dpi: '1.85',
    rvpi: '0',
    tvpi: '1.85',
    grossMoic: '1.85',
    grossIrr: '0.21',
  }),
  exposures: {
    sector: [
      {
        key: 'sector.healthcare',
        label: 'Healthcare',
        count: 2,
        invested: '20000000.00',
        nav: '30000000.00',
        navShare: '0.75',
      },
      {
        key: 'sector.software',
        label: 'Software',
        count: 1,
        invested: '10000000.00',
        nav: '10000000.00',
        navShare: '0.25',
      },
    ],
    geography: [],
    dealType: [],
    vehicle: [],
    sponsor: [],
    vintage: [],
    vehicleByDealType: [],
  },
  navSeries: [
    { periodEnd: '2025-03-31', value: '38000000.00' },
    { periodEnd: AS_OF, value: '40000000.00' },
  ],
  flowsByYear: [],
  topPositions: [
    {
      id: uuid(31),
      investmentNumber: 'PB-0007',
      companyName: 'Harbor Analytics',
      vehicleName: 'Beach Co-Invest Fund I',
      nav: '11200000.00',
      navShare: '0.28',
      grossMoic: '1.6',
    },
    {
      id: uuid(32),
      investmentNumber: 'PB-0012',
      companyName: 'Dune Logistics',
      vehicleName: 'Beach Co-Invest Fund I',
      nav: '7360000.00',
      navShare: '0.184',
      grossMoic: '1.1',
    },
  ],
  calcVersion: '0.1.0',
  ...over,
});

export const watchlistFixture = (over: Partial<Watchlist> = {}): Watchlist => ({
  asOf: AS_OF,
  thresholds: { netDebtToEbitdaMax: 6 },
  items: [
    {
      investmentId: uuid(32),
      investmentNumber: 'PB-0012',
      companyName: 'Dune Logistics',
      vehicleName: 'Beach Co-Invest Fund I',
      dealType: 'deal_type.co_invest_equity',
      flags: [
        {
          code: 'markdown',
          severity: 'bad',
          message: 'Locked fair value for 2025-06-30 is 8.0% below 2025-03-31 (limit 20.0%)',
          value: '-0.08',
          threshold: '0.2',
        },
        {
          code: 'missing_prior_year',
          severity: 'watch',
          message:
            'No approved quarter one year before 2025-06-30 (within 7 days), so year-on-year growth is not calculable',
          value: null,
          threshold: null,
        },
      ],
    },
  ],
  counts: { watch: 0, bad: 1, clear: 2 },
  calcVersion: '0.1.0',
  ...over,
});

export const capitalNoticesFixture = (
  over: Partial<CapitalNoticePage> = {},
): CapitalNoticePage => ({
  items: [
    notice(),
    notice({ id: uuid(702), state: 'Reconciled', daysToDue: -20, dueDate: '2025-06-10' }),
  ],
  nextCursor: null,
  asOf: AS_OF,
  attention: [notice()],
  alertDaysBeforeDue: 3,
  ...over,
});

export const principalFixture = (over: Partial<Principal> = {}): Principal => ({
  userId: uuid(95),
  externalId: 'ops.one',
  displayName: 'Ops One',
  roles: ['operations'],
  clientIds: [],
  mockIdentity: true,
  ...over,
});

export const mockUsersFixture = (): {
  users: { externalId: string; displayName: string; roles: string[] }[];
} => ({
  users: [
    { externalId: 'ops.one', displayName: 'Ops One', roles: ['operations'] },
    { externalId: 'ops.two', displayName: 'Ops Two', roles: ['operations'] },
    { externalId: 'admin.one', displayName: 'Admin One', roles: ['platform_admin'] },
  ],
});

/* ---- fetch mock ---- */

export type Answer = { body: unknown } | { status: number; title: string };

function problem(status: number, title: string): Response {
  return new Response(
    JSON.stringify({
      type: 'https://portfolio-beach.example/problems/test',
      title,
      status,
      detail: title,
      request_id: 'test',
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** Answers fetch by pathname (the query string is ignored); unknown paths answer 404. */
export function mockApi(routes: Record<string, Answer>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const answer = routes[url.pathname];
    if (answer === undefined) return Promise.resolve(problem(404, `No route for ${url.pathname}`));
    if ('status' in answer) return Promise.resolve(problem(answer.status, answer.title));
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

/** Wraps a page in a QueryClientProvider that never retries, so a 403 or 501 settles at once. */
export function withQueries(ui: ReactNode): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, ui);
}
