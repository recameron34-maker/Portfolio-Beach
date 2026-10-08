import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lt, lte, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Principal } from '@pb/adapters';
import {
  addDays,
  alignedQuarterEnd,
  latestQuarterEndOnOrBefore,
  valueChange,
  lockedNear,
} from '@pb/calc';
import type { ValuationPage, valuationListQuery } from '@pb/contracts';
import { schema } from '@pb/db';
import type { z } from 'zod';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { configInteger } from '../common/definitions.js';
import { DEFINITIONS } from '../common/tokens.js';
import { DbService } from '../db/db.service.js';
import { str } from '../portfolio/metrics.js';
import type { ValuationRow } from '../portfolio/metrics.js';

export type ValuationListOptions = Omit<z.infer<typeof valuationListQuery>, 'asOf'> & {
  asOf: string;
};

/** Calculation settings from config/definitions.json (docs/03 section 4); only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: unknown;
  [key: string]: unknown;
}

const valuation = schema.valuation;
const preparer = alias(schema.appUser, 'preparer');
const dealTeamApprover = alias(schema.appUser, 'deal_team_approver');
const approver = alias(schema.appUser, 'approver');

/** The cursor is "periodEnd|investmentNumber|version" of the last row, the page's sort key. */
const CURSOR = /^(\d{4}-\d{2}-\d{2})\|(.+)\|(\d{1,9})$/s;

