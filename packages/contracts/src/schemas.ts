import { ISO_DATE, isCalendarDate, isQuarterEnd } from '@pb/calc';
import { z } from 'zod';

/** A decimal amount or rate as text, never a float: the one pattern every reader checks against. */
export const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** Money, rates and multiples travel as decimal strings; the missing placeholder is null (docs/06 section 3). */
export const decimalString = z.string().regex(DECIMAL_PATTERN);

/**
 * A calendar date (YYYY-MM-DD) that exists, so an impossible date is a 400 'validation' at the
 * boundary instead of an error deep in Postgres or packages/calc. The calendar check is
 * packages/calc's isCalendarDate, the one every package judges a date by (CLAUDE.md rule 7); it
 * judges only strings of the right shape (the pattern reports the rest), and the OpenAPI document
 * carries format date.
 */
export const isoDate = z
  .string()
  .regex(ISO_DATE)
  .refine((value) => !ISO_DATE.test(value) || isCalendarDate(value), 'Not a real calendar date')
  .meta({ format: 'date' });
export const uuid = z.string().uuid();

/**
 * A control character other than tab, line feed and carriage return. The database refuses a NUL
 * byte in any text parameter (an error from inside the query, so a 500), and none of the others
 * belong in a value a person typed, so the boundary refuses them as a 400 'validation'.
 */
const FORBIDDEN_CONTROL = /[^\P{Cc}\t\n\r]/u;
const CONTROL_MESSAGE = 'Control characters are not allowed';

/** Free text a person writes, such as a reason: bounded, with no control characters beyond whitespace. */
export const plainText = (max: number): z.ZodString =>
  z
    .string()
    .max(max)
    .refine((value) => !FORBIDDEN_CONTROL.test(value), CONTROL_MESSAGE);

/** A code or name a list is filtered by: one bounded line of text, matched exactly, never empty. */
export const filterText = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !FORBIDDEN_CONTROL.test(value), CONTROL_MESSAGE);

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
  .object({ enabled: z.boolean(), reason: plainText(500).min(3) })
  .strict();

