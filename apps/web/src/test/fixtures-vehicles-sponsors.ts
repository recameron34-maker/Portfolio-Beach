import type {
  FundCommitmentRow,
  PooledMetrics,
  SponsorDetail,
  SponsorSummary,
  VehicleDetail,
  VehicleSummary,
} from '@pb/contracts';
import { AS_OF, ID, investmentFixture, pooledFixture } from './fixtures.js';

/* Contract-shaped synthetic fixtures for the vehicle and sponsor pages (docs/12 section 4: synthetic data only). */

export const VS_ID = {
  vehicleCv: ID.vehicle1,
  vehiclePrimary: ID.vehicle2,
  vehicleCoInvest: '00000000-0000-4000-8000-0000000000b3',
  vehicleSma: '00000000-0000-4000-8000-0000000000b4',
  sponsorKelpwood: ID.sponsor1,
  sponsorMarram: '00000000-0000-4000-8000-0000000000c2',
  sponsorCliffside: '00000000-0000-4000-8000-0000000000c3',
  fundOne: '00000000-0000-4000-8000-0000000000f1',
  fundThree: '00000000-0000-4000-8000-0000000000f3',
  clientAlpha: '00000000-0000-4000-8000-0000000001a1',
  clientBeta: '00000000-0000-4000-8000-0000000001a2',
  commitmentOne: '00000000-0000-4000-8000-0000000001c1',
  commitmentTwo: '00000000-0000-4000-8000-0000000001c2',
} as const;

export function vehicleSummaryFixture(overrides: Partial<VehicleSummary> = {}): VehicleSummary {
  return {
    id: VS_ID.vehicleCv,
    name: 'Beach CV Opportunities I',
    vehicleType: 'vehicle_type.cv',
    vintage: 2021,
    activeInvestments: 3,
    lpCommitmentsTotal: '200000000.00',
    ...overrides,
  };
}

/** Three vehicles as an operations user sees them: every LP commitment total is visible. */
export function vehicleListFixture(items?: VehicleSummary[]): { items: VehicleSummary[] } {
  return {
    items: items ?? [
      vehicleSummaryFixture(),
      vehicleSummaryFixture({
        id: VS_ID.vehicleCoInvest,
        name: 'Beach Co-Invest Fund I',
        vehicleType: 'vehicle_type.co_invest',
        vintage: 2016,
        activeInvestments: 4,
        lpCommitmentsTotal: '150000000.00',
      }),
      vehicleSummaryFixture({
        id: VS_ID.vehiclePrimary,
        name: 'Beach Primary Program',
        vehicleType: 'vehicle_type.primary_program',
        vintage: null,
        activeInvestments: 0,
        lpCommitmentsTotal: '200000000.00',
      }),
    ],
  };
}

/** Nothing pooled: a vehicle without a visible position (the primary program holds commitments). */
export const NOT_CALCULABLE: PooledMetrics = {
  count: 0,
  invested: null,
  distributions: null,
  nav: null,
  dpi: null,
  rvpi: null,
  tvpi: null,
  grossMoic: null,
  grossIrr: null,
  irrFlag: 'insufficient_flows',
};

export function fundCommitmentFixture(
  overrides: Partial<FundCommitmentRow> = {},
): FundCommitmentRow {
  return {
    id: VS_ID.commitmentOne,
    vehicleId: VS_ID.vehiclePrimary,
    vehicleName: 'Beach Primary Program',
    vehicleType: 'vehicle_type.primary_program',
    sponsorId: VS_ID.sponsorKelpwood,
    sponsorName: 'Kelpwood Capital Partners',
    sponsorFundId: VS_ID.fundOne,
    sponsorFundName: 'Kelpwood Fund I',
    vintage: 2015,
    strategy: 'strategy.buyout',
    clientName: null,
    amount: '25000000.00',
    called: '22775000',
    distributed: '3776500',
    recallable: '0',
    unfunded: '2225000',
    commitmentDate: '2015-03-31',
    ...overrides,
  };
}

