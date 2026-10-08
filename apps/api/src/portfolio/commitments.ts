import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { summarizeFlows, unfunded } from '@pb/calc';
import type { TypedCashFlow } from '@pb/calc';
import type { FundCommitmentRow } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { kindOf, str } from './metrics.js';
import { compareText } from '../common/order.js';

/** Pooled rows (no client) sort ahead of client-directed rows of the same vehicle and fund. */
const compareClientName = (a: string | null, b: string | null): number => {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return compareText(a, b);
};

/**
 * Approved, commitment-keyed cash flows (investment_id is null) on or before the as-of date for a
 * set of commitments, oldest first, in one query. Row-level security on mon.cash_flow follows the
 * commitment's visibility.
 */
async function loadCommitmentFlows(
  tx: Tx,
  ids: readonly string[],
  asOf: string,
): Promise<Map<string, TypedCashFlow[]>> {
  const out = new Map<string, TypedCashFlow[]>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      commitmentId: schema.cashFlow.commitmentId,
      flowDate: schema.cashFlow.flowDate,
      flowType: schema.cashFlow.flowType,
      amount: schema.cashFlow.amount,
    })
    .from(schema.cashFlow)
    .where(
      and(
        inArray(schema.cashFlow.commitmentId, [...ids]),
        isNull(schema.cashFlow.investmentId),
        eq(schema.cashFlow.status, 'record_status.approved'),
        lte(schema.cashFlow.flowDate, asOf),
      ),
    )
    .orderBy(asc(schema.cashFlow.flowDate), asc(schema.cashFlow.id));
  for (const f of rows) {
    if (f.commitmentId === null) continue;
    const flow: TypedCashFlow = { date: f.flowDate, kind: kindOf(f.flowType), amount: f.amount };
    const list = out.get(f.commitmentId);
    if (list === undefined) out.set(f.commitmentId, [flow]);
    else list.push(flow);
  }
  return out;
}

/**
 * Vehicle-to-fund commitments the caller can see (core.commitment under RLS: pooled rows for
 * every authenticated user, client-directed rows for callers entitled to that client, SEC-5.2),
 * narrowed by an optional condition over the commitment, its vehicle, sponsor fund or sponsor,
 * with what the approved commitment-keyed cash flows on or before the as-of date say was called,
 * distributed and recalled, and the unfunded balance from @pb/calc (docs/08 section 2). The one
 * loader behind the vehicle detail, the commitments board and the sponsor 360.
 *
 * A commitment without an approved flow on or before the as-of date is not calculable: its four
 * figures are null, never 0 (docs/06 section 3), the same rule as a position's invested capital.
 * The numbers are shown as recorded: a commitment called beyond its amount (the equalization
 * scenario books its call to a primary commitment) reads as over-called. Ordered by vehicle,
 * sponsor, fund and client name (pooled rows first), then id, so a response is byte-stable.
 */
export async function loadCommitmentRows(
  tx: Tx,
  asOf: string,
  where?: SQL,
): Promise<FundCommitmentRow[]> {
  const c = schema.commitment;
  const rows = await tx
    .select({
      id: c.id,
      vehicleId: c.vehicleId,
      vehicleName: schema.vehicle.name,
      vehicleType: schema.vehicle.vehicleType,
      sponsorId: schema.sponsor.id,
      sponsorName: schema.sponsor.name,
      sponsorFundId: schema.sponsorFund.id,
      sponsorFundName: schema.sponsorFund.name,
      vintage: schema.sponsorFund.vintage,
      strategy: schema.sponsorFund.strategy,
      clientName: schema.client.name,
      amount: c.amount,
      commitmentDate: c.commitmentDate,
    })
    .from(c)
    .innerJoin(schema.vehicle, eq(schema.vehicle.id, c.vehicleId))
    .innerJoin(schema.sponsorFund, eq(schema.sponsorFund.id, c.sponsorFundId))
    .innerJoin(schema.sponsor, eq(schema.sponsor.id, schema.sponsorFund.sponsorId))
    .leftJoin(schema.client, eq(schema.client.id, c.clientId))
    .where(where);
  const flows = await loadCommitmentFlows(
    tx,
    rows.map((r) => r.id),
    asOf,
  );
  return rows
    .sort(
      (a, b) =>
        compareText(a.vehicleName, b.vehicleName) ||
        compareText(a.sponsorName, b.sponsorName) ||
        compareText(a.sponsorFundName, b.sponsorFundName) ||
        compareClientName(a.clientName, b.clientName) ||
        compareText(a.id, b.id),
    )
    .map((r) => {
      const typed = flows.get(r.id);
      if (typed === undefined) {
        return { ...r, called: null, distributed: null, recallable: null, unfunded: null };
      }
      const summary = summarizeFlows(typed);
      return {
        ...r,
        called: str(summary.contributions),
        distributed: str(summary.distributions),
        recallable: str(summary.recallable),
        unfunded: str(unfunded(r.amount, summary.contributions, summary.recallable)),
      };
    });
}
