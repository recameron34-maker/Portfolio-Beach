import type {
  AllocationRow,
  CapitalNoticeControlDetail,
  CapitalNoticePage,
  CapitalNoticeRow,
  ChangeRequestRow,
  ClosingDetail,
  ClosingItem,
  DataHealth,
  DiligenceTask,
  InvestmentDetail,
  InvestmentPerformance,
  LegalTerm,
  OpportunityDetail,
  OpportunityRow,
  Person,
  Principal,
  QuarterRow,
  RealizationOutlookDetail,
  TradeTicketRow,
  ValuationApproval,
  ValuationDetail,
  ValuationPage,
  ValuationRow,
  WireInstructionRow,
} from '@pb/contracts';
import {
  closingChecklist,
  diligenceTemplateFor,
  diligenceTemplates,
  investmentSummary,
  problemDetails,
  valuationLockText,
} from '@pb/contracts';
import checklistConfig from '../../../../config/closing_checklist.json';
import templatesConfig from '../../../../config/diligence_templates.json';
import { parseBook } from './book.js';
import type { BookInvestment, BookQuarter, PreviewBook } from './book.js';
import type { PreviewFixtures, PreviewUser } from './fixtures.js';
import { getKey } from './keys.js';
import {
  CHANGE_REQUESTS_PATH,
  OPPORTUNITIES_PATH,
  TICKETS_PATH,
  VALUATIONS_PATH,
  WIRES_PATH,
} from './state.js';
import {
  DUE_SOON_BUSINESS_DAYS,
  HOLD_DAYS,
  fmtDate,
  noticeAlerts,
  pendingChange,
  releaseOf,
} from './routes/register.js';
import type { RegisterView } from './routes/register.js';

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
 * investment, valuation versions in every state, capital notices in every state, a wire register
 * in every state, trade tickets, change requests, a pipeline with a deal at every gate and the
 * closings those deals name, recorded per user the way scripts/build-preview.mjs records them.
 * Names and figures are invented here.
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
  fund: uuid(11),
  vehicle2: uuid(12),
  client: uuid(13),
  fund2: uuid(14),
  sponsor: uuid(901),
  /** A document the simulated hub may hold (the tests put it into the state when a journey needs evidence). */
  document: uuid(801),
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
  wire: {
    Superseded: uuid(301),
    Verified: uuid(302),
    Rejected: uuid(303),
    Proposed: uuid(304),
    /** The active version of the second fund, which the Funded ticket was approved against. */
    verifiedFund2: uuid(305),
  },
  ticket: {
    drafted: uuid(401),
    funded: uuid(402),
    walled: uuid(403),
  },
  changeRequest: {
    submitted: uuid(501),
    inProgress: uuid(502),
    applied: uuid(503),
    walled: uuid(504),
  },
  opportunity: {
    sourced: uuid(601),
    ic: uuid(602),
    closingOpen: uuid(603),
    walled: uuid(604),
    passed: uuid(605),
    closed: uuid(606),
  },
  closing: {
    open: uuid(701),
    confirmed: uuid(702),
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

/** A user as a person on a record. */
export const personOf = (u: PreviewUser): Person => ({ id: u.userId, name: u.displayName });

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
    opportunityId: null,
    closingId: null,
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
    sponsorId: IDS.sponsor,
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

/* ---- The Phase 3 controls (decision 0013) ---- */

export const FUND_NAME = 'Test Fund IV';
export const FUND2_NAME = 'Test Fund V';
export const BANK_DETAILS = {
  Superseded: {
    bankName: 'Harbor Street Bank',
    accountName: FUND_NAME,
    accountNumber: '1111222233',
    routingCode: '021000021',
  },
  Verified: {
    bankName: 'Harbor Street Bank',
    accountName: FUND_NAME,
    accountNumber: '4444555566',
    routingCode: '021000021',
  },
  Rejected: {
    bankName: 'Northline Trust',
    accountName: FUND_NAME,
    accountNumber: '7777888899',
    routingCode: '111000025',
  },
  Proposed: {
    bankName: 'Meridian Clearing',
    accountName: FUND_NAME,
    accountNumber: '1234567890',
    routingCode: '031000053',
  },
  verifiedFund2: {
    bankName: 'Harbor Street Bank',
    accountName: FUND2_NAME,
    accountNumber: '9876543210',
    routingCode: '021000021',
  },
} as const;

const masked = (d: { bankName: string; accountNumber: string }): string =>
  `${d.bankName} ****${d.accountNumber.slice(-4)}`;

function wireFixture(
  id: string,
  version: number,
  state: WireInstructionRow['state'],
  details: { bankName: string; accountNumber: string },
  overrides: Partial<WireInstructionRow> = {},
): WireInstructionRow {
  return {
    id,
    counterparty: { kind: 'sponsor_fund', id: IDS.fund, name: FUND_NAME },
    version,
    state,
    bankDetailsMasked: masked(details),
    proposedBy: personOf(USERS.ops),
    proposedAt: '2025-01-10T10:00:00.000Z',
    sourceNote: null,
    callback: null,
    verifiedAt: null,
    rejectionReason: null,
    active: false,
    rowVersion: 1,
    ...overrides,
  };
}

/** The register of the test world: every state on the first fund, one active version on the second. */
export function wireFixtures(): WireInstructionRow[] {
  const confirmed = (at: string): WireInstructionRow['callback'] => ({
    by: personOf(USERS.ops2),
    at,
    numberSource: 'prior_instruction',
    result: 'confirmed',
  });
  return [
    wireFixture(IDS.wire.Superseded, 1, 'Superseded', BANK_DETAILS.Superseded, {
      proposedAt: '2024-01-10T10:00:00.000Z',
      callback: confirmed('2024-01-11T10:00:00.000Z'),
      verifiedAt: '2024-01-11T10:00:00.000Z',
    }),
    wireFixture(IDS.wire.Verified, 2, 'Verified', BANK_DETAILS.Verified, {
      callback: confirmed('2025-01-11T10:00:00.000Z'),
      verifiedAt: '2025-01-11T10:00:00.000Z',
      active: true,
    }),
    wireFixture(IDS.wire.Rejected, 3, 'Rejected', BANK_DETAILS.Rejected, {
      proposedAt: '2025-03-01T10:00:00.000Z',
      callback: {
        by: personOf(USERS.ops2),
        at: '2025-03-02T10:00:00.000Z',
        numberSource: 'known_contact',
        result: 'not_confirmed',
      },
      rejectionReason: 'the contact did not recognise the account',
    }),
    wireFixture(IDS.wire.Proposed, 4, 'Proposed', BANK_DETAILS.Proposed, {
      proposedAt: `${AS_OF}T09:00:00.000Z`,
      sourceNote: 'Changed instructions received in the notice',
    }),
    wireFixture(IDS.wire.verifiedFund2, 1, 'Verified', BANK_DETAILS.verifiedFund2, {
      counterparty: { kind: 'sponsor_fund', id: IDS.fund2, name: FUND2_NAME },
      proposedAt: '2024-06-10T10:00:00.000Z',
      callback: confirmed('2024-06-11T10:00:00.000Z'),
      verifiedAt: '2024-06-11T10:00:00.000Z',
      active: true,
    }),
  ];
}

/** A minimal book for the register tests: the two funds, the bank details of every recorded version, the bundled config. */
export function testBook(): PreviewBook {
  return parseBook({
    generatedFrom: 'unit test',
    asOf: AS_OF,
    investments: [],
    sponsorFunds: [
      {
        id: IDS.fund,
        sponsorId: IDS.sponsor,
        name: FUND_NAME,
        canonicalName: 'test fund iv',
        aliases: [],
      },
      {
        id: IDS.fund2,
        sponsorId: IDS.sponsor,
        name: FUND2_NAME,
        canonicalName: 'test fund v',
        aliases: [],
      },
    ],
    expectedDocumentDefaults: { reportingDealTypes: [], fundCommitments: [] },
    matchGuards: [],
    quarters: {},
    lockedMarks: {},
    investedCost: {},
    samples: [],
    weeklySamples: [],
    lookthroughSamples: [],
    opsDropSamples: [],
    documents: [],
    documentExpectations: {
      byDocType: {},
      scenarioFiles: {},
      walledFiles: [],
      total: 0,
      lateFinancials: null,
    },
    wireInstructions: [
      { id: IDS.wire.Superseded, bankDetails: BANK_DETAILS.Superseded },
      { id: IDS.wire.Verified, bankDetails: BANK_DETAILS.Verified },
      { id: IDS.wire.Rejected, bankDetails: BANK_DETAILS.Rejected },
      { id: IDS.wire.Proposed, bankDetails: BANK_DETAILS.Proposed },
      { id: IDS.wire.verifiedFund2, bankDetails: BANK_DETAILS.verifiedFund2 },
    ],
    diligenceTemplates: templatesConfig,
    closingChecklist: checklistConfig,
  });
}

const CHECKLIST = closingChecklist.parse(checklistConfig);
const TEMPLATES = diligenceTemplates.parse(templatesConfig);

/** The checklist items of a closing: every item in config order, in the status given per code (open otherwise). */
function closingItems(
  base: number,
  statuses: Partial<Record<string, { status: ClosingItem['status']; documentId?: string }>>,
): ClosingItem[] {
  return CHECKLIST.items.map((i, index) => {
    const given = statuses[i.code];
    return {
      id: uuid(base + index),
      itemCode: i.code,
      label: i.label,
      required: i.required,
      documentId: given?.documentId ?? null,
      status: given?.status ?? 'open',
      waivedReason: given?.status === 'waived' ? `${i.code} held by outside counsel` : null,
    };
  });
}

/** The template tasks of a deal type, every one in the status given, owned by the deal lead. */
function templateTasks(
  base: number,
  dealType: string,
  status: DiligenceTask['status'] | ((index: number) => DiligenceTask['status']),
): DiligenceTask[] {
  return diligenceTemplateFor(TEMPLATES, dealType).map((t, index) => {
    const s = typeof status === 'function' ? status(index) : status;
    return {
      id: uuid(base + index),
      workstream: t.workstream,
      title: t.title,
      owner: personOf(USERS.deal),
      dueDate: null,
      status: s,
      requiredForIc: t.requiredForIc,
      evidenceDocumentId: null,
      waivedReason: s === 'waived' ? 'covered by the sponsor review' : null,
    };
  });
}

const legalTerm = (id: string, status: LegalTerm['status']): LegalTerm => ({
  id,
  termType: 'legal_term_type.mfn',
  value: { granted: true, scope: 'fee terms' },
  sourceDocumentId: null,
  status,
  confirmedBy: status === 'confirmed' ? personOf(USERS.deal) : null,
});

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

  forbidden(credential: string, path: string): this {
    return this.add(credential, path, forbiddenBody(path), 403);
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

function forbiddenBody(path: string): unknown {
  return {
    type: 'https://portfolio-beach.example/problems/forbidden',
    title: 'Forbidden',
    status: 403,
    detail: 'This operation needs a role you do not hold',
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
  wires: WireInstructionRow[];
  tickets: TradeTicketRow[];
  changeRequests: ChangeRequestRow[];
  opportunities: OpportunityDetail[];
  closings: ClosingDetail[];
}

/** The roles the contract names on each read route, as the build records 200 for them and 403 for the rest. */
const READ_ROLES: Role[] = [
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'auditor',
];
const TICKET_ROLES: Role[] = ['operations', 'approver', 'auditor', 'deal_team'];
const WIRE_ROLES: Role[] = ['operations', 'approver', 'auditor', 'platform_admin'];
const CHANGE_REQUEST_ROLES: Role[] = ['deal_team', 'operations', 'approver', 'auditor'];

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
  const states = investmentFixture(IDS.states, {
    investmentNumber: 'INV-STATES',
    sponsorFundId: IDS.fund2,
    sponsorFundName: FUND2_NAME,
  });
  const open = investmentFixture(IDS.open, {
    investmentNumber: 'INV-0001',
    sponsorFundId: IDS.fund,
    sponsorFundName: FUND_NAME,
  });
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
    ).map((state) =>
      noticeFixture(n[state], {
        state,
        investmentId: IDS.states,
        investmentNumber: states.investmentNumber,
        companyName: states.companyName,
        sponsorFundName: FUND2_NAME,
        ...(state === 'Reconciled' ? { settledAmount: '250.00' } : {}),
      }),
    ),
    // The wire change call: issued on the as-of date, due two business days later, with changed
    // instructions in the notice (the Proposed version of its fund) and urgency language.
    noticeFixture(n.wireChange, {
      state: 'Extracted',
      scenarioTag: 'wire_change',
      sponsorFundName: FUND_NAME,
      issueDate: AS_OF,
      dueDate: '2025-07-02',
      daysToDue: 2,
      amount: '2500.00',
      split: { investment: '2500.00' },
    }),
    noticeFixture(n.walled, {
      state: 'Extracted',
      investmentId: IDS.walled,
      investmentNumber: walled.investmentNumber,
      companyName: walled.companyName,
    }),
  ];

  const wires = wireFixtures();
  const registerOfFund = (fundId: string): RegisterView => {
    const versions = wires
      .filter((w) => w.counterparty.id === fundId)
      .sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : a.proposedAt > b.proposedAt ? -1 : 0));
    return { versions, active: versions.find((w) => w.active) ?? null };
  };
  const fundOfNotice = (notice: CapitalNoticeRow): string | null =>
    notice.investmentId === IDS.open
      ? IDS.fund
      : notice.investmentId === IDS.states
        ? IDS.fund2
        : null;
  const registerOfNotice = (notice: CapitalNoticeRow): RegisterView => {
    const fund = fundOfNotice(notice);
    return fund === null ? { versions: [], active: null } : registerOfFund(fund);
  };

  /** The tickets, without the release check (computed per reader below). */
  const ticketBase: Omit<TradeTicketRow, 'release'>[] = [
    {
      id: IDS.ticket.drafted,
      capitalNoticeId: n.wireChange,
      amount: '2500.00',
      currency: 'USD',
      fundingDate: '2025-07-02',
      preparedBy: personOf(USERS.ops),
      preparedAt: `${AS_OF}T09:30:00.000Z`,
      approvedBy: null,
      approvedAt: null,
      wireInstruction: null,
      state: 'Drafted',
      rowVersion: 1,
    },
    {
      id: IDS.ticket.funded,
      capitalNoticeId: n.Reconciled,
      amount: '250.00',
      currency: 'USD',
      fundingDate: '2025-06-15',
      preparedBy: personOf(USERS.ops),
      preparedAt: '2025-06-10T09:30:00.000Z',
      approvedBy: personOf(USERS.head),
      approvedAt: '2025-06-11T09:30:00.000Z',
      wireInstruction: {
        id: IDS.wire.verifiedFund2,
        version: 1,
        state: 'Verified',
        bankDetailsMasked: masked(BANK_DETAILS.verifiedFund2),
      },
      state: 'Funded',
      rowVersion: 3,
    },
    {
      id: IDS.ticket.walled,
      capitalNoticeId: n.walled,
      amount: '250.00',
      currency: 'USD',
      fundingDate: '2025-06-15',
      preparedBy: personOf(USERS.ops),
      preparedAt: '2025-06-10T09:30:00.000Z',
      approvedBy: null,
      approvedAt: null,
      wireInstruction: null,
      state: 'Drafted',
      rowVersion: 1,
    },
  ];
  const ticketFor = (t: Omit<TradeTicketRow, 'release'>, reader: PreviewUser): TradeTicketRow => {
    const notice = notices.find((x) => x.id === t.capitalNoticeId);
    const register =
      notice === undefined ? { versions: [], active: null } : registerOfNotice(notice);
    return {
      ...t,
      release: releaseOf(
        { state: t.state, preparedById: t.preparedBy.id },
        register,
        reader.userId,
        AS_OF,
      ),
    };
  };
  const tickets = ticketBase.map((t) => ticketFor(t, USERS.all));

  const changeRequest = (
    id: string,
    inv: InvestmentDetail,
    overrides: Partial<ChangeRequestRow>,
  ): ChangeRequestRow => ({
    id,
    investmentId: inv.id,
    investmentName: inv.companyName,
    changeType: 'change_type.add_on_acquisition',
    effectiveDate: '2025-06-15',
    summary: 'Add-on acquisition of a regional competitor closed',
    details: { target: 'A regional competitor' },
    owner: null,
    submittedBy: personOf(USERS.deal),
    state: 'Submitted',
    appliedPeriod: null,
    appliedBy: null,
    rejectionReason: null,
    createdAt: '2025-06-16T10:00:00.000Z',
    rowVersion: 1,
    ...overrides,
  });
  const changeRequests: ChangeRequestRow[] = [
    changeRequest(IDS.changeRequest.submitted, open, {}),
    changeRequest(IDS.changeRequest.inProgress, states, {
      changeType: 'change_type.recapitalization',
      effectiveDate: '2025-05-31',
      summary: 'Dividend recapitalization closed',
      details: {},
      owner: personOf(USERS.ops),
      state: 'InProgress',
      createdAt: '2025-06-02T10:00:00.000Z',
      rowVersion: 3,
    }),
    changeRequest(IDS.changeRequest.applied, states, {
      changeType: 'change_type.partial_exit',
      effectiveDate: '2025-02-15',
      summary: 'Partial exit to a strategic buyer closed',
      details: {},
      owner: personOf(USERS.ops),
      state: 'Applied',
      appliedPeriod: '2025-03-31',
      appliedBy: personOf(USERS.ops),
      createdAt: '2025-02-20T10:00:00.000Z',
      rowVersion: 4,
    }),
    changeRequest(IDS.changeRequest.walled, walled, {
      owner: personOf(USERS.ops),
      state: 'Routed',
      submittedBy: personOf(USERS.dealWall),
      createdAt: '2025-06-20T10:00:00.000Z',
      rowVersion: 2,
    }),
  ];

  const CO_INVEST = 'deal_type.co_invest_equity';
  const opportunityRow = (
    id: string,
    stage: OpportunityRow['stage'],
    overrides: Partial<OpportunityRow> = {},
  ): OpportunityRow => ({
    id,
    name: `Project ${id.slice(-3)}`,
    companyName: `Prospect ${id.slice(-3)} Co`,
    sponsor: { id: IDS.sponsor, name: 'Test Sponsor' },
    sponsorFund: { id: IDS.fund, name: FUND_NAME },
    dealType: CO_INVEST,
    sector: 'sector.software',
    geography: 'geography.north_america',
    stage,
    owner: personOf(USERS.deal),
    receivedDate: '2025-06-20',
    targetCommitment: '5000000.00',
    currency: 'USD',
    daysInStage: 10,
    passReasonCode: null,
    investmentId: null,
    rowVersion: 1,
    ...overrides,
  });
  const history = (
    stages: readonly OpportunityRow['stage'][],
    by: PreviewUser = USERS.deal,
  ): OpportunityDetail['stageHistory'] =>
    stages.map((toStage, i) => ({
      fromStage: i === 0 ? null : (stages[i - 1] ?? null),
      toStage,
      command: i === 0 ? 'create' : toStage === 'Passed' ? 'pass' : 'advance',
      reason: null,
      changedBy: personOf(by),
      changedAt: `2025-0${Math.min(6, 1 + i)}-15T10:00:00.000Z`,
    }));
  const tiedAllocation: AllocationRow[] = [
    {
      id: uuid(651),
      vehicle: { id: IDS.vehicle, name: 'Test Vehicle I' },
      client: null,
      requested: '2000000.00',
      received: '2000000.00',
    },
  ];
  const openClosing: ClosingDetail = {
    id: IDS.closing.open,
    closeDate: '2025-07-15',
    commitmentAmount: '2000000.00',
    currency: 'USD',
    state: 'Open',
    opsConfirmedBy: null,
    opsConfirmedAt: null,
    itemsOpen: 3,
    itemsRequiredOpen: 1,
    allocationTieOut: {
      commitment: '2000000.00',
      allocated: '2000000.00',
      difference: '0.00',
      tiedOut: true,
    },
    opportunityId: IDS.opportunity.closingOpen,
    investmentId: null,
    items: closingItems(710, {
      signed_documents: { status: 'waived' },
      cap_table: { status: 'waived' },
      funds_flow: { status: 'waived' },
      consents: { status: 'waived' },
    }),
    legalTerms: [legalTerm(uuid(721), 'draft'), legalTerm(uuid(722), 'draft')],
    allocations: tiedAllocation,
    rowVersion: 1,
  };
  const closedAllocation: AllocationRow[] = [
    {
      id: uuid(652),
      vehicle: { id: IDS.vehicle, name: 'Test Vehicle I' },
      client: null,
      requested: '1000.00',
      received: '1000.00',
    },
  ];
  const confirmedClosing: ClosingDetail = {
    id: IDS.closing.confirmed,
    closeDate: open.entryDate,
    commitmentAmount: '1000.00',
    currency: 'USD',
    state: 'OpsConfirmed',
    opsConfirmedBy: personOf(USERS.ops),
    opsConfirmedAt: '2023-01-16T16:00:00.000Z',
    itemsOpen: 0,
    itemsRequiredOpen: 0,
    allocationTieOut: {
      commitment: '1000.00',
      allocated: '1000.00',
      difference: '0.00',
      tiedOut: true,
    },
    opportunityId: IDS.opportunity.closed,
    investmentId: IDS.open,
    items: closingItems(730, {
      signed_documents: { status: 'received', documentId: IDS.document },
      cap_table: { status: 'waived' },
      funds_flow: { status: 'waived' },
      wire_confirmation: { status: 'received', documentId: IDS.document },
      consents: { status: 'waived' },
      side_letter: { status: 'waived' },
      closing_memo: { status: 'waived' },
    }),
    legalTerms: [legalTerm(uuid(741), 'confirmed'), legalTerm(uuid(742), 'confirmed')],
    allocations: closedAllocation,
    rowVersion: 2,
  };
  const closings = [openClosing, confirmedClosing];
  const summaryOf = (c: ClosingDetail): OpportunityDetail['closing'] => {
    const {
      opportunityId: _o,
      investmentId: _i,
      items: _it,
      legalTerms: _lt,
      allocations: _a,
      rowVersion: _rv,
      ...summary
    } = c;
    return summary;
  };
  const approvedDecision = (id: string): OpportunityDetail['icDecisions'][number] => ({
    id,
    decisionDate: '2025-05-20',
    decision: 'approved',
    amount: '2000000.00',
    conditions: ['Confirmatory legal review complete before signing'],
    recordedBy: personOf(USERS.head),
  });
  const o = IDS.opportunity;
  const opportunities: OpportunityDetail[] = [
    {
      ...opportunityRow(o.sourced, 'Sourced'),
      source: 'Sponsor introduction',
      passNote: null,
      stageHistory: history(['Sourced']),
      diligenceTasks: templateTasks(611, CO_INVEST, 'open'),
      icDecisions: [],
      allocations: [],
      closing: null,
      gates: {
        diligence: { requiredOpen: 4, ok: false },
        icDecision: { ok: false },
        closing: { checklistComplete: false, allocationTiedOut: false, ok: false },
      },
    },
    {
      ...opportunityRow(o.ic, 'IC', { receivedDate: '2025-03-01', daysInStage: 5 }),
      source: null,
      passNote: null,
      stageHistory: history(['Sourced', 'Screening', 'Prescreen', 'Diligence', 'IC']),
      diligenceTasks: templateTasks(621, CO_INVEST, 'done'),
      icDecisions: [],
      allocations: [],
      closing: null,
      gates: {
        diligence: { requiredOpen: 0, ok: true },
        icDecision: { ok: false },
        closing: { checklistComplete: false, allocationTiedOut: false, ok: false },
      },
    },
    {
      ...opportunityRow(o.closingOpen, 'Closing', { receivedDate: '2025-01-10', daysInStage: 20 }),
      source: null,
      passNote: null,
      stageHistory: history([
        'Sourced',
        'Screening',
        'Prescreen',
        'Diligence',
        'IC',
        'Approved',
        'Closing',
      ]),
      diligenceTasks: templateTasks(631, CO_INVEST, (i) => (i === 4 ? 'waived' : 'done')),
      icDecisions: [approvedDecision(uuid(641))],
      allocations: tiedAllocation,
      closing: summaryOf(openClosing),
      gates: {
        diligence: { requiredOpen: 0, ok: true },
        icDecision: { ok: true },
        closing: { checklistComplete: false, allocationTiedOut: true, ok: false },
      },
    },
    {
      ...opportunityRow(o.walled, 'Diligence', { receivedDate: '2025-04-01', daysInStage: 30 }),
      source: null,
      passNote: null,
      stageHistory: history(['Sourced', 'Screening', 'Prescreen', 'Diligence'], USERS.dealWall),
      diligenceTasks: templateTasks(661, CO_INVEST, 'open'),
      icDecisions: [],
      allocations: [],
      closing: null,
      gates: {
        diligence: { requiredOpen: 4, ok: false },
        icDecision: { ok: false },
        closing: { checklistComplete: false, allocationTiedOut: false, ok: false },
      },
    },
    {
      ...opportunityRow(o.passed, 'Passed', {
        receivedDate: '2025-02-01',
        daysInStage: 60,
        passReasonCode: 'pass_reason.sector',
      }),
      source: null,
      passNote: 'Outside the sector focus',
      stageHistory: history(['Sourced', 'Screening', 'Passed']),
      diligenceTasks: [],
      icDecisions: [],
      allocations: [],
      closing: null,
      gates: {
        diligence: { requiredOpen: 0, ok: true },
        icDecision: { ok: false },
        closing: { checklistComplete: false, allocationTiedOut: false, ok: false },
      },
    },
    {
      ...opportunityRow(o.closed, 'Closed', {
        companyName: open.companyName,
        receivedDate: '2022-10-01',
        daysInStage: 900,
        targetCommitment: '1000.00',
        investmentId: IDS.open,
      }),
      source: null,
      passNote: null,
      stageHistory: history([
        'Sourced',
        'Screening',
        'Prescreen',
        'Diligence',
        'IC',
        'Approved',
        'Closing',
        'Closed',
      ]),
      diligenceTasks: templateTasks(671, CO_INVEST, 'done'),
      icDecisions: [approvedDecision(uuid(642))],
      allocations: closedAllocation,
      closing: summaryOf(confirmedClosing),
      gates: {
        diligence: { requiredOpen: 0, ok: true },
        icDecision: { ok: true },
        closing: { checklistComplete: true, allocationTiedOut: true, ok: true },
      },
    },
  ];
  const rowOf = (d: OpportunityDetail): OpportunityRow => {
    const {
      source: _s,
      passNote: _p,
      stageHistory: _h,
      diligenceTasks: _t,
      icDecisions: _d,
      allocations: _a,
      closing: _c,
      gates: _g,
      ...row
    } = d;
    return row;
  };
  const opportunityWalled = (id: string): boolean => id === o.walled;

  const b = new FixtureBuilder(users);
  b.add('', '/api/v1/auth/mock-users', {
    users: users.map(({ externalId, displayName, roles }) => ({ externalId, displayName, roles })),
  });
  const workflows = options.workflowEndpoints ?? 'recorded';
  for (const user of users) {
    const c = user.externalId;
    const member = WALL_MEMBERS.includes(c);
    const canSee = (investmentId: string | null): boolean => investmentId !== IDS.walled || member;
    const holds = (roles: readonly Role[]): boolean => roles.some((r) => user.roles.includes(r));
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
    const visibleInvestments = Object.values(investments).filter((inv) => canSee(inv.id));
    for (const query of ['limit=100', 'active=true&limit=200'])
      b.add(c, `/api/v1/investments?${query}`, {
        items: visibleInvestments
          .filter((inv) => !query.startsWith('active=true') || inv.isActive)
          .map((inv) => investmentSummary.parse(inv)),
        nextCursor: null,
        asOf: AS_OF,
      });
    b.add(c, '/api/v1/sponsors?limit=200', {
      items: [
        {
          id: IDS.sponsor,
          name: 'Test Sponsor',
          tier: 'sponsor_tier.core',
          hqGeography: null,
          fundCount: 2,
          activeInvestments: 5,
        },
      ],
      nextCursor: null,
    });
    b.add(c, '/api/v1/vehicles', {
      items: [
        {
          id: IDS.vehicle,
          name: 'Test Vehicle I',
          vehicleType: 'vehicle_type.co_invest',
          vintage: 2022,
          activeInvestments: 5,
          lpCommitmentsTotal: null,
        },
        {
          id: IDS.vehicle2,
          name: 'Test Vehicle II',
          vehicleType: 'vehicle_type.co_invest',
          vintage: 2024,
          activeInvestments: 0,
          lpCommitmentsTotal: null,
        },
      ],
    });
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
    // The valuation detail: the recorded approval trail of the Locked version, the open change
    // requests of the position and, once Locked, the lock text.
    const visibleRequests = changeRequests.filter((r) => canSee(r.investmentId));
    for (const row of valuations) {
      const path = `/api/v1/valuations/${row.id}`;
      if (!canSee(row.investmentId) || !holds(READ_ROLES)) {
        if (!canSee(row.investmentId)) b.notFound(c, path);
        else b.forbidden(c, path);
        continue;
      }
      const approvals: ValuationApproval[] =
        row.id === v.Locked
          ? [
              {
                id: uuid(151),
                step: 'ops_prepared',
                decision: 'approve',
                actorId: USERS.ops.userId,
                actorName: USERS.ops.displayName,
                at: '2025-01-18T12:00:00.000Z',
                reason: null,
              },
              {
                id: uuid(152),
                step: 'deal_team',
                decision: 'approve',
                actorId: USERS.deal.userId,
                actorName: USERS.deal.displayName,
                at: '2025-01-19T12:00:00.000Z',
                reason: null,
              },
              {
                id: uuid(153),
                step: 'final',
                decision: 'approve',
                actorId: USERS.head.userId,
                actorName: USERS.head.displayName,
                at: '2025-01-20T12:00:00.000Z',
                reason: null,
              },
            ]
          : [];
      const detail: ValuationDetail = {
        ...row,
        approvals,
        openChangeRequests: visibleRequests.filter(
          (r) =>
            r.investmentId === row.investmentId && r.state !== 'Applied' && r.state !== 'Rejected',
        ),
        lockText: row.state === 'Locked' ? valuationLockText(row) : null,
      };
      b.add(c, path, detail);
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
      const register = registerOfNotice(notice);
      const pending = pendingChange(register, AS_OF, HOLD_DAYS);
      const changedOn = pending === null ? null : pending.proposedAt.slice(0, 10);
      const until = changedOn === null ? null : '2025-07-30';
      const settled = notice.settledAmount !== null;
      const cashFlows: CapitalNoticeControlDetail['cashFlows'] = settled
        ? [
            {
              date: '2025-06-15',
              flowType: 'flow_type.contribution',
              amount: `-${notice.amount}`,
              status: 'record_status.approved',
            },
          ]
        : [];
      const notes: string[] = [];
      if (changedOn !== null && until !== null)
        notes.push(
          `Wire instructions changed on ${fmtDate(changedOn)}; release is held until ${fmtDate(until)} (SEC-12.3).`,
        );
      if (!settled) notes.push('No cash flow has been recorded for this notice.');
      const ticket = ticketBase.find((t) => t.capitalNoticeId === notice.id);
      const wireChange = notice.scenarioTag === 'wire_change';
      const detail: CapitalNoticeControlDetail = {
        ...notice,
        cashFlows,
        wireChangeHold: until === null ? null : { until, holdDays: HOLD_DAYS },
        notes,
        ticket: ticket === undefined ? null : ticketFor(ticket, user),
        activeWireInstruction: register.active,
        alerts: noticeAlerts({
          state: notice.state,
          urgencyFlag: wireChange,
          wireChangeFlag: wireChange,
          dueDate: notice.dueDate,
          asOf: AS_OF,
          dueSoonBusinessDays: DUE_SOON_BUSINESS_DAYS,
          wireVerified: register.active !== null,
        }),
      };
      b.add(c, path, detail);
    }

    // The register (no wall) for its roles; every other role recorded as the API's 403.
    if (holds(WIRE_ROLES)) {
      b.add(c, WIRES_PATH, { items: wires, nextCursor: null });
      for (const w of wires)
        b.add(c, `/api/v1/wire-instructions/${w.id}`, { ...w, bankDetails: null });
    } else {
      b.forbidden(c, WIRES_PATH);
      for (const w of wires) b.forbidden(c, `/api/v1/wire-instructions/${w.id}`);
    }

    // The tickets follow their notice's wall.
    if (holds(TICKET_ROLES)) {
      const visible = ticketBase
        .filter((t) =>
          canSee(notices.find((x) => x.id === t.capitalNoticeId)?.investmentId ?? null),
        )
        .map((t) => ticketFor(t, user));
      b.add(c, TICKETS_PATH, { items: visible, nextCursor: null });
      for (const t of ticketBase) {
        const path = `/api/v1/trade-tickets/${t.id}`;
        const row = visible.find((x) => x.id === t.id);
        if (row === undefined) b.notFound(c, path);
        else b.add(c, path, row);
      }
    } else {
      b.forbidden(c, TICKETS_PATH);
      for (const t of ticketBase) b.forbidden(c, `/api/v1/trade-tickets/${t.id}`);
    }

    // The change requests follow their position's wall.
    if (holds(CHANGE_REQUEST_ROLES)) {
      b.add(c, CHANGE_REQUESTS_PATH, {
        items: [...visibleRequests].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)),
        nextCursor: null,
      });
      for (const r of changeRequests) {
        const path = `/api/v1/change-requests/${r.id}`;
        if (canSee(r.investmentId)) b.add(c, path, r);
        else b.notFound(c, path);
      }
    } else {
      b.forbidden(c, CHANGE_REQUESTS_PATH);
      for (const r of changeRequests) b.forbidden(c, `/api/v1/change-requests/${r.id}`);
    }

    // The pipeline: the walled deal is absent for a non-member; the closings follow their deal.
    if (holds(READ_ROLES)) {
      const visibleDeals = opportunities.filter((d) => !opportunityWalled(d.id) || member);
      b.add(c, OPPORTUNITIES_PATH, {
        items: [...visibleDeals]
          .map(rowOf)
          .sort((x, y) =>
            x.receivedDate < y.receivedDate ? 1 : x.receivedDate > y.receivedDate ? -1 : 0,
          ),
        nextCursor: null,
      });
      for (const d of opportunities) {
        const path = `/api/v1/opportunities/${d.id}`;
        if (opportunityWalled(d.id) && !member) b.notFound(c, path);
        else b.add(c, path, d);
      }
      for (const cl of closings) b.add(c, `/api/v1/closings/${cl.id}`, cl);
    } else {
      b.forbidden(c, OPPORTUNITIES_PATH);
      for (const d of opportunities) b.forbidden(c, `/api/v1/opportunities/${d.id}`);
      for (const cl of closings) b.forbidden(c, `/api/v1/closings/${cl.id}`);
    }
  }
  return {
    fixtures: b.build(),
    investments,
    valuations,
    notices,
    wires,
    tickets,
    changeRequests,
    opportunities,
    closings,
  };
}