/** A CV fund with one active and one realized position, two client commitments and a NAV series. */
export function vehicleDetailFixture(overrides: Partial<VehicleDetail> = {}): VehicleDetail {
  return {
    id: VS_ID.vehicleCv,
    name: 'Beach CV Opportunities I',
    vehicleType: 'vehicle_type.cv',
    vintage: 2021,
    activeInvestments: 1,
    lpCommitmentsTotal: '200000000.00',
    asOf: AS_OF,
    currency: 'USD',
    closingCount: 1,
    finalCloseDate: '2021-06-30',
    metrics: pooledFixture({
      count: 2,
      invested: '73129853.12',
      distributions: '23000000.00',
      nav: '79062720.52',
      dpi: '0.3145091571',
      rvpi: '1.0811281012',
      tvpi: '1.3956372583',
      grossMoic: '1.3956372583',
      grossIrr: '0.0693711637',
    }),
    positions: [
      investmentFixture({
        id: ID.inv3,
        investmentNumber: 'INV-0012',
        companyName: 'Ashby Renewables Group',
        sponsorName: 'Skerry Partners',
        sponsorFundName: 'Skerry Fund I',
        vehicleName: 'Beach CV Opportunities I',
        dealType: 'deal_type.cv_single_asset',
        entryDate: '2019-04-27',
        invested: '55929725.57',
        distributions: '0',
        nav: '79062720.52',
        grossMoic: '1.4136082327',
        grossIrr: '0.0576010099',
      }),
      investmentFixture({
        id: ID.inv2,
        investmentNumber: 'INV-0017',
        companyName: 'Penrose Foods Holdings',
        sponsorName: 'Marram Equity Partners',
        sponsorFundName: 'Marram Fund III',
        vehicleName: 'Beach CV Opportunities I',
        dealType: 'deal_type.cv_single_asset',
        entryDate: '2018-09-01',
        exitDate: '2020-09-01',
        isActive: false,
        invested: '17200127.55',
        distributions: '23000000.00',
        nav: '0',
        navDate: null,
        grossMoic: '1.3371994153',
        grossIrr: null,
        irrFlag: 'multiple_irr',
      }),
    ],
    fundCommitments: [],
    lpCommitments: [
      {
        clientId: VS_ID.clientAlpha,
        clientName: 'Client Alpha Pension',
        amount: '120000000.00',
        closingNumber: 1,
        ownershipPct: '0.60000000',
        commitmentDate: '2021-06-30',
      },
      {
        clientId: VS_ID.clientBeta,
        clientName: 'Client Beta Endowment',
        amount: '80000000.00',
        closingNumber: 1,
        ownershipPct: '0.40000000',
        commitmentDate: '2021-06-30',
      },
    ],
    navSeries: [
      { periodEnd: '2024-12-31', value: '98428500.58' },
      { periodEnd: '2025-03-31', value: '107127538.65' },
      { periodEnd: AS_OF, value: '79062720.52' },
    ],
    calcVersion: '0.1.0',
    ...overrides,
  };
}

/**
 * The primary program as a viewer sees it: fund commitments only, one with no recorded cash flow
 * yet, no positions, no NAV series and no client data (lpCommitments is null, never an empty list).
 */
export function primaryProgramFixture(overrides: Partial<VehicleDetail> = {}): VehicleDetail {
  return vehicleDetailFixture({
    id: VS_ID.vehiclePrimary,
    name: 'Beach Primary Program',
    vehicleType: 'vehicle_type.primary_program',
    vintage: 2014,
    activeInvestments: 0,
    lpCommitmentsTotal: null,
    closingCount: 2,
    finalCloseDate: null,
    metrics: NOT_CALCULABLE,
    positions: [],
    fundCommitments: [
      fundCommitmentFixture(),
      fundCommitmentFixture({
        id: VS_ID.commitmentTwo,
        sponsorId: VS_ID.sponsorMarram,
        sponsorName: 'Marram Equity Partners',
        sponsorFundId: VS_ID.fundThree,
        sponsorFundName: 'Marram Fund III',
        vintage: 2022,
        strategy: 'strategy.growth',
        amount: '42000000.00',
        called: null,
        distributed: null,
        recallable: null,
        unfunded: null,
        commitmentDate: '2022-03-31',
      }),
    ],
    lpCommitments: null,
    navSeries: [],
    ...overrides,
  });
}

