import { entryCohortBands, valueCreationRollup } from '@pb/calc';
import type {
  InvestmentValueCreation,
  ValueCreation,
  ValueCreationPosition,
} from '@pb/contracts';

/*
 * Contract-shaped synthetic fixtures for the value creation tabs and the deal card (docs/12
 * section 4: synthetic data only). Four positions in two vehicles: the worked example of docs/08
 * section 8 (a 4% entry stake), a company whose multiple contracted and whose mark trails its
 * earnings, one whose entry snapshot is dated after the as-of date and a realized one whose
 * EBITDA turned negative. `portfolio` and `cohorts` are the roll-up of the rows, as the API
 * answers them; the tests state the figures they expect by hand.
 */

export const VC_ID = {
  saltmarsh: '00000000-0000-4000-8000-000000000101',
  kelp: '00000000-0000-4000-8000-000000000102',
  tidepool: '00000000-0000-4000-8000-000000000103',
  dune: '00000000-0000-4000-8000-000000000104',
  credit: '00000000-0000-4000-8000-000000000105',
  vehicle: '00000000-0000-4000-8000-0000000001b1',
  cvVehicle: '00000000-0000-4000-8000-0000000001b2',
  sponsor: '00000000-0000-4000-8000-0000000001c1',
  otherSponsor: '00000000-0000-4000-8000-0000000001c2',
} as const;

export const VC_AS_OF = '2025-06-30';

const NO_GROWTH: ValueCreationPosition['growth'] = {
  ebitdaGrowth: null,
  evGrowth: null,
  equityValueGrowth: null,
  multipleChange: null,
  netLeverageChange: null,
  netDebtChange: null,
};

/**
 * Fixture 21 case 1 of packages/calc: 10,000,000 invested in 250,000,000 of entry equity value
 * is a stake of 4%, so the company's 250 + 65 + 30 (millions) is 10.0 + 2.6 + 1.2 of ours, and
 * the rest of the 14,500,000 gain, 700,000, is mark and timing. Entered 1,461 days before the
 * as-of date: (1 + IRR)^(1461/365) = 24,500,000 / 10,000,000.
 */
export function saltmarsh(overrides: Partial<ValueCreationPosition> = {}): ValueCreationPosition {
  return {
    id: VC_ID.saltmarsh,
    investmentNumber: 'INV-0001',
    companyName: 'Saltmarsh Holdings',
    vehicleId: VC_ID.vehicle,
    vehicleName: 'Beach Co-Invest Fund I',
    sponsorId: VC_ID.sponsor,
    sponsorName: 'Harborlight Partners',
    sector: 'sector.software',
    dealType: 'deal_type.co_invest_equity',
    entryDate: '2021-06-30',
    entryYear: 2021,
    exitDate: null,
    isActive: true,
    status: 'active',
    entry: {
      periodEnd: '2021-03-31',
      revenueLtm: '200000000',
      ebitdaLtm: '40000000',
      ev: '400000000',
      netDebt: '150000000',
      equityValue: '250000000',
      evToEbitda: '10',
      netDebtToEbitda: '3.75',
    },
    current: {
      periodEnd: '2025-06-30',
      revenueLtm: '260000000',
      ebitdaLtm: '65000000',
      ev: '715000000',
      netDebt: '120000000',
      equityValue: '595000000',
      evToEbitda: '11',
      netDebtToEbitda: '1.8461538462',
    },
    growth: {
      ebitdaGrowth: '0.625',
      evGrowth: '0.7875',
      equityValueGrowth: '1.38',
      multipleChange: '1',
      netLeverageChange: '-1.9038461538',
      netDebtChange: '-30000000',
    },
    bridge: {
      equityAtEntry: '250000000',
      equityCurrent: '595000000',
      ebitdaGrowth: '250000000',
      multipleExpansion: '65000000',
      debtPaydown: '30000000',
      total: '345000000',
      shares: {
        ebitdaGrowth: '0.7246376812',
        multipleExpansion: '0.1884057971',
        debtPaydown: '0.0869565217',
      },
      revenueGrowth: '120000000',
      marginChange: '130000000',
    },
    notCalculable: null,
    invested: '10000000',
    nav: '22500000',
    distributions: '2000000',
    grossMoic: '2.45',
    grossIrr: '0.2509067289',
    irrFlag: null,
    valuationGrowth: '1.45',
    valuationGrowthGap: '0.825',
    stake: '0.04',
    gain: '14500000',
    gainByDriver: {
      ebitdaGrowth: '10000000',
      multipleExpansion: '2600000',
      debtPaydown: '1200000',
      other: '700000',
      revenueGrowth: '4800000',
      marginChange: '5200000',
    },
    gainNotCalculable: null,
    flows: [
      { date: '2021-06-30', amount: '-10000000' },
      { date: '2025-06-30', amount: '2000000' },
    ],
    entryMultipleBand: 'band_1',
    entryLeverageBand: 'band_0',
    ...overrides,
  };
}

