import { vi } from 'vitest';
import { valuationLockText } from '@pb/contracts';
import type {
  ChangeRequestPage,
  ChangeRequestRow,
  InvestmentSummary,
  MockUser,
  Principal,
  ProblemDetails,
  QuarterEndCheckResult,
  Taxonomy,
  ValuationDetail,
  ValuationPage,
  ValuationRow,
  VehicleSummary,
} from '@pb/contracts';
import { AS_OF, ID, investmentFixture, principalFixture } from './fixtures.js';

/* Contract-shaped synthetic fixtures for the valuation board (docs/12 section 4: synthetic data only). */

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Requests the page sent through the mockApi fetch spy, as [path and query, method, parsed body]. */
export function sentRequests(): [string, string, unknown][] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input, init]) => [
      urlOf(input),
      init?.method ?? 'GET',
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    ]);
}

/** The POST requests only, as [path, parsed body]. */
export function sentPosts(): [string, unknown][] {
  return sentRequests()
    .filter(([, method]) => method === 'POST')
    .map(([url, , body]) => [url, body]);
}

export const PRIOR_PERIOD = '2025-03-31';

export const VAL_ID = {
  draft: '00000000-0000-4000-8000-000000000101',
  prepared: '00000000-0000-4000-8000-000000000102',
  approved: '00000000-0000-4000-8000-000000000103',
  locked: '00000000-0000-4000-8000-000000000104',
  reopened: '00000000-0000-4000-8000-000000000105',
  lockedV2: '00000000-0000-4000-8000-000000000106',
  priorLocked: '00000000-0000-4000-8000-000000000107',
  priorOther: '00000000-0000-4000-8000-000000000108',
} as const;

export const POSITION_ID = {
  meridian: ID.inv1,
  silverline: '00000000-0000-4000-8000-000000000204',
  cobalt: '00000000-0000-4000-8000-000000000207',
  ashby: ID.inv3,
  summit: ID.inv2,
  summitCare: '00000000-0000-4000-8000-000000000215',
} as const;

export const USER_ID = {
  ops: '00000000-0000-4000-8000-000000000301',
  deal: '00000000-0000-4000-8000-000000000302',
  approver: '00000000-0000-4000-8000-000000000303',
  opsTwo: '00000000-0000-4000-8000-000000000304',
} as const;

/** The people the fixtures name, as the API names them on a record. */
export const PERSON = {
  ops: { id: USER_ID.ops, name: 'Avery Mbeki' },
  opsTwo: { id: USER_ID.opsTwo, name: 'Rowan Castellanos' },
  deal: { id: USER_ID.deal, name: 'Blake Okafor' },
  approver: { id: USER_ID.approver, name: 'Morgan Lindqvist' },
} as const;

/** The role switcher's list with ids, as the API answers it: two operations users among the four. */
export function mockUsersFixture(): { users: MockUser[] } {
  return {
    users: [
      {
        id: USER_ID.ops,
        externalId: 'ops.one',
        displayName: PERSON.ops.name,
        roles: ['operations'],
      },
      {
        id: USER_ID.opsTwo,
        externalId: 'ops.two',
        displayName: PERSON.opsTwo.name,
        roles: ['operations'],
      },
      {
        id: USER_ID.deal,
        externalId: 'deal.one',
        displayName: PERSON.deal.name,
        roles: ['deal_team'],
      },
      {
        id: USER_ID.approver,
        externalId: 'head.one',
        displayName: PERSON.approver.name,
        roles: ['approver'],
      },
    ],
  };
}

/** The signed-in user with the given roles (the board reads principal.roles). */
export function rolePrincipal(roles: Principal['roles']): Principal {
  return { ...principalFixture(), userId: USER_ID.ops, roles };
}

export function valuationRowFixture(overrides: Partial<ValuationRow> = {}): ValuationRow {
  return {
    id: VAL_ID.locked,
    investmentId: POSITION_ID.meridian,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    vehicleName: 'Beach Co-Invest Fund I',
    dealType: 'deal_type.co_invest_equity',
    periodEnd: overrides.periodEnd ?? AS_OF,
    quarterEnd: overrides.periodEnd ?? AS_OF,
    version: 1,
    state: 'Locked',
    method: 'valuation_method.sponsor_mark',
    fairValue: '27400000.00',
    priorFairValue: '25000000.00',
    changePct: '0.096',
    lockHash: 'h-00000104',
    preparedBy: USER_ID.ops,
    dealTeamApprovedBy: USER_ID.deal,
    approvedBy: USER_ID.approver,
    approvedAt: '2025-08-09T15:00:00Z',
    reopenReason: null,
    rowVersion: 3,
    ...overrides,
  };
}

