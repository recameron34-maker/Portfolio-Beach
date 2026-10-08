import { describe, expect, it } from 'vitest';
import { capitalNoticeDetail, capitalNoticePage, commitmentList } from '@pb/contracts';
import {
  commitmentListFixture,
  NOTICE_ID,
  noticeDetailFixture,
  noticePageFixture,
  noticeRows,
  settledDetailFixture,
} from '../../test/fixtures-capital.js';
import {
  ALERT_DAYS_BEFORE_DUE,
  byDueDate,
  cashFlowTone,
  dayCount,
  filterNotices,
  noticeAmount,
  noticeCounts,
  noticeSubject,
  noticeTypes,
  progressSteps,
  unfundedCaveats,
  unfundedChart,
} from './notices.js';

describe('capital fixtures match the contracts', () => {
  it.each([
    ['notice page', capitalNoticePage, noticePageFixture()],
    ['notice detail with a hold', capitalNoticeDetail, noticeDetailFixture()],
    ['settled notice detail', capitalNoticeDetail, settledDetailFixture()],
    ['commitments', commitmentList, commitmentListFixture()],
  ])('%s', (_name, schema, fixture) => {
    const result = schema.safeParse(fixture);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
});

describe('capital notice helpers', () => {
  it('reads the reminder days from config/definitions.json', () => {
    expect(ALERT_DAYS_BEFORE_DUE).toEqual([3, 1, 0]);
  });

  it('counts overdue and due soon only until the money moves', () => {
    expect(noticeCounts(noticeRows(), 3)).toEqual({
      overdue: 1,
      dueSoon: 1,
      inFlight: 5,
      reconciled: 1,
    });
  });

  it('filters on the client and sorts by due date, latest first', () => {
    const all = { state: '' as const, noticeType: '', vehicle: '', includeReconciled: true };
    expect(filterNotices(noticeRows(), all).map((n) => n.dueDate)).toEqual([
      '2025-07-20',
      '2025-07-12',
      '2025-07-02',
      '2025-06-27',
      '2025-06-25',
      '2025-01-15',
    ]);
    expect(filterNotices(noticeRows(), { ...all, includeReconciled: false })).toHaveLength(5);
    expect(
      filterNotices(noticeRows(), { ...all, noticeType: 'notice_type.capital_call' }),
    ).toHaveLength(2);
    expect(
      filterNotices(noticeRows(), { ...all, vehicle: 'Beach Credit Partners I' }),
    ).toHaveLength(3);
    expect(
      filterNotices(noticeRows(), { ...all, state: 'Reconciled', includeReconciled: false }),
    ).toEqual([]);
    expect(byDueDate(noticeRows()).map((n) => n.id)[0]).toBe(NOTICE_ID.reconciled);
  });

  it('names the company or the sponsor fund, and keeps a foreign currency code', () => {
    const [extracted, , reviewed] = noticeRows();
    expect(extracted && noticeSubject(extracted)).toBe('Silverline Staffing Holdings');
    expect(reviewed && noticeSubject(reviewed)).toBe('Kelpwood Fund I');
    expect(noticeAmount('2500000.00', 'USD')).toBe('$2.5M');
    expect(noticeAmount('2500000.00', 'EUR')).toBe('EUR 2.5M');
    expect(noticeAmount(null, 'EUR')).toBe('-');
    expect(dayCount(1)).toBe('1 day');
    expect(dayCount(3)).toBe('3 days');
  });

  it('orders notice types by label and maps cash flow statuses to tones', () => {
    expect(noticeTypes(noticeRows())).toEqual([
      'notice_type.capital_call',
      'notice_type.distribution',
      'notice_type.equalization',
      'notice_type.interest_payment',
      'notice_type.principal_repayment',
    ]);
    expect(cashFlowTone('record_status.approved')).toBe('good');
    expect(cashFlowTone('record_status.staged')).toBe('watch');
    expect(cashFlowTone('record_status.rejected')).toBe('bad');
  });

  it('marks the steps before the current state done and the rest upcoming', () => {
    expect(progressSteps('Reviewed').map((s) => s.status)).toEqual([
      'done',
      'done',
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
    expect(progressSteps('Reconciled').at(-1)?.status).toBe('current');
  });
});

describe('unfunded chart', () => {
  it('leaves out unknown unfunded, keeps an over-called commitment below zero and says both', () => {
    const chart = unfundedChart(commitmentListFixture().items);
    expect(chart.bars.map((b) => [b.label, b.display])).toEqual([
      ['Skerry Fund I', '$3.8M'],
      ['Kelpwood Fund I', '$2.2M'],
      ['Seagrass Growth Fund II', '$0.5M'],
      ['Oysterbed Credit Fund I', '-$0.4M'],
    ]);
    expect(chart.bars.at(-1)?.value).toBeLessThan(0);
    expect(chart.omitted).toBe(1);
    expect(unfundedCaveats(chart)).toEqual([
      '1 commitment has no recorded cash flow, so its unfunded is not known and it is left out.',
      'Oysterbed Credit Fund I is called beyond its commitment, so its unfunded reads below zero.',
    ]);
  });

  it('keeps one bar per commitment when two accounts commit to the same fund', () => {
    const items = commitmentListFixture().items.map((r) =>
      r.clientName === null ? r : { ...r, called: '1000000', recallable: '0', unfunded: '5000000' },
    );
    const labels = unfundedChart(items).bars.map((b) => b.label);
    expect(labels).toContain('Seagrass Growth Fund II (Client Gamma Insurance)');
    expect(labels).toContain('Seagrass Growth Fund II (Beach Primary Program)');
    expect(new Set(labels).size).toBe(labels.length);
  });
});
