import { describe, expect, it } from 'vitest';
import type { CapitalNoticeDetail, CapitalNoticePage, ValuationPage } from '@pb/contracts';
import { Recordings } from './fixtures.js';
import {
  overlayCapitalNoticeDetail,
  overlayCapitalNoticePage,
  overlayFlags,
  overlayInvestmentDetail,
  overlayRecordedBody,
  overlayValuationPage,
} from './overlay.js';
import { createPreviewState } from './state.js';
import type { SimNotice, SimValuation } from './state.js';
import {
  AS_OF,
  FixtureBuilder,
  IDS,
  USERS,
  investmentFixture,
  noticeFixture,
  valuationFixture,
} from './test-fixtures.js';

const open = investmentFixture(IDS.open, {
  valuations: [
    { periodEnd: '2025-03-31', version: 1, state: 'Locked', fairValue: '1000.00', method: 'm' },
  ],
});
const walled = investmentFixture(IDS.walled);
const recordedRow = valuationFixture(IDS.valuation.openPrior, open, { fairValue: '1000.00' });

const sim = (row: SimValuation['row'], extra: Partial<SimValuation> = {}): SimValuation => ({
  row,
  origin: 'recorded',
  changed: true,
  vehicleId: null,
  preparedByIds: [],
  dealTeamApprovedByIds: [],
  approvedByIds: [],
  ...extra,
});

const page = (items: ValuationPage['items']): ValuationPage => ({
  items,
  nextCursor: null,
  asOf: AS_OF,
  periods: ['2025-03-31'],
});

const created = valuationFixture('50000000-0000-4000-8000-000000000001', open, {
  periodEnd: '2025-06-30',
  state: 'Draft',
});
const createdWalled = valuationFixture('50000000-0000-4000-8000-000000000002', walled, {
  periodEnd: '2025-06-30',
  state: 'Draft',
});
const everyone = (): boolean => true;
const notWalled = (id: string): boolean => id !== IDS.walled;

describe('valuation list overlay', () => {
  it('returns the recorded page itself when nothing was simulated', () => {
    const p = page([recordedRow]);
    expect(overlayValuationPage(p, [], {}, everyone)).toBe(p);
    expect(overlayValuationPage(p, [sim(recordedRow, { changed: false })], {}, everyone)).toBe(p);
  });

  it('replaces changed rows by id and keeps the recorded order', () => {
    const reopened = { ...recordedRow, state: 'Reopened' as const, rowVersion: 2 };
    const out = overlayValuationPage(page([recordedRow]), [sim(reopened)], {}, everyone);
    expect(out.items).toEqual([reopened]);
  });

  it('adds created rows only where the credential can open the investment, and syncs the periods', () => {
    const sims = [sim(created, { origin: 'created' }), sim(createdWalled, { origin: 'created' })];
    const out = overlayValuationPage(page([recordedRow]), sims, {}, notWalled);
    expect(out.items.map((r) => r.id)).toEqual([created.id, recordedRow.id]);
    expect(out.periods).toEqual(['2025-06-30', '2025-03-31']);
    const member = overlayValuationPage(page([recordedRow]), sims, {}, everyone);
    expect(member.items).toHaveLength(3);
  });

  it('respects the filters of the recorded query', () => {
    const sims = [sim(created, { origin: 'created', vehicleId: IDS.vehicle }), sim(createdWalled)];
    const byInvestment = overlayValuationPage(
      page([]),
      sims,
      { investmentId: IDS.walled },
      everyone,
    );
    expect(byInvestment.items.map((r) => r.id)).toEqual([createdWalled.id]);
    const byState = overlayValuationPage(page([recordedRow]), sims, { state: 'Locked' }, everyone);
    expect(byState.items).toEqual([recordedRow]);
    const reopened = { ...recordedRow, state: 'Reopened' as const };
    expect(
      overlayValuationPage(page([recordedRow]), [sim(reopened)], { state: 'Locked' }, everyone)
        .items,
    ).toEqual([]);
    // A vehicle filter adds a row only when its vehicle is known and matches.
    const byVehicle = overlayValuationPage(page([]), sims, { vehicleId: IDS.vehicle }, everyone);
    expect(byVehicle.items.map((r) => r.id)).toEqual([created.id]);
  });
});

