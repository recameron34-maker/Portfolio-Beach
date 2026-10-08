import type {
  AuditPage,
  CapitalNoticePage,
  InvestmentDetail,
  InvestmentPerformance,
  Principal,
  QuarterRow,
  SponsorDetail,
  ValuationPage,
  ValuationRow,
} from '@pb/contracts';
import {
  AS_OF,
  capitalNoticePageFixture,
  ID,
  investmentFixture,
  noticeFixture,
  performanceFixture,
  pooledFixture,
  principalFixture,
} from './fixtures.js';

/* Contract-shaped synthetic fixtures for the deal workspace tabs (docs/12 section 4: synthetic data only). */

export const DEAL_ID = ID.inv1;

export const DEAL_IDS = {
  company: '00000000-0000-4000-8000-0000000000e1',
  fundIv: '00000000-0000-4000-8000-0000000000f1',
  fundI: '00000000-0000-4000-8000-0000000000f2',
  vehicleSma: '00000000-0000-4000-8000-0000000000b4',
  vehicleCv: '00000000-0000-4000-8000-0000000000b5',
  notice2: '00000000-0000-4000-8000-0000000000d2',
  notice3: '00000000-0000-4000-8000-0000000000d3',
  valuation1: '00000000-0000-4000-8000-000000000101',
  valuation2: '00000000-0000-4000-8000-000000000102',
  valuation3: '00000000-0000-4000-8000-000000000103',
  valuation4: '00000000-0000-4000-8000-000000000104',
} as const;

/** The paths the deal tabs read, exactly as the query options build them. */
export const DEAL_PATHS = {
  me: '/api/v1/auth/me',
  detail: `/api/v1/investments/${DEAL_ID}`,
  performance: `/api/v1/investments/${DEAL_ID}/performance`,
  valuations: `/api/v1/valuations?limit=200&investmentId=${DEAL_ID}`,
  notices: `/api/v1/capital-notices?limit=200&investmentId=${DEAL_ID}`,
  sponsor: `/api/v1/sponsors/${ID.sponsor1}`,
  audit: `/api/v1/audit/events?limit=100&entityId=${DEAL_ID}`,
} as const;

const METHOD = 'valuation_method.sponsor_mark';

/** An equity co-investment with four valuation versions, one of them reopened, and two cash flows. */
export function dealDetailFixture(overrides: Partial<InvestmentDetail> = {}): InvestmentDetail {
  return {
    // The summary row carries the vehicle and sponsor ids (ID.vehicle1, ID.sponsor1).
    ...investmentFixture(),
    companyId: DEAL_IDS.company,
    sponsorFundId: DEAL_IDS.fundIv,
    companyDescription: 'Synthetic portfolio company.',
    latestPeriodEnd: AS_OF,
    cashFlows: [
      { date: '2018-11-15', flowType: 'flow_type.contribution', amount: '-6900000.00' },
      { date: '2024-07-30', flowType: 'flow_type.distribution', amount: '2200000.00' },
    ],
    valuations: [
      {
        periodEnd: '2024-12-31',
        version: 1,
        state: 'Locked',
        fairValue: '25100000.00',
        method: METHOD,
      },
      {
        periodEnd: '2025-03-31',
        version: 1,
        state: 'Reopened',
        fairValue: '26800000.00',
        method: METHOD,
      },
      {
        periodEnd: '2025-03-31',
        version: 2,
        state: 'Locked',
        fairValue: '26000000.00',
        method: METHOD,
      },
      {
        periodEnd: AS_OF,
        version: 1,
        state: 'OpsPrepared',
        fairValue: '27400000.00',
        method: METHOD,
      },
    ],
    credit: null,
    operating: {
      periodEnd: '2025-03-31',
      revenueLtm: '13878398.06',
      ebitdaLtm: '4138835.16',
      ev: '42674102.25',
      netDebt: '11640057.58',
      evToEbitda: '10.3106551965',
      netDebtToEbitda: '2.8123994143',
      ebitdaMargin: '0.29822139',
      revenueYoy: '0.0948865317',
      ebitdaYoy: '0.0618767854',
      priorYearPeriodEnd: '2024-03-31',
    },
    ...overrides,
  };
}

