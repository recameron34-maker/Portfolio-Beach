import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, addDays, alignedQuarterEnd, daysBetween, latestQuarterEndOnOrBefore } from '@pb/calc';
import { problemDetails, valuationPage } from '@pb/contracts';
import type { ValuationPage, ValuationRow } from '@pb/contracts';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const TOLERANCE = 7;

describe('valuation board (M10)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const get = async (who: string, query = ''): Promise<ValuationPage> =>
    valuationPage.parse(
      (await h.http().get(`/api/v1/valuations${query}`).set('authorization', h.as(who)).expect(200))
        .body,
    );

  /** Every row the caller can see for a query, following nextCursor page by page. */
  const walk = async (
    who: string,
    limit: number,
    query = '',
  ): Promise<{ rows: ValuationRow[]; pages: number }> => {
    const rows: ValuationRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const after: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page = await get(who, `?limit=${limit}${query}${after}`);
      rows.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 100);
    return { rows, pages };
  };

  const idOf = (tag: string): string => h.dataset.scenarios[tag]![0]!;
  const walledId = (): string => idOf('walled_deal');
  const userName = (externalId: string): string =>
    h.dataset.users.find((u) => u.externalId === externalId)!.displayName;
  /** Seeded versions on or before the dataset as-of date that a reader can see. */
  const seeded = (wallMember: boolean) =>
    h.dataset.valuations.filter(
      (v) => v.periodEnd <= h.dataset.asOf && (wallMember || v.investmentId !== walledId()),
    );
  /** The board order: period end descending, investment number ascending, version descending. */
  const inBoardOrder = (a: ValuationRow, b: ValuationRow): boolean => {
    if (a.periodEnd !== b.periodEnd) return a.periodEnd > b.periodEnd;
    if (a.investmentNumber !== b.investmentNumber) return a.investmentNumber < b.investmentNumber;
    return a.version > b.version;
  };

  describe('request handling (docs/17 section 3)', () => {
    it('requires authentication, defaults the as-of date to the clock and rejects unknown keys', async () => {
      await h.http().get('/api/v1/valuations').expect(401);
      const page = await get('viewer');
      expect(page.asOf).toBe(h.dataset.asOf);
      expect(page.items.length).toBe(50);
      const res = await h
        .http()
        .get('/api/v1/valuations?sortBy=fairValue')
        .set('authorization', h.as('viewer'))
        .expect(400);
      expect(problemDetails.parse(res.body).type).toMatch(/\/validation$/);
      await h
        .http()
        .get('/api/v1/valuations?state=Approved')
        .set('authorization', h.as('viewer'))
        .expect(400);
    });

    it('rejects a malformed cursor with 400, including impossible dates and versions', async () => {
      const forged = [
        'not-a-cursor',
        Buffer.from('2025-06-30|INV-0001').toString('base64url'),
        Buffer.from('2025-02-31|INV-0001|1').toString('base64url'),
        Buffer.from('2025-06-30|INV-0001|one').toString('base64url'),
        Buffer.from('2025-06-30||1').toString('base64url'),
      ];
      for (const cursor of forged) {
        const res = await h
          .http()
          .get(`/api/v1/valuations?cursor=${cursor}`)
          .set('authorization', h.as('viewer'))
          .expect(400);
        expect(problemDetails.parse(res.body).detail).toBe('Invalid cursor');
      }
    });

    it('reports a missing tolerance setting as a configuration problem, never a default', async () => {
      const definitions = h.runtime.definitions;
      const saved = definitions.priorYearPeriodEndToleranceDays;
      delete definitions.priorYearPeriodEndToleranceDays;
      try {
        const res = await h
          .http()
          .get('/api/v1/valuations')
          .set('authorization', h.as('viewer'))
          .expect(500);
        expect(problemDetails.parse(res.body).type).toMatch(/\/configuration$/);
      } finally {
        definitions.priorYearPeriodEndToleranceDays = saved;
      }
      await get('viewer');
    });
  });

  describe('board contents', () => {
    it('shows 15 Locked marks for the 2025-06-30 quarter to a wall member and 14 to everyone else', async () => {
      const member = await get('deal.three', '?periodEnd=2025-06-30&state=Locked&limit=200');
      const viewer = await get('viewer.one', '?periodEnd=2025-06-30&state=Locked&limit=200');
      expect(member.items.length).toBe(15);
      expect(viewer.items.length).toBe(14);
      expect(member.items.map((r) => r.investmentId)).toContain(walledId());
      expect(viewer.items.map((r) => r.investmentId)).not.toContain(walledId());
      // The quarter includes the sponsor that reports on Jun 27 (period_end_shift).
      expect(member.items.every((r) => r.quarterEnd === '2025-06-30')).toBe(true);
      expect(member.items.map((r) => r.periodEnd)).toContain('2025-06-27');
      const total = (p: ValuationPage) => p.items.reduce((acc, r) => acc.plus(r.fairValue), D('0'));
      const expected = seeded(true)
        .filter(
          (v) => alignedQuarterEnd(v.periodEnd, TOLERANCE) === '2025-06-30' && v.state === 'Locked',
        )
        .reduce((acc, v) => acc.plus(v.fairValue), D('0'));
      expect(total(member).equals(expected)).toBe(true);
      // Period end descending, then investment number: the early reporter follows the quarter end.
      const keys = member.items.map((r) => `${r.periodEnd}|${r.investmentNumber}`);
      expect(keys).toEqual(
        [...keys].sort((a, b) => {
          const [pa = '', na = ''] = a.split('|');
          const [pb = '', nb = ''] = b.split('|');
          return pa !== pb ? (pa < pb ? 1 : -1) : na < nb ? -1 : na > nb ? 1 : 0;
        }),
      );
    });

    it('lists the restated quarter as version 2 Locked above version 1 Reopened', async () => {
      const restated = idOf('restatement');
      const page = await get('viewer', `?investmentId=${restated}&periodEnd=2025-03-31`);
      expect(page.items.map((r) => [r.version, r.state])).toEqual([
        [2, 'Locked'],
        [1, 'Reopened'],
      ]);
      const v2 = h.dataset.valuations.find(
        (v) => v.investmentId === restated && v.periodEnd === '2025-03-31' && v.version === 2,
      )!;
      expect(page.items[0]!.fairValue).toBe(v2.fairValue);
      expect(page.items[0]!.lockHash).toBe(v2.lockHash);
      // The seeded Reopened row carries no reason (G5); the API says so with null, never text.
      expect(page.items[1]!.reopenReason).toBeNull();
      expect(page.items[1]!.lockHash).not.toBeNull();
      // The next quarter compares against the Locked restatement, not the Reopened version.
      const next = await get('viewer', `?investmentId=${restated}&periodEnd=2025-06-30`);
      expect(next.items[0]!.priorFairValue).toBe(v2.fairValue);
    });

    it('returns exactly one row for the Reopened state filter', async () => {
      const page = await get('viewer', '?state=Reopened&limit=200');
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.investmentId).toBe(idOf('restatement'));
      expect(page.nextCursor).toBeNull();
    });

    it('has no 2025-06-30 mark for the stale position and no prior for the roll-forward break', async () => {
      const stale = await get('viewer', `?investmentId=${idOf('stale_valuation')}`);
      // Entered in the quarter to Dec 31, 2024: carried at cost then, marked by its sponsor at
      // Mar 31, 2025, and not since.
      expect(stale.items.map((r) => r.periodEnd)).toEqual(['2025-03-31', '2024-12-31']);
      expect(stale.items[1]!.method).toBe('valuation_method.cost');
      expect(stale.items[0]!.priorFairValue).toBe(stale.items[1]!.fairValue);
      expect(stale.items[0]!.changePct).not.toBeNull();
      const broken = await get(
        'viewer',
        `?investmentId=${idOf('roll_forward_break')}&periodEnd=2025-06-30`,
      );
      expect(broken.items.length).toBe(1);
      expect(broken.items[0]!.priorFairValue).toBeNull();
      expect(broken.items[0]!.changePct).toBeNull();
    });

    it('compares a sponsor reporting a few days early with its own previous quarter', async () => {
      const shifted = idOf('period_end_shift');
      const page = await get('viewer', `?investmentId=${shifted}`);
      const latest = page.items[0]!;
      expect(latest.periodEnd < '2025-06-30').toBe(true);
      const previous = h.dataset.valuations
        .filter((v) => v.investmentId === shifted && v.periodEnd < latest.periodEnd)
        .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))[0]!;
      expect(daysBetween(previous.periodEnd, '2025-03-31')).toBeGreaterThan(0);
      expect(latest.priorFairValue).toBe(previous.fairValue);
      expect(latest.changePct).not.toBeNull();
    });

    it('names the preparer and approvers and stamps the approval time on Locked rows', async () => {
      const page = await get('viewer', '?state=Locked&limit=200');
      for (const r of page.items) {
        expect(r.preparedBy).toBe(userName('ops.one'));
        expect(r.dealTeamApprovedBy).toBe(userName('deal.one'));
        expect(r.approvedBy).toBe(userName('head.one'));
        expect(r.lockHash).toMatch(/^h-[0-9a-f]{8}$/);
        const seededRow = h.dataset.valuations.find((v) => v.id === r.id)!;
        expect(r.approvedAt).not.toBeNull();
        expect(Date.parse(r.approvedAt!)).toBe(Date.parse(seededRow.approvedAt!));
        expect(r.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(r.method.startsWith('valuation_method.')).toBe(true);
        expect(r.dealType.startsWith('deal_type.')).toBe(true);
      }
    });

    it('computes the prior mark and the change for every row from the previous quarter end', async () => {
      const { rows } = await walk('deal.three', 200);
      expect(rows.length).toBe(seeded(true).length);
      let withPrior = 0;
      for (const r of rows) {
        const target = latestQuarterEndOnOrBefore(addDays(r.periodEnd, -1));
        const candidates = h.dataset.valuations
          .filter(
            (v) =>
              v.investmentId === r.investmentId &&
              v.state === 'Locked' &&
              v.periodEnd <= target &&
              daysBetween(v.periodEnd, target) <= 7,
          )
          .sort((a, b) =>
            a.periodEnd === b.periodEnd
              ? b.version - a.version
              : a.periodEnd < b.periodEnd
                ? 1
                : -1,
          );
        const prior = candidates[0]?.fairValue ?? null;
        expect(r.priorFairValue, `${r.investmentNumber} ${r.periodEnd}`).toBe(prior);
        if (prior === null) {
          expect(r.changePct).toBeNull();
          continue;
        }
        withPrior += 1;
        const expected = D(r.fairValue).minus(prior).div(prior);
        expect(D(r.changePct!).minus(expected).abs().lt('1e-9')).toBe(true);
      }
      expect(withPrior).toBeGreaterThan(100);
    });
  });

  describe('paging, filters and walls (SEC-5.1, SEC-5.3)', () => {
    it('walks the full visible set at limit 50 without duplicates, in board order', async () => {
      for (const [who, member] of [
        ['viewer.one', false],
        ['deal.three', true],
      ] as const) {
        const { rows, pages } = await walk(who, 50);
        const expected = seeded(member);
        expect(rows.length).toBe(expected.length);
        expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
        expect(new Set(rows.map((r) => r.id))).toEqual(new Set(expected.map((v) => v.id)));
        expect(pages).toBe(Math.ceil(expected.length / 50));
        for (let i = 1; i < rows.length; i += 1)
          expect(inBoardOrder(rows[i - 1]!, rows[i]!), `row ${i}`).toBe(true);
      }
      // Four positions entered within their kept history carry a cost mark at their entry quarter
      // end; one of them is the walled deal.
      const costMarks = h.dataset.valuations.filter((v) => v.method === 'valuation_method.cost');
      expect(costMarks.length).toBe(4);
      expect(seeded(false).length).toBe(137);
      expect(seeded(true).length).toBe(146);
    });

    it('breaks every tie in the cursor key: small pages reproduce the single-page order', async () => {
      const single = (await get('deal.three', '?limit=200')).items.map((r) => r.id);
      expect((await walk('deal.three', 7)).rows.map((r) => r.id)).toEqual(single);
      // One row per page splits the restated quarter between its two versions.
      const restated = idOf('restatement');
      const versions = (await get('viewer', `?investmentId=${restated}&limit=200`)).items;
      const { rows, pages } = await walk('viewer', 1, `&investmentId=${restated}`);
      expect(rows.map((r) => [r.periodEnd, r.version])).toEqual(
        versions.map((r) => [r.periodEnd, r.version]),
      );
      expect(pages).toBe(versions.length);
    });

    it('filters by investment and by vehicle', async () => {
      const target = h.dataset.investments.find((i) => i.investmentNumber === 'INV-0009')!;
      const byInvestment = await get('viewer', `?investmentId=${target.id}&limit=200`);
      const expected = seeded(false).filter((v) => v.investmentId === target.id);
      expect(byInvestment.items.length).toBe(expected.length);
      for (const r of byInvestment.items) expect(r.investmentId).toBe(target.id);
      expect(
        byInvestment.items.every((r) => r.method === 'valuation_method.par_plus_accrued'),
      ).toBe(true);

      const vehicle = h.dataset.vehicles.find((v) => v.id === target.vehicleId)!;
      const inVehicle = new Set(
        h.dataset.investments.filter((i) => i.vehicleId === vehicle.id).map((i) => i.id),
      );
      const byVehicle = await get('viewer', `?vehicleId=${vehicle.id}&limit=200`);
      expect(byVehicle.items.length).toBe(
        seeded(false).filter((v) => inVehicle.has(v.investmentId)).length,
      );
      for (const r of byVehicle.items) expect(r.vehicleName).toBe(vehicle.name);
    });

    it('hides the walled position even when filtered by its id: an empty list, not 403', async () => {
      const viewer = await get('viewer.one', `?investmentId=${walledId()}`);
      expect(viewer.items).toEqual([]);
      expect(viewer.nextCursor).toBeNull();
      const member = await get('deal.three', `?investmentId=${walledId()}`);
      expect(member.items.length).toBe(
        seeded(true).filter((v) => v.investmentId === walledId()).length,
      );
      expect(member.items.length).toBeGreaterThan(0);
    });

    it('lists the visible quarter ends, latest first, whatever the page and filters', async () => {
      // config/definitions.json priorYearPeriodEndToleranceDays is 7.
      const expected = [
        ...new Set(seeded(false).map((v) => alignedQuarterEnd(v.periodEnd, TOLERANCE))),
      ]
        .sort()
        .reverse();
      const plain = await get('viewer', '?limit=1');
      const filtered = await get('viewer', '?state=Reopened');
      expect(plain.periods).toEqual(expected);
      expect(filtered.periods).toEqual(expected);
      expect(plain.periods[0]).toBe('2025-06-30');
      // A sponsor reporting a few days early lands in the quarter it reports for.
      expect(plain.periods).not.toContain('2025-06-27');
    });

    it('gives every version the quarter end it reports for (the NAV series rule)', async () => {
      const { rows } = await walk('deal.three', 200);
      for (const r of rows) expect(r.quarterEnd).toBe(alignedQuarterEnd(r.periodEnd, TOLERANCE));
      const shifted = rows.find(
        (r) => r.investmentId === idOf('period_end_shift') && r.periodEnd === '2025-06-27',
      )!;
      expect(shifted.quarterEnd).toBe('2025-06-30');
      expect(rows.filter((r) => r.quarterEnd !== r.periodEnd).length).toBeGreaterThan(0);
      expect(rows.every((r) => latestQuarterEndOnOrBefore(r.quarterEnd) === r.quarterEnd)).toBe(
        true,
      );
    });

    it('honours an earlier as-of date for the rows and the periods', async () => {
      const page = await get('viewer', '?asOf=2024-12-31&limit=200');
      expect(page.asOf).toBe('2024-12-31');
      expect(page.items.every((r) => r.periodEnd <= '2024-12-31')).toBe(true);
      expect(page.periods[0]).toBe('2024-12-31');
      expect(page.periods.every((p) => p <= '2024-12-31')).toBe(true);
    });
  });
});
