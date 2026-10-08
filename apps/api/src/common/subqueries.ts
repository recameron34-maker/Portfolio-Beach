import { sql } from 'drizzle-orm';

/*
 * Correlated counts and totals that the list and detail reads share, written once. The outer
 * columns are fully qualified: in a single-table select Drizzle renders a column as a bare "id",
 * which inside the subquery would bind to the inner table. Row-level security applies inside the
 * subqueries as everywhere else, so each count or total covers only what the caller may see.
 */
const OUTER_SPONSOR_ID = sql.raw('"core"."sponsor"."id"');
const OUTER_FUND_ID = sql.raw('"core"."sponsor_fund"."id"');
const OUTER_VEHICLE_ID = sql.raw('"core"."vehicle"."id"');

/** Funds on record for the sponsor in the outer select. */
export const sponsorFundCount = sql<number>`(select count(*)::int from core.sponsor_fund f where f.sponsor_id = ${OUTER_SPONSOR_ID})`;

/** Active positions with the sponsor in the outer select. */
export const sponsorActiveInvestments = sql<number>`(select count(*)::int from core.investment i where i.sponsor_id = ${OUTER_SPONSOR_ID} and i.is_active)`;

/** Underlying holdings recorded for the fund in the outer select. */
export const fundHoldingCount = sql<number>`(select count(*)::int from core.fund_holding h where h.sponsor_fund_id = ${OUTER_FUND_ID})`;

/** Our positions in the fund in the outer select. */
export const fundPositionCount = sql<number>`(select count(*)::int from core.investment i where i.sponsor_fund_id = ${OUTER_FUND_ID})`;

/** Active positions in the vehicle in the outer select. */
export const vehicleActiveInvestments = sql<number>`(select count(*)::int from core.investment i where i.vehicle_id = ${OUTER_VEHICLE_ID} and i.is_active)`;

/** LP commitments to the vehicle in the outer select; none visible yields null, never 0. */
export const vehicleLpCommitmentTotal = sql<
  string | null
>`(select sum(l.amount)::text from core.lp_commitment l where l.vehicle_id = ${OUTER_VEHICLE_ID})`;
