import {
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { approvalColumns, lineageColumns, standardColumns } from './columns.js';

export const mon = pgSchema('mon');

export const valuationState = mon.enum('valuation_state', [
  'Draft',
  'OpsPrepared',
  'DealTeamApproved',
  'Locked',
  'Reopened',
]);
export const capitalNoticeState = mon.enum('capital_notice_state', [
  'Received',
  'Extracted',
  'Reviewed',
  'TicketDrafted',
  'TicketApproved',
  'Funded',
  'Reconciled',
]);
/** docs/18 section 11 (migration 0013). */
export const wireInstructionState = mon.enum('wire_instruction_state', [
  'Proposed',
  'Verified',
  'Rejected',
  'Superseded',
]);
export const tradeTicketState = mon.enum('trade_ticket_state', [
  'Drafted',
  'Approved',
  'Funded',
  'Withdrawn',
]);
/** docs/18 section 8. */
export const changeRequestState = mon.enum('change_request_state', [
  'Submitted',
  'Routed',
  'InProgress',
  'Applied',
  'Rejected',
]);

const money = (name: string) => numeric(name, { precision: 20, scale: 2 });
const rate = (name: string) => numeric(name, { precision: 12, scale: 8 });

export const quarterlyPerformance = mon.table('quarterly_performance', {
  id: uuid('id').primaryKey().defaultRandom(),
  investmentId: uuid('investment_id').notNull(),
  periodEnd: date('period_end').notNull(),
  revenueLtm: money('revenue_ltm'),
  ebitdaLtm: money('ebitda_ltm'),
  ev: money('ev'),
  netDebt: money('net_debt'),
  cash: money('cash'),
  totalEquity: money('total_equity'),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  highlights: jsonb('highlights').notNull().default([]),
  commentary: text('commentary'),
  isEntrySnapshot: boolean('is_entry_snapshot').notNull().default(false),
  status: text('status').notNull().default('record_status.draft'),
  ...lineageColumns,
  ...approvalColumns,
  calcVersion: text('calc_version'),
  ...standardColumns,
});

export const creditTerms = mon.table('credit_terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  investmentId: uuid('investment_id').notNull().unique(),
  facilityType: text('facility_type').notNull(),
  seniorityRank: integer('seniority_rank').notNull().default(1),
  commitmentAmount: money('commitment_amount').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  baseRate: text('base_rate').notNull(),
  floor: rate('floor'),
  spread: rate('spread').notNull(),
  cashCoupon: rate('cash_coupon').notNull().default('0'),
  pikCoupon: rate('pik_coupon').notNull().default('0'),
  oid: rate('oid').notNull().default('0'),
  upfrontFee: rate('upfront_fee').notNull().default('0'),
  maturityDate: date('maturity_date').notNull(),
  paymentFrequency: text('payment_frequency').notNull().default('quarterly'),
  amortization: jsonb('amortization').notNull().default([]),
  callProtection: jsonb('call_protection').notNull().default([]),
  covenants: jsonb('covenants').notNull().default([]),
  effectiveDate: date('effective_date').notNull(),
  sourceDocumentId: uuid('source_document_id'),
  status: text('status').notNull().default('record_status.draft'),
  ...approvalColumns,
  ...standardColumns,
});

export const creditPerformance = mon.table('credit_performance', {
  id: uuid('id').primaryKey().defaultRandom(),
  investmentId: uuid('investment_id').notNull(),
  periodEnd: date('period_end').notNull(),
  parValue: money('par_value'),
  costBasis: money('cost_basis'),
  fairValue: money('fair_value'),
  accruedInterest: money('accrued_interest'),
  cashInterestLtm: money('cash_interest_ltm'),
  pikCapitalizedLtm: money('pik_capitalized_ltm'),
  principalRepaidLtm: money('principal_repaid_ltm'),
  fundedAmount: money('funded_amount'),
  ebitdaLtm: money('ebitda_ltm'),
  cashInterestExpenseLtm: money('cash_interest_expense_ltm'),
  netDebtThroughTranche: money('net_debt_through_tranche'),
  ev: money('ev'),
  dscrInputs: jsonb('dscr_inputs').notNull().default({}),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  covenantStatus: text('covenant_status'),
  paymentStatus: text('payment_status'),
  highlights: jsonb('highlights').notNull().default([]),
  commentary: text('commentary'),
  isEntrySnapshot: boolean('is_entry_snapshot').notNull().default(false),
  status: text('status').notNull().default('record_status.draft'),
  ...lineageColumns,
  ...approvalColumns,
  calcVersion: text('calc_version'),
  ...standardColumns,
});

export const valuation = mon.table('valuation', {
  id: uuid('id').primaryKey().defaultRandom(),
  investmentId: uuid('investment_id').notNull(),
  periodEnd: date('period_end').notNull(),
  version: integer('version').notNull(),
  method: text('method').notNull(),
  inputs: jsonb('inputs').notNull().default({}),
  fairValue: money('fair_value').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  state: valuationState('state').notNull().default('Draft'),
  lockHash: text('lock_hash'),
  preparedBy: uuid('prepared_by'),
  dealTeamApprovedBy: uuid('deal_team_approved_by'),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  reopenReason: text('reopen_reason'),
  calcVersion: text('calc_version'),
  ...standardColumns,
});

