import { describe, expect, it } from 'vitest';
import {
  investmentPage,
  principal,
  problemDetails,
  valuationPage,
  vehicleList,
} from '@pb/contracts';
import { AS_OF, investmentPageFixture } from '../../test/fixtures.js';
import {
  activePositions,
  PRIOR_PERIOD,
  refusalFixture,
  rolePrincipal,
  valuationPageFixture,
  POSITION_ID,
  valuationRowFixture,
  valuationRows,
  vehicleListFixture,
} from '../../test/fixtures-valuations.js';
import {
  aboveVarianceFlag,
  approvedOn,
  filterRows,
  isFairValue,
  latestFirst,
  lastMethodOf,
  methodCodes,
  missingMarks,
  periodCounts,
  VARIANCE_FLAG,
  VARIANCE_TITLE,
  vehicleNames,
  versionLabel,
} from './board.js';

describe('valuation fixtures match the contracts', () => {
  it.each([
    ['valuation page', valuationPage, valuationPageFixture()],
    ['active positions', investmentPage, investmentPageFixture(activePositions())],
    ['vehicles', vehicleList, vehicleListFixture()],
    ['principal', principal, rolePrincipal(['operations'])],
    ['refusal', problemDetails, refusalFixture(422, 'valuation: a reason is required')],
  ])('%s', (_name, schema, fixture) => {
    const result = schema.safeParse(fixture);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
});

describe('valuation board helpers', () => {
  it('reads the variance flag from config/definitions.json and flags at or above it, either way', () => {
    expect(VARIANCE_FLAG).toBe(0.1);
    expect(VARIANCE_TITLE).toBe('Above the 10.0% flag (config/definitions.json)');
    expect(aboveVarianceFlag('0.1')).toBe(true);
    expect(aboveVarianceFlag('-0.2059')).toBe(true);
    expect(aboveVarianceFlag('0.0999')).toBe(false);
    expect(aboveVarianceFlag(null)).toBe(false);
  });

  it('formats the approval date from a timestamp and never invents one', () => {
    expect(approvedOn('2025-08-09T15:00:00Z')).toBe('Aug 9, 2025');
    expect(approvedOn(null)).toBe('-');
    expect(approvedOn('yesterday')).toBe('-');
  });

  it('counts versions per period by state', () => {
    expect(periodCounts(valuationRows(), AS_OF)).toEqual({ locked: 2, inFlight: 3, reopened: 1 });
    expect(periodCounts(valuationRows(), PRIOR_PERIOD)).toEqual({
      locked: 2,
      inFlight: 0,
      reopened: 0,
    });
  });

  it('lists active positions with no version of any state for the period', () => {
    expect(
      missingMarks(activePositions(), valuationRows(), AS_OF).map((p) => p.investmentNumber),
    ).toEqual(['INV-0015']);
    expect(
      missingMarks(activePositions(), valuationRows(), PRIOR_PERIOD).map((p) => p.investmentNumber),
    ).toEqual(['INV-0004', 'INV-0007', 'INV-0012', 'INV-0013']);
  });

  it('filters by period, state, vehicle and a search over number and company, newest version first', () => {
    const rows = valuationRows();
    const base = { period: AS_OF, state: '' as const, vehicle: '', search: '' };
    expect(filterRows(rows, base).map((r) => `${r.investmentNumber} v${r.version}`)).toEqual([
      'INV-0001 v1',
      'INV-0004 v1',
      'INV-0007 v1',
      'INV-0012 v2',
      'INV-0012 v1',
      'INV-0013 v1',
    ]);
    expect(filterRows(rows, { ...base, state: 'OpsPrepared' }).map((r) => r.companyName)).toEqual([
      'Silverline Staffing Holdings',
    ]);
    expect(filterRows(rows, { ...base, vehicle: 'Beach Credit Partners I' })).toHaveLength(1);
    expect(
      filterRows(rows, { ...base, search: ' cobalt ' }).map((r) => r.investmentNumber),
    ).toEqual(['INV-0007']);
    expect(filterRows(rows, { ...base, search: 'inv-0012' })).toHaveLength(2);
  });

  it('offers the methods present in the rows and the vehicle names, with a fallback to the rows', () => {
    expect(methodCodes(valuationRows())).toEqual([
      'valuation_method.market_multiple',
      'valuation_method.par_plus_accrued',
      'valuation_method.sponsor_mark',
    ]);
    expect(vehicleNames(undefined, valuationRows())).toEqual([
      'Beach Co-Invest Fund I',
      'Beach Co-Invest Fund III',
      'Beach Credit Partners I',
      'Beach CV Opportunities I',
    ]);
    expect(vehicleNames(vehicleListFixture().items, [])).toHaveLength(4);
  });

  it('takes a fair value as digits with an optional decimal point only', () => {
    expect(isFairValue('12500000')).toBe(true);
    expect(isFairValue('12500000.50')).toBe(true);
    expect(isFairValue('0')).toBe(true);
    for (const bad of ['', '-5', '12,500,000', '1e6', '12.', '.5', '$12M', ' 12'])
      expect(isFairValue(bad), bad).toBe(false);
  });

  it('orders periods latest first whatever order they arrive in', () => {
    expect(latestFirst(['2024-12-31', AS_OF, PRIOR_PERIOD, AS_OF])).toEqual([
      AS_OF,
      PRIOR_PERIOD,
      '2024-12-31',
    ]);
  });

  it('names a version the way messages and buttons do', () => {
    expect(versionLabel(valuationRowFixture())).toBe('Meridian Data Partners, Jun 30, 2025 v1');
  });
});

describe('lastMethodOf', () => {
  it('takes the method of the latest period and the highest version, or null', () => {
    const rows = valuationRows();
    const first = rows[0]!;
    const sameInvestment = rows.filter((r) => r.investmentId === first.investmentId);
    const latest = [...sameInvestment].sort(
      (a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.version - a.version,
    )[0]!;
    expect(lastMethodOf(rows, first.investmentId)).toBe(latest.method);
    expect(lastMethodOf(rows, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('quarters', () => {
  it('counts a mark dated a few days early in the quarter it reports for', () => {
    const early = valuationRowFixture({
      id: '00000000-0000-4000-8000-000000000999',
      investmentId: POSITION_ID.meridian,
      periodEnd: '2025-06-27',
      quarterEnd: '2025-06-30',
      state: 'Locked',
    });
    const rows = [early];
    const active = activePositions();
    expect(active.map((p) => p.id)).toContain(POSITION_ID.meridian);
    expect(periodCounts(rows, '2025-06-30').locked).toBe(1);
    expect(periodCounts(rows, '2025-06-27').locked).toBe(0);
    expect(filterRows(rows, { period: '2025-06-30', state: '', vehicle: '', search: '' })).toEqual([
      early,
    ]);
    expect(missingMarks(active, rows, '2025-06-30').map((p) => p.id)).not.toContain(
      POSITION_ID.meridian,
    );
  });
});
