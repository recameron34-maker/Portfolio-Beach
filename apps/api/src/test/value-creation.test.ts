import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, ZERO, toDecimalString, turnBands, valueChange } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import {
  investmentPage,
  investmentValueCreation,
  valueCreation as valueCreationSchema,
} from '@pb/contracts';
import type {
  EntryCohort,
  InvestmentValueCreation,
  ValueCreation,
  ValueCreationPosition,
} from '@pb/contracts';
import { parseCsv } from '@pb/validation';
import { VALUE_CREATION_CSV_COLUMNS } from '../analytics/value-creation.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';
import {
  EQUITY_DEAL_TYPES,
  expectedBand,
  expectedPool,
  expectedPosition,
  expectedSeries,
} from './value-creation-oracle.js';
import type { ExpectedPosition } from './value-creation-oracle.js';

/*
 * The value creation and entry metric analytics (docs/04 M13 and M20, docs/08 section 8). Every
 * figure the routes answer is recomputed here from the seeded rows with the calculation library
 * (value-creation-oracle.ts) and compared as the contract's decimal strings.
 */

const str = toDecimalString;
const SUMMARY = '/api/v1/analytics/value-creation';
const EXPORT = '/api/v1/analytics/value-creation/export';
const one = (id: string): string => `/api/v1/investments/${id}/value-creation`;

interface BandConfig {
  entryMultipleBands: number[];
  entryLeverageBands: number[];
}

