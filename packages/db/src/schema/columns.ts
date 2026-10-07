import { integer, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Standard columns on every table (docs/03 section 1). */
export const standardColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  rowVersion: integer('row_version').notNull().default(1),
};

/** Lineage columns on any table whose values come from outside (docs/03 section 1). */
export const lineageColumns = {
  sourceDocumentId: uuid('source_document_id'),
  sourcePage: integer('source_page'),
  sourceLocator: text('source_locator'),
  extractionRunId: uuid('extraction_run_id'),
  promptVersion: text('prompt_version'),
  modelId: text('model_id'),
};

/** Approval columns on any table that can reach a client or the accounting system. */
export const approvalColumns = {
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvalReason: text('approval_reason'),
};

import { text } from 'drizzle-orm/pg-core';
