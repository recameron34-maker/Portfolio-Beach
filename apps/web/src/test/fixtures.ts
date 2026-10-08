import type {
  AnalyticsSummary,
  CapitalNoticePage,
  CapitalNoticeRow,
  DataHealth,
  ExposureBucket,
  InvestmentPage,
  InvestmentPerformance,
  InvestmentSummary,
  PooledMetrics,
  Principal,
  Watchlist,
} from '@pb/contracts';

/* Contract-shaped synthetic fixtures for the page tests (docs/12 section 4: synthetic data only). */

export const ID = {
  inv1: '00000000-0000-4000-8000-000000000001',
  inv2: '00000000-0000-4000-8000-000000000002',
  inv3: '00000000-0000-4000-8000-000000000003',
  user: '00000000-0000-4000-8000-0000000000aa',
  vehicle1: '00000000-0000-4000-8000-0000000000b1',
  vehicle2: '00000000-0000-4000-8000-0000000000b2',
  sponsor1: '00000000-0000-4000-8000-0000000000c1',
  notice1: '00000000-0000-4000-8000-0000000000d1',
} as const;

export const AS_OF = '2025-06-30';

export function principalFixture(): Principal {
  return {
    userId: ID.user,
    externalId: 'deal.three',
    displayName: 'Emerson Marchetti',
    roles: ['deal_team'],
    clientIds: [],
    mockIdentity: true,
  };
}

export function pooledFixture(overrides: Partial<PooledMetrics> = {}): PooledMetrics {
  return {
    count: 2,
    invested: '390745869.96',
    distributions: '38446450.51',
    nav: '464322597.06',
    dpi: '0.098392468',
    rvpi: '1.1882981568',
    tvpi: '1.2866906248',
    grossMoic: '1.2866906248',
    grossIrr: '0.0530216124',
    irrFlag: null,
    ...overrides,
  };
}

export function investmentFixture(overrides: Partial<InvestmentSummary> = {}): InvestmentSummary {
  return {
    id: ID.inv1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    sponsorId: ID.sponsor1,
    sponsorName: 'Kelpwood Capital Partners',
    sponsorFundName: 'Kelpwood Fund IV',
    vehicleId: ID.vehicle1,
    vehicleName: 'Beach Co-Invest Fund I',
    dealType: 'deal_type.co_invest_equity',
    sector: 'sector.software',
    geography: 'geography.north_america',
    vintage: 2018,
    entryDate: '2018-11-15',
    exitDate: null,
    isActive: true,
    invested: '6900000.00',
    distributions: '2200000.00',
    nav: '27400000.00',
    navDate: AS_OF,
    grossMoic: '4.2898550725',
    grossIrr: '0.25',
    irrFlag: null,
    calcVersion: '0.1.0',
    ...overrides,
  };
}

export function investmentPageFixture(
  items: InvestmentSummary[],
  nextCursor: string | null = null,
): InvestmentPage {
  return { items, nextCursor, asOf: AS_OF };
}

const bucket = (
  key: string,
  label: string,
  count: number,
  invested: string,
  nav: string,
  navShare: string,
): ExposureBucket => ({ key, label, count, invested, nav, navShare });

/** The two active positions behind the analytics fixture, one per vehicle and deal type. */
export const CV_BUCKET = bucket(
  'deal_type.cv_single_asset',
  'Continuation vehicle (single asset)',
  1,
  '75353708.54',
  '105893922.44',
  '0.23',
);
export const CREDIT_BUCKET = bucket(
  'deal_type.private_credit',
  'Private credit',
  1,
  '18968583.11',
  '18837699.89',
  '0.04',
);

