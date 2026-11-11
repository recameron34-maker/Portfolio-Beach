import { describe, expect, it } from 'vitest';
import {
  investmentPage,
  principal,
  problemDetails,
  valuationPage,
  vehicleList,
} from '@pb/contracts';
import { AS_OF, investmentFixture, investmentPageFixture } from '../../test/fixtures.js';
import {
  activePositions,
  PRIOR_PERIOD,
  refusalFixture,
  rolePrincipal,
  valuationDetailFixture,
  valuationPageFixture,
  POSITION_ID,
  valuationRowFixture,
  valuationRows,
  vehicleListFixture,
} from '../../test/fixtures-valuations.js';

const ABOVE_ZERO = 'Must be above zero';
import {
  aboveVarianceFlag,
  approvedOn,
  batchLabel,
  batchPlanFor,
  batchPlans,
  canEditDraft,
  EDIT_ROLES,
  fairValueProblem,
  filterRows,
  inputEntries,
  inputEntriesProblem,
  inputsFromEntries,
  isFairValue,
  latestFirst,
  lastMethodOf,
  lockedBy,
  methodCodes,
  missingMarks,
  openForNewVersion,
  periodCounts,
  sameInputs,
  signOffsOf,
  startablePositions,
  valuationSteps,
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

  it('counts no missing mark for a position entered after the period end', () => {
    const late = investmentFixture({
      id: '00000000-0000-4000-8000-000000000998',
      investmentNumber: 'INV-0099',
      entryDate: '2025-05-15',
    });
    expect(
      missingMarks([...activePositions(), late], valuationRows(), PRIOR_PERIOD).map(
        (p) => p.investmentNumber,
      ),
    ).toEqual(['INV-0004', 'INV-0007', 'INV-0012', 'INV-0013']);
    expect(missingMarks([late], valuationRows(), AS_OF).map((p) => p.investmentNumber)).toEqual([
      'INV-0099',
    ]);
  });

  it('opens a quarter to a new version only with no version in flight and no Locked version left unreopened', () => {
    expect(openForNewVersion([])).toBe(true);
    expect(openForNewVersion([{ state: 'Reopened', version: 1 }])).toBe(true);
    expect(openForNewVersion([{ state: 'Locked', version: 1 }])).toBe(false);
    expect(
      openForNewVersion([
        { state: 'Locked', version: 1 },
        { state: 'Reopened', version: 2 },
      ]),
    ).toBe(true);
    expect(
      openForNewVersion([
        { state: 'Reopened', version: 1 },
        { state: 'Locked', version: 2 },
      ]),
    ).toBe(false);
    for (const state of ['Draft', 'OpsPrepared', 'DealTeamApproved'])
      expect(openForNewVersion([{ state, version: 1 }]), state).toBe(false);
    expect(
      openForNewVersion([
        { state: 'Reopened', version: 1 },
        { state: 'Draft', version: 2 },
      ]),
    ).toBe(false);
  });

  it('offers a new version for the positions whose quarter is open, held at the quarter end', () => {
    // At the latest period only Summit Care has no version; Ashby's reopened v1 is closed again by its Locked v2.
    expect(
      startablePositions(activePositions(), valuationRows(), AS_OF).map((p) => p.investmentNumber),
    ).toEqual(['INV-0015']);
    expect(
      startablePositions(activePositions(), valuationRows(), PRIOR_PERIOD).map(
        (p) => p.investmentNumber,
      ),
    ).toEqual(['INV-0004', 'INV-0007', 'INV-0012', 'INV-0013']);
    const late = investmentFixture({
      id: '00000000-0000-4000-8000-000000000998',
      investmentNumber: 'INV-0099',
      entryDate: '2025-05-15',
    });
    expect(startablePositions([late], [], PRIOR_PERIOD)).toEqual([]);
    expect(startablePositions([late], [], AS_OF).map((p) => p.investmentNumber)).toEqual([
      'INV-0099',
    ]);
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

  it('takes an amount as digits with an optional decimal point only (the pipeline forms read it)', () => {
    expect(isFairValue('12500000')).toBe(true);
    expect(isFairValue('12500000.50')).toBe(true);
    expect(isFairValue('0')).toBe(true);
    for (const bad of ['', '-5', '12,500,000', '1e6', '12.', '.5', '$12M', ' 12'])
      expect(isFairValue(bad), bad).toBe(false);
  });

  it('takes a fair value the way the contract does, and says why not in the contract words (VAL-3)', () => {
    const SHAPE = 'An amount above zero: at most 18 digits before the decimal point and two after';
    for (const good of ['12500000', '12500000.5', '12500000.50', '0.01', '9'.repeat(18)])
      expect(fairValueProblem(good), good).toBeNull();
    for (const bad of ['', '-5', '12,500,000', '1e6', '12.', '.5', '$12M', ' 12'])
      expect(fairValueProblem(bad), bad).toBe(SHAPE);
    // A third decimal would be rounded and a nineteenth digit would not fit the column.
    expect(fairValueProblem('12500000.005')).toBe(SHAPE);
    expect(fairValueProblem(`1${'9'.repeat(18)}`)).toBe(SHAPE);
    for (const zero of ['0', '0.0', '0.00']) expect(fairValueProblem(zero), zero).toBe(ABOVE_ZERO);
  });

  it('turns the stored inputs into form rows and back, keeping each value as it was stored unless it is retyped', () => {
    const stored = { multiple: 11.5, basis: 'LTM EBITDA', year: '2025' };
    const rows = inputEntries(stored);
    expect(rows).toEqual([
      { name: 'basis', value: 'LTM EBITDA' },
      { name: 'multiple', value: '11.5' },
      { name: 'year', value: '2025' },
    ]);
    // Unchanged rows keep their stored type: the text "2025" stays text, the number stays a number.
    expect(inputsFromEntries(rows ?? [], stored)).toEqual(stored);
    // A retyped value is a number when it is written exactly as that number reads, text otherwise.
    expect(
      inputsFromEntries(
        [
          { name: ' multiple ', value: ' 12 ' },
          { name: 'discount', value: '0.125' },
          { name: 'padded', value: '11.50' },
          { name: 'big', value: '12345678901234567890' },
          { name: 'note', value: 'see the sponsor letter' },
          { name: '', value: '' },
        ],
        stored,
      ),
    ).toEqual({
      multiple: 12,
      discount: 0.125,
      padded: '11.50',
      big: '12345678901234567890',
      note: 'see the sponsor letter',
    });
    expect(inputEntries({})).toEqual([]);
    // A value the form cannot carry (anything but text or a number) makes the inputs read only.
    expect(inputEntries({ comps: { set: 'peers', count: 6 } })).toBeNull();
    expect(inputEntries({ range: [9.5, 12] })).toBeNull();
    expect(sameInputs({ b: 2, a: 'x' }, { a: 'x', b: 2 })).toBe(true);
    expect(sameInputs({ a: '2' }, { a: 2 })).toBe(false);
    expect(sameInputs({}, { a: 1 })).toBe(false);
  });

  it('refuses in the form what the contract refuses of the inputs: a value without a name, a name twice, a name too long', () => {
    expect(inputEntriesProblem([{ name: 'basis', value: 'LTM' }])).toBeNull();
    expect(inputEntriesProblem([{ name: '', value: '' }])).toBeNull();
    expect(inputEntriesProblem([{ name: '  ', value: '11.5' }])).toBe(
      'Give each input a name, or clear its value.',
    );
    expect(
      inputEntriesProblem([
        { name: 'basis', value: 'LTM' },
        { name: ' basis', value: 'NTM' },
      ]),
    ).toBe('Use each input name once: basis is there twice.');
    expect(inputEntriesProblem([{ name: 'x'.repeat(101), value: '1' }])).toBe(
      'An input name can be up to 100 characters.',
    );
  });

  it('names who signed a version that holds no decision rows, from the version itself', () => {
    const seeded = {
      state: 'Locked' as const,
      approvals: [],
      preparedBy: 'Avery Mbeki',
      dealTeamApprovedBy: 'Blake Okafor',
      approvedBy: 'Morgan Lindqvist',
      approvedAt: '2025-08-09T15:00:00Z',
    };
    const all = [
      { step: 'ops_prepared', by: 'Avery Mbeki', at: null },
      { step: 'deal_team', by: 'Blake Okafor', at: null },
      { step: 'final', by: 'Morgan Lindqvist', at: '2025-08-09T15:00:00Z' },
    ];
    expect(signOffsOf(seeded)).toEqual(all);
    expect(signOffsOf({ ...seeded, state: 'Reopened' })).toEqual(all);
    expect(lockedBy(seeded)).toBe('Morgan Lindqvist');
    // A version in progress names who has signed so far; nobody named is nobody shown.
    const prepared = { ...seeded, dealTeamApprovedBy: null, approvedBy: null, approvedAt: null };
    expect(signOffsOf({ ...prepared, state: 'OpsPrepared' })).toEqual([all[0]]);
    expect(signOffsOf({ ...seeded, state: 'DealTeamApproved' })).toEqual([all[0], all[1]]);
    // A Draft may name a preparer already (a staged weekly value made it) without having been
    // prepared: a name on a step the version has not passed is no sign-off.
    expect(signOffsOf({ ...prepared, state: 'Draft' })).toEqual([]);
    expect(lockedBy({ ...seeded, approvedBy: null, approvedAt: null })).toBeNull();
    // The decision rows say more (who, when, why): where they exist, they are what is shown.
    const trail = valuationDetailFixture().approvals;
    expect(signOffsOf({ ...seeded, approvals: trail })).toEqual([]);
    expect(lockedBy({ ...seeded, approvals: trail, approvedBy: 'Someone Else' })).toBe(
      'Morgan Lindqvist',
    );
  });

  it('reads who may edit a Draft from the route table', () => {
    expect(EDIT_ROLES).toEqual(['operations']);
    expect(canEditDraft(['operations'])).toBe(true);
    expect(canEditDraft(['deal_team', 'approver', 'viewer'])).toBe(false);
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

describe('the batch approval screen and the version screen (docs/04 M10)', () => {
  it('derives the batch commands a role may run from the transition table', () => {
    expect(batchPlans(['deal_team'])).toEqual([
      expect.objectContaining({
        command: 'dealTeamApprove',
        from: 'OpsPrepared',
        to: 'DealTeamApproved',
      }),
    ]);
    expect(batchPlans(['approver'])).toEqual([
      expect.objectContaining({ command: 'lock', from: 'DealTeamApproved', to: 'Locked' }),
    ]);
    expect(batchPlans(['deal_team', 'approver']).map((p) => p.command)).toEqual([
      'dealTeamApprove',
      'lock',
    ]);
    // Operations prepares, sends back and reopens one at a time: never a batch.
    expect(batchPlans(['operations'])).toEqual([]);
    expect(batchPlans(['viewer'])).toEqual([]);
  });

  it('matches a row to the plan its state starts from and words the buttons', () => {
    const plans = batchPlans(['deal_team', 'approver']);
    expect(batchPlanFor({ state: 'OpsPrepared' }, plans)?.command).toBe('dealTeamApprove');
    expect(batchPlanFor({ state: 'DealTeamApproved' }, plans)?.command).toBe('lock');
    expect(batchPlanFor({ state: 'Draft' }, plans)).toBeUndefined();
    expect(batchPlanFor({ state: 'Locked' }, plans)).toBeUndefined();
    expect(batchLabel('dealTeamApprove')).toBe('Approve selected');
    expect(batchLabel('lock')).toBe('Lock selected');
  });

  it('marks the four steps done, current or upcoming, with every step behind a Reopened version', () => {
    expect(valuationSteps('DealTeamApproved').map((s) => s.status)).toEqual([
      'done',
      'done',
      'current',
      'upcoming',
    ]);
    expect(valuationSteps('Draft').map((s) => s.status)).toEqual([
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
    expect(valuationSteps('Locked')[3]).toEqual({ state: 'Locked', status: 'current' });
    expect(valuationSteps('Reopened').every((s) => s.status === 'done')).toBe(true);
  });
});
