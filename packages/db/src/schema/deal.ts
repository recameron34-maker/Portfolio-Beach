import {
  boolean,
  char,
  date,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { standardColumns } from './columns.js';

export const deal = pgSchema('deal');

/** docs/18 section 4. */
export const dealStage = deal.enum('stage', [
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
/** docs/18 section 12. */
export const closingState = deal.enum('closing_state', ['Open', 'OpsConfirmed']);

const money = (name: string) => numeric(name, { precision: 20, scale: 2 });

/**
 * The pipeline record (docs/04 M5 skeleton, migration 0013). The company is a name until known as a
 * portfolio company; the investment is set on close. The wall is on the opportunity itself
 * (core.walled_record entity 'opportunity').
 */
export const opportunity = deal.table('opportunity', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  companyName: text('company_name').notNull(),
  portfolioCompanyId: uuid('portfolio_company_id'),
  sponsorId: uuid('sponsor_id').notNull(),
  sponsorFundId: uuid('sponsor_fund_id'),
  /** A core.taxonomy_term code of the deal_type domain. */
  dealType: text('deal_type').notNull(),
  sector: text('sector'),
  geography: text('geography'),
  stage: dealStage('stage').notNull().default('Sourced'),
  /** The deal lead. */
  ownerId: uuid('owner_id'),
  receivedDate: date('received_date').notNull(),
  targetCommitment: money('target_commitment'),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  source: text('source'),
  /** A pass_reason.* code, required when the stage is Passed. */
  passReasonCode: text('pass_reason_code'),
  passNote: text('pass_note'),
  /** Set on close; unique, so one opportunity becomes at most one position. */
  investmentId: uuid('investment_id').unique(),
  scenarioTag: text('scenario_tag'),
  ...standardColumns,
});

/** One row per stage command; append-only (no update or delete is granted). */
export const opportunityStageHistory = deal.table('opportunity_stage_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  opportunityId: uuid('opportunity_id').notNull(),
  fromStage: dealStage('from_stage'),
  toStage: dealStage('to_stage').notNull(),
  command: text('command').notNull(),
  reason: text('reason'),
  changedBy: uuid('changed_by').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The diligence gate: tasks from config/diligence_templates.json per deal type. */
export const diligenceTask = deal.table('diligence_task', {
  id: uuid('id').primaryKey().defaultRandom(),
  opportunityId: uuid('opportunity_id').notNull(),
  /** A diligence_workstream.* code. */
  workstream: text('workstream').notNull(),
  title: text('title').notNull(),
  ownerId: uuid('owner_id'),
  dueDate: date('due_date'),
  /** open, done or waived (waived needs a reason). */
  status: text('status').notNull().default('open'),
  requiredForIc: boolean('required_for_ic').notNull().default(false),
  evidenceDocumentId: uuid('evidence_document_id'),
  waivedReason: text('waived_reason'),
  ...standardColumns,
});

/** The committee's decision, recorded by an approver and never edited; a later row supersedes. */
export const icDecision = deal.table('ic_decision', {
  id: uuid('id').primaryKey().defaultRandom(),
  opportunityId: uuid('opportunity_id').notNull(),
  decisionDate: date('decision_date').notNull(),
  /** approved, declined or deferred. */
  decision: text('decision').notNull(),
  amount: money('amount'),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  /** Plain sentences. */
  conditions: jsonb('conditions').notNull().default([]),
  memoDocumentId: uuid('memo_document_id'),
  recordedBy: uuid('recorded_by').notNull(),
  ...standardColumns,
});

/**
 * How a deal is allocated across vehicles and, inside a vehicle, clients (docs/04 M22). Anchored on
 * the opportunity before close and on the investment after; a null client is the vehicle line.
 */
export const allocation = deal.table('allocation', {
  id: uuid('id').primaryKey().defaultRandom(),
  opportunityId: uuid('opportunity_id'),
  investmentId: uuid('investment_id'),
  vehicleId: uuid('vehicle_id').notNull(),
  clientId: uuid('client_id'),
  requested: money('requested').notNull(),
  received: money('received'),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  ...standardColumns,
});

/**
 * The closing record (docs/04 M8). closeDate is the single source of every close date. The
 * opportunity is null only for a position that predates the pipeline.
 */
export const closing = deal.table('closing', {
  id: uuid('id').primaryKey().defaultRandom(),
  opportunityId: uuid('opportunity_id').unique(),
  investmentId: uuid('investment_id').unique(),
  closeDate: date('close_date').notNull(),
  commitmentAmount: money('commitment_amount').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  state: closingState('state').notNull().default('Open'),
  opsConfirmedBy: uuid('ops_confirmed_by'),
  opsConfirmedAt: timestamp('ops_confirmed_at', { withTimezone: true }),
  reopenReason: text('reopen_reason'),
  ...standardColumns,
});

/** The required-document checklist from config/closing_checklist.json, one row per item. */
export const closingItem = deal.table('closing_item', {
  id: uuid('id').primaryKey().defaultRandom(),
  closingId: uuid('closing_id').notNull(),
  itemCode: text('item_code').notNull(),
  label: text('label').notNull(),
  required: boolean('required').notNull(),
  documentId: uuid('document_id'),
  /** open, received (needs a document) or waived (needs a reason). */
  status: text('status').notNull().default('open'),
  waivedReason: text('waived_reason'),
  ...standardColumns,
});

/** A term captured at close (docs/04 M22), typed by the legal_term_type taxonomy. */
export const legalTerm = deal.table('legal_term', {
  id: uuid('id').primaryKey().defaultRandom(),
  closingId: uuid('closing_id').notNull(),
  /** Copied at close so the terms follow the position. */
  investmentId: uuid('investment_id'),
  termType: text('term_type').notNull(),
  value: jsonb('value').notNull(),
  sourceDocumentId: uuid('source_document_id'),
  /** draft or confirmed. */
  status: text('status').notNull().default('draft'),
  confirmedBy: uuid('confirmed_by'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  ...standardColumns,
});