describe('investment detail overlay', () => {
  it('lays simulated versions over the one-pager list in period and version order', () => {
    const lockedAgain = { ...recordedRow, version: 1, state: 'Reopened' as const };
    const out = overlayInvestmentDetail(open, [sim(created), sim(lockedAgain), sim(createdWalled)]);
    expect(out.valuations).toEqual([
      {
        periodEnd: '2025-03-31',
        version: 1,
        state: 'Reopened',
        fairValue: '1000.00',
        method: recordedRow.method,
      },
      {
        periodEnd: '2025-06-30',
        version: 1,
        state: 'Draft',
        fairValue: created.fairValue,
        method: created.method,
      },
    ]);
    expect(out.nav).toBe(open.nav);
    expect(overlayInvestmentDetail(open, [sim(createdWalled)])).toBe(open);
  });
});

describe('capital notice overlays', () => {
  const extracted = noticeFixture(IDS.notice.Extracted, { state: 'Extracted' });
  const reconciled = noticeFixture(IDS.notice.Reconciled);
  const reviewed: SimNotice = {
    row: { ...extracted, state: 'Reviewed', rowVersion: 2 },
    changed: true,
    ticketPreparedBy: null,
  };
  const notices: CapitalNoticePage = {
    items: [extracted, reconciled],
    nextCursor: null,
    asOf: AS_OF,
    attention: [extracted],
    alertDaysBeforeDue: 3,
  };

  it('replaces by id in the items and the attention list', () => {
    const out = overlayCapitalNoticePage(notices, [reviewed], {});
    expect(out.items[0]?.state).toBe('Reviewed');
    expect(out.attention[0]?.state).toBe('Reviewed');
    expect(out.items[1]).toBe(reconciled);
    // A list filtered to Extracted loses the notice once it moves on; attention keeps it.
    const onlyExtracted = { ...notices, items: [extracted] };
    const filtered = overlayCapitalNoticePage(onlyExtracted, [reviewed], { state: 'Extracted' });
    expect(filtered.items).toEqual([]);
    expect(filtered.attention[0]?.state).toBe('Reviewed');
    expect(overlayCapitalNoticePage(notices, [{ ...reviewed, changed: false }], {})).toBe(notices);
  });

  it('updates the detail state and row version only', () => {
    const detail: CapitalNoticeDetail = {
      ...extracted,
      cashFlows: [],
      wireChangeHold: null,
      notes: ['n'],
    };
    expect(overlayCapitalNoticeDetail(detail, reviewed)).toEqual({
      ...detail,
      state: 'Reviewed',
      rowVersion: 2,
    });
    expect(overlayCapitalNoticeDetail(detail, undefined)).toBe(detail);
  });
});

describe('flag overlay and the recorded-body dispatcher', () => {
  it('overrides flags by key', () => {
    const list = { flags: [{ key: 'ai.extraction', enabled: false, description: 'd' }] };
    expect(overlayFlags(list, new Map([['ai.extraction', true]])).flags[0]?.enabled).toBe(true);
    expect(overlayFlags(list, new Map([['other', true]]))).toBe(list);
  });

  it('leaves the recorded text untouched when no overlay applies or the body is off contract', () => {
    const recordings = new Recordings(new FixtureBuilder([USERS.viewer]).build());
    const state = createPreviewState();
    const ctx = { credential: 'viewer.one', recordings, state };
    const url = new URL('http://x.invalid/api/v1/valuations?limit=200');
    expect(overlayRecordedBody(url, '{"items":[]}', ctx)).toBe('{"items":[]}');
    state.valuations = new Map([[created.id, sim(created)]]);
    expect(overlayRecordedBody(url, '{"not":"a page"}', ctx)).toBe('{"not":"a page"}');
    // The viewer has no recorded detail for the investment, so nothing is added.
    const text = JSON.stringify(page([]));
    expect(overlayRecordedBody(url, text, ctx)).toBe(text);
  });
});
