import { describe, expect, it } from 'vitest';
import type {
  CapitalNoticeDetail,
  CapitalNoticePage,
  InvestmentPerformance,
  QuarterRow,
  ValuationPage,
} from '@pb/contracts';
import { Recordings } from './fixtures.js';
import {
  overlayCapitalNoticeDetail,
  overlayCapitalNoticePage,
  overlayDataHealth,
  overlayFlags,
  overlayInvestmentDetail,
  overlayInvestmentPerformance,
  overlayRecordedBody,
  overlayValuationPage,
} from './overlay.js';
import { createPreviewState } from './state.js';
import type { SimException, SimNotice, SimPromotedQuarter, SimValuation } from './state.js';
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
      ticket: null,
      activeWireInstruction: null,
      alerts: [],
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

  it('adds the open and acknowledged simulated exceptions to the recorded Data Health count', () => {
    const health = {
      asOf: AS_OF,
      orphanInvestments: 0,
      openExceptions: 2,
      staleInvestments: 0,
      staleAfterDays: 75,
      vehiclesWithOwnershipGap: [],
      lockedValuationsLatestQuarter: 1,
      activeInvestments: 1,
    };
    const exception = (id: string, state: SimException['state']): SimException => ({
      id,
      source: 'accounting_import',
      entity: 'stg.intake_row',
      entityId: 'r',
      ruleId: 'TIE-01',
      expected: null,
      actual: null,
      severity: 'exception_severity.high',
      ownerId: null,
      ownerName: null,
      state,
      externalTicket: null,
      candidates: [],
      createdAt: '2025-07-01T00:00:00.000Z',
      updatedAt: '2025-07-01T00:00:00.000Z',
      rowVersion: 1,
      context: { intakeFileId: 'f', intakeFileName: 'x.csv', rowNo: 1, investmentId: null },
    });
    expect(overlayDataHealth(health, [])).toBe(health);
    expect(
      overlayDataHealth(health, [
        exception('a', 'open'),
        exception('b', 'acknowledged'),
        exception('c', 'resolved'),
        exception('d', 'wont_fix'),
      ]).openExceptions,
    ).toBe(4);
    const recordings = new Recordings(new FixtureBuilder([USERS.viewer]).build());
    const state = createPreviewState();
    state.exceptions.set('a', exception('a', 'open'));
    const url = new URL('http://x.invalid/api/v1/data-health');
    const text = JSON.stringify(health);
    const out = JSON.parse(
      overlayRecordedBody(url, text, { credential: 'viewer.one', recordings, state }),
    ) as typeof health;
    expect(out.openExceptions).toBe(3);
  });

  it('lays a promoted quarter over the recorded performance with its source and derives the ratios again', () => {
    const quarter = (periodEnd: string, revenue: string, ebitda: string): QuarterRow => ({
      periodEnd,
      isEntrySnapshot: false,
      status: 'record_status.approved',
      revenueLtm: revenue,
      ebitdaLtm: ebitda,
      ev: '500000000',
      netDebt: '100000000',
      cash: null,
      totalEquity: null,
      evToEbitda: '9.99',
      netDebtToEbitda: '9.99',
      ebitdaMargin: '9.99',
      revenueYoy: null,
      ebitdaYoy: null,
      highlights: ['As recorded.'],
      source: null,
    });
    const entry: QuarterRow = {
      ...quarter('2023-06-30', '80000000', '16000000'),
      isEntrySnapshot: true,
    };
    const perf: InvestmentPerformance = {
      investmentId: IDS.open,
      asOf: '2025-06-30',
      entry,
      quarters: [
        quarter('2024-06-30', '100000000', '20000000'),
        quarter('2025-03-31', '110000000', '22000000'),
      ],
      sinceEntry: null,
      credit: null,
      realizationOutlook: null,
      calcVersion: 'test',
    };
    const promoted = (
      periodEnd: string,
      figures: SimPromotedQuarter['figures'],
    ): SimPromotedQuarter => ({
      id: 'q-1',
      investmentId: IDS.open,
      periodEnd,
      created: false,
      figures,
      approvedById: USERS.deal.userId,
      approvedBy: USERS.deal.displayName,
      approvedAt: '2025-07-01T09:00:00.000Z',
      approvalReason: 'checked',
      highlights: ['LTM revenue rose.'],
      source: {
        documentId: IDS.states,
        runId: IDS.twoChains,
        page: 2,
        locator: 'field:revenue_ltm',
      },
      promptVersion: '1',
      modelId: 'mock',
    });
    // Nothing promoted for this investment: the answer is the very object.
    expect(
      overlayInvestmentPerformance(
        perf,
        [{ ...promoted('2025-06-30', { revenueLtm: '1' }), investmentId: IDS.walled }],
        7,
      ),
    ).toBe(perf);
    // A new quarter is added with its figures, the recorded one is replaced; both carry the source.
    const out = overlayInvestmentPerformance(
      perf,
      [
        promoted('2025-06-30', { revenueLtm: '120000000', ebitdaLtm: '30000000' }),
        { ...promoted('2025-03-31', { revenueLtm: '111000000' }), highlights: undefined },
      ],
      7,
    );
    expect(out.quarters.map((q) => q.periodEnd)).toEqual([
      '2024-06-30',
      '2025-03-31',
      '2025-06-30',
    ]);
    const added = out.quarters[2]!;
    expect(added.revenueLtm).toBe('120000000');
    expect(added.ebitdaLtm).toBe('30000000');
    expect(added.ev).toBeNull();
    expect(added.status).toBe('record_status.approved');
    expect(added.source).toEqual({
      documentId: IDS.states,
      runId: IDS.twoChains,
      page: 2,
      locator: 'field:revenue_ltm',
    });
    expect(added.highlights).toEqual(['LTM revenue rose.']);
    expect(added.ebitdaMargin).toBe('0.25');
    expect(added.evToEbitda).toBeNull();
    // Year on year against the quarter a year before, now that the promoted figures stand.
    expect(added.revenueYoy).toBe('0.2');
    expect(added.ebitdaYoy).toBe('0.5');
    const replaced = out.quarters[1]!;
    expect(replaced.revenueLtm).toBe('111000000');
    expect(replaced.ebitdaLtm).toBe('22000000');
    expect(replaced.ev).toBe('500000000');
    expect(replaced.highlights).toEqual(['As recorded.']);
    expect(replaced.evToEbitda).not.toBe('9.99');
    expect(replaced.source?.documentId).toBe(IDS.states);
    // An untouched quarter keeps the ratios the API answered.
    expect(out.quarters[0]?.evToEbitda).toBe('9.99');
    expect(out.quarters[0]?.highlights).toEqual(['As recorded.']);
    // Since entry is derived again from the latest approved quarter on or before the as-of day.
    expect(out.sinceEntry?.periodEnd).toBe('2025-06-30');
    expect(out.sinceEntry?.revenueGrowth).toBe('0.5');
    expect(out.sinceEntry?.ebitdaGrowth).toBe('0.875');
    expect(out.entry).toBe(perf.entry);
    // Through the recorded body, for the performance path only.
    const recordings = new Recordings(new FixtureBuilder([USERS.viewer]).build());
    const state = createPreviewState();
    state.promotedQuarters.set(
      `${IDS.open}|2025-06-30`,
      promoted('2025-06-30', { revenueLtm: '120000000' }),
    );
    const ctx = { credential: 'viewer.one', recordings, state };
    const text = JSON.stringify(perf);
    const url = new URL(`http://x.invalid/api/v1/investments/${IDS.open}/performance`);
    const laid = JSON.parse(overlayRecordedBody(url, text, ctx)) as InvestmentPerformance;
    expect(laid.quarters).toHaveLength(3);
    expect(laid.quarters[2]?.revenueLtm).toBe('120000000');
    expect(
      overlayRecordedBody(new URL(`http://x.invalid/api/v1/investments/${IDS.open}`), text, ctx),
    ).toBe(text);
    // Another position's recorded performance (its own id in the body) is left as recorded.
    const other = JSON.stringify({ ...perf, investmentId: IDS.walled });
    expect(
      overlayRecordedBody(
        new URL(`http://x.invalid/api/v1/investments/${IDS.walled}/performance`),
        other,
        ctx,
      ),
    ).toBe(other);
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
