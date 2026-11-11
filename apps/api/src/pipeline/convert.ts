import { and, eq, sql } from 'drizzle-orm';
import { D } from '@pb/calc';
import type { AllocationRow } from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { compareText } from '../common/order.js';
import { ProblemError } from '../common/problem.js';
import type { AuditEntry } from '../db/db.service.js';
import type { LockedOpportunity } from './rows.js';

/*
 * The conversion of a closed deal into a position (docs/04 M5 AC: data captured once; M8). The
 * one write into core.investment from the pipeline: the company, sponsor, fund and deal type come
 * from the opportunity as they were captured, the entry date is the closing's close date (the
 * single source of every close date), the vehicle is the one with the largest allocation line,
 * and the portfolio company is created from the company name when the deal did not name one yet
 * (or linked to the company already on record under that name, so no second record is made). The
 * next investment number counts every position, walled ones included, so it is read as the system
 * actor; nothing read there is returned to the caller. A walled deal becomes a walled position:
 * every wall of the opportunity is carried to the investment in the same transaction (carryWalls).
 */

export interface Conversion {
  investmentId: string;
  investmentNumber: string;
  portfolioCompanyId: string;
  /** True when the company was created from the opportunity's company name. */
  portfolioCompanyCreated: boolean;
  vehicleId: string;
  entryDate: string;
}

/** The canonical form of a company name, as the directory keys it: lower case, no periods or commas, single spaces. */
export const canonicalName = (name: string): string =>
  name.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/** The next INV-nnnn after the highest on record, across the whole book. */
export async function nextInvestmentNumber(tx: Tx): Promise<string> {
  const highest = await asSystemActor(tx, async (sys) => {
    const result = await sys.execute<{ n: number }>(
      sql`select coalesce(max(substring(investment_number from 5)::int), 0)::int as n from core.investment where investment_number ~ '^INV-[0-9]+$'`,
    );
    return result.rows[0]?.n ?? 0;
  });
  return `INV-${String(highest + 1).padStart(4, '0')}`;
}

/** The line that names the vehicle the position closes into: the largest by received (else requested), then by vehicle name. */
export function largestAllocation(rows: readonly AllocationRow[]): AllocationRow | undefined {
  return [...rows].sort(
    (a, b) =>
      D(b.received ?? b.requested).comparedTo(D(a.received ?? a.requested)) ||
      compareText(a.vehicle.name, b.vehicle.name),
  )[0];
}

/**
 * The walls of the opportunity, carried to the position it became (SEC-5.3): a walled deal must
 * not turn into a position everyone can read. Every wall that covers the opportunity is copied to
 * the investment in the conversion's own transaction, as the system actor: the person closing the
 * deal is a member of one of those walls at least, not necessarily of all, and members do not
 * manage walls. Answers how many walls were carried.
 *
 * The copy is checked before the conversion goes on. The person sees the wall rows of the walls
 * they belong to, so they see one at least when the deal is walled; every wall they see must be
 * among the walls carried. When it is not (the system actor could not read or write the wall
 * rows), the conversion is refused and nothing is written, rather than leave an unwalled position.
 */
export async function carryWalls(
  tx: Tx,
  opportunityId: string,
  investmentId: string,
): Promise<number> {
  const walled = schema.walledRecord;
  const ofOpportunity = and(eq(walled.entity, 'opportunity'), eq(walled.entityId, opportunityId));
  const seen = await tx.select({ wallId: walled.wallId }).from(walled).where(ofOpportunity);
  const carried = await asSystemActor(tx, async (sys) => {
    const walls = await sys.select({ wallId: walled.wallId }).from(walled).where(ofOpportunity);
    if (walls.length > 0)
      await sys
        .insert(walled)
        .values(
          walls.map((w) => ({ wallId: w.wallId, entity: 'investment', entityId: investmentId })),
        );
    return new Set(walls.map((w) => w.wallId));
  });
  if (seen.some((w) => !carried.has(w.wallId)))
    throw new ProblemError(
      500,
      'internal',
      'conversion: the walls of the deal could not be carried to the position; nothing was written',
    );
  return carried.size;
}

export async function convertToInvestment(
  tx: Tx,
  audit: (entry: AuditEntry) => Promise<void>,
  opportunity: LockedOpportunity,
  closing: { id: string; closeDate: string; currency: string },
  allocations: readonly AllocationRow[],
): Promise<Conversion> {
  const largest = largestAllocation(allocations);
  if (largest === undefined)
    throw new ProblemError(
      422,
      'workflow-precondition',
      'no allocation names the vehicle the position closes into (M22)',
    );
  const investmentNumber = await nextInvestmentNumber(tx);

  let portfolioCompanyId = opportunity.portfolioCompanyId;
  let portfolioCompanyCreated = false;
  if (portfolioCompanyId === null) {
    const canonical = canonicalName(opportunity.companyName);
    const onRecord = (
      await tx
        .select({ id: schema.portfolioCompany.id })
        .from(schema.portfolioCompany)
        .where(eq(schema.portfolioCompany.canonicalName, canonical))
        .limit(1)
    )[0];
    if (onRecord !== undefined) {
      portfolioCompanyId = onRecord.id;
    } else {
      const created = (
        await tx
          .insert(schema.portfolioCompany)
          .values({
            name: opportunity.companyName,
            canonicalName: canonical,
            sector: opportunity.sector,
            geography: opportunity.geography,
            description: null,
          })
          .returning()
      )[0];
      if (created === undefined)
        throw new ProblemError(
          500,
          'internal',
          'conversion: the portfolio company was not written',
        );
      portfolioCompanyId = created.id;
      portfolioCompanyCreated = true;
    }
  }

  const investment = (
    await tx
      .insert(schema.investment)
      .values({
        investmentNumber,
        vehicleId: largest.vehicle.id,
        portfolioCompanyId,
        sponsorFundId: opportunity.sponsorFundId,
        sponsorId: opportunity.sponsorId,
        dealType: opportunity.dealType,
        entryDate: closing.closeDate,
        exitDate: null,
        isActive: true,
        currency: closing.currency,
      })
      .returning()
  )[0];
  if (investment === undefined)
    throw new ProblemError(500, 'internal', 'conversion: the investment was not written');
  const wallsCarried = await carryWalls(tx, opportunity.id, investment.id);

  await audit({
    action: 'investment.create',
    entity: 'core.investment',
    entityId: investment.id,
    details: {
      investmentNumber,
      opportunityId: opportunity.id,
      closingId: closing.id,
      vehicleId: largest.vehicle.id,
      portfolioCompanyId,
      portfolioCompanyCreated,
      sponsorId: opportunity.sponsorId,
      sponsorFundId: opportunity.sponsorFundId,
      dealType: opportunity.dealType,
      entryDate: closing.closeDate,
      wallsCarried,
    },
  });
  return {
    investmentId: investment.id,
    investmentNumber,
    portfolioCompanyId,
    portfolioCompanyCreated,
    vehicleId: largest.vehicle.id,
    entryDate: closing.closeDate,
  };
}
