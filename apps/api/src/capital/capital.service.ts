import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, lt, lte, ne, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import { addDays } from '@pb/calc';
import type { CapitalNoticeDetail, CapitalNoticePage, capitalNoticeListQuery } from '@pb/contracts';
import { schema } from '@pb/db';
import type { z } from 'zod';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { fmtDate } from '../common/dates.js';
import { configInteger, configIntegerList } from '../common/definitions.js';
import { ProblemError } from '../common/problem.js';
import { DEFINITIONS } from '../common/tokens.js';
import { DbService } from '../db/db.service.js';
import { DUE_ORDER, REGISTER_ORDER, buildNoticeRows } from './notices.js';

export type CapitalNoticeListOptions = Omit<z.infer<typeof capitalNoticeListQuery>, 'asOf'> & {
  asOf: string;
};

/** Capital activity settings from config/definitions.json (docs/04 M16); only the keys this service reads. */
interface Definitions {
  capitalActivity?: { alertDaysBeforeDue?: unknown; wireChangeHoldDays?: unknown };
  [key: string]: unknown;
}

const notice = schema.capitalNotice;

/** The cursor is "dueDate|issueDate|id" of the last row, the register's sort key. */
const CURSOR =
  /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

@Injectable()
export class CapitalService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  /**
   * The capital notice register (M16), latest due date first, with the attention list: every
   * visible notice that is not Reconciled or falls due within the alert window after the as-of
   * date (the largest of capitalActivity.alertDaysBeforeDue), whatever the page and filters.
   * Walls and client entitlements apply through row-level security (SEC-5.1, SEC-5.2, SEC-5.3).
   */
  async list(
    principal: Principal,
    requestId: string,
    opts: CapitalNoticeListOptions,
  ): Promise<CapitalNoticePage> {
    const alertDays = Math.max(
      ...configIntegerList(
        this.definitions.capitalActivity?.alertDaysBeforeDue,
        'capitalActivity.alertDaysBeforeDue',
      ),
    );
    const conditions: (SQL | undefined)[] = [];
    if (opts.cursor !== undefined) {
      const [dueDate = '', issueDate = '', id = ''] = decodeCursor(opts.cursor, CURSOR, [1, 2]);
      // The sort is due date descending, issue date descending, id ascending.
      conditions.push(
        or(
          lt(notice.dueDate, dueDate),
          and(eq(notice.dueDate, dueDate), lt(notice.issueDate, issueDate)),
          and(eq(notice.dueDate, dueDate), eq(notice.issueDate, issueDate), gt(notice.id, id)),
        ),
      );
    }
    if (opts.state !== undefined) conditions.push(eq(notice.state, opts.state));
    if (opts.vehicleId !== undefined) conditions.push(eq(notice.vehicleId, opts.vehicleId));
    if (opts.investmentId !== undefined)
      conditions.push(eq(notice.investmentId, opts.investmentId));
    if (opts.noticeType !== undefined) conditions.push(eq(notice.noticeType, opts.noticeType));
    if (opts.dueFrom !== undefined) conditions.push(gte(notice.dueDate, opts.dueFrom));
    if (opts.dueTo !== undefined) conditions.push(lte(notice.dueDate, opts.dueTo));

    return this.db.run(principal, requestId, async (tx) => {
      const rows = await buildNoticeRows(tx, opts.asOf, and(...conditions), {
        orderBy: REGISTER_ORDER,
        limit: opts.limit + 1,
      });
      const page = rows.slice(0, opts.limit);
      const attention = await buildNoticeRows(
        tx,
        opts.asOf,
        or(
          ne(notice.state, 'Reconciled'),
          and(gte(notice.dueDate, opts.asOf), lte(notice.dueDate, addDays(opts.asOf, alertDays))),
        ),
        { orderBy: DUE_ORDER },
      );
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.dueDate, last.issueDate, last.id])
            : null,
        asOf: opts.asOf,
        attention,
        alertDaysBeforeDue: alertDays,
      };
    });
  }

  /**
   * One notice with the cash flows created from it, the wire change hold (SEC-12.3) and plain
   * notes. Never carries bank details. 404 when the notice does not exist or the caller cannot see
   * it; a successful open is audited (SEC-11.1).
   */
  async detail(
    principal: Principal,
    requestId: string,
    id: string,
    asOf: string,
  ): Promise<CapitalNoticeDetail> {
    const holdDays = configInteger(
      this.definitions.capitalActivity?.wireChangeHoldDays,
      'capitalActivity.wireChangeHoldDays',
    );
    return this.db.run(principal, requestId, async (tx, audit) => {
      const [row] = await buildNoticeRows(tx, asOf, eq(notice.id, id));
      if (row === undefined) throw new ProblemError(404, 'not-found', 'Capital notice not found');
      const flow = schema.cashFlow;
      const cashFlows = await tx
        .select({
          date: flow.flowDate,
          flowType: flow.flowType,
          amount: flow.amount,
          status: flow.status,
        })
        .from(flow)
        .where(eq(flow.sourceNoticeId, row.id))
        .orderBy(asc(flow.flowDate), asc(flow.id));

      const holdUntil = addDays(row.issueDate, holdDays);
      const wireChangeHold =
        row.scenarioTag === 'wire_change' && asOf < holdUntil
          ? { until: holdUntil, holdDays }
          : null;
      const notes: string[] = [];
      if (wireChangeHold !== null)
        notes.push(
          `Wire instructions changed on ${fmtDate(row.issueDate)}; release is held until ${fmtDate(wireChangeHold.until)} (SEC-12.3).`,
        );
      if (row.settledAmount === null)
        notes.push(
          cashFlows.length === 0
            ? 'No cash flow has been recorded for this notice.'
            : 'No approved cash flow has been recorded for this notice.',
        );

      await audit({
        action: 'capital_notice.read',
        entity: 'mon.capital_notice',
        entityId: row.id,
      });
      return { ...row, cashFlows, wireChangeHold, notes };
    });
  }
}