export function analyticsFixture(overrides: Partial<AnalyticsSummary> = {}): AnalyticsSummary {
  return {
    asOf: AS_OF,
    activeInvestments: 2,
    realizedInvestments: 1,
    totals: pooledFixture({
      count: 3,
      invested: '474124852.35',
      distributions: '194553187.24',
      dpi: '0.4103416775',
      rvpi: '0.9793255822',
      tvpi: '1.3896672597',
      grossMoic: '1.3896672597',
      grossIrr: '0.0762662147',
    }),
    active: pooledFixture(),
    realized: pooledFixture({
      count: 1,
      invested: '83378982.39',
      distributions: '156106736.73',
      nav: '0',
      dpi: '1.8722552405',
      rvpi: '0',
      tvpi: '1.8722552405',
      grossMoic: '1.8722552405',
      grossIrr: '0.1932646788',
    }),
    exposures: {
      sector: [
        bucket(
          'sector.energy_transition',
          'Energy transition',
          1,
          '93789963.35',
          '125141028.86',
          '0.27',
        ),
        bucket('sector.software', 'Software', 1, '6900000.00', '27400000.00', '0.06'),
      ],
      geography: [
        bucket(
          'geography.north_america',
          'North America',
          2,
          '100689963.35',
          '152541028.86',
          '0.33',
        ),
      ],
      dealType: [CV_BUCKET, CREDIT_BUCKET],
      vehicle: [
        bucket(ID.vehicle1, 'Beach CV Opportunities I', 1, '75353708.54', '105893922.44', '0.23'),
        bucket(ID.vehicle2, 'Beach Credit Partners I', 1, '18968583.11', '18837699.89', '0.04'),
      ],
      sponsor: [
        bucket(ID.sponsor1, 'Kelpwood Capital Partners', 2, '156361407.64', '189713276.90', '0.41'),
      ],
      vintage: [bucket('2019', '2019', 2, '145263025.40', '189717241.63', '0.41')],
      // Each vehicle's segments sum to its bucket in `vehicle`, as the API guarantees.
      vehicleByDealType: [
        { key: ID.vehicle1, label: 'Beach CV Opportunities I', segments: [CV_BUCKET] },
        { key: ID.vehicle2, label: 'Beach Credit Partners I', segments: [CREDIT_BUCKET] },
      ],
    },
    navSeries: [
      { periodEnd: '2024-12-31', value: '405983675.45' },
      { periodEnd: '2025-03-31', value: '425708487.84' },
      { periodEnd: AS_OF, value: '418244288.72' },
    ],
    flowsByYear: [
      {
        period: '2024',
        contributions: '63191706.41',
        distributions: '34300204.24',
        net: '-28891502.17',
        cumulativeNet: '-282123685.13',
      },
      {
        period: '2025',
        contributions: '0',
        distributions: '2552020.02',
        net: '2552020.02',
        cumulativeNet: '-279571665.11',
      },
    ],
    topPositions: [
      {
        id: ID.inv3,
        investmentNumber: 'INV-0012',
        companyName: 'Ashby Renewables Group',
        vehicleName: 'Beach CV Opportunities I',
        nav: '79062720.52',
        navShare: '0.1702754099',
        grossMoic: '1.4136082327',
      },
      {
        id: ID.inv1,
        investmentNumber: 'INV-0001',
        companyName: 'Meridian Data Partners',
        vehicleName: 'Beach Co-Invest Fund I',
        nav: '27400000.00',
        navShare: '0.059',
        grossMoic: '4.2898550725',
      },
    ],
    calcVersion: '0.1.0',
    ...overrides,
  };
}

export function watchlistFixture(overrides: Partial<Watchlist> = {}): Watchlist {
  return {
    asOf: AS_OF,
    thresholds: {
      netDebtToEbitdaMax: 6,
      ebitdaYoYDeclinePct: 0.15,
      markdownPct: 0.2,
      missingFinancialsDays: 75,
      maturityWithinMonths: 12,
    },
    items: [
      {
        investmentId: ID.inv1,
        investmentNumber: 'INV-0004',
        companyName: 'Silverline Staffing Holdings',
        vehicleName: 'Beach Co-Invest Fund I',
        dealType: 'deal_type.co_invest_equity',
        flags: [
          {
            code: 'negative_ebitda',
            severity: 'bad',
            message: 'EBITDA LTM of -3484738.35 for 2025-06-30 is at or below zero',
            value: '-3484738.35',
            threshold: '0',
          },
          {
            code: 'ebitda_decline',
            severity: 'watch',
            message: 'EBITDA LTM fell 117.9% against the same quarter last year (limit 15.0%)',
            value: '-1.179',
            threshold: '-0.15',
          },
        ],
      },
      {
        investmentId: ID.inv2,
        investmentNumber: 'INV-0007',
        companyName: 'Cobalt Energy Group',
        vehicleName: 'Beach Co-Invest Fund III',
        dealType: 'deal_type.co_invest_equity',
        flags: [
          {
            code: 'stale_valuation',
            severity: 'watch',
            message: 'Latest Locked valuation is for 2025-03-31; no Locked mark for 2025-06-30',
            value: null,
            threshold: null,
          },
        ],
      },
    ],
    counts: { watch: 1, bad: 1, clear: 3 },
    calcVersion: '0.1.0',
    ...overrides,
  };
}

