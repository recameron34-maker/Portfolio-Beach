import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import type { DataHealth } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { DbService } from '../db/db.service.js';

interface Definitions {
  watchlist?: { missingFinancialsDays?: number };
}

/** M1: Data Health and Data Dictionary pages. */
@Controller('api/v1')
export class DataController {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions & Record<string, unknown>,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('data-health')
  async health(
    @Query('asOf') asOfQuery: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DataHealth> {
    const asOf =
      asOfQuery !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(asOfQuery)
        ? asOfQuery
        : this.adapters.clock.today();
    const staleAfterDays = this.definitions.watchlist?.missingFinancialsDays ?? 75;
    return this.db.run(principal, req.id ?? 'unknown', async (tx) => {
      const one = async <T>(query: ReturnType<typeof sql>): Promise<T> =>
        (await tx.execute<Record<string, T>>(query)).rows[0]!.n as T;
      const orphanInvestments = await one<number>(sql`
        select count(*)::int as n from core.investment i
        left join core.vehicle v on v.id = i.vehicle_id
        left join core.sponsor s on s.id = i.sponsor_id
        left join core.sponsor_fund f on f.id = i.sponsor_fund_id
        where i.is_active and (v.id is null or s.id is null or (i.sponsor_fund_id is not null and f.id is null))`);
      const openExceptions = await one<number>(
        sql`select count(*)::int as n from ops.data_exception where state in ('open', 'acknowledged')`,
      );
      const activeInvestments = await one<number>(
        sql`select count(*)::int as n from core.investment where is_active`,
      );
      const staleInvestments = await one<number>(sql`
        select count(*)::int as n from core.investment i
        where i.is_active and not exists (
          select 1 from mon.quarterly_performance q where q.investment_id = i.id and not q.is_entry_snapshot
            and q.status = 'record_status.approved' and q.period_end >= (${asOf}::date - make_interval(days => ${staleAfterDays}))
        ) and not exists (
          select 1 from mon.credit_performance c where c.investment_id = i.id and c.status = 'record_status.approved'
            and c.period_end >= (${asOf}::date - make_interval(days => ${staleAfterDays}))
        )`);
      const gaps = await tx.execute<{ vehicleName: string; ownershipTotal: string }>(sql`
        select v.name as "vehicleName", coalesce(sum(l.ownership_pct), 0)::text as "ownershipTotal"
        from core.vehicle v left join core.lp_commitment l on l.vehicle_id = v.id
        where v.final_close_date is not null
        group by v.name having abs(coalesce(sum(l.ownership_pct), 0) - 1) > 0.000001
        order by v.name`);
      const lockedValuationsLatestQuarter = await one<number>(sql`
        select count(*)::int as n from mon.valuation where state = 'Locked'
          and period_end = (select max(period_end) from mon.valuation where state = 'Locked' and period_end <= ${asOf}::date)`);
      return {
        asOf,
        orphanInvestments,
        openExceptions,
        staleInvestments,
        staleAfterDays,
        vehiclesWithOwnershipGap: gaps.rows,
        lockedValuationsLatestQuarter,
        activeInvestments,
      };
    });
  }

  @Get('data-dictionary')
  dictionary(): { source: 'config/definitions.json'; definitions: Record<string, unknown> } {
    return { source: 'config/definitions.json', definitions: this.definitions };
  }
}