export const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Opaque, from the previous page's nextCursor; each list checks it against its own key shape. */
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export const investmentListQuery = pageQuery.extend({
  vehicleId: uuid.optional(),
  dealType: filterText.optional(),
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
  /**
   * Years from the first contribution to the exit (realized) or the as-of date (held), in 365-day
   * years (docs/08 section 2); null without a contribution on or before the as-of date.
   */
  holdingPeriodYears: decimalString.nullable(),
  invested: decimalString.nullable(),
  distributions: decimalString.nullable(),
  nav: decimalString.nullable(),
  navDate: isoDate.nullable(),
  grossMoic: decimalString.nullable(),
  grossIrr: decimalString.nullable(),
  /** Why grossIrr is missing or not meaningful; no_valuation: something still held has no Locked mark. */
  irrFlag: z
    .enum([
      'short_period',
      'multiple_irr',
      'no_root',
      'same_sign',
      'insufficient_flows',
      'no_convergence',
      'no_valuation',
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
/** One approved quarter's figures and the ratios docs/08 section 4 derives from them. */
export const operatingPeriod = z.object({
  periodEnd: isoDate,
  revenueLtm: decimalString.nullable(),
  ebitdaLtm: decimalString.nullable(),
  ev: decimalString.nullable(),
  netDebt: decimalString.nullable(),
  evToEbitda: decimalString.nullable(),
  netDebtToEbitda: decimalString.nullable(),
  ebitdaMargin: decimalString.nullable(),
});

export const investmentDetail = investmentSummary.extend({
  companyId: uuid,
  sponsorFundId: uuid.nullable(),
  /**
   * The close date from the closing record (deal.closing), the single source of every close date
   * (docs/04 M8); null when no closing names the position. Defaults to null on parse so responses
   * recorded before Phase 3 still read.
   */
  closeDate: isoDate.nullable().default(null),
  /**
   * The pipeline record the position came from (deal.opportunity.investment_id) and the closing
   * record that carries its close date (deal.closing.investment_id); null for a position that
   * predates the pipeline or whose records sit behind a wall. Both default to null on parse for
   * the same reason closeDate does.
   */
  opportunityId: uuid.nullable().default(null),
  closingId: uuid.nullable().default(null),
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
  operating: operatingPeriod
    .extend({
      revenueYoy: decimalString.nullable(),
      ebitdaYoy: decimalString.nullable(),
      /**
       * The same fiscal quarter one year earlier, exactly (docs/08 section 5), with its own
       * figures; null when it is not on record, never the nearest quarter.
       */
      priorYear: operatingPeriod.nullable(),
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
  /**
   * NAV at each calendar quarter end, oldest first, the latest `analytics.navSeriesQuarters`
   * points: every visible position held then at its latest Locked mark for that quarter or an
   * earlier one. Null for a quarter end at which a held position has no Locked mark yet (docs/08
   * section 2), never a partial sum.
   */
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
  /** The analytics NAV series rule over this vehicle's positions (docs/08 section 2). */
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
  /**
   * A quarter end selects every version that reports for that quarter (quarterEnd), including a
   * sponsor reporting a few days either side of it; any other date matches that period end exactly.
   */
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
  /**
   * The calendar quarter end this version reports for: the period end folded to the nearest
   * quarter end when within priorYearPeriodEndToleranceDays (a sponsor that closes its books a few
   * days early), otherwise the period end itself. The same rule as the NAV series.
   */
  quarterEnd: isoDate,
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
  /** Distinct quarter ends (quarterEnd) of the versions visible to the caller, latest first. */
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
  noticeType: filterText.optional(),
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
  /**
   * Approved cash flows created from this notice up to the as-of date, in the notice's own
   * direction (unsigned like amount); null when none yet.
   */
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

/**
 * Where a quarter's figures came from (the lineage columns of mon.quarterly_performance, SEC-9.4,
 * docs/11 I1 click-to-source): the document, the extraction run that read it when one did, the
 * page the leading figure sits on and the locator inside it. Null for a quarter with no source
 * document, such as the synthetic seed or an accounting import.
 */
export const quarterSource = z.object({
  documentId: uuid,
  runId: uuid.nullable(),
  page: z.number().int().nullable(),
  locator: z.string().nullable(),
});
export type QuarterSource = z.infer<typeof quarterSource>;

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
  source: quarterSource.nullable(),
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
  entity: filterText.optional(),
  entityId: uuid.optional(),
  action: filterText.optional(),
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

/* ---- Intake: staging, validation, approval, then production (M2, SEC-9.1) ---- */

/** docs/18 section 2. A row moves new > validated | flagged > approved > promoted; rejected is terminal. */
export const stagingState = z.enum([
  'new',
  'validated',
  'flagged',
  'approved',
  'rejected',
  'promoted',
]);
export type StagingState = z.infer<typeof stagingState>;

export const intakeFinding = z.object({
  /** A packages/validation rule id, such as TIE-01, or LAYOUT-01 for a file-level problem. */
  ruleId: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  field: z.string().nullable(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
});
export type IntakeFinding = z.infer<typeof intakeFinding>;

export const intakeLink = z.object({
  /** docs/03 section 5: matched by number or exact name; never linked from a near miss or a guarded pair. */
  status: z.enum(['matched', 'unmatched', 'guarded', 'ambiguous']),
  investmentId: uuid.nullable(),
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  candidates: z.array(
    z.object({
      investmentNumber: z.string(),
      companyName: z.string(),
      reason: z.enum(['near miss', 'match guard']),
    }),
  ),
});
export type IntakeLink = z.infer<typeof intakeLink>;

export const intakeChange = z.object({
  field: z.enum(['revenueLtm', 'ebitdaLtm', 'ev', 'netDebt']),
  /** The file's text and the record's figure; text so the reviewer sees what the file said. */
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type IntakeChange = z.infer<typeof intakeChange>;

export const intakeRow = z.object({
  id: uuid,
  /** The file's data line, the row's own locator for lineage. */
  rowNo: z.number().int(),
  /** The layout's key columns joined with a pipe: the idempotency key within a file. */
  naturalKey: z.string(),
  targetEntity: z.literal('quarterly_performance'),
  /** The quarterly performance row the import would replace, once linked; null for a new quarter. */
  targetId: uuid.nullable(),
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  periodEnd: z.string().nullable(),
  figures: z.object({
    revenueLtm: z.string().nullable(),
    ebitdaLtm: z.string().nullable(),
    ev: z.string().nullable(),
    netDebt: z.string().nullable(),
    fairValue: z.string().nullable(),
  }),
  link: intakeLink,
  diff: z.object({
    kind: z.enum(['new', 'changed', 'unchanged']),
    changes: z.array(intakeChange),
  }),
  findings: z.array(intakeFinding),
  status: stagingState,
  /** The reviewer's reason on a rejection, or the approval note. */
  decision: z.string().nullable(),
  decidedBy: z.string().nullable(),
  promotedAt: z.string().nullable(),
});
export type IntakeRow = z.infer<typeof intakeRow>;

export const intakeCounts = z.object({
  new: z.number().int(),
  validated: z.number().int(),
  flagged: z.number().int(),
  approved: z.number().int(),
  rejected: z.number().int(),
  promoted: z.number().int(),
});
export type IntakeCounts = z.infer<typeof intakeCounts>;

/**
 * Where an intake file came from (stg.intake_file.source): the accounting export, the weekly
 * report values, a look-through reconcile run or an operations workbook drop (docs/04 M2).
 */
export const intakeSource = z.enum(['accounting', 'weekly', 'lookthrough', 'ops_drop']);
export type IntakeSource = z.infer<typeof intakeSource>;

/**
 * An intake file. Its status sums up its rows: flagged while any row is flagged, validated while
 * any row waits for approval, promoted once every row is promoted or rejected (rejected when all
 * are), and new only while the file itself was refused (fileFindings) and holds no rows.
 */
export const intakeFile = z.object({
  id: uuid,
  source: intakeSource,
  fileName: z.string(),
  /** SHA-256 of the file text, the idempotency key with the source (docs/04 M2). */
  contentHash: z.string(),
  /**
   * The ops-drop template the workbook matched (config/ops_drop_templates.json); null for every
   * other source. Optional until every producer sets it (the accounting intake and the preview
   * were written before it existed); a reader treats an absent value as null.
   */
  templateSignature: z.string().nullable(),
  receivedAt: z.string(),
  receivedBy: z.string().nullable(),
  rowCount: z.number().int(),
  status: stagingState,
  counts: intakeCounts,
  fileFindings: z.array(intakeFinding),
  /** Data exceptions the import opened (unmatched or guarded names, fair values that do not tie). */
  exceptions: z.number().int(),
  rowVersion: z.number().int(),
});
export type IntakeFile = z.infer<typeof intakeFile>;

export const intakeFileDetail = intakeFile.extend({
  /** The staged rows the caller may see, in file order. */
  rows: z.array(intakeRow),
  /** Rows linked to investments not visible to the caller; never a reason to show them. */
  hiddenRows: z.number().int(),
});
export type IntakeFileDetail = z.infer<typeof intakeFileDetail>;

export const intakeFilePage = z.object({
  items: z.array(intakeFile),
  nextCursor: z.string().nullable(),
});
export type IntakeFilePage = z.infer<typeof intakeFilePage>;

export const intakeFileListQuery = pageQuery.extend({
  status: stagingState.optional(),
  source: intakeSource.optional(),
});

/** An export the accounting system dropped in the folder the adapter watches. */
export const intakeExportList = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), receivedAt: z.string() })),
});
export type IntakeExportList = z.infer<typeof intakeExportList>;

/** Import an export: the file's text as uploaded, or one the adapter lists by id. */
export const intakeImportBody = z.union([
  z
    .object({
      fileName: plainText(200).min(1),
      /** The CSV as text; the API refuses more than definitions.intake.maxFileBytes. */
      csv: z.string().min(1).max(2_000_000),
    })
    .strict(),
  z.object({ exportId: plainText(200).min(1) }).strict(),
]);
export type IntakeImportBody = z.infer<typeof intakeImportBody>;

/** The staged file, with `duplicate` true when the same content was imported before (nothing new was staged). */
export const intakeImportResult = intakeFileDetail.extend({ duplicate: z.boolean() });
export type IntakeImportResult = z.infer<typeof intakeImportResult>;

export const intakeCommand = z.enum(['approve', 'reject']);
export type IntakeCommand = z.infer<typeof intakeCommand>;

/**
 * approve: every validated row (or the rows named) becomes approved and is promoted in the same
 * transaction with an audit event per row. reject: every flagged row (or the rows named) is
 * rejected with the reason, which is required.
 */
export const intakeCommandBody = z
  .object({
    command: intakeCommand,
    reason: plainText(500).min(3).optional(),
    rowIds: z.array(uuid).min(1).max(5000).optional(),
  })
  .strict();
export type IntakeCommandBody = z.infer<typeof intakeCommandBody>;

/* ---- Weekly report values (M2 weekly-report-intake, docs/18 sections 1 and 2) ---- */

/**
 * What a weekly value is compared with: the latest Locked mark on record, or the weekly value
 * promoted before it when no Locked mark is newer.
 */
export const weeklyPriorSource = z.enum(['locked_mark', 'weekly']);
export type WeeklyPriorSource = z.infer<typeof weeklyPriorSource>;

/**
 * One staged weekly value (stg.valuation). Cells stay text as the file wrote them: a reviewer sees
 * exactly what the report said, and a cell that is not a date or a decimal is null here and named
 * by a finding, never guessed. On approval the value becomes a Draft valuation of method
 * weekly_report through the valuation machine (valuationId); a Locked mark is never touched.
 */
export const weeklyRow = z.object({
  id: uuid,
  /** The file's data line, the row's own locator for lineage. */
  rowNo: z.number().int(),
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  /** The report date as the file wrote it (YYYY-MM-DD when it is a real day). */
  reportDate: z.string().nullable(),
  /** The reported value as the file wrote it, a decimal string when it is one. */
  reportedValue: z.string().nullable(),
  priorValue: decimalString.nullable(),
  priorSource: weeklyPriorSource.nullable(),
  priorDate: isoDate.nullable(),
  /** The change against the prior as a decimal fraction (0.12 = up 12%); null without a prior or a value. */
  variancePct: decimalString.nullable(),
  /** Set when the move against the prior is at or beyond intake.weeklyVarianceThresholdPct. */
  flag: z.enum(['above_threshold']).nullable(),
  link: intakeLink,
  findings: z.array(intakeFinding),
  status: stagingState,
  /** The reviewer's reason on a rejection, or the approval note. */
  decision: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /** The Draft valuation the approval created (mon.valuation), once promoted. */
  valuationId: uuid.nullable(),
});
export type WeeklyRow = z.infer<typeof weeklyRow>;

export const weeklyFileDetail = intakeFile.extend({
  /** The staged values the caller may see, in file order. */
  rows: z.array(weeklyRow),
  /** Rows linked to investments not visible to the caller; never a reason to show them. */
  hiddenRows: z.number().int(),
});
export type WeeklyFileDetail = z.infer<typeof weeklyFileDetail>;

/** Import a weekly values file: the CSV as uploaded, or one the weekly drop folder lists by id. */
export const weeklyImportBody = z.union([
  z
    .object({
      fileName: plainText(200).min(1),
      /** The CSV as text; the API refuses more than definitions.intake.maxFileBytes. */
      csv: z.string().min(1).max(2_000_000),
    })
    .strict(),
  z.object({ dropId: plainText(200).min(1) }).strict(),
]);
export type WeeklyImportBody = z.infer<typeof weeklyImportBody>;

/** The staged file, with `duplicate` true when the same content was imported before (nothing new was staged). */
export const weeklyImportResult = weeklyFileDetail.extend({ duplicate: z.boolean() });
export type WeeklyImportResult = z.infer<typeof weeklyImportResult>;

/* ---- Look-through reconcile (M2 lookthrough-reconcile, M1 taxonomy) ---- */

/** The fields a provider row is compared on: sector and geography against the taxonomy, exposures against approved values. */
export const lookthroughField = z.enum(['sector', 'geography', 'exposureAtCost', 'exposureAtNav']);
export type LookthroughField = z.infer<typeof lookthroughField>;

/** One difference between the provider and the record: what the record says and what the provider sent, as text. */
export const lookthroughDifference = z.object({
  field: lookthroughField,
  expected: z.string().nullable(),
  actual: z.string().nullable(),
});
export type LookthroughDifference = z.infer<typeof lookthroughDifference>;

/**
 * One provider row of a reconcile run. The provider's texts are kept as sent; `mapped` is what
 * config/lookthrough_mapping.json makes of them (null for a label the mapping does not know);
 * `approved` is the record's exposure at cost and at the latest Locked mark. Every difference is a
 * data exception; the approved values never change from a provider file.
 */
export const lookthroughRow = z.object({
  id: uuid,
  rowNo: z.number().int(),
  investmentNumber: z.string().nullable(),
  companyName: z.string(),
  /**
   * The provider's as-of text as sent, not an ISO date: the API stages a value that is not a
   * calendar date and flags it (the LT-TYPE-01 finding names the malformed value), and the run
   * must stay readable with that row in it. The run's own date is `lookthroughRunDetail.asOf`.
   */
  asOf: z.string(),
  provider: z.object({
    sector: z.string(),
    geography: z.string(),
    exposureAtCost: z.string(),
    exposureAtNav: z.string(),
  }),
  mapped: z.object({
    /** A taxonomy sector code, or null when the provider's label is not in the mapping. */
    sector: z.string().nullable(),
    geography: z.string().nullable(),
  }),
  approved: z.object({
    exposureAtCost: decimalString.nullable(),
    exposureAtNav: decimalString.nullable(),
  }),
  differences: z.array(lookthroughDifference),
  link: intakeLink,
  findings: z.array(intakeFinding),
  status: stagingState,
  /** Data exceptions this row opened (one per difference, plus one per unresolved link). */
  exceptions: z.number().int(),
});
export type LookthroughRow = z.infer<typeof lookthroughRow>;

export const lookthroughRunDetail = intakeFile.extend({
  asOf: isoDate,
  rows: z.array(lookthroughRow),
  hiddenRows: z.number().int(),
});
export type LookthroughRunDetail = z.infer<typeof lookthroughRunDetail>;

/** Reconcile the provider's extract for one as-of date against the taxonomy and the approved values. */
export const lookthroughReconcileBody = z.object({ asOf: isoDate }).strict();
export type LookthroughReconcileBody = z.infer<typeof lookthroughReconcileBody>;

/** The run, with `duplicate` true when the same extract was reconciled before (nothing new was staged). */
export const lookthroughReconcileResult = lookthroughRunDetail.extend({ duplicate: z.boolean() });
export type LookthroughReconcileResult = z.infer<typeof lookthroughReconcileResult>;

/* ---- Ops drop workbooks (M2 ops-drop-import) ---- */

/** The two ways an ops-drop workbook arrives: uploaded as base64, or listed by the ops drop folder. */
const opsDropUpload = z
  .object({ fileName: plainText(200).min(1), workbookBase64: z.string().min(1) })
  .strict();
const opsDropFromFolder = z.object({ dropId: plainText(200).min(1) }).strict();

/**
 * Import an operations workbook: the file as base64 as uploaded, or one the ops drop folder lists
 * by id. The workbook limit is config (definitions.intake.maxWorkbookBase64Chars): the API builds
 * the schema with it, and the route table documents the shape without a limit. The workbook is
 * parsed by template signature (sheet names plus header hash); an unknown template is refused.
 */
export function opsDropImportBody(
  maxWorkbookBase64Chars?: number,
): z.ZodUnion<readonly [typeof opsDropUpload, typeof opsDropFromFolder]> {
  const upload =
    maxWorkbookBase64Chars === undefined
      ? opsDropUpload
      : opsDropUpload.extend({ workbookBase64: z.string().min(1).max(maxWorkbookBase64Chars) });
  return z.union([upload, opsDropFromFolder]);
}
export type OpsDropImportBody = z.infer<ReturnType<typeof opsDropImportBody>>;

/* ---- Data exceptions (M1 Data Health, M2; ops.data_exception, docs/18 section 9) ---- */

export const dataExceptionState = z.enum(['open', 'acknowledged', 'resolved', 'wont_fix']);
export type DataExceptionState = z.infer<typeof dataExceptionState>;

/**
 * A data exception as the exceptions page shows it. The context names the staged row or the
 * position it is about only when the caller may see them (the row's own policy decides); a
 * candidate is listed by reason only, the names being on the staged row (decision 0009).
 */
export const dataException = z.object({
  id: uuid,
  /** The intake or job that opened it, such as accounting_import or lookthrough_reconcile. */
  source: z.string(),
  entity: z.string(),
  entityId: uuid.nullable(),
  ruleId: z.string(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  /** A core.taxonomy_term code of the exception_severity domain. */
  severity: z.string(),
  /** The owner's display name, when one is assigned. */
  owner: z.string().nullable(),
  state: dataExceptionState,
  externalTicket: z.string().nullable(),
  candidates: z.array(z.object({ reason: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
  rowVersion: z.number().int(),
  context: z.object({
    intakeFileId: uuid.nullable(),
    intakeFileName: z.string().nullable(),
    rowNo: z.number().int().nullable(),
    investmentId: uuid.nullable(),
    investmentNumber: z.string().nullable(),
    companyName: z.string().nullable(),
  }),
});
export type DataException = z.infer<typeof dataException>;

export const dataExceptionPage = z.object({
  items: z.array(dataException),
  nextCursor: z.string().nullable(),
});
export type DataExceptionPage = z.infer<typeof dataExceptionPage>;

export const dataExceptionListQuery = pageQuery.extend({
  state: dataExceptionState.optional(),
  source: filterText.optional(),
  severity: filterText.optional(),
  /** Only the exceptions about the rows of this intake file or reconcile run. */
  intakeFileId: uuid.optional(),
});

export const dataExceptionCommand = z.enum(['acknowledge', 'resolve', 'wont_fix', 'set_ticket']);
export type DataExceptionCommand = z.infer<typeof dataExceptionCommand>;

/** An external ticket reference: one short line of plain text, such as a help desk number. */
export const externalTicket = plainText(64).min(1);

/**
 * acknowledge, resolve and wont_fix move the exception through docs/18 section 9; resolve and
 * wont_fix need a reason. set_ticket records the external ticket number and is not a transition.
 */
export const dataExceptionCommandBody = z
  .object({
    command: dataExceptionCommand,
    reason: plainText(500).min(3).optional(),
    externalTicket: externalTicket.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if ((body.command === 'resolve' || body.command === 'wont_fix') && body.reason === undefined)
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A reason is required' });
    if (body.command === 'set_ticket' && body.externalTicket === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['externalTicket'],
        message: 'An external ticket is required',
      });
  });
export type DataExceptionCommandBody = z.infer<typeof dataExceptionCommandBody>;

/* ---- Config files the intakes read (rule 9: config over code) ---- */

/** A taxonomy code of one domain, such as sector.software: the domain, a dot, then the code. */
export const taxonomyCodeOf = (domain: string): z.ZodString =>
  z.string().regex(new RegExp(`^${domain}\\.[a-z0-9_]+$`));

/**
 * config/lookthrough_mapping.json: the provider's plain labels mapped onto the firm's taxonomy
 * codes (docs/04 M1: outside sources are mapped to the taxonomy and never override it). A provider
 * label the mapping does not know maps to nothing and the reconcile flags it.
 */
export const lookthroughMapping = z
  .object({
    _note: z.string().optional(),
    sector: z.record(z.string().min(1), taxonomyCodeOf('sector')),
    geography: z.record(z.string().min(1), taxonomyCodeOf('geography')),
  })
  .strict();
export type LookthroughMapping = z.infer<typeof lookthroughMapping>;

/** The unit separator the header cells are joined by before hashing (U+001F). */
export const TEMPLATE_HEADER_SEPARATOR = '\u001f';

/**
 * config/ops_drop_templates.json: each operations workbook template by its signature, the sheet
 * names plus the SHA-256 of the header cells joined by TEMPLATE_HEADER_SEPARATOR, and the
 * accounting layout column each header maps onto, so a known workbook stages through the
 * accounting rules. A workbook whose signature matches no template is refused.
 */
export const opsDropTemplate = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    sheets: z.array(z.string().min(1)).min(1),
    headerSheet: z.string().min(1),
    header: z.array(z.string().min(1)).min(1),
    headerHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Header cell to the accounting layout column name (config/accounting_layout.json). */
    columns: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict()
  .superRefine((template, ctx) => {
    if (!template.sheets.includes(template.headerSheet))
      ctx.addIssue({
        code: 'custom',
        path: ['headerSheet'],
        message: 'The header sheet must be one of the sheets',
      });
    for (const [i, cell] of template.header.entries()) {
      if (!(cell in template.columns))
        ctx.addIssue({
          code: 'custom',
          path: ['header', i],
          message: 'Every header cell needs a column mapping',
        });
    }
    if (new Set(template.header).size !== template.header.length)
      ctx.addIssue({ code: 'custom', path: ['header'], message: 'Header cells must be distinct' });
    const targets = Object.values(template.columns);
    if (new Set(targets).size !== targets.length)
      ctx.addIssue({
        code: 'custom',
        path: ['columns'],
        message: 'Each accounting column may be mapped once',
      });
  });
export type OpsDropTemplate = z.infer<typeof opsDropTemplate>;

export const opsDropTemplates = z
  .object({
    _note: z.string().optional(),
    templates: z.array(opsDropTemplate).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const names = file.templates.map((t) => t.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: 'custom',
        path: ['templates'],
        message: 'Template names must be distinct',
      });
  });
export type OpsDropTemplates = z.infer<typeof opsDropTemplates>;

/* ---- Config files the pipeline and the closing read (docs/04 M5, M7, M8; rule 9) ---- */

/** One item of config/closing_checklist.json: a stable code, the label the checklist shows and whether it blocks confirmation. */
export const closingChecklistItem = z
  .object({
    code: z.string().regex(/^[a-z0-9_]+$/),
    label: z.string().min(1),
    required: z.boolean(),
  })
  .strict();
export type ClosingChecklistItem = z.infer<typeof closingChecklistItem>;

/**
 * config/closing_checklist.json: the required-document checklist every closing starts with
 * (docs/18 section 12). Operations cannot confirm a closing while a required item is open; an
 * optional item is tracked but never blocks.
 */
export const closingChecklist = z
  .object({ _note: z.string().optional(), items: z.array(closingChecklistItem).min(1) })
  .strict()
  .superRefine((file, ctx) => {
    const codes = file.items.map((i) => i.code);
    if (new Set(codes).size !== codes.length)
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Item codes must be distinct' });
  });
export type ClosingChecklist = z.infer<typeof closingChecklist>;

/** One task of a diligence template: its workstream code, its title and whether it gates IC. */
export const diligenceTemplateTask = z
  .object({
    workstream: taxonomyCodeOf('diligence_workstream'),
    title: z.string().min(1),
    requiredForIc: z.boolean(),
  })
  .strict();
export type DiligenceTemplateTask = z.infer<typeof diligenceTemplateTask>;

/**
 * config/diligence_templates.json: the tasks an opportunity starts with on entering Diligence, by
 * deal type code, with the default list for a deal type without a template (docs/18 section 4).
 */
export const diligenceTemplates = z
  .object({
    _note: z.string().optional(),
    templates: z.record(taxonomyCodeOf('deal_type'), z.array(diligenceTemplateTask).min(1)),
    default: z.array(diligenceTemplateTask).min(1),
  })
  .strict();
export type DiligenceTemplates = z.infer<typeof diligenceTemplates>;

/** The template of a deal type: its own list, else the default. */
export function diligenceTemplateFor(
  templates: DiligenceTemplates,
  dealType: string,
): DiligenceTemplateTask[] {
  return templates.templates[dealType] ?? templates.default;
}

/* ---- Documents (M3 document hub, docs/18 section 6, migration 0011, decision 0012) ---- */

/** A quarter end (packages/calc isQuarterEnd), the period a report covers: the only date a tracker or a batch runs for. */
export const quarterEndDate = isoDate
  .refine((value) => !isCalendarDate(value) || isQuarterEnd(value), 'Not a quarter end')
  .meta({ format: 'date' });

/** A core.taxonomy_term code of the doc_type domain (docs/04 M3), such as doc_type.quarterly_financials. */
export const docTypeCode = taxonomyCodeOf('doc_type');

/** docs/18 section 6: Received > Classified | NeedsReview; NeedsReview > Classified (a person); Duplicate links to the original. */
export const documentReviewStatus = z.enum(['Received', 'Classified', 'NeedsReview', 'Duplicate']);
export type DocumentReviewStatus = z.infer<typeof documentReviewStatus>;

export const documentConfidentiality = z.enum(['internal', 'confidential', 'restricted']);
export type DocumentConfidentiality = z.infer<typeof documentConfidentiality>;

/** docs/18 section 7: Queued > Running > Succeeded | Failed | NeedsRetry; NeedsRetry > Running within the retry budget. */
export const extractionRunState = z.enum([
  'Queued',
  'Running',
  'Succeeded',
  'Failed',
  'NeedsRetry',
]);
export type ExtractionRunState = z.infer<typeof extractionRunState>;

/** What the classifier found: matched keywords, and other candidates by reason only (never a value). */
export const classifierEvidence = z.object({
  keywords: z.array(z.string()),
  candidates: z.array(z.object({ reason: z.string() })),
});
export type ClassifierEvidence = z.infer<typeof classifierEvidence>;

/**
 * A document of the hub as the list and the detail show it: the store's metadata, the links a
 * classification made (sponsor, fund, investment, period), the classifier's confidence and
 * evidence, the duplicate it was found to be, and its latest extraction run. Only metadata travels;
 * the document itself is read page by page through its pages route.
 */
export const documentSummary = z.object({
  id: uuid,
  title: z.string(),
  fileName: z.string(),
  folder: z.string(),
  docType: docTypeCode.nullable(),
  reviewStatus: documentReviewStatus,
  sponsorId: uuid.nullable(),
  sponsorFundId: uuid.nullable(),
  sponsorFundName: z.string().nullable(),
  investmentId: uuid.nullable(),
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  periodEnd: isoDate.nullable(),
  confidentiality: documentConfidentiality,
  /** SHA-256 of the bytes, hex: the duplicate key. */
  contentHash: z.string(),
  sizeBytes: z.number().int(),
  pageCount: z.number().int().nullable(),
  receivedAt: z.string(),
  indexedAt: z.string(),
  /** The classifier's confidence as decimal text between 0 and 1; null until classified. */
  classificationConfidence: decimalString.nullable(),
  classifierEvidence,
  /** The display name of the person who classified it; null when the classifier did, or nobody yet. */
  classifiedBy: z.string().nullable(),
  classifiedAt: z.string().nullable(),
  duplicateOfId: uuid.nullable(),
  latestRun: z.object({ id: uuid, state: extractionRunState }).nullable(),
});
export type DocumentSummary = z.infer<typeof documentSummary>;

/** Another indexed item with the same content hash. */
export const documentDuplicate = z.object({
  id: uuid,
  fileName: z.string(),
  folder: z.string(),
  indexedAt: z.string(),
  reviewStatus: documentReviewStatus,
});
export type DocumentDuplicate = z.infer<typeof documentDuplicate>;

export const documentDetail = documentSummary.extend({
  /** Every other document with the same content hash the caller may see. */
  duplicates: z.array(documentDuplicate),
});
export type DocumentDetail = z.infer<typeof documentDetail>;

/** The text of a document page by page, as lines (packages/pdf lines, top to bottom). */
export const documentPages = z.object({
  documentId: uuid,
  pageCount: z.number().int(),
  pages: z.array(z.object({ number: z.number().int().min(1), lines: z.array(z.string()) })),
});
export type DocumentPages = z.infer<typeof documentPages>;

export const documentPage = z.object({
  items: z.array(documentSummary),
  nextCursor: z.string().nullable(),
});
export type DocumentPage = z.infer<typeof documentPage>;

/** Newest first (indexedAt, id). `q` is a full-text query over title, file name and text excerpt. */
export const documentListQuery = pageQuery.extend({
  q: filterText.optional(),
  docType: docTypeCode.optional(),
  reviewStatus: documentReviewStatus.optional(),
  investmentId: uuid.optional(),
  sponsorFundId: uuid.optional(),
  periodEnd: isoDate.optional(),
});

/** What a scan of the store did: rows created, items found to repeat an indexed hash, items already indexed. */
export const documentIndexResult = z.object({
  indexed: z.number().int(),
  duplicates: z.number().int(),
  unchanged: z.number().int(),
});
export type DocumentIndexResult = z.infer<typeof documentIndexResult>;

/**
 * A person classifies a document (NeedsReview > Classified, docs/18 section 6; the index leaves no
 * document in Received, a classifier that is off or fails flags it for review): the type, and the
 * links the type needs. The service's own commands (autoClassify, flagForReview, markDuplicate)
 * are internal and never arrive through this body.
 */
const documentClassifyCommand = z
  .object({
    command: z.literal('classify'),
    docType: docTypeCode,
    investmentId: uuid.optional(),
    sponsorFundId: uuid.optional(),
    periodEnd: isoDate.optional(),
    reason: plainText(500).optional(),
  })
  .strict();
export const documentCommandBody = z.discriminatedUnion('command', [documentClassifyCommand]);
export type DocumentCommandBody = z.infer<typeof documentCommandBody>;

/* ---- Expected documents (M3 tracker; status derived from the clock and config, never stored) ---- */

/**
 * expected: not yet due; received: a classified document matched it; late: past due by less than
 * definitions.documents.missingAfterDays beyond the lateAfterDays grace; missing: later than that.
 */
export const expectedDocumentStatus = z.enum(['expected', 'received', 'late', 'missing']);
export type ExpectedDocumentStatus = z.infer<typeof expectedDocumentStatus>;

export const expectedDocument = z.object({
  id: uuid,
  investmentId: uuid.nullable(),
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  sponsorFundId: uuid.nullable(),
  sponsorFundName: z.string().nullable(),
  periodEnd: isoDate,
  docType: docTypeCode,
  dueDate: isoDate,
  receivedDocumentId: uuid.nullable(),
  status: expectedDocumentStatus,
  /**
   * Whole days from the due date to the as-of day (negative while not yet due); for a received
   * document, from the due date to the day it was received, so a late receipt keeps its age.
   */
  ageDays: z.number().int(),
});
export type ExpectedDocument = z.infer<typeof expectedDocument>;

export const expectedDocumentPage = z.object({
  items: z.array(expectedDocument),
  nextCursor: z.string().nullable(),
});
export type ExpectedDocumentPage = z.infer<typeof expectedDocumentPage>;

/** Newest period first (periodEnd, dueDate, id). `asOf` is the day the status is judged on; the clock otherwise. */
export const expectedDocumentListQuery = pageQuery.extend({
  periodEnd: isoDate.optional(),
  status: expectedDocumentStatus.optional(),
  investmentId: uuid.optional(),
  sponsorFundId: uuid.optional(),
  asOf: isoDate.optional(),
});

/** Generate the expected rows of a quarter: one per active investment and per sponsor fund with a position. */
export const expectedDocumentGenerateBody = z.object({ periodEnd: quarterEndDate }).strict();
export type ExpectedDocumentGenerateBody = z.infer<typeof expectedDocumentGenerateBody>;

export const expectedDocumentGenerateResult = z.object({
  periodEnd: isoDate,
  /** Rows created by this call; rows the quarter already had are counted as existing and left as they were. */
  created: z.number().int(),
  existing: z.number().int(),
});
export type ExpectedDocumentGenerateResult = z.infer<typeof expectedDocumentGenerateResult>;

/* ---- Extraction (M4; doc.extraction_run, stg.extracted_value; docs/18 section 7; SEC-8.4, SEC-9.1) ---- */

/** The units a model may declare; money is converted to dollars by packages/calc at promotion. */
export const extractionUnit = z.enum(['USD', 'USD_K', 'USD_M', 'USD_B', 'PCT', 'COUNT', 'DATE']);
export type ExtractionUnit = z.infer<typeof extractionUnit>;

/** The money units among them (config/extraction_schema.json kind 'money'). */
export const MONEY_UNITS: readonly ExtractionUnit[] = ['USD', 'USD_K', 'USD_M', 'USD_B'];

/** A field's kind in config/extraction_schema.json. */
export const extractionFieldKind = z.enum(['date', 'money', 'percent', 'count']);
export type ExtractionFieldKind = z.infer<typeof extractionFieldKind>;

/** clean: promotable as answered; flagged: reviewed first; invalid: never promoted unedited. */
export const extractionValidationState = z.enum(['clean', 'flagged', 'invalid']);
export type ExtractionValidationState = z.infer<typeof extractionValidationState>;

export const extractionDecision = z.enum(['accepted', 'edited', 'rejected']);
export type ExtractionDecision = z.infer<typeof extractionDecision>;

/** schema: the output failed validation (retried once); transient: the call failed (retried three times). */
export const extractionErrorKind = z.enum(['schema', 'transient']);
export type ExtractionErrorKind = z.infer<typeof extractionErrorKind>;

/** One validator finding on a value (packages/ai rule ids such as EXT-CITE-02); invalid outranks flagged. */
export const extractionFinding = z.object({
  ruleId: z.string(),
  severity: z.enum(['flagged', 'invalid']),
  message: z.string(),
});
export type ExtractionFinding = z.infer<typeof extractionFinding>;

/**
 * A staged field of a run as the review page shows it: the model's answer with its citation and
 * confidence, the validation's verdict, and the reviewer's decision. `value` is decimal text, an
 * ISO date or text, never a float; once a reviewer edits, `editedValue` in `editedUnit` is the
 * figure promotion takes, while `value` and `unit` stay what the model declared (migration 0012,
 * WF-1); an accept after an edit clears both. The label, kind and requirement come from
 * config/extraction_schema.json.
 */
export const extractedValue = z.object({
  id: uuid,
  field: z.string(),
  label: z.string(),
  kind: extractionFieldKind,
  required: z.boolean(),
  value: z.string().nullable(),
  unit: extractionUnit.nullable(),
  page: z.number().int().min(1).nullable(),
  quote: z.string().max(150).nullable(),
  confidence: decimalString.nullable(),
  validationState: extractionValidationState,
  findings: z.array(extractionFinding),
  decision: extractionDecision.nullable(),
  editedValue: z.string().nullable(),
  /** The unit of editedValue; null until a reviewer edits the row. */
  editedUnit: extractionUnit.nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
export type ExtractedValue = z.infer<typeof extractedValue>;

export const extractionValueCounts = z.object({
  values: z.number().int(),
  clean: z.number().int(),
  flagged: z.number().int(),
  invalid: z.number().int(),
  /** Values with a reviewer decision. */
  decided: z.number().int(),
});
export type ExtractionValueCounts = z.infer<typeof extractionValueCounts>;

/**
 * An extraction run: one model call over one document against one schema, with its bookkeeping
 * (prompt, model, tokens, cost as decimal text, SEC-8.9), its state and retry counts, the review's
 * approval and the record the approved values became.
 */
export const extractionRun = z.object({
  id: uuid,
  documentId: uuid,
  documentTitle: z.string(),
  fileName: z.string(),
  investmentId: uuid.nullable(),
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  periodEnd: isoDate.nullable(),
  /** A key of config/extraction_schema.json, such as quarterly_financials. */
  schemaId: z.string(),
  promptId: z.string(),
  promptVersion: z.string(),
  modelId: z.string().nullable(),
  state: extractionRunState,
  batchId: uuid.nullable(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  costUsd: decimalString.nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorKind: extractionErrorKind.nullable(),
  schemaRetries: z.number().int(),
  transientRetries: z.number().int(),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  /** The mon.quarterly_performance row the approved values were promoted into. */
  promotedRecordId: uuid.nullable(),
  counts: extractionValueCounts,
  rowVersion: z.number().int(),
});
export type ExtractionRun = z.infer<typeof extractionRun>;

export const extractionRunPage = z.object({
  items: z.array(extractionRun),
  nextCursor: z.string().nullable(),
});
export type ExtractionRunPage = z.infer<typeof extractionRunPage>;

/** Newest first (createdAt, id). */
export const extractionRunListQuery = pageQuery.extend({
  state: extractionRunState.optional(),
  documentId: uuid.optional(),
  investmentId: uuid.optional(),
  batchId: uuid.optional(),
});

/** A positioned text run of a page, as packages/pdf reads it (PDF points, origin bottom left). */
export const pageTextRun = z.object({
  x: z.number(),
  y: z.number(),
  size: z.number(),
  text: z.string(),
});
export type PageTextRun = z.infer<typeof pageTextRun>;

/** A page's layout for the review pane: the page is drawn from its runs and the cited quote is highlighted. */
export const pageLayout = z.object({
  number: z.number().int().min(1),
  width: z.number(),
  height: z.number(),
  runs: z.array(pageTextRun),
});
export type PageLayout = z.infer<typeof pageLayout>;

/**
 * The review page: the run, its document, every staged value with findings (flagged and invalid
 * first is the page's job), the drafted highlights and commentary (staged with the values, promoted
 * only on approval, and only from approved numbers), and the page layouts for click-to-source.
 */
export const extractionRunDetail = z.object({
  run: extractionRun,
  document: documentSummary,
  values: z.array(extractedValue),
  highlights: z.array(z.string()),
  commentary: z.string().nullable(),
  pages: z.array(pageLayout),
});
export type ExtractionRunDetail = z.infer<typeof extractionRunDetail>;

/** The state of the ops.job row a batch is (docs/17 jobs). */
export const extractionBatchState = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'dead_letter',
]);
export type ExtractionBatchState = z.infer<typeof extractionBatchState>;

/** A batch: the ops.job that queued a set of runs, with their states and the tokens and cost they used. */
export const extractionBatch = z.object({
  id: uuid,
  state: extractionBatchState,
  progress: z.number().int().min(0).max(100),
  requestedBy: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  runs: z.object({
    total: z.number().int(),
    queued: z.number().int(),
    running: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    needsRetry: z.number().int(),
  }),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: decimalString,
});
export type ExtractionBatch = z.infer<typeof extractionBatch>;

export const extractionBatchPage = z.object({
  items: z.array(extractionBatch),
  nextCursor: z.string().nullable(),
});
export type ExtractionBatchPage = z.infer<typeof extractionBatchPage>;

/** Start a batch: the documents named, or every classified document of a type for a quarter. */
export const extractionBatchBody = z.union([
  z.object({ documentIds: z.array(uuid).min(1).max(500) }).strict(),
  z.object({ periodEnd: quarterEndDate, docType: docTypeCode }).strict(),
]);
export type ExtractionBatchBody = z.infer<typeof extractionBatchBody>;

/** A field key of config/extraction_schema.json, such as revenue_ltm. */
export const extractionFieldKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .meta({ description: 'A field key of the extraction schema' });

const runAcceptCommand = z
  .object({ command: z.literal('accept'), field: extractionFieldKey })
  .strict();
const runRejectCommand = z
  .object({
    command: z.literal('reject'),
    field: extractionFieldKey,
    reason: plainText(500).min(3).optional(),
  })
  .strict();
const runEditCommand = z
  .object({
    command: z.literal('edit'),
    field: extractionFieldKey,
    /** The corrected value as text: decimal digits, an ISO date or a count, as the unit says. */
    value: plainText(200),
    unit: extractionUnit.optional(),
    reason: plainText(500).optional(),
  })
  .strict();
const runAcceptCleanCommand = z.object({ command: z.literal('acceptClean') }).strict();
const runApproveCommand = z
  .object({ command: z.literal('approve'), reason: plainText(500).optional() })
  .strict();
const runRetryCommand = z.object({ command: z.literal('retry') }).strict();

/** True when a value's text fits the unit: digits for money and percent, a whole number for a count, a calendar date for a date. */
export function valueFitsUnit(value: string, unit: ExtractionUnit): boolean {
  switch (unit) {
    case 'USD':
    case 'USD_K':
    case 'USD_M':
    case 'USD_B':
    case 'PCT':
      return DECIMAL_PATTERN.test(value);
    case 'COUNT':
      return /^\d+$/.test(value);
    case 'DATE':
      return isCalendarDate(value);
  }
}

/**
 * The unit a value of a kind carries when nobody names one: a percent is a fraction, a count a
 * whole number, a date a calendar day. A money field always names its own unit (null here), so
 * an edit of one without a unit is refused by extractionRunCommandBody.
 */
export function naturalUnitOf(kind: ExtractionFieldKind): ExtractionUnit | null {
  switch (kind) {
    case 'money':
      return null;
    case 'percent':
      return 'PCT';
    case 'count':
      return 'COUNT';
    case 'date':
      return 'DATE';
  }
}

type ExtractionRunCommandSchema = z.ZodDiscriminatedUnion<
  readonly [
    typeof runAcceptCommand,
    typeof runRejectCommand,
    typeof runEditCommand,
    typeof runAcceptCleanCommand,
    typeof runApproveCommand,
    typeof runRetryCommand,
  ]
>;

/**
 * Review commands on a run. accept and reject decide one value; edit replaces its value (and,
 * for a money field, its unit: the API builds the schema with the money field keys of the run's
 * schema, config over code, and the route table documents the shape without them); acceptClean
 * accepts every clean undecided value; approve promotes the accepted and edited values into the
 * record in one audited transaction (SEC-9.1, SEC-11.1) once no required value is undecided or
 * invalid; retry queues a NeedsRetry or Failed run again within the budget (docs/18 section 7).
 */
export function extractionRunCommandBody(
  moneyFields: readonly string[] = [],
): ExtractionRunCommandSchema {
  return z
    .discriminatedUnion('command', [
      runAcceptCommand,
      runRejectCommand,
      runEditCommand,
      runAcceptCleanCommand,
      runApproveCommand,
      runRetryCommand,
    ])
    .superRefine((body, ctx) => {
      if (body.command !== 'edit') return;
      if (body.value.trim() === '')
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'A value is required' });
      if (
        moneyFields.includes(body.field) &&
        (body.unit === undefined || !MONEY_UNITS.includes(body.unit))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['unit'],
          message: 'A money edit needs a money unit',
        });
      if (body.unit !== undefined && !valueFitsUnit(body.value, body.unit))
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'The value does not fit the unit',
        });
    });
}
export type ExtractionRunCommandBody = z.infer<ExtractionRunCommandSchema>;

/* ---- Monitoring board and realization outlook (M9; decision 0012) ---- */

/** none: no succeeded run for the quarter; pending: a run awaits approval; approved: promoted into the record. */
export const monitoringApproval = z.enum(['none', 'pending', 'approved']);
export type MonitoringApproval = z.infer<typeof monitoringApproval>;

/** One active investment on the board for one quarter: its expected report, its run and its approval. */
export const monitoringBoardRow = z.object({
  investmentId: uuid,
  investmentNumber: z.string(),
  companyName: z.string(),
  vehicleName: z.string(),
  sponsorFundName: z.string().nullable(),
  dealType: z.string(),
  periodEnd: isoDate,
  /** Null when the quarter's expected rows were not generated for this investment. */
  expectedDocumentId: uuid.nullable(),
  documentStatus: expectedDocumentStatus,
  dueDate: isoDate.nullable(),
  ageDays: z.number().int().nullable(),
  documentId: uuid.nullable(),
  runId: uuid.nullable(),
  runState: extractionRunState.nullable(),
  /** Flagged plus invalid values on the latest run, undecided ones only. */
  flagsCount: z.number().int(),
  approval: monitoringApproval,
  approvedAt: z.string().nullable(),
});
export type MonitoringBoardRow = z.infer<typeof monitoringBoardRow>;

export const monitoringBoard = z.object({
  asOf: isoDate,
  periodEnd: isoDate,
  rows: z.array(monitoringBoardRow),
  counts: z.object({
    expected: z.number().int(),
    received: z.number().int(),
    late: z.number().int(),
    missing: z.number().int(),
    inReview: z.number().int(),
    approved: z.number().int(),
  }),
});
export type MonitoringBoard = z.infer<typeof monitoringBoard>;

/** The quarter to show (the latest quarter end on or before asOf when absent) and the day statuses are judged on. */
export const monitoringBoardQuery = z
  .object({ periodEnd: quarterEndDate.optional(), asOf: isoDate.optional() })
  .strict();

/** A text/csv body: the board's rows, one line each, with a header line. */
export const csvText = z.string().meta({ contentMediaType: 'text/csv' });

export const realizationOutlookCode = z.enum(['none', 'partial', 'full']);
export type RealizationOutlookCode = z.infer<typeof realizationOutlookCode>;

/** The realization outlook of an investment; outlook none with no setBy when nobody has set one. */
export const realizationOutlookDetail = z.object({
  investmentId: uuid,
  investmentNumber: z.string(),
  companyName: z.string(),
  outlook: realizationOutlookCode,
  horizonMonths: z.number().int(),
  note: z.string().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().nullable(),
});
export type RealizationOutlookDetail = z.infer<typeof realizationOutlookDetail>;

/** Set the outlook by hand (definitions.realizationFlagEditableOnlyManually): audited with the reason. */
export const realizationOutlookBody = z
  .object({
    outlook: realizationOutlookCode,
    horizonMonths: z.number().int().min(1).max(120),
    note: plainText(500).nullable(),
    reason: plainText(500).min(3),
  })
  .strict();
export type RealizationOutlookBody = z.infer<typeof realizationOutlookBody>;

/* ---- Config blocks the document hub and extraction read (rule 9: config over code) ---- */

/** A whole number of zero or more. */
const wholeNumber = z.number().int().min(0);

/** A decimal fraction between 0 and 1 as a JSON number (definitions.json keeps rates as decimals). */
const fraction = z.number().min(0).max(1);

/**
 * config/definitions.json `documents`: when a quarter's report is due (days after the quarter end),
 * when it counts as late and then missing (days after the due date), the search page size and the
 * limits the PDF reader works to.
 */
export const documentDefinitions = z
  .object({
    _note: z.string().optional(),
    expectedDueDaysAfterQuarterEnd: wholeNumber,
    lateAfterDays: wholeNumber,
    missingAfterDays: wholeNumber,
    searchPageSize: z.number().int().min(1).max(200),
    maxPdfBytes: z.number().int().min(1),
    maxPages: z.number().int().min(1),
  })
  .strict()
  .refine((d) => d.missingAfterDays > d.lateAfterDays, {
    path: ['missingAfterDays'],
    message: 'A document is missing only after it was late',
  });
export type DocumentDefinitions = z.infer<typeof documentDefinitions>;

/**
 * config/definitions.json `extraction`: batch concurrency, the token budgets per run and per day,
 * the quote length, the confidence below which a value is flagged, the retry budget per error kind
 * (docs/18 section 7) and the cost per thousand tokens as decimal strings, never floats.
 */
export const extractionDefinitions = z
  .object({
    _note: z.string().optional(),
    batchConcurrency: z.number().int().min(1),
    runTokenBudget: z.number().int().min(1),
    dayTokenBudget: z.number().int().min(1),
    quoteMaxChars: z.number().int().min(1).max(150),
    confidenceFlagBelow: fraction,
    schemaRetries: wholeNumber,
    transientRetries: wholeNumber,
    costPerThousandTokensUsd: z.object({ in: decimalString, out: decimalString }).strict(),
  })
  .strict();
export type ExtractionDefinitions = z.infer<typeof extractionDefinitions>;