export const valuationApproval = mon.table('valuation_approval', {
  id: uuid('id').primaryKey().defaultRandom(),
  valuationId: uuid('valuation_id').notNull(),
  approverId: uuid('approver_id').notNull(),
  step: text('step').notNull(),
  decision: text('decision').notNull(),
  comment: text('comment'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const capitalNotice = mon.table('capital_notice', {
  id: uuid('id').primaryKey().defaultRandom(),
  noticeType: text('notice_type').notNull(),
  vehicleId: uuid('vehicle_id').notNull(),
  investmentId: uuid('investment_id'),
  commitmentId: uuid('commitment_id'),
  issueDate: date('issue_date').notNull(),
  dueDate: date('due_date').notNull(),
  amount: money('amount').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  split: jsonb('split').notNull().default({}),
  ilpaFields: jsonb('ilpa_fields').notNull().default({}),
  preferredFundingDate: date('preferred_funding_date'),
  state: capitalNoticeState('state').notNull().default('Received'),
  sourceDocumentId: uuid('source_document_id'),
  scenarioTag: text('scenario_tag'),
  /** SEC-12.4: the notice text matched capitalActivity.urgencyPhrases. */
  urgencyFlag: boolean('urgency_flag').notNull().default(false),
  /** SEC-12.4: the instructions changed, or a new wire version was proposed for the counterparty. */
  wireChangeFlag: boolean('wire_change_flag').notNull().default(false),
  fundedAt: timestamp('funded_at', { withTimezone: true }),
  fundedBy: uuid('funded_by'),
  ...standardColumns,
});

/**
 * The wire instruction register (SEC-12.2, migration 0013): one row per version of a counterparty's
 * instructions (a sponsor fund or an investment, never both). bankDetailsEnc is the AES-256-GCM
 * ciphertext of the JSON bank details (packages/db/src/fieldCrypto.ts); nothing here is plaintext.
 */
export const wireInstruction = mon.table('wire_instruction', {
  id: uuid('id').primaryKey().defaultRandom(),
  sponsorFundId: uuid('sponsor_fund_id'),
  investmentId: uuid('investment_id'),
  counterpartyName: text('counterparty_name').notNull(),
  version: integer('version').notNull(),
  bankDetailsEnc: text('bank_details_enc').notNull(),
  /** "<bank> ****<last 4>", what every page shows. */
  bankDetailsMasked: text('bank_details_masked').notNull(),
  state: wireInstructionState('state').notNull().default('Proposed'),
  proposedBy: uuid('proposed_by').notNull(),
  proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
  /** How the instruction reached us, in plain words; never a document or an email body. */
  sourceNote: text('source_note'),
  /** The second person who made the callback (never the proposer). */
  callbackBy: uuid('callback_by'),
  callbackAt: timestamp('callback_at', { withTimezone: true }),
  /** prior_instruction, sponsor_website, known_contact or fund_administrator. */
  callbackNumberSource: text('callback_number_source'),
  /** confirmed or not_confirmed. */
  callbackResult: text('callback_result'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  /** The one version in use per counterparty; only a Verified version can be active. */
  active: boolean('active').notNull().default(false),
  ...standardColumns,
});

/**
 * Dual control on funding (SEC-12.3, migration 0013): one ticket per capital notice, prepared by one
 * person and approved by another against the Verified wire instruction version it names.
 */
export const tradeTicket = mon.table('trade_ticket', {
  id: uuid('id').primaryKey().defaultRandom(),
  capitalNoticeId: uuid('capital_notice_id').notNull().unique(),
  /** The version the ticket was approved against; null until approved. */
  wireInstructionId: uuid('wire_instruction_id'),
  amount: money('amount').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  fundingDate: date('funding_date').notNull(),
  preparedBy: uuid('prepared_by').notNull(),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  state: tradeTicketState('state').notNull().default('Drafted'),
  withdrawnReason: text('withdrawn_reason'),
  ...standardColumns,
});

/**
 * A change to a position the deal team reports and operations applies in a period (docs/04 M11,
 * docs/18 section 8, migration 0013). appliedPeriod is the quarter end the change was applied in.
 */
export const dealChangeRequest = mon.table('deal_change_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  investmentId: uuid('investment_id').notNull(),
  /** A change_type.* code. */
  changeType: text('change_type').notNull(),
  effectiveDate: date('effective_date').notNull(),
  /** A small map of plain values. */
  details: jsonb('details').notNull().default({}),
  /** One line, plain words. */
  summary: text('summary').notNull(),
  ownerId: uuid('owner_id'),
  submittedBy: uuid('submitted_by').notNull(),
  state: changeRequestState('state').notNull().default('Submitted'),
  appliedPeriod: date('applied_period'),
  appliedBy: uuid('applied_by'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  ...standardColumns,
});

export const cashFlow = mon.table('cash_flow', {
  id: uuid('id').primaryKey().defaultRandom(),
  investmentId: uuid('investment_id'),
  commitmentId: uuid('commitment_id'),
  flowDate: date('flow_date').notNull(),
  flowType: text('flow_type').notNull(),
  amount: money('amount').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  sourceNoticeId: uuid('source_notice_id'),
  status: text('status').notNull().default('record_status.draft'),
  ...lineageColumns,
  ...approvalColumns,
  ...standardColumns,
});

export const realizationOutlook = mon.table('realization_outlook', {
  id: uuid('id').primaryKey().defaultRandom(),
  investmentId: uuid('investment_id').notNull().unique(),
  horizonMonths: integer('horizon_months').notNull().default(18),
  outlook: text('outlook').notNull(),
  note: text('note'),
  setBy: uuid('set_by'),
  setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  ...standardColumns,
});
