import { z } from 'zod';

/** Money, rates and multiples travel as decimal strings; the missing placeholder is null (docs/06 section 3). */
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const uuid = z.string().uuid();

export const appRole = z.enum([
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'platform_admin',
  'auditor',
  'service',
]);

/** RFC 9457 problem details (docs/17 section 3). Never carries stack traces or data values. */
export const problemDetails = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  request_id: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetails>;

export const principal = z.object({
  userId: uuid,
  externalId: z.string(),
  displayName: z.string(),
  roles: z.array(appRole),
  clientIds: z.array(uuid),
  /** True when the prototype mock identity is in use; the UI shows a banner. */
  mockIdentity: z.boolean(),
});
export type Principal = z.infer<typeof principal>;

export const mockUser = z.object({
  externalId: z.string(),
  displayName: z.string(),
  roles: z.array(appRole),
});
export const mockUserList = z.object({ users: z.array(mockUser) });

export const healthLive = z.object({ status: z.literal('ok'), version: z.string() });
export const healthReady = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.record(z.string(), z.object({ ok: z.boolean(), detail: z.string().optional() })),
});

export const featureFlag = z.object({
  key: z.string(),
  enabled: z.boolean(),
  description: z.string(),
});
export const featureFlagList = z.object({ flags: z.array(featureFlag) });
export const featureFlagPatch = z
  .object({ enabled: z.boolean(), reason: z.string().min(3) })
  .strict();

export const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  })
  .strict();

export const investmentListQuery = pageQuery.extend({
  vehicleId: uuid.optional(),
  dealType: z.string().optional(),
  active: z.enum(['true', 'false']).optional(),
  asOf: isoDate.optional(),
});

/** One row of the portfolio grid (M9 metrics from packages/calc, null where not calculable). */
export const investmentSummary = z.object({
  id: uuid,
  investmentNumber: z.string(),
  companyName: z.string(),
  sponsorName: z.string(),
  sponsorFundName: z.string().nullable(),
  vehicleName: z.string(),
  dealType: z.string(),
  entryDate: isoDate,
  exitDate: isoDate.nullable(),
  isActive: z.boolean(),
  invested: decimalString.nullable(),
  distributions: decimalString.nullable(),
  nav: decimalString.nullable(),
  navDate: isoDate.nullable(),
  grossMoic: decimalString.nullable(),
  grossIrr: decimalString.nullable(),
  irrFlag: z
    .enum([
      'short_period',
      'multiple_irr',
      'no_root',
      'same_sign',
      'insufficient_flows',
      'no_convergence',
    ])
    .nullable(),
  calcVersion: z.string(),
});
export type InvestmentSummary = z.infer<typeof investmentSummary>;

export const investmentPage = z.object({
  items: z.array(investmentSummary),
  nextCursor: z.string().nullable(),
  asOf: isoDate,
});
export type InvestmentPage = z.infer<typeof investmentPage>;

export const investmentDetail = investmentSummary.extend({
  companyId: uuid,
  sponsorId: uuid,
  vehicleId: uuid,
  sector: z.string().nullable(),
  geography: z.string().nullable(),
  latestPeriodEnd: isoDate.nullable(),
  cashFlows: z.array(z.object({ date: isoDate, flowType: z.string(), amount: decimalString })),
  valuations: z.array(
    z.object({
      periodEnd: isoDate,
      version: z.number().int(),
      state: z.string(),
      fairValue: decimalString,
      method: z.string(),
    }),
  ),
  credit: z
    .object({
      facilityType: z.string(),
      baseRate: z.string(),
      spread: decimalString,
      cashCoupon: decimalString,
      pikCoupon: decimalString,
      maturityDate: isoDate,
      latest: z
        .object({
          periodEnd: isoDate,
          parValue: decimalString.nullable(),
          fairValue: decimalString.nullable(),
          currentYield: decimalString.nullable(),
          interestCoverage: decimalString.nullable(),
          leverageThroughTranche: decimalString.nullable(),
          loanToValue: decimalString.nullable(),
          covenantStatus: z.string().nullable(),
          paymentStatus: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  operating: z
    .object({
      periodEnd: isoDate,
      revenueLtm: decimalString.nullable(),
      ebitdaLtm: decimalString.nullable(),
      ev: decimalString.nullable(),
      netDebt: decimalString.nullable(),
      evToEbitda: decimalString.nullable(),
      netDebtToEbitda: decimalString.nullable(),
      ebitdaMargin: decimalString.nullable(),
      revenueYoy: decimalString.nullable(),
      ebitdaYoy: decimalString.nullable(),
      priorYearPeriodEnd: isoDate.nullable(),
    })
    .nullable(),
});
export type InvestmentDetail = z.infer<typeof investmentDetail>;

export const sponsorSummary = z.object({
  id: uuid,
  name: z.string(),
  tier: z.string(),
  hqGeography: z.string().nullable(),
  fundCount: z.number().int(),
  activeInvestments: z.number().int(),
});
export const sponsorPage = z.object({
  items: z.array(sponsorSummary),
  nextCursor: z.string().nullable(),
});

export const vehicleSummary = z.object({
  id: uuid,
  name: z.string(),
  vehicleType: z.string(),
  vintage: z.number().int().nullable(),
  activeInvestments: z.number().int(),
  /** LP commitment total, visible only to roles entitled to client data; null otherwise. */
  lpCommitmentsTotal: decimalString.nullable(),
});
export const vehicleList = z.object({ items: z.array(vehicleSummary) });

export const dataHealth = z.object({
  asOf: isoDate,
  orphanInvestments: z.number().int(),
  openExceptions: z.number().int(),
  staleInvestments: z.number().int(),
  staleAfterDays: z.number().int(),
  vehiclesWithOwnershipGap: z.array(
    z.object({ vehicleName: z.string(), ownershipTotal: decimalString }),
  ),
  lockedValuationsLatestQuarter: z.number().int(),
  activeInvestments: z.number().int(),
});
export type DataHealth = z.infer<typeof dataHealth>;

export const dataDictionary = z.object({
  source: z.literal('config/definitions.json'),
  definitions: z.record(z.string(), z.unknown()),
});
