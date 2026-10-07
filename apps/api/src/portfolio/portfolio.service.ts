import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import type { InvestmentDetail, InvestmentPage, InvestmentSummary } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { DEFINITIONS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { creditView, operatingView, positionMetrics } from './metrics.js';
import type { FlowRow, ValuationRow } from './metrics.js';

export interface ListOptions {
  limit: number;
  cursor?: string | undefined;
  vehicleId?: string | undefined;
  dealType?: string | undefined;
  active?: 'true' | 'false' | undefined;
  asOf: string;
}

interface Definitions {
  priorYearPeriodEndToleranceDays?: number;
}

const encodeCursor = (investmentNumber: string): string =>
  Buffer.from(investmentNumber, 'utf8').toString('base64url');
const decodeCursor = (cursor: string): string => {
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[A-Z0-9-]{1,32}$/.test(value)) throw new ProblemError(400, 'validation', 'Invalid cursor');
  return value;
};

interface BaseRow {
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
}

/**
 * Fully qualified outer-table columns for correlated subqueries. In a single-table select Drizzle
 * renders a column as a bare `"id"`, which inside the subquery would bind to the inner table.
 */
const OUTER_SPONSOR_ID = sql.raw('"core"."sponsor"."id"');
const OUTER_VEHICLE_ID = sql.raw('"core"."vehicle"."id"');

const baseSelect = {
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
};