/**
 * Fixture 19 case 3 in millions (90 - 35 + 40 = 95 of company equity value) at a stake of
 * 20 / 300: 6,000,000 - 2,333,333.33 + 2,666,666.67 of ours. Our mark grew 5% against EBITDA
 * growth of 16.7% and equity value growth of 31.7%, so mark and timing is negative:
 * 1,000,000 - 6,333,333.33 = -5,333,333.33.
 */
export function kelp(overrides: Partial<ValueCreationPosition> = {}): ValueCreationPosition {
  return saltmarsh({
    id: VC_ID.kelp,
    investmentNumber: 'INV-0002',
    companyName: 'Kelp Forest Foods',
    vehicleId: VC_ID.cvVehicle,
    vehicleName: 'Beach CV Opportunities I',
    sponsorId: VC_ID.otherSponsor,
    sponsorName: 'Tidewater Capital',
    sector: 'sector.consumer',
    dealType: 'deal_type.cv_single_asset',
    entry: {
      periodEnd: '2021-03-31',
      revenueLtm: '300000000',
      ebitdaLtm: '60000000',
      ev: '540000000',
      netDebt: '240000000',
      equityValue: '300000000',
      evToEbitda: '9',
      netDebtToEbitda: '4',
    },
    current: {
      periodEnd: '2025-06-30',
      revenueLtm: '390000000',
      ebitdaLtm: '70000000',
      ev: '595000000',
      netDebt: '200000000',
      equityValue: '395000000',
      evToEbitda: '8.5',
      netDebtToEbitda: '2.8571428571',
    },
    growth: {
      ebitdaGrowth: '0.1666666667',
      evGrowth: '0.1018518519',
      equityValueGrowth: '0.3166666667',
      multipleChange: '-0.5',
      netLeverageChange: '-1.1428571429',
      netDebtChange: '-40000000',
    },
    bridge: {
      equityAtEntry: '300000000',
      equityCurrent: '395000000',
      ebitdaGrowth: '90000000',
      multipleExpansion: '-35000000',
      debtPaydown: '40000000',
      total: '95000000',
      shares: {
        ebitdaGrowth: '0.9473684211',
        multipleExpansion: '-0.3684210526',
        debtPaydown: '0.4210526316',
      },
      revenueGrowth: '162000000',
      marginChange: '-72000000',
    },
    invested: '20000000',
    nav: '21000000',
    distributions: '0',
    grossMoic: '1.05',
    grossIrr: '0.0122637832',
    valuationGrowth: '0.05',
    valuationGrowthGap: '-0.1166666667',
    stake: '0.0666666667',
    gain: '1000000',
    gainByDriver: {
      ebitdaGrowth: '6000000',
      multipleExpansion: '-2333333.3333333333',
      debtPaydown: '2666666.6666666667',
      other: '-5333333.3333333334',
      revenueGrowth: '10800000',
      marginChange: '-4800000',
    },
    flows: [{ date: '2021-06-30', amount: '-20000000' }],
    entryMultipleBand: 'band_1',
    entryLeverageBand: 'band_1',
    ...overrides,
  });
}

/** An entry snapshot dated after the as-of date: nothing to compare against yet, and the reason says so. */
export function tidepool(): ValueCreationPosition {
  return saltmarsh({
    id: VC_ID.tidepool,
    investmentNumber: 'INV-0003',
    companyName: 'Tidepool Analytics',
    entryDate: '2022-06-30',
    entryYear: 2022,
    entry: null,
    growth: NO_GROWTH,
    bridge: null,
    notCalculable: 'entry_snapshot_forward_dated',
    invested: '5000000',
    nav: '6000000',
    distributions: '0',
    grossMoic: '1.2',
    grossIrr: '0.0625996458',
    valuationGrowth: '0.2',
    valuationGrowthGap: null,
    stake: null,
    gain: '1000000',
    gainByDriver: null,
    gainNotCalculable: 'entry_snapshot_forward_dated',
    flows: [{ date: '2022-06-30', amount: '-5000000' }],
    entryMultipleBand: 'not_calculable',
    entryLeverageBand: 'not_calculable',
  });
}

