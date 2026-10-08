import { z } from 'zod';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbHandle, Schema } from './client.js';
import { APP_ROLES } from './roles.js';
import * as schema from './schema/index.js';

/**
 * The synthetic dataset contract shared by tools/synthetic (producer) and this loader (consumer).
 * Money and rates are strings (exact decimals). Ids are stable UUIDs so re-seeding is idempotent.
 */
const money = z.string().regex(/^-?\d+(\.\d+)?$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A UTC instant such as 2025-03-31T12:00:00Z; the generator derives it, the loader writes it. */
const isoTimestamp = z.iso.datetime();
const uuid = z.string().uuid();

export const syntheticDatasetSchema = z.object({
  version: z.literal(1),
  profile: z.string(),
  seed: z.number().int(),
  /** Reporting date the dataset is built up to. */
  asOf: isoDate,
  /** Scenario tag to the ids that carry it (docs/14 section 3). */
  scenarios: z.record(z.string(), z.array(z.string())).default({}),
  users: z.array(
    z.object({
      id: uuid,
      externalId: z.string(),
      displayName: z.string(),
      email: z.string().email(),
      roles: z.array(z.enum(APP_ROLES)),
      clientIds: z.array(uuid).default([]),
    }),
  ),
  sponsors: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      canonicalName: z.string(),
      tier: z.string(),
      hqGeography: z.string().nullable(),
      description: z.string().nullable(),
    }),
  ),
  sponsorFunds: z.array(
    z.object({
      id: uuid,
      sponsorId: uuid,
      name: z.string(),
      canonicalName: z.string(),
      vintage: z.number().int().nullable(),
      strategy: z.string().nullable(),
      sizeTarget: money.nullable(),
      sizeHardCap: money.nullable(),
      sizeFinal: money.nullable(),
    }),
  ),
  fundAliases: z.array(z.object({ id: uuid, sponsorFundId: uuid, alias: z.string() })),
  portfolioCompanies: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      canonicalName: z.string(),
      sector: z.string().nullable(),
      geography: z.string().nullable(),
      description: z.string().nullable(),
    }),
  ),
  fundHoldings: z.array(z.object({ id: uuid, sponsorFundId: uuid, portfolioCompanyId: uuid })),
  vehicles: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      vehicleType: z.string(),
      vintage: z.number().int().nullable(),
      closingCount: z.number().int(),
      finalCloseDate: isoDate.nullable(),
    }),
  ),
  investments: z.array(
    z.object({
      id: uuid,
      investmentNumber: z.string(),
      vehicleId: uuid,
      portfolioCompanyId: uuid,
      sponsorFundId: uuid.nullable(),
      sponsorId: uuid,
      dealType: z.string(),
      entryDate: isoDate,
      exitDate: isoDate.nullable(),
      isActive: z.boolean(),
      scenarioTags: z.array(z.string()).default([]),
    }),
  ),
  clients: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      reportingBases: z.array(z.string()),
      reportingCadence: z.string(),
    }),
  ),
  commitments: z.array(
    z.object({
      id: uuid,
      vehicleId: uuid,
      sponsorFundId: uuid,
      clientId: uuid.nullable(),
      amount: money,
      commitmentDate: isoDate,
    }),
  ),
  lpCommitments: z.array(
    z.object({
      id: uuid,
      clientId: uuid,
      vehicleId: uuid,
      amount: money,
      commitmentDate: isoDate,
      closingNumber: z.number().int(),
      ownershipPct: money.nullable(),
    }),
  ),
  matchGuards: z.array(
    z.object({ id: uuid, nameA: z.string(), nameB: z.string(), reason: z.string() }),
  ),
  walls: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      description: z.string().nullable(),
      memberUserIds: z.array(uuid),
      records: z.array(
        z.object({
          entity: z.enum(['investment', 'opportunity', 'sponsor', 'document']),
          entityId: uuid,
        }),
      ),
    }),
  ),
  quarterlyPerformance: z.array(
    z.object({
      id: uuid,
      investmentId: uuid,
      periodEnd: isoDate,
      revenueLtm: money.nullable(),
      ebitdaLtm: money.nullable(),
      ev: money.nullable(),
      netDebt: money.nullable(),
      cash: money.nullable(),
      totalEquity: money.nullable(),
      highlights: z.array(z.string()).default([]),
      commentary: z.string().nullable(),
      isEntrySnapshot: z.boolean(),
      status: z.string(),
      scenarioTags: z.array(z.string()).default([]),
    }),
  ),
  creditTerms: z.array(
    z.object({
      id: uuid,
      investmentId: uuid,
      facilityType: z.string(),
      seniorityRank: z.number().int(),
      commitmentAmount: money,
      baseRate: z.string(),
      floor: money.nullable(),
      spread: money,
      cashCoupon: money,
      pikCoupon: money,
      oid: money,
      upfrontFee: money,
      maturityDate: isoDate,
      paymentFrequency: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']),
      amortization: z.array(z.object({ date: isoDate, amount: money })).default([]),
      callProtection: z.array(z.object({ until: isoDate, premium: money })).default([]),
      covenants: z
        .array(z.object({ name: z.string(), level: money, test: z.string() }))
        .default([]),
      effectiveDate: isoDate,
      status: z.string(),
    }),
  ),
  creditPerformance: z.array(
    z.object({
      id: uuid,
      investmentId: uuid,
      periodEnd: isoDate,
      parValue: money.nullable(),
      costBasis: money.nullable(),
      fairValue: money.nullable(),
      accruedInterest: money.nullable(),
      cashInterestLtm: money.nullable(),
      pikCapitalizedLtm: money.nullable(),
      principalRepaidLtm: money.nullable(),
      fundedAmount: money.nullable(),
      ebitdaLtm: money.nullable(),
      cashInterestExpenseLtm: money.nullable(),
      netDebtThroughTranche: money.nullable(),
      ev: money.nullable(),
      covenantStatus: z.string().nullable(),
      paymentStatus: z.string().nullable(),
      isEntrySnapshot: z.boolean(),
      status: z.string(),
      scenarioTags: z.array(z.string()).default([]),
    }),
  ),
  valuations: z.array(
    z.object({
      id: uuid,
      investmentId: uuid,
      periodEnd: isoDate,
      version: z.number().int(),
      method: z.string(),
      fairValue: money,
      state: z.enum(['Draft', 'OpsPrepared', 'DealTeamApproved', 'Locked', 'Reopened']),
      lockHash: z.string().nullable(),
      preparedBy: uuid.nullable(),
      dealTeamApprovedBy: uuid.nullable(),
      approvedBy: uuid.nullable(),
      approvedAt: z.string().nullable(),
      scenarioTags: z.array(z.string()).default([]),
    }),
  ),
  capitalNotices: z.array(
    z.object({
      id: uuid,
      noticeType: z.string(),
      vehicleId: uuid,
      investmentId: uuid.nullable(),
      commitmentId: uuid.nullable(),
      issueDate: isoDate,
      dueDate: isoDate,
      amount: money,
      split: z.record(z.string(), money).default({}),
      state: z.enum([
        'Received',
        'Extracted',
        'Reviewed',
        'TicketDrafted',
        'TicketApproved',
        'Funded',
        'Reconciled',
      ]),
      scenarioTag: z.string().nullable(),
    }),
  ),
  cashFlows: z.array(
    z.object({
      id: uuid,
      investmentId: uuid.nullable(),
      commitmentId: uuid.nullable(),
      flowDate: isoDate,
      flowType: z.string(),
      amount: money,
      sourceNoticeId: uuid.nullable(),
      status: z.string(),
    }),
  ),
  realizationOutlooks: z.array(
    z.object({
      id: uuid,
      investmentId: uuid,
      horizonMonths: z.number().int(),
      outlook: z.string(),
      note: z.string().nullable(),
      /** When the outlook was set; written explicitly so set_at never falls back to now(). */
      setAt: isoTimestamp,
    }),
  ),
});