/** One version in each state for the latest period, a superseded version and two prior-quarter marks. */
export function valuationRows(): ValuationRow[] {
  const inFlight = {
    lockHash: null,
    dealTeamApprovedBy: null,
    approvedBy: null,
    approvedAt: null,
  };
  return [
    valuationRowFixture({
      ...inFlight,
      id: VAL_ID.draft,
      investmentId: POSITION_ID.cobalt,
      investmentNumber: 'INV-0007',
      companyName: 'Cobalt Energy Group',
      vehicleName: 'Beach Co-Invest Fund III',
      state: 'Draft',
      method: 'valuation_method.market_multiple',
      fairValue: '15000000.00',
      priorFairValue: '14500000.00',
      changePct: '0.0345',
      preparedBy: null,
      rowVersion: 1,
    }),
    valuationRowFixture({
      ...inFlight,
      id: VAL_ID.prepared,
      investmentId: POSITION_ID.silverline,
      investmentNumber: 'INV-0004',
      companyName: 'Silverline Staffing Holdings',
      state: 'OpsPrepared',
      fairValue: '8100000.00',
      priorFairValue: '10200000.00',
      changePct: '-0.2059',
      rowVersion: 2,
    }),
    valuationRowFixture({
      ...inFlight,
      id: VAL_ID.approved,
      investmentId: POSITION_ID.summit,
      investmentNumber: 'INV-0013',
      companyName: 'Summit Services Co',
      vehicleName: 'Beach Credit Partners I',
      dealType: 'deal_type.private_credit',
      state: 'DealTeamApproved',
      method: 'valuation_method.par_plus_accrued',
      fairValue: '9859053.48',
      priorFairValue: '9700000.00',
      changePct: '0.0164',
      lockHash: 'h-00000103',
      dealTeamApprovedBy: USER_ID.deal,
      rowVersion: 3,
    }),
    valuationRowFixture(),
    valuationRowFixture({
      id: VAL_ID.reopened,
      investmentId: POSITION_ID.ashby,
      investmentNumber: 'INV-0012',
      companyName: 'Ashby Renewables Group',
      vehicleName: 'Beach CV Opportunities I',
      dealType: 'deal_type.cv_single_asset',
      state: 'Reopened',
      fairValue: '81500000.00',
      priorFairValue: '76000000.00',
      changePct: '0.0724',
      reopenReason: 'Quarterly financials restated',
      rowVersion: 4,
    }),
    valuationRowFixture({
      id: VAL_ID.lockedV2,
      investmentId: POSITION_ID.ashby,
      investmentNumber: 'INV-0012',
      companyName: 'Ashby Renewables Group',
      vehicleName: 'Beach CV Opportunities I',
      dealType: 'deal_type.cv_single_asset',
      version: 2,
      fairValue: '79062720.52',
      priorFairValue: '76000000.00',
      changePct: '0.0403',
      lockHash: 'h-00000106',
      approvedAt: '2025-08-20T15:00:00Z',
    }),
    valuationRowFixture({
      id: VAL_ID.priorLocked,
      periodEnd: PRIOR_PERIOD,
      fairValue: '25000000.00',
      priorFairValue: '24100000.00',
      changePct: '0.0373',
      lockHash: 'h-00000107',
      approvedAt: '2025-05-10T15:00:00Z',
    }),
    valuationRowFixture({
      id: VAL_ID.priorOther,
      investmentId: POSITION_ID.summitCare,
      investmentNumber: 'INV-0015',
      companyName: 'Summit Care Holdings',
      vehicleName: 'Beach CV Opportunities I',
      dealType: 'deal_type.cv_single_asset',
      periodEnd: PRIOR_PERIOD,
      fairValue: '41000000.00',
      priorFairValue: null,
      changePct: null,
      lockHash: 'h-00000108',
      approvedAt: '2025-05-10T15:00:00Z',
    }),
  ];
}

export function valuationPageFixture(
  items: ValuationRow[] = valuationRows(),
  nextCursor: string | null = null,
): ValuationPage {
  return { items, nextCursor, asOf: AS_OF, periods: [AS_OF, PRIOR_PERIOD] };
}

