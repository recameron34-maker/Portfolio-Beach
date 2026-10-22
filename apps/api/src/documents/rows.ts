import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isCalendarDate } from '@pb/calc';
import { classifierEvidence, documentReviewStatus, extractionRunState } from '@pb/contracts';
import type {
  DocumentDetail,
  DocumentDuplicate,
  DocumentReviewStatus,
  DocumentSummary,
  ExtractionRunState,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { EXACT_AT_FORMAT } from '../common/cursor.js';

/*
 * How the hub reads a document for a caller: one select with the names its links carry (the
 * fund, the investment number and company, the person who classified it), each joined under the
 * caller's own row-level security, so a document attached to a position past their walls is not
 * there at all (migration 0011, SEC-5.3), and the latest extraction run per document read the
 * same way. The list, the review queue, the detail and the commands share these.
 */

export const NOT_FOUND = 'Document not found';
/** The store the prototype indexes (docs/04 M3: SharePoint in production). */
export const SOURCE_SYSTEM = 'local_folder';
/** The folder the index scans. */
export const INBOX = 'inbox';

export const d = schema.document;
const run = schema.extractionRun;
const classifier = alias(schema.appUser, 'classifier');

export const documentColumns = {
  id: d.id,
  title: d.title,
  fileName: d.fileName,
  folder: d.folder,
  docType: d.docType,
  reviewStatus: d.reviewStatus,
  sponsorId: d.sponsorId,
  sponsorFundId: d.sponsorFundId,
  sponsorFundName: schema.sponsorFund.name,
  investmentId: d.investmentId,
  investmentNumber: schema.investment.investmentNumber,
  companyName: schema.portfolioCompany.name,
  periodEnd: d.periodEnd,
  confidentiality: d.confidentiality,
  contentHash: d.contentHash,
  sizeBytes: d.sizeBytes,
  pageCount: d.pageCount,
  receivedAt: d.receivedAt,
  indexedAt: d.indexedAt,
  classificationConfidence: d.classificationConfidence,
  classifierEvidence: d.classifierEvidence,
  classifiedBy: classifier.displayName,
  classifiedAt: d.classifiedAt,
  duplicateOfId: d.duplicateOfId,
  /** The exact index time the (indexedAt, id) cursor carries (common/cursor.ts). */
  exactAt: sql<string>`to_char(${d.indexedAt} at time zone 'UTC', ${EXACT_AT_FORMAT})`,
};

/** A document row as the select reads it. */
export interface LoadedDocument {
  id: string;
  title: string;
  fileName: string;
  folder: string;
  docType: string | null;
  reviewStatus: string;
  sponsorId: string | null;
  sponsorFundId: string | null;
  sponsorFundName: string | null;
  investmentId: string | null;
  investmentNumber: string | null;
  companyName: string | null;
  periodEnd: string | null;
  confidentiality: string;
  contentHash: string;
  sizeBytes: number;
  pageCount: number | null;
  receivedAt: Date;
  indexedAt: Date;
  classificationConfidence: string | null;
  classifierEvidence: unknown;
  classifiedBy: string | null;
  classifiedAt: Date | null;
  duplicateOfId: string | null;
  exactAt: string;
}

/** The hub's one select: the rows matching the conditions, newest first by (indexedAt, id), at most `limit`. */
export function loadDocuments(
  tx: Tx,
  options: { where?: SQL | undefined; limit: number },
): Promise<LoadedDocument[]> {
  return tx
    .select(documentColumns)
    .from(d)
    .leftJoin(schema.sponsorFund, eq(schema.sponsorFund.id, d.sponsorFundId))
    .leftJoin(schema.investment, eq(schema.investment.id, d.investmentId))
    .leftJoin(
      schema.portfolioCompany,
      eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
    )
    .leftJoin(classifier, eq(classifier.id, d.classifiedBy))
    .where(options.where)
    .orderBy(desc(d.indexedAt), desc(d.id))
    .limit(options.limit);
}

export type LatestRun = { id: string; state: ExtractionRunState } | null;

/** The newest extraction run per document among those given, under the caller's row-level security. */
export async function latestRunsFor(
  tx: Tx,
  documentIds: readonly string[],
): Promise<Map<string, LatestRun>> {
  const out = new Map<string, LatestRun>();
  if (documentIds.length === 0) return out;
  const rows = await tx
    .selectDistinctOn([run.documentId], {
      documentId: run.documentId,
      id: run.id,
      state: run.state,
    })
    .from(run)
    .where(inArray(run.documentId, [...documentIds]))
    .orderBy(run.documentId, desc(run.createdAt), desc(run.id));
  for (const r of rows)
    out.set(r.documentId, { id: r.id, state: extractionRunState.parse(r.state) });
  return out;
}

/** A row for the caller, with the jsonb evidence checked against the contract. */
export function toSummary(r: LoadedDocument, latestRun: LatestRun): DocumentSummary {
  return {
    id: r.id,
    title: r.title,
    fileName: r.fileName,
    folder: r.folder,
    docType: r.docType,
    reviewStatus: documentReviewStatus.parse(r.reviewStatus),
    sponsorId: r.sponsorId,
    sponsorFundId: r.sponsorFundId,
    sponsorFundName: r.sponsorFundName,
    investmentId: r.investmentId,
    investmentNumber: r.investmentNumber,
    companyName: r.companyName,
    periodEnd: r.periodEnd !== null && isCalendarDate(r.periodEnd) ? r.periodEnd : null,
    confidentiality: documentConfidentialityOf(r.confidentiality),
    contentHash: r.contentHash,
    sizeBytes: r.sizeBytes,
    pageCount: r.pageCount,
    receivedAt: r.receivedAt.toISOString(),
    indexedAt: r.indexedAt.toISOString(),
    classificationConfidence: r.classificationConfidence,
    classifierEvidence: classifierEvidence.parse(evidenceOrEmpty(r.classifierEvidence)),
    classifiedBy: r.classifiedBy,
    classifiedAt: r.classifiedAt === null ? null : r.classifiedAt.toISOString(),
    duplicateOfId: r.duplicateOfId,
    latestRun,
  };
}

/** The stored evidence, or the empty evidence for a row the index wrote before any classification ({}). */
function evidenceOrEmpty(stored: unknown): unknown {
  if (stored !== null && typeof stored === 'object' && 'keywords' in stored) return stored;
  return { keywords: [], candidates: [] };
}

function documentConfidentialityOf(value: string): DocumentSummary['confidentiality'] {
  return value === 'internal' || value === 'restricted' ? value : 'confidential';
}

/** The other indexed items carrying the same content, newest first, as the caller may see them. */
export async function duplicatesOf(tx: Tx, documentId: string): Promise<DocumentDuplicate[]> {
  const rows = await tx
    .select({
      id: d.id,
      fileName: d.fileName,
      folder: d.folder,
      indexedAt: d.indexedAt,
      reviewStatus: d.reviewStatus,
    })
    .from(d)
    .where(eq(d.duplicateOfId, documentId))
    .orderBy(desc(d.indexedAt), desc(d.id));
  return rows.map((r) => ({
    id: r.id,
    fileName: r.fileName,
    folder: r.folder,
    indexedAt: r.indexedAt.toISOString(),
    reviewStatus: documentReviewStatus.parse(r.reviewStatus),
  }));
}

/** The document as the detail answers it, or null when the caller cannot see it. */
export async function loadDetail(tx: Tx, documentId: string): Promise<DocumentDetail | null> {
  const rows = await loadDocuments(tx, { where: eq(d.id, documentId), limit: 1 });
  const row = rows[0];
  if (row === undefined) return null;
  const runs = await latestRunsFor(tx, [row.id]);
  return {
    ...toSummary(row, runs.get(row.id) ?? null),
    duplicates: await duplicatesOf(tx, row.id),
  };
}

/** The stored review status as the machine knows it; anything else is a row the hub cannot work. */
export function reviewStatusOf(value: string): DocumentReviewStatus {
  return documentReviewStatus.parse(value);
}
