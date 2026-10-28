import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@pb/adapters';
import { D, addDays, daysBetween, toDecimalString } from '@pb/calc';
import {
  capitalNoticeControlDetail,
  capitalNoticePage,
  commitmentList,
  documentPage,
  investmentDetail,
  problemDetails,
  tradeTicketPage,
  tradeTicketRow,
  weeklyReport,
  wireInstructionDetail,
  wireInstructionPage,
} from '@pb/contracts';
import type {
  CapitalNoticeControlDetail,
  CapitalNoticePage,
  CapitalNoticeRow,
  TradeTicketRow,
  WireInstructionRow,
} from '@pb/contracts';
import { SYSTEM_USER_ID } from '@pb/db';
import { writePdf } from '@pb/pdf';
import { capitalNoticeMachine, forbiddenPairs } from '@pb/workflows';
import { CapitalService } from '../capital/capital.service.js';
import { ProblemError } from '../common/problem.js';
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
  ): Promise<CapitalNoticeControlDetail> =>
    capitalNoticeControlDetail.parse(
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
      await expectProblem('/api/v1/capital-notices?noticeType=call%00', 400, 'validation');
    });

    it('rejects a malformed cursor with 400, including impossible dates and ids', async () => {
      const id = tagged('wire_change').id;
      const forged = [
        'garbage',
        Buffer.from(`2025-07-12|2025-07-10`).toString('base64url'),
        Buffer.from(`2025-07-12|2025-02-30|${id}`).toString('base64url'),
        Buffer.from(`2025-07-12|2025-07-10|not-a-uuid`).toString('base64url'),
        Buffer.from(`2025-07-12|2025-07-10|${id}${String.fromCharCode(0)}`).toString('base64url'),
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
      // The seeded call is issued on the dataset as-of date and falls due two days after it.
      expect(wire!.issueDate).toBe(h.dataset.asOf);
      expect(wire!.daysToDue).toBe(daysBetween(h.dataset.asOf, seededWire.dueDate));
      expect(wire!.daysToDue).toBe(2);
      expect(wire!.settledAmount).toBeNull();
      expect(wire!.split).toEqual({ investment: '2500000.00' });
      expect(wire!.investmentNumber).toBe('INV-0011');

      const open = await detail('viewer', seededWire.id);
      expect(open.cashFlows).toEqual([]);
      const until = addDays(seededWire.issueDate, 30);
      expect(open.wireChangeHold).toEqual({ until, holdDays: 30 });
      expect(until).toBe('2025-07-30');
      expect(open.notes).toEqual([
        'Wire instructions changed on Jun 30, 2025; release is held until Jul 30, 2025 (SEC-12.3).',
        'No cash flow has been recorded for this notice.',
      ]);
      // Never a bank detail: the payload has the contract's keys only, and the active instruction
      // it carries is the masked form (the bank's name and the last four digits, nothing more).
      expect(Object.keys(open).sort()).toEqual(
        Object.keys(capitalNoticeControlDetail.shape).sort(),
      );
      expect(JSON.stringify(open)).not.toMatch(
        /accountNumber|routingCode|iban|swift|account number/i,
      );
      for (const w of h.dataset.wireInstructions!) {
        expect(JSON.stringify(open)).not.toContain(w.bankDetails.accountNumber);
        expect(JSON.stringify(open)).not.toContain(w.bankDetails.routingCode);
      }
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
      // The flow is signed from the investor's side; the settled amount reads like the notice's.
      expect(D(flow!.amount).isNegative()).toBe(true);
      expect(D(open.settledAmount!).equals(D(flow!.amount).abs())).toBe(true);
      expect(D(open.settledAmount!).equals(D(call.amount))).toBe(true);
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
        const flows = flowsOf(n.id).filter(
          (f) => f.status === 'record_status.approved' && f.flowDate <= h.dataset.asOf,
        );
        if (flows.length === 0) expect(n.settledAmount).toBeNull();
        else
          expect(
            D(n.settledAmount!).equals(flows.reduce((acc, f) => acc.plus(f.amount), D('0')).abs()),
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
      expect(seeded(false).length).toBe(185);
      expect(seeded(true).length).toBe(187);
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

  describe('controls: notice commands, trade tickets and alerts (docs/18 section 3, SEC-12, journey 4)', () => {
    const PROBLEM = 'https://portfolio-beach.example/problems/';
    const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
    const APPROVED = 'record_status.approved';
    const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
    const now = (): string => h.runtime.adapters.clock.now();
    const noticeById = (id: string) => h.dataset.capitalNotices.find((n) => n.id === id)!;
    const fundOfNotice = (n: { investmentId: string | null; commitmentId: string | null }) =>
      n.investmentId !== null
        ? h.dataset.investments.find((i) => i.id === n.investmentId)!.sponsorFundId
        : h.dataset.commitments.find((c) => c.id === n.commitmentId)!.sponsorFundId;
    const fundName = (fundId: string) => h.dataset.sponsorFunds.find((f) => f.id === fundId)!.name;
    const get = (who: string, path: string, requestId = 'req-ctl-get') =>
      h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
    const control = async (
      who: string,
      id: string,
      query = '',
      requestId = 'req-ctl-detail',
    ): Promise<CapitalNoticeControlDetail> =>
      capitalNoticeControlDetail.parse(
        (await get(who, `/api/v1/capital-notices/${id}${query}`, requestId).expect(200)).body,
      );
    const command = (
      who: string,
      id: string,
      body: object,
      requestId = 'req-ctl-command',
      ifMatch?: string,
    ) => {
      let req = h
        .http()
        .post(`/api/v1/capital-notices/${id}/commands`)
        .set('authorization', h.as(who))
        .set('x-request-id', requestId);
      if (ifMatch !== undefined) req = req.set('if-match', ifMatch);
      return req.send(body);
    };
    const ok = async (
      who: string,
      id: string,
      body: object,
      requestId?: string,
    ): Promise<CapitalNoticeControlDetail> =>
      capitalNoticeControlDetail.parse((await command(who, id, body, requestId).expect(200)).body);
    const refused = async (
      who: string,
      id: string,
      body: object,
      status: number,
      code: string,
      requestId?: string,
    ) => {
      const res = await command(who, id, body, requestId).expect(status);
      const problem = problemDetails.parse(res.body);
      expect(problem.type, JSON.stringify(body)).toBe(`${PROBLEM}${code}`);
      return problem;
    };
    const wireList = async (who: string, query: string): Promise<WireInstructionRow[]> =>
      wireInstructionPage.parse(
        (await get(who, `/api/v1/wire-instructions${query}`).expect(200)).body,
      ).items;
    const wirePropose = (who: string, body: object, requestId = 'req-ctl-propose') =>
      h
        .http()
        .post('/api/v1/wire-instructions')
        .set('authorization', h.as(who))
        .set('x-request-id', requestId)
        .send(body);
    const wireCommand = (who: string, id: string, body: object) =>
      h
        .http()
        .post(`/api/v1/wire-instructions/${id}/commands`)
        .set('authorization', h.as(who))
        .set('x-request-id', 'req-ctl-wire-command')
        .send(body);
    const tickets = async (who: string, query = '') =>
      tradeTicketPage.parse((await get(who, `/api/v1/trade-tickets${query}`).expect(200)).body);
    const ticketOf = (who: string, id: string, requestId = 'req-ctl-ticket') =>
      get(who, `/api/v1/trade-tickets/${id}`, requestId);
    const walkTickets = async (
      who: string,
      limit: number,
      query = '',
    ): Promise<TradeTicketRow[]> => {
      const rows: TradeTicketRow[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const after: string = cursor === null ? '' : `&cursor=${cursor}`;
        const page = await tickets(who, `?limit=${limit}${query}${after}`);
        rows.push(...page.items);
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 100);
      return rows;
    };
    const sqlRows = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> =>
      h.runtime.db.query<T>(text, params);
    const auditRows = (
      action: string,
      requestId: string,
    ): Promise<{ entity_id: string; reason: string | null; details: Record<string, unknown> }[]> =>
      sqlRows(
        'select entity_id, reason, details from audit.event where action = $1 and request_id = $2 order by id',
        [action, requestId],
      );
    const commitmentsRow = async (commitmentId: string) =>
      commitmentList
        .parse(
          (await get('ops.one', `/api/v1/commitments?asOf=${h.dataset.asOf}`).expect(200)).body,
        )
        .items.find((r) => r.id === commitmentId)!;
    const investedOf = async (investmentId: string): Promise<string | null> =>
      investmentDetail.parse(
        (
          await get('ops.one', `/api/v1/investments/${investmentId}?asOf=${h.dataset.asOf}`).expect(
            200,
          )
        ).body,
      ).invested;
    const insertNotice = async (fields: {
      noticeType: string;
      vehicleId: string;
      investmentId: string | null;
      commitmentId: string | null;
      issueDate: string;
      dueDate: string;
      amount: string;
      state: string;
      sourceDocumentId?: string;
    }): Promise<string> => {
      const [row] = await sqlRows<{ id: string }>(
        `insert into mon.capital_notice
           (notice_type, vehicle_id, investment_id, commitment_id, issue_date, due_date, amount, state, source_document_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8::mon.capital_notice_state, $9)
         returning id`,
        [
          fields.noticeType,
          fields.vehicleId,
          fields.investmentId,
          fields.commitmentId,
          fields.issueDate,
          fields.dueDate,
          fields.amount,
          fields.state,
          fields.sourceDocumentId ?? null,
        ],
      );
      return row!.id;
    };
    const freshDetails = (accountNumber: string) => ({
      bankName: 'Meridian Clearing',
      accountName: 'Synthetic counterparty',
      accountNumber,
      routingCode: '021000021',
    });
    /** A Verified active instruction for the fund, proposing and verifying one when the seed has none. */
    const verifiedFor = async (fundId: string): Promise<void> => {
      const rows = await wireList('ops.one', `?sponsorFundId=${fundId}&limit=200`);
      if (rows.some((r) => r.active)) return;
      const created = wireInstructionDetail.parse(
        (
          await wirePropose('ops.one', {
            sponsorFundId: fundId,
            counterpartyName: fundName(fundId),
            bankDetails: freshDetails('4455667788'),
          }).expect(201)
        ).body,
      );
      await wireCommand('ops.two', created.id, {
        command: 'verify',
        callbackNumberSource: 'prior_instruction',
        callbackResult: 'confirmed',
      }).expect(200);
    };
    const expectNoSecret = (payload: unknown): void => {
      const text = JSON.stringify(payload);
      for (const w of h.dataset.wireInstructions!) {
        expect(text).not.toContain(w.bankDetails.accountNumber);
        expect(text).not.toContain(w.bankDetails.routingCode);
      }
      expect(text).not.toMatch(/accountNumber|routingCode/);
    };
    const systemPrincipal: Principal = {
      userId: SYSTEM_USER_ID,
      externalId: 'system',
      displayName: 'System',
      roles: ['service'],
      clientIds: [],
    };
    const verifyBody = {
      command: 'verify',
      callbackNumberSource: 'sponsor_website',
      callbackResult: 'confirmed',
    };

    it('shows the ticket panel, the active instruction (masked) and the SEC-12.4 alerts on the notice detail', async () => {
      const wc = tagged('wire_change');
      const open = await control('ops.one', wc.id);
      expect(open.state).toBe('Extracted');
      expect(open.ticket).toMatchObject({
        state: 'Drafted',
        amount: wc.amount,
        fundingDate: wc.dueDate,
        approvedBy: null,
        approvedAt: null,
        wireInstruction: null,
        release: { allowed: false, blockers: ['changed_within_hold', 'same_person'] },
      });
      expect(open.ticket!.preparedBy.id).toBe(user('ops.one').id);
      expect((await control('head.one', wc.id)).ticket!.release).toEqual({
        allowed: false,
        blockers: ['changed_within_hold'],
      });
      expect(open.activeWireInstruction).toMatchObject({
        version: 1,
        state: 'Verified',
        active: true,
      });
      expect(open.activeWireInstruction!.bankDetailsMasked).toMatch(/^.+ \*{4}\d{4}$/);
      expect('bankDetails' in open.activeWireInstruction!).toBe(false);
      expect(open.alerts).toEqual(['wire_changed', 'urgency_language']);
      expect(open.wireChangeHold).toEqual({ until: addDays(h.dataset.asOf, 30), holdDays: 30 });
      expectNoSecret(open);

      // Every reader of the notice sees the same notice-level facts, masked.
      const asViewer = await control('viewer.one', wc.id);
      expect(asViewer.activeWireInstruction?.id).toBe(open.activeWireInstruction!.id);
      expect(asViewer.alerts).toEqual(open.alerts);
      expect(asViewer.wireChangeHold).toEqual(open.wireChangeHold);
      expect(asViewer.ticket?.id).toBe(open.ticket!.id);

      // The due date is judged in business days against the as-of date: due on Wednesday, read
      // on Monday is two business days away (no alert), read on Tuesday is one (alert).
      expect(wc.dueDate).toBe(addDays(h.dataset.asOf, 2));
      const soon = await control('ops.one', wc.id, `?asOf=${addDays(h.dataset.asOf, 1)}`);
      expect(soon.alerts).toEqual([
        'wire_changed',
        'urgency_language',
        'due_within_two_business_days',
      ]);

      // A reconciled call of a verified counterparty has nothing to flag.
      const funded = h.dataset.tradeTickets!.find((t) => t.state === 'Funded')!;
      const settled = await control('ops.one', funded.capitalNoticeId);
      expect(settled.alerts).toEqual([]);
      expect(settled.ticket).toMatchObject({
        state: 'Funded',
        release: { allowed: false, blockers: [] },
        wireInstruction: { id: funded.wireInstructionId },
      });
      expect(settled.ticket!.approvedBy!.id).toBe(user('head.one').id);

      // A notice whose counterparty has no instruction at all carries the unverified alert.
      const registered = new Set(h.dataset.wireInstructions!.map((w) => w.sponsorFundId));
      const bare = seeded(false).find((n) => !registered.has(fundOfNotice(n)))!;
      expect((await control('ops.one', bare.id)).alerts).toContain('unverified_instruction');

      await withConfig(setNested('capitalActivity', 'dueSoonBusinessDays', undefined), async () =>
        expectProblem(`/api/v1/capital-notices/${wc.id}`, 500, 'configuration'),
      );
    });

    it('journey 4 over the API: review, draft, the hold, the callback by a second person, dual control, funding, reconciliation', async () => {
      const wc = tagged('wire_change');
      const fund = fundOfNotice(wc)!;
      const seededTicket = h.dataset.tradeTickets!.find((t) => t.capitalNoticeId === wc.id)!;
      const invested0 = await investedOf(wc.investmentId!);

      // review is operations' step; the route guard refuses roles outside the command route.
      await refused('head.one', wc.id, { command: 'review' }, 403, 'forbidden');
      for (const who of ['viewer.one', 'deal.one', 'ir.one', 'audit.one'])
        await command(who, wc.id, { command: 'review' }).expect(403);
      await refused('ops.one', wc.id, { command: 'review', shout: true }, 400, 'validation');
      await refused('ops.one', wc.id, { command: 'sign' }, 400, 'validation');
      const reviewed = await ok('ops.one', wc.id, { command: 'review' }, 'req-j4-review');
      expect(reviewed.state).toBe('Reviewed');
      expect(reviewed.alerts).toEqual(['wire_changed', 'urgency_language']);
      expect((await auditRows('capital_notice.review', 'req-j4-review'))[0]!.details).toMatchObject(
        {
          state: { before: 'Extracted', after: 'Reviewed' },
        },
      );

      // The notice already carries a ticket: draftTicket re-drafts it, never a second one.
      const drafted = await ok(
        'ops.one',
        wc.id,
        { command: 'draftTicket', fundingDate: h.dataset.asOf },
        'req-j4-draft',
      );
      expect(drafted.state).toBe('TicketDrafted');
      expect(drafted.ticket).toMatchObject({
        id: seededTicket.id,
        state: 'Drafted',
        fundingDate: h.dataset.asOf,
        amount: wc.amount,
        preparedAt: now(),
      });
      expect(drafted.ticket!.preparedBy.id).toBe(user('ops.one').id);
      expect(
        (
          await sqlRows<{ n: number }>(
            'select count(*)::int as n from mon.trade_ticket where capital_notice_id = $1',
            [wc.id],
          )
        )[0]!.n,
      ).toBe(1);

      // Dual control and the hold (SEC-12.3): the drafter cannot approve; nobody can while a
      // changed instruction waits for its callback.
      const samePerson = await refused(
        'ops.one',
        wc.id,
        { command: 'approveTicket' },
        422,
        'workflow-precondition',
      );
      expect(samePerson.detail).toContain('preparer cannot approve');
      expect(samePerson.detail).toContain('SEC-12.3');
      const held = await refused(
        'head.one',
        wc.id,
        { command: 'approveTicket' },
        422,
        'workflow-precondition',
      );
      expect(held.detail).toContain('changed recently');
      expect(held.detail).toContain('SEC-12.3');
      expect((await control('head.one', wc.id)).state).toBe('TicketDrafted');

      // The callback by a second person (SEC-12.2) verifies the changed instruction and lifts the hold.
      const [v2] = await wireList('ops.one', `?sponsorFundId=${fund}&state=Proposed`);
      expect(v2).toMatchObject({ version: 2, state: 'Proposed' });
      const ownCallback = problemDetails.parse(
        (await wireCommand('ops.one', v2!.id, verifyBody).expect(422)).body,
      );
      expect(ownCallback.detail).toContain('SEC-12.2');
      await wireCommand('ops.two', v2!.id, verifyBody).expect(200);
      const afterCallback = await control('head.one', wc.id);
      expect(afterCallback.activeWireInstruction).toMatchObject({
        id: v2!.id,
        version: 2,
        state: 'Verified',
        active: true,
      });
      expect(afterCallback.wireChangeHold).toBeNull();
      expect(afterCallback.notes).toEqual(['No cash flow has been recorded for this notice.']);
      expect(afterCallback.ticket!.release).toEqual({ allowed: true, blockers: [] });
      expect(afterCallback.alerts).toEqual(['wire_changed', 'urgency_language']);

      await refused('ops.one', wc.id, { command: 'approveTicket' }, 422, 'workflow-precondition');
      const approved = await ok('head.one', wc.id, { command: 'approveTicket' }, 'req-j4-approve');
      expect(approved.state).toBe('TicketApproved');
      expect(approved.ticket).toMatchObject({
        state: 'Approved',
        approvedAt: now(),
        wireInstruction: { id: v2!.id, version: 2, state: 'Verified' },
        release: { allowed: true, blockers: [] },
      });
      expect(approved.ticket!.approvedBy!.id).toBe(user('head.one').id);
      expect(approved.ticket!.wireInstruction!.bankDetailsMasked).toBe(v2!.bankDetailsMasked);
      const approveEvent = (await auditRows('capital_notice.approveTicket', 'req-j4-approve'))[0]!;
      expect(approveEvent.details).toMatchObject({
        state: { before: 'TicketDrafted', after: 'TicketApproved' },
        ticket: {
          before: { state: 'Drafted', approvedBy: null, wireInstructionId: null },
          after: { state: 'Approved', approvedBy: user('head.one').id, wireInstructionId: v2!.id },
        },
      });
      expectNoSecret(approveEvent);
      const [ticketRow] = await sqlRows<{ updated_by: string; approved_by: string }>(
        'select updated_by, approved_by from mon.trade_ticket where id = $1',
        [seededTicket.id],
      );
      expect(ticketRow).toEqual({
        updated_by: user('head.one').id,
        approved_by: user('head.one').id,
      });
      expect(
        tradeTicketRow.parse((await ticketOf('audit.one', seededTicket.id).expect(200)).body)
          .release,
      ).toEqual({ allowed: true, blockers: [] });

      // A new version proposed while the ticket is approved returns it to draft and flags the notice.
      const v3 = wireInstructionDetail.parse(
        (
          await wirePropose(
            'ops.one',
            {
              sponsorFundId: fund,
              counterpartyName: fundName(fund),
              bankDetails: freshDetails('7788990011'),
              sourceNote: 'A second letter, typed in',
            },
            'req-j4-propose',
          ).expect(201)
        ).body,
      );
      expect(v3.version).toBe(3);
      const back = await control('head.one', wc.id);
      expect(back.state).toBe('TicketDrafted');
      expect(back.ticket).toMatchObject({
        state: 'Drafted',
        approvedBy: null,
        approvedAt: null,
        wireInstruction: null,
        release: { allowed: false, blockers: ['changed_within_hold'] },
      });
      expect(back.wireChangeHold).toEqual({ until: addDays(h.dataset.asOf, 30), holdDays: 30 });
      expect(back.alerts).toContain('wire_changed');
      const changedEvents = await auditRows('capital_notice.wireChanged', 'req-j4-propose');
      expect(changedEvents.length).toBe(1);
      expect(changedEvents[0]!.entity_id).toBe(wc.id);
      expect(changedEvents[0]!.reason).toBe('new wire instruction version proposed');
      expect(changedEvents[0]!.details).toMatchObject({
        state: { before: 'TicketApproved', after: 'TicketDrafted' },
        ticket: {
          before: { state: 'Approved' },
          after: { state: 'Drafted', wireInstructionId: null },
        },
      });
      await refused('head.one', wc.id, { command: 'approveTicket' }, 422, 'workflow-precondition');

      // A change the callback refused is not a change: the active version stands, the hold lifts.
      await wireCommand('ops.two', v3.id, {
        command: 'reject',
        callbackNumberSource: 'known_contact',
        callbackResult: 'not_confirmed',
        reason: 'the sponsor did not recognise the new account',
      }).expect(200);
      expect((await control('head.one', wc.id)).wireChangeHold).toBeNull();
      expect((await ok('head.one', wc.id, { command: 'approveTicket' })).state).toBe(
        'TicketApproved',
      );

      // A person records a wire change with a reason (the service path names its own).
      const noReason = await refused(
        'ops.one',
        wc.id,
        { command: 'wireChanged' },
        422,
        'workflow-precondition',
      );
      expect(noReason.detail).toContain('reason');
      await refused(
        'head.one',
        wc.id,
        { command: 'wireChanged', reason: 'approvers do not' },
        403,
        'forbidden',
      );
      const manual = await ok(
        'ops.one',
        wc.id,
        { command: 'wireChanged', reason: 'The sponsor phoned about a new account' },
        'req-j4-manual',
      );
      expect(manual.state).toBe('TicketDrafted');
      expect(manual.ticket!.state).toBe('Drafted');
      expect((await auditRows('capital_notice.wireChanged', 'req-j4-manual'))[0]!.reason).toBe(
        'The sponsor phoned about a new account',
      );
      expect((await ok('head.one', wc.id, { command: 'approveTicket' })).state).toBe(
        'TicketApproved',
      );

      // Funding is operations' confirmation against the Approved ticket.
      await refused('head.one', wc.id, { command: 'confirmFunding' }, 403, 'forbidden');
      const fundedNotice = await ok(
        'ops.one',
        wc.id,
        { command: 'confirmFunding' },
        'req-j4-funded',
      );
      expect(fundedNotice.state).toBe('Funded');
      expect(fundedNotice.ticket).toMatchObject({
        state: 'Funded',
        release: { allowed: false, blockers: [] },
      });
      expect(fundedNotice.alerts).toEqual(['wire_changed', 'urgency_language']);
      const [fundedRow] = await sqlRows<{ funded_by: string; funded_at: string | null }>(
        'select funded_by, funded_at from mon.capital_notice where id = $1',
        [wc.id],
      );
      expect(fundedRow!.funded_by).toBe(user('ops.one').id);
      expect(fundedRow!.funded_at).not.toBeNull();
      expect(
        (await auditRows('capital_notice.confirmFunding', 'req-j4-funded'))[0]!.details,
      ).toMatchObject({
        state: { before: 'TicketApproved', after: 'Funded' },
        ticket: { before: { state: 'Approved' }, after: { state: 'Funded' } },
      });

      // Reconciliation writes the one approved cash flow, sourced to the notice (rules 5 and 6).
      await refused('head.one', wc.id, { command: 'reconcile' }, 403, 'forbidden');
      const reconciled = await ok(
        'ops.one',
        wc.id,
        { command: 'reconcile', reason: 'Wire confirmed by the bank' },
        'req-j4-reconcile',
      );
      expect(reconciled.state).toBe('Reconciled');
      expect(reconciled.cashFlows).toEqual([
        {
          date: h.dataset.asOf,
          flowType: 'flow_type.contribution',
          amount: '-2500000.00',
          status: APPROVED,
        },
      ]);
      expect(reconciled.settledAmount).toBe('2500000.00');
      expect(reconciled.notes).toEqual([]);
      expect(reconciled.alerts).toEqual(['wire_changed', 'urgency_language']);
      const [flowRow] = await sqlRows<{
        approved_by: string;
        approval_reason: string;
        investment_id: string;
        commitment_id: string | null;
        status: string;
      }>(
        'select approved_by, approval_reason, investment_id, commitment_id, status from mon.cash_flow where source_notice_id = $1',
        [wc.id],
      );
      expect(flowRow).toEqual({
        approved_by: user('ops.one').id,
        approval_reason: 'Wire confirmed by the bank',
        investment_id: wc.investmentId,
        commitment_id: null,
        status: APPROVED,
      });
      const reconcileEvent = (await auditRows('capital_notice.reconcile', 'req-j4-reconcile'))[0]!;
      expect(reconcileEvent.reason).toBe('Wire confirmed by the bank');
      expect(reconcileEvent.details).toMatchObject({
        state: { before: 'Funded', after: 'Reconciled' },
        cashFlow: {
          flowType: 'flow_type.contribution',
          amount: '-2500000',
          flowDate: h.dataset.asOf,
        },
      });
      // The position's invested capital grew by the call: the readers see approved flows only.
      const invested1 = await investedOf(wc.investmentId!);
      expect(
        D(invested1!)
          .minus(invested0 ?? '0')
          .equals(D('2500000')),
      ).toBe(true);
      // Reconciled is terminal.
      await refused('ops.one', wc.id, { command: 'reconcile' }, 409, 'workflow-transition');
      await refused('ops.one', wc.id, { command: 'review' }, 409, 'workflow-transition');
      expectNoSecret(reconciled);
    });

    it('reconciles a commitment call and reduces unfunded by exactly the amount; the equalization sequence stays reconciled and ties', async () => {
      // Both notices of the sequence carry the tag; the credit is the equalization notice itself.
      const eq2 = h.dataset.capitalNotices.find(
        (n) => n.scenarioTag === 'equalization' && n.noticeType === 'notice_type.equalization',
      )!;
      const commitmentId = eq2.commitmentId!;
      const before = await commitmentsRow(commitmentId);
      expect(before.clientName).toBeNull();
      expect(before.unfunded).toBe(
        toDecimalString(D(before.amount).minus(before.called!).plus(before.recallable!)),
      );
      // The equalization credit is the recallable the synthetic sequence booked.
      expect(D(before.recallable!).gte('1000000')).toBe(true);
      const eqDetail = await control('ops.one', eq2.id);
      expect(eqDetail.state).toBe('Reconciled');
      expect(eqDetail.settledAmount).toBe('1000000.00');
      expect(eqDetail.cashFlows.map((f) => f.flowType)).toEqual(['flow_type.recallable']);
      expect(eqDetail.alerts).not.toContain('due_within_two_business_days');

      const fund = fundOfNotice(eq2)!;
      await verifiedFor(fund);
      const id = await insertNotice({
        noticeType: 'notice_type.capital_call',
        vehicleId: eq2.vehicleId,
        investmentId: null,
        commitmentId,
        issueDate: addDays(h.dataset.asOf, -3),
        dueDate: h.dataset.asOf,
        amount: '300000.00',
        state: 'Reviewed',
      });
      const drafted = await ok('ops.one', id, { command: 'draftTicket' });
      expect(drafted.ticket).toMatchObject({ amount: '300000.00', fundingDate: h.dataset.asOf });
      expect((await ok('head.one', id, { command: 'approveTicket' })).state).toBe('TicketApproved');
      expect((await ok('ops.one', id, { command: 'confirmFunding' })).state).toBe('Funded');
      const done = await ok('ops.one', id, { command: 'reconcile' });
      expect(done.state).toBe('Reconciled');
      expect(done.cashFlows).toEqual([
        {
          date: h.dataset.asOf,
          flowType: 'flow_type.contribution',
          amount: '-300000.00',
          status: APPROVED,
        },
      ]);
      expect(done.settledAmount).toBe('300000.00');
      // Reconciling twice can never count the call twice.
      await refused('ops.one', id, { command: 'reconcile' }, 409, 'workflow-transition');

      const after = await commitmentsRow(commitmentId);
      expect(D(before.unfunded!).minus(after.unfunded!).equals(D('300000'))).toBe(true);
      expect(D(after.called!).minus(before.called!).equals(D('300000'))).toBe(true);
      expect(after.recallable).toBe(before.recallable);
      expect(after.unfunded).toBe(
        toDecimalString(D(after.amount).minus(after.called!).plus(after.recallable!)),
      );
    });

    it('trade tickets: the list and the detail follow the notice wall and carry release blockers (SEC-12.3)', async () => {
      for (const who of ['viewer.one', 'ir.one']) {
        await get(who, '/api/v1/trade-tickets').expect(403);
        await ticketOf(who, h.dataset.tradeTickets![0]!.id).expect(403);
      }
      await h.http().get('/api/v1/trade-tickets').expect(401);
      const all = await walkTickets('ops.one', 200);
      const seededTickets = h.dataset.tradeTickets!;
      const walled = seededTickets.filter(
        (t) => noticeById(t.capitalNoticeId).investmentId === walledId(),
      );
      const visible = seededTickets.filter((t) => !walled.includes(t));
      expect(visible.length).toBeGreaterThan(1);
      const ids = all.map((t) => t.id);
      for (const t of visible) expect(ids).toContain(t.id);
      for (const t of walled) {
        expect(ids).not.toContain(t.id);
        await ticketOf('ops.one', t.id).expect(404);
        expect(tradeTicketRow.parse((await ticketOf('deal.three', t.id).expect(200)).body).id).toBe(
          t.id,
        );
      }
      for (let i = 1; i < all.length; i += 1) {
        const a = all[i - 1]!;
        const b = all[i]!;
        expect(
          a.fundingDate > b.fundingDate || (a.fundingDate === b.fundingDate && a.id < b.id),
        ).toBe(true);
      }
      const single = (await tickets('ops.one', '?limit=200')).items.map((t) => t.id);
      expect((await walkTickets('ops.one', 3)).map((t) => t.id)).toEqual(single);
      const fundedOnly = await walkTickets('ops.one', 200, '&state=Funded');
      expect(fundedOnly.length).toBe(all.filter((t) => t.state === 'Funded').length);
      for (const t of all) {
        if (t.state === 'Funded') {
          expect(t.release).toEqual({ allowed: false, blockers: [] });
          expect(t.approvedBy).not.toBeNull();
          expect(t.approvedBy!.id).not.toBe(t.preparedBy.id);
          expect(t.wireInstruction).not.toBeNull();
        }
      }
      expectNoSecret(all);
      expect(JSON.stringify(all)).not.toContain(String.fromCharCode(0x2014));

      await get('ops.one', '/api/v1/trade-tickets?cursor=garbage').expect(400);
      await get('ops.one', '/api/v1/trade-tickets?state=Paid').expect(400);
      await ticketOf('ops.one', NO_SUCH_ID).expect(404);
      await ticketOf('ops.one', 'not-a-uuid').expect(404);
      const opened = visible[0]!;
      await ticketOf('audit.one', opened.id, 'req-ctl-ticket-open').expect(200);
      const reads = await auditRows('trade_ticket.read', 'req-ctl-ticket-open');
      expect(reads.length).toBe(1);
      expect(reads[0]!.entity_id).toBe(opened.id);
    });

    it('extract scans the notice document for urgency language (SEC-12.4); review keeps the flags; a person cannot extract', async () => {
      const index = (requestId: string) =>
        h
          .http()
          .post('/api/v1/documents/index')
          .set('authorization', h.as('ops.one'))
          .set('x-request-id', requestId)
          .expect(200);
      await index('req-ctl-index-1');
      const listDocs = async () =>
        documentPage.parse((await get('ops.one', '/api/v1/documents?limit=200').expect(200)).body)
          .items;
      const callFile = h.documents.documents.find(
        (d) => d.truth.docType === 'doc_type.capital_call',
      )!;
      const calmDoc = (await listDocs()).find((d) => d.fileName === callFile.fileName)!;

      // A notice whose text asks for same-day funds, written into the inbox and indexed.
      writeFileSync(
        join(h.runtime.config.PB_DOCUMENT_ROOT, 'inbox', 'urgent-call-notice.pdf'),
        writePdf({
          title: 'Capital Call Notice',
          pages: [
            {
              items: [
                {
                  kind: 'text',
                  x: 72,
                  y: 700,
                  size: 12,
                  font: 'Helvetica',
                  text: 'URGENT: please remit the amount due immediately.',
                },
              ],
            },
          ],
        }),
      );
      await index('req-ctl-index-2');
      const urgentDoc = (await listDocs()).find((d) => d.fileName === 'urgent-call-notice.pdf')!;

      const wc = tagged('wire_change');
      const received = (sourceDocumentId?: string) =>
        insertNotice({
          noticeType: 'notice_type.capital_call',
          vehicleId: wc.vehicleId,
          investmentId: wc.investmentId,
          commitmentId: null,
          issueDate: addDays(h.dataset.asOf, -1),
          dueDate: addDays(h.dataset.asOf, 5),
          amount: '150000.00',
          state: 'Received',
          ...(sourceDocumentId === undefined ? {} : { sourceDocumentId }),
        });
      const calm = await received(calmDoc.id);
      const loud = await received(urgentDoc.id);
      const blank = await received();

      // The machine names the system actor for extract: a person is refused (403).
      await refused('ops.one', loud, { command: 'extract' }, 403, 'forbidden');
      expect((await control('ops.one', loud)).state).toBe('Received');

      // The service actor cannot sign in (identity.middleware.ts), so the system path is the
      // service method with the system principal, as a worker would call it.
      const service = h.app.get(CapitalService);
      const calmOut = await service.command(systemPrincipal, 'req-ctl-extract-calm', calm, {
        command: 'extract',
      });
      expect(calmOut.state).toBe('Extracted');
      expect(calmOut.alerts).not.toContain('urgency_language');
      const loudOut = await service.command(systemPrincipal, 'req-ctl-extract-loud', loud, {
        command: 'extract',
      });
      expect(loudOut.state).toBe('Extracted');
      expect(loudOut.alerts).toContain('urgency_language');
      expect(
        (await auditRows('capital_notice.extract', 'req-ctl-extract-loud'))[0]!.details,
      ).toMatchObject({
        state: { before: 'Received', after: 'Extracted' },
        urgencyFlag: { before: false, after: true },
      });
      const [flagRow] = await sqlRows<{ urgency_flag: boolean }>(
        'select urgency_flag from mon.capital_notice where id = $1',
        [loud],
      );
      expect(flagRow!.urgency_flag).toBe(true);
      // Neither the text nor the flag reached the log or the event as content.
      expect(
        JSON.stringify(await auditRows('capital_notice.extract', 'req-ctl-extract-loud')),
      ).not.toMatch(/remit|URGENT/);

      // Without an indexed document the notice stays Received (docs/18 section 3).
      let caught: unknown;
      try {
        await service.command(systemPrincipal, 'req-ctl-extract-blank', blank, {
          command: 'extract',
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProblemError);
      expect((caught as ProblemError).getStatus()).toBe(422);
      expect((caught as ProblemError).message).toContain('indexed');
      expect((await control('ops.one', blank)).state).toBe('Received');

      // Review keeps the flags.
      const reviewed = await ok('ops.one', loud, { command: 'review' });
      expect(reviewed.state).toBe('Reviewed');
      expect(reviewed.alerts).toContain('urgency_language');

      // The phrases come from config, never from code.
      const more = await received(urgentDoc.id);
      await withConfig(setNested('capitalActivity', 'urgencyPhrases', undefined), async () => {
        let problem: unknown;
        try {
          await service.command(systemPrincipal, 'req-ctl-extract-noconf', more, {
            command: 'extract',
          });
        } catch (error) {
          problem = error;
        }
        expect(problem).toBeInstanceOf(ProblemError);
        expect((problem as ProblemError).getStatus()).toBe(500);
        expect((problem as ProblemError).code).toBe('configuration');
      });
      expect((await control('ops.one', more)).state).toBe('Received');
    });

    it('rejects every forbidden state and command pair with 409, unseen notices with 404 and a stale If-Match with 412', async () => {
      const wc = tagged('wire_change');
      const scratch = await insertNotice({
        noticeType: 'notice_type.capital_call',
        vehicleId: wc.vehicleId,
        investmentId: wc.investmentId,
        commitmentId: null,
        issueDate: addDays(h.dataset.asOf, -2),
        dueDate: addDays(h.dataset.asOf, 3),
        amount: '100000.00',
        state: 'Received',
      });
      const bodies: Record<string, object> = {
        extract: { command: 'extract' },
        review: { command: 'review' },
        draftTicket: { command: 'draftTicket' },
        approveTicket: { command: 'approveTicket' },
        wireChanged: { command: 'wireChanged', reason: 'a reason for the test' },
        confirmFunding: { command: 'confirmFunding' },
        reconcile: { command: 'reconcile' },
      };
      const pairs = forbiddenPairs(capitalNoticeMachine);
      expect(pairs.length).toBeGreaterThan(30);
      for (const { from, command: cmd } of pairs) {
        await sqlRows(
          'update mon.capital_notice set state = $1::mon.capital_notice_state where id = $2',
          [from, scratch],
        );
        const res = await command('ops.one', scratch, bodies[cmd]!).expect(409);
        expect(problemDetails.parse(res.body).type, `${from} ${cmd}`).toBe(
          `${PROBLEM}workflow-transition`,
        );
        expect(problemDetails.parse(res.body).detail).toContain(
          `${cmd} is not allowed from ${from}`,
        );
      }
      // An allowed pair for the wrong role is the machine's 403.
      await sqlRows(
        'update mon.capital_notice set state = $1::mon.capital_notice_state where id = $2',
        ['Extracted', scratch],
      );
      await refused('head.one', scratch, { command: 'review' }, 403, 'forbidden');
      // Anything the caller cannot see is 404: the walled notice, an unknown id, a malformed id.
      const walledNotice = h.dataset.capitalNotices.find((n) => n.investmentId === walledId())!;
      await command('ops.one', walledNotice.id, { command: 'review' }).expect(404);
      await command('ops.one', NO_SUCH_ID, { command: 'review' }).expect(404);
      await command('ops.one', 'not-a-uuid', { command: 'review' }).expect(404);
      // If-Match: stale is 412, malformed is 400, current writes.
      const current = await control('ops.one', scratch);
      const stale = problemDetails.parse(
        (
          await command(
            'ops.one',
            scratch,
            { command: 'review' },
            'req-ctl-stale',
            `"${current.rowVersion + 5}"`,
          ).expect(412)
        ).body,
      );
      expect(stale.type).toBe(`${PROBLEM}stale-row-version`);
      expect(stale.detail).toContain(`row version ${current.rowVersion}`);
      await command(
        'ops.one',
        scratch,
        { command: 'review' },
        'req-ctl-bad-match',
        'garbage',
      ).expect(400);
      expect((await control('ops.one', scratch)).state).toBe('Extracted');
      const reviewed = capitalNoticeControlDetail.parse(
        (
          await command(
            'ops.one',
            scratch,
            { command: 'review' },
            'req-ctl-match',
            `"${current.rowVersion}"`,
          ).expect(200)
        ).body,
      );
      expect(reviewed.state).toBe('Reviewed');
      expect(reviewed.rowVersion).toBe(current.rowVersion + 1);
    });
  });
});
