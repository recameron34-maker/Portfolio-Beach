import { z } from 'zod';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbHandle, Schema } from './client.js';
import {
  bankDetails,
  DEV_FIELD_KEY,
  encryptBankDetails,
  FieldCipher,
  maskBankDetails,
} from './fieldCrypto.js';
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
/** An instant, or a business date the loader reads as UTC midnight (never a local time zone). */
const instant = z.union([isoTimestamp, isoDate]);
const uuid = z.string().uuid();
const toDate = (value: string): Date => new Date(value);
const toDateOrNull = (value: string | null): Date | null => (value === null ? null : toDate(value));

const dealStage = z.enum([
  'Sourced',
  'Screening',
  'Prescreen',
  'Diligence',
  'IC',
  'Approved',
  'Closing',
  'Closed',
  'Passed',
]);

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
  /** Names a portfolio company is also known by (core.company_alias); absent in datasets made before migration 0010. */
  companyAliases: z
    .array(z.object({ id: uuid, portfolioCompanyId: uuid, alias: z.string().min(1) }))
    .optional()
    .superRefine((aliases, ctx) => {
      // Linking matches aliases after normalization, so two that normalize alike are refused here
      // rather than silently dropped by the unique index at load time.
      const seen = new Map<string, number>();
      for (const [i, a] of (aliases ?? []).entries()) {
        const key = a.alias.toLowerCase().replace(/[^a-z0-9]+/g, '');
        const first = seen.get(key);
        if (first !== undefined)
          ctx.addIssue({
            code: 'custom',
            path: [i, 'alias'],
            message: `alias normalizes like the alias at index ${first}`,
          });
        else seen.set(key, i);
      }
    }),
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
      /** SEC-12.4 alert flags (migration 0013); optional, false when absent (datasets made before Phase 3). */
      urgencyFlag: z.boolean().optional(),
      wireChangeFlag: z.boolean().optional(),
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
  // The Phase 3 controls (migration 0013, decision 0013). Each array defaults to [] so a dataset
  // made before Phase 3 still loads. Timestamps are instants (or dates read as UTC midnight).
  opportunities: z
    .array(
      z.object({
        id: uuid,
        name: z.string().min(1),
        companyName: z.string().min(1),
        portfolioCompanyId: uuid.nullable(),
        sponsorId: uuid,
        sponsorFundId: uuid.nullable(),
        dealType: z.string(),
        sector: z.string().nullable(),
        geography: z.string().nullable(),
        stage: dealStage,
        ownerId: uuid.nullable(),
        receivedDate: isoDate,
        targetCommitment: money.nullable(),
        source: z.string().nullable(),
        passReasonCode: z.string().nullable(),
        passNote: z.string().nullable(),
        investmentId: uuid.nullable(),
        scenarioTag: z.string().nullable(),
      }),
    )
    .default([]),
  opportunityStageHistory: z
    .array(
      z.object({
        id: uuid,
        opportunityId: uuid,
        fromStage: dealStage.nullable(),
        toStage: dealStage,
        command: z.string().min(1),
        reason: z.string().nullable(),
        changedBy: uuid,
        changedAt: instant,
      }),
    )
    .default([]),
  diligenceTasks: z
    .array(
      z.object({
        id: uuid,
        opportunityId: uuid,
        workstream: z.string(),
        title: z.string().min(1),
        ownerId: uuid.nullable(),
        dueDate: isoDate.nullable(),
        status: z.enum(['open', 'done', 'waived']),
        requiredForIc: z.boolean(),
        evidenceDocumentId: uuid.nullable(),
        waivedReason: z.string().nullable(),
      }),
    )
    .default([]),
  icDecisions: z
    .array(
      z.object({
        id: uuid,
        opportunityId: uuid,
        decisionDate: isoDate,
        decision: z.enum(['approved', 'declined', 'deferred']),
        amount: money.nullable(),
        conditions: z.array(z.string()),
        recordedBy: uuid,
      }),
    )
    .default([]),
  allocations: z
    .array(
      z.object({
        id: uuid,
        opportunityId: uuid.nullable(),
        investmentId: uuid.nullable(),
        vehicleId: uuid,
        clientId: uuid.nullable(),
        requested: money,
        received: money.nullable(),
      }),
    )
    .default([]),
  closings: z
    .array(
      z.object({
        id: uuid,
        /** Null only for a position that predates the pipeline (seeded from the investment). */
        opportunityId: uuid.nullable(),
        investmentId: uuid.nullable(),
        closeDate: isoDate,
        commitmentAmount: money,
        state: z.enum(['Open', 'OpsConfirmed']),
        opsConfirmedBy: uuid.nullable(),
        opsConfirmedAt: instant.nullable(),
      }),
    )
    .default([]),
  closingItems: z
    .array(
      z.object({
        id: uuid,
        closingId: uuid,
        itemCode: z.string().min(1),
        label: z.string().min(1),
        required: z.boolean(),
        documentId: uuid.nullable(),
        status: z.enum(['open', 'received', 'waived']),
        waivedReason: z.string().nullable(),
      }),
    )
    .default([]),
  legalTerms: z
    .array(
      z.object({
        id: uuid,
        closingId: uuid,
        investmentId: uuid.nullable(),
        termType: z.string(),
        value: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        status: z.enum(['draft', 'confirmed']),
        confirmedBy: uuid.nullable(),
        confirmedAt: instant.nullable(),
      }),
    )
    .default([]),
  /** Bank details are plaintext in the synthetic dataset; the loader encrypts them (SEC-12.2). */
  wireInstructions: z
    .array(
      z.object({
        id: uuid,
        sponsorFundId: uuid.nullable(),
        investmentId: uuid.nullable(),
        counterpartyName: z.string().min(1),
        version: z.number().int().min(1),
        bankDetails,
        state: z.enum(['Proposed', 'Verified', 'Rejected', 'Superseded']),
        proposedBy: uuid,
        proposedAt: instant,
        sourceNote: z.string().nullable(),
        callbackBy: uuid.nullable(),
        callbackAt: instant.nullable(),
        callbackNumberSource: z
          .enum(['prior_instruction', 'sponsor_website', 'known_contact', 'fund_administrator'])
          .nullable(),
        callbackResult: z.enum(['confirmed', 'not_confirmed']).nullable(),
        verifiedAt: instant.nullable(),
        rejectionReason: z.string().nullable(),
        active: z.boolean(),
      }),
    )
    .default([]),
  tradeTickets: z
    .array(
      z.object({
        id: uuid,
        capitalNoticeId: uuid,
        wireInstructionId: uuid.nullable(),
        amount: money,
        currency: z.string().length(3),
        fundingDate: isoDate,
        preparedBy: uuid,
        preparedAt: instant,
        approvedBy: uuid.nullable(),
        approvedAt: instant.nullable(),
        state: z.enum(['Drafted', 'Approved', 'Funded', 'Withdrawn']),
      }),
    )
    .default([]),
  changeRequests: z
    .array(
      z.object({
        id: uuid,
        investmentId: uuid,
        changeType: z.string(),
        effectiveDate: isoDate,
        details: z.record(z.string(), z.string()),
        summary: z.string().min(1),
        ownerId: uuid.nullable(),
        submittedBy: uuid,
        state: z.enum(['Submitted', 'Routed', 'InProgress', 'Applied', 'Rejected']),
        appliedPeriod: isoDate.nullable(),
        appliedBy: uuid.nullable(),
        appliedAt: instant.nullable(),
        rejectionReason: z.string().nullable(),
      }),
    )
    .default([]),
});