/** Six active positions; Summit Care Holdings has no version for the latest period. */
export function activePositions(): InvestmentSummary[] {
  const at = (
    id: string,
    investmentNumber: string,
    companyName: string,
    vehicleName: string,
    dealType = 'deal_type.co_invest_equity',
  ): InvestmentSummary => {
    // Each position links to the vehicle of the same name in vehicleListFixture.
    const vehicle = vehicleListFixture().items.find((v) => v.name === vehicleName);
    if (vehicle === undefined) throw new Error(`no vehicle fixture named ${vehicleName}`);
    return investmentFixture({
      id,
      investmentNumber,
      companyName,
      vehicleId: vehicle.id,
      vehicleName,
      dealType,
    });
  };
  return [
    at(POSITION_ID.meridian, 'INV-0001', 'Meridian Data Partners', 'Beach Co-Invest Fund I'),
    at(
      POSITION_ID.silverline,
      'INV-0004',
      'Silverline Staffing Holdings',
      'Beach Co-Invest Fund I',
    ),
    at(POSITION_ID.cobalt, 'INV-0007', 'Cobalt Energy Group', 'Beach Co-Invest Fund III'),
    at(
      POSITION_ID.ashby,
      'INV-0012',
      'Ashby Renewables Group',
      'Beach CV Opportunities I',
      'deal_type.cv_single_asset',
    ),
    at(
      POSITION_ID.summit,
      'INV-0013',
      'Summit Services Co',
      'Beach Credit Partners I',
      'deal_type.private_credit',
    ),
    at(
      POSITION_ID.summitCare,
      'INV-0015',
      'Summit Care Holdings',
      'Beach CV Opportunities I',
      'deal_type.cv_single_asset',
    ),
  ];
}

export function vehicleListFixture(): { items: VehicleSummary[] } {
  const v = (id: string, name: string, vehicleType: string, vintage: number): VehicleSummary => ({
    id,
    name,
    vehicleType,
    vintage,
    activeInvestments: 2,
    lpCommitmentsTotal: null,
  });
  return {
    items: [
      v(ID.vehicle1, 'Beach Co-Invest Fund I', 'vehicle_type.co_invest', 2016),
      v(ID.vehicle2, 'Beach Credit Partners I', 'vehicle_type.private_credit', 2020),
      v(
        '00000000-0000-4000-8000-0000000000b3',
        'Beach Co-Invest Fund III',
        'vehicle_type.co_invest',
        2022,
      ),
      v(
        '00000000-0000-4000-8000-0000000000b4',
        'Beach CV Opportunities I',
        'vehicle_type.cv',
        2021,
      ),
    ],
  };
}

/** A workflow refusal as the API and the preview simulation send it (docs/17 section 3). */
export function refusalFixture(status: 403 | 409 | 422, detail: string): ProblemDetails {
  return {
    type: 'https://portfolio-beach.example/problems/workflow-precondition',
    title: status === 422 ? 'Unprocessable' : status === 409 ? 'Conflict' : 'Forbidden',
    status,
    detail,
    request_id: 'test',
  };
}

/* ---- Phase 3 (docs/04 M10 and M11): the version screen and the deal change requests ---- */

export const CR_ID = {
  submitted: '00000000-0000-4000-8000-000000000501',
  routed: '00000000-0000-4000-8000-000000000502',
  inProgress: '00000000-0000-4000-8000-000000000503',
  applied: '00000000-0000-4000-8000-000000000504',
  rejected: '00000000-0000-4000-8000-000000000505',
} as const;

export function changeRequestRowFixture(
  overrides: Partial<ChangeRequestRow> = {},
): ChangeRequestRow {
  return {
    id: CR_ID.submitted,
    investmentId: POSITION_ID.meridian,
    investmentName: 'Meridian Data Partners',
    changeType: 'change_type.add_on_acquisition',
    effectiveDate: '2025-05-15',
    summary: 'Add-on acquisition of a regional competitor closed',
    details: { target: 'A regional competitor', consideration: '4000000.00' },
    owner: null,
    submittedBy: PERSON.deal,
    state: 'Submitted',
    appliedPeriod: null,
    appliedBy: null,
    rejectionReason: null,
    createdAt: '2025-06-20T09:00:00Z',
    rowVersion: 1,
    ...overrides,
  };
}

