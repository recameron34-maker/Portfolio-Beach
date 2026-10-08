import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { daysBetween } from '@pb/calc';
import type { CapitalNoticeRow } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';

const notice = schema.capitalNotice;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** The register order: latest due date first, then latest issue date, then id (the list cursor key). */
export const REGISTER_ORDER: readonly SQL[] = [
  desc(notice.dueDate),
  desc(notice.issueDate),
  asc(notice.id),
];

/** Soonest due date first, then id: the attention list and the weekly report. */
export const DUE_ORDER: readonly SQL[] = [asc(notice.dueDate), asc(notice.id)];

/**
 * The split jsonb as text values, built in Postgres so a JSON number keeps its exact numeric text
 * and never passes through a JS number. Anything other than an object reads as empty.
 */
const SPLIT_TEXT = sql<string | null>`(
  select jsonb_object_agg(e.key, e.value #>> '{}')
  from jsonb_each(case when jsonb_typeof(${notice.split}) = 'object' then ${notice.split} else '{}'::jsonb end) as e
)::text`;

/** The split as a map of decimal strings, keys kept and sorted; an entry that is not an amount is left out, never invented. */
function splitOf(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (text === null) return out;
  const values = JSON.parse(text) as Record<string, unknown>;
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (typeof value === 'string' && DECIMAL.test(value)) out[key] = value;
  }
  return out;
}

export interface NoticeRowOptions {
  /** Sort keys; the register order when omitted. */
  orderBy?: readonly SQL[];
  limit?: number;
}

/**
 * Visible capital notices as contract rows (M16): vehicle, position or fund names, the split as
 * decimal strings, the sum of approved cash flows created from each notice (one batched query; null
 * when none yet, never 0) and whole days from the as-of date to the due date (negative when
 * overdue). Row-level security decides which notices exist for the caller (SEC-5.1, SEC-5.3).
 */
export async function buildNoticeRows(
  tx: Tx,
  asOf: string,
  where?: SQL,
  options: NoticeRowOptions = {},
): Promise<CapitalNoticeRow[]> {
  const query = tx
    .select({
      id: notice.id,
      noticeType: notice.noticeType,
      state: notice.state,
      vehicleId: notice.vehicleId,
      vehicleName: schema.vehicle.name,
      investmentId: notice.investmentId,
      investmentNumber: schema.investment.investmentNumber,
      companyName: schema.portfolioCompany.name,
      commitmentId: notice.commitmentId,
      sponsorFundName: schema.sponsorFund.name,
      issueDate: notice.issueDate,
      dueDate: notice.dueDate,
      amount: notice.amount,
      currency: notice.currency,
      split: SPLIT_TEXT,
      scenarioTag: notice.scenarioTag,
      rowVersion: notice.rowVersion,
    })
    .from(notice)
    .innerJoin(schema.vehicle, eq(schema.vehicle.id, notice.vehicleId))
    .leftJoin(schema.investment, eq(schema.investment.id, notice.investmentId))
    .leftJoin(
      schema.portfolioCompany,
      eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
    )
    .leftJoin(schema.commitment, eq(schema.commitment.id, notice.commitmentId))
    .leftJoin(schema.sponsorFund, eq(schema.sponsorFund.id, schema.commitment.sponsorFundId))
    .where(where)
    .orderBy(...(options.orderBy ?? REGISTER_ORDER));
  const notices = await (options.limit === undefined ? query : query.limit(options.limit));
  if (notices.length === 0) return [];

  const flow = schema.cashFlow;
  const settledRows = await tx
    .select({ noticeId: flow.sourceNoticeId, total: sql<string>`sum(${flow.amount})::text` })
    .from(flow)
    .where(
      and(
        inArray(
          flow.sourceNoticeId,
          notices.map((n) => n.id),
        ),
        eq(flow.status, 'record_status.approved'),
      ),
    )
    .groupBy(flow.sourceNoticeId);
  const settled = new Map<string, string>();
  for (const r of settledRows) if (r.noticeId !== null) settled.set(r.noticeId, r.total);

  return notices.map((n) => ({
    id: n.id,
    noticeType: n.noticeType,
    state: n.state,
    vehicleId: n.vehicleId,
    vehicleName: n.vehicleName,
    investmentId: n.investmentId,
    investmentNumber: n.investmentNumber,
    companyName: n.companyName,
    commitmentId: n.commitmentId,
    sponsorFundName: n.sponsorFundName,
    issueDate: n.issueDate,
    dueDate: n.dueDate,
    amount: n.amount,
    currency: n.currency,
    split: splitOf(n.split),
    scenarioTag: n.scenarioTag,
    settledAmount: settled.get(n.id) ?? null,
    daysToDue: daysBetween(asOf, n.dueDate),
    rowVersion: n.rowVersion,
  }));
}