/** The dataset after parse: every array present (the Phase 3 arrays fill in as []). */
export type ParsedSyntheticDataset = z.infer<typeof syntheticDatasetSchema>;

/** The arrays migration 0013 added; a dataset made before Phase 3 has none of them. */
type Phase3Array =
  | 'opportunities'
  | 'opportunityStageHistory'
  | 'diligenceTasks'
  | 'icDecisions'
  | 'allocations'
  | 'closings'
  | 'closingItems'
  | 'legalTerms'
  | 'wireInstructions'
  | 'tradeTickets'
  | 'changeRequests';

/**
 * The dataset as a producer builds it (tools/synthetic) and a reader receives it: the Phase 3 arrays
 * are optional on the way in, so a generator or a file made before Phase 3 still type-checks and
 * still loads; the parse fills them with [] and the loader reads the parsed form.
 */
export type SyntheticDataset = Omit<ParsedSyntheticDataset, Phase3Array> &
  Partial<Pick<ParsedSyntheticDataset, Phase3Array>>;

export interface SeedOptions {
  /**
   * The cipher for `mon.wire_instruction.bank_details_enc`. Defaults to the prototype key
   * (DEV_FIELD_KEY): a local seed never has a vault, and the data is synthetic.
   */
  cipher?: FieldCipher;
}

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
  options: SeedOptions = {},
): Promise<Record<string, number>> {
  const data = syntheticDatasetSchema.parse(raw);
  const cipher = options.cipher ?? new FieldCipher(DEV_FIELD_KEY);
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
  if (data.companyAliases !== undefined)
    await insert('companyAliases', schema.companyAlias, data.companyAliases);
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
  await insert(
    'capitalNotices',
    schema.capitalNotice,
    data.capitalNotices.map((n) => ({
      ...n,
      urgencyFlag: n.urgencyFlag ?? false,
      wireChangeFlag: n.wireChangeFlag ?? false,
    })),
  );
  await insert('cashFlows', schema.cashFlow, data.cashFlows);
  await insert(
    'realizationOutlooks',
    schema.realizationOutlook,
    data.realizationOutlooks.map(({ setAt, ...row }) => ({ ...row, setAt: new Date(setAt) })),
  );
  // The Phase 3 controls (migration 0013), parents before children.
  await insert('opportunities', schema.opportunity, data.opportunities);
  await insert(
    'opportunityStageHistory',
    schema.opportunityStageHistory,
    data.opportunityStageHistory.map(({ changedAt, ...row }) => ({
      ...row,
      changedAt: toDate(changedAt),
    })),
  );
  await insert('diligenceTasks', schema.diligenceTask, data.diligenceTasks);
  await insert('icDecisions', schema.icDecision, data.icDecisions);
  await insert('allocations', schema.allocation, data.allocations);
  await insert(
    'closings',
    schema.closing,
    data.closings.map(({ opsConfirmedAt, ...row }) => ({
      ...row,
      opsConfirmedAt: toDateOrNull(opsConfirmedAt),
    })),
  );
  await insert('closingItems', schema.closingItem, data.closingItems);
  await insert(
    'legalTerms',
    schema.legalTerm,
    data.legalTerms.map(({ confirmedAt, ...row }) => ({
      ...row,
      confirmedAt: toDateOrNull(confirmedAt),
    })),
  );
  await insert(
    'wireInstructions',
    schema.wireInstruction,
    data.wireInstructions.map(
      ({ bankDetails: details, proposedAt, callbackAt, verifiedAt, ...row }) => ({
        ...row,
        bankDetailsEnc: encryptBankDetails(cipher, details),
        bankDetailsMasked: maskBankDetails(details),
        proposedAt: toDate(proposedAt),
        callbackAt: toDateOrNull(callbackAt),
        verifiedAt: toDateOrNull(verifiedAt),
      }),
    ),
  );
  await insert(
    'tradeTickets',
    schema.tradeTicket,
    data.tradeTickets.map(({ preparedAt, approvedAt, ...row }) => ({
      ...row,
      preparedAt: toDate(preparedAt),
      approvedAt: toDateOrNull(approvedAt),
    })),
  );
  await insert(
    'changeRequests',
    schema.dealChangeRequest,
    data.changeRequests.map(({ appliedAt, ...row }) => ({
      ...row,
      appliedAt: toDateOrNull(appliedAt),
    })),
  );
  return counts;
}
