import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, addDays, alignedQuarterEnd, daysBetween, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  investmentDetail,
  problemDetails,
  valuationBatchResult,
  valuationDetail,
  valuationLockText,
  valuationPage,
  valuationRow,
  weeklyReport,
} from '@pb/contracts';
import type {
  ValuationBatchResult,
  ValuationCommand,
  ValuationDetail,
  ValuationPage,
  ValuationRow,
  ValuationState,
} from '@pb/contracts';
import { SYSTEM_USER_ID, schema, withUserContext } from '@pb/db';
import { forbiddenPairs, valuationMachine } from '@pb/workflows';
import { valuationLockHash } from '../common/lock.js';
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
        Buffer.from(`2025-06-30|INV-0001${String.fromCharCode(0)}|1`).toString('base64url'),
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

/*
 * The valuation workflow (docs/04 M10, docs/18 section 1, journey 3 of docs/12) over the API, on
 * its own harness so the board counts above stay as seeded. The reporting gate test runs first,
 * before any reopen moves a Locked mark; every later test takes its own untagged investment.
 */
describe('valuation workflow (M10, docs/18 section 1)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const PERIOD = '2025-06-30';
  const METHOD = 'valuation_method.sponsor_mark';
  const NIL = '00000000-0000-4000-8000-000000000000';
  const userId = (externalId: string): string =>
    h.dataset.users.find((u) => u.externalId === externalId)!.id;
  const userName = (externalId: string): string =>
    h.dataset.users.find((u) => u.externalId === externalId)!.displayName;
  const idOf = (tag: string): string => h.dataset.scenarios[tag]![0]!;
  const lockedAt = (investmentId: string, periodEnd = PERIOD): string =>
    h.dataset.valuations.find(
      (v) => v.investmentId === investmentId && v.periodEnd === periodEnd && v.state === 'Locked',
    )!.id;
  /** Active, visible investments outside every scenario, each with a Locked mark at the period. */
  const plain = (periodEnd = PERIOD): string[] => {
    const tagged = new Set(Object.values(h.dataset.scenarios).flat());
    return h.dataset.investments
      .filter(
        (i) =>
          i.isActive &&
          !tagged.has(i.id) &&
          h.dataset.valuations.some(
            (v) => v.investmentId === i.id && v.periodEnd === periodEnd && v.state === 'Locked',
          ),
      )
      .map((i) => i.id)
      .sort();
  };
  /**
   * Locked versions for the write tests to take one each, latest quarter first: the small
   * profile has four untagged active positions, so the earlier quarters supply the rest (one
   * Locked version per investment and period end, so each slot is its own chain).
   */
  const slots = (): { investmentId: string; versionId: string; periodEnd: string }[] =>
    [PERIOD, '2025-03-31', '2024-12-31'].flatMap((periodEnd) =>
      plain(periodEnd).map((investmentId) => ({
        investmentId,
        versionId: lockedAt(investmentId, periodEnd),
        periodEnd,
      })),
    );
  const slot = (n: number): { investmentId: string; versionId: string; periodEnd: string } => {
    const found = slots()[n];
    if (found === undefined) throw new Error(`no slot ${n}`);
    return found;
  };
  /** The message of a rejected promise, with the cause drizzle wraps a database error in. */
  const rejection = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
      return 'resolved';
    } catch (error: unknown) {
      const err = error as { message?: string; cause?: { message?: string } };
      return `${err.message ?? ''} ${err.cause?.message ?? ''}`;
    }
  };

  const create = async (
    who: string,
    body: Record<string, unknown>,
    status = 201,
  ): Promise<Record<string, unknown>> =>
    (
      await h
        .http()
        .post('/api/v1/valuations')
        .set('authorization', h.as(who))
        .send(body)
        .expect(status)
    ).body as Record<string, unknown>;
  const command = async (
    who: string,
    id: string,
    body: Record<string, unknown>,
    status = 200,
    headers: Record<string, string> = {},
  ): Promise<{ body: Record<string, unknown>; etag: string | undefined }> => {
    const res = await h
      .http()
      .post(`/api/v1/valuations/${id}/commands`)
      .set('authorization', h.as(who))
      .set(headers)
      .send(body)
      .expect(status);
    return { body: res.body as Record<string, unknown>, etag: res.headers.etag };
  };
  const row = async (
    who: string,
    id: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<ValuationRow> => valuationRow.parse((await command(who, id, body, 200, headers)).body);
  const detail = async (who: string, id: string, status = 200): Promise<ValuationDetail> => {
    const res = await h
      .http()
      .get(`/api/v1/valuations/${id}`)
      .set('authorization', h.as(who))
      .expect(status);
    return status === 200 ? valuationDetail.parse(res.body) : (res.body as ValuationDetail);
  };
  const stateOf = async (id: string): Promise<string> =>
    (
      await h.runtime.db.query<{ state: string }>('select state from mon.valuation where id = $1', [
        id,
      ])
    )[0]!.state;
  const versionIn = async (investmentId: string, state: string): Promise<string> =>
    (
      await h.runtime.db.query<{ id: string }>(
        'select id from mon.valuation where investment_id = $1 and state = $2',
        [investmentId, state],
      )
    )[0]!.id;
  const events = (action: string, entityId: string) =>
    h.runtime.db.query<{
      details: Record<string, unknown>;
      reason: string | null;
      actor_id: string;
    }>(
      'select details, reason, actor_id from audit.event where action = $1 and entity_id = $2 order by id',
      [action, entityId],
    );
  const tasksFor = (regardingId: string) =>
    h.runtime.db.query<{ owner_id: string; title: string; state: string }>(
      "select owner_id, title, state from ops.task where regarding_entity = 'mon.valuation' and regarding_id = $1 order by owner_id",
      [regardingId],
    );
  /** Stages a segregation-of-duties case by hand: no synthetic user holds two roles. */
  const setPreparedBy = (id: string, preparedBy: string): Promise<void> =>
    withUserContext(
      h.runtime.db.db,
      { userId: userId('ops.one'), roles: ['operations'], clientIds: [] },
      async (tx) => {
        await tx.update(schema.valuation).set({ preparedBy }).where(eq(schema.valuation.id, id));
      },
    );
  const weekly = async () =>
    weeklyReport.parse(
      (
        await h
          .http()
          .get('/api/v1/reports/weekly')
          .set('authorization', h.as('viewer'))
          .expect(200)
      ).body,
    );
  const onePager = async (investmentId: string) =>
    investmentDetail.parse(
      (
        await h
          .http()
          .get(`/api/v1/investments/${investmentId}?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as('viewer'))
          .expect(200)
      ).body,
    );

  it('reproduces the pinned lock digest of the contracts over the same text', () => {
    const inputs = {
      investmentId: '30000000-0000-4000-8000-000000000001',
      periodEnd: '2025-06-30',
      version: 2,
      method: 'Last round',
      fairValue: '1250000.00',
    };
    expect(valuationLockHash(inputs)).toBe(
      '828c4e9f8fcd8423b76d5e175ca857a1cca0302e9789faf1b56eb3c68700cc1f',
    );
    expect(valuationLockHash(inputs)).toBe(
      createHash('sha256').update(valuationLockText(inputs)).digest('hex'),
    );
  });

  it('reporting gate: a DealTeamApproved mark changes no report; locking it does', async () => {
    const stale = idOf('stale_valuation');
    const before = await onePager(stale);
    expect(before.navDate).toBe('2025-03-31');
    const prior = before.nav!;
    const fairValue = D(prior).times('1.5').toFixed(2);
    const created = valuationRow.parse(
      await create('ops.one', {
        investmentId: stale,
        periodEnd: PERIOD,
        method: METHOD,
        fairValue,
        inputs: { source: 'sponsor letter', note: 'Q2 mark' },
      }),
    );
    expect(created.state).toBe('Draft');
    expect(created.preparedBy).toBeNull();
    expect(created.priorFairValue).toBe(prior);
    expect(created.version).toBe(1);
    const report = await weekly();
    expect(report.staleValuations.map((x) => x.investmentId)).toContain(stale);

    await row('ops.one', created.id, { command: 'prepare' });
    const approved = await row('deal.one', created.id, { command: 'dealTeamApprove' });
    expect(approved.state).toBe('DealTeamApproved');
    expect(approved.dealTeamApprovedBy).toBe(userName('deal.one'));
    // Nothing a client could see has moved: the weekly report and the one-pager read Locked only.
    expect(await weekly()).toEqual(report);
    const unchanged = await onePager(stale);
    expect(unchanged.nav).toBe(prior);
    expect(unchanged.navDate).toBe('2025-03-31');
    expect(unchanged.valuations.map((v) => v.state)).toContain('DealTeamApproved');

    const locked = await row('head.one', created.id, { command: 'lock' });
    expect(locked.state).toBe('Locked');
    expect(locked.approvedBy).toBe(userName('head.one'));
    expect(locked.approvedAt).toBe(`${h.dataset.asOf}T12:00:00.000Z`);
    expect(locked.lockHash).toBe(valuationLockHash(locked));
    const after = await onePager(stale);
    expect(after.nav).toBe(fairValue);
    expect(after.navDate).toBe(PERIOD);
    const relocked = await weekly();
    expect(relocked).not.toEqual(report);
    expect(relocked.staleValuations.map((x) => x.investmentId)).not.toContain(stale);
    const seen = await detail('viewer', created.id);
    expect(seen.lockText).toBe(valuationLockText(locked));
    expect(seen.approvals.map((a) => [a.step, a.decision, a.actorName])).toEqual([
      ['ops_prepared', 'approve', userName('ops.one')],
      ['deal_team', 'approve', userName('deal.one')],
      ['final', 'approve', userName('head.one')],
    ]);
    const lockEvent = (await events('valuation.lock', created.id))[0]!;
    expect(lockEvent.details.state).toEqual({ before: 'DealTeamApproved', after: 'Locked' });
    expect(lockEvent.details.lockHash).toEqual({ before: null, after: locked.lockHash });
    expect((await events('valuation.create', created.id))[0]!.details.state).toEqual({
      before: null,
      after: 'Draft',
    });
  });

  describe('create (the "(new) to Draft" row)', () => {
    it('needs the operations role, a visible active investment, a quarter and a positive value', async () => {
      const target = slot(0).investmentId;
      const body = { investmentId: target, periodEnd: PERIOD, method: METHOD, fairValue: '10.00' };
      for (const who of ['viewer', 'deal.one', 'head.one', 'audit.one'])
        await create(who, body, 403);
      // A period with a Locked version is reopened first, never doubled (422, not a hint).
      const locked = problemDetails.parse(await create('ops.one', body, 422));
      expect(locked.type).toMatch(/workflow-precondition$/);
      expect(locked.detail).toMatch(/reopen/);
      // Walled: 404 for operations outside the wall, so the position is not revealed.
      await create('ops.one', { ...body, investmentId: idOf('walled_deal') }, 404);
      await create('ops.one', { ...body, investmentId: NIL }, 404);
      const exited = h.dataset.investments.find((i) => !i.isActive)!;
      await create('ops.one', { ...body, investmentId: exited.id }, 404);
      // Not a quarter end and not within the tolerance of one.
      const offQuarter = problemDetails.parse(
        await create('ops.one', { ...body, periodEnd: '2025-05-15' }, 422),
      );
      expect(offQuarter.detail).toMatch(/quarter end/);
      const position = h.dataset.investments.find((i) => i.id === target)!;
      const early = problemDetails.parse(
        await create(
          'ops.one',
          { ...body, periodEnd: latestQuarterEndOnOrBefore(addDays(position.entryDate, -1)) },
          422,
        ),
      );
      expect(early.detail).toMatch(/not yet held/);
      for (const fairValue of ['0', '0.00', '-5.00']) {
        const bad = problemDetails.parse(await create('ops.one', { ...body, fairValue }, 400));
        expect(bad.errors?.map((e) => e.path)).toEqual(['fairValue']);
      }
      for (const method of [
        'sponsor_mark',
        'valuation_method.made_up',
        'deal_type.cv_single_asset',
      ]) {
        const bad = problemDetails.parse(await create('ops.one', { ...body, method }, 400));
        expect(bad.errors?.map((e) => e.path)).toEqual(['method']);
      }
      await create('ops.one', { ...body, extra: 1 }, 400);
    });
  });

  describe('journey 3: prepare, approve, lock, then an edit after lock', () => {
    it('reopens a Locked version into a new Draft, alerts the prior approvers and locks the new one', async () => {
      const { investmentId: target, versionId: v1 } = slot(0);
      expect(slot(0).periodEnd).toBe(PERIOD);
      const seeded = h.dataset.valuations.find((v) => v.id === v1)!;
      // Reopen needs a reason (422 without one) and a role from the table (403 for the deal team).
      const noReason = problemDetails.parse(
        (await command('head.one', v1, { command: 'reopen' }, 422)).body,
      );
      expect(noReason.detail).toMatch(/reason/);
      await command('deal.one', v1, { command: 'reopen', reason: 'Sponsor restated Q2' }, 403);
      const draft = await row('head.one', v1, { command: 'reopen', reason: 'Sponsor restated Q2' });
      expect(draft.id).not.toBe(v1);
      expect(draft.state).toBe('Draft');
      expect(draft.version).toBe(seeded.version + 1);
      expect(draft.periodEnd).toBe(PERIOD);
      expect([draft.method, draft.fairValue]).toEqual([seeded.method, seeded.fairValue]);
      expect([
        draft.preparedBy,
        draft.dealTeamApprovedBy,
        draft.approvedBy,
        draft.lockHash,
      ]).toEqual([null, null, null, null]);
      expect(await stateOf(v1)).toBe('Reopened');
      const reopened = await detail('viewer', v1);
      expect(reopened.reopenReason).toBe('Sponsor restated Q2');
      expect(reopened.lockHash).toBe(seeded.lockHash);
      expect(reopened.lockText).toBeNull();
      expect(reopened.approvals.map((a) => [a.step, a.decision, a.reason])).toEqual([
        ['reopen', 'reopen', 'Sponsor restated Q2'],
      ]);
      // The approver reopening is not alerted about their own reopen; the deal team approver is.
      const tasks = await tasksFor(draft.id);
      expect(tasks.map((t) => t.owner_id)).toEqual([userId('deal.one')]);
      expect(tasks[0]!.title).toBe(`Valuation reopened: ${draft.investmentNumber} ${PERIOD}`);
      expect(tasks[0]!.state).toBe('open');
      const reopenEvent = (await events('valuation.reopen', v1))[0]!;
      expect(reopenEvent.reason).toBe('Sponsor restated Q2');
      expect(reopenEvent.details.state).toEqual({ before: 'Locked', after: 'Reopened' });
      expect(reopenEvent.details.newVersion).toEqual({ id: draft.id, version: draft.version });
      expect((await events('valuation.create', draft.id)).length).toBe(1);

      // The new version takes the full path, with a send back on the way.
      await row('ops.one', draft.id, { command: 'prepare' });
      const sentBack = await row('deal.one', draft.id, {
        command: 'sendBack',
        reason: 'Check the multiple against the latest comps',
      });
      expect(sentBack.state).toBe('Draft');
      expect(sentBack.preparedBy).toBe(userName('ops.one'));
      await row('ops.one', draft.id, { command: 'prepare' });
      await row('deal.one', draft.id, { command: 'dealTeamApprove' });
      const locked = await row('head.one', draft.id, { command: 'lock' });
      expect(locked.state).toBe('Locked');
      expect(locked.lockHash).toBe(
        createHash('sha256').update(valuationLockText(locked)).digest('hex'),
      );
      expect(locked.lockHash).not.toBe(seeded.lockHash);
      const trail = (await detail('audit.one', draft.id)).approvals;
      expect(trail.map((a) => [a.step, a.decision])).toEqual([
        ['ops_prepared', 'approve'],
        ['deal_team', 'reject'],
        ['ops_prepared', 'approve'],
        ['deal_team', 'approve'],
        ['final', 'approve'],
      ]);
      expect(trail[1]!.reason).toBe('Check the multiple against the latest comps');
      // The board lists the new Locked version above the Reopened one.
      const page = valuationPage.parse(
        (
          await h
            .http()
            .get(`/api/v1/valuations?investmentId=${target}&periodEnd=${PERIOD}`)
            .set('authorization', h.as('viewer'))
            .expect(200)
        ).body,
      );
      expect(page.items.map((r) => [r.version, r.state])).toEqual([
        [draft.version, 'Locked'],
        [seeded.version, 'Reopened'],
      ]);
    });

    it('alerts both prior approvers when operations reopens, and refuses a second chain', async () => {
      const { investmentId: target, versionId: v1 } = slot(1);
      expect(slot(1).periodEnd).toBe(PERIOD);
      const draft = await row('ops.one', v1, { command: 'reopen', reason: 'Late sponsor letter' });
      expect((await tasksFor(draft.id)).map((t) => t.owner_id).sort()).toEqual(
        [userId('deal.one'), userId('head.one')].sort(),
      );
      // A version is in progress for the quarter now: no second chain from the board.
      const inProgress = problemDetails.parse(
        await create(
          'ops.one',
          { investmentId: target, periodEnd: PERIOD, method: METHOD, fairValue: '1.00' },
          422,
        ),
      );
      expect(inProgress.detail).toMatch(/in progress/);
    });
  });

  describe('M10 acceptance: a Locked version never changes in place; segregation of duties', () => {
    it('raises from the guard trigger on a direct update, whoever tries', async () => {
      const v1 = slot(2).versionId;
      const before = await h.runtime.db.query<{ fair_value: string }>(
        'select fair_value from mon.valuation where id = $1',
        [v1],
      );
      expect(
        await rejection(
          h.runtime.db.exec(`update mon.valuation set fair_value = 1 where id = '${v1}'`),
        ),
      ).toMatch(/is Locked and cannot be updated in place/);
      expect(
        await rejection(
          withUserContext(
            h.runtime.db.db,
            { userId: userId('ops.one'), roles: ['operations'], clientIds: [] },
            async (tx) => {
              await tx
                .update(schema.valuation)
                .set({ fairValue: '1.00' })
                .where(eq(schema.valuation.id, v1));
            },
          ),
        ),
      ).toMatch(/is Locked and cannot be updated in place/);
      // The system actor holds no update policy on valuations at all: nothing changes, silently.
      await withUserContext(
        h.runtime.db.db,
        { userId: SYSTEM_USER_ID, roles: ['service'] },
        async (tx) => {
          await tx
            .update(schema.valuation)
            .set({ fairValue: '1.00' })
            .where(eq(schema.valuation.id, v1));
        },
      );
      const after = await h.runtime.db.query<{ fair_value: string }>(
        'select fair_value from mon.valuation where id = $1',
        [v1],
      );
      expect(after).toEqual(before);
      expect(await stateOf(v1)).toBe('Locked');
    });

    it('refuses the preparer as deal team approver (422) and as final approver (422)', async () => {
      // Deal team approve: a version prepared by the deal team member who tries to approve it.
      const draftA = await row('head.one', slot(3).versionId, {
        command: 'reopen',
        reason: 'Stage the preparer case',
      });
      await row('ops.one', draftA.id, { command: 'prepare' });
      await setPreparedBy(draftA.id, userId('deal.one'));
      const asPreparer = problemDetails.parse(
        (await command('deal.one', draftA.id, { command: 'dealTeamApprove' }, 422)).body,
      );
      expect(asPreparer.type).toMatch(/workflow-precondition$/);
      expect(asPreparer.detail).toMatch(/preparer/);
      expect(await stateOf(draftA.id)).toBe('OpsPrepared');
      // Lock: a version prepared by the approver who tries to lock it; and the deal team cannot
      // lock at all (403); and a lock from Draft is not a transition (409).
      const draftB = await row('head.one', slot(4).versionId, {
        command: 'reopen',
        reason: 'Stage the approver case',
      });
      const fromDraft = problemDetails.parse(
        (await command('head.one', draftB.id, { command: 'lock' }, 409)).body,
      );
      expect(fromDraft.type).toMatch(/workflow-transition$/);
      await row('ops.one', draftB.id, { command: 'prepare' });
      await row('deal.one', draftB.id, { command: 'dealTeamApprove' });
      await command('deal.one', draftB.id, { command: 'lock' }, 403);
      await setPreparedBy(draftB.id, userId('head.one'));
      const asApprover = problemDetails.parse(
        (await command('head.one', draftB.id, { command: 'lock' }, 422)).body,
      );
      expect(asApprover.detail).toMatch(/preparer/);
      expect(await stateOf(draftB.id)).toBe('DealTeamApproved');
      expect((await events('valuation.lock', draftB.id)).length).toBe(0);
    });

    it('answers 409 for every forbidden pair of the machine, from a row in that state', async () => {
      const byState: Record<ValuationState, string> = {
        Draft: await versionIn(slot(1).investmentId, 'Draft'),
        OpsPrepared: await versionIn(slot(3).investmentId, 'OpsPrepared'),
        DealTeamApproved: await versionIn(slot(4).investmentId, 'DealTeamApproved'),
        Locked: slot(2).versionId,
        Reopened: slot(0).versionId,
      };
      const userFor: Record<string, string> = {
        operations: 'ops.one',
        deal_team: 'deal.one',
        approver: 'head.one',
      };
      const pairs = forbiddenPairs(valuationMachine);
      const commands: ValuationCommand[] = [
        'prepare',
        'sendBack',
        'dealTeamApprove',
        'lock',
        'reopen',
      ];
      expect(pairs.length).toBe(
        valuationMachine.states.length * commands.length - valuationMachine.transitions.length,
      );
      for (const { from, command: cmd } of pairs) {
        const id = byState[from];
        expect(await stateOf(id), `${from} row`).toBe(from);
        const role = valuationMachine.transitions.find((t) => t.command === cmd)!.roles[0]!;
        const res = await command(
          userFor[role]!,
          id,
          { command: cmd, reason: 'Trying a pair the table does not list' },
          409,
        );
        const problem = problemDetails.parse(res.body);
        expect(problem.type, `${from} ${cmd}`).toMatch(/workflow-transition$/);
        expect(problem.detail, `${from} ${cmd}`).toContain(`${cmd} is not allowed from ${from}`);
        expect(await stateOf(id), `${from} ${cmd}`).toBe(from);
      }
    });
  });

  describe('row versions, batches and walls', () => {
    it('answers 412 to a stale If-Match, 400 to a malformed one, and tags every answer', async () => {
      const draft = await row('ops.one', slot(5).versionId, {
        command: 'reopen',
        reason: 'Row version check',
      });
      const first = await command('ops.one', draft.id, { command: 'prepare' }, 412, {
        'if-match': '"999"',
      });
      expect(problemDetails.parse(first.body).status).toBe(412);
      expect(problemDetails.parse(first.body).type).toBe(
        'https://portfolio-beach.example/problems/stale-row-version',
      );
      expect(await stateOf(draft.id)).toBe('Draft');
      await command('ops.one', draft.id, { command: 'prepare' }, 400, { 'if-match': 'abc' });
      const ok = await command('ops.one', draft.id, { command: 'prepare' }, 200, {
        'if-match': `W/"${draft.rowVersion}"`,
      });
      const prepared = valuationRow.parse(ok.body);
      expect(prepared.state).toBe('OpsPrepared');
      expect(prepared.rowVersion).toBe(draft.rowVersion + 1);
      expect(ok.etag).toBe(`"${prepared.rowVersion}"`);
      // The old tag is stale now; a wildcard matches anything.
      await command('deal.one', draft.id, { command: 'dealTeamApprove' }, 412, {
        'if-match': `"${draft.rowVersion}"`,
      });
      await command('deal.one', draft.id, { command: 'dealTeamApprove' }, 200, {
        'if-match': '*',
      });
    });

    it('runs a batch id by id, never stopping at a refusal, with one audit event per success', async () => {
      const opsPrepared = await row('ops.one', slot(6).versionId, {
        command: 'reopen',
        reason: 'Batch check',
      });
      await row('ops.one', opsPrepared.id, { command: 'prepare' });
      const stillDraft = await row('ops.one', slot(7).versionId, {
        command: 'reopen',
        reason: 'Batch check',
      });
      const locked = slot(2).versionId;
      const post = async (who: string, body: Record<string, unknown>, status = 200) =>
        (
          await h
            .http()
            .post('/api/v1/valuations/batch-commands')
            .set('authorization', h.as(who))
            .send(body)
            .expect(status)
        ).body as ValuationBatchResult;
      await post('ops.one', { command: 'dealTeamApprove', ids: [opsPrepared.id] }, 403);
      await post('deal.one', { command: 'prepare', ids: [opsPrepared.id] }, 400);
      const batch = valuationBatchResult.parse(
        await post('deal.one', {
          command: 'dealTeamApprove',
          ids: [opsPrepared.id, stillDraft.id, locked, NIL],
        }),
      );
      expect(batch.results.map((r) => [r.id, r.ok, r.state ?? r.problem?.status])).toEqual([
        [opsPrepared.id, true, 'DealTeamApproved'],
        [stillDraft.id, false, 409],
        [locked, false, 409],
        [NIL, false, 404],
      ]);
      expect(batch.results[1]!.problem?.code).toBe('workflow-transition');
      expect((await events('valuation.dealTeamApprove', opsPrepared.id)).length).toBe(1);
      expect((await events('valuation.dealTeamApprove', stillDraft.id)).length).toBe(0);
      expect(
        (
          await h.runtime.db.query<{ n: number }>(
            "select count(*)::int as n from audit.event where action like 'valuation.batch%'",
          )
        )[0]!.n,
      ).toBe(0);
      // The deal team may call the batch route but cannot lock: a 403 per row, not for the batch.
      const refused = valuationBatchResult.parse(
        await post('deal.one', { command: 'lock', ids: [opsPrepared.id] }),
      );
      expect(refused.results[0]!.problem?.status).toBe(403);
      const lockedBatch = valuationBatchResult.parse(
        await post('head.one', { command: 'lock', ids: [opsPrepared.id] }),
      );
      expect(lockedBatch.results[0]).toEqual({ id: opsPrepared.id, ok: true, state: 'Locked' });
      expect(await stateOf(opsPrepared.id)).toBe('Locked');
    });

    it('hides a walled version from everyone outside the wall, commands included', async () => {
      const walled = lockedAt(idOf('walled_deal'));
      await detail('viewer', walled, 404);
      await detail('ops.one', walled, 404);
      await detail('viewer', 'not-a-uuid', 404);
      await command('ops.one', walled, { command: 'reopen', reason: 'Not mine to see' }, 404);
      await command('head.one', 'not-a-uuid', { command: 'reopen', reason: 'Not a row' }, 404);
      const member = await detail('deal.three', walled);
      expect(member.investmentId).toBe(idOf('walled_deal'));
      expect(member.state).toBe('Locked');
      expect(await stateOf(walled)).toBe('Locked');
      // The detail is for every reading role; the admin role is not on it.
      await detail('admin.one', walled, 403);
    });

    it('lists the open change requests of the investment on the detail', async () => {
      const requests = h.dataset.changeRequests ?? [];
      const open = requests.filter((r) => r.state !== 'Applied' && r.state !== 'Rejected');
      expect(open.length).toBeGreaterThan(0);
      const target = open[0]!.investmentId;
      const version = h.dataset.valuations.find((v) => v.investmentId === target)!;
      const seen = await detail('deal.one', version.id);
      const expected = open.filter((r) => r.investmentId === target).map((r) => r.id);
      expect(seen.openChangeRequests.map((r) => r.id).sort()).toEqual([...expected].sort());
      for (const r of seen.openChangeRequests) {
        expect(['Submitted', 'Routed', 'InProgress']).toContain(r.state);
        expect(r.submittedBy.name.length).toBeGreaterThan(0);
        expect(r.investmentId).toBe(target);
      }
      const settled = requests.find((r) => r.state === 'Applied')!;
      const other = h.dataset.valuations.find((v) => v.investmentId === settled.investmentId)!;
      expect(
        (await detail('deal.one', other.id)).openChangeRequests.map((r) => r.id),
      ).not.toContain(settled.id);
      const read = await h.runtime.db.query<{ n: number }>(
        "select count(*)::int as n from audit.event where action = 'valuation.read' and entity_id = $1",
        [version.id],
      );
      expect(read[0]!.n).toBe(1);
    });
  });
});
