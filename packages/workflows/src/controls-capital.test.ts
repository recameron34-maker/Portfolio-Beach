import { describe, expect, it } from 'vitest';
import {
  REGISTER_READERS,
  activeVersionOf,
  belongsToCounterparty,
  businessDaysBetween,
  holdUntil,
  insideHoldWindow,
  noticeAlerts,
  olderThanVerified,
  pendingChange,
  readsRegister,
  recentVerifiedChange,
  registerViewOf,
  releaseOf,
  utcDateOf,
  weekdayOf,
} from './controls-capital.js';
import type { AlertInput, RegisterVersion, RegisterView } from './controls-capital.js';

/*
 * The capital controls as pure rules (docs/04 M16, docs/18 sections 3 and 11, SEC-12.2 to
 * SEC-12.4): the API and the preview simulation read the same functions, so these tables are the
 * one place the business-day count, the hold window, the alerts and the release blockers are
 * pinned. Every date is given; nothing here reads a clock.
 */

const FUND = '10000000-0000-4000-8000-000000000001';
const OTHER_FUND = '10000000-0000-4000-8000-000000000002';
const INVESTMENT = '10000000-0000-4000-8000-000000000003';
const OPS = '20000000-0000-4000-8000-000000000001';
const OPS_TWO = '20000000-0000-4000-8000-000000000002';
const HEAD = '20000000-0000-4000-8000-000000000003';
const HOLD = 30;