/** Realized at a loss with EBITDA below zero in its last quarter before the exit: growth is known, a multiple is not. */
export function dune(): ValueCreationPosition {
  return saltmarsh({
    id: VC_ID.dune,
    investmentNumber: 'INV-0004',
    companyName: 'Dune Grass Logistics',
    vehicleId: VC_ID.cvVehicle,
    vehicleName: 'Beach CV Opportunities I',
    sponsorId: VC_ID.otherSponsor,
    sponsorName: 'Tidewater Capital',
    sector: 'sector.industrials',
    entryDate: '2017-09-20',
    entryYear: 2017,
    exitDate: '2023-11-30',
    isActive: false,
    status: 'realized',
    entry: {
      periodEnd: '2017-06-30',
      revenueLtm: '160000000',
      ebitdaLtm: '20000000',
      ev: '250000000',
      netDebt: '130000000',
      equityValue: '120000000',
      evToEbitda: '12.5',
      netDebtToEbitda: '6.5',
    },
    current: {
      periodEnd: '2023-09-30',
      revenueLtm: '150000000',
      ebitdaLtm: '-5000000',
      ev: '180000000',
      netDebt: '140000000',
      equityValue: '40000000',
      evToEbitda: null,
      netDebtToEbitda: null,
    },
    growth: {
      ebitdaGrowth: '-1.25',
      evGrowth: '-0.28',
      equityValueGrowth: '-0.6666666667',
      multipleChange: null,
      netLeverageChange: null,
      netDebtChange: '10000000',
    },
    bridge: null,
    notCalculable: 'non_positive_ebitda',
    invested: '8000000',
    nav: '0',
    distributions: '6000000',
    grossMoic: '0.75',
    grossIrr: '-0.04535988',
    valuationGrowth: '-0.25',
    valuationGrowthGap: '1',
    stake: '0.0666666667',
    gain: '-2000000',
    gainByDriver: null,
    gainNotCalculable: 'non_positive_ebitda',
    flows: [
      { date: '2017-09-20', amount: '-8000000' },
      { date: '2023-11-30', amount: '6000000' },
    ],
    entryMultipleBand: 'band_2',
    entryLeverageBand: 'band_3',
  });
}

/** The bands of the fixture, as config would give them. */
const BANDS = {
  byEntryMultiple: entryCohortBands(['9', '11', '13']),
  byEntryLeverage: entryCohortBands(['4', '5', '6']),
};

/** The answer over a set of rows: `portfolio` and `cohorts` are their roll-up, as the API's are. */
export function valueCreationFixture(overrides: Partial<ValueCreation> = {}): ValueCreation {
  const positions = overrides.positions ?? [saltmarsh(), kelp(), tidepool(), dune()];
  return {
    asOf: VC_AS_OF,
    positions,
    ...valueCreationRollup(positions, BANDS, VC_AS_OF),
    leftOut: [{ dealType: 'deal_type.private_credit', label: 'Private credit', count: 2 }],
    calcVersion: '0.1.0',
    ...overrides,
  };
}

/** One position with its indexed series; the second quarter has no EBITDA on record. */
export function investmentValueCreationFixture(
  overrides: Partial<InvestmentValueCreation> = {},
): InvestmentValueCreation {
  return {
    asOf: VC_AS_OF,
    investmentId: VC_ID.saltmarsh,
    dealType: 'deal_type.co_invest_equity',
    position: saltmarsh(),
    series: [
      {
        periodEnd: '2021-03-31',
        isEntry: true,
        ebitdaIndex: '100',
        evIndex: '100',
        equityValueIndex: '100',
        markIndex: null,
      },
      {
        periodEnd: '2024-12-31',
        isEntry: false,
        ebitdaIndex: '150',
        evIndex: '160',
        equityValueIndex: '200',
        markIndex: '140',
      },
      {
        periodEnd: '2025-03-31',
        isEntry: false,
        ebitdaIndex: null,
        evIndex: '170',
        equityValueIndex: '220',
        markIndex: '145',
      },
      {
        periodEnd: '2025-06-30',
        isEntry: false,
        ebitdaIndex: '162.5',
        evIndex: '178.75',
        equityValueIndex: '238',
        markIndex: '225',
      },
    ],
    calcVersion: '0.1.0',
    ...overrides,
  };
}
