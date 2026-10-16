import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ExtractionField, ExtractionSchemas } from '@pb/ai';
import {
  extractionBatchState,
  extractionDecision,
  extractionErrorKind,
  extractionFinding,
  extractionRunState,
  extractionUnit,
  extractionValidationState,
  isCalendarDate,
} from '@pb/contracts';
import type {
  ExtractedValue,
  ExtractionBatch,
  ExtractionRun,
  ExtractionRunDetail,
  ExtractionValueCounts,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { z } from 'zod';
import { EXACT_AT_FORMAT } from '../common/cursor.js';
import { ProblemError } from '../common/problem.js';
import { latestRunsFor, loadDocuments, toSummary } from '../documents/rows.js';
import { COMMENTARY_FIELD, HIGHLIGHTS_FIELD, NARRATIVE_FIELDS } from './settings.js';

/*
 * How the extraction engine reads a run, its values and a batch for a caller: one select per
 * shape with the names the ids carry (the document, the investment number and company, the
 * people who requested, approved and decided), each joined under the caller's own row-level
 * security, so a run on a document attached to a position past their walls is not there at all
 * (migration 0011, SEC-5.3). The counts of a run cover its schema fields: the highlights and the
 * commentary rows are decided like a value but reported as the narrative they are.
 */

export const RUN_NOT_FOUND = 'Extraction run not found';

export const run = schema.extractionRun;
export const value = schema.extractedValue;
export const job = schema.job;
const d = schema.document;
const requester = alias(schema.appUser, 'requester');
const approver = alias(schema.appUser, 'approver');
const reviewer = alias(schema.appUser, 'reviewer');

const exactAtOf = (column: AnyPgColumn): SQL<string> =>
  sql<string>`to_char(${column} at time zone 'UTC', ${EXACT_AT_FORMAT})`;

/** A run row as the select reads it, with the store id and hash of its document for the runner. */
export interface LoadedRun {
  id: string;
  documentId: string;
  documentTitle: string;
  fileName: string;
  sourceItemId: string;
  contentHash: string;
  pageCount: number | null;
  docType: string | null;
  investmentId: string | null;
  investmentNumber: string | null;
  companyName: string | null;
  periodEnd: string | null;
  schemaId: string;
  promptId: string;
  promptVersion: string;
  modelId: string | null;
  state: string;
  batchId: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  errorKind: string | null;
  schemaRetries: number;
  transientRetries: number;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  promotedRecordId: string | null;
  rowVersion: number;
  exactAt: string;
}

const runColumns = {
  id: run.id,
  documentId: run.documentId,
  documentTitle: d.title,
  fileName: d.fileName,
  sourceItemId: d.sourceItemId,
  contentHash: d.contentHash,
  pageCount: d.pageCount,
  docType: d.docType,
  investmentId: run.investmentId,
  investmentNumber: schema.investment.investmentNumber,
  companyName: schema.portfolioCompany.name,
  periodEnd: run.periodEnd,
  schemaId: run.schemaId,
  promptId: run.promptId,
  promptVersion: run.promptVersion,
  modelId: run.modelId,
  state: run.state,
  batchId: run.batchId,
  tokensIn: run.tokensIn,
  tokensOut: run.tokensOut,
  costUsd: run.costUsd,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  errorCode: run.errorCode,
  errorKind: run.errorKind,
  schemaRetries: run.schemaRetries,
  transientRetries: run.transientRetries,
  requestedBy: requester.displayName,
  approvedBy: approver.displayName,
  approvedAt: run.approvedAt,
  promotedRecordId: run.promotedRecordId,
  rowVersion: run.rowVersion,
  /** The exact creation time the (createdAt, id) cursor carries (common/cursor.ts). */
  exactAt: exactAtOf(run.createdAt),
};

/** The runs matching the conditions, newest first by (createdAt, id), at most `limit`; the document joined under the same wall. */
export function loadRuns(
  tx: Tx,
  options: { where?: SQL | undefined; limit: number },
): Promise<LoadedRun[]> {
  return tx
    .select(runColumns)
    .from(run)
    .innerJoin(d, eq(d.id, run.documentId))
    .leftJoin(schema.investment, eq(schema.investment.id, run.investmentId))
    .leftJoin(
      schema.portfolioCompany,
      eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
    )
    .leftJoin(requester, eq(requester.id, run.requestedBy))
    .leftJoin(approver, eq(approver.id, run.approvedBy))
    .where(options.where)
    .orderBy(desc(run.createdAt), desc(run.id))
    .limit(options.limit);
}

export const emptyCounts = (): ExtractionValueCounts => ({
  values: 0,
  clean: 0,
  flagged: 0,
  invalid: 0,
  decided: 0,
});

/** The value counts of the runs given, over their schema fields (not the narrative rows), as the caller sees them. */
export async function countsFor(
  tx: Tx,
  runIds: readonly string[],
): Promise<Map<string, ExtractionValueCounts>> {
  const out = new Map<string, ExtractionValueCounts>();
  if (runIds.length === 0) return out;
  const rows = await tx
    .select({
      runId: value.runId,
      values: sql<number>`count(*)::int`,
      clean: sql<number>`count(*) filter (where ${value.validationState} = 'clean')::int`,
      flagged: sql<number>`count(*) filter (where ${value.validationState} = 'flagged')::int`,
      invalid: sql<number>`count(*) filter (where ${value.validationState} = 'invalid')::int`,
      decided: sql<number>`count(*) filter (where ${value.decision} is not null)::int`,
    })
    .from(value)
    .where(
      and(
        inArray(value.runId, [...runIds]),
        sql`${value.field} not in (${sql.join(
          NARRATIVE_FIELDS.map((f) => sql`${f}`),
          sql`, `,
        )})`,
      ),
    )
    .groupBy(value.runId);
  for (const r of rows)
    out.set(r.runId, {
      values: r.values,
      clean: r.clean,
      flagged: r.flagged,
      invalid: r.invalid,
      decided: r.decided,
    });
  return out;
}

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

/** A run for the caller, with the stored state and kind checked against the contract. */
export function toRun(r: LoadedRun, counts: ExtractionValueCounts): ExtractionRun {
  return {
    id: r.id,
    documentId: r.documentId,
    documentTitle: r.documentTitle,
    fileName: r.fileName,
    investmentId: r.investmentId,
    investmentNumber: r.investmentNumber,
    companyName: r.companyName,
    periodEnd: r.periodEnd !== null && isCalendarDate(r.periodEnd) ? r.periodEnd : null,
    schemaId: r.schemaId,
    promptId: r.promptId,
    promptVersion: r.promptVersion,
    modelId: r.modelId,
    state: extractionRunState.parse(r.state),
    batchId: r.batchId,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costUsd: r.costUsd,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    errorCode: r.errorCode,
    errorKind: r.errorKind === null ? null : extractionErrorKind.parse(r.errorKind),
    schemaRetries: r.schemaRetries,
    transientRetries: r.transientRetries,
    requestedBy: r.requestedBy,
    approvedBy: r.approvedBy,
    approvedAt: iso(r.approvedAt),
    promotedRecordId: r.promotedRecordId,
    counts,
    rowVersion: r.rowVersion,
  };
}

/** A staged value as the select reads it, with the name of the person who decided it. */
export interface LoadedValue {
  id: string;
  runId: string;
  field: string;
  value: string | null;
  unit: string | null;
  page: number | null;
  quote: string | null;
  confidence: string | null;
  validationState: string;
  findings: unknown;
  reviewerId: string | null;
  decidedBy: string | null;
  decision: string | null;
  editedValue: string | null;
  decidedAt: Date | null;
  rowVersion: number;
}

/** Every staged row of a run, schema fields and narrative alike, as the caller sees them. */
export function loadValues(tx: Tx, runId: string): Promise<LoadedValue[]> {
  return tx
    .select({
      id: value.id,
      runId: value.runId,
      field: value.field,
      value: value.value,
      unit: value.unit,
      page: value.page,
      quote: value.quote,
      confidence: value.confidence,
      validationState: value.validationState,
      findings: value.findings,
      reviewerId: value.reviewerId,
      decidedBy: reviewer.displayName,
      decision: value.decision,
      editedValue: value.editedValue,
      decidedAt: value.decidedAt,
      rowVersion: value.rowVersion,
    })
    .from(value)
    .leftJoin(reviewer, eq(reviewer.id, value.reviewerId))
    .where(eq(value.runId, runId));
}

const findingsList = z.array(extractionFinding);

/** The stored findings as the contract shapes them; a row written before any validation reads as none. */
export function findingsOf(stored: unknown): ExtractedValue['findings'] {
  const parsed = findingsList.safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** A staged value for the caller, labeled by its schema field. */
export function toValue(r: LoadedValue, field: ExtractionField): ExtractedValue {
  return {
    id: r.id,
    field: r.field,
    label: field.label,
    kind: field.kind,
    required: field.required,
    value: r.value,
    unit: r.unit === null ? null : extractionUnit.parse(r.unit),
    page: r.page,
    quote: r.quote,
    confidence: r.confidence,
    validationState: extractionValidationState.parse(r.validationState),
    findings: findingsOf(r.findings),
    decision: r.decision === null ? null : extractionDecision.parse(r.decision),
    editedValue: r.editedValue,
    decidedBy: r.decidedBy,
    decidedAt: iso(r.decidedAt),
  };
}

const highlightsList = z.array(z.string());

/** The drafted highlights a staged row holds (a JSON array as text); an unreadable row reads as none. */
export function highlightsOf(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const parsed = highlightsList.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The narrative of a run from its two staged rows: the highlights and the commentary as drafted. */
export function narrativeOf(values: readonly LoadedValue[]): {
  highlights: string[];
  commentary: string | null;
} {
  const highlights = values.find((v) => v.field === HIGHLIGHTS_FIELD);
  const commentary = values.find((v) => v.field === COMMENTARY_FIELD);
  return {
    highlights: highlightsOf(highlights?.value ?? null),
    commentary: commentary?.value ?? null,
  };
}

/** The run detail without its page layouts (read from the store afterwards), or null when the caller cannot see the run. */
export async function loadRunDetail(
  tx: Tx,
  runId: string,
  schemas: ExtractionSchemas,
): Promise<(Omit<ExtractionRunDetail, 'pages'> & { sourceItemId: string }) | null> {
  const loaded = (await loadRuns(tx, { where: eq(run.id, runId), limit: 1 }))[0];
  if (loaded === undefined) return null;
  const extractionSchema = schemas[loaded.schemaId];
  if (extractionSchema === undefined)
    throw new ProblemError(
      500,
      'configuration',
      `config/extraction_schema.json no longer holds the schema ${loaded.schemaId}`,
    );
  const counts = (await countsFor(tx, [loaded.id])).get(loaded.id) ?? emptyCounts();
  const values = await loadValues(tx, loaded.id);
  const byField = new Map(values.map((v) => [v.field, v]));
  const document = (await loadDocuments(tx, { where: eq(d.id, loaded.documentId), limit: 1 }))[0];
  if (document === undefined) return null;
  const latest = (await latestRunsFor(tx, [document.id])).get(document.id) ?? null;
  return {
    run: toRun(loaded, counts),
    document: toSummary(document, latest),
    // In schema order: the review page puts flagged and invalid values first itself.
    values: extractionSchema.fields.flatMap((field) => {
      const row = byField.get(field.key);
      return row === undefined ? [] : [toValue(row, field)];
    }),
    ...narrativeOf(values),
    sourceItemId: loaded.sourceItemId,
  };
}

/** A batch (ops.job) row as the select reads it. */
export interface LoadedBatch {
  id: string;
  state: string;
  progress: number;
  requestedBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  exactAt: string;
}

/** Batches newest first by (createdAt, id), at most `limit`. */
export function loadBatches(
  tx: Tx,
  options: { where?: SQL | undefined; limit: number },
): Promise<LoadedBatch[]> {
  return tx
    .select({
      id: job.id,
      state: job.state,
      progress: job.progress,
      requestedBy: requester.displayName,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      errorCode: job.errorCode,
      exactAt: exactAtOf(job.createdAt),
    })
    .from(job)
    .leftJoin(requester, eq(requester.id, job.requestedBy))
    .where(options.where)
    .orderBy(desc(job.createdAt), desc(job.id))
    .limit(options.limit);
}

/** The run states, tokens and cost of the batches given, over the runs the caller sees. */
export async function batchRunsFor(
  tx: Tx,
  batchIds: readonly string[],
): Promise<Map<string, Pick<ExtractionBatch, 'runs' | 'tokensIn' | 'tokensOut' | 'costUsd'>>> {
  const out = new Map<
    string,
    Pick<ExtractionBatch, 'runs' | 'tokensIn' | 'tokensOut' | 'costUsd'>
  >();
  if (batchIds.length === 0) return out;
  const rows = await tx
    .select({
      batchId: run.batchId,
      total: sql<number>`count(*)::int`,
      queued: sql<number>`count(*) filter (where ${run.state} = 'Queued')::int`,
      running: sql<number>`count(*) filter (where ${run.state} = 'Running')::int`,
      succeeded: sql<number>`count(*) filter (where ${run.state} = 'Succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${run.state} = 'Failed')::int`,
      needsRetry: sql<number>`count(*) filter (where ${run.state} = 'NeedsRetry')::int`,
      tokensIn: sql<number>`coalesce(sum(${run.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${run.tokensOut}), 0)::int`,
      costUsd: sql<string>`coalesce(sum(${run.costUsd}), 0)::numeric(14,4)::text`,
    })
    .from(run)
    .where(inArray(run.batchId, [...batchIds]))
    .groupBy(run.batchId);
  for (const r of rows) {
    if (r.batchId === null) continue;
    out.set(r.batchId, {
      runs: {
        total: r.total,
        queued: r.queued,
        running: r.running,
        succeeded: r.succeeded,
        failed: r.failed,
        needsRetry: r.needsRetry,
      },
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costUsd: r.costUsd,
    });
  }
  return out;
}

const NO_RUNS = {
  runs: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, needsRetry: 0 },
  tokensIn: 0,
  tokensOut: 0,
  costUsd: '0.0000',
};

export function toBatch(
  b: LoadedBatch,
  runs: Pick<ExtractionBatch, 'runs' | 'tokensIn' | 'tokensOut' | 'costUsd'> | undefined,
): ExtractionBatch {
  return {
    id: b.id,
    state: extractionBatchState.parse(b.state),
    progress: b.progress,
    requestedBy: b.requestedBy,
    createdAt: b.createdAt.toISOString(),
    startedAt: iso(b.startedAt),
    finishedAt: iso(b.finishedAt),
    errorCode: b.errorCode,
    ...(runs ?? NO_RUNS),
  };
}
