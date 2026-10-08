import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import type { InvestmentDetail, InvestmentPage } from '@pb/contracts';
import { schema } from '@pb/db';
import { configInteger } from '../common/definitions.js';
import { DEFINITIONS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { loadFlowsAndValuations, loadInvestmentRows, summarizeInvestment } from './loaders.js';
import { creditView, operatingView } from './metrics.js';

export interface ListOptions {
  limit: number;
  cursor?: string | undefined;
  vehicleId?: string | undefined;
  dealType?: string | undefined;
  active?: 'true' | 'false' | undefined;
  asOf: string;
}

/** Calculation settings from config/definitions.json (docs/03 section 4); only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: number;
  [key: string]: unknown;
}

const encodeCursor = (investmentNumber: string): string =>
  Buffer.from(investmentNumber, 'utf8').toString('base64url');
const decodeCursor = (cursor: string): string => {
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[A-Z0-9-]{1,32}$/.test(value)) throw new ProblemError(400, 'validation', 'Invalid cursor');
  return value;
};

/**
 * Fully qualified outer-table columns for correlated subqueries. In a single-table select Drizzle
 * renders a column as a bare `"id"`, which inside the subquery would bind to the inner table.
 */
const OUTER_SPONSOR_ID = sql.raw('"core"."sponsor"."id"');
const OUTER_VEHICLE_ID = sql.raw('"core"."vehicle"."id"');

@Injectable()
export class PortfolioService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

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
      const rows = await loadInvestmentRows(tx, {
        where: conditions.length > 0 ? and(...conditions) : undefined,
        limit: opts.limit + 1,
      });
      const page = rows.slice(0, opts.limit);
      const { flows, valuations } = await loadFlowsAndValuations(
        tx,
        page.map((r) => r.id),
      );
      const items = page.map((r) =>
        summarizeInvestment(r, flows.get(r.id) ?? [], valuations.get(r.id) ?? [], opts.asOf),
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

  /**
   * 404 for anything the caller cannot see (docs/17 section 3); a successful open is an audited
   * sensitive read (SEC-11.1). The prior-year tolerance comes from config; without it the read is
   * a 500 'configuration' problem before the database is touched, never a default in code.
   */
  async detail(
    principal: Principal,
    requestId: string,
    id: string,
    asOf: string,
  ): Promise<InvestmentDetail> {
    const tolerance = configInteger(
      this.definitions.priorYearPeriodEndToleranceDays,
      'priorYearPeriodEndToleranceDays',
    );
    return this.db.run(principal, requestId, async (tx, audit) => {
      const rows = await loadInvestmentRows(tx, { where: eq(schema.investment.id, id), limit: 1 });
      const row = rows[0];
      if (row === undefined) throw new ProblemError(404, 'not-found', 'Investment not found');
      const description = (
        await tx
          .select({ description: schema.portfolioCompany.description })
          .from(schema.portfolioCompany)
          .where(eq(schema.portfolioCompany.id, row.companyId))
          .limit(1)
      )[0];
      const { flows, valuations } = await loadFlowsAndValuations(tx, [row.id]);
      const summary = summarizeInvestment(
        row,
        flows.get(row.id) ?? [],
        valuations.get(row.id) ?? [],
        asOf,
      );

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
        sponsorFundId: row.sponsorFundId,
        vehicleId: row.vehicleId,
        companyDescription: description?.description ?? null,
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