/** A private credit position: funded, fair value and the latest quarter's par and yield. */
export function creditDetailFixture(overrides: Partial<InvestmentDetail> = {}): InvestmentDetail {
  return dealDetailFixture({
    companyName: 'Summit Services Co',
    investmentNumber: 'INV-0013',
    dealType: 'deal_type.private_credit',
    vehicleName: 'Beach Credit Partners I',
    invested: '9937711.38',
    distributions: '2066965.86',
    nav: '9859053.48',
    grossMoic: '1.2000770483',
    grossIrr: '0.0310800657',
    operating: null,
    credit: {
      facilityType: 'facility_type.unitranche',
      baseRate: 'base_rate.sofr',
      spread: '0.0600',
      cashCoupon: '0.0900',
      pikCoupon: '0.0200',
      maturityDate: '2024-10-22',
      latest: {
        periodEnd: AS_OF,
        parValue: '9859053.48',
        fairValue: '9859053.48',
        currentYield: '0.1123',
        interestCoverage: '1.8',
        leverageThroughTranche: '5.2',
        loanToValue: '0.55',
        covenantStatus: 'covenant_status.waiver',
        paymentStatus: 'payment_status.current',
      },
    },
    ...overrides,
  });
}

const quarter = (
  periodEnd: string,
  values: Partial<QuarterRow>,
  highlights: string[] = [],
): QuarterRow => ({
  periodEnd,
  isEntrySnapshot: false,
  status: 'record_status.approved',
  revenueLtm: null,
  ebitdaLtm: null,
  ev: null,
  netDebt: null,
  cash: null,
  totalEquity: null,
  evToEbitda: null,
  netDebtToEbitda: null,
  ebitdaMargin: null,
  revenueYoy: null,
  ebitdaYoy: null,
  highlights,
  ...values,
});

export const ENTRY_SNAPSHOT: QuarterRow = quarter('2018-09-30', {
  isEntrySnapshot: true,
  revenueLtm: '11652096.41',
  ebitdaLtm: '3588845.69',
  ev: '37611102.86',
  netDebt: '12787774.97',
  cash: '1128333.09',
  totalEquity: '24823327.89',
  evToEbitda: '10.48',
  netDebtToEbitda: '3.5632',
  ebitdaMargin: '0.308',
});

/**
 * Equity series: the entry snapshot, two approved quarters and a draft latest quarter (left out
 * of the chart and of growth since entry, which runs to the latest approved quarter).
 */
export function equityPerformanceFixture(
  overrides: Partial<InvestmentPerformance> = {},
): InvestmentPerformance {
  return {
    investmentId: DEAL_ID,
    asOf: AS_OF,
    entry: ENTRY_SNAPSHOT,
    quarters: [
      quarter(
        '2024-12-31',
        {
          revenueLtm: '13577836.77',
          ebitdaLtm: '4079426.49',
          ev: '42210277.73',
          netDebt: '11777073.26',
          cash: '1266308.33',
          totalEquity: '30433204.47',
          evToEbitda: '10.3471107602',
          netDebtToEbitda: '2.8869433703',
          ebitdaMargin: '0.3004474541',
          revenueYoy: '0.1041595689',
          ebitdaYoy: '0.0846566434',
        },
        ['Pricing held through the quarter.'],
      ),
      quarter(
        '2025-03-31',
        {
          revenueLtm: '13878398.06',
          ebitdaLtm: '4138835.16',
          ev: '42674102.25',
          netDebt: '11640057.58',
          cash: '1280223.07',
          totalEquity: '31034044.67',
          evToEbitda: '10.3106551965',
          netDebtToEbitda: '2.8123994143',
          ebitdaMargin: '0.29822139',
          revenueYoy: '0.0948865317',
          ebitdaYoy: '0.0618767854',
        },
        [
          'LTM revenue grew with new customer wins.',
          'Management completed one add-on acquisition.',
        ],
      ),
      quarter(
        AS_OF,
        {
          status: 'record_status.draft',
          revenueLtm: '14088185.61',
          ebitdaLtm: '4168976.44',
          ev: '42864663.17',
          netDebt: '11561000.47',
          cash: '1285939.89',
          totalEquity: '31303662.69',
          evToEbitda: '10.2818194794',
          netDebtToEbitda: '2.7731028554',
          ebitdaMargin: '0.2959200393',
        },
        ['Draft commentary from the quarterly letter.'],
      ),
    ],
    sinceEntry: {
      periodEnd: '2025-03-31',
      revenueGrowth: '0.1910',
      ebitdaGrowth: '0.1532',
      multipleDelta: '-0.1693',
      evToEbitdaAtEntry: '10.48',
      netDebtToEbitdaAtEntry: '3.5632',
    },
    credit: null,
    realizationOutlook: {
      horizonMonths: 18,
      outlook: 'realization_outlook.partial',
      note: 'Sponsor has engaged advisors.',
      setAt: '2025-05-02T09:30:00.000Z',
    },
    calcVersion: '0.1.0',
    ...overrides,
  };
}

