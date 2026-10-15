import { sql } from 'drizzle-orm';
import {
  customType,
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

export const doc = pgSchema('doc');

/** Postgres full-text search vector; read as text, never written (the column is generated). */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * The document hub index (docs/04 M3, migration 0011): one row per item the document store holds,
 * with its metadata, the classifier's evidence and the first 2000 characters of its text for
 * search. reviewStatus follows the document classification machine (docs/18 section 6).
 */
export const document = doc.table('document', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The store the item lives in ('local_folder' in the prototype). */
  sourceSystem: text('source_system').notNull(),
  /** The store's own id: the path relative to the root. Unique with sourceSystem. */
  sourceItemId: text('source_item_id').notNull(),
  fileName: text('file_name').notNull(),
  folder: text('folder').notNull(),
  title: text('title').notNull(),
  /** A core.taxonomy_term code of the doc_type domain, null until classified. */
  docType: text('doc_type'),
  sponsorId: uuid('sponsor_id'),
  sponsorFundId: uuid('sponsor_fund_id'),
  investmentId: uuid('investment_id'),
  periodEnd: date('period_end'),
  confidentiality: text('confidentiality').notNull().default('confidential'),
  /** SHA-256 of the bytes, hex: finds duplicates. */
  contentHash: text('content_hash').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  pageCount: integer('page_count'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  reviewStatus: text('review_status').notNull().default('Received'),
  classificationConfidence: numeric('classification_confidence', { precision: 5, scale: 4 }),
  /** Matched keywords and candidates by reason only, as the contract shapes them. */
  classifierEvidence: jsonb('classifier_evidence').notNull().default({}),
  classifiedBy: uuid('classified_by'),
  classifiedAt: timestamp('classified_at', { withTimezone: true }),
  duplicateOfId: uuid('duplicate_of_id'),
  /** The first 2000 characters of the extracted text, for search only. */
  textExcerpt: text('text_excerpt'),
  searchText: tsvector('search_text').generatedAlwaysAs(
    sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(file_name, '') || ' ' || coalesce(text_excerpt, ''))`,
  ),
  ...standardColumns,
});

/**
 * A document the firm expects for a period from an investment or a sponsor fund (one or the other).
 * Its status (expected, received, late, missing) is derived at read time from the clock and
 * config/definitions.json documents.*, never stored.
 */
export const expectedDocument = doc.table('expected_document', {
  id: uuid('id').primaryKey().defaultRandom(),
  investmentId: uuid('investment_id'),
  sponsorFundId: uuid('sponsor_fund_id'),
  periodEnd: date('period_end').notNull(),
  docType: text('doc_type').notNull(),
  dueDate: date('due_date').notNull(),
  receivedDocumentId: uuid('received_document_id'),
  ...standardColumns,
});

/**
 * One model call over one document against one extraction schema (a key of
 * config/extraction_schema.json), through the extraction run machine (docs/18 section 7). The
 * investment is denormalized so the run carries the wall of the document it reads.
 */
export const extractionRun = doc.table('extraction_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull(),
  investmentId: uuid('investment_id'),
  periodEnd: date('period_end'),
  schemaId: text('schema_id').notNull(),
  promptId: text('prompt_id').notNull(),
  promptVersion: text('prompt_version').notNull(),
  modelId: text('model_id'),
  state: text('state').notNull().default('Queued'),
  /** The ops.job row of the batch that queued the run. */
  batchId: uuid('batch_id'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costUsd: numeric('cost_usd', { precision: 12, scale: 4 }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  errorCode: text('error_code'),
  /** 'schema' (the output failed validation) or 'transient' (the call failed), for the retry budget. */
  errorKind: text('error_kind'),
  schemaRetries: integer('schema_retries').notNull().default(0),
  transientRetries: integer('transient_retries').notNull().default(0),
  requestedBy: uuid('requested_by'),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  /** The mon.quarterly_performance row the approved values were promoted into. */
  promotedRecordId: uuid('promoted_record_id'),
  ...standardColumns,
});