export function sponsorSummaryFixture(overrides: Partial<SponsorSummary> = {}): SponsorSummary {
  return {
    id: VS_ID.sponsorKelpwood,
    name: 'Kelpwood Capital Partners',
    tier: 'sponsor_tier.active',
    hqGeography: 'geography.north_america',
    fundCount: 2,
    activeInvestments: 7,
    ...overrides,
  };
}

export function sponsorPageFixture(
  items?: SponsorSummary[],
  nextCursor: string | null = null,
): { items: SponsorSummary[]; nextCursor: string | null } {
  return {
    items: items ?? [
      sponsorSummaryFixture({
        id: VS_ID.sponsorCliffside,
        name: 'Cliffside Equity Partners',
        tier: 'sponsor_tier.watch',
        hqGeography: null,
        fundCount: 1,
        activeInvestments: 0,
      }),
      sponsorSummaryFixture(),
      sponsorSummaryFixture({
        id: VS_ID.sponsorMarram,
        name: 'Marram Equity Partners',
        tier: 'sponsor_tier.core',
        hqGeography: 'geography.europe',
        fundCount: 3,
        activeInvestments: 2,
      }),
    ],
    nextCursor,
  };
}

/** Kelpwood with two funds, one active and one realized position and two commitments, one client-directed. */
export function sponsorDetailFixture(overrides: Partial<SponsorDetail> = {}): SponsorDetail {
  return {
    ...sponsorSummaryFixture({ activeInvestments: 1 }),
    description: 'Control buyouts and growth investments in the middle market.',
    funds: [
      {
        id: VS_ID.fundOne,
        name: 'Kelpwood Fund I',
        vintage: 2015,
        strategy: 'strategy.buyout',
        sizeTarget: '4000000000.00',
        sizeFinal: '3916747832.95',
        currency: 'USD',
        aliases: ['KF I', 'Kelpwood I'],
        holdings: 3,
        ourPositions: 1,
        ourCommitment: '25000000',
      },
      {
        id: VS_ID.fundThree,
        name: 'Kelpwood Fund III',
        vintage: 2018,
        strategy: 'strategy.growth',
        sizeTarget: '500000000.00',
        sizeFinal: null,
        currency: 'EUR',
        aliases: [],
        holdings: 4,
        ourPositions: 1,
        ourCommitment: '8000000.00',
      },
    ],
    positions: [
      investmentFixture({
        sponsorFundName: 'Kelpwood Fund III',
        invested: '6935771.67',
        distributions: '2150089.22',
        nav: '8746412.16',
        grossMoic: '1.5710582612',
        grossIrr: '0.0726481261',
      }),
      investmentFixture({
        id: ID.inv2,
        investmentNumber: 'INV-0011',
        companyName: 'Cobalt Components Corp',
        sponsorFundName: 'Kelpwood Fund I',
        vehicleName: 'Beach Co-Invest Fund I',
        entryDate: '2017-01-25',
        exitDate: '2023-01-25',
        isActive: false,
        invested: '28542239.66',
        distributions: '30010000.00',
        nav: '0',
        navDate: null,
        grossMoic: '1.0514248372',
        grossIrr: '0.0084405509',
      }),
    ],
    commitments: [
      fundCommitmentFixture(),
      fundCommitmentFixture({
        id: VS_ID.commitmentTwo,
        vehicleId: VS_ID.vehicleSma,
        vehicleName: 'Client Gamma Separate Account',
        vehicleType: 'vehicle_type.client_sma',
        sponsorFundId: VS_ID.fundThree,
        sponsorFundName: 'Kelpwood Fund III',
        vintage: 2018,
        clientName: 'Client Gamma Insurance',
        amount: '8000000.00',
        called: null,
        distributed: null,
        recallable: null,
        unfunded: null,
        commitmentDate: '2018-06-30',
      }),
    ],
    metrics: pooledFixture({
      count: 2,
      invested: '35478011.33',
      distributions: '32160089.22',
      nav: '8746412.16',
      dpi: '0.9064680049',
      rvpi: '0.2465305006',
      tvpi: '1.1529985055',
      grossMoic: '1.1529985055',
      grossIrr: '0.0230212765',
    }),
    totalCommitted: '33000000.00',
    calcVersion: '0.1.0',
    ...overrides,
  };
}
