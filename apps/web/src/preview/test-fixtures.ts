import type {
  CapitalNoticeDetail,
  CapitalNoticePage,
  CapitalNoticeRow,
  DataHealth,
  InvestmentDetail,
  InvestmentPerformance,
  Principal,
  QuarterRow,
  RealizationOutlookDetail,
  ValuationPage,
  ValuationRow,
} from '@pb/contracts';
import { problemDetails } from '@pb/contracts';
import type { BookInvestment, BookQuarter, PreviewBook } from './book.js';
import type { PreviewFixtures, PreviewUser } from './fixtures.js';
import { getKey } from './keys.js';
import { VALUATIONS_PATH } from './state.js';

export interface Answer {
  status: number;
  json: unknown;
  text: string;
  headers: Headers;
}

/** One request through the shim, the way src/api/client.ts sends it. */
export async function send(
  f: typeof fetch,
  credential: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${credential}`,
    ...extra,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await f(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: jsonOf(text),
    text,
    headers: res.headers,
  };
}

/** The body as JSON, or null for an empty body or one that is not JSON (the CSV export). */
function jsonOf(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The problem code (the last segment of its type) and detail of a refused answer. */
export function problemOf(answer: Answer): { code: string; detail: string } {
  const p = problemDetails.parse(answer.json);
  return { code: p.type.split('/').pop() ?? '', detail: p.detail ?? '' };
}

/**
 * Contract-shaped fixtures for the preview unit tests: a small synthetic world with a walled
 * investment, valuation versions in every state and capital notices in every state, recorded per
 * user the way scripts/build-preview.mjs records them. Names and figures are invented here.
 */

export const AS_OF = '2025-06-30';

const uuid = (n: number): string => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const IDS = {
  open: uuid(1),
  walled: uuid(2),
  realized: uuid(3),
  lockedPeriod: uuid(4),
  states: uuid(5),
  twoChains: uuid(6),
  vehicle: uuid(10),
  valuation: {
    Draft: uuid(101),
    OpsPrepared: uuid(102),
    DealTeamApproved: uuid(103),
    Locked: uuid(104),
    Reopened: uuid(105),
    openPrior: uuid(106),
    walled: uuid(107),
    lockedPeriod: uuid(108),
    twoChainsLocked: uuid(109),
    twoChainsApproved: uuid(110),
  },
  notice: {
    Received: uuid(201),
    Extracted: uuid(202),
    Reviewed: uuid(203),
    TicketDrafted: uuid(204),
    TicketApproved: uuid(205),
    Funded: uuid(206),
    Reconciled: uuid(207),
    wireChange: uuid(208),
    walled: uuid(209),
  },
} as const;

type Role = Principal['roles'][number];
const ALL_ROLES: Role[] = [
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'platform_admin',
  'auditor',
  'service',
];

const person = (
  n: number,
  externalId: string,
  displayName: string,
  roles: Role[],
): PreviewUser => ({
  externalId,
  userId: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  displayName,
  roles,
});

export const USERS = {
  viewer: person(1, 'viewer.one', 'Test Viewer', ['viewer']),
  deal: person(2, 'deal.one', 'Test Deal Lead', ['deal_team']),
  dealWall: person(3, 'deal.three', 'Test Wall Member', ['deal_team']),
  ops: person(4, 'ops.one', 'Test Operator', ['operations']),
  ops2: person(5, 'ops.two', 'Test Second Operator', ['operations']),
  head: person(6, 'head.one', 'Test Approver', ['approver']),
  admin: person(7, 'admin.one', 'Test Admin', ['platform_admin']),
  all: person(8, 'all.roles', 'Test Everyone', ALL_ROLES),
} as const;

/** Wall members see the walled investment; everyone else gets the recorded 404. */
export const WALL_MEMBERS: readonly string[] = [
  USERS.dealWall.externalId,
  USERS.head.externalId,
  USERS.all.externalId,
];

/** A quarter the recorded performance serves with a status other than approved (the API serves every row with its stored status). */
export interface RecordedQuarterStatus {
  investmentId: string;
  periodEnd: string;
  status: string;
}

/** A quarter row as the API records a seeded quarter: the book's figures, no ratios, no narrative, no source. */
function recordedQuarter(q: BookQuarter, status = 'record_status.approved'): QuarterRow {
  return {
    periodEnd: q.periodEnd,
    isEntrySnapshot: q.isEntrySnapshot,
    status,
    revenueLtm: q.revenueLtm,
    ebitdaLtm: q.ebitdaLtm,
    ev: q.ev,
    netDebt: q.netDebt,
    cash: null,
    totalEquity: null,
    evToEbitda: null,
    netDebtToEbitda: null,
    ebitdaMargin: null,
    revenueYoy: null,
    ebitdaYoy: null,
    highlights: [],
    source: null,
  };
}

/** The performance of a book investment as the build would record it: the approved quarters, the entry snapshot apart, any status given for a quarter. */
export function performanceFixture(
  book: PreviewBook,
  inv: BookInvestment,
  statuses: readonly RecordedQuarterStatus[] = [],
): InvestmentPerformance {
  const rows = (book.quarters[inv.id] ?? []).map((q) =>
    recordedQuarter(
      q,
      statuses.find((s) => s.investmentId === inv.id && s.periodEnd === q.periodEnd)?.status,
    ),
  );
  return {
    investmentId: inv.id,
    asOf: book.asOf,
    entry: rows.find((r) => r.isEntrySnapshot) ?? null,
    quarters: rows.filter((r) => !r.isEntrySnapshot),
    sinceEntry: null,
    credit: null,
    realizationOutlook: null,
    calcVersion: 'test',
  };
}

/** The outlook the API records for an investment nobody set one for. */
export function defaultOutlookFixture(inv: BookInvestment): RealizationOutlookDetail {
  return {
    investmentId: inv.id,
    investmentNumber: inv.investmentNumber,
    companyName: inv.companyName,
    outlook: 'none',
    horizonMonths: 18,
    note: null,
    setBy: null,
    setAt: null,
  };
}

/**
 * The recordings of a world over the real generator's book (the simulated intake, document,
 * extraction and monitoring tests): every mock user's own sign-in and flag list, their view of
 * each of the book's investments with its performance and default outlook (the walled deal
 * answers 404 outside the wall, as the build records it), an empty valuations board for the
 * simulated Drafts to land on, and Data Health with no open exception for the overlay to count
 * onto. `quarterStatuses` records the named quarters with another status than approved.
 */
export function generatedWorld(
  book: PreviewBook,
  walledId: string,
  quarterStatuses: readonly RecordedQuarterStatus[] = [],
): PreviewFixtures {
  const users = Object.values(USERS);
  const b = new FixtureBuilder(users, book.asOf);
  b.add('', '/api/v1/auth/mock-users', {
    users: users.map(({ externalId, displayName, roles }) => ({ externalId, displayName, roles })),
  });
  const health: DataHealth = {
    asOf: book.asOf,
    orphanInvestments: 0,
    openExceptions: 0,
    staleInvestments: 0,
    staleAfterDays: 75,
    vehiclesWithOwnershipGap: [],
    lockedValuationsLatestQuarter: 0,
    activeInvestments: book.investments.filter((i) => i.isActive).length,
  };
  const board: ValuationPage = { items: [], nextCursor: null, asOf: book.asOf, periods: [] };
  for (const user of users) {
    const c = user.externalId;
    b.add(c, '/api/v1/auth/me', {
      userId: user.userId,
      externalId: c,
      displayName: user.displayName,
      roles: user.roles,
      clientIds: [],
      mockIdentity: true,
    });
    b.add(c, '/api/v1/data-health', health);
    b.add(c, VALUATIONS_PATH, board);
    b.add(c, '/api/v1/flags', {
      flags: [
        { key: 'ai.classifier', enabled: true, description: 'Classifier switch' },
        { key: 'ai.extraction', enabled: false, description: 'Extraction kill switch' },
      ],
    });
    for (const inv of book.investments) {
      const path = `/api/v1/investments/${inv.id}`;
      if (inv.id !== walledId || WALL_MEMBERS.includes(c)) {
        b.add(
          c,
          path,
          investmentFixture(inv.id, {
            investmentNumber: inv.investmentNumber,
            companyName: inv.companyName,
            dealType: inv.dealType,
            entryDate: inv.entryDate,
            exitDate: inv.exitDate,
            isActive: inv.isActive,
          }),
        );
        b.add(c, `${path}/performance`, performanceFixture(book, inv, quarterStatuses));
        b.add(c, `/api/v1/monitoring/outlook/${inv.id}`, defaultOutlookFixture(inv));
      } else {
        b.notFound(c, path);
        b.notFound(c, `${path}/performance`);
        b.notFound(c, `/api/v1/monitoring/outlook/${inv.id}`);
      }
    }
  }
  return b.build();
}

/** The static assets beside the page (the bundled samples), served by their URL-decoded file name as text or bytes; anything else is 404. */
export function serveSamples(files: ReadonlyMap<string, string | Uint8Array>): typeof fetch {
  return (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const found = files.get(decodeURIComponent(url.split('/').pop() ?? ''));
    if (found === undefined) return Promise.resolve(new Response('', { status: 404 }));
    const body: BodyInit = typeof found === 'string' ? found : new Uint8Array(found);
    return Promise.resolve(new Response(body, { status: 200 }));
  };
}

export function investmentFixture(
  id: string,
  overrides: Partial<InvestmentDetail> = {},
): InvestmentDetail {
  return {
    id,
    investmentNumber: `INV-${id.slice(-4)}`,
    companyName: `Company ${id.slice(-4)}`,
    sponsorName: 'Test Sponsor',
    sponsorFundName: null,
    vehicleName: 'Test Vehicle I',
    dealType: 'deal_type.co_invest_equity',
    sector: null,
    geography: null,
    vintage: 2023,
    entryDate: '2023-01-15',
    closeDate: '2023-01-15',
    exitDate: null,
    isActive: true,
    invested: '1000.00',
    distributions: '0.00',
    nav: '1100.00',
    holdingPeriodYears: '2.2465753425',
    navDate: '2025-03-31',
    grossMoic: '1.10',
    grossIrr: '0.05',
    irrFlag: null,
    calcVersion: 'test',
    companyId: uuid(900),
    sponsorId: uuid(901),
    sponsorFundId: null,
    vehicleId: IDS.vehicle,
    companyDescription: null,
    latestPeriodEnd: '2025-03-31',
    cashFlows: [],
    valuations: [],
    credit: null,
    operating: null,
    ...overrides,
  };
}

export function valuationFixture(
  id: string,
  investment: InvestmentDetail,
  overrides: Partial<ValuationRow> = {},
): ValuationRow {
  return {
    id,
    investmentId: investment.id,
    investmentNumber: investment.investmentNumber,
    companyName: investment.companyName,
    vehicleName: investment.vehicleName,
    dealType: investment.dealType,
    periodEnd: overrides.periodEnd ?? '2025-03-31',
    quarterEnd: overrides.periodEnd ?? '2025-03-31',
    version: 1,
    state: 'Locked',
    method: 'valuation_method.sponsor_mark',
    fairValue: '1100.00',
    priorFairValue: null,
    changePct: null,
    lockHash: null,
    preparedBy: null,
    dealTeamApprovedBy: null,
    approvedBy: null,
    approvedAt: null,
    reopenReason: null,
    rowVersion: 1,
    ...overrides,
  };
}

export function noticeFixture(
  id: string,
  overrides: Partial<CapitalNoticeRow> = {},
): CapitalNoticeRow {
  return {
    id,
    noticeType: 'notice_type.capital_call',
    state: 'Reconciled',
    vehicleId: IDS.vehicle,
    vehicleName: 'Test Vehicle I',
    investmentId: IDS.open,
    investmentNumber: 'INV-0001',
    companyName: 'Company 0001',
    commitmentId: null,
    sponsorFundName: null,
    issueDate: '2025-06-01',
    dueDate: '2025-06-15',
    amount: '250.00',
    currency: 'USD',
    split: { investment: '250.00' },
    scenarioTag: null,
    settledAmount: null,
    daysToDue: -15,
    rowVersion: 1,
    ...overrides,
  };
}

/** Builds fixtures in the recorder's format: bodies stored once, responses point at them. */
export class FixtureBuilder {
  private readonly bodies: Record<string, string> = {};
  private readonly hashes = new Map<string, string>();
  private readonly responses: PreviewFixtures['responses'] = {};

  constructor(
    private readonly users: readonly PreviewUser[],
    private readonly asOf = AS_OF,
  ) {}

  add(credential: string, path: string, body: unknown, status = 200): this {
    const text = JSON.stringify(body);
    let hash = this.hashes.get(text);
    if (hash === undefined) {
      hash = `h${this.hashes.size}`;
      this.hashes.set(text, hash);
      this.bodies[hash] = text;
    }
    this.responses[getKey(credential, path)] = {
      status,
      contentType: status === 200 ? 'application/json' : 'application/problem+json',
      body: hash,
    };
    return this;
  }

  notFound(credential: string, path: string): this {
    return this.add(credential, path, notFoundBody(path), 404);
  }

  build(): PreviewFixtures {
    return {
      generatedFrom: 'unit test',
      asOf: this.asOf,
      users: [...this.users],
      bodies: { ...this.bodies },
      responses: { ...this.responses },
    };
  }
}

export function notFoundBody(path: string): unknown {
  return {
    type: 'https://portfolio-beach.example/problems/not-found',
    title: 'Not found',
    status: 404,
    detail: 'Not found',
    instance: path.split('?')[0],
    request_id: 'preview',
  };
}

function notImplementedBody(path: string): unknown {
  return {
    type: 'https://portfolio-beach.example/problems/not-implemented',
    title: 'Not implemented',
    status: 501,
    detail: 'This endpoint is not implemented yet',
    instance: path.split('?')[0],
    request_id: 'preview',
  };
}

export interface World {
  fixtures: PreviewFixtures;
  investments: Record<
    'open' | 'walled' | 'realized' | 'lockedPeriod' | 'states' | 'twoChains',
    InvestmentDetail
  >;
  valuations: ValuationRow[];
  notices: CapitalNoticeRow[];
}

/**
 * The test world. With `workflowEndpoints: 'not-implemented'` the valuation and capital notice
 * reads are recorded as 501, as they are while the API work is pending. With `twoChains` one
 * investment carries a Locked version and a second version awaiting lock in the same quarter,
 * as imported data might.
 */
export function buildWorld(
  options: { workflowEndpoints?: 'recorded' | 'not-implemented'; twoChains?: boolean } = {},
): World {
  const users = Object.values(USERS);
  const states = investmentFixture(IDS.states, { investmentNumber: 'INV-STATES' });
  const open = investmentFixture(IDS.open, { investmentNumber: 'INV-0001' });
  const walled = investmentFixture(IDS.walled, { investmentNumber: 'INV-WALL' });
  const realized = investmentFixture(IDS.realized, {
    investmentNumber: 'INV-DONE',
    isActive: false,
    exitDate: '2024-12-31',
  });
  const lockedPeriod = investmentFixture(IDS.lockedPeriod, { investmentNumber: 'INV-LOCK' });
  const twoChains = investmentFixture(IDS.twoChains, { investmentNumber: 'INV-TWO' });

  const v = IDS.valuation;
  const valuations: ValuationRow[] = [
    valuationFixture(v.Draft, states, { periodEnd: '2024-03-31', state: 'Draft' }),
    // Prepared by the user who holds every role, so the recorded name must map back to that
    // user's id for segregation of duties to hold.
    valuationFixture(v.OpsPrepared, states, {
      periodEnd: '2024-06-30',
      state: 'OpsPrepared',
      preparedBy: USERS.all.displayName,
      lockHash: 'h-recorded',
    }),
    valuationFixture(v.DealTeamApproved, states, {
      periodEnd: '2024-09-30',
      state: 'DealTeamApproved',
      preparedBy: USERS.all.displayName,
      dealTeamApprovedBy: USERS.deal.displayName,
      lockHash: 'h-recorded',
    }),
    valuationFixture(v.Locked, states, {
      periodEnd: '2024-12-31',
      state: 'Locked',
      preparedBy: USERS.ops.displayName,
      dealTeamApprovedBy: USERS.deal.displayName,
      approvedBy: USERS.head.displayName,
      approvedAt: '2025-01-20T12:00:00Z',
      lockHash: 'h-recorded',
    }),
    valuationFixture(v.Reopened, states, {
      periodEnd: '2023-12-31',
      state: 'Reopened',
      reopenReason: 'restated by the sponsor',
    }),
    valuationFixture(v.openPrior, open, {
      periodEnd: '2025-03-31',
      state: 'Locked',
      fairValue: '1000.00',
      approvedBy: USERS.head.displayName,
    }),
    valuationFixture(v.walled, walled, { periodEnd: '2025-03-31', state: 'Locked' }),
    valuationFixture(v.lockedPeriod, lockedPeriod, { periodEnd: '2025-06-30', state: 'Locked' }),
    ...(options.twoChains === true
      ? [
          valuationFixture(v.twoChainsLocked, twoChains, {
            periodEnd: '2025-03-31',
            state: 'Locked',
            preparedBy: USERS.ops.displayName,
            dealTeamApprovedBy: USERS.deal.displayName,
            approvedBy: USERS.head.displayName,
            approvedAt: '2025-04-20T12:00:00Z',
            lockHash: 'h-recorded',
          }),
          valuationFixture(v.twoChainsApproved, twoChains, {
            periodEnd: '2025-03-31',
            version: 2,
            state: 'DealTeamApproved',
            preparedBy: USERS.ops.displayName,
            dealTeamApprovedBy: USERS.deal.displayName,
            lockHash: 'h-recorded',
          }),
        ]
      : []),
  ];
  const entries = (inv: InvestmentDetail): InvestmentDetail['valuations'] =>
    valuations
      .filter((r) => r.investmentId === inv.id)
      .map(({ periodEnd, version, state, fairValue, method }) => ({
        periodEnd,
        version,
        state,
        fairValue,
        method,
      }))
      .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : 0));
  const investments = { open, walled, realized, lockedPeriod, states, twoChains };
  for (const inv of Object.values(investments)) inv.valuations = entries(inv);

  const n = IDS.notice;
  const notices: CapitalNoticeRow[] = [
    ...(
      [
        'Received',
        'Extracted',
        'Reviewed',
        'TicketDrafted',
        'TicketApproved',
        'Funded',
        'Reconciled',
      ] as const
    ).map((state) => noticeFixture(n[state], { state, investmentId: IDS.states })),
    noticeFixture(n.wireChange, { state: 'Extracted', scenarioTag: 'wire_change' }),
    noticeFixture(n.walled, { state: 'Extracted', investmentId: IDS.walled }),
  ];

  const b = new FixtureBuilder(users);
  b.add('', '/api/v1/auth/mock-users', {
    users: users.map(({ externalId, displayName, roles }) => ({ externalId, displayName, roles })),
  });
  const workflows = options.workflowEndpoints ?? 'recorded';
  for (const user of users) {
    const c = user.externalId;
    const member = WALL_MEMBERS.includes(c);
    const canSee = (investmentId: string | null): boolean => investmentId !== IDS.walled || member;
    b.add(c, '/api/v1/auth/me', {
      userId: user.userId,
      externalId: c,
      displayName: user.displayName,
      roles: user.roles,
      clientIds: [],
      mockIdentity: true,
    });
    b.add(c, '/api/v1/flags', {
      flags: [{ key: 'ai.extraction', enabled: false, description: 'Extraction kill switch' }],
    });
    for (const inv of Object.values(investments)) {
      const path = `/api/v1/investments/${inv.id}`;
      if (canSee(inv.id)) b.add(c, path, inv);
      else b.notFound(c, path);
    }
    const visibleValuations = valuations.filter((r) => canSee(r.investmentId));
    const visibleNotices = notices.filter((r) => canSee(r.investmentId));
    const valuationList = '/api/v1/valuations?limit=200';
    const noticeList = '/api/v1/capital-notices?limit=200';
    if (workflows === 'not-implemented') {
      b.add(c, valuationList, notImplementedBody(valuationList), 501);
      b.add(c, noticeList, notImplementedBody(noticeList), 501);
      for (const notice of notices) {
        const path = `/api/v1/capital-notices/${notice.id}`;
        b.add(c, path, notImplementedBody(path), 501);
      }
      continue;
    }
    const page = (items: ValuationRow[]): ValuationPage => ({
      items,
      nextCursor: null,
      asOf: AS_OF,
      periods: [...new Set(items.map((r) => r.periodEnd))].sort().reverse(),
    });
    b.add(c, valuationList, page(visibleValuations));
    for (const inv of Object.values(investments)) {
      if (canSee(inv.id))
        b.add(
          c,
          `/api/v1/valuations?investmentId=${inv.id}&limit=200`,
          page(visibleValuations.filter((r) => r.investmentId === inv.id)),
        );
    }
    const noticePage: CapitalNoticePage = {
      items: visibleNotices,
      nextCursor: null,
      asOf: AS_OF,
      attention: visibleNotices.filter((r) => r.state !== 'Reconciled'),
      alertDaysBeforeDue: 3,
    };
    b.add(c, noticeList, noticePage);
    for (const notice of notices) {
      const path = `/api/v1/capital-notices/${notice.id}`;
      if (!canSee(notice.investmentId)) {
        b.notFound(c, path);
        continue;
      }
      const detail: CapitalNoticeDetail = {
        ...notice,
        cashFlows: [],
        wireChangeHold:
          notice.scenarioTag === 'wire_change' ? { until: '2025-07-30', holdDays: 30 } : null,
        notes: [],
        ticket: null,
        activeWireInstruction: null,
        alerts: notice.scenarioTag === 'wire_change' ? ['wire_changed'] : [],
      };
      b.add(c, path, detail);
    }
  }
  return { fixtures: b.build(), investments, valuations, notices };
}
