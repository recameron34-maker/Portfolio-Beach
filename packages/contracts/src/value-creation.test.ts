import { describe, expect, it } from 'vitest';
import { buildOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';
import {
  asOfQuery,
  csvText,
  entryCohort,
  investmentValueCreation,
  valueCreation,
  valueCreationPosition,
  valueCreationReason,
} from './schemas.js';

/*
 * The value creation and entry metric analytics (docs/04 M13 and M20, docs/08 section 8): the
 * three routes, their schemas, and the rules the shapes carry (money as decimal text, null for
 * not calculable with a reason beside it, nothing extra accepted).
 */

const INV = '30000000-0000-4000-8000-000000000001';
const VEHICLE = '30000000-0000-4000-8000-0000000000b1';
const SPONSOR = '30000000-0000-4000-8000-0000000000c1';

/** The worked example of docs/08 section 8 as one position row. */
const position = {
  id: INV,
  investmentNumber: 'INV-0001',
  companyName: 'Saltmarsh Holdings',
  vehicleId: VEHICLE,
  vehicleName: 'Beach Co-Invest Fund I',
  sponsorId: SPONSOR,
  sponsorName: 'Harborlight Partners',
  sector: 'sector.software',
  dealType: 'deal_type.co_invest_equity',
  entryDate: '2019-02-15',
  exitDate: null,
  isActive: true,
  entry: {
    periodEnd: '2018-12-31',
    revenueLtm: '200',
    ebitdaLtm: '40',
    ev: '400',
    netDebt: '150',
    equityValue: '250',
    evToEbitda: '10',
    netDebtToEbitda: '3.75',
  },
  current: {
    periodEnd: '2025-06-30',
    revenueLtm: '260',
    ebitdaLtm: '65',
    ev: '715',
    netDebt: '120',
    equityValue: '595',
    evToEbitda: '11',
    netDebtToEbitda: '1.8461538462',
  },
  growth: {
    ebitdaGrowth: '0.625',
    evGrowth: '0.7875',
    equityValueGrowth: '1.38',
    multipleChange: '1',
    netLeverageChange: '-1.9038461538',
    netDebtChange: '-30',
  },
  bridge: {
    equityAtEntry: '250',
    equityCurrent: '595',
    ebitdaGrowth: '250',
    multipleExpansion: '65',
    debtPaydown: '30',
    total: '345',
    shares: {
      ebitdaGrowth: '0.7246376812',
      multipleExpansion: '0.1884057971',
      debtPaydown: '0.0869565217',
    },
    revenueGrowth: '120',
    marginChange: '130',
  },
  notCalculable: null,
  invested: '10000000',
  nav: '14900000',
  distributions: '2000000',
  grossMoic: '1.69',
  grossIrr: '0.0912',
  irrFlag: null,
  valuationGrowth: '0.69',
  valuationGrowthGap: '0.065',
  gain: '6900000',
  gainByDriver: {
    ebitdaGrowth: '5000000',
    multipleExpansion: '1300000',
    debtPaydown: '600000',
    revenueGrowth: '2400000',
    marginChange: '2600000',
  },
  gainNotCalculable: null,
  entryMultipleBand: 'band_1',
  entryLeverageBand: 'band_0',
};

/** A position the bridge cannot be computed for: every derived figure is null and the reason says why. */
const withoutBridge = {
  ...position,
  id: '30000000-0000-4000-8000-000000000002',
  investmentNumber: 'INV-0002',
  entry: null,
  growth: {
    ebitdaGrowth: null,
    evGrowth: null,
    equityValueGrowth: null,
    multipleChange: null,
    netLeverageChange: null,
    netDebtChange: null,
  },
  bridge: null,
  notCalculable: 'no_entry_snapshot',
  valuationGrowthGap: null,
  gainByDriver: null,
  gainNotCalculable: 'no_entry_snapshot',
  entryMultipleBand: 'not_calculable',
  entryLeverageBand: 'not_calculable',
};

const cohort = {
  key: 'band_1',
  label: '9.0x to 11.0x',
  lower: '9',
  upper: '11',
  count: 1,
  invested: '10000000',
  distributions: '2000000',
  nav: '14900000',
  dpi: '0.2',
  rvpi: '1.49',
  tvpi: '1.69',
  grossMoic: '1.69',
  grossIrr: '0.0912',
  irrFlag: null,
  ebitdaGrowth: '0.625',
  ebitdaGrowthPositions: 1,
};

const emptyCohort = {
  key: 'not_calculable',
  label: 'Not calculable',
  lower: null,
  upper: null,
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
  ebitdaGrowth: null,
  ebitdaGrowthPositions: 0,
};

const response = {
  asOf: '2025-06-30',
  positions: [position, withoutBridge],
  portfolio: {
    positions: 1,
    invested: '10000000',
    nav: '14900000',
    distributions: '2000000',
    totalValue: '16900000',
    gain: '6900000',
    gainByDriver: position.gainByDriver,
    notCalculable: [{ reason: 'no_entry_snapshot', count: 1 }],
  },
  cohorts: {
    byEntryMultiple: [cohort, emptyCohort],
    byEntryLeverage: [{ ...cohort, key: 'band_0', label: 'Under 4.0x', lower: null, upper: '4' }],
  },
  leftOut: [{ dealType: 'deal_type.private_credit', label: 'Private credit', count: 2 }],
  calcVersion: '0.1.0',
};

const point = {
  periodEnd: '2025-06-30',
  isEntry: false,
  ebitdaIndex: '162.5',
  evIndex: '178.75',
  equityValueIndex: '238',
  markIndex: '149',
};

const one = {
  asOf: '2025-06-30',
  investmentId: INV,
  dealType: 'deal_type.co_invest_equity',
  position,
  series: [
    { ...point, periodEnd: '2018-12-31', isEntry: true, markIndex: null },
    { ...point, ebitdaIndex: null },
    point,
  ],
  calcVersion: '0.1.0',
};

describe('value creation contracts', () => {
  it('reads the portfolio answer: positions, the roll-up, the cohorts and what was left out', () => {
    const parsed = valueCreation.parse(response);
    expect(parsed.positions.map((p) => p.notCalculable)).toEqual([null, 'no_entry_snapshot']);
    expect(parsed.portfolio.gainByDriver?.debtPaydown).toBe('600000');
    expect(parsed.cohorts.byEntryMultiple.map((c) => c.key)).toEqual(['band_1', 'not_calculable']);
    expect(parsed.leftOut[0]?.count).toBe(2);
  });

  it('keeps every figure as decimal text, never a JS number', () => {
    for (const broken of [
      { ...position, invested: 10000000 },
      { ...position, bridge: { ...position.bridge, total: 345 } },
      { ...position, growth: { ...position.growth, ebitdaGrowth: 0.625 } },
      { ...position, gainByDriver: { ...position.gainByDriver, ebitdaGrowth: 5e6 } },
      { ...position, entry: { ...position.entry, evToEbitda: 10 } },
      { ...position, valuationGrowth: '6.9e-1' },
    ]) {
      expect(valueCreationPosition.safeParse(broken).success).toBe(false);
    }
    expect(entryCohort.safeParse({ ...cohort, grossMoic: 1.69 }).success).toBe(false);
    expect(entryCohort.safeParse({ ...cohort, ebitdaGrowthPositions: '1' }).success).toBe(false);
  });

  it('never leaves a key out: not calculable is null with its reason, not an absent field', () => {
    expect(valueCreationPosition.parse(withoutBridge).bridge).toBeNull();
    for (const key of Object.keys(position)) {
      const { [key as keyof typeof position]: _dropped, ...rest } = position;
      expect(valueCreationPosition.safeParse(rest).success, key).toBe(false);
    }
    const { shares: _shares, ...noShares } = position.bridge;
    expect(valueCreationPosition.safeParse({ ...position, bridge: noShares }).success).toBe(false);
    // A company whose equity value did not move has a bridge with no shares.
    expect(
      valueCreationPosition.safeParse({
        ...position,
        bridge: { ...position.bridge, shares: null },
        gainByDriver: null,
        gainNotCalculable: 'no_equity_change',
      }).success,
    ).toBe(true);
  });

  it('accepts nothing beyond the fields it names (strict)', () => {
    expect(valueCreation.safeParse({ ...response, extra: 1 }).success).toBe(false);
    expect(valueCreationPosition.safeParse({ ...position, geography: null }).success).toBe(false);
    expect(
      valueCreationPosition.safeParse({ ...position, bridge: { ...position.bridge, other: '1' } })
        .success,
    ).toBe(false);
    expect(entryCohort.safeParse({ ...cohort, positions: [] }).success).toBe(false);
    expect(
      valueCreation.safeParse({ ...response, portfolio: { ...response.portfolio, moic: '1' } })
        .success,
    ).toBe(false);
    expect(investmentValueCreation.safeParse({ ...one, extra: true }).success).toBe(false);
    expect(
      investmentValueCreation.safeParse({ ...one, series: [{ ...point, navIndex: '1' }] }).success,
    ).toBe(false);
  });

  it('names the reasons a bridge or a gain split is not calculable', () => {
    expect(valueCreationReason.options).toEqual([
      'no_entry_snapshot',
      'no_current_quarter',
      'missing_figures',
      'non_positive_ebitda',
      'no_equity_change',
      'no_gain',
    ]);
    expect(
      valueCreationPosition.safeParse({ ...withoutBridge, notCalculable: 'other' }).success,
    ).toBe(false);
    // The bridge itself is only ever missing for the first four.
    expect(
      valueCreationPosition.safeParse({ ...withoutBridge, notCalculable: 'no_gain' }).success,
    ).toBe(false);
  });

  it('reads one position with its indexed series, or says the deal type has no such view', () => {
    const parsed = investmentValueCreation.parse(one);
    expect(parsed.series.map((p) => p.isEntry)).toEqual([true, false, false]);
    expect(parsed.series[0]?.markIndex).toBeNull();
    const credit = investmentValueCreation.parse({
      ...one,
      dealType: 'deal_type.private_credit',
      position: null,
      series: [],
    });
    expect(credit.position).toBeNull();
    expect(investmentValueCreation.safeParse({ ...one, investmentId: 'INV-0001' }).success).toBe(
      false,
    );
  });
});

describe('value creation routes', () => {
  const doc = buildOpenApi('0.1.0');
  const operation = (path: string): Record<string, unknown> => {
    const op = doc.paths[path]?.get as Record<string, unknown> | undefined;
    if (op === undefined) throw new Error(`no GET ${path}`);
    return op;
  };
  const PATHS = [
    '/api/v1/analytics/value-creation',
    '/api/v1/analytics/value-creation/export',
    '/api/v1/investments/{id}/value-creation',
  ];

  it('lists the three routes for any signed-in user, with the as-of date as the only query', () => {
    for (const path of PATHS) {
      const route = ROUTES.find((r) => r.method === 'GET' && r.path === path);
      expect(route, path).toBeDefined();
      expect(route?.auth).toBe(true);
      // Row-level security decides what comes back, as for /analytics/summary.
      expect(route?.roles).toEqual([]);
      expect(route?.query).toBe(asOfQuery);
      expect(operation(path)['x-roles']).toBeUndefined();
      expect(operation(path).security).toEqual([{ bearer: [] }]);
      const parameters = operation(path).parameters as { name: string; in: string }[];
      expect(parameters.filter((p) => p.in === 'query').map((p) => p.name)).toEqual(['asOf']);
    }
    const summary = ROUTES.find((r) => r.path === '/api/v1/analytics/summary');
    expect(ROUTES.find((r) => r.path === PATHS[0])?.query).toBe(summary?.query);
  });

  it('answers the schemas above, and the export as text/csv', () => {
    const responseOf = (path: string): Record<string, { schema: Record<string, unknown> }> =>
      (operation(path).responses as Record<string, { content: never }>)['200']!.content;
    expect(ROUTES.find((r) => r.path === PATHS[0])?.response).toBe(valueCreation);
    expect(ROUTES.find((r) => r.path === PATHS[1])?.response).toBe(csvText);
    expect(ROUTES.find((r) => r.path === PATHS[2])?.response).toBe(investmentValueCreation);
    expect(Object.keys(responseOf(PATHS[0]!))).toEqual(['application/json']);
    expect(Object.keys(responseOf(PATHS[1]!))).toEqual(['text/csv']);
    expect(responseOf(PATHS[1]!)['text/csv']?.schema.contentMediaType).toBe('text/csv');
    const body = responseOf(PATHS[0]!)['application/json']?.schema as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(body.required).toEqual(
      expect.arrayContaining(['asOf', 'positions', 'portfolio', 'cohorts', 'leftOut']),
    );
    expect(body.additionalProperties).toBe(false);
    const single = (operation(PATHS[2]!).parameters as { name: string; in: string }[]).filter(
      (p) => p.in === 'path',
    );
    expect(single.map((p) => p.name)).toEqual(['id']);
  });
});