/** One request in each state, newest first as the API lists them, on five of the fixture positions. */
export function changeRequestRows(): ChangeRequestRow[] {
  return [
    changeRequestRowFixture(),
    changeRequestRowFixture({
      id: CR_ID.routed,
      investmentId: POSITION_ID.silverline,
      investmentName: 'Silverline Staffing Holdings',
      changeType: 'change_type.recapitalization',
      effectiveDate: '2025-04-30',
      summary: 'Dividend recapitalization with a new term loan',
      details: { facility: 'Term loan B' },
      owner: PERSON.ops,
      state: 'Routed',
      createdAt: '2025-06-10T09:00:00Z',
      rowVersion: 2,
    }),
    changeRequestRowFixture({
      id: CR_ID.inProgress,
      investmentId: POSITION_ID.cobalt,
      investmentName: 'Cobalt Energy Group',
      changeType: 'change_type.new_security',
      effectiveDate: '2025-03-31',
      summary: 'Preferred equity issued to a new investor',
      details: {},
      owner: PERSON.ops,
      state: 'InProgress',
      createdAt: '2025-05-02T09:00:00Z',
      rowVersion: 3,
    }),
    changeRequestRowFixture({
      id: CR_ID.applied,
      investmentId: POSITION_ID.ashby,
      investmentName: 'Ashby Renewables Group',
      changeType: 'change_type.partial_exit',
      effectiveDate: '2025-02-15',
      summary: 'Partial exit of a fifth of the holding to a strategic buyer',
      details: { buyer: 'A strategic buyer' },
      owner: PERSON.ops,
      state: 'Applied',
      appliedPeriod: '2025-03-31',
      appliedBy: PERSON.ops,
      createdAt: '2025-02-20T09:00:00Z',
      rowVersion: 4,
    }),
    changeRequestRowFixture({
      id: CR_ID.rejected,
      investmentId: POSITION_ID.summit,
      investmentName: 'Summit Services Co',
      changeType: 'change_type.distribution_treatment',
      effectiveDate: '2025-01-20',
      summary: 'Interest payment to be treated as a distribution',
      details: {},
      owner: PERSON.ops,
      state: 'Rejected',
      rejectionReason: 'Already reflected in the record',
      createdAt: '2025-01-25T09:00:00Z',
      rowVersion: 3,
    }),
  ];
}

export function changeRequestPageFixture(
  items: ChangeRequestRow[] = changeRequestRows(),
  nextCursor: string | null = null,
): ChangeRequestPage {
  return { items, nextCursor };
}

/** The quarter-end check at the as-of quarter: the three open requests, two of them newly listed. */
export function quarterEndCheckFixture(): QuarterEndCheckResult {
  const rows = changeRequestRows();
  return {
    periodEnd: AS_OF,
    unapplied: rows.filter((r) => r.state !== 'Applied' && r.state !== 'Rejected'),
    exceptionsOpened: 2,
  };
}

/** The Locked Meridian version with its three approvals, one open request and the lock text. */
export function valuationDetailFixture(overrides: Partial<ValuationDetail> = {}): ValuationDetail {
  const row = valuationRowFixture(overrides);
  return {
    ...row,
    approvals: [
      {
        id: '00000000-0000-4000-8000-000000000601',
        step: 'ops_prepared',
        decision: 'approve',
        actorId: PERSON.ops.id,
        actorName: PERSON.ops.name,
        at: '2025-07-20T10:00:00Z',
        reason: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000602',
        step: 'deal_team',
        decision: 'approve',
        actorId: PERSON.deal.id,
        actorName: PERSON.deal.name,
        at: '2025-08-01T10:00:00Z',
        reason: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000603',
        step: 'final',
        decision: 'approve',
        actorId: PERSON.approver.id,
        actorName: PERSON.approver.name,
        at: '2025-08-09T15:00:00Z',
        reason: null,
      },
    ],
    openChangeRequests: [changeRequestRowFixture()],
    lockText: valuationLockText(row),
    ...overrides,
  };
}

/** The change_type domain as migration 0013 seeds it, for the request form's picker. */
export function changeTypeTaxonomyFixture(): Taxonomy {
  const terms: [string, string][] = [
    ['add_on_acquisition', 'Add-on acquisition'],
    ['new_security', 'New security'],
    ['distribution_treatment', 'Distribution treatment'],
    ['recapitalization', 'Recapitalization'],
    ['partial_exit', 'Partial exit'],
    ['ownership_change', 'Ownership change'],
    ['name_change', 'Name change'],
    ['structure_change', 'Structure change'],
    ['other', 'Other'],
  ];
  return {
    domains: [
      {
        domain: 'change_type',
        terms: terms.map(([code, label], i) => ({
          code: `change_type.${code}`,
          label,
          parentCode: null,
          active: true,
          sortOrder: i + 1,
        })),
      },
    ],
  };
}
