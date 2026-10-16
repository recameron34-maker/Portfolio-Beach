import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { promptRef } from '@pb/ai';
import type { ExtractionSchema, ExtractionSchemas } from '@pb/ai';
import type {
  ExtractionBatch,
  ExtractionBatchBody,
  ExtractionBatchPage,
  ExtractionRunDetail,
  ExtractionRunPage,
  PageLayout,
  extractionRunListQuery,
  pageQuery,
} from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import type { PdfDocument } from '@pb/pdf';
import type { z } from 'zod';
import { AT_ID_CURSOR, decodeAtIdCursor, encodeCursor } from '../common/cursor.js';
import { ProblemError } from '../common/problem.js';
import { ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import { isPdfError, readDocument, unreadableProblem } from '../documents/read.js';
import { NOT_FOUND as DOCUMENT_NOT_FOUND } from '../documents/rows.js';
import {
  EXTRACTION_SCHEMAS,
  documentSettingsOf,
  extractionSettingsOf,
} from '../documents/settings.js';
import { ExtractionRunner } from './runner.js';
import {
  RUN_NOT_FOUND,
  batchRunsFor,
  countsFor,
  emptyCounts,
  job,
  loadBatches,
  loadRunDetail,
  loadRuns,
  run,
  toBatch,
  toRun,
} from './rows.js';
import { BATCH_JOB_TYPE, schemaForDocType } from './settings.js';

/*
 * Batches and the run reads (docs/04 M4, decision 0012). A batch (operations) names documents or
 * a (period end, document type) selection; every document must be Classified, carry a type an
 * extraction schema covers, and be indexed (M3 AC: nothing is extracted without an index row).
 * The batch is an ops.job row with one Queued run per document, written as the system actor
 * inside the caller's transaction (migration 0011: walled documents get their runs too, as the
 * expected-document generation covers walled positions), then driven inline by the runner. The
 * lists and the detail run under the caller's own row-level security, so a run on a document
 * past their walls is not found; a batch's counts cover the runs the caller sees.
 */

export type RunListOptions = z.infer<typeof extractionRunListQuery>;
export type PageOptions = z.infer<typeof pageQuery>;

const d = schema.document;
const BATCH_NOT_FOUND = 'Extraction batch not found';

/** A document as the batch checks it. */
interface SelectedDocument {
  id: string;
  fileName: string;
  reviewStatus: string;
  docType: string | null;
  investmentId: string | null;
  periodEnd: string | null;
}

/** A refusal of the batch: a document that cannot be extracted (422). */
const refused = (detail: string): ProblemError =>
  new ProblemError(422, 'workflow-precondition', detail);

@Injectable()
export class ExtractionService {
  constructor(
    private readonly db: DbService,
    private readonly runner: ExtractionRunner,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
    @Inject(EXTRACTION_SCHEMAS) private readonly schemas: ExtractionSchemas,
  ) {}

  /**
   * Create and drive a batch (operations). Refused while the kill switch is off (409), for a
   * document that is not Classified, for a type without a schema, and for an empty selection
   * (422 naming the first). The job and its Queued runs are written first, in one audited
   * transaction, then processed; the batch is answered as the caller sees it afterwards.
   */
  async createBatch(
    principal: Principal,
    requestId: string,
    body: ExtractionBatchBody,
  ): Promise<ExtractionBatch> {
    await this.runner.assertSwitchOn();
    const settings = extractionSettingsOf(this.definitions);
    const { jobId, runIds } = await this.db.run(principal, requestId, async (tx, audit) => {
      const { documents, extractionSchema } = await this.select(tx, body);
      const ref = promptRef(extractionSchema.promptId);
      const created = await asSystemActor(tx, async (stx) => {
        const inserted = (
          await stx
            .insert(job)
            .values({ jobType: BATCH_JOB_TYPE, requestedBy: principal.userId })
            .returning()
        )[0];
        if (inserted === undefined)
          throw new ProblemError(500, 'internal', 'extraction: the batch was not written');
        const runs = await stx
          .insert(run)
          .values(
            documents.map((doc) => ({
              documentId: doc.id,
              investmentId: doc.investmentId,
              periodEnd: doc.periodEnd,
              schemaId: extractionSchema.id,
              promptId: ref.promptId,
              promptVersion: ref.promptVersion,
              batchId: inserted.id,
              requestedBy: principal.userId,
            })),
          )
          .returning();
        return { jobId: inserted.id, runs };
      });
      const fileNames = new Map(documents.map((doc) => [doc.id, doc.fileName]));
      for (const r of created.runs)
        await audit({
          action: 'extraction_run.queue',
          entity: 'doc.extraction_run',
          entityId: r.id,
          details: {
            documentId: r.documentId,
            fileName: fileNames.get(r.documentId) ?? null,
            batchId: created.jobId,
            schemaId: extractionSchema.id,
            state: { before: null, after: 'Queued' },
          },
        });
      await audit({
        action: 'extraction_batch.create',
        entity: 'ops.job',
        entityId: created.jobId,
        details: {
          schemaId: extractionSchema.id,
          runs: created.runs.length,
          selection:
            'documentIds' in body
              ? { documents: body.documentIds.length }
              : { periodEnd: body.periodEnd, docType: body.docType },
        },
      });
      // The document order is the processing order: by index time, so the runs of a batch are
      // driven in the order the documents arrived.
      const order = new Map(documents.map((doc, i) => [doc.id, i]));
      return {
        jobId: created.jobId,
        runIds: [...created.runs]
          .sort((a, b) => (order.get(a.documentId) ?? 0) - (order.get(b.documentId) ?? 0))
          .map((r) => r.id),
      };
    });
    // Inline in the prototype; Temporal is the production slot (decision 0012).
    await this.runner.processBatch(principal, requestId, jobId, runIds, settings.batchConcurrency);
    return this.db.run(principal, requestId, async (tx) => {
      const batch = await this.loadBatch(tx, jobId);
      if (batch === null) throw new ProblemError(404, 'not-found', BATCH_NOT_FOUND);
      return batch;
    });
  }

  /**
   * The documents a batch covers, checked: ids named are read under the caller's own row-level
   * security (one they cannot see is not found); a (period end, type) selection is read as the
   * system actor over the whole book and takes Classified documents only. Every document must be
   * Classified and of a type an extraction schema covers.
   */
  private async select(
    tx: Tx,
    body: ExtractionBatchBody,
  ): Promise<{ documents: SelectedDocument[]; extractionSchema: ExtractionSchema }> {
    const columns = {
      id: d.id,
      fileName: d.fileName,
      reviewStatus: d.reviewStatus,
      docType: d.docType,
      investmentId: d.investmentId,
      periodEnd: d.periodEnd,
    };
    if ('documentIds' in body) {
      const ids = [...new Set(body.documentIds)];
      const rows = await tx.select(columns).from(d).where(inArray(d.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const documents: SelectedDocument[] = [];
      for (const id of ids) {
        const row = byId.get(id);
        if (row === undefined) throw new ProblemError(404, 'not-found', DOCUMENT_NOT_FOUND);
        documents.push(row);
      }
      let extractionSchema: ExtractionSchema | null = null;
      for (const doc of documents) {
        if (doc.reviewStatus !== 'Classified')
          throw refused(
            `extraction: ${doc.fileName} is ${doc.reviewStatus}, not Classified; classify it first`,
          );
        const found = doc.docType === null ? null : schemaForDocType(this.schemas, doc.docType);
        if (found === null)
          throw refused(
            `extraction: no extraction schema for ${await this.labelOf(tx, doc.docType)} (${doc.fileName})`,
          );
        if (extractionSchema !== null && found.id !== extractionSchema.id)
          throw refused('extraction: a batch covers one document type; split the selection');
        extractionSchema = found;
      }
      if (extractionSchema === null) throw refused('extraction: no document to extract');
      return { documents, extractionSchema };
    }
    const extractionSchema = schemaForDocType(this.schemas, body.docType);
    if (extractionSchema === null)
      throw refused(`extraction: no extraction schema for ${await this.labelOf(tx, body.docType)}`);
    const documents = await asSystemActor(tx, (stx) =>
      stx
        .select(columns)
        .from(d)
        .where(
          and(
            eq(d.reviewStatus, 'Classified'),
            eq(d.docType, body.docType),
            eq(d.periodEnd, body.periodEnd),
          ),
        )
        .orderBy(asc(d.indexedAt), asc(d.id)),
    );
    if (documents.length === 0)
      throw refused(
        `extraction: no Classified ${await this.labelOf(tx, body.docType)} document for ${body.periodEnd}`,
      );
    return { documents, extractionSchema };
  }

  /** The plain label of a document type (core.taxonomy_term), or the code when it has none. */
  private async labelOf(tx: Tx, docType: string | null): Promise<string> {
    if (docType === null) return 'an unclassified document';
    const term = (
      await tx
        .select({ label: schema.taxonomyTerm.label })
        .from(schema.taxonomyTerm)
        .where(eq(schema.taxonomyTerm.code, docType))
    )[0];
    return term?.label ?? docType;
  }

  private async loadBatch(tx: Tx, jobId: string): Promise<ExtractionBatch | null> {
    const rows = await loadBatches(tx, {
      where: and(eq(job.id, jobId), eq(job.jobType, BATCH_JOB_TYPE)),
      limit: 1,
    });
    const row = rows[0];
    if (row === undefined) return null;
    const runs = await batchRunsFor(tx, [row.id]);
    return toBatch(row, runs.get(row.id));
  }

  /** Batches newest first on the (createdAt, id) cursor, each with the states, tokens and cost of the runs the caller sees. */
  async listBatches(
    principal: Principal,
    requestId: string,
    opts: PageOptions,
  ): Promise<ExtractionBatchPage> {
    const conditions: (SQL | undefined)[] = [eq(job.jobType, BATCH_JOB_TYPE)];
    if (opts.cursor !== undefined) {
      const key = decodeAtIdCursor(opts.cursor, AT_ID_CURSOR);
      const at = sql`${key.at}::timestamptz`;
      conditions.push(
        or(lt(job.createdAt, at), and(eq(job.createdAt, at), lt(job.id, sql`${key.id}::uuid`))),
      );
    }
    return this.db.run(principal, requestId, async (tx) => {
      const rows = await loadBatches(tx, { where: and(...conditions), limit: opts.limit + 1 });
      const page = rows.slice(0, opts.limit);
      const runs = await batchRunsFor(
        tx,
        page.map((b) => b.id),
      );
      const last = page[page.length - 1];
      return {
        items: page.map((b) => toBatch(b, runs.get(b.id))),
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.exactAt, last.id])
            : null,
      };
    });
  }

  /** Runs newest first on the (createdAt, id) cursor, filtered by state, document, investment or batch; what the caller may see. */
  async listRuns(
    principal: Principal,
    requestId: string,
    opts: RunListOptions,
  ): Promise<ExtractionRunPage> {
    const conditions: (SQL | undefined)[] = [];
    if (opts.state !== undefined) conditions.push(eq(run.state, opts.state));
    if (opts.documentId !== undefined) conditions.push(eq(run.documentId, opts.documentId));
    if (opts.investmentId !== undefined) conditions.push(eq(run.investmentId, opts.investmentId));
    if (opts.batchId !== undefined) conditions.push(eq(run.batchId, opts.batchId));
    if (opts.cursor !== undefined) {
      const key = decodeAtIdCursor(opts.cursor, AT_ID_CURSOR);
      const at = sql`${key.at}::timestamptz`;
      conditions.push(
        or(lt(run.createdAt, at), and(eq(run.createdAt, at), lt(run.id, sql`${key.id}::uuid`))),
      );
    }
    return this.db.run(principal, requestId, async (tx) => {
      const rows = await loadRuns(tx, { where: and(...conditions), limit: opts.limit + 1 });
      const page = rows.slice(0, opts.limit);
      const counts = await countsFor(
        tx,
        page.map((r) => r.id),
      );
      const last = page[page.length - 1];
      return {
        items: page.map((r) => toRun(r, counts.get(r.id) ?? emptyCounts())),
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.exactAt, last.id])
            : null,
      };
    });
  }

  /** The run for review with its document, values, narrative and page layouts; one the caller cannot see is 404. The open is audited. */
  async detail(principal: Principal, requestId: string, id: string): Promise<ExtractionRunDetail> {
    requireUuid(id, RUN_NOT_FOUND);
    const loaded = await this.db.run(principal, requestId, async (tx, audit) => {
      const found = await loadRunDetail(tx, id, this.schemas);
      if (found === null) throw new ProblemError(404, 'not-found', RUN_NOT_FOUND);
      await audit({ action: 'extraction_run.read', entity: 'doc.extraction_run', entityId: id });
      return found;
    });
    return this.withPages(loaded);
  }

  /** The detail completed with the page layouts, read from the store on demand. */
  async withPages(
    loaded: Omit<ExtractionRunDetail, 'pages'> & { sourceItemId: string },
  ): Promise<ExtractionRunDetail> {
    const { sourceItemId, ...detail } = loaded;
    return { ...detail, pages: await this.layouts(sourceItemId) };
  }

  /** The page layouts of an indexed item: every positioned text run per page, for click-to-source. */
  private async layouts(sourceItemId: string): Promise<PageLayout[]> {
    let bytes: Uint8Array;
    try {
      bytes = await this.adapters.documents.read(sourceItemId);
    } catch {
      throw new ProblemError(404, 'not-found', 'The document is no longer in the store');
    }
    let doc: PdfDocument;
    try {
      doc = await readDocument(bytes, documentSettingsOf(this.definitions));
    } catch (error) {
      if (isPdfError(error)) throw unreadableProblem(error);
      throw error;
    }
    return doc.pages.map((p) => ({
      number: p.number,
      width: p.width,
      height: p.height,
      runs: p.runs
        .filter((r) => r.text !== '')
        .map((r) => ({ x: r.x, y: r.y, size: r.size, text: r.text })),
    }));
  }
}
