import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { InvestmentSummary } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { positionMetrics } from './metrics.js';
import type { FlowRow, ValuationRow } from './metrics.js';

/** The investment row every list, detail and aggregate view starts from. RLS decides what is visible. */
export interface InvestmentBaseRow {
  id: string;
  investmentNumber: string;
  companyName: string;
  sponsorName: string;
  sponsorFundName: string | null;
  vehicleName: string;
  dealType: string;
  entryDate: string;
  exitDate: string | null;
  isActive: boolean;
  sector: string | null;
  geography: string | null;
  vehicleId: string;
  sponsorId: string;
  sponsorFundId: string | null;
  companyId: string;
}

export const INVESTMENT_SELECT = {
  id: schema.investment.id,
  investmentNumber: schema.investment.investmentNumber,
  companyName: schema.portfolioCompany.name,
  sponsorName: schema.sponsor.name,
  sponsorFundName: schema.sponsorFund.name,
  vehicleName: schema.vehicle.name,
  dealType: schema.investment.dealType,
  entryDate: schema.investment.entryDate,
  exitDate: schema.investment.exitDate,
  isActive: schema.investment.isActive,
  sector: schema.portfolioCompany.sector,
  geography: schema.portfolioCompany.geography,
  vehicleId: schema.vehicle.id,
  sponsorId: schema.sponsor.id,
  sponsorFundId: schema.investment.sponsorFundId,
  companyId: schema.portfolioCompany.id,
};

/*
 * Status as of a date, from the entry and exit dates: the is_active column says only how things
 * stand today. A position exists as of a date once entered, and is held until the day it exits.
 */

/** Entered on or before the as-of date: the positions that exist as of it. */
export const enteredBy = (asOf: string): SQL => lte(schema.investment.entryDate, asOf);

/** Held on the as-of date: entered by it and not exited by it. */
export const heldOn = (asOf: string): SQL | undefined =>
  and(
    enteredBy(asOf),
    or(isNull(schema.investment.exitDate), gt(schema.investment.exitDate, asOf)),
  );

/** Exited on or before the as-of date. */
export const realizedBy = (asOf: string): SQL => lte(schema.investment.exitDate, asOf);

/** A row whose isActive says whether it is held on the as-of date rather than today. */
export function asOfStatus(row: InvestmentBaseRow, asOf: string): InvestmentBaseRow {
  return { ...row, isActive: row.exitDate === null || row.exitDate > asOf };
}

/** Visible investments with their company, sponsor, fund and vehicle names, ordered by investment number. */
export async function loadInvestmentRows(
  tx: Tx,
  options: { where?: SQL | undefined; limit?: number | undefined } = {},
): Promise<InvestmentBaseRow[]> {
  const query = tx
    .select(INVESTMENT_SELECT)
    .from(schema.investment)
    .innerJoin(
      schema.portfolioCompany,
      eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
    )
    .innerJoin(schema.sponsor, eq(schema.sponsor.id, schema.investment.sponsorId))
    .innerJoin(schema.vehicle, eq(schema.vehicle.id, schema.investment.vehicleId))
    .leftJoin(schema.sponsorFund, eq(schema.sponsorFund.id, schema.investment.sponsorFundId))
    .where(options.where)
    .orderBy(asc(schema.investment.investmentNumber));
  return options.limit === undefined ? query : query.limit(options.limit);
}

/** Approved cash flows (by date) and every valuation version (by period, version) for a set of investments, batched. */
export async function loadFlowsAndValuations(
  tx: Tx,
  ids: readonly string[],
): Promise<{ flows: Map<string, FlowRow[]>; valuations: Map<string, ValuationRow[]> }> {
  const flows = new Map<string, FlowRow[]>();
  const valuations = new Map<string, ValuationRow[]>();
  if (ids.length === 0) return { flows, valuations };
  const flowRows = await tx
    .select({
      investmentId: schema.cashFlow.investmentId,
      flowDate: schema.cashFlow.flowDate,
      flowType: schema.cashFlow.flowType,
      amount: schema.cashFlow.amount,
    })
    .from(schema.cashFlow)
    .where(
      and(
        inArray(schema.cashFlow.investmentId, [...ids]),
        eq(schema.cashFlow.status, 'record_status.approved'),
      ),
    )
    .orderBy(asc(schema.cashFlow.flowDate));
  for (const f of flowRows) {
    if (f.investmentId === null) continue;
    (flows.get(f.investmentId) ?? flows.set(f.investmentId, []).get(f.investmentId))!.push({
      flowDate: f.flowDate,
      flowType: f.flowType,
      amount: f.amount,
    });
  }
  const valRows = await tx
    .select({
      investmentId: schema.valuation.investmentId,
      periodEnd: schema.valuation.periodEnd,
      version: schema.valuation.version,
      state: schema.valuation.state,
      fairValue: schema.valuation.fairValue,
      method: schema.valuation.method,
    })
    .from(schema.valuation)
    .where(inArray(schema.valuation.investmentId, [...ids]))
    .orderBy(asc(schema.valuation.periodEnd), asc(schema.valuation.version));
  for (const v of valRows) {
    (valuations.get(v.investmentId) ??
      valuations.set(v.investmentId, []).get(v.investmentId))!.push({
      periodEnd: v.periodEnd,
      version: v.version,
      state: v.state,
      fairValue: v.fairValue,
      method: v.method,
    });
  }
  return { flows, valuations };
}

/**
 * The grid row: base columns (with the vehicle and sponsor ids pages link to) plus the calculated
 * position metrics as of a date. The fund and company ids stay with the detail.
 */
export function summarizeInvestment(
  row: InvestmentBaseRow,
  flows: readonly FlowRow[],
  valuations: readonly ValuationRow[],
  asOf: string,
): InvestmentSummary {
  const { sponsorFundId: _f, companyId: _c, ...base } = row;
  return {
    ...base,
    vintage: Number(row.entryDate.slice(0, 4)),
    ...positionMetrics(flows, valuations, asOf, row.isActive),
  };
}

/**
 * Everything the aggregate views need for the visible investments that exist as of a date, loaded
 * in three queries, each row's isActive saying whether it is held on that date.
 */
export async function loadInvestmentsWithMetrics(
  tx: Tx,
  asOf: string,
  where?: SQL,
): Promise<
  {
    row: InvestmentBaseRow;
    summary: InvestmentSummary;
    flows: FlowRow[];
    valuations: ValuationRow[];
  }[]
> {
  const rows = (await loadInvestmentRows(tx, { where: and(enteredBy(asOf), where) })).map((r) =>
    asOfStatus(r, asOf),
  );
  const { flows, valuations } = await loadFlowsAndValuations(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const f = flows.get(row.id) ?? [];
    const v = valuations.get(row.id) ?? [];
    return { row, summary: summarizeInvestment(row, f, v, asOf), flows: f, valuations: v };
  });
}
