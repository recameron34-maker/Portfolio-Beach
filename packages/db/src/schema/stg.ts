import {
  date,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { standardColumns } from './columns.js';

export const stg = pgSchema('stg');

export const stagingStatus = stg.enum('staging_status', [
  'new',
  'validated',
  'flagged',
  'approved',
  'rejected',
  'promoted',
]);

export const intakeFile = stg.table('intake_file', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  fileName: text('file_name').notNull(),
  contentHash: text('content_hash').notNull(),
  templateSignature: text('template_signature'),
  /** The date a file reports for when its rows do not carry it (a look-through run's as-of date). */
  asOf: date('as_of'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  receivedBy: uuid('received_by'),
  rowCount: integer('row_count').notNull().default(0),
  status: stagingStatus('status').notNull().default('new'),
  /** File-level findings (an unknown or missing column, an empty file); a refused file holds no rows. */
  findings: jsonb('findings').notNull().default([]),
  ...standardColumns,
});

export const intakeRow = stg.table('intake_row', {
  id: uuid('id').primaryKey().defaultRandom(),
  intakeFileId: uuid('intake_file_id').notNull(),
  rowNo: integer('row_no').notNull(),
  naturalKey: text('natural_key').notNull(),
  targetEntity: text('target_entity').notNull(),
  targetId: uuid('target_id'),
  payload: jsonb('payload').notNull(),
  diff: jsonb('diff').notNull().default({}),
  validation: jsonb('validation').notNull().default([]),
  status: stagingStatus('status').notNull().default('new'),
  reviewerId: uuid('reviewer_id'),
  decision: text('decision'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  ...standardColumns,
});

/**
 * Weekly report values (docs/04 M2 weekly-report-intake, migration 0010). The typed columns hold
 * the cells that parse; `raw` holds every cell as the file wrote it; `link` is the intake link and
 * `findings` the rule findings, as the contract shapes them. An approved value becomes a Draft
 * valuation of method weekly_report (valuationId).
 */
export const stagedValuation = stg.table('valuation', {
  id: uuid('id').primaryKey().defaultRandom(),
  intakeFileId: uuid('intake_file_id'),
  rowNo: integer('row_no').notNull(),
  reportDate: date('report_date'),
  investmentNumber: text('investment_number'),
  companyName: text('company_name'),
  investmentId: uuid('investment_id'),
  reportedValue: numeric('reported_value', { precision: 20, scale: 2 }),
  priorValue: numeric('prior_value', { precision: 20, scale: 2 }),
  priorSource: text('prior_source'),
  priorDate: date('prior_date'),
  variancePct: numeric('variance_pct', { precision: 20, scale: 8 }),
  flag: text('flag'),
  matchStatus: text('match_status').notNull().default('unmatched'),
  link: jsonb('link').notNull().default({}),
  findings: jsonb('findings').notNull().default([]),
  raw: jsonb('raw').notNull().default({}),
  status: stagingStatus('status').notNull().default('new'),
  reviewerId: uuid('reviewer_id'),
  decision: text('decision'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  valuationId: uuid('valuation_id'),
  ...standardColumns,
});
