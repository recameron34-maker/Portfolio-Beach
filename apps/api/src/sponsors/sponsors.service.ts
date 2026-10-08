import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import { CALC_VERSION, ZERO } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import type { SponsorDetail, Taxonomy, WallList } from '@pb/contracts';
import { schema } from '@pb/db';
import { DEFINITIONS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { loadCommitmentRows } from '../portfolio/commitments.js';
import { loadInvestmentRows, loadInvestmentsWithMetrics } from '../portfolio/loaders.js';
import { pooledPositionMetrics, str } from '../portfolio/metrics.js';

/** Calculation settings from config/definitions.json (docs/03 section 4); only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: number;
  [key: string]: unknown;
}

/**
 * Fully qualified outer-table columns for correlated subqueries: in a single-table select Drizzle
 * renders a column as a bare `"id"`, which inside the subquery would bind to the inner table.
 */
const OUTER_SPONSOR_ID = sql.raw('"core"."sponsor"."id"');
const OUTER_FUND_ID = sql.raw('"core"."sponsor_fund"."id"');

@Injectable()
export class SponsorsService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  /**
   * Sponsor 360 (docs/04 M6): the directory row's counts, every fund with its aliases, holdings,
   * our positions and our commitment, the visible positions with their metrics pooled, and the
   * commitment rows to the sponsor's funds. RLS applies walls to sponsors and investments and
   * client entitlements to separate-account commitments (SEC-5.1 to SEC-5.3), so a sponsor the
   * caller cannot see is a 404 and every count and sum covers the caller's view only. The open is
   * an audited sensitive read: tier and description are Restricted (SEC-11.1).
   */
  async detail(
    principal: Principal,
    requestId: string,
    id: string,
    asOf: string,
  ): Promise<SponsorDetail> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const s = schema.sponsor;
      const sponsor = (
        await tx
          .select({
            id: s.id,
            name: s.name,
            tier: s.tier,
            hqGeography: s.hqGeography,
            description: s.description,
            fundCount: sql<number>`(select count(*)::int from core.sponsor_fund f where f.sponsor_id = ${OUTER_SPONSOR_ID})`,
            activeInvestments: sql<number>`(select count(*)::int from core.investment i where i.sponsor_id = ${OUTER_SPONSOR_ID} and i.is_active)`,
          })
          .from(s)
          .where(eq(s.id, id))
          .limit(1)
      )[0];
      if (sponsor === undefined) throw new ProblemError(404, 'not-found', 'Sponsor not found');

      const f = schema.sponsorFund;
      const funds = await tx
        .select({
          id: f.id,
          name: f.name,
          vintage: f.vintage,
          strategy: f.strategy,
          sizeTarget: f.sizeTarget,
          sizeFinal: f.sizeFinal,
          currency: f.currency,
          holdings: sql<number>`(select count(*)::int from core.fund_holding h where h.sponsor_fund_id = ${OUTER_FUND_ID})`,
          ourPositions: sql<number>`(select count(*)::int from core.investment i where i.sponsor_fund_id = ${OUTER_FUND_ID})`,
        })
        .from(f)
        .where(eq(f.sponsorId, sponsor.id))
        .orderBy(asc(f.vintage), asc(f.name), asc(f.id));
      const a = schema.fundAlias;
      const aliases =
        funds.length === 0
          ? []
          : await tx
              .select({ sponsorFundId: a.sponsorFundId, alias: a.alias })
              .from(a)
              .where(
                inArray(
                  a.sponsorFundId,
                  funds.map((r) => r.id),
                ),
              )
              .orderBy(asc(a.alias));

      // The shared commitment loader, narrowed to this sponsor's funds (portfolio/commitments.ts).
      const commitments = await loadCommitmentRows(
        tx,
        asOf,
        eq(schema.sponsorFund.sponsorId, sponsor.id),
      );
      const positions = await loadInvestmentsWithMetrics(
        tx,
        asOf,
        eq(schema.investment.sponsorId, sponsor.id),
      );
      await audit({ action: 'sponsor.read', entity: 'core.sponsor', entityId: sponsor.id });

      // Our commitment per fund and in total: sums of the visible commitment rows, null when none.
      const committedByFund = new Map<string, Decimal>();
      let totalCommitted: Decimal | null = null;
      for (const c of commitments) {
        committedByFund.set(
          c.sponsorFundId,
          (committedByFund.get(c.sponsorFundId) ?? ZERO).plus(c.amount),
        );
        totalCommitted = (totalCommitted ?? ZERO).plus(c.amount);
      }
      return {
        id: sponsor.id,
        name: sponsor.name,
        tier: sponsor.tier,
        hqGeography: sponsor.hqGeography,
        fundCount: sponsor.fundCount,
        activeInvestments: sponsor.activeInvestments,
        description: sponsor.description,
        funds: funds.map((r) => ({
          id: r.id,
          name: r.name,
          vintage: r.vintage,
          strategy: r.strategy,
          sizeTarget: r.sizeTarget,
          sizeFinal: r.sizeFinal,
          currency: r.currency,
          aliases: aliases.filter((x) => x.sponsorFundId === r.id).map((x) => x.alias),
          holdings: r.holdings,
          ourPositions: r.ourPositions,
          ourCommitment: str(committedByFund.get(r.id) ?? null),
        })),
        positions: positions.map((p) => p.summary),
        commitments,
        metrics: pooledPositionMetrics(
          positions.map((p) => ({
            flows: p.flows,
            valuations: p.valuations,
            isActive: p.row.isActive,
          })),
          asOf,
        ),
        totalCommitted: str(totalCommitted),
        calcVersion: CALC_VERSION,
      };
    });
  }

  /** Every taxonomy term grouped by domain: domains alphabetical, terms by sort order then code (codes keep their prefix). */
  async taxonomy(principal: Principal, requestId: string): Promise<Taxonomy> {
    return this.db.run(principal, requestId, async (tx) => {
      const t = schema.taxonomyTerm;
      const rows = await tx
        .select({
          domain: t.domain,
          code: t.code,
          label: t.label,
          parentCode: t.parentCode,
          active: t.active,
          sortOrder: t.sortOrder,
        })
        .from(t)
        .orderBy(asc(t.domain), asc(t.sortOrder), asc(t.code));
      const domains: Taxonomy['domains'] = [];
      for (const { domain, ...term } of rows) {
        const current = domains[domains.length - 1];
        if (current?.domain === domain) current.terms.push(term);
        else domains.push({ domain, terms: [term] });
      }
      return { domains };
    });
  }

  /**
   * Information walls the caller can see (SEC-5.3): RLS shows approvers and platform admins every
   * wall and members their own, with the membership rows RLS allows (a plain member sees their own
   * row only). A record is labelled only when the caller can see it through the normal read path.
   */
  async walls(principal: Principal, requestId: string): Promise<WallList> {
    return this.db.run(principal, requestId, async (tx) => {
      const walls = await tx
        .select({
          id: schema.wall.id,
          name: schema.wall.name,
          description: schema.wall.description,
        })
        .from(schema.wall)
        .orderBy(asc(schema.wall.name));
      if (walls.length === 0) return { walls: [] };
      const wallIds = walls.map((w) => w.id);
      const members = await tx
        .select({
          wallId: schema.wallMember.wallId,
          userId: schema.wallMember.userId,
          displayName: schema.appUser.displayName,
        })
        .from(schema.wallMember)
        .innerJoin(schema.appUser, eq(schema.appUser.id, schema.wallMember.userId))
        .where(inArray(schema.wallMember.wallId, wallIds))
        .orderBy(asc(schema.appUser.displayName), asc(schema.wallMember.userId));
      const records = await tx
        .select({
          wallId: schema.walledRecord.wallId,
          entity: schema.walledRecord.entity,
          entityId: schema.walledRecord.entityId,
        })
        .from(schema.walledRecord)
        .where(inArray(schema.walledRecord.wallId, wallIds))
        .orderBy(asc(schema.walledRecord.entity), asc(schema.walledRecord.entityId));

      const labels = new Map<string, string>();
      const investmentIds = records.filter((r) => r.entity === 'investment').map((r) => r.entityId);
      if (investmentIds.length > 0) {
        const visible = await loadInvestmentRows(tx, {
          where: inArray(schema.investment.id, investmentIds),
        });
        for (const r of visible) labels.set(r.id, `${r.investmentNumber} ${r.companyName}`);
      }
      const sponsorIds = records.filter((r) => r.entity === 'sponsor').map((r) => r.entityId);
      if (sponsorIds.length > 0) {
        const visible = await tx
          .select({ id: schema.sponsor.id, name: schema.sponsor.name })
          .from(schema.sponsor)
          .where(inArray(schema.sponsor.id, sponsorIds));
        for (const r of visible) labels.set(r.id, r.name);
      }

      return {
        walls: walls.map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          members: members
            .filter((m) => m.wallId === w.id)
            .map((m) => ({ userId: m.userId, displayName: m.displayName })),
          records: records
            .filter((r) => r.wallId === w.id)
            .map((r) => ({
              entity: r.entity,
              entityId: r.entityId,
              label: labels.get(r.entityId) ?? null,
            })),
        })),
      };
    });
  }
}
