import {
  boolean,
  date,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { standardColumns } from './columns.js';

export const rpt = pgSchema('rpt');

/** docs/18 section 5. */
export const packageState = rpt.enum('package_state', [
  'Draft',
  'Generated',
  'QAFailed',
  'QAPassed',
  'InReview',
  'Approved',
  'Released',
]);
export const packageBasis = rpt.enum('package_basis', ['gross', 'net']);
export const packageLabel = rpt.enum('package_label', ['preliminary', 'final']);

/**
 * One client report for one period and basis (docs/04 M14, migration 0019). Prepared by one
 * person and reviewed by another, locked with a content hash when approved, immutable once
 * Released: a correction is a new version with a reason.
 */
export const reportingPackage = rpt.table('package', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull(),
  periodEnd: date('period_end').notNull(),
  /** The date the package's figures were read as of. */
  asOf: date('as_of').notNull(),
  basis: packageBasis('basis').notNull(),
  label: packageLabel('label').notNull(),
  version: integer('version').notNull().default(1),
  state: packageState('state').notNull().default('Draft'),
  preparedBy: uuid('prepared_by').notNull(),
  reviewerId: uuid('reviewer_id'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  /** SHA-256 of the approved content, hex. */
  contentHash: text('content_hash'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedBy: uuid('released_by'),
  correctionReason: text('correction_reason'),
  /** What changed between generations; never written into an output file. */
  changeLog: jsonb('change_log').notNull().default([]),
  ...standardColumns,
});

/** What the report QA engine found on one run (docs/08 section 7); only the override is ever added. */
export const qaResult = rpt.table('qa_result', {
  id: uuid('id').primaryKey().defaultRandom(),
  packageId: uuid('package_id').notNull(),
  runNo: integer('run_no').notNull(),
  rule: text('rule').notNull(),
  entityRef: text('entity_ref').notNull(),
  expected: text('expected'),
  actual: text('actual'),
  passed: boolean('passed').notNull(),
  detail: text('detail').notNull(),
  overrideReason: text('override_reason'),
  approverId: uuid('approver_id'),
  overriddenAt: timestamp('overridden_at', { withTimezone: true }),
  ...standardColumns,
});