@Injectable()
export class ValuationsService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  /**
   * The valuation board (M10): every visible version with a period end on or before the as-of
   * date, newest period first, with preparer and approver names, the Locked fair value of the
   * previous quarter end and the change against it. Walls apply through row-level security, so a
   * walled position's versions are simply absent (SEC-5.1, SEC-5.3). Fair values stay decimal strings.
   */
  async list(
    principal: Principal,
    requestId: string,
    opts: ValuationListOptions,
  ): Promise<ValuationPage> {
    const tolerance = configInteger(
      this.definitions.priorYearPeriodEndToleranceDays,
      'priorYearPeriodEndToleranceDays',
    );
    const number = schema.investment.investmentNumber;
    const conditions: (SQL | undefined)[] = [lte(valuation.periodEnd, opts.asOf)];
    if (opts.cursor !== undefined) {
      const [periodEnd = '', investmentNumber = '', version = ''] = decodeCursor(
        opts.cursor,
        CURSOR,
        [1],
      );
      // The sort is period end descending, investment number ascending, version descending.
      conditions.push(
        or(
          lt(valuation.periodEnd, periodEnd),
          and(eq(valuation.periodEnd, periodEnd), gt(number, investmentNumber)),
          and(
            eq(valuation.periodEnd, periodEnd),
            eq(number, investmentNumber),
            lt(valuation.version, Number(version)),
          ),
        ),
      );
    }
    if (opts.periodEnd !== undefined) conditions.push(eq(valuation.periodEnd, opts.periodEnd));
    if (opts.state !== undefined) conditions.push(eq(valuation.state, opts.state));
    if (opts.investmentId !== undefined)
      conditions.push(eq(valuation.investmentId, opts.investmentId));
    if (opts.vehicleId !== undefined)
      conditions.push(eq(schema.investment.vehicleId, opts.vehicleId));

    return this.db.run(principal, requestId, async (tx) => {
      const rows = await tx
        .select({
          id: valuation.id,
          investmentId: valuation.investmentId,
          investmentNumber: number,
          companyName: schema.portfolioCompany.name,
          vehicleName: schema.vehicle.name,
          dealType: schema.investment.dealType,
          periodEnd: valuation.periodEnd,
          version: valuation.version,
          state: valuation.state,
          method: valuation.method,
          fairValue: valuation.fairValue,
          lockHash: valuation.lockHash,
          preparedBy: preparer.displayName,
          dealTeamApprovedBy: dealTeamApprover.displayName,
          approvedBy: approver.displayName,
          approvedAt: valuation.approvedAt,
          reopenReason: valuation.reopenReason,
          rowVersion: valuation.rowVersion,
        })
        .from(valuation)
        .innerJoin(schema.investment, eq(schema.investment.id, valuation.investmentId))
        .innerJoin(
          schema.portfolioCompany,
          eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
        )
        .innerJoin(schema.vehicle, eq(schema.vehicle.id, schema.investment.vehicleId))
        .leftJoin(preparer, eq(preparer.id, valuation.preparedBy))
        .leftJoin(dealTeamApprover, eq(dealTeamApprover.id, valuation.dealTeamApprovedBy))
        .leftJoin(approver, eq(approver.id, valuation.approvedBy))
        .where(and(...conditions))
        .orderBy(desc(valuation.periodEnd), asc(number), desc(valuation.version))
        .limit(opts.limit + 1);
      const page = rows.slice(0, opts.limit);

      // Prior marks for the positions on this page, in one query. Within a period end the highest
      // version comes first, so lockedNear keeps the latest version when several qualify.
      const lockedByInvestment = new Map<string, ValuationRow[]>();
      const ids = [...new Set(page.map((r) => r.investmentId))];
      if (ids.length > 0) {
        const locked = await tx
          .select({
            investmentId: valuation.investmentId,
            periodEnd: valuation.periodEnd,
            version: valuation.version,
            state: valuation.state,
            fairValue: valuation.fairValue,
            method: valuation.method,
          })
          .from(valuation)
          .where(and(inArray(valuation.investmentId, ids), eq(valuation.state, 'Locked')))
          .orderBy(asc(valuation.periodEnd), desc(valuation.version));
        for (const { investmentId, ...mark } of locked) {
          const marks = lockedByInvestment.get(investmentId);
          if (marks === undefined) lockedByInvestment.set(investmentId, [mark]);
          else marks.push(mark);
        }
      }

      const periods = await tx
        .selectDistinct({ periodEnd: valuation.periodEnd })
        .from(valuation)
        .where(lte(valuation.periodEnd, opts.asOf))
        .orderBy(desc(valuation.periodEnd));

      const last = page[page.length - 1];
      return {
        items: page.map(({ approvedAt, ...r }) => {
          // The previous calendar quarter end; a sponsor reporting a few days early still counts.
          const previousQuarterEnd = latestQuarterEndOnOrBefore(addDays(r.periodEnd, -1));
          const prior = lockedNear(
            lockedByInvestment.get(r.investmentId) ?? [],
            previousQuarterEnd,
            tolerance,
          );
          const priorFairValue = prior?.fairValue ?? null;
          return {
            id: r.id,
            investmentId: r.investmentId,
            investmentNumber: r.investmentNumber,
            companyName: r.companyName,
            vehicleName: r.vehicleName,
            dealType: r.dealType,
            periodEnd: r.periodEnd,
            quarterEnd: alignedQuarterEnd(r.periodEnd, tolerance),
            version: r.version,
            state: r.state,
            method: r.method,
            fairValue: r.fairValue,
            priorFairValue,
            // Null without a prior Locked mark or against a zero one (docs/08 section 2).
            changePct: str(valueChange(r.fairValue, priorFairValue)),
            lockHash: r.lockHash,
            preparedBy: r.preparedBy,
            dealTeamApprovedBy: r.dealTeamApprovedBy,
            approvedBy: r.approvedBy,
            approvedAt: approvedAt === null ? null : approvedAt.toISOString(),
            reopenReason: r.reopenReason,
            rowVersion: r.rowVersion,
          };
        }),
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.periodEnd, last.investmentNumber, last.version])
            : null,
        asOf: opts.asOf,
        // Quarter ends, so a sponsor reporting a few days early lands in the quarter it reports for.
        periods: [...new Set(periods.map((p) => alignedQuarterEnd(p.periodEnd, tolerance)))].sort(
          (a, b) => (a < b ? 1 : a > b ? -1 : 0),
        ),
      };
    });
  }
}
