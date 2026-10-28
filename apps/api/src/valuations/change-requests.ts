import { and, asc, desc, eq, notInArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { changeRequestDetails, changeRequestState } from '@pb/contracts';
import type { ChangeRequestRow } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';

/*
 * The open deal change requests of an investment (docs/04 M10 and M11): what the valuation screen
 * shows beside a version so the preparer and the approvers see a change the period's mark may
 * need to reflect. Open means not yet Applied and not Rejected (docs/18 section 8). The rows read
 * under the caller's own row-level security, so a walled investment's requests stay inside the
 * wall. The change-requests module (wave 2, Agent C) serves the full register; its
 * openChangeRequestsFor replaces this one at the merge, so only one copy survives (rule 7).
 */

const request = schema.dealChangeRequest;
const owner = alias(schema.appUser, 'cr_owner');
const submitter = alias(schema.appUser, 'cr_submitter');
const applier = alias(schema.appUser, 'cr_applier');

/** The states a request has left behind: it needs nothing from the valuation any more. */
const SETTLED = ['Applied', 'Rejected'] as const;

/** A person on a request, or null when the column is unset. */
function personOf(id: string | null, name: string | null): { id: string; name: string } | null {
  return id === null || name === null ? null : { id, name };
}

/** Every request of the investment that is still open, newest effective date first. */
export async function openChangeRequestsFor(
  tx: Tx,
  investmentId: string,
): Promise<ChangeRequestRow[]> {
  const rows = await tx
    .select({
      id: request.id,
      investmentId: request.investmentId,
      investmentName: schema.portfolioCompany.name,
      changeType: request.changeType,
      effectiveDate: request.effectiveDate,
      summary: request.summary,
      details: request.details,
      ownerId: request.ownerId,
      ownerName: owner.displayName,
      submittedById: request.submittedBy,
      submittedByName: submitter.displayName,
      state: request.state,
      appliedPeriod: request.appliedPeriod,
      appliedById: request.appliedBy,
      appliedByName: applier.displayName,
      rejectionReason: request.rejectionReason,
      createdAt: request.createdAt,
      rowVersion: request.rowVersion,
    })
    .from(request)
    .innerJoin(schema.investment, eq(schema.investment.id, request.investmentId))
    .innerJoin(
      schema.portfolioCompany,
      eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
    )
    .innerJoin(submitter, eq(submitter.id, request.submittedBy))
    .leftJoin(owner, eq(owner.id, request.ownerId))
    .leftJoin(applier, eq(applier.id, request.appliedBy))
    .where(and(eq(request.investmentId, investmentId), notInArray(request.state, [...SETTLED])))
    .orderBy(desc(request.effectiveDate), desc(request.createdAt), asc(request.id));
  return rows.map((r) => ({
    id: r.id,
    investmentId: r.investmentId,
    investmentName: r.investmentName,
    changeType: r.changeType,
    effectiveDate: r.effectiveDate,
    summary: r.summary,
    details: changeRequestDetails.parse(r.details),
    owner: personOf(r.ownerId, r.ownerName),
    submittedBy: { id: r.submittedById, name: r.submittedByName },
    state: changeRequestState.parse(r.state),
    appliedPeriod: r.appliedPeriod,
    appliedBy: personOf(r.appliedById, r.appliedByName),
    rejectionReason: r.rejectionReason,
    createdAt: r.createdAt.toISOString(),
    rowVersion: r.rowVersion,
  }));
}