@Injectable()
export class PortfolioService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  private async loadFlowsAndValuations(
    tx: Tx,
    ids: string[],
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
          inArray(schema.cashFlow.investmentId, ids),
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
      .where(inArray(schema.valuation.investmentId, ids))
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

  private summarize(
    row: BaseRow,
    flows: FlowRow[],
    valuations: ValuationRow[],
    asOf: string,
  ): InvestmentSummary {
    return { ...row, ...positionMetrics(flows, valuations, asOf, row.isActive) };
  }

  async list(principal: Principal, requestId: string, opts: ListOptions): Promise<InvestmentPage> {
    return this.db.run(principal, requestId, async (tx) => {
      const conditions = [];
      if (opts.cursor !== undefined)
        conditions.push(gt(schema.investment.investmentNumber, decodeCursor(opts.cursor)));
      if (opts.vehicleId !== undefined)
        conditions.push(eq(schema.investment.vehicleId, opts.vehicleId));
      if (opts.dealType !== undefined)
        conditions.push(eq(schema.investment.dealType, opts.dealType));
      if (opts.active !== undefined)
        conditions.push(eq(schema.investment.isActive, opts.active === 'true'));
      const rows = await tx
        .select(baseSelect)
        .from(schema.investment)
        .innerJoin(
          schema.portfolioCompany,
          eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
        )
        .innerJoin(schema.sponsor, eq(schema.sponsor.id, schema.investment.sponsorId))
        .innerJoin(schema.vehicle, eq(schema.vehicle.id, schema.investment.vehicleId))
        .leftJoin(schema.sponsorFund, eq(schema.sponsorFund.id, schema.investment.sponsorFundId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(schema.investment.investmentNumber))
        .limit(opts.limit + 1);
      const page = rows.slice(0, opts.limit);
      const { flows, valuations } = await this.loadFlowsAndValuations(
        tx,
        page.map((r) => r.id),
      );
      const items = page.map((r) =>
        this.summarize(r, flows.get(r.id) ?? [], valuations.get(r.id) ?? [], opts.asOf),
      );
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor(last.investmentNumber)
            : null,
        asOf: opts.asOf,
      };
    });
  }

  /** 404 for anything the caller cannot see (docs/17 section 3); a successful open is an audited sensitive read (SEC-11.1). */
  async detail(
    principal: Principal,
    requestId: string,
    id: string,
    asOf: string,
  ): Promise<InvestmentDetail> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const rows = await tx
        .select({
          ...baseSelect,
          companyId: schema.portfolioCompany.id,
          sponsorId: schema.sponsor.id,
          vehicleId: schema.vehicle.id,
          sector: schema.portfolioCompany.sector,
          geography: schema.portfolioCompany.geography,
        })
        .from(schema.investment)
        .innerJoin(
          schema.portfolioCompany,
          eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
        )
        .innerJoin(schema.sponsor, eq(schema.sponsor.id, schema.investment.sponsorId))
        .innerJoin(schema.vehicle, eq(schema.vehicle.id, schema.investment.vehicleId))
        .leftJoin(schema.sponsorFund, eq(schema.sponsorFund.id, schema.investment.sponsorFundId))
        .where(eq(schema.investment.id, id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) throw new ProblemError(404, 'not-found', 'Investment not found');
      const { flows, valuations } = await this.loadFlowsAndValuations(tx, [row.id]);
      const summary = this.summarize(
        row,
        flows.get(row.id) ?? [],
        valuations.get(row.id) ?? [],
        asOf,
      );
      const tolerance = this.definitions.priorYearPeriodEndToleranceDays ?? 7;

      const operatingRows = await tx
        .select({
          periodEnd: schema.quarterlyPerformance.periodEnd,
          status: schema.quarterlyPerformance.status,
          isEntrySnapshot: schema.quarterlyPerformance.isEntrySnapshot,
          revenueLtm: schema.quarterlyPerformance.revenueLtm,
          ebitdaLtm: schema.quarterlyPerformance.ebitdaLtm,
          ev: schema.quarterlyPerformance.ev,
          netDebt: schema.quarterlyPerformance.netDebt,
        })
        .from(schema.quarterlyPerformance)
        .where(eq(schema.quarterlyPerformance.investmentId, row.id));
      const operating = operatingView(operatingRows, asOf, tolerance);

      let credit: InvestmentDetail['credit'] = null;
      const terms = (
        await tx
          .select()
          .from(schema.creditTerms)
          .where(eq(schema.creditTerms.investmentId, row.id))
          .limit(1)
      )[0];
      if (terms !== undefined) {
        const creditRows = await tx
          .select({
            periodEnd: schema.creditPerformance.periodEnd,
            status: schema.creditPerformance.status,
            isEntrySnapshot: schema.creditPerformance.isEntrySnapshot,
            parValue: schema.creditPerformance.parValue,
            fairValue: schema.creditPerformance.fairValue,
            ebitdaLtm: schema.creditPerformance.ebitdaLtm,
            cashInterestExpenseLtm: schema.creditPerformance.cashInterestExpenseLtm,
            netDebtThroughTranche: schema.creditPerformance.netDebtThroughTranche,
            ev: schema.creditPerformance.ev,
            covenantStatus: schema.creditPerformance.covenantStatus,
            paymentStatus: schema.creditPerformance.paymentStatus,
          })
          .from(schema.creditPerformance)
          .where(eq(schema.creditPerformance.investmentId, row.id));
        credit = {
          facilityType: terms.facilityType,
          baseRate: terms.baseRate,
          spread: terms.spread,
          cashCoupon: terms.cashCoupon,
          pikCoupon: terms.pikCoupon,
          maturityDate: terms.maturityDate,
          latest: creditView(creditRows, terms.cashCoupon, asOf),
        };
      }
      await audit({ action: 'investment.read', entity: 'core.investment', entityId: row.id });
      const latestPeriodEnd = credit?.latest?.periodEnd ?? operating?.periodEnd ?? null;
      return {
        ...summary,
        companyId: row.companyId,
        sponsorId: row.sponsorId,
        vehicleId: row.vehicleId,
        sector: row.sector,
        geography: row.geography,
        latestPeriodEnd,
        cashFlows: (flows.get(row.id) ?? []).map((f) => ({
          date: f.flowDate,
          flowType: f.flowType,
          amount: f.amount,
        })),
        valuations: (valuations.get(row.id) ?? []).map((v) => ({
          periodEnd: v.periodEnd,
          version: v.version,
          state: v.state,
          fairValue: v.fairValue,
          method: v.method,
        })),
        credit,
        operating,
      };
    });
  }

  async sponsors(
    principal: Principal,
    requestId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<{
    items: {
      id: string;
      name: string;
      tier: string;
      hqGeography: string | null;
      fundCount: number;
      activeInvestments: number;
    }[];
    nextCursor: string | null;
  }> {
    return this.db.run(principal, requestId, async (tx) => {
      const after = cursor === undefined ? null : Buffer.from(cursor, 'base64url').toString('utf8');
      const rows = await tx
        .select({
          id: schema.sponsor.id,
          name: schema.sponsor.name,
          tier: schema.sponsor.tier,
          hqGeography: schema.sponsor.hqGeography,
          fundCount: sql<number>`(select count(*)::int from core.sponsor_fund f where f.sponsor_id = ${OUTER_SPONSOR_ID})`,
          activeInvestments: sql<number>`(select count(*)::int from core.investment i where i.sponsor_id = ${OUTER_SPONSOR_ID} and i.is_active)`,
        })
        .from(schema.sponsor)
        .where(after === null ? undefined : gt(schema.sponsor.name, after))
        .orderBy(asc(schema.sponsor.name))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor:
          rows.length > limit && last !== undefined
            ? Buffer.from(last.name, 'utf8').toString('base64url')
            : null,
      };
    });
  }

  async vehicles(
    principal: Principal,
    requestId: string,
  ): Promise<{
    items: {
      id: string;
      name: string;
      vehicleType: string;
      vintage: number | null;
      activeInvestments: number;
      lpCommitmentsTotal: string | null;
    }[];
  }> {
    return this.db.run(principal, requestId, async (tx) => {
      const rows = await tx
        .select({
          id: schema.vehicle.id,
          name: schema.vehicle.name,
          vehicleType: schema.vehicle.vehicleType,
          vintage: schema.vehicle.vintage,
          activeInvestments: sql<number>`(select count(*)::int from core.investment i where i.vehicle_id = ${OUTER_VEHICLE_ID} and i.is_active)`,
          // RLS decides which LP commitments the caller can see; none visible yields null, never 0.
          lpCommitmentsTotal: sql<
            string | null
          >`(select sum(l.amount)::text from core.lp_commitment l where l.vehicle_id = ${OUTER_VEHICLE_ID})`,
        })
        .from(schema.vehicle)
        .orderBy(desc(schema.vehicle.vintage), asc(schema.vehicle.name));
      return { items: rows };
    });
  }
}
