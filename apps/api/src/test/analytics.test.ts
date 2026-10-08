import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import { analyticsSummary, investmentPage, watchlist as watchlistSchema } from '@pb/contracts';
import type { AnalyticsSummary, ExposureBucket, Watchlist } from '@pb/contracts';
import { evaluateFlags, vehicleByDealType } from '../analytics/analytics.service.js';
import type { Thresholds } from '../analytics/analytics.service.js';
import type { ValuationRow } from '../portfolio/metrics.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';
import { expectedNavSeries } from './nav-oracle.js';

describe('analytics summary (M12, M13) and monitoring watchlist (M9)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const walled = (): Set<string> => new Set(h.dataset.scenarios.walled_deal ?? []);
  const activeVisibleToViewer = (): number =>
    h.dataset.investments.filter((i) => i.isActive && !walled().has(i.id)).length;
  const summaryFor = async (who: string, requestId = 'req-analytics'): Promise<AnalyticsSummary> =>
    analyticsSummary.parse(
      (
        await h
          .http()
          .get(`/api/v1/analytics/summary?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );
  const watchlistFor = async (who: string, requestId = 'req-watchlist'): Promise<Watchlist> =>
    watchlistSchema.parse(
      (
        await h
          .http()
          .get(`/api/v1/monitoring/watchlist?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );

  it('requires authentication on both routes', async () => {
    await h.http().get('/api/v1/analytics/summary').expect(401);
    await h.http().get('/api/v1/monitoring/watchlist').expect(401);
  });

  it('defaults the as-of date to the clock and rejects unknown query keys', async () => {
    const res = await h
      .http()
      .get('/api/v1/analytics/summary')
      .set('authorization', h.as('viewer'))
      .expect(200);
    expect(analyticsSummary.parse(res.body).asOf).toBe(h.dataset.asOf);
    await h
      .http()
      .get('/api/v1/analytics/summary?junk=1')
      .set('authorization', h.as('viewer'))
      .expect(400);
  });

  describe('summary', () => {
    it('pools metrics over the positions the caller can see (SEC-5.3)', async () => {
      const viewer = await summaryFor('viewer.one');
      const member = await summaryFor('deal.three');
      expect(viewer.active.count).toBe(activeVisibleToViewer());
      expect(member.active.count).toBe(h.dataset.investments.filter((i) => i.isActive).length);
      expect(member.active.count).toBe(viewer.active.count + 1);
      expect(viewer.activeInvestments).toBe(viewer.active.count);
      expect(viewer.realizedInvestments).toBe(viewer.realized.count);
      expect(viewer.totals.count).toBe(viewer.active.count + viewer.realized.count);
      expect(viewer.totals.invested).not.toBeNull();
      expect(D(viewer.totals.invested ?? '0').gt(0)).toBe(true);
      expect(viewer.active.nav).not.toBeNull();
      // Realized positions carry no NAV, so the realized set is fully distributed.
      expect(viewer.realized.nav).toBe('0');
      expect(viewer.realized.rvpi).toBe('0');
      expect(viewer.realized.dpi).toBe(viewer.realized.tvpi);
      expect(viewer.calcVersion).toBe('0.1.0');
      // The wall member sees more NAV than the viewer, never less.
      expect(D(member.active.nav ?? '0').gt(viewer.active.nav ?? '0')).toBe(true);
      expect(viewer.topPositions.some((p) => walled().has(p.id))).toBe(false);
    });

    it('buckets exposures with taxonomy labels and NAV shares that sum to one', async () => {
      const s = await summaryFor('viewer.one');
      const activeNav = D(s.active.nav ?? '0');
      const dimensions = [
        'sector',
        'geography',
        'dealType',
        'vehicle',
        'sponsor',
        'vintage',
      ] as const;
      expect(Object.keys(s.exposures).sort()).toEqual([...dimensions, 'vehicleByDealType'].sort());
      for (const name of dimensions) {
        const buckets = s.exposures[name];
        expect(buckets.length, name).toBeGreaterThan(0);
        expect(
          buckets.reduce((n, b) => n + b.count, 0),
          name,
        ).toBe(s.activeInvestments);
        const share = buckets.reduce(
          (acc, b) => (b.navShare === null ? acc : acc.plus(b.navShare)),
          D('0'),
        );
        expect(share.minus(1).abs().lte('0.000001'), name).toBe(true);
        const navSum = buckets.reduce((acc, b) => (b.nav === null ? acc : acc.plus(b.nav)), D('0'));
        expect(navSum.eq(activeNav), name).toBe(true);
        for (let i = 1; i < buckets.length; i += 1) {
          const prev = buckets[i - 1]!;
          const cur = buckets[i]!;
          if (prev.nav !== null && cur.nav !== null)
            expect(D(prev.nav).gte(cur.nav), `${name} sorted by nav`).toBe(true);
          if (prev.nav === null) expect(cur.nav, `${name} nulls last`).toBeNull();
        }
      }
      for (const b of s.exposures.sector) {
        expect(b.key).toMatch(/^sector\./);
        expect(b.label).not.toMatch(/^sector\./);
      }
      for (const b of s.exposures.geography) expect(b.key).toMatch(/^geography\./);
      for (const b of s.exposures.dealType) {
        expect(b.key).toMatch(/^deal_type\./);
        expect(b.label).not.toMatch(/^deal_type\./);
      }
      for (const b of s.exposures.vintage) {
        expect(b.key).toMatch(/^\d{4}$/);
        expect(b.label).toBe(b.key);
      }
      expect(s.exposures.vehicle.every((b) => b.label.length > 0)).toBe(true);
      expect(s.exposures.sponsor.every((b) => b.label.length > 0)).toBe(true);
    });

    it('splits each vehicle NAV by deal type with Decimal sums that reconcile to the vehicle buckets', async () => {
      for (const who of ['viewer.one', 'deal.three']) {
        const s = await summaryFor(who);
        const rows = s.exposures.vehicleByDealType;
        const dealTypeOrder = s.exposures.dealType.map((b) => b.key);
        // One row per vehicle with a Locked NAV, keyed and labelled like its vehicle bucket.
        const withNav = s.exposures.vehicle.filter((b) => b.nav !== null);
        expect(rows.map((r) => r.key).sort(), who).toEqual(withNav.map((b) => b.key).sort());
        for (const r of rows) {
          const bucket = s.exposures.vehicle.find((b) => b.key === r.key)!;
          expect(r.label).toBe(bucket.label);
          expect(r.segments.length).toBeGreaterThan(0);
          // Segment NAVs sum exactly to the vehicle's NAV in exposures.vehicle.
          const navSum = r.segments.reduce((acc, seg) => acc.plus(seg.nav!), D('0'));
          expect(navSum.eq(bucket.nav!), `${who} ${r.label}`).toBe(true);
          // Segments are deal type buckets, in the order of exposures.dealType.
          const order = r.segments.map((seg) => dealTypeOrder.indexOf(seg.key));
          expect(order.every((i) => i >= 0)).toBe(true);
          expect(order).toEqual([...order].sort((a, b) => a - b));
          for (const seg of r.segments) {
            expect(seg.key).toMatch(/^deal_type\./);
            expect(seg.label).toBe(s.exposures.dealType.find((b) => b.key === seg.key)!.label);
            expect(seg.count).toBeGreaterThan(0);
            const share = D(seg.navShare!).minus(D(seg.nav!).div(s.active.nav!));
            expect(share.abs().lte('1e-9')).toBe(true);
          }
        }
        // Vehicles by total NAV, largest first.
        const totals = rows.map((r) => r.segments.reduce((acc, seg) => acc.plus(seg.nav!), D('0')));
        for (let i = 1; i < totals.length; i += 1)
          expect(totals[i - 1]!.gte(totals[i]!)).toBe(true);

        // Every active position with a Locked mark counts once, in its vehicle and deal type.
        const page = investmentPage.parse(
          (
            await h
              .http()
              .get(`/api/v1/investments?active=true&limit=200&asOf=${h.dataset.asOf}`)
              .set('authorization', h.as(who))
              .expect(200)
          ).body,
        );
        expect(page.nextCursor).toBeNull();
        expect(page.items.length).toBe(s.activeInvestments);
        const marked = page.items.filter((i) => i.nav !== null);
        const cells = new Map<string, { count: number; nav: ReturnType<typeof D> }>();
        for (const i of marked) {
          const key = `${i.vehicleName}|${i.dealType}`;
          const cell = cells.get(key) ?? { count: 0, nav: D('0') };
          cells.set(key, { count: cell.count + 1, nav: cell.nav.plus(i.nav!) });
        }
        const segments = rows.flatMap((r) => r.segments.map((seg) => ({ r, seg })));
        expect(segments.length).toBe(cells.size);
        for (const { r, seg } of segments) {
          const cell = cells.get(`${r.label}|${seg.key}`)!;
          expect(seg.count).toBe(cell.count);
          expect(D(seg.nav!).eq(cell.nav)).toBe(true);
        }
      }
    });

    it('builds the NAV series, flows by year and top positions from config', async () => {
      const s = await summaryFor('operations');
      expect(s.navSeries.length).toBeGreaterThan(0);
      expect(s.navSeries.length).toBeLessThanOrEqual(8);
      for (let i = 1; i < s.navSeries.length; i += 1)
        expect(s.navSeries[i]!.periodEnd > s.navSeries[i - 1]!.periodEnd).toBe(true);
      expect(s.navSeries[s.navSeries.length - 1]?.periodEnd).toBe(h.dataset.asOf);
      // A sponsor closing three days early (period_end_shift) folds into its calendar quarter.
      for (const point of s.navSeries) {
        expect(point.periodEnd).toMatch(/-(03-31|06-30|09-30|12-31)$/);
        expect(point.value).not.toBeNull();
      }
      expect(s.navSeries.length).toBe(8);
      // Point by point, the Locked marks of the visible active positions summed by calendar quarter.
      const definitions = h.runtime.definitions as {
        priorYearPeriodEndToleranceDays: number;
        analytics: { navSeriesQuarters: number };
      };
      const expected = expectedNavSeries(
        h.dataset,
        new Set(
          h.dataset.investments.filter((i) => i.isActive && !walled().has(i.id)).map((i) => i.id),
        ),
        definitions.analytics.navSeriesQuarters,
        definitions.priorYearPeriodEndToleranceDays,
      );
      expect(s.navSeries.map((p) => p.periodEnd)).toEqual(expected.map((p) => p.periodEnd));
      s.navSeries.forEach((p, i) => expect(D(p.value!).eq(expected[i]!.value)).toBe(true));

      expect(s.flowsByYear.length).toBeGreaterThan(1);
      let running = D('0');
      for (let i = 0; i < s.flowsByYear.length; i += 1) {
        const y = s.flowsByYear[i]!;
        expect(y.period).toMatch(/^\d{4}$/);
        if (i > 0) expect(y.period > s.flowsByYear[i - 1]!.period).toBe(true);
        expect(D(y.contributions).gte(0)).toBe(true);
        expect(D(y.distributions).gte(0)).toBe(true);
        expect(D(y.net).eq(D(y.distributions).minus(y.contributions))).toBe(true);
        running = running.plus(y.net);
        expect(D(y.cumulativeNet).eq(running)).toBe(true);
      }
      const netSum = s.flowsByYear.reduce((acc, y) => acc.plus(y.net), D('0'));
      expect(D(s.flowsByYear[s.flowsByYear.length - 1]!.cumulativeNet).eq(netSum)).toBe(true);
      // Flows pooled by year reconcile to the pooled totals.
      const contributed = s.flowsByYear.reduce((acc, y) => acc.plus(y.contributions), D('0'));
      expect(contributed.eq(s.totals.invested ?? '0')).toBe(true);

      expect(s.topPositions.length).toBe(Math.min(10, s.activeInvestments));
      const activeNav = D(s.active.nav ?? '0');
      for (let i = 0; i < s.topPositions.length; i += 1) {
        const p = s.topPositions[i]!;
        expect(p.nav).not.toBeNull();
        expect(
          D(p.navShare ?? '0')
            .minus(D(p.nav ?? '0').div(activeNav))
            .abs()
            .lte('1e-9'),
        ).toBe(true);
        if (i > 0) expect(D(s.topPositions[i - 1]!.nav ?? '0').gte(p.nav ?? '0')).toBe(true);
      }
    });

    it('audits the summary read without business values (SEC-11.1)', async () => {
      await summaryFor('viewer.one', 'req-analytics-audit-1');
      const audit = await h.runtime.db.query<{ n: number; details: string }>(
        "select count(*)::int as n, min(details::text) as details from audit.event where action = 'analytics.read' and request_id = 'req-analytics-audit-1'",
      );
      expect(audit[0]?.n).toBe(1);
      expect(audit[0]?.details).toBe('{}');
    });
  });

  describe('watchlist', () => {
    const codesOf = (w: Watchlist, investmentNumber: string): string[] =>
      w.items.find((i) => i.investmentNumber === investmentNumber)?.flags.map((f) => f.code) ?? [];
    const codesById = (w: Watchlist, id: string): string[] =>
      w.items.find((i) => i.investmentId === id)?.flags.map((f) => f.code) ?? [];

    it('flags the seeded scenarios from config thresholds', async () => {
      const w = await watchlistFor('viewer.one');
      expect(w.thresholds).toEqual({
        netDebtToEbitdaMax: 6,
        ebitdaYoYDeclinePct: 0.15,
        markdownPct: 0.2,
        missingFinancialsDays: 75,
        maturityWithinMonths: 12,
      });
      expect(w.calcVersion).toBe('0.1.0');

      expect(codesOf(w, 'INV-0007')).toContain('stale_valuation');
      expect(codesOf(w, 'INV-0004')).toContain('negative_ebitda');
      expect(codesOf(w, 'INV-0001')).toContain('missing_prior_year');
      expect(codesOf(w, 'INV-0013')).toContain('covenant_waiver');
      expect(codesOf(w, 'INV-0013')).toContain('past_maturity');
      expect(codesOf(w, 'INV-0013')).not.toContain('covenant_breach');
      expect(codesOf(w, 'INV-0009')).not.toContain('maturity_within_12_months');
      expect(codesOf(w, 'INV-0009')).not.toContain('past_maturity');

      // The same expectations through the scenario tags, so a reseed cannot silently drift.
      expect(codesById(w, h.dataset.scenarios.stale_valuation![0]!)).toContain('stale_valuation');
      expect(codesById(w, h.dataset.scenarios.negative_ebitda![0]!)).toContain('negative_ebitda');
      expect(codesById(w, h.dataset.scenarios.missing_prior_year![0]!)).toContain(
        'missing_prior_year',
      );
      expect(codesById(w, h.dataset.scenarios.covenant_breach![0]!)).toContain('covenant_waiver');
      // A sponsor reporting three days off the quarter end is within tolerance, not stale.
      expect(codesById(w, h.dataset.scenarios.period_end_shift![0]!)).not.toContain(
        'stale_valuation',
      );
      // The walled position never appears for a viewer outside the wall.
      expect(w.items.some((i) => walled().has(i.investmentId))).toBe(false);
      expect(w.items.some((i) => i.investmentNumber === 'INV-0010')).toBe(false);
    });

    it('carries plain messages with figures as decimal strings', async () => {
      const w = await watchlistFor('viewer.one');
      const stale = w.items
        .find((i) => i.investmentNumber === 'INV-0007')
        ?.flags.find((f) => f.code === 'stale_valuation');
      expect(stale?.severity).toBe('watch');
      expect(stale?.value).toBeNull();
      expect(stale?.message).toContain('2025-03-31');
      expect(stale?.message).toContain(h.dataset.asOf);
      const negative = w.items
        .find((i) => i.investmentNumber === 'INV-0004')
        ?.flags.find((f) => f.code === 'negative_ebitda');
      expect(negative?.severity).toBe('bad');
      expect(negative?.threshold).toBe('0');
      expect(D(negative?.value ?? '1').lte(0)).toBe(true);
      const maturity = w.items
        .find((i) => i.investmentNumber === 'INV-0013')
        ?.flags.find((f) => f.code === 'past_maturity');
      expect(maturity?.severity).toBe('bad');
      expect(maturity?.message).toMatch(/matured on \d{4}-\d{2}-\d{2}/);
      for (const item of w.items) {
        expect(item.flags.length).toBeGreaterThan(0);
        for (const f of item.flags)
          expect(f.message).not.toMatch(new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`));
      }
    });

    it('orders bad before watch, counts every active position once and audits the read', async () => {
      const w = await watchlistFor('viewer.one', 'req-watchlist-audit-1');
      const ranks = w.items.map((i) => (i.flags.some((f) => f.severity === 'bad') ? 0 : 1));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      for (let i = 1; i < w.items.length; i += 1) {
        if (ranks[i] === ranks[i - 1])
          expect(w.items[i]!.investmentNumber > w.items[i - 1]!.investmentNumber).toBe(true);
      }
      expect(w.counts.bad).toBe(ranks.filter((r) => r === 0).length);
      expect(w.counts.watch).toBe(ranks.filter((r) => r === 1).length);
      expect(w.counts.bad + w.counts.watch + w.counts.clear).toBe(activeVisibleToViewer());
      expect(w.counts.clear).toBeGreaterThan(0);
      const audit = await h.runtime.db.query<{ n: number }>(
        "select count(*)::int as n from audit.event where action = 'watchlist.read' and request_id = 'req-watchlist-audit-1'",
      );
      expect(audit[0]?.n).toBe(1);
    });

    it('includes the walled position in the active count for a wall member', async () => {
      const member = await watchlistFor('deal.three');
      expect(member.counts.bad + member.counts.watch + member.counts.clear).toBe(
        h.dataset.investments.filter((i) => i.isActive).length,
      );
    });
  });
});

describe('vehicleByDealType (the stacked NAV by vehicle and deal type)', () => {
  type Position = Parameters<typeof vehicleByDealType>[0][number];
  const CO = 'deal_type.co_invest_equity';
  const CV = 'deal_type.cv_single_asset';
  const CREDIT = 'deal_type.private_credit';
  const LABELS: Record<string, string> = {
    [CO]: 'Co-investment (equity)',
    [CV]: 'Continuation vehicle (single asset)',
    [CREDIT]: 'Private credit',
  };
  /** Only the fields the breakdown reads; the rest of a position plays no part in it. */
  const position = (
    vehicleId: string,
    vehicleName: string,
    dealType: string,
    nav: string | null,
    invested: string | null,
  ): Position => ({
    row: { vehicleId, vehicleName, dealType } as Position['row'],
    summary: { nav, invested } as Position['summary'],
    flows: [],
    valuations: [],
  });
  const dealTypeOf = (p: Position): { key: string; label: string } => ({
    key: p.row.dealType,
    label: LABELS[p.row.dealType] ?? p.row.dealType,
  });
  const bucket = (key: string): ExposureBucket => ({
    key,
    label: LABELS[key] ?? key,
    count: 0,
    invested: null,
    nav: null,
    navShare: null,
  });
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const C = '00000000-0000-4000-8000-00000000000c';
  const Z = '00000000-0000-4000-8000-00000000000d';

  it('sums Decimal NAV per vehicle and deal type, leaves out unmarked positions and orders both levels', () => {
    const active = [
      position(A, 'Beach Fund A', CO, '10.10', '5'),
      position(A, 'Beach Fund A', CV, '29.90', '20'),
      position(A, 'Beach Fund A', CO, null, '7'), // no Locked mark: left out
      position(B, 'Beach Fund B', CREDIT, '0.1', '1'),
      position(B, 'Beach Fund B', CREDIT, '49.9', null),
      position(C, 'Beach Fund C', CO, null, '3'), // no Locked mark at all: no row
      position(Z, 'Aardvark Fund', CO, '40', '30'), // the same NAV as Beach Fund A
    ];
    // The deal type buckets' order (largest NAV first) decides the segment order in every bar.
    const rows = vehicleByDealType(
      active,
      D('130'),
      [bucket(CREDIT), bucket(CV), bucket(CO)],
      dealTypeOf,
    );
    expect(rows.map((r) => r.key)).toEqual([B, Z, A]);
    expect(rows.map((r) => r.label)).toEqual(['Beach Fund B', 'Aardvark Fund', 'Beach Fund A']);
    expect(rows[0]!.segments).toEqual([
      {
        key: CREDIT,
        label: 'Private credit',
        count: 2,
        invested: '1',
        nav: '50',
        navShare: '0.3846153846',
      },
    ]);
    const fundA = rows[2]!;
    expect(fundA.segments.map((s) => s.key)).toEqual([CV, CO]);
    expect(fundA.segments.map((s) => s.label)).toEqual([
      'Continuation vehicle (single asset)',
      'Co-investment (equity)',
    ]);
    expect(fundA.segments.map((s) => [s.count, s.invested, s.nav])).toEqual([
      [1, '20', '29.9'],
      [1, '5', '10.1'],
    ]);
    // Shares are of the total active NAV, like every other exposure bucket.
    expect(fundA.segments.map((s) => s.navShare)).toEqual(['0.23', '0.0776923077']);
  });

  it('has no rows when no active position has a Locked mark', () => {
    expect(
      vehicleByDealType(
        [position(C, 'Beach Fund C', CO, null, '1')],
        null,
        [bucket(CO)],
        dealTypeOf,
      ),
    ).toEqual([]);
  });
});

describe('the markdown flag measures the change with the one value change rule', () => {
  const thresholds: Thresholds = {
    raw: {},
    netDebtToEbitdaMax: D('6'),
    ebitdaYoYDeclinePct: D('0.15'),
    markdownPct: D('0.2'),
    missingFinancialsDays: 75,
    maturityWithinMonths: 12,
    priorYearToleranceDays: 7,
  };
  const lockedMark = (periodEnd: string, fairValue: string): ValuationRow => ({
    periodEnd,
    version: 1,
    state: 'Locked',
    fairValue,
    method: 'valuation_method.sponsor_mark',
  });
  const flagsFor = (prior: string, current: string): ReturnType<typeof evaluateFlags> =>
    evaluateFlags(
      {
        valuations: [lockedMark('2025-03-31', prior), lockedMark('2025-06-30', current)],
        operating: [],
        credit: null,
      },
      '2025-06-30',
      thresholds,
      new Map(),
    );

  it('flags a fall beyond the limit with the change as a decimal string', () => {
    expect(flagsFor('1000.00', '700.00')).toEqual([
      {
        code: 'markdown',
        severity: 'watch',
        message: 'Locked fair value for 2025-06-30 is 30.0% below 2025-03-31 (limit 20.0%)',
        value: '-0.3',
        threshold: '-0.2',
      },
    ]);
  });

  it('does not flag a fall within the limit, a rise, or a mark against a zero prior', () => {
    expect(flagsFor('1000.00', '800.00')).toEqual([]);
    expect(flagsFor('1000.00', '1200.00')).toEqual([]);
    expect(flagsFor('0', '500.00')).toEqual([]);
  });
});
