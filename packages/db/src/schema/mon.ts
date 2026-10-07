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
