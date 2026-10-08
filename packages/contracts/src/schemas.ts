import { z } from 'zod';

/** Money, rates and multiples travel as decimal strings; the missing placeholder is null (docs/06 section 3). */
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when a YYYY-MM-DD string names a real day: set as a UTC date, it reads back unchanged, so
 * 2025-02-30 (which UTC rolls over to March 2) and 2025-13-01 are not days.
 */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const day = new Date(0);
  day.setUTCFullYear(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8)),
  );
  return day.toISOString().slice(0, 10) === value;
}

/**
 * A calendar date (YYYY-MM-DD) that exists, so an impossible date is a 400 'validation' at the
 * boundary instead of an error deep in Postgres or packages/calc. The calendar check judges only
 * strings of the right shape (the pattern reports the rest), and the OpenAPI document carries
 * format date.
 */
export const isoDate = z
  .string()
  .regex(ISO_DATE)
  .refine((value) => !ISO_DATE.test(value) || isCalendarDate(value), 'Not a real calendar date')
  .meta({ format: 'date' });
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

/**
 * One row of the portfolio grid (M9 metrics from packages/calc, null where not calculable). The
 * vehicle and sponsor ids let a page link a position to its vehicle and sponsor.
 */
export const investmentSummary = z.object({
  id: uuid,
  investmentNumber: z.string(),
  companyName: z.string(),
  sponsorId: uuid,
  sponsorName: z.string(),
  sponsorFundName: z.string().nullable(),
  vehicleId: uuid,
  vehicleName: z.string(),
  dealType: z.string(),
  sector: z.string().nullable(),
  geography: z.string().nullable(),
  /** Entry year, the vintage used for cohort views. */
  vintage: z.number().int(),
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

/** The summary row (vehicle and sponsor ids included) plus the detail the workspace tabs read. */
export const investmentDetail = investmentSummary.extend({
  companyId: uuid,
  sponsorFundId: uuid.nullable(),
  companyDescription: z.string().nullable(),
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

/* ------------------------------------------------------------------------------------------------
 * Shared pieces for the aggregate views (vehicles, sponsors, clients, analytics, reports).
 * ---------------------------------------------------------------------------------------------- */

export const irrFlag = investmentSummary.shape.irrFlag;

/** Pooled gross metrics over a set of positions: flows pooled, NAV summed, IRR over the pooled flows (docs/08). */
export const pooledMetrics = z.object({
  count: z.number().int(),
  invested: decimalString.nullable(),
  distributions: decimalString.nullable(),
  nav: decimalString.nullable(),
  dpi: decimalString.nullable(),
  rvpi: decimalString.nullable(),
  tvpi: decimalString.nullable(),
  grossMoic: decimalString.nullable(),
  grossIrr: decimalString.nullable(),
  irrFlag,
});
export type PooledMetrics = z.infer<typeof pooledMetrics>;

export const seriesPoint = z.object({ periodEnd: isoDate, value: decimalString.nullable() });
export type SeriesPoint = z.infer<typeof seriesPoint>;

export const flowSeriesPoint = z.object({
  period: z.string(),
  contributions: decimalString,
  distributions: decimalString,
  net: decimalString,
  cumulativeNet: decimalString,
});

export const exposureBucket = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
  invested: decimalString.nullable(),
  nav: decimalString.nullable(),
  /** Share of total NAV, a rate between 0 and 1; null when total NAV is not calculable. */
  navShare: decimalString.nullable(),
});
export type ExposureBucket = z.infer<typeof exposureBucket>;

/**
 * One vehicle's NAV split by deal type (the stacked chart on the Exposure tab). Segments are
 * exposure buckets keyed by deal type code with taxonomy labels; their NAV shares are of the total
 * active NAV, like every other bucket.
 */
export const vehicleDealTypeRow = z.object({
  /** The vehicle id, the same key as the vehicle's bucket in exposures.vehicle. */
  key: uuid,
  label: z.string(),
  segments: z.array(exposureBucket),
});
export type VehicleDealTypeRow = z.infer<typeof vehicleDealTypeRow>;

export const asOfQuery = z.object({ asOf: isoDate.optional() }).strict();

/* ---- Analytics (M12 portfolio analysis, M13 in-app analytics) ---- */

export const analyticsSummary = z.object({
  asOf: isoDate,
  activeInvestments: z.number().int(),
  realizedInvestments: z.number().int(),
  /** Over every visible position, active and realized. */
  totals: pooledMetrics,
  /** Over active positions only. */
  active: pooledMetrics,
  /** Over realized positions only. */
  realized: pooledMetrics,
  exposures: z.object({
    sector: z.array(exposureBucket),
    geography: z.array(exposureBucket),
    dealType: z.array(exposureBucket),
    vehicle: z.array(exposureBucket),
    sponsor: z.array(exposureBucket),
    vintage: z.array(exposureBucket),
    /**
     * NAV per vehicle and deal type over the active positions with a Locked mark, as Decimal sums
     * (a position without one is left out). Vehicles by total NAV, largest first, then name;
     * each vehicle's segments in the order of the dealType buckets. Segment NAVs sum to the
     * vehicle's NAV in `vehicle`; a vehicle with no Locked mark at all has no row.
     */
    vehicleByDealType: z.array(vehicleDealTypeRow),
  }),
  /** Sum of Locked fair values per quarter end over visible positions, oldest first. */
  navSeries: z.array(seriesPoint),
  /** Investment-level cash flows grouped by calendar year, oldest first. */
  flowsByYear: z.array(flowSeriesPoint),
  topPositions: z.array(
    z.object({
      id: uuid,
      investmentNumber: z.string(),
      companyName: z.string(),
      vehicleName: z.string(),
      nav: decimalString.nullable(),
      navShare: decimalString.nullable(),
      grossMoic: decimalString.nullable(),
    }),
  ),
  calcVersion: z.string(),
});
export type AnalyticsSummary = z.infer<typeof analyticsSummary>;

/* ---- Vehicles, commitments, clients (M17, decision 0004) ---- */

export const fundCommitmentRow = z.object({
  id: uuid,
  vehicleId: uuid,
  vehicleName: z.string(),
  vehicleType: z.string(),
  sponsorId: uuid,
  sponsorName: z.string(),
  sponsorFundId: uuid,
  sponsorFundName: z.string(),
  vintage: z.number().int().nullable(),
  strategy: z.string().nullable(),
  /** Set only for client-directed (separate account) commitments the caller is entitled to see. */
  clientName: z.string().nullable(),
  amount: decimalString,
  called: decimalString.nullable(),
  distributed: decimalString.nullable(),
  recallable: decimalString.nullable(),
  unfunded: decimalString.nullable(),
  commitmentDate: isoDate,
});
export type FundCommitmentRow = z.infer<typeof fundCommitmentRow>;

export const commitmentList = z.object({
  asOf: isoDate,
  items: z.array(fundCommitmentRow),
  totals: z.object({
    amount: decimalString.nullable(),
    called: decimalString.nullable(),
    distributed: decimalString.nullable(),
    unfunded: decimalString.nullable(),
  }),
  calcVersion: z.string(),
});
export type CommitmentList = z.infer<typeof commitmentList>;

export const lpCommitmentRow = z.object({
  clientId: uuid,
  clientName: z.string(),
  amount: decimalString,
  closingNumber: z.number().int(),
  ownershipPct: decimalString.nullable(),
  commitmentDate: isoDate,
});

export const vehicleDetail = vehicleSummary.extend({
  asOf: isoDate,
  currency: z.string(),
  closingCount: z.number().int(),
  finalCloseDate: isoDate.nullable(),
  metrics: pooledMetrics,
  positions: z.array(investmentSummary),
  fundCommitments: z.array(fundCommitmentRow),
  /** Null when the caller is not entitled to client data (never an empty list in that case). */
  lpCommitments: z.array(lpCommitmentRow).nullable(),
  navSeries: z.array(seriesPoint),
  calcVersion: z.string(),
});
export type VehicleDetail = z.infer<typeof vehicleDetail>;

export const clientVehicleShare = z.object({
  vehicleId: uuid,
  vehicleName: z.string(),
  vehicleType: z.string(),
  commitment: decimalString,
  closingNumber: z.number().int(),
  ownershipPct: decimalString.nullable(),
  commitmentDate: isoDate,
  /** The client's share of the vehicle's pooled figures: position times ownership (docs/03 section 4). */
  invested: decimalString.nullable(),
  distributions: decimalString.nullable(),
  nav: decimalString.nullable(),
  grossMoic: decimalString.nullable(),
});

export const clientSummary = z.object({
  id: uuid,
  name: z.string(),
  reportingBases: z.array(z.string()),
  reportingCadence: z.string(),
  vehicles: z.array(clientVehicleShare),
  totals: z.object({
    commitment: decimalString.nullable(),
    invested: decimalString.nullable(),
    distributions: decimalString.nullable(),
    nav: decimalString.nullable(),
    grossMoic: decimalString.nullable(),
  }),
});
export type ClientSummary = z.infer<typeof clientSummary>;

export const clientList = z.object({
  asOf: isoDate,
  items: z.array(clientSummary),
  calcVersion: z.string(),
});
export type ClientList = z.infer<typeof clientList>;

/* ---- Sponsors (M6 relationship intelligence, firm-side data only in the prototype) ---- */

export const sponsorFundRow = z.object({
  id: uuid,
  name: z.string(),
  vintage: z.number().int().nullable(),
  strategy: z.string().nullable(),
  sizeTarget: decimalString.nullable(),
  sizeFinal: decimalString.nullable(),
  currency: z.string(),
  aliases: z.array(z.string()),
  holdings: z.number().int(),
  ourPositions: z.number().int(),
  /** Our commitment to this fund across visible commitments; null when none. */
  ourCommitment: decimalString.nullable(),
});

export const sponsorDetail = sponsorSummary.extend({
  /** The date the positions, commitment flows and pooled metrics are calculated as of. */
  asOf: isoDate,
  description: z.string().nullable(),
  funds: z.array(sponsorFundRow),
  positions: z.array(investmentSummary),
  commitments: z.array(fundCommitmentRow),
  metrics: pooledMetrics,
  totalCommitted: decimalString.nullable(),
  calcVersion: z.string(),
});
export type SponsorDetail = z.infer<typeof sponsorDetail>;
export type SponsorSummary = z.infer<typeof sponsorSummary>;
export type VehicleSummary = z.infer<typeof vehicleSummary>;

/* ---- Valuations (M10) ---- */

export const valuationState = z.enum([
  'Draft',
  'OpsPrepared',
  'DealTeamApproved',
  'Locked',
  'Reopened',
]);
export type ValuationState = z.infer<typeof valuationState>;

export const valuationListQuery = pageQuery.extend({
  periodEnd: isoDate.optional(),
  state: valuationState.optional(),
  investmentId: uuid.optional(),
  vehicleId: uuid.optional(),
  asOf: isoDate.optional(),
});

export const valuationRow = z.object({
  id: uuid,
  investmentId: uuid,
  investmentNumber: z.string(),
  companyName: z.string(),
  vehicleName: z.string(),
  dealType: z.string(),
  periodEnd: isoDate,
  version: z.number().int(),
  state: valuationState,
  method: z.string(),
  fairValue: decimalString,
  /** Latest Locked fair value for the previous quarter end, when one exists. */
  priorFairValue: decimalString.nullable(),
  changePct: decimalString.nullable(),
  lockHash: z.string().nullable(),
  preparedBy: z.string().nullable(),
  dealTeamApprovedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  reopenReason: z.string().nullable(),
  rowVersion: z.number().int(),
});
export type ValuationRow = z.infer<typeof valuationRow>;

export const valuationPage = z.object({
  items: z.array(valuationRow),
  nextCursor: z.string().nullable(),
  asOf: isoDate,
  /** Distinct period ends visible to the caller, latest first. */
  periods: z.array(isoDate),
});
export type ValuationPage = z.infer<typeof valuationPage>;

/* ---- Capital activity (M16) ---- */

export const capitalNoticeState = z.enum([
  'Received',
  'Extracted',
  'Reviewed',
  'TicketDrafted',
  'TicketApproved',
  'Funded',
  'Reconciled',
]);
export type CapitalNoticeState = z.infer<typeof capitalNoticeState>;

export const capitalNoticeListQuery = pageQuery.extend({
  state: capitalNoticeState.optional(),
  vehicleId: uuid.optional(),
  investmentId: uuid.optional(),
  noticeType: z.string().optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  asOf: isoDate.optional(),
});

export const capitalNoticeRow = z.object({
  id: uuid,
  noticeType: z.string(),
  state: capitalNoticeState,
  vehicleId: uuid,
  vehicleName: z.string(),
  investmentId: uuid.nullable(),
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  commitmentId: uuid.nullable(),
  sponsorFundName: z.string().nullable(),
  issueDate: isoDate,
  dueDate: isoDate,
  amount: decimalString,
  currency: z.string(),
  split: z.record(z.string(), decimalString),
  scenarioTag: z.string().nullable(),
  /** Sum of approved cash flows created from this notice; null when none yet. */
  settledAmount: decimalString.nullable(),
  /** Days from the as-of date to the due date; negative when overdue. */
  daysToDue: z.number().int(),
  rowVersion: z.number().int(),
});
export type CapitalNoticeRow = z.infer<typeof capitalNoticeRow>;

export const capitalNoticePage = z.object({
  items: z.array(capitalNoticeRow),
  nextCursor: z.string().nullable(),
  asOf: isoDate,
  /** Notices that need attention: not Reconciled, or due within the alert window. */
  attention: z.array(capitalNoticeRow),
  alertDaysBeforeDue: z.number().int(),
});
export type CapitalNoticePage = z.infer<typeof capitalNoticePage>;

export const capitalNoticeDetail = capitalNoticeRow.extend({
  cashFlows: z.array(
    z.object({ date: isoDate, flowType: z.string(), amount: decimalString, status: z.string() }),
  ),
  /** Set when the sponsor's wire instructions changed inside the hold window (SEC-12.3). */
  wireChangeHold: z.object({ until: isoDate, holdDays: z.number().int() }).nullable(),
  notes: z.array(z.string()),
});
export type CapitalNoticeDetail = z.infer<typeof capitalNoticeDetail>;

/* ---- Investment performance series (M9 Performance tab) ---- */

export const quarterRow = z.object({
  periodEnd: isoDate,
  isEntrySnapshot: z.boolean(),
  status: z.string(),
  revenueLtm: decimalString.nullable(),
  ebitdaLtm: decimalString.nullable(),
  ev: decimalString.nullable(),
  netDebt: decimalString.nullable(),
  cash: decimalString.nullable(),
  totalEquity: decimalString.nullable(),
  evToEbitda: decimalString.nullable(),
  netDebtToEbitda: decimalString.nullable(),
  ebitdaMargin: decimalString.nullable(),
  revenueYoy: decimalString.nullable(),
  ebitdaYoy: decimalString.nullable(),
  highlights: z.array(z.string()),
});
export type QuarterRow = z.infer<typeof quarterRow>;

export const creditQuarterRow = z.object({
  periodEnd: isoDate,
  parValue: decimalString.nullable(),
  costBasis: decimalString.nullable(),
  fairValue: decimalString.nullable(),
  accruedInterest: decimalString.nullable(),
  cashInterestLtm: decimalString.nullable(),
  pikCapitalizedLtm: decimalString.nullable(),
  principalRepaidLtm: decimalString.nullable(),
  fundedAmount: decimalString.nullable(),
  ebitdaLtm: decimalString.nullable(),
  cashInterestExpenseLtm: decimalString.nullable(),
  netDebtThroughTranche: decimalString.nullable(),
  ev: decimalString.nullable(),
  currentYield: decimalString.nullable(),
  interestCoverage: decimalString.nullable(),
  leverageThroughTranche: decimalString.nullable(),
  loanToValue: decimalString.nullable(),
  covenantStatus: z.string().nullable(),
  paymentStatus: z.string().nullable(),
});

export const creditTermsDetail = z.object({
  facilityType: z.string(),
  seniorityRank: z.number().int(),
  commitmentAmount: decimalString.nullable(),
  baseRate: z.string(),
  floor: decimalString.nullable(),
  spread: decimalString,
  cashCoupon: decimalString,
  pikCoupon: decimalString,
  oid: decimalString.nullable(),
  upfrontFee: decimalString.nullable(),
  maturityDate: isoDate,
  paymentFrequency: z.string(),
  effectiveDate: isoDate,
  amortization: z.array(z.object({ date: isoDate, amount: decimalString })),
  callProtection: z.array(z.object({ until: isoDate, premium: decimalString })),
  covenants: z.array(z.object({ name: z.string(), level: decimalString, test: z.string() })),
  allInCoupon: decimalString.nullable(),
  yieldToMaturity: decimalString.nullable(),
  pastMaturity: z.boolean(),
});

export const investmentPerformance = z.object({
  investmentId: uuid,
  asOf: isoDate,
  entry: quarterRow.nullable(),
  quarters: z.array(quarterRow),
  /** Ratios of the latest approved quarter against the entry snapshot (docs/08 section 4). */
  sinceEntry: z
    .object({
      periodEnd: isoDate,
      revenueGrowth: decimalString.nullable(),
      ebitdaGrowth: decimalString.nullable(),
      multipleDelta: decimalString.nullable(),
      evToEbitdaAtEntry: decimalString.nullable(),
      netDebtToEbitdaAtEntry: decimalString.nullable(),
    })
    .nullable(),
  credit: z.object({ terms: creditTermsDetail, quarters: z.array(creditQuarterRow) }).nullable(),
  realizationOutlook: z
    .object({
      horizonMonths: z.number().int(),
      outlook: z.string(),
      note: z.string().nullable(),
      setAt: z.string().nullable(),
    })
    .nullable(),
  calcVersion: z.string(),
});
export type InvestmentPerformance = z.infer<typeof investmentPerformance>;

/* ---- Monitoring watchlist (M9, thresholds from config/definitions.json) ---- */

export const watchFlagCode = z.enum([
  'no_locked_valuation',
  'stale_valuation',
  'missing_prior_year',
  'negative_ebitda',
  'leverage_above_max',
  'ebitda_decline',
  'markdown',
  'covenant_breach',
  'covenant_waiver',
  'payment_not_current',
  'maturity_within_12_months',
  'past_maturity',
]);
export type WatchFlagCode = z.infer<typeof watchFlagCode>;

export const watchFlag = z.object({
  code: watchFlagCode,
  severity: z.enum(['watch', 'bad']),
  message: z.string(),
  value: decimalString.nullable(),
  threshold: decimalString.nullable(),
});

export const watchlistItem = z.object({
  investmentId: uuid,
  investmentNumber: z.string(),
  companyName: z.string(),
  vehicleName: z.string(),
  dealType: z.string(),
  flags: z.array(watchFlag),
});
export type WatchlistItem = z.infer<typeof watchlistItem>;

export const watchlist = z.object({
  asOf: isoDate,
  thresholds: z.record(z.string(), z.union([z.number(), z.string()])),
  items: z.array(watchlistItem),
  counts: z.object({ watch: z.number().int(), bad: z.number().int(), clear: z.number().int() }),
  calcVersion: z.string(),
});
export type Watchlist = z.infer<typeof watchlist>;

/* ---- Audit, taxonomy, walls (SEC-11, SEC-5.3) ---- */

export const auditQuery = pageQuery.extend({
  entity: z.string().optional(),
  entityId: uuid.optional(),
  action: z.string().optional(),
});

export const auditEventRow = z.object({
  id: z.string(),
  at: z.string(),
  actorName: z.string().nullable(),
  actorType: z.string(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  reason: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type AuditEventRow = z.infer<typeof auditEventRow>;

export const auditPage = z.object({
  items: z.array(auditEventRow),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditPage>;

export const taxonomy = z.object({
  domains: z.array(
    z.object({
      domain: z.string(),
      terms: z.array(
        z.object({
          code: z.string(),
          label: z.string(),
          parentCode: z.string().nullable(),
          active: z.boolean(),
          sortOrder: z.number().int(),
        }),
      ),
    }),
  ),
});
export type Taxonomy = z.infer<typeof taxonomy>;

export const wallList = z.object({
  walls: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      description: z.string().nullable(),
      members: z.array(z.object({ userId: uuid, displayName: z.string() })),
      records: z.array(
        z.object({ entity: z.string(), entityId: uuid, label: z.string().nullable() }),
      ),
    }),
  ),
});
export type WallList = z.infer<typeof wallList>;

/* ---- Weekly report (M12) ---- */

export const weeklyReport = z.object({
  asOf: isoDate,
  /** Latest quarter end on or before the as-of date. */
  periodEnd: isoDate,
  preparedFor: z.string(),
  summary: pooledMetrics.extend({ activeInvestments: z.number().int() }),
  byVehicle: z.array(
    z.object({
      vehicleId: uuid,
      vehicleName: z.string(),
      vehicleType: z.string(),
      count: z.number().int(),
      invested: decimalString.nullable(),
      distributions: decimalString.nullable(),
      nav: decimalString.nullable(),
      grossMoic: decimalString.nullable(),
    }),
  ),
  /** Largest Locked fair value changes against the prior quarter, up and down. */
  movers: z.array(
    z.object({
      investmentId: uuid,
      investmentNumber: z.string(),
      companyName: z.string(),
      periodEnd: isoDate,
      priorFairValue: decimalString.nullable(),
      fairValue: decimalString,
      changePct: decimalString.nullable(),
    }),
  ),
  staleValuations: z.array(
    z.object({
      investmentId: uuid,
      investmentNumber: z.string(),
      companyName: z.string(),
      latestLockedPeriodEnd: isoDate.nullable(),
      footnote: z.string(),
    }),
  ),
  capitalActivity: z.array(capitalNoticeRow),
  /** Deterministic commentary assembled from the figures above; never a model call in the prototype. */
  commentary: z.object({
    paragraphs: z.array(z.string()),
    source: z.enum(['template', 'mock_assistant']),
    aiDraft: z.boolean(),
  }),
  footnotes: z.array(z.string()),
  calcVersion: z.string(),
});
export type WeeklyReport = z.infer<typeof weeklyReport>;