/** The shared credit series (fixtures.ts) for this position. */
export function creditPerformanceFixture(
  overrides: Partial<InvestmentPerformance> = {},
): InvestmentPerformance {
  return performanceFixture({ investmentId: DEAL_ID, ...overrides });
}

export function valuationRowFixture(overrides: Partial<ValuationRow> = {}): ValuationRow {
  return {
    id: DEAL_IDS.valuation1,
    investmentId: DEAL_ID,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    vehicleName: 'Beach Co-Invest Fund I',
    dealType: 'deal_type.co_invest_equity',
    periodEnd: overrides.periodEnd ?? '2024-12-31',
    quarterEnd: overrides.periodEnd ?? '2024-12-31',
    version: 1,
    state: 'Locked',
    method: METHOD,
    fairValue: '25100000.00',
    priorFairValue: null,
    changePct: null,
    lockHash: 'lock-hash-1',
    preparedBy: ID.user,
    dealTeamApprovedBy: ID.user,
    approvedBy: ID.user,
    approvedAt: '2025-01-25T15:00:00.000Z',
    reopenReason: null,
    rowVersion: 3,
    ...overrides,
  };
}

/** Four versions in API order (oldest first): Locked, Reopened with a reason, its Locked v2, and a version in review. */
export function valuationPageFixture(items?: ValuationRow[]): ValuationPage {
  return {
    items: items ?? [
      valuationRowFixture(),
      valuationRowFixture({
        id: DEAL_IDS.valuation2,
        periodEnd: '2025-03-31',
        version: 1,
        state: 'Reopened',
        fairValue: '26800000.00',
        priorFairValue: '25100000.00',
        changePct: '0.0677',
        approvedAt: '2025-04-10T15:00:00.000Z',
        reopenReason: 'Sponsor restated the quarter.',
      }),
      valuationRowFixture({
        id: DEAL_IDS.valuation3,
        periodEnd: '2025-03-31',
        version: 2,
        state: 'Locked',
        fairValue: '26000000.00',
        priorFairValue: '25100000.00',
        changePct: '0.0359',
        approvedAt: '2025-04-20T15:00:00.000Z',
      }),
      valuationRowFixture({
        id: DEAL_IDS.valuation4,
        periodEnd: AS_OF,
        version: 1,
        state: 'OpsPrepared',
        fairValue: '27400000.00',
        priorFairValue: '26000000.00',
        changePct: '0.0538',
        lockHash: null,
        dealTeamApprovedBy: null,
        approvedBy: null,
        approvedAt: null,
      }),
    ],
    nextCursor: null,
    asOf: AS_OF,
    periods: [AS_OF, '2025-03-31', '2024-12-31'],
  };
}