export function dataHealthFixture(): DataHealth {
  return {
    asOf: AS_OF,
    orphanInvestments: 0,
    openExceptions: 0,
    staleInvestments: 1,
    staleAfterDays: 75,
    vehiclesWithOwnershipGap: [],
    lockedValuationsLatestQuarter: 14,
    activeInvestments: 16,
  };
}

export function noticeFixture(overrides: Partial<CapitalNoticeRow> = {}): CapitalNoticeRow {
  return {
    id: ID.notice1,
    noticeType: 'notice_type.capital_call',
    state: 'Reviewed',
    vehicleId: ID.vehicle1,
    vehicleName: 'Beach Co-Invest Fund I',
    investmentId: ID.inv1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    commitmentId: null,
    sponsorFundName: null,
    issueDate: '2025-06-20',
    dueDate: '2025-06-28',
    amount: '2500000.00',
    currency: 'USD',
    split: {},
    scenarioTag: null,
    settledAmount: null,
    daysToDue: -2,
    rowVersion: 1,
    ...overrides,
  };
}

export function capitalNoticePageFixture(attention: CapitalNoticeRow[]): CapitalNoticePage {
  return { items: attention, nextCursor: null, asOf: AS_OF, attention, alertDaysBeforeDue: 3 };
}

const creditQuarter = (
  periodEnd: string,
  parValue: string,
  fairValue: string,
): NonNullable<InvestmentPerformance['credit']>['quarters'][number] => ({
  periodEnd,
  parValue,
  costBasis: '9300000.00',
  fairValue,
  accruedInterest: '70000.00',
  cashInterestLtm: '850000.00',
  pikCapitalizedLtm: '190000.00',
  principalRepaidLtm: '0.00',
  fundedAmount: '9937711.38',
  ebitdaLtm: '2100000.00',
  cashInterestExpenseLtm: '1100000.00',
  netDebtThroughTranche: '13000000.00',
  ev: '19000000.00',
  currentYield: '0.1123',
  interestCoverage: '1.8',
  leverageThroughTranche: '5.2',
  loanToValue: '0.55',
  covenantStatus: 'covenant_status.waiver',
  paymentStatus: 'payment_status.current',
});

export function performanceFixture(
  overrides: Partial<InvestmentPerformance> = {},
): InvestmentPerformance {
  return {
    investmentId: ID.inv2,
    asOf: AS_OF,
    entry: null,
    quarters: [],
    sinceEntry: null,
    credit: {
      terms: {
        facilityType: 'facility_type.unitranche',
        seniorityRank: 1,
        commitmentAmount: '9937711.38',
        baseRate: 'base_rate.sofr',
        floor: '0.0100',
        spread: '0.0600',
        cashCoupon: '0.0900',
        pikCoupon: '0.0200',
        oid: '0.0200',
        upfrontFee: '0.0100',
        maturityDate: '2024-10-22',
        paymentFrequency: 'quarterly',
        effectiveDate: '2019-05-22',
        amortization: [{ date: '2020-05-22', amount: '496885.57' }],
        callProtection: [],
        covenants: [{ name: 'Maximum net leverage', level: '6.00', test: 'quarterly' }],
        allInCoupon: '0.1100',
        yieldToMaturity: '0.1150',
        pastMaturity: true,
      },
      quarters: [
        creditQuarter('2025-03-31', '9800000.00', '9700000.00'),
        creditQuarter(AS_OF, '9859053.48', '9859053.48'),
      ],
    },
    realizationOutlook: null,
    calcVersion: '0.1.0',
    ...overrides,
  };
}
