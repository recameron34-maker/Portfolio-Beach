import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeRequestPage,
  mockUserList,
  quarterEndCheckResult,
  valuationDetail,
} from '@pb/contracts';
import { dealChangeRequestMachine } from '@pb/workflows';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../lib/format.js';
import {
  changeRequestPageFixture,
  changeRequestRows,
  changeTypeTaxonomyFixture,
  mockUsersFixture,
  PERSON,
  POSITION_ID,
  quarterEndCheckFixture,
  USER_ID,
  valuationDetailFixture,
} from '../../test/fixtures-valuations.js';
import {
  applicablePeriods,
  canReadQueue,
  canRunQuarterEndCheck,
  canSubmitRequest,
  CHANGE_REQUEST_STATES,
  detailsRecord,
  filterRequests,
  formProblems,
  investmentOptions,
  isChangeRequestState,
  isOpenRequest,
  ownerCandidates,
  recentQuarterEnds,
  requestCounts,
  requestLabel,
} from './changes.js';

/** The shell registers the taxonomy labels for labelOf; the tests register the change types the same way. */
beforeAll(() =>
  registerTaxonomyLabels(changeTypeTaxonomyFixture().domains.flatMap((d) => d.terms)),
);
afterAll(() => clearTaxonomyLabels());

describe('change request fixtures match the contracts', () => {
  it.each([
    ['change request page', changeRequestPage, changeRequestPageFixture()],
    ['quarter-end check', quarterEndCheckResult, quarterEndCheckFixture()],
    ['valuation detail', valuationDetail, valuationDetailFixture()],
    ['mock users', mockUserList, mockUsersFixture()],
  ])('%s', (_name, schema, fixture) => {
    expect(() => schema.parse(fixture)).not.toThrow();
  });
});

describe('change request helpers (docs/18 section 8)', () => {
  const rows = changeRequestRows();

  it('takes the states from the transition table and knows which are still open', () => {
    expect(CHANGE_REQUEST_STATES).toEqual(dealChangeRequestMachine.states);
    expect(isChangeRequestState('InProgress')).toBe(true);
    expect(isChangeRequestState('Open')).toBe(false);
    expect(isOpenRequest('Submitted')).toBe(true);
    expect(isOpenRequest('Routed')).toBe(true);
    expect(isOpenRequest('InProgress')).toBe(true);
    expect(isOpenRequest('Applied')).toBe(false);
    expect(isOpenRequest('Rejected')).toBe(false);
  });

  it('counts requests per state and filters by state and position, keeping the order', () => {
    expect(requestCounts(rows)).toEqual({
      submitted: 1,
      routed: 1,
      inProgress: 1,
      applied: 1,
      rejected: 1,
    });
    expect(filterRequests(rows, { state: '', investmentId: '' })).toEqual(rows);
    expect(filterRequests(rows, { state: 'Applied', investmentId: '' }).map((r) => r.id)).toEqual([
      rows[3]!.id,
    ]);
    expect(
      filterRequests(rows, { state: '', investmentId: POSITION_ID.cobalt }).map((r) => r.id),
    ).toEqual([rows[2]!.id]);
    expect(filterRequests(rows, { state: 'Applied', investmentId: POSITION_ID.cobalt })).toEqual(
      [],
    );
  });

  it('names the positions on the rows once each, by name', () => {
    expect(investmentOptions([...rows, ...rows]).map((o) => o.name)).toEqual([
      'Ashby Renewables Group',
      'Cobalt Energy Group',
      'Meridian Data Partners',
      'Silverline Staffing Holdings',
      'Summit Services Co',
    ]);
  });

  it('words a request by its change type and position', () => {
    expect(requestLabel(rows[0]!)).toBe('Add-on acquisition for Meridian Data Partners');
  });

  it('reads who may read, submit and check from the route table', () => {
    expect(canReadQueue(['viewer'])).toBe(false);
    expect(canReadQueue(['auditor'])).toBe(true);
    expect(canSubmitRequest(['deal_team'])).toBe(true);
    expect(canSubmitRequest(['operations'])).toBe(true);
    expect(canSubmitRequest(['approver'])).toBe(false);
    expect(canRunQuarterEndCheck(['operations'])).toBe(true);
    expect(canRunQuarterEndCheck(['deal_team', 'approver'])).toBe(false);
  });

  it('offers the operations users with an id, plus owners already named, each once by name', () => {
    expect(ownerCandidates(mockUsersFixture().users, rows)).toEqual([
      { id: USER_ID.ops, name: PERSON.ops.name },
      { id: USER_ID.opsTwo, name: PERSON.opsTwo.name },
    ]);
    // Without the list (or a list without ids), the owners on the rows are still offered.
    expect(ownerCandidates(undefined, rows)).toEqual([{ id: USER_ID.ops, name: PERSON.ops.name }]);
    const noIds = mockUsersFixture().users.map(({ externalId, displayName, roles }) => ({
      externalId,
      displayName,
      roles,
    }));
    expect(ownerCandidates(noIds, [])).toEqual([]);
  });

  it('lists recent quarter ends latest first and the periods a request may be applied in', () => {
    expect(recentQuarterEnds('2025-08-15', 3)).toEqual(['2025-06-30', '2025-03-31', '2024-12-31']);
    expect(recentQuarterEnds('2025-06-30', 2)).toEqual(['2025-06-30', '2025-03-31']);
    expect(applicablePeriods('2025-04-30', '2025-08-15')).toEqual(['2025-06-30']);
    expect(applicablePeriods('2025-01-20', '2025-08-15')).toEqual(['2025-06-30', '2025-03-31']);
    // Effective after the latest quarter end: that quarter alone, so the API's rule is never broken.
    expect(applicablePeriods('2025-08-01', '2025-08-15')).toEqual(['2025-09-30']);
  });

  it('turns the form rows into the details record and drops rows without a name', () => {
    expect(
      detailsRecord([
        { key: ' target ', value: ' A regional competitor ' },
        { key: '', value: 'ignored' },
        { key: 'consideration', value: '4000000.00' },
      ]),
    ).toEqual({ target: 'A regional competitor', consideration: '4000000.00' });
  });

  it('refuses in the form what the contract refuses, field by field', () => {
    const valid = {
      investmentId: POSITION_ID.meridian,
      changeType: 'change_type.add_on_acquisition',
      effectiveDate: '2025-05-15',
      summary: 'Add-on acquisition closed',
      details: { target: 'A regional competitor' },
    };
    expect(formProblems(valid)).toEqual({});
    const problems = formProblems({ ...valid, changeType: '', effectiveDate: '', summary: 'ab' });
    expect(problems).toEqual({
      changeType: 'Choose a change type.',
      effectiveDate: 'Give the effective date.',
      summary: 'Summarize the change in 3 to 200 characters of plain text.',
    });
    expect(formProblems({ ...valid, details: { '': 'x' } })).toHaveProperty('details');
    expect(formProblems({ ...valid, effectiveDate: '2025-02-30' })).toHaveProperty('effectiveDate');
  });
});
