import { describe, expect, it } from 'vitest';
import {
  dealDetailFixture,
  ENTRY_SNAPSHOT,
  equityPerformanceFixture,
  valuationPageFixture,
} from '../../test/fixtures-deal.js';
import { clearTaxonomyLabels, MISSING, registerTaxonomyLabels } from '../../lib/format.js';
import {
  ALERT_DAYS_BEFORE_DUE,
  approvedQuarters,
  AUDIT_ROLES,
  canReadAudit,
  canSetOutlook,
  datePart,
  documentHref,
  HORIZON_MONTHS,
  isApproved,
  isHorizon,
  isOutlookCode,
  isSettled,
  lockedSeries,
  OUTLOOK_CODES,
  OUTLOOK_ROLES,
  outlookLabel,
  quarterRowsNewestFirst,
  runHref,
  sinceEntryGap,
  sourceLabel,
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

  it('keeps the date part of a timestamp', () => {
    expect(datePart('2025-05-02T09:30:00.000Z')).toBe('2025-05-02');
  });
});

describe('deal tab helpers for Phase 2: sources, documents and the outlook', () => {
  it('reads the outlook roles from the route table and checks a role set against them', () => {
    expect([...OUTLOOK_ROLES]).toEqual(['deal_team']);
    expect(canSetOutlook(['deal_team'])).toBe(true);
    expect(canSetOutlook(['viewer', 'deal_team'])).toBe(true);
    expect(canSetOutlook(['operations'])).toBe(false);
    expect(canSetOutlook(['approver'])).toBe(false);
    expect(canSetOutlook([])).toBe(false);
  });

  it('lists the outlook codes the contract allows and labels them from the taxonomy', () => {
    expect([...OUTLOOK_CODES]).toEqual(['none', 'partial', 'full']);
    expect(isOutlookCode('partial')).toBe(true);
    expect(isOutlookCode('soon')).toBe(false);
    expect(isOutlookCode('')).toBe(false);
    expect(outlookLabel('partial')).toBe('Partial');
    registerTaxonomyLabels([{ code: 'realization_outlook.full', label: 'Full realization' }]);
    try {
      expect(outlookLabel('full')).toBe('Full realization');
      expect(outlookLabel('none')).toBe('None');
    } finally {
      clearTaxonomyLabels();
    }
  });

  it('accepts a horizon only as a whole number of months inside the contract bounds', () => {
    expect(HORIZON_MONTHS).toEqual({ min: 1, max: 120 });
    expect(isHorizon('18')).toBe(true);
    expect(isHorizon(' 1 ')).toBe(true);
    expect(isHorizon('120')).toBe(true);
    expect(isHorizon('0')).toBe(false);
    expect(isHorizon('121')).toBe(false);
    expect(isHorizon('-3')).toBe(false);
    expect(isHorizon('1.5')).toBe(false);
    expect(isHorizon('1e1')).toBe(false);
    expect(isHorizon('')).toBe(false);
    expect(isHorizon('twelve')).toBe(false);
  });

  it('builds the hub paths with the id encoded', () => {
    expect(documentHref('a0000000-0000-4000-8000-000000000001')).toBe(
      '/documents/a0000000-0000-4000-8000-000000000001',
    );
    expect(runHref('a0000000-0000-4000-8000-000000000005')).toBe(
      '/documents/extraction/a0000000-0000-4000-8000-000000000005',
    );
    expect(documentHref('odd/id?x')).toBe('/documents/odd%2Fid%3Fx');
  });

  it('words the source of a quarter as the page, the document, or the missing placeholder', () => {
    const documentId = 'a0000000-0000-4000-8000-000000000001';
    expect(sourceLabel(null)).toBe(MISSING);
    expect(sourceLabel({ documentId, runId: null, page: 3, locator: 'field:revenue_ltm' })).toBe(
      'page 3',
    );
    expect(sourceLabel({ documentId, runId: null, page: null, locator: null })).toBe('document');
  });
});
