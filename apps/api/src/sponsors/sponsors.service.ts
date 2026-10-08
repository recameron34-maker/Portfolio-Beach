import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import type { SponsorDetail, Taxonomy, WallList } from '@pb/contracts';
import { schema } from '@pb/db';
import { DEFINITIONS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { loadInvestmentRows } from '../portfolio/loaders.js';

/** Calculation settings from config/definitions.json (docs/03 section 4); only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: number;
  [key: string]: unknown;
}

const notImplemented = (): never => {
  throw new ProblemError(501, 'not-implemented', 'This endpoint is not implemented yet');
};

@Injectable()
export class SponsorsService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async detail(
    _principal: Principal,
    _requestId: string,
    _id: string,
    _asOf: string,
  ): Promise<SponsorDetail> {
    return notImplemented();
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
