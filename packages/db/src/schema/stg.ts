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
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  receivedBy: uuid('received_by'),
  rowCount: integer('row_count').notNull().default(0),
  status: stagingStatus('status').notNull().default('new'),
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

export const stagedValuation = stg.table('valuation', {
  id: uuid('id').primaryKey().defaultRandom(),
  intakeFileId: uuid('intake_file_id'),
  reportDate: date('report_date').notNull(),
  investmentNumber: text('investment_number').notNull(),
  investmentId: uuid('investment_id'),
  reportedValue: numeric('reported_value', { precision: 20, scale: 2 }).notNull(),
  priorValue: numeric('prior_value', { precision: 20, scale: 2 }),
  variancePct: numeric('variance_pct', { precision: 12, scale: 8 }),
  flag: text('flag'),
  matchStatus: text('match_status').notNull().default('unmatched'),
  status: stagingStatus('status').notNull().default('new'),
  reviewerId: uuid('reviewer_id'),
  decision: text('decision'),
  ...standardColumns,
});