describe('value creation analytics (M13, M20)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const idOf = (number: string): string =>
    h.dataset.investments.find((i) => i.investmentNumber === number)!.id;
  const bands = (): BandConfig =>
    (h.runtime.definitions as unknown as { analytics: BandConfig }).analytics;
  const tolerance = (): number =>
    (h.runtime.definitions as unknown as { priorYearPeriodEndToleranceDays: number })
      .priorYearPeriodEndToleranceDays;
  const get = (who: string, path: string, requestId = 'req-value-creation') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const summaryFor = async (
    who: string,
    asOf = h.dataset.asOf,
    requestId?: string,
  ): Promise<ValueCreation> =>
    valueCreationSchema.parse(
      (await get(who, `${SUMMARY}?asOf=${asOf}`, requestId).expect(200)).body,
    );
  const oneFor = async (
    who: string,
    id: string,
    asOf = h.dataset.asOf,
    requestId?: string,
  ): Promise<InvestmentValueCreation> =>
    investmentValueCreation.parse(
      (await get(who, `${one(id)}?asOf=${asOf}`, requestId).expect(200)).body,
    );
  /** The equity and continuation vehicle positions that exist as of a date, the walled one left out or kept. */
  const eligible = (asOf: string, withWalled: boolean): ExpectedPosition[] =>
    h.dataset.investments
      .filter(
        (i) =>
          EQUITY_DEAL_TYPES.includes(i.dealType) &&
          i.entryDate <= asOf &&
          (withWalled || i.id !== walledId()),
      )
      .sort((a, b) => (a.investmentNumber < b.investmentNumber ? -1 : 1))
      .map((i) => expectedPosition(h.dataset, i, asOf));
  const count = async (sql: string): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql))[0]!.n;

  /** Every figure of one API row against the oracle's, as decimal strings. */
  function expectRow(row: ValueCreationPosition, want: ExpectedPosition, asOf: string): void {
    const label = row.investmentNumber;
    expect(row.id, label).toBe(want.investment.id);
    expect(row.dealType, label).toBe(want.investment.dealType);
    expect(row.entryDate, label).toBe(want.investment.entryDate);
    expect(row.isActive, label).toBe(want.isActive);
    for (const [point, quarter] of [
      [row.entry, want.entry],
      [row.current, want.current],
    ] as const) {
      if (quarter === null) {
        expect(point, label).toBeNull();
        continue;
      }
      expect(point, label).not.toBeNull();
      expect(point!.periodEnd, label).toBe(quarter.periodEnd);
      expect(point!.periodEnd <= asOf, label).toBe(true);
      for (const [field, value] of [
        ['revenueLtm', quarter.revenueLtm],
        ['ebitdaLtm', quarter.ebitdaLtm],
        ['ev', quarter.ev],
        ['netDebt', quarter.netDebt],
      ] as const)
        expect(point![field] === null ? null : D(point![field]).toString(), label).toBe(
          value === null ? null : D(value).toString(),
        );
    }
    const measures = want.measures;
    for (const key of [
      'ebitdaGrowth',
      'evGrowth',
      'equityValueGrowth',
      'multipleChange',
      'netLeverageChange',
      'netDebtChange',
    ] as const)
      expect(row.growth[key], `${label} ${key}`).toBe(str(measures?.[key] ?? null));

    expect(row.notCalculable, label).toBe(want.reason);
    if (want.bridge === null) expect(row.bridge, label).toBeNull();
    else {
      const b = row.bridge!;
      for (const key of [
        'equityAtEntry',
        'equityCurrent',
        'ebitdaGrowth',
        'multipleExpansion',
        'debtPaydown',
        'total',
        'revenueGrowth',
        'marginChange',
      ] as const)
        expect(b[key], `${label} bridge ${key}`).toBe(str(want.bridge[key]));
      for (const key of ['ebitdaGrowth', 'multipleExpansion', 'debtPaydown'] as const)
        expect(b.shares?.[key] ?? null, `${label} share ${key}`).toBe(
          str(want.bridge.shares?.[key] ?? null),
        );
    }

    expect(row.invested, label).toBe(str(want.invested));
    expect(row.distributions, label).toBe(str(want.distributions));
    expect(row.nav, label).toBe(str(want.nav));
    expect(row.grossMoic, label).toBe(str(want.moic));
    expect(row.gain, label).toBe(str(want.gain));
    const total =
      want.nav === null || want.distributions === null ? null : want.nav.plus(want.distributions);
    const valuationGrowth = valueChange(total, want.invested);
    expect(row.valuationGrowth, label).toBe(str(valuationGrowth));
    const ebitdaGrowth = measures?.ebitdaGrowth ?? null;
    expect(row.valuationGrowthGap, label).toBe(
      str(
        valuationGrowth === null || ebitdaGrowth === null
          ? null
          : valuationGrowth.minus(ebitdaGrowth),
      ),
    );
    expect(row.gainNotCalculable, label).toBe(want.gainReason);
    if (want.split === null) expect(row.gainByDriver, label).toBeNull();
    else
      for (const key of [
        'ebitdaGrowth',
        'multipleExpansion',
        'debtPaydown',
        'revenueGrowth',
        'marginChange',
      ] as const)
        expect(row.gainByDriver![key], `${label} gain ${key}`).toBe(str(want.split[key]));
    expect(row.entryMultipleBand, label).toBe(
      expectedBand(want.entryMultiple, bands().entryMultipleBands),
    );
    expect(row.entryLeverageBand, label).toBe(
      expectedBand(want.entryLeverage, bands().entryLeverageBands),
    );
    expect(row.entry?.evToEbitda ?? null, label).toBe(str(want.entryMultiple));
    expect(row.entry?.netDebtToEbitda ?? null, label).toBe(str(want.entryLeverage));
  }

  it('requires authentication on the three routes', async () => {
    await h.http().get(SUMMARY).expect(401);
    await h.http().get(EXPORT).expect(401);
    await h
      .http()
      .get(one(idOf('INV-0001')))
      .expect(401);
  });

  it('takes the as-of date as its only filter: the clock by default, anything else is refused', async () => {
    const res = await get('viewer.one', SUMMARY).expect(200);
    expect(valueCreationSchema.parse(res.body).asOf).toBe(h.dataset.asOf);
    const single = await get('viewer.one', one(idOf('INV-0001'))).expect(200);
    expect(investmentValueCreation.parse(single.body).asOf).toBe(h.dataset.asOf);
    for (const path of [SUMMARY, EXPORT, one(idOf('INV-0001'))]) {
      for (const query of ['junk=1', 'dealType=deal_type.co_invest_equity', 'asOf=2025-02-30']) {
        const refused = await get('viewer.one', `${path}?${query}`).expect(400);
        expect((refused.body as { type: string }).type).toMatch(/validation$/);
      }
    }
  });

  describe('the portfolio view', () => {
    it('lists one row per equity and continuation vehicle position the caller can see (SEC-5.3)', async () => {
      const asOf = h.dataset.asOf;
      const viewer = await summaryFor('viewer.one');
      const member = await summaryFor('deal.three');
      expect(viewer.positions.map((p) => p.investmentNumber)).toEqual(
        eligible(asOf, false).map((p) => p.investment.investmentNumber),
      );
      expect(member.positions.map((p) => p.investmentNumber)).toEqual(
        eligible(asOf, true).map((p) => p.investment.investmentNumber),
      );
      // The walled position is absent for a non-member and present for a member, nothing else moves.
      expect(viewer.positions.some((p) => p.id === walledId())).toBe(false);
      expect(member.positions.some((p) => p.id === walledId())).toBe(true);
      expect(member.positions.length).toBe(viewer.positions.length + 1);
      expect(JSON.stringify(viewer)).not.toContain(walledId());
      expect(viewer.positions.every((p) => EQUITY_DEAL_TYPES.includes(p.dealType))).toBe(true);
      expect(viewer.positions.some((p) => !p.isActive)).toBe(true);
      expect(viewer.calcVersion).toBe('0.1.0');
    });

    it('answers every figure of every row as the calculation library gives it from the seeded rows', async () => {
      const asOf = h.dataset.asOf;
      const member = await summaryFor('deal.three');
      const want = eligible(asOf, true);
      expect(member.positions.length).toBe(want.length);
      member.positions.forEach((row, i) => expectRow(row, want[i]!, asOf));
      // The IRR is the portfolio grid's own, position by position.
      const grid = investmentPage.parse(
        (await get('deal.three', `/api/v1/investments?limit=200&asOf=${asOf}`).expect(200)).body,
      );
      for (const row of member.positions) {
        const listed = grid.items.find((i) => i.id === row.id)!;
        expect(row.grossIrr, row.investmentNumber).toBe(listed.grossIrr);
        expect(row.irrFlag, row.investmentNumber).toBe(listed.irrFlag);
        expect(row.grossMoic, row.investmentNumber).toBe(listed.grossMoic);
        expect(row.companyName).toBe(listed.companyName);
        expect(row.vehicleName).toBe(listed.vehicleName);
        expect(row.sponsorName).toBe(listed.sponsorName);
        expect(row.sector).toBe(listed.sector);
      }
    });

    it('splits each company bridge into three drivers that are the equity value change', async () => {
      const s = await summaryFor('deal.three');
      const withBridge = s.positions.filter((p) => p.bridge !== null);
      expect(withBridge.length).toBeGreaterThan(10);
      for (const p of withBridge) {
        const b = p.bridge!;
        const parts = D(b.ebitdaGrowth).plus(b.multipleExpansion).plus(b.debtPaydown);
        // Each figure is rounded to ten places on the wire, so the sum is within three of those.
        expect(parts.minus(b.total).abs().lte('3e-10'), p.investmentNumber).toBe(true);
        expect(D(b.equityCurrent).minus(b.equityAtEntry).eq(b.total), p.investmentNumber).toBe(
          true,
        );
        expect(D(b.equityAtEntry).eq(D(p.entry!.ev!).minus(p.entry!.netDebt!))).toBe(true);
        expect(D(b.debtPaydown).eq(D(p.entry!.netDebt!).minus(p.current!.netDebt!))).toBe(true);
        if (b.revenueGrowth !== null)
          expect(
            D(b.revenueGrowth).plus(b.marginChange!).minus(b.ebitdaGrowth).abs().lte('3e-10'),
            p.investmentNumber,
          ).toBe(true);
        if (p.gainByDriver !== null) {
          const g = p.gainByDriver;
          const ours = D(g.ebitdaGrowth).plus(g.multipleExpansion).plus(g.debtPaydown);
          expect(ours.minus(p.gain!).abs().lte('3e-10'), p.investmentNumber).toBe(true);
          expect(D(p.gain!).eq(D(p.nav!).plus(p.distributions!).minus(p.invested!))).toBe(true);
        }
      }
      // The seeded book has marks that ran ahead of earnings and marks that did not.
      const gaps = s.positions.flatMap((p) =>
        p.valuationGrowthGap === null ? [] : [D(p.valuationGrowthGap)],
      );
      expect(gaps.some((g) => g.gt(0))).toBe(true);
      expect(gaps.some((g) => g.lt(0))).toBe(true);
    });

    it('rolls our gain up by driver over the positions it can be split for, and counts the rest by reason', async () => {
      const asOf = h.dataset.asOf;
      const s = await summaryFor('deal.three');
      const want = eligible(asOf, true);
      const included = want.filter((p) => p.split !== null);
      const sum = (pick: (p: ExpectedPosition) => Decimal | null): Decimal =>
        included.reduce((acc, p) => acc.plus(pick(p) ?? ZERO), ZERO);
      expect(s.portfolio.positions).toBe(included.length);
      expect(s.portfolio.invested).toBe(str(sum((p) => p.invested)));
      expect(s.portfolio.nav).toBe(str(sum((p) => p.nav)));
      expect(s.portfolio.distributions).toBe(str(sum((p) => p.distributions)));
      expect(s.portfolio.gain).toBe(str(sum((p) => p.gain)));
      expect(s.portfolio.totalValue).toBe(str(sum((p) => p.nav).plus(sum((p) => p.distributions))));
      const g = s.portfolio.gainByDriver!;
      expect(g.ebitdaGrowth).toBe(str(sum((p) => p.split!.ebitdaGrowth)));
      expect(g.multipleExpansion).toBe(str(sum((p) => p.split!.multipleExpansion)));
      expect(g.debtPaydown).toBe(str(sum((p) => p.split!.debtPaydown)));
      expect(g.revenueGrowth).toBe(str(sum((p) => p.split!.revenueGrowth)));
      expect(g.marginChange).toBe(str(sum((p) => p.split!.marginChange)));
      // The roll-up ties to our own numbers: the drivers are the gain, and cost plus gain is value.
      expect(
        D(g.ebitdaGrowth)
          .plus(g.multipleExpansion)
          .plus(g.debtPaydown)
          .minus(s.portfolio.gain!)
          .abs()
          .lte('3e-10'),
      ).toBe(true);
      expect(D(s.portfolio.invested!).plus(s.portfolio.gain!).eq(s.portfolio.totalValue!)).toBe(
        true,
      );
      expect(
        D(s.portfolio.totalValue!).eq(D(s.portfolio.nav!).plus(s.portfolio.distributions!)),
      ).toBe(true);
      // The seeded forward-dated snapshot and the negative EBITDA are counted, never dropped.
      expect(s.portfolio.notCalculable).toEqual([
        { reason: 'no_entry_snapshot', count: 1 },
        { reason: 'non_positive_ebitda', count: 1 },
      ]);
      expect(
        s.portfolio.positions + s.portfolio.notCalculable.reduce((n, r) => n + r.count, 0),
      ).toBe(s.positions.length);
      expect(s.positions.find((p) => p.notCalculable === 'no_entry_snapshot')?.id).toBe(
        h.dataset.scenarios.forward_entry_snapshot![0],
      );
      expect(s.positions.find((p) => p.notCalculable === 'non_positive_ebitda')?.id).toBe(
        h.dataset.scenarios.negative_ebitda![0],
      );
    });

    it('pools performance by entry multiple band and by entry leverage band from config', async () => {
      const asOf = h.dataset.asOf;
      const s = await summaryFor('deal.three');
      const want = eligible(asOf, true);
      const check = (
        cohorts: EntryCohort[],
        edges: number[],
        figure: (p: ExpectedPosition) => Decimal | null,
        bandOf: (p: ValueCreationPosition) => string,
      ): void => {
        const configured = turnBands(edges.map((e) => String(e)));
        // Every config band is listed, lowest first, then the explicit "Not calculable" cohort.
        expect(cohorts.map((c) => c.key)).toEqual([
          ...configured.map((b) => `band_${b.index}`),
          'not_calculable',
        ]);
        expect(cohorts.map((c) => c.label)).toEqual([
          ...configured.map((b) => b.label),
          'Not calculable',
        ]);
        configured.forEach((b, i) => {
          expect(cohorts[i]!.lower).toBe(str(b.lower));
          expect(cohorts[i]!.upper).toBe(str(b.upper));
        });
        expect(cohorts.reduce((n, c) => n + c.count, 0)).toBe(s.positions.length);
        for (const cohort of cohorts) {
          const members = want.filter((p) => expectedBand(figure(p), edges) === cohort.key);
          const pool = expectedPool(h.dataset, members, asOf);
          const { key, label, lower: _lower, upper: _upper, ...figures } = cohort;
          expect(
            {
              count: figures.count,
              invested: figures.invested,
              distributions: figures.distributions,
              nav: figures.nav,
              grossMoic: figures.grossMoic,
              grossIrr: figures.grossIrr,
              ebitdaGrowth: figures.ebitdaGrowth,
              ebitdaGrowthPositions: figures.ebitdaGrowthPositions,
            },
            `${key} ${label}`,
          ).toEqual(pool);
          expect(s.positions.filter((p) => bandOf(p) === cohort.key).map((p) => p.id)).toEqual(
            members.map((p) => p.investment.id),
          );
        }
        // At least three bands hold positions, so the view is not degenerate.
        expect(
          cohorts.filter((c) => c.key !== 'not_calculable' && c.count > 0).length,
        ).toBeGreaterThanOrEqual(3);
        // The forward-dated snapshot has no entry figure as of today: counted, never dropped.
        const none = cohorts[cohorts.length - 1]!;
        expect(none.count).toBe(1);
        expect(none.lower).toBeNull();
        expect(none.upper).toBeNull();
      };
      check(
        s.cohorts.byEntryMultiple,
        bands().entryMultipleBands,
        (p) => p.entryMultiple,
        (p) => p.entryMultipleBand,
      );
      check(
        s.cohorts.byEntryLeverage,
        bands().entryLeverageBands,
        (p) => p.entryLeverage,
        (p) => p.entryLeverageBand,
      );
    });

    it('says which positions it leaves out by deal type, as the caller sees them', async () => {
      const s = await summaryFor('viewer.one');
      const credit = h.dataset.investments.filter((i) => i.dealType === 'deal_type.private_credit');
      expect(credit.length).toBeGreaterThan(0);
      expect(s.leftOut).toEqual([
        { dealType: 'deal_type.private_credit', label: 'Private credit', count: credit.length },
      ]);
      expect(s.positions.some((p) => credit.some((c) => c.id === p.id))).toBe(false);
    });

    it('answers as of an earlier date: later positions are absent and later quarters do not count', async () => {
      const asOf = '2024-12-31';
      const s = await summaryFor('deal.three', asOf);
      const want = eligible(asOf, true);
      expect(s.asOf).toBe(asOf);
      // A position entered later does not exist yet, and one exited later is still held.
      const midYear = await summaryFor('deal.three', '2024-06-30');
      expect(midYear.positions.some((p) => p.investmentNumber === 'INV-0007')).toBe(false);
      expect(midYear.positions.length).toBe(eligible('2024-06-30', true).length);
      expect(midYear.positions.length).toBeLessThan(s.positions.length);
      const held = await summaryFor('deal.three', '2023-06-30');
      const later = held.positions.find((p) => p.investmentNumber === 'INV-0019')!;
      expect(later.isActive).toBe(true);
      expect(D(later.nav!).gt(0)).toBe(true);
      expect(s.positions.find((p) => p.investmentNumber === 'INV-0019')!.nav).toBe('0');
      expect(s.positions.map((p) => p.investmentNumber)).toEqual(
        want.map((p) => p.investment.investmentNumber),
      );
      s.positions.forEach((row, i) => expectRow(row, want[i]!, asOf));
      for (const row of s.positions) {
        expect(row.entryDate <= asOf).toBe(true);
        if (row.current !== null) expect(row.current.periodEnd <= asOf).toBe(true);
      }
      // A position that had entered but not yet reported a quarter: no current quarter, and the
      // reason is carried to the gain split and the roll-up.
      const early = s.positions.find((p) => p.investmentNumber === 'INV-0007')!;
      expect(early.entry).not.toBeNull();
      expect(early.current).toBeNull();
      expect(early.notCalculable).toBe('no_current_quarter');
      expect(early.bridge).toBeNull();
      expect(early.gain).not.toBeNull();
      expect(early.gainByDriver).toBeNull();
      expect(early.gainNotCalculable).toBe('no_current_quarter');
      // It still has an entry multiple, so it sits in a band, not in "Not calculable".
      expect(early.entryMultipleBand).toMatch(/^band_\d$/);
      expect(s.portfolio.notCalculable).toContainEqual({ reason: 'no_current_quarter', count: 1 });
      // Before any position existed there is nothing to show, and nothing is invented.
      const empty = await summaryFor('deal.three', '2010-01-01');
      expect(empty.positions).toEqual([]);
      expect(empty.portfolio).toEqual({
        positions: 0,
        invested: null,
        nav: null,
        distributions: null,
        totalValue: null,
        gain: null,
        gainByDriver: null,
        notCalculable: [],
      });
      expect(
        empty.cohorts.byEntryMultiple.every((c) => c.count === 0 && c.grossMoic === null),
      ).toBe(true);
      expect(empty.leftOut).toEqual([]);
    });

    it('audits the read without business values (SEC-11.1)', async () => {
      await summaryFor('viewer.one', h.dataset.asOf, 'req-value-creation-audit-1');
      const audit = await h.runtime.db.query<{ n: number; details: string }>(
        "select count(*)::int as n, min(details::text) as details from audit.event where action = 'analytics.value_creation.read' and request_id = 'req-value-creation-audit-1'",
      );
      expect(audit[0]?.n).toBe(1);
      expect(audit[0]?.details).toBe('{}');
    });
  });

  describe('the CSV export', () => {
    it('exports the rows the caller sees: a header line, one line per position, text/csv', async () => {
      const s = await summaryFor('deal.three');
      const res = await get('deal.three', EXPORT, 'req-value-creation-export-1').expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="value-creation-${h.dataset.asOf}.csv"`,
      );
      const lines = res.text.trimEnd().split('\n');
      expect(lines.length).toBe(s.positions.length + 1);
      expect(lines[0]).toBe(VALUE_CREATION_CSV_COLUMNS.join(','));
      const table = parseCsv(res.text);
      expect(table.header).toEqual([...VALUE_CREATION_CSV_COLUMNS]);
      const cell = (row: string[], column: (typeof VALUE_CREATION_CSV_COLUMNS)[number]): string =>
        row[VALUE_CREATION_CSV_COLUMNS.indexOf(column)]!;
      const multipleLabels = new Map(s.cohorts.byEntryMultiple.map((c) => [c.key, c.label]));
      const leverageLabels = new Map(s.cohorts.byEntryLeverage.map((c) => [c.key, c.label]));
      s.positions.forEach((p, i) => {
        const row = table.rows[i]!;
        expect(row.length).toBe(VALUE_CREATION_CSV_COLUMNS.length);
        expect(cell(row, 'investmentNumber')).toBe(p.investmentNumber);
        expect(cell(row, 'investmentId')).toBe(p.id);
        expect(cell(row, 'companyName')).toBe(p.companyName);
        expect(cell(row, 'status')).toBe(p.isActive ? 'active' : 'realized');
        expect(cell(row, 'entryEvToEbitda')).toBe(p.entry?.evToEbitda ?? '');
        expect(cell(row, 'entryNetDebtToEbitda')).toBe(p.entry?.netDebtToEbitda ?? '');
        expect(cell(row, 'currentPeriodEnd')).toBe(p.current?.periodEnd ?? '');
        expect(cell(row, 'ebitdaGrowth')).toBe(p.growth.ebitdaGrowth ?? '');
        expect(cell(row, 'bridgeEbitdaGrowth')).toBe(p.bridge?.ebitdaGrowth ?? '');
        expect(cell(row, 'bridgeMultipleExpansion')).toBe(p.bridge?.multipleExpansion ?? '');
        expect(cell(row, 'bridgeDebtPaydown')).toBe(p.bridge?.debtPaydown ?? '');
        expect(cell(row, 'bridgeTotal')).toBe(p.bridge?.total ?? '');
        expect(cell(row, 'notCalculable')).toBe(p.notCalculable ?? '');
        expect(cell(row, 'grossMoic')).toBe(p.grossMoic ?? '');
        expect(cell(row, 'grossIrr')).toBe(p.grossIrr ?? '');
        expect(cell(row, 'gain')).toBe(p.gain ?? '');
        expect(cell(row, 'gainEbitdaGrowth')).toBe(p.gainByDriver?.ebitdaGrowth ?? '');
        expect(cell(row, 'gainNotCalculable')).toBe(p.gainNotCalculable ?? '');
        expect(cell(row, 'entryMultipleBand')).toBe(multipleLabels.get(p.entryMultipleBand));
        expect(cell(row, 'entryLeverageBand')).toBe(leverageLabels.get(p.entryLeverageBand));
      });
      // A figure that is not calculable is an empty cell, never a zero.
      const noBridge = table.rows[s.positions.findIndex((p) => p.bridge === null)]!;
      expect(cell(noBridge, 'bridgeTotal')).toBe('');
      expect(
        await count(
          "select count(*)::int as n from audit.event where action = 'analytics.value_creation.export' and request_id = 'req-value-creation-export-1'",
        ),
      ).toBe(1);
      // A non-member gets one line fewer, and nothing of the walled position.
      const outsider = await get('viewer.one', EXPORT).expect(200);
      const walledRow = s.positions.find((p) => p.id === walledId())!;
      expect(outsider.text.trimEnd().split('\n').length).toBe(s.positions.length);
      expect(outsider.text).not.toContain(walledRow.companyName);
      expect(outsider.text).not.toContain(walledId());
      // The as-of date carries to the file and its name.
      const earlier = await get('viewer.one', `${EXPORT}?asOf=2024-12-31`).expect(200);
      expect(earlier.headers['content-disposition']).toBe(
        'attachment; filename="value-creation-2024-12-31.csv"',
      );
      expect(earlier.text.trimEnd().split('\n').length).toBe(
        eligible('2024-12-31', false).length + 1,
      );
    });
  });

  describe('one position', () => {
    it('answers the same row as the portfolio view, with the indexed series by quarter', async () => {
      const asOf = h.dataset.asOf;
      const s = await summaryFor('deal.three');
      for (const number of ['INV-0001', 'INV-0002', 'INV-0006', 'INV-0010', 'INV-0018']) {
        const id = idOf(number);
        const detail = await oneFor('deal.three', id);
        expect(detail.investmentId).toBe(id);
        expect(detail.position).toEqual(s.positions.find((p) => p.id === id));
        const investment = h.dataset.investments.find((i) => i.id === id)!;
        expect(detail.series, number).toEqual(
          expectedSeries(h.dataset, investment, asOf, tolerance()),
        );
        // The lines start together at 100 on the entry snapshot; our mark has no figure there.
        expect(detail.series[0]).toEqual({
          periodEnd: detail.position!.entry!.periodEnd,
          isEntry: true,
          ebitdaIndex: '100',
          evIndex: '100',
          equityValueIndex: '100',
          markIndex: null,
        });
        expect(detail.series.slice(1).every((p) => !p.isEntry)).toBe(true);
        expect(detail.series[detail.series.length - 1]!.periodEnd).toBe(
          detail.position!.current!.periodEnd,
        );
        // The last company point is the growth since entry, on the index scale.
        const last = detail.series[detail.series.length - 1]!;
        expect(
          D(last.ebitdaIndex!)
            .div(100)
            .minus(1)
            .minus(detail.position!.growth.ebitdaGrowth!)
            .abs()
            .lte('1e-9'),
        ).toBe(true);
      }
      // A sponsor closing three days early still has its Locked mark for the quarter (INV-0002),
      // and a realized position has no mark in its last quarter: null, never zero (INV-0018).
      const shifted = await oneFor('deal.three', idOf('INV-0002'));
      expect(shifted.series[shifted.series.length - 1]!.markIndex).not.toBeNull();
      const realized = await oneFor('deal.three', idOf('INV-0018'));
      expect(realized.series[realized.series.length - 1]!.markIndex).toBeNull();
      expect(realized.series.some((p) => p.markIndex !== null)).toBe(true);
    });

    it('keeps the quarters and our mark when the bridge is not calculable', async () => {
      const forward = await oneFor('viewer.one', h.dataset.scenarios.forward_entry_snapshot![0]!);
      expect(forward.position!.notCalculable).toBe('no_entry_snapshot');
      expect(forward.position!.entry).toBeNull();
      expect(forward.series.length).toBeGreaterThan(0);
      // No base to index to, so the company lines are missing; our mark per cost is not.
      expect(forward.series.every((p) => !p.isEntry && p.ebitdaIndex === null)).toBe(true);
      expect(forward.series.every((p) => p.evIndex === null && p.equityValueIndex === null)).toBe(
        true,
      );
      expect(forward.series.some((p) => p.markIndex !== null)).toBe(true);
      const negative = await oneFor('viewer.one', h.dataset.scenarios.negative_ebitda![0]!);
      expect(negative.position!.notCalculable).toBe('non_positive_ebitda');
      expect(negative.position!.bridge).toBeNull();
      // EBITDA below zero still has an index level (below zero), and no multiple.
      const last = negative.series[negative.series.length - 1]!;
      expect(D(last.ebitdaIndex!).lt(0)).toBe(true);
      expect(negative.position!.current!.evToEbitda).toBeNull();
      expect(negative.position!.growth.multipleChange).toBeNull();
    });

    it('has no view for a credit position: no row and no series, said plainly', async () => {
      const credit = h.dataset.investments.find((i) => i.dealType === 'deal_type.private_credit')!;
      const detail = await oneFor('viewer.one', credit.id);
      expect(detail).toEqual({
        asOf: h.dataset.asOf,
        investmentId: credit.id,
        dealType: 'deal_type.private_credit',
        position: null,
        series: [],
        calcVersion: '0.1.0',
      });
    });

    it('returns 404, never 403, for a walled, unknown, malformed or not yet entered id and audits a member open', async () => {
      await get('viewer.one', one(walledId())).expect(404);
      await get('viewer.one', one('00000000-0000-4000-8000-000000000000')).expect(404);
      await get('viewer.one', one('not-a-uuid')).expect(404);
      // As of a day before its entry the position does not exist, as on the one-pager.
      await get('deal.three', `${one(idOf('INV-0007'))}?asOf=2024-01-31`).expect(404);
      const refused = await get('viewer.one', one(walledId()), 'req-value-creation-walled').expect(
        404,
      );
      expect(JSON.stringify(refused.body)).not.toContain('INV-0010');
      const member = await oneFor(
        'deal.three',
        walledId(),
        h.dataset.asOf,
        'req-value-creation-member',
      );
      expect(member.position?.investmentNumber).toBe('INV-0010');
      expect(
        await count(
          `select count(*)::int as n from audit.event where action = 'investment.value_creation.read' and entity_id = '${walledId()}' and request_id = 'req-value-creation-member'`,
        ),
      ).toBe(1);
      // Nobody outside the wall ever left an audited open of it.
      expect(
        await count(
          `select count(*)::int as n from audit.event e join core.app_user u on u.id = e.actor_id where e.action = 'investment.value_creation.read' and e.entity_id = '${walledId()}' and u.external_id <> 'deal.three'`,
        ),
      ).toBe(0);
      expect(
        await count(
          "select count(*)::int as n from audit.event where request_id = 'req-value-creation-walled'",
        ),
      ).toBe(0);
    });
  });
});

describe('value creation analytics: what does not count (M13, M20)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const idOf = (number: string): string =>
    h.dataset.investments.find((i) => i.investmentNumber === number)!.id;
  const rowFor = async (number: string): Promise<ValueCreationPosition> => {
    const res = await h
      .http()
      .get(`/api/v1/analytics/value-creation?asOf=${h.dataset.asOf}`)
      .set('authorization', h.as('deal.three'))
      .expect(200);
    return valueCreationSchema
      .parse(res.body)
      .positions.find((p) => p.investmentNumber === number)!;
  };
  const sql = (text: string, params: unknown[] = []): Promise<unknown[]> =>
    h.runtime.db.query(text, params);
  const latestQuarter = (number: string): string =>
    h.dataset.quarterlyPerformance
      .filter((q) => q.investmentId === idOf(number) && !q.isEntrySnapshot)
      .map((q) => q.periodEnd)
      .sort()
      .pop()!;

  it('never counts a quarter that is not approved: the earlier approved quarter stands', async () => {
    const before = await rowFor('INV-0012');
    const latest = latestQuarter('INV-0012');
    expect(before.current?.periodEnd).toBe(latest);
    await sql(
      "update mon.quarterly_performance set status = 'record_status.draft' where investment_id = $1 and period_end = $2 and not is_entry_snapshot",
      [idOf('INV-0012'), latest],
    );
    const after = await rowFor('INV-0012');
    expect(after.current!.periodEnd < latest).toBe(true);
    expect(after.bridge).not.toBeNull();
    expect(after.bridge!.equityCurrent).not.toBe(before.bridge!.equityCurrent);
    // With no approved quarter at all there is no current quarter, and no bridge.
    await sql(
      "update mon.quarterly_performance set status = 'record_status.draft' where investment_id = $1 and not is_entry_snapshot",
      [idOf('INV-0012')],
    );
    const none = await rowFor('INV-0012');
    expect(none.current).toBeNull();
    expect(none.notCalculable).toBe('no_current_quarter');
    expect(none.entryMultipleBand).toBe(before.entryMultipleBand);
  });

  it('has no entry while the entry snapshot is not approved', async () => {
    const before = await rowFor('INV-0014');
    expect(before.entry).not.toBeNull();
    await sql(
      "update mon.quarterly_performance set status = 'record_status.draft' where investment_id = $1 and is_entry_snapshot",
      [idOf('INV-0014')],
    );
    const after = await rowFor('INV-0014');
    expect(after.entry).toBeNull();
    expect(after.current).not.toBeNull();
    expect(after.notCalculable).toBe('no_entry_snapshot');
    expect(after.bridge).toBeNull();
    expect(after.growth.ebitdaGrowth).toBeNull();
    expect(after.entryMultipleBand).toBe('not_calculable');
    expect(after.entryLeverageBand).toBe('not_calculable');
    expect(after.gainNotCalculable).toBe('no_entry_snapshot');
  });

  it('names a missing figure as the reason, and still answers what the rest allows', async () => {
    await sql(
      'update mon.quarterly_performance set net_debt = null where investment_id = $1 and period_end = $2 and not is_entry_snapshot',
      [idOf('INV-0015'), latestQuarter('INV-0015')],
    );
    const row = await rowFor('INV-0015');
    expect(row.current!.netDebt).toBeNull();
    expect(row.notCalculable).toBe('missing_figures');
    expect(row.bridge).toBeNull();
    expect(row.gainByDriver).toBeNull();
    expect(row.gainNotCalculable).toBe('missing_figures');
    // EBITDA and EV still compare; net debt, leverage and equity value do not.
    expect(row.growth.ebitdaGrowth).not.toBeNull();
    expect(row.growth.evGrowth).not.toBeNull();
    expect(row.growth.multipleChange).not.toBeNull();
    expect(row.growth.netDebtChange).toBeNull();
    expect(row.growth.netLeverageChange).toBeNull();
    expect(row.growth.equityValueGrowth).toBeNull();
    expect(row.current!.netDebtToEbitda).toBeNull();
    expect(row.current!.evToEbitda).not.toBeNull();
  });

  it('does not split our gain when the company equity value did not change, or when we have no gain figure', async () => {
    // INV-0016: the current quarter restated to the entry equity value (EV and net debt as at entry).
    const entry = h.dataset.quarterlyPerformance.find(
      (q) => q.investmentId === idOf('INV-0016') && q.isEntrySnapshot,
    )!;
    await sql(
      'update mon.quarterly_performance set ev = $3, net_debt = $4 where investment_id = $1 and period_end = $2 and not is_entry_snapshot',
      [idOf('INV-0016'), latestQuarter('INV-0016'), entry.ev, entry.netDebt],
    );
    const flat = await rowFor('INV-0016');
    expect(flat.bridge).not.toBeNull();
    expect(flat.notCalculable).toBeNull();
    expect(flat.bridge!.total).toBe('0');
    expect(flat.bridge!.shares).toBeNull();
    expect(flat.bridge!.debtPaydown).toBe('0');
    // EBITDA growth and the multiple still moved, against each other.
    expect(D(flat.bridge!.ebitdaGrowth).plus(flat.bridge!.multipleExpansion).isZero()).toBe(true);
    expect(flat.gain).not.toBeNull();
    expect(flat.gainByDriver).toBeNull();
    expect(flat.gainNotCalculable).toBe('no_equity_change');

    // INV-0005: no Locked valuation left, so no NAV, no gain and nothing to split.
    await sql(
      "update mon.valuation set state = 'Reopened', reopen_reason = 'reopened for the value creation test' where investment_id = $1 and state = 'Locked'",
      [idOf('INV-0005')],
    );
    const unmarked = await rowFor('INV-0005');
    expect(unmarked.bridge).not.toBeNull();
    expect(unmarked.nav).toBeNull();
    expect(unmarked.gain).toBeNull();
    expect(unmarked.grossMoic).toBeNull();
    expect(unmarked.valuationGrowth).toBeNull();
    expect(unmarked.valuationGrowthGap).toBeNull();
    expect(unmarked.irrFlag).toBe('no_valuation');
    expect(unmarked.gainByDriver).toBeNull();
    expect(unmarked.gainNotCalculable).toBe('no_gain');

    const res = await h
      .http()
      .get(`/api/v1/analytics/value-creation?asOf=${h.dataset.asOf}`)
      .set('authorization', h.as('deal.three'))
      .expect(200);
    const s = valueCreationSchema.parse(res.body);
    const reasons = Object.fromEntries(s.portfolio.notCalculable.map((r) => [r.reason, r.count]));
    expect(reasons.no_equity_change).toBe(1);
    expect(reasons.no_gain).toBe(1);
    expect(reasons.missing_figures).toBe(1);
    expect(s.portfolio.positions + s.portfolio.notCalculable.reduce((n, r) => n + r.count, 0)).toBe(
      s.positions.length,
    );
    // The cohort that holds the unmarked position has no NAV, MOIC or IRR: never a partial sum.
    const cohort = s.cohorts.byEntryMultiple.find((c) => c.key === unmarked.entryMultipleBand)!;
    expect(cohort.nav).toBeNull();
    expect(cohort.grossMoic).toBeNull();
    expect(cohort.irrFlag).toBe('no_valuation');
    expect(cohort.invested).not.toBeNull();
  });

  it('reads the band edges from config and refuses to answer without usable ones', async () => {
    const analytics = (h.runtime.definitions as unknown as { analytics: Record<string, unknown> })
      .analytics;
    const original = { ...analytics };
    try {
      for (const [key, value] of [
        ['entryMultipleBands', undefined],
        ['entryMultipleBands', []],
        ['entryMultipleBands', [12, 10]],
        ['entryLeverageBands', [4, 4]],
        ['entryLeverageBands', ['four']],
      ] as const) {
        Object.assign(analytics, original);
        if (value === undefined) delete analytics[key];
        else analytics[key] = value;
        const res = await h
          .http()
          .get('/api/v1/analytics/value-creation')
          .set('authorization', h.as('viewer.one'))
          .expect(500);
        const problem = res.body as { type: string; detail: string };
        expect(problem.type).toMatch(/configuration$/);
        expect(problem.detail).toContain(`analytics.${key}`);
      }
      // Different edges give different bands at once: config, not code.
      Object.assign(analytics, original, { entryMultipleBands: [10.5] });
      const res = await h
        .http()
        .get('/api/v1/analytics/value-creation')
        .set('authorization', h.as('viewer.one'))
        .expect(200);
      expect(
        valueCreationSchema.parse(res.body).cohorts.byEntryMultiple.map((c) => c.label),
      ).toEqual(['Under 10.5x', '10.5x and over', 'Not calculable']);
    } finally {
      for (const key of Object.keys(analytics)) delete analytics[key];
      Object.assign(analytics, original);
    }
  });
});