export type SyntheticDataset = z.infer<typeof syntheticDatasetSchema>;

function chunks<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Loads a synthetic dataset as the database owner (not through RLS: this is the seed path for
 * local databases only; production data never arrives this way). Idempotent: rows are inserted
 * with `on conflict do nothing` keyed on their stable ids.
 */
export async function loadSyntheticDataset(
  handle: DbHandle,
  raw: unknown,
): Promise<Record<string, number>> {
  const data = syntheticDatasetSchema.parse(raw);
  // Both drivers expose the same query builder; only the execution backend differs, so the loader
  // uses one concrete type for the generic insert below instead of the driver union.
  const db = handle.db as unknown as PgliteDatabase<Schema>;
  const counts: Record<string, number> = {};
  const insert = async (name: string, table: PgTable, rows: readonly Record<string, unknown>[]) => {
    for (const batch of chunks(rows)) {
      if (batch.length === 0) continue;
      await db.insert(table).values(batch).onConflictDoNothing();
    }
    counts[name] = rows.length;
  };

  await insert(
    'users',
    schema.appUser,
    data.users.map((u) => ({
      id: u.id,
      externalId: u.externalId,
      displayName: u.displayName,
      email: u.email,
    })),
  );
  await insert('sponsors', schema.sponsor, data.sponsors);
  await insert('sponsorFunds', schema.sponsorFund, data.sponsorFunds);
  await insert('fundAliases', schema.fundAlias, data.fundAliases);
  await insert('portfolioCompanies', schema.portfolioCompany, data.portfolioCompanies);
  await insert('fundHoldings', schema.fundHolding, data.fundHoldings);
  await insert('vehicles', schema.vehicle, data.vehicles);
  await insert(
    'investments',
    schema.investment,
    data.investments.map(({ scenarioTags: _tags, ...row }) => row),
  );
  await insert('clients', schema.client, data.clients);
  await insert('commitments', schema.commitment, data.commitments);
  await insert('lpCommitments', schema.lpCommitment, data.lpCommitments);
  await insert('matchGuards', schema.matchGuard, data.matchGuards);
  await insert(
    'walls',
    schema.wall,
    data.walls.map((w) => ({ id: w.id, name: w.name, description: w.description })),
  );
  await insert(
    'wallMembers',
    schema.wallMember,
    data.walls.flatMap((w) => w.memberUserIds.map((userId) => ({ wallId: w.id, userId }))),
  );
  await insert(
    'walledRecords',
    schema.walledRecord,
    data.walls.flatMap((w) =>
      w.records.map((r) => ({ wallId: w.id, entity: r.entity, entityId: r.entityId })),
    ),
  );
  await insert(
    'quarterlyPerformance',
    schema.quarterlyPerformance,
    data.quarterlyPerformance.map(({ scenarioTags: _tags, ...row }) => row),
  );
  await insert('creditTerms', schema.creditTerms, data.creditTerms);
  await insert(
    'creditPerformance',
    schema.creditPerformance,
    data.creditPerformance.map(({ scenarioTags: _tags, ...row }) => row),
  );
  await insert(
    'valuations',
    schema.valuation,
    data.valuations.map(({ scenarioTags: _tags, approvedAt, ...row }) => ({
      ...row,
      approvedAt: approvedAt === null ? null : new Date(approvedAt),
    })),
  );
  await insert('capitalNotices', schema.capitalNotice, data.capitalNotices);
  await insert('cashFlows', schema.cashFlow, data.cashFlows);
  await insert(
    'realizationOutlooks',
    schema.realizationOutlook,
    data.realizationOutlooks.map(({ setAt, ...row }) => ({ ...row, setAt: new Date(setAt) })),
  );
  return counts;
}
