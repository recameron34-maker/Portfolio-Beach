import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, addDays, daysBetween } from '@pb/calc';
import {
  capitalNoticeDetail,
  capitalNoticePage,
  problemDetails,
  weeklyReport,
} from '@pb/contracts';
import type { CapitalNoticeDetail, CapitalNoticePage, CapitalNoticeRow } from '@pb/contracts';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

describe('capital activity (M16)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const list = async (who: string, query = ''): Promise<CapitalNoticePage> =>
    capitalNoticePage.parse(
      (
        await h
          .http()
          .get(`/api/v1/capital-notices${query}`)
          .set('authorization', h.as(who))
          .expect(200)
      ).body,
    );
  const detail = async (
    who: string,
    id: string,
    query = '',
    requestId = 'req-notice-detail',
  ): Promise<CapitalNoticeDetail> =>
    capitalNoticeDetail.parse(
      (
        await h
          .http()
          .get(`/api/v1/capital-notices/${id}${query}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );

  /** Every notice the caller can see for a query, following nextCursor page by page. */
  const walk = async (
    who: string,
    limit: number,
    query = '',
  ): Promise<{ rows: CapitalNoticeRow[]; pages: number }> => {
    const rows: CapitalNoticeRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const after: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page = await list(who, `?limit=${limit}${query}${after}`);
      rows.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 100);
    return { rows, pages };
  };

  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  /** Seeded notices a reader can see (only the walled position's notices are hidden in the seed). */
  const seeded = (wallMember: boolean) =>
    h.dataset.capitalNotices.filter((n) => wallMember || n.investmentId !== walledId());
  const tagged = (tag: string) => h.dataset.capitalNotices.find((n) => n.scenarioTag === tag)!;
  const flowsOf = (noticeId: string) =>
    h.dataset.cashFlows.filter((f) => f.sourceNoticeId === noticeId);
  /** The register order: due date descending, issue date descending, id ascending. */
  const inRegisterOrder = (a: CapitalNoticeRow, b: CapitalNoticeRow): boolean => {
    if (a.dueDate !== b.dueDate) return a.dueDate > b.dueDate;
    if (a.issueDate !== b.issueDate) return a.issueDate > b.issueDate;
    return a.id < b.id;
  };
  const auditCount = async (action: string, requestId: string): Promise<number> => {
    const rows = await h.runtime.db.query<{ n: number }>(
      `select count(*)::int as n from audit.event where action = '${action}' and request_id = '${requestId}'`,
    );
    return rows[0]?.n ?? -1;
  };
  const withConfig = async (
    mutate: (definitions: Record<string, unknown>) => () => void,
    run: () => Promise<void>,
  ): Promise<void> => {
    const restore = mutate(h.runtime.definitions);
    try {
      await run();
    } finally {
      restore();
    }
  };
  /** Replaces one key of a nested config section for the duration of a test. */
  const setNested =
    (section: string, key: string, value: unknown) =>
    (d: Record<string, unknown>): (() => void) => {
      const target = d[section] as Record<string, unknown>;
      const had = Object.hasOwn(target, key);
      const saved = target[key];
      if (value === undefined) delete target[key];
      else target[key] = value;
      return () => {
        if (had) target[key] = saved;
        else delete target[key];
      };
    };
  const expectProblem = async (path: string, status: number, code: string): Promise<void> => {
    const res = await h.http().get(path).set('authorization', h.as('operations')).expect(status);
    expect(problemDetails.parse(res.body).type).toMatch(new RegExp(`/${code}$`));
  };

  describe('request handling (docs/17 section 3)', () => {
    it('requires authentication, defaults the as-of date to the clock and rejects unknown keys', async () => {
      await h.http().get('/api/v1/capital-notices').expect(401);
      await h
        .http()
        .get(`/api/v1/capital-notices/${tagged('wire_change').id}`)
        .expect(401);
      const page = await list('viewer');
      expect(page.asOf).toBe(h.dataset.asOf);
      expect(page.items.length).toBe(50);
      expect(page.alertDaysBeforeDue).toBe(3);
      await expectProblem('/api/v1/capital-notices?bank=1', 400, 'validation');
      await expectProblem('/api/v1/capital-notices?state=Paid', 400, 'validation');
      await expectProblem('/api/v1/capital-notices?dueFrom=July', 400, 'validation');
    });

    it('rejects a malformed cursor with 400, including impossible dates and ids', async () => {
      const id = tagged('wire_change').id;
      const forged = [
        'garbage',
        Buffer.from(`2025-07-12|2025-07-10`).toString('base64url'),
        Buffer.from(`2025-07-12|2025-02-30|${id}`).toString('base64url'),
        Buffer.from(`2025-07-12|2025-07-10|not-a-uuid`).toString('base64url'),
      ];
      for (const cursor of forged) {
        const res = await h
          .http()
          .get(`/api/v1/capital-notices?cursor=${cursor}`)
          .set('authorization', h.as('viewer'))
          .expect(400);
        expect(problemDetails.parse(res.body).detail).toBe('Invalid cursor');
      }
    });

    it('returns 404 for a malformed or unknown id and audits only successful opens', async () => {
      await h
        .http()
        .get('/api/v1/capital-notices/not-a-uuid')
        .set('authorization', h.as('viewer'))
        .set('x-request-id', 'req-notice-404a')
        .expect(404);
      await h
        .http()
        .get('/api/v1/capital-notices/00000000-0000-4000-8000-000000000000')
        .set('authorization', h.as('viewer'))
        .set('x-request-id', 'req-notice-404b')
        .expect(404);
      expect(await auditCount('capital_notice.read', 'req-notice-404a')).toBe(0);
      expect(await auditCount('capital_notice.read', 'req-notice-404b')).toBe(0);
      await list('viewer', '?limit=5');
      const opened = tagged('wire_change').id;
      await detail('viewer', opened, '', 'req-notice-open-1');
      expect(await auditCount('capital_notice.read', 'req-notice-open-1')).toBe(1);
      const row = await h.runtime.db.query<{ entity: string; entity_id: string }>(
        "select entity, entity_id from audit.event where request_id = 'req-notice-open-1'",
      );
      expect(row[0]).toEqual({ entity: 'mon.capital_notice', entity_id: opened });
    });

    it('reports missing capital activity settings as configuration problems, never defaults', async () => {
      const id = tagged('wire_change').id;
      await withConfig(setNested('capitalActivity', 'alertDaysBeforeDue', undefined), async () =>
        expectProblem('/api/v1/capital-notices', 500, 'configuration'),
      );
      await withConfig(setNested('capitalActivity', 'alertDaysBeforeDue', []), async () =>
        expectProblem('/api/v1/capital-notices', 500, 'configuration'),
      );
      await withConfig(setNested('capitalActivity', 'alertDaysBeforeDue', [3, 'one']), async () =>
        expectProblem('/api/v1/capital-notices', 500, 'configuration'),
      );
      await withConfig(setNested('capitalActivity', 'wireChangeHoldDays', undefined), async () =>
        expectProblem(`/api/v1/capital-notices/${id}`, 500, 'configuration'),
      );
      await withConfig(setNested('reporting', 'capitalActivityWindowDays', undefined), async () =>
        expectProblem('/api/v1/reports/weekly', 500, 'configuration'),
      );
      await withConfig(setNested('reporting', 'capitalActivityWindowDays', 2.5), async () =>
        expectProblem('/api/v1/reports/weekly', 500, 'configuration'),
      );
      // Restored settings serve again.
      await list('viewer', '?limit=1');
      await detail('viewer', id);
    });
  });

  describe('scenario notices', () => {
    it('holds the wire change call: in attention, no cash flow yet, release held (SEC-12.3)', async () => {
      const seededWire = tagged('wire_change');
      const page = await list('viewer');
      const wire = page.attention.find((n) => n.scenarioTag === 'wire_change');
      expect(wire).toBeDefined();
      expect(wire!.id).toBe(seededWire.id);
      expect(wire!.state).toBe('Extracted');
      expect(wire!.noticeType).toBe('notice_type.capital_call');
      expect(D(wire!.amount).equals(D('2500000'))).toBe(true);
      expect(wire!.issueDate).toBe(seededWire.issueDate);
      expect(wire!.dueDate).toBe(seededWire.dueDate);
      // The seeded call is issued after the dataset as-of date and falls due 12 days after it.
      expect(wire!.issueDate > h.dataset.asOf).toBe(true);
      expect(wire!.daysToDue).toBe(daysBetween(h.dataset.asOf, seededWire.dueDate));
      expect(wire!.daysToDue).toBe(12);
      expect(wire!.settledAmount).toBeNull();
      expect(wire!.split).toEqual({ investment: '2500000.00' });
      expect(wire!.investmentNumber).toBe('INV-0011');

      const open = await detail('viewer', seededWire.id);
      expect(open.cashFlows).toEqual([]);
      const until = addDays(seededWire.issueDate, 30);
      expect(open.wireChangeHold).toEqual({ until, holdDays: 30 });
      expect(until).toBe('2025-08-09');
      expect(open.notes).toEqual([
        'Wire instructions changed on Jul 10, 2025; release is held until Aug 9, 2025 (SEC-12.3).',
        'No cash flow has been recorded for this notice.',
      ]);
      // Never a bank detail: the payload has the contract's keys only.
      expect(Object.keys(open).sort()).toEqual(Object.keys(capitalNoticeDetail.shape).sort());
      expect(JSON.stringify(open)).not.toMatch(/iban|swift|routing|account number|bank/i);
      expect(JSON.stringify(open)).not.toContain(String.fromCharCode(0x2014));

      // On or after the hold end the hold is gone and the note with it.
      const later = await detail('viewer', seededWire.id, `?asOf=${until}`);
      expect(later.wireChangeHold).toBeNull();
      expect(later.daysToDue).toBe(daysBetween(until, seededWire.dueDate));
      expect(later.notes).toEqual(['No cash flow has been recorded for this notice.']);
    });

    it('shows the reviewed prepayment with no settlement and its split', async () => {
      const seededPrepayment = tagged('credit_prepayment');
      const open = await detail('viewer', seededPrepayment.id);
      expect(open.state).toBe('Reviewed');
      expect(open.noticeType).toBe('notice_type.principal_repayment');
      expect(open.settledAmount).toBeNull();
      expect(open.cashFlows).toEqual([]);
      expect(open.wireChangeHold).toBeNull();
      expect(open.notes).toEqual(['No cash flow has been recorded for this notice.']);
      expect(open.split).toEqual(seededPrepayment.split);
      expect(Object.keys(open.split)).toEqual(['premium', 'principal']);
      expect(D(open.split.principal!).plus(open.split.premium!).equals(D(open.amount))).toBe(true);
    });

    it('settles a Reconciled call at its cash flow and lists that flow', async () => {
      const call = h.dataset.capitalNotices.find(
        (n) =>
          n.state === 'Reconciled' &&
          n.noticeType === 'notice_type.capital_call' &&
          n.investmentId !== null &&
          n.investmentId !== walledId() &&
          flowsOf(n.id).length === 1,
      )!;
      const [flow] = flowsOf(call.id);
      const open = await detail('viewer', call.id);
      expect(open.settledAmount).not.toBeNull();
      expect(D(open.settledAmount!).equals(D(flow!.amount))).toBe(true);
      expect(D(open.settledAmount!).isNegative()).toBe(true);
      expect(open.cashFlows).toEqual([
        {
          date: flow!.flowDate,
          flowType: flow!.flowType,
          amount: flow!.amount,
          status: flow!.status,
        },
      ]);
      expect(open.notes).toEqual([]);
      expect(open.wireChangeHold).toBeNull();
    });

    it('keeps split keys and exact amounts, sums settlements and names the fund or company', async () => {
      const { rows } = await walk('operations', 200);
      const equalization = rows.find((n) => n.noticeType === 'notice_type.equalization')!;
      expect(equalization.split).toEqual({ equalization: '950000.00', interest: '50000.00' });
      expect(equalization.sponsorFundName).not.toBeNull();
      for (const n of rows) {
        expect(n.split).toEqual(h.dataset.capitalNotices.find((x) => x.id === n.id)!.split);
        expect(Object.keys(n.split)).toEqual(Object.keys(n.split).sort());
        const flows = flowsOf(n.id).filter((f) => f.status === 'record_status.approved');
        if (flows.length === 0) expect(n.settledAmount).toBeNull();
        else
          expect(
            D(n.settledAmount!).equals(flows.reduce((acc, f) => acc.plus(f.amount), D('0'))),
          ).toBe(true);
        if (n.investmentId === null) {
          expect(n.commitmentId).not.toBeNull();
          expect(n.sponsorFundName).not.toBeNull();
          expect(n.companyName).toBeNull();
        } else {
          expect(n.investmentNumber).toMatch(/^INV-\d{4}$/);
          expect(n.companyName).not.toBeNull();
        }
      }
    });
  });

  describe('register, attention list and walls (SEC-5.1, SEC-5.3)', () => {
    it('walks every visible notice at limit 100 without duplicates, in register order', async () => {
      for (const [who, member] of [
        ['viewer.one', false],
        ['deal.three', true],
      ] as const) {
        const { rows, pages } = await walk(who, 100);
        const expected = seeded(member);
        expect(rows.length).toBe(expected.length);
        expect(new Set(rows.map((n) => n.id))).toEqual(new Set(expected.map((n) => n.id)));
        expect(pages).toBe(Math.ceil(expected.length / 100));
        for (let i = 1; i < rows.length; i += 1)
          expect(inRegisterOrder(rows[i - 1]!, rows[i]!), `row ${i}`).toBe(true);
        for (const n of rows) expect(n.daysToDue).toBe(daysBetween(h.dataset.asOf, n.dueDate));
      }
      expect(seeded(false).length).toBe(186);
      expect(seeded(true).length).toBe(188);
    });

    it('breaks every tie in the cursor key: small pages reproduce the single-page order', async () => {
      // Many notices share a due date and an issue date, so the id decides at page boundaries.
      const single = (await list('viewer', '?limit=200')).items.map((n) => n.id);
      expect((await walk('viewer', 7)).rows.map((n) => n.id)).toEqual(single);
    });

    it('never shows the walled position to non-members, in the list, the filter or the detail', async () => {
      const walledNotices = h.dataset.capitalNotices.filter((n) => n.investmentId === walledId());
      expect(walledNotices.length).toBeGreaterThan(0);
      const { rows } = await walk('viewer.one', 200);
      for (const n of walledNotices) expect(rows.map((r) => r.id)).not.toContain(n.id);
      const filtered = await list('viewer.one', `?investmentId=${walledId()}`);
      expect(filtered.items).toEqual([]);
      for (const n of walledNotices) {
        await h
          .http()
          .get(`/api/v1/capital-notices/${n.id}`)
          .set('authorization', h.as('viewer.one'))
          .expect(404);
        const open = await detail('deal.three', n.id);
        expect(open.investmentId).toBe(walledId());
      }
      const member = await list('deal.three', `?investmentId=${walledId()}`);
      expect(member.items.map((n) => n.id).sort()).toEqual(walledNotices.map((n) => n.id).sort());
    });

    it('lists the notices needing attention, soonest first, whatever the page and filters', async () => {
      const window = addDays(h.dataset.asOf, 3);
      const expected = seeded(false)
        .filter(
          (n) => n.state !== 'Reconciled' || (n.dueDate >= h.dataset.asOf && n.dueDate <= window),
        )
        .sort((a, b) =>
          a.dueDate === b.dueDate ? (a.id < b.id ? -1 : 1) : a.dueDate < b.dueDate ? -1 : 1,
        )
        .map((n) => n.id);
      const plain = await list('viewer');
      const filtered = await list('viewer', '?state=Reconciled&limit=1');
      expect(plain.attention.map((n) => n.id)).toEqual(expected);
      expect(filtered.attention).toEqual(plain.attention);
      const states = plain.attention.map((n) => n.state);
      expect(states).toContain('Extracted');
      expect(states).toContain('Reviewed');
      expect(plain.attention.length).toBe(4);
      for (const n of plain.attention)
        if (n.state === 'Reconciled') expect(n.daysToDue >= 0 && n.daysToDue <= 3).toBe(true);
    });

    it('filters by state, vehicle, investment, notice type and due dates', async () => {
      const visible = seeded(false);
      const idsOf = (rows: readonly CapitalNoticeRow[]) => rows.map((n) => n.id).sort();
      const expectIds = (rows: readonly CapitalNoticeRow[], want: typeof visible) =>
        expect(idsOf(rows)).toEqual(want.map((n) => n.id).sort());

      expectIds(
        (await walk('viewer', 200, '&state=Reviewed')).rows,
        visible.filter((n) => n.state === 'Reviewed'),
      );
      expectIds(
        (await walk('viewer', 200, '&state=Reconciled')).rows,
        visible.filter((n) => n.state === 'Reconciled'),
      );

      const credit = h.dataset.vehicles.find(
        (v) => v.vehicleType === 'vehicle_type.private_credit',
      )!;
      const byVehicle = (await walk('viewer', 200, `&vehicleId=${credit.id}`)).rows;
      expectIds(
        byVehicle,
        visible.filter((n) => n.vehicleId === credit.id),
      );
      for (const n of byVehicle) expect(n.vehicleName).toBe(credit.name);

      const credited = tagged('credit_prepayment').investmentId!;
      expectIds(
        (await walk('viewer', 200, `&investmentId=${credited}`)).rows,
        visible.filter((n) => n.investmentId === credited),
      );

      expectIds(
        (await walk('viewer', 200, '&noticeType=notice_type.interest_payment')).rows,
        visible.filter((n) => n.noticeType === 'notice_type.interest_payment'),
      );
      expect((await list('viewer', '?noticeType=interest_payment')).items).toEqual([]);

      const between = (await walk('viewer', 200, '&dueFrom=2025-01-01&dueTo=2025-03-31')).rows;
      expectIds(
        between,
        visible.filter((n) => n.dueDate >= '2025-01-01' && n.dueDate <= '2025-03-31'),
      );
      expect(between.length).toBeGreaterThan(0);
    });

    it('feeds the weekly report the same rows as the register (shared builder)', async () => {
      const report = weeklyReport.parse(
        (
          await h
            .http()
            .get('/api/v1/reports/weekly')
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      const { rows } = await walk('operations', 200);
      const byId = new Map(rows.map((n) => [n.id, n]));
      expect(report.capitalActivity.length).toBeGreaterThan(0);
      for (const n of report.capitalActivity) expect(n).toEqual(byId.get(n.id));
    });
  });
});
