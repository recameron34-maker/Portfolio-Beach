import { describe, expect, it } from 'vitest';
import { MISSING } from '../../lib/format.js';
import {
  dealDetailFixture,
  ENTRY_SNAPSHOT,
  equityPerformanceFixture,
  valuationPageFixture,
} from '../../test/fixtures-deal.js';
import {
  ALERT_DAYS_BEFORE_DUE,
  approvedQuarters,
  AUDIT_ROLES,
  axisPeriod,
  canReadAudit,
  datePart,
  isApproved,
  isSettled,
  lockedSeries,
  quarterRowsNewestFirst,
  sinceEntryGap,
  timelineEntries,
  versionsNewestFirst,
} from './data.js';

describe('deal tab helpers', () => {
  it('reads the audit roles from the route table and checks a role set against them', () => {
    expect([...AUDIT_ROLES].sort()).toEqual([
      'approver',
      'auditor',
      'operations',
      'platform_admin',
    ]);
    expect(canReadAudit(['operations'])).toBe(true);
    expect(canReadAudit(['viewer', 'auditor'])).toBe(true);
    expect(canReadAudit(['deal_team'])).toBe(false);
    expect(canReadAudit([])).toBe(false);
  });

  it('takes the alert window from config, never a literal', () => {
    expect(ALERT_DAYS_BEFORE_DUE).toEqual([3, 1, 0]);
  });

  it('treats only approved rows as approved and only funded or reconciled notices as settled', () => {
    expect(isApproved('record_status.approved')).toBe(true);
    expect(isApproved('approved')).toBe(true);
    expect(isApproved('record_status.draft')).toBe(false);
    expect(isSettled('Funded')).toBe(true);
    expect(isSettled('Reconciled')).toBe(true);
    expect(isSettled('TicketApproved')).toBe(false);
  });

  it('places the entry snapshot by its own date among the quarters, newest first', () => {
    const perf = equityPerformanceFixture();
    expect(quarterRowsNewestFirst(perf).map((q) => [q.periodEnd, q.isEntrySnapshot])).toEqual([
      ['2025-06-30', false],
      ['2025-03-31', false],
      ['2024-12-31', false],
      ['2018-09-30', true],
    ]);
    const forward = equityPerformanceFixture({
      entry: { ...ENTRY_SNAPSHOT, periodEnd: '2025-09-30' },
    });
    expect(quarterRowsNewestFirst(forward)[0]?.isEntrySnapshot).toBe(true);
    expect(approvedQuarters(perf).map((q) => q.periodEnd)).toEqual(['2024-12-31', '2025-03-31']);
  });

  it('names why growth since entry is missing', () => {
    expect(sinceEntryGap(equityPerformanceFixture())).toBeNull();
    expect(sinceEntryGap(equityPerformanceFixture({ entry: null, sinceEntry: null }))).toBe(
      'no_entry',
    );
    expect(
      sinceEntryGap(
        equityPerformanceFixture({
          entry: { ...ENTRY_SNAPSHOT, periodEnd: '2025-09-30' },
          sinceEntry: null,
        }),
      ),
    ).toBe('forward_entry');
    expect(sinceEntryGap(equityPerformanceFixture({ sinceEntry: null }))).toBe('no_quarter');
  });

  it('orders versions newest first and plots one Locked value per period', () => {
    const rows = valuationPageFixture().items;
    expect(versionsNewestFirst(rows).map((v) => `${v.periodEnd} v${v.version}`)).toEqual([
      '2025-06-30 v1',
      '2025-03-31 v2',
      '2025-03-31 v1',
      '2024-12-31 v1',
    ]);
    expect(lockedSeries(rows).map((v) => `${v.periodEnd} v${v.version}`)).toEqual([
      '2024-12-31 v1',
      '2025-03-31 v2',
    ]);
    // Two Locked versions for one period (never expected, docs/18): the higher version wins.
    const doubled = [...rows, { ...rows[0]!, version: 5, fairValue: '1.00' }];
    expect(lockedSeries(doubled)[0]?.version).toBe(5);
  });

  it('builds timeline entries newest first, later versions ahead within a date', () => {
    const entries = timelineEntries(dealDetailFixture(), []);
    expect(entries.map((e) => `${e.date} ${e.kind}`)).toEqual([
      '2025-06-30 Valuation',
      '2025-03-31 Valuation',
      '2025-03-31 Valuation',
      '2024-12-31 Valuation',
      '2024-07-30 Cash flow',
      '2018-11-15 Cash flow',
    ]);
    expect(entries[1]?.text).toBe('Valuation Mar 31, 2025 v2: Locked');
    expect(entries[2]?.text).toBe('Valuation Mar 31, 2025 v1: Reopened');
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });

  it('shortens chart axis labels from formatMonthYear and keeps the date part of a timestamp', () => {
    expect(axisPeriod('2025-06-30')).toBe('Jun 2025');
    expect(axisPeriod('2024-09-30')).toBe('Sep 2024');
    expect(axisPeriod('not a date')).toBe(MISSING);
    expect(datePart('2025-05-02T09:30:00.000Z')).toBe('2025-05-02');
  });
});
