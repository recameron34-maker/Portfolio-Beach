import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { changeRequestDetails, changeRequestState, changeTypeCode } from '@pb/contracts';
import type { ChangeRequestRow, ChangeRequestState } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { EXACT_AT_FORMAT } from '../common/cursor.js';

/*
 * The one read of mon.deal_change_request (docs/04 M11, docs/18 section 8, decision 0013): the
 * queue, the detail, the quarter-end check and the valuation screen's open requests all read
 * through selectChangeRequests, under the caller's own row-level security (migration 0013: a
 * request carries its investment's wall, SEC-5.3), so a walled position's requests are simply
 * absent for anyone outside the wall. People are named from core.app_user by id; the position
 * is named by its company, as the valuation board names it.
 */

export const changeRequest = schema.dealChangeRequest;
const owner = alias(schema.appUser, 'cr_owner');
const submitter = alias(schema.appUser, 'cr_submitter');
const applier = alias(schema.appUser, 'cr_applier');

/** The states a request still works through: not Applied and not Rejected, the terminal ones. */
export const OPEN_STATES: readonly ChangeRequestState[] = ['Submitted', 'Routed', 'InProgress'];

/** A request as the queue reads it: the row, the people named on it and its position's name. */
export interface LoadedChangeRequest {
  id: string;
  investmentId: string;
  investmentName: string;
  changeType: string;
  effectiveDate: string;
  summary: string;
  details: unknown;
  ownerId: string | null;
  ownerName: string | null;
  submittedBy: string;
  submitterName: string;
  state: string;
  appliedPeriod: string | null;
  appliedBy: string | null;
  applierName: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  rowVersion: number;
  /** created_at to the microsecond, the exact value a page cursor carries (common/cursor.ts). */
  exactAt: string;
}

/** The select every read shares; the readers below add their where, order and limit. */
function selectChangeRequests(tx: Tx) {
  return tx
    .select({
      id: changeRequest.id,
      investmentId: changeRequest.investmentId,
      investmentName: schema.portfolioCompany.name,
      changeType: changeRequest.changeType,
      effectiveDate: changeRequest.effectiveDate,
      summary: changeRequest.summary,
      details: changeRequest.details,
      ownerId: changeRequest.ownerId,
      ownerName: owner.displayName,
      submittedBy: changeRequest.submittedBy,
      submitterName: submitter.displayName,
      state: changeRequest.state,
      appliedPeriod: changeRequest.appliedPeriod,
      appliedBy: changeRequest.appliedBy,
      applierName: applier.displayName,
      rejectionReason: changeRequest.rejectionReason,
      createdAt: changeRequest.createdAt,
      rowVersion: changeRequest.rowVersion,
      exactAt: sql<string>`to_char(${changeRequest.createdAt} at time zone 'UTC', ${EXACT_AT_FORMAT})`,
    })
    .from(changeRequest)
    .innerJoin(schema.investment, eq(schema.investment.id, changeRequest.investmentId))
    .innerJoin(
      schema.portfolioCompany,
      eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
    )
    .innerJoin(submitter, eq(submitter.id, changeRequest.submittedBy))
    .leftJoin(owner, eq(owner.id, changeRequest.ownerId))
    .leftJoin(applier, eq(applier.id, changeRequest.appliedBy))
    .$dynamic();
}

const personOf = (id: string | null, name: string | null): { id: string; name: string } | null =>
  id === null || name === null ? null : { id, name };

/** The contract row from a loaded request; the stored codes and states are checked on the way out. */
export function toChangeRequestRow(r: LoadedChangeRequest): ChangeRequestRow {
  return {
    id: r.id,
    investmentId: r.investmentId,
    investmentName: r.investmentName,
    changeType: changeTypeCode.parse(r.changeType),
    effectiveDate: r.effectiveDate,
    summary: r.summary,
    details: changeRequestDetails.parse(r.details),
    owner: personOf(r.ownerId, r.ownerName),
    submittedBy: { id: r.submittedBy, name: r.submitterName },
    state: changeRequestState.parse(r.state),
    appliedPeriod: r.appliedPeriod,
    appliedBy: personOf(r.appliedBy, r.applierName),
    rejectionReason: r.rejectionReason,
    createdAt: r.createdAt.toISOString(),
    rowVersion: r.rowVersion,
  };
}

/**
 * One page of the queue, newest first on (createdAt, id), under the conditions given (position,
 * state, the page cursor); the caller asks for one row more than its page to learn whether a next
 * page exists.
 */
export function pageChangeRequests(
  tx: Tx,
  conditions: readonly (SQL | undefined)[],
  limit: number,
): Promise<LoadedChangeRequest[]> {
  return selectChangeRequests(tx)
    .where(and(...conditions))
    .orderBy(desc(changeRequest.createdAt), desc(changeRequest.id))
    .limit(limit);
}

/** Every request not Applied or Rejected with an effective date on or before the period end, earliest first. */
export function unappliedChangeRequests(tx: Tx, periodEnd: string): Promise<LoadedChangeRequest[]> {
  return selectChangeRequests(tx)
    .where(
      and(
        inArray(changeRequest.state, [...OPEN_STATES]),
        lte(changeRequest.effectiveDate, periodEnd),
      ),
    )
    .orderBy(asc(changeRequest.effectiveDate), asc(changeRequest.createdAt), asc(changeRequest.id));
}

/** One request the caller may see, or null. */
export async function loadChangeRequest(tx: Tx, id: string): Promise<ChangeRequestRow | null> {
  const rows = await selectChangeRequests(tx).where(eq(changeRequest.id, id));
  const [row] = rows;
  return row === undefined ? null : toChangeRequestRow(row);
}

/**
 * The open requests of one position (docs/04 M10: shown on the valuation screen), the latest
 * effective date first. Row-level security applies as everywhere: a caller who cannot see the
 * position sees none.
 */
export async function openChangeRequestsFor(
  tx: Tx,
  investmentId: string,
): Promise<ChangeRequestRow[]> {
  const rows = await selectChangeRequests(tx)
    .where(
      and(
        eq(changeRequest.investmentId, investmentId),
        inArray(changeRequest.state, [...OPEN_STATES]),
      ),
    )
    .orderBy(
      desc(changeRequest.effectiveDate),
      desc(changeRequest.createdAt),
      desc(changeRequest.id),
    );
  return rows.map(toChangeRequestRow);
}