let serial = 0;
function version(overrides: Partial<RegisterVersion> = {}): RegisterVersion {
  serial += 1;
  return {
    id: `30000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
    counterparty: { kind: 'sponsor_fund', id: FUND },
    version: 1,
    state: 'Verified',
    proposedBy: { id: OPS },
    proposedAt: '2025-01-10T10:00:00.000Z',
    callback: { by: { id: OPS_TWO } },
    active: true,
    ...overrides,
  };
}

const view = (versions: RegisterVersion[]): RegisterView =>
  registerViewOf(versions, { sponsorFundId: FUND, investmentId: INVESTMENT });

describe('business days (Monday to Friday, no holiday calendar)', () => {
  it('names the weekday of a date: 0 is Sunday, 6 is Saturday', () => {
    expect(weekdayOf('1970-01-01')).toBe(4);
    expect(weekdayOf('2025-06-29')).toBe(0);
    expect(weekdayOf('2025-06-30')).toBe(1);
    expect(weekdayOf('2025-07-05')).toBe(6);
    expect(weekdayOf('1969-12-28')).toBe(0);
  });

  it.each([
    ['2025-06-30', '2025-06-30', 0],
    ['2025-06-30', '2025-07-01', 1],
    ['2025-06-30', '2025-07-02', 2],
    ['2025-06-30', '2025-07-04', 4],
    // Monday to the next Monday: five weekdays; the weekend counts nothing.
    ['2025-06-30', '2025-07-05', 4],
    ['2025-06-30', '2025-07-06', 4],
    ['2025-06-30', '2025-07-07', 5],
    // From a Friday, the next business day is Monday.
    ['2025-07-04', '2025-07-05', 0],
    ['2025-07-04', '2025-07-07', 1],
    // From a Saturday or a Sunday, Monday is one business day away.
    ['2025-07-05', '2025-07-07', 1],
    ['2025-07-06', '2025-07-07', 1],
    ['2025-06-30', '2025-07-28', 20],
    ['2025-06-30', '2025-07-30', 22],
    // Across a year end.
    ['2024-12-31', '2025-01-02', 2],
  ])('counts the weekdays after %s up to and including %s as %i', (from, to, expected) => {
    expect(businessDaysBetween(from, to)).toBe(expected);
  });

  it('is negative when the second date is earlier, counting the weekdays after it up to the first', () => {
    expect(businessDaysBetween('2025-07-02', '2025-06-30')).toBe(-2);
    expect(businessDaysBetween('2025-07-07', '2025-07-04')).toBe(-1);
    // Saturday back to Friday: no weekday lies after Friday up to Saturday.
    expect(businessDaysBetween('2025-07-05', '2025-07-04')).toBe(-0);
  });
});

describe('the SEC-12.4 alerts of a notice', () => {
  const base: AlertInput = {
    state: 'Extracted',
    urgencyFlag: false,
    wireChangeFlag: false,
    dueDate: '2025-07-30',
    asOf: '2025-06-30',
    dueSoonBusinessDays: 2,
    wireVerified: true,
  };

  it('is empty when nothing needs attention', () => {
    expect(noticeAlerts(base)).toEqual([]);
  });

  it('lists every alert in the contract order', () => {
    expect(
      noticeAlerts({
        ...base,
        urgencyFlag: true,
        wireChangeFlag: true,
        dueDate: '2025-07-01',
        wireVerified: false,
      }),
    ).toEqual([
      'wire_changed',
      'urgency_language',
      'due_within_two_business_days',
      'unverified_instruction',
    ]);
  });

  it('alerts on a due date under the configured number of business days away, an overdue one included', () => {
    expect(noticeAlerts({ ...base, dueDate: '2025-07-01' })).toEqual([
      'due_within_two_business_days',
    ]);
    // Exactly two business days away is not under two.
    expect(noticeAlerts({ ...base, dueDate: '2025-07-02' })).toEqual([]);
    expect(noticeAlerts({ ...base, dueDate: '2025-06-15' })).toEqual([
      'due_within_two_business_days',
    ]);
    expect(noticeAlerts({ ...base, dueDate: '2025-07-02', dueSoonBusinessDays: 3 })).toEqual([
      'due_within_two_business_days',
    ]);
  });

  it('drops the due date alert once the wire is out, and keeps the others', () => {
    for (const state of ['Funded', 'Reconciled'] as const)
      expect(noticeAlerts({ ...base, state, dueDate: '2025-06-15', wireChangeFlag: true })).toEqual(
        ['wire_changed'],
      );
    expect(noticeAlerts({ ...base, state: 'TicketApproved', dueDate: '2025-06-15' })).toEqual([
      'due_within_two_business_days',
    ]);
  });
});

describe('the register of one counterparty', () => {
  it('reads a timestamp as its UTC calendar date', () => {
    expect(utcDateOf('2025-06-30T09:00:00.000Z')).toBe('2025-06-30');
    expect(utcDateOf('2025-06-30T23:30:00.000-05:00')).toBe('2025-07-01');
  });

  it('holds the versions keyed by either key of the counterparty, in the order given', () => {
    const ofFund = version();
    const ofInvestment = version({
      counterparty: { kind: 'investment', id: INVESTMENT },
      active: false,
    });
    const other = version({ counterparty: { kind: 'sponsor_fund', id: OTHER_FUND } });
    const keys = { sponsorFundId: FUND, investmentId: INVESTMENT };
    expect(belongsToCounterparty(ofFund, keys)).toBe(true);
    expect(belongsToCounterparty(ofInvestment, keys)).toBe(true);
    expect(belongsToCounterparty(other, keys)).toBe(false);
    // An investment id never matches a fund-level version, nor the reverse.
    expect(belongsToCounterparty(ofFund, { sponsorFundId: null, investmentId: FUND })).toBe(false);
    expect(belongsToCounterparty(ofFund, { sponsorFundId: null, investmentId: null })).toBe(false);
    const register = registerViewOf([ofInvestment, other, ofFund], keys);
    expect(register.versions).toEqual([ofInvestment, ofFund]);
    expect(register.active).toBe(ofFund);
  });

  it('prefers the investment-level active version over the fund-level one', () => {
    const ofFund = version();
    const ofInvestment = version({ counterparty: { kind: 'investment', id: INVESTMENT } });
    expect(activeVersionOf([ofFund, ofInvestment])).toBe(ofInvestment);
    expect(activeVersionOf([ofFund])).toBe(ofFund);
    expect(activeVersionOf([version({ active: false })])).toBeNull();
    expect(activeVersionOf([])).toBeNull();
  });

  it('is read by operations, approvers, auditors, platform admins and the system actor only', () => {
    expect([...REGISTER_READERS].sort()).toEqual(
      ['approver', 'auditor', 'operations', 'platform_admin', 'service'].sort(),
    );
    for (const role of REGISTER_READERS) expect(readsRegister({ roles: [role] })).toBe(true);
    for (const role of ['viewer', 'deal_team', 'investor_relations'])
      expect(readsRegister({ roles: [role] })).toBe(false);
    expect(readsRegister({ roles: ['viewer', 'auditor'] })).toBe(true);
    expect(readsRegister({ roles: [] })).toBe(false);
  });
});

describe('the hold window (SEC-12.3)', () => {
  it('runs from the proposal date for the configured days, the last day excluded', () => {
    expect(holdUntil('2025-06-30T09:00:00.000Z', HOLD)).toBe('2025-07-30');
    expect(insideHoldWindow('2025-06-30T09:00:00.000Z', '2025-06-30', HOLD)).toBe(true);
    expect(insideHoldWindow('2025-06-30T09:00:00.000Z', '2025-07-29', HOLD)).toBe(true);
    expect(insideHoldWindow('2025-06-30T09:00:00.000Z', '2025-07-30', HOLD)).toBe(false);
  });

  it('a pending change is the latest version other than the active one, not Rejected, inside the window', () => {
    const active = version();
    const proposed = version({
      version: 2,
      state: 'Proposed',
      proposedAt: '2025-06-30T09:00:00.000Z',
      callback: null,
      active: false,
    });
    const register = view([proposed, active]);
    expect(pendingChange(register, '2025-06-30', HOLD)).toBe(proposed);
    expect(pendingChange(register, '2025-07-29', HOLD)).toBe(proposed);
    expect(pendingChange(register, '2025-07-30', HOLD)).toBeNull();
    // The active version is never the pending change, however recent.
    expect(pendingChange(view([active]), '2025-01-10', HOLD)).toBeNull();
    expect(pendingChange(view([]), '2025-06-30', HOLD)).toBeNull();
  });

  it('a Rejected version holds nothing; a Superseded one inside the window does; the latest wins', () => {
    const rejected = version({
      version: 3,
      state: 'Rejected',
      proposedAt: '2025-06-29T09:00:00.000Z',
      active: false,
    });
    const superseded = version({
      version: 1,
      state: 'Superseded',
      proposedAt: '2025-06-20T09:00:00.000Z',
      active: false,
    });
    const later = version({
      version: 4,
      state: 'Proposed',
      proposedAt: '2025-06-28T09:00:00.000Z',
      callback: null,
      active: false,
    });
    expect(pendingChange(view([rejected]), '2025-06-30', HOLD)).toBeNull();
    expect(pendingChange(view([superseded]), '2025-06-30', HOLD)).toBe(superseded);
    expect(pendingChange(view([rejected, superseded, later]), '2025-06-30', HOLD)).toBe(later);
  });

  it('a verified change is recent while the active version is inside the window from its proposal', () => {
    const active = version({ proposedAt: '2025-06-30T09:00:00.000Z' });
    const register = view([active]);
    expect(recentVerifiedChange(register, '2025-06-30', HOLD)).toBe(active);
    expect(recentVerifiedChange(register, '2025-07-29', HOLD)).toBe(active);
    expect(recentVerifiedChange(register, '2025-07-30', HOLD)).toBeNull();
    expect(recentVerifiedChange(view([version({ active: false })]), '2025-06-30', HOLD)).toBeNull();
  });
});

describe('verifying an older version (SEC-12.2)', () => {
  it('is older than Verified when a Verified version of the same key has a higher number', () => {
    const v2 = version({ version: 2, state: 'Proposed', active: false });
    const v3 = version({ version: 3 });
    const v1 = version({ version: 1, state: 'Superseded', active: false });
    expect(olderThanVerified(v2, [v1, v2, v3])).toBe(true);
    expect(olderThanVerified(v2, [v1, v2])).toBe(false);
    // A newer version that is not Verified does not count, nor a Verified one of another key.
    expect(olderThanVerified(v2, [v2, { ...v3, state: 'Rejected' }])).toBe(false);
    expect(
      olderThanVerified(v2, [
        v2,
        { ...v3, counterparty: { kind: 'sponsor_fund', id: OTHER_FUND } },
      ]),
    ).toBe(false);
    expect(
      olderThanVerified(v2, [v2, { ...v3, counterparty: { kind: 'investment', id: FUND } }]),
    ).toBe(false);
  });
});

describe('the release check of a trade ticket (SEC-12.3)', () => {
  const quiet = (): RegisterView => view([version()]);
  const reader = (userId: string, asOf = '2025-06-30') => ({ userId, asOf, holdDays: HOLD });
  const drafted = { state: 'Drafted' as const, preparedBy: OPS };

  it('allows a second person against a Verified instruction nothing changed', () => {
    expect(releaseOf(drafted, quiet(), reader(HEAD))).toEqual({ allowed: true, blockers: [] });
  });

  it('judges nothing on a Funded or Withdrawn ticket', () => {
    for (const state of ['Funded', 'Withdrawn'] as const)
      expect(releaseOf({ state, preparedBy: OPS }, view([]), reader(OPS))).toEqual({
        allowed: false,
        blockers: [],
      });
  });

  it('reports an Approved ticket with the same checks as a Drafted one', () => {
    expect(releaseOf({ state: 'Approved', preparedBy: OPS }, quiet(), reader(OPS))).toEqual({
      allowed: false,
      blockers: ['same_person'],
    });
  });

  it('says no instruction when the register is empty and unverified when none is active', () => {
    expect(releaseOf(drafted, view([]), reader(HEAD)).blockers).toEqual(['no_instruction']);
    expect(
      releaseOf(drafted, view([version({ state: 'Superseded', active: false })]), reader(HEAD))
        .blockers,
    ).toEqual(['unverified_instruction']);
  });

  it('lists the blockers in the contract order', () => {
    const proposed = version({
      version: 2,
      state: 'Proposed',
      proposedAt: '2025-06-30T09:00:00.000Z',
      callback: null,
      active: false,
    });
    expect(releaseOf(drafted, view([proposed]), reader(OPS)).blockers).toEqual([
      'unverified_instruction',
      'changed_within_hold',
      'same_person',
    ]);
    const recent = version({ proposedAt: '2025-06-20T09:00:00.000Z' });
    expect(releaseOf(drafted, view([proposed, recent]), reader(OPS)).blockers).toEqual([
      'changed_within_hold',
      'same_person',
      'verifier_within_hold',
    ]);
  });

  it('inside the window after a verified change, takes a third person: not its proposer, not its verifier', () => {
    const recent = (): RegisterView => view([version({ proposedAt: '2025-06-20T09:00:00.000Z' })]);
    const byHead = { state: 'Drafted' as const, preparedBy: HEAD };
    expect(releaseOf(byHead, recent(), reader(OPS)).blockers).toEqual(['verifier_within_hold']);
    expect(releaseOf(byHead, recent(), reader(OPS_TWO)).blockers).toEqual(['verifier_within_hold']);
    expect(releaseOf(drafted, recent(), reader(HEAD))).toEqual({ allowed: true, blockers: [] });
    // Day 29 still holds the two; day 30 is past the window and dual control alone stands.
    expect(releaseOf(byHead, recent(), reader(OPS_TWO, '2025-07-19')).blockers).toEqual([
      'verifier_within_hold',
    ]);
    expect(releaseOf(byHead, recent(), reader(OPS_TWO, '2025-07-20'))).toEqual({
      allowed: true,
      blockers: [],
    });
  });
});