/** Three notices for the position: one overdue, one due soon, one settled. */
export function dealNoticePageFixture(): CapitalNoticePage {
  return capitalNoticePageFixture([
    noticeFixture(),
    noticeFixture({
      id: DEAL_IDS.notice2,
      noticeType: 'notice_type.distribution',
      state: 'Reconciled',
      issueDate: '2024-07-20',
      dueDate: '2024-07-30',
      amount: '2200000.00',
      settledAmount: '2200000.00',
      daysToDue: -335,
    }),
    noticeFixture({
      id: DEAL_IDS.notice3,
      state: 'TicketApproved',
      issueDate: '2025-06-24',
      dueDate: '2025-07-02',
      amount: '1250000.00',
      daysToDue: 2,
    }),
  ]);
}

export function sponsorDetailFixture(overrides: Partial<SponsorDetail> = {}): SponsorDetail {
  return {
    id: ID.sponsor1,
    name: 'Kelpwood Capital Partners',
    tier: 'sponsor_tier.active',
    hqGeography: 'geography.north_america',
    fundCount: 2,
    activeInvestments: 2,
    asOf: AS_OF,
    description: 'Control buyouts and growth investments in the middle market.',
    funds: [
      {
        id: DEAL_IDS.fundIv,
        name: 'Kelpwood Fund IV',
        vintage: 2018,
        strategy: 'strategy.buyout',
        sizeTarget: '500000000.00',
        sizeFinal: null,
        currency: 'USD',
        aliases: ['KF IV'],
        holdings: 4,
        ourPositions: 2,
        ourCommitment: '22000000',
      },
      {
        id: DEAL_IDS.fundI,
        name: 'Kelpwood Fund I',
        vintage: 2015,
        strategy: 'strategy.growth',
        sizeTarget: '4000000000.00',
        sizeFinal: '3916747832.95',
        currency: 'USD',
        aliases: [],
        holdings: 3,
        ourPositions: 1,
        ourCommitment: null,
      },
    ],
    positions: [
      investmentFixture(),
      investmentFixture({
        id: ID.inv2,
        investmentNumber: 'INV-0002',
        companyName: 'Juniper Financial Group',
        vehicleId: DEAL_IDS.vehicleSma,
        vehicleName: 'Client Gamma Separate Account',
      }),
      investmentFixture({
        id: ID.inv3,
        investmentNumber: 'INV-0017',
        companyName: 'Penrose Foods Holdings',
        vehicleId: DEAL_IDS.vehicleCv,
        vehicleName: 'Beach CV Opportunities I',
        dealType: 'deal_type.cv_single_asset',
        isActive: false,
        exitDate: '2020-09-01',
      }),
    ],
    commitments: [],
    metrics: pooledFixture({
      count: 3,
      invested: '156361407.64',
      nav: '189713276.90',
      grossMoic: '1.2523',
    }),
    totalCommitted: '22000000',
    calcVersion: '0.1.0',
    ...overrides,
  };
}

export function auditPageFixture(overrides: Partial<AuditPage> = {}): AuditPage {
  return {
    items: [
      {
        id: '12',
        at: '2025-07-01T09:15:00.000Z',
        actorName: 'Avery Mbeki',
        actorType: 'user',
        action: 'investment.performance.read',
        entity: 'core.investment',
        entityId: DEAL_ID,
        reason: null,
        requestId: 'req-2',
      },
      {
        id: '11',
        at: '2025-06-30T17:02:11.000Z',
        actorName: null,
        actorType: 'service',
        action: 'valuation.lock',
        entity: 'mon.valuation',
        entityId: DEAL_ID,
        reason: 'Quarter-end close',
        requestId: 'req-1',
      },
    ],
    nextCursor: null,
    ...overrides,
  };
}

export function operationsPrincipalFixture(): Principal {
  return {
    ...principalFixture(),
    externalId: 'ops.one',
    displayName: 'Avery Mbeki',
    roles: ['operations'],
  };
}
