import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, DocumentRef, Principal } from '@pb/adapters';
import {
  AiError,
  buildInput,
  classifierOutputSchema,
  parseDocumentFileName,
  promptRef,
  redact,
} from '@pb/ai';
import type { ClassifierOutput, DocumentFileName } from '@pb/ai';
import { D } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import type {
  DocumentCommandBody,
  DocumentDetail,
  DocumentIndexResult,
  DocumentPage,
  DocumentPages,
  documentListQuery,
  pageQuery,
} from '@pb/contracts';
import { SYSTEM_USER_ID, asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import type { PdfDocument } from '@pb/pdf';
import { attempt, documentClassificationMachine } from '@pb/workflows';
import type { DocumentCommand, DocumentState } from '@pb/workflows';
import type { z } from 'zod';
import { AT_ID_CURSOR, decodeAtIdCursor, encodeCursor } from '../common/cursor.js';
import type { Logger } from '../common/logging.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { ADAPTERS, DEFINITIONS, LOGGER } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import { FlagsService } from '../flags/flags.service.js';
import { matchExpectedDocument } from './expected.service.js';
import { documentDirectory, linkDocument } from './link.js';
import type { DocumentDirectory, DocumentLinks } from './link.js';
import {
  excerptOf,
  isPdfError,
  readDocument,
  stripExtension,
  titleOf,
  unreadableProblem,
} from './read.js';
import {
  INBOX,
  NOT_FOUND,
  SOURCE_SYSTEM,
  d,
  latestRunsFor,
  loadDetail,
  loadDocuments,
  reviewStatusOf,
  toSummary,
} from './rows.js';
import { classifierThresholdOf, documentSettingsOf } from './settings.js';
import type { DocumentDefinitions } from '@pb/contracts';

/*
 * The document hub (docs/04 M3, docs/18 section 6, decision 0012). The index scans the store's
 * inbox: an item already indexed under its path and hash is unchanged, an item whose bytes are
 * already indexed under another path is a Duplicate linked to the original, and a new item is
 * read with @pb/pdf and inserted as Received with the links its file name resolves (the
 * investment by exact company name, the sponsor fund by exact name or alias), so the wall of the
 * position it names holds from the first write on every path, with or without a model (SEC-5.3);
 * then classified through the model client (the keyword classifier in the prototype) when the
 * ai.classifier switch is on: the investment is linked again by the number the model read or the
 * name, and a confidence at or above definitions.classifierConfidenceThreshold classifies the
 * document, below it goes to the review queue with the evidence. With the switch off, a refused
 * or failed call, or an item the reader refuses, the document is flagged for review instead
 * (docs/18 section 6: nothing stays in Received), the unreadable one with a data exception
 * (DOC-READ-01). Every state change goes through documentClassificationMachine; the
 * index writes as the system actor inside the caller's transaction (migration 0011: walled
 * positions get their documents) and the caller's audit event records each change. Everything a
 * caller reads runs under their own row-level security: a document attached to a position past
 * their walls is not found, in the list, the search, the detail and the pages (SEC-8.5, M3 AC).
 * Every page is redacted before it reaches the model, and a model call is logged by its ids,
 * tokens and latency, never its content (SEC-8.7, SEC-8.9).
 */

export type DocumentListOptions = z.infer<typeof documentListQuery>;
export type PageOptions = z.infer<typeof pageQuery>;

/** The kill switch for classification during indexing (migration 0011, SEC-8.10). */
export const CLASSIFIER_SWITCH = 'ai.classifier';
const EXCEPTION_SOURCE = 'documents';
/** The rule of the data exception an unreadable item opens. */
export const UNREADABLE_RULE = 'DOC-READ-01';
const EXCEPTION_SEVERITY = 'exception_severity.high';
const ENTITY = 'doc.document';
const SYSTEM = { actorId: SYSTEM_USER_ID, actorRoles: ['service'] } as const;
const machine = documentClassificationMachine;

/** What the index did with one item of the store. */
type IndexOutcome =
  | { kind: 'unchanged' }
  | { kind: 'duplicate'; id: string; duplicateOfId: string }
  | {
      kind: 'indexed';
      id: string;
      command: DocumentCommand | null;
      state: DocumentState;
      docType: string | null;
      reason: string | null;
    };

/** The document the classifier is asked about. */
interface Classifiable {
  id: string;
  fileName: string;
  fromName: DocumentFileName | null;
  contentHash: string;
  pageCount: number;
}

/** The links a document carries, as the file name or the classifier resolved them. */
type Links = Pick<DocumentLinks, 'investmentId' | 'sponsorFundId' | 'sponsorId'>;

/**
 * The links the file name alone resolves, before any model runs: `<period> <Fund> - <Type> -
 * <Company>.pdf` names the position exactly or not at all (never fuzzy), so a report of a walled
 * position is attached to it on every path, the classifier off, failed or the file unreadable.
 */
function linksFromName(
  fromName: DocumentFileName | null,
  directory: DocumentDirectory,
): DocumentLinks {
  return linkDocument(
    {
      investmentNumber: null,
      companyName: fromName?.companyName ?? null,
      sponsorFundName: fromName?.sponsorFundName ?? null,
    },
    directory,
  );
}

/**
 * Writes a document row and answers its id, or null when the store's key (source_system,
 * source_item_id) is already taken: another scan indexed the item between this scan's read and
 * its write, and the item is then unchanged for this scan (docs/17 section 3, idempotency).
 */
async function insertDocument(stx: Tx, values: typeof d.$inferInsert): Promise<string | null> {
  const inserted = await stx
    .insert(d)
    .values(values)
    .onConflictDoNothing({ target: [d.sourceSystem, d.sourceItemId] })
    .returning();
  return inserted[0]?.id ?? null;
}

/** A file name with the " (n)" a mail client adds to a second delivery taken out, so the original sorts first. */
const baseName = (name: string): string => name.replace(/ \(\d+\)(\.[^.]*)?$/, '$1');

/**
 * The order the index takes the store's items in: by name with any " (n)" suffix removed, then
 * the plainly named item before its renamed copies, then by name, compared by code unit so the
 * order never depends on a locale. "report.pdf" is indexed before "report (1).pdf" and is the
 * original of the pair; deterministic for the same inbox.
 */
export function indexOrder(refs: readonly DocumentRef[]): DocumentRef[] {
  const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return [...refs].sort((a, b) => {
    const base = compare(baseName(a.name), baseName(b.name));
    if (base !== 0) return base;
    const plain = Number(a.name !== baseName(a.name)) - Number(b.name !== baseName(b.name));
    return plain !== 0 ? plain : compare(a.name, b.name);
  });
}

/** The problem when a command finds the document already changed by another command. */
const conflict = (): ProblemError =>
  new ProblemError(409, 'conflict', 'document: another command changed it first; open it again');

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DbService,
    private readonly flags: FlagsService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Scan the store (operations): every item of the inbox is indexed, linked to its original or
   * left as it is, in one transaction, with an audit event per document written and one with
   * the counts. Idempotent: a second scan over the same inbox changes nothing, and a scan that
   * overlaps another finds the items the other wrote first unchanged (the insert does nothing on
   * the store's key), never a unique violation (docs/17 section 3).
   */
  async index(principal: Principal, requestId: string): Promise<DocumentIndexResult> {
    const settings = documentSettingsOf(this.definitions);
    const threshold = classifierThresholdOf(this.definitions);
    const classifierOn = await this.flags.isEnabled(CLASSIFIER_SWITCH);
    const refs = indexOrder(await this.adapters.documents.list(INBOX));
    const now = new Date(this.adapters.clock.now());
    return this.db.run(principal, requestId, async (tx, audit) => {
      const directory = await asSystemActor(tx, documentDirectory);
      const result: DocumentIndexResult = { indexed: 0, duplicates: 0, unchanged: 0 };
      for (const ref of refs) {
        const outcome = await asSystemActor(tx, (stx) =>
          this.indexOne(stx, ref, directory, settings, threshold, classifierOn, now),
        );
        if (outcome.kind === 'unchanged') {
          result.unchanged += 1;
          continue;
        }
        if (outcome.kind === 'duplicate') {
          result.duplicates += 1;
          await audit({
            action: 'document.index',
            entity: ENTITY,
            entityId: outcome.id,
            details: {
              fileName: ref.name,
              command: 'markDuplicate',
              state: { before: machine.initial, after: 'Duplicate' },
              duplicateOfId: outcome.duplicateOfId,
            },
          });
          continue;
        }
        result.indexed += 1;
        await audit({
          action: 'document.index',
          entity: ENTITY,
          entityId: outcome.id,
          ...(outcome.reason === null ? {} : { reason: outcome.reason }),
          details: {
            fileName: ref.name,
            command: outcome.command,
            state: { before: machine.initial, after: outcome.state },
            docType: outcome.docType,
          },
        });
      }
      await audit({ action: 'documents.index', entity: ENTITY, details: { ...result } });
      return result;
    });
  }

  /** One item of the store, as the system actor: unchanged, a duplicate, or read and classified. */
  private async indexOne(
    stx: Tx,
    ref: DocumentRef,
    directory: DocumentDirectory,
    settings: DocumentDefinitions,
    threshold: Decimal,
    classifierOn: boolean,
    now: Date,
  ): Promise<IndexOutcome> {
    const existing = (
      await stx
        .select({ id: d.id, contentHash: d.contentHash })
        .from(d)
        .where(and(eq(d.sourceSystem, SOURCE_SYSTEM), eq(d.sourceItemId, ref.id)))
    )[0];
    if (existing !== undefined) {
      // An item whose bytes changed under an indexed path keeps its row: the index never
      // rewrites a classification, and the change is logged for operations to look at.
      if (existing.contentHash !== ref.contentHash)
        this.logger.warn(
          { document_id: existing.id },
          'an indexed item changed in the store; its row was left as it was',
        );
      return { kind: 'unchanged' };
    }
    const base = {
      sourceSystem: SOURCE_SYSTEM,
      sourceItemId: ref.id,
      fileName: ref.name,
      folder: ref.folder,
      contentHash: ref.contentHash,
      sizeBytes: ref.sizeBytes,
      receivedAt: new Date(ref.modifiedAt),
    };
    // The links the file name resolves are written with the row on every path below, so the wall
    // of the position named holds whether or not a model ever reads the document (SEC-5.3).
    const fromName = parseDocumentFileName(ref.name);
    const named = linksFromName(fromName, directory);
    const links: Links = {
      investmentId: named.investmentId,
      sponsorFundId: named.sponsorFundId,
      sponsorId: named.sponsorId,
    };

    // The same bytes indexed before: the earliest non-duplicate row is the original.
    const original = (
      await stx
        .select({
          id: d.id,
          title: d.title,
          pageCount: d.pageCount,
          investmentId: d.investmentId,
          sponsorFundId: d.sponsorFundId,
          sponsorId: d.sponsorId,
          periodEnd: d.periodEnd,
        })
        .from(d)
        .where(eq(d.contentHash, ref.contentHash))
        .orderBy(
          asc(sql`case when ${d.reviewStatus} = 'Duplicate' then 1 else 0 end`),
          asc(d.indexedAt),
          asc(d.id),
        )
        .limit(1)
    )[0];
    if (original !== undefined) {
      const marked = attempt(machine, machine.initial, 'markDuplicate', {
        ...SYSTEM,
        record: { sameHashAsExisting: true },
      });
      if (!marked.ok) throw workflowProblem(marked);
      // The duplicate carries the original's links (not its type: it is not classified), so the
      // wall on the original is the wall on the copy from the start; the classify command keeps
      // them aligned afterwards.
      const id = await insertDocument(stx, {
        ...base,
        title: original.title,
        pageCount: original.pageCount,
        reviewStatus: marked.to,
        duplicateOfId: original.id,
        investmentId: original.investmentId,
        sponsorFundId: original.sponsorFundId,
        sponsorId: original.sponsorId,
        periodEnd: original.periodEnd,
      });
      if (id === null) return { kind: 'unchanged' };
      return { kind: 'duplicate', id, duplicateOfId: original.id };
    }

    let doc: PdfDocument;
    try {
      doc = await readDocument(await this.adapters.documents.read(ref.id), settings);
    } catch (error) {
      if (!isPdfError(error)) throw error;
      const flagged = attempt(machine, machine.initial, 'flagForReview', { ...SYSTEM, record: {} });
      if (!flagged.ok) throw workflowProblem(flagged);
      const reason = `unreadable (${error.code})`;
      const id = await insertDocument(stx, { ...base, ...links, title: stripExtension(ref.name) });
      if (id === null) return { kind: 'unchanged' };
      await stx
        .update(d)
        .set({
          reviewStatus: flagged.to,
          classifierEvidence: {
            keywords: [],
            candidates: [{ reason }, ...named.candidates],
            reason: 'unreadable',
            code: error.code,
          },
        })
        .where(eq(d.id, id));
      await stx.insert(schema.dataException).values({
        source: EXCEPTION_SOURCE,
        entity: ENTITY,
        entityId: id,
        ruleId: UNREADABLE_RULE,
        expected: 'a PDF the reader accepts',
        actual: `the reader refused it (${error.code})`,
        severity: EXCEPTION_SEVERITY,
        state: 'open',
        candidates: [],
      });
      this.logger.warn({ document_id: id, code: error.code }, 'indexed item is unreadable');
      return {
        kind: 'indexed',
        id,
        command: 'flagForReview',
        state: flagged.to,
        docType: null,
        reason,
      };
    }

    const pageTexts = doc.pages.map((p) => p.text);
    const id = await insertDocument(stx, {
      ...base,
      ...links,
      title: titleOf(doc, ref.name),
      pageCount: doc.pageCount,
      textExcerpt: excerptOf(pageTexts),
    });
    if (id === null) return { kind: 'unchanged' };
    if (!classifierOn) {
      // The kill switch is a graceful degradation (docs/17 section 5): the item queues for a
      // person through the same transition a failed call takes, so nothing stays in Received.
      const flagged = attempt(machine, machine.initial, 'flagForReview', { ...SYSTEM, record: {} });
      if (!flagged.ok) throw workflowProblem(flagged);
      await stx
        .update(d)
        .set({
          reviewStatus: flagged.to,
          classifierEvidence: {
            keywords: [],
            candidates: named.candidates,
            reason: 'classifier off',
          },
        })
        .where(eq(d.id, id));
      return {
        kind: 'indexed',
        id,
        command: 'flagForReview',
        state: flagged.to,
        docType: null,
        reason: 'classifier off',
      };
    }
    return this.classify(
      stx,
      { id, fileName: ref.name, fromName, contentHash: ref.contentHash, pageCount: doc.pageCount },
      pageTexts,
      directory,
      threshold,
      now,
    );
  }

  /**
   * One model call over the redacted pages, then the links and the transition: autoClassify at
   * or above the threshold, flagForReview below it or when the call fails (the row then keeps
   * the links its file name resolved). The input is the shared frame of @pb/ai (metadata, then
   * the pages as data); the log line carries ids, token counts, latency and redaction counts only.
   */
  private async classify(
    stx: Tx,
    row: Classifiable,
    pageTexts: readonly string[],
    directory: DocumentDirectory,
    threshold: Decimal,
    now: Date,
  ): Promise<IndexOutcome> {
    const redactions: Record<string, number> = {};
    const pages = pageTexts.map((text) => {
      const r = redact(text);
      for (const [kind, n] of Object.entries(r.counts))
        if (n > 0) redactions[kind] = (redactions[kind] ?? 0) + n;
      return r.text;
    });
    const ref = promptRef('document_classifier');
    let output: ClassifierOutput | null = null;
    let failure: string | null = null;
    try {
      const input = buildInput({
        metadata: {
          file_name: row.fileName,
          content_hash: row.contentHash,
          page_count: row.pageCount,
        },
        pages,
      });
      const res = await this.adapters.ai.complete(
        { promptId: ref.promptId, promptVersion: ref.promptVersion, input },
        classifierOutputSchema,
      );
      this.logger.info(
        {
          prompt_id: ref.promptId,
          prompt_version: ref.promptVersion,
          model_id: res.modelId,
          tokens_in: res.tokensIn,
          tokens_out: res.tokensOut,
          latency_ms: res.latencyMs,
          document_id: row.id,
          redactions,
        },
        'classifier call',
      );
      output = res.output;
    } catch (error) {
      failure =
        error instanceof AiError
          ? `classifier input refused (${error.code})`
          : 'classifier call failed';
      this.logger.warn(
        {
          prompt_id: ref.promptId,
          prompt_version: ref.promptVersion,
          document_id: row.id,
          err:
            error instanceof Error ? { name: error.name, message: error.message } : String(error),
        },
        'classifier call failed',
      );
    }
    if (output === null) {
      const flagged = attempt(machine, machine.initial, 'flagForReview', { ...SYSTEM, record: {} });
      if (!flagged.ok) throw workflowProblem(flagged);
      await stx
        .update(d)
        .set({
          reviewStatus: flagged.to,
          classifierEvidence: { keywords: [], candidates: [{ reason: failure }], reason: failure },
        })
        .where(eq(d.id, row.id));
      return {
        kind: 'indexed',
        id: row.id,
        command: 'flagForReview',
        state: flagged.to,
        docType: null,
        reason: failure,
      };
    }

    const { fromName } = row;
    const links = linkDocument(
      {
        investmentNumber: output.investmentNumber ?? null,
        companyName: fromName?.companyName ?? null,
        sponsorFundName: output.sponsorFundName ?? fromName?.sponsorFundName ?? null,
      },
      directory,
    );
    const confident = D(output.confidence).gte(threshold);
    const command: DocumentCommand = confident ? 'autoClassify' : 'flagForReview';
    const result = attempt(machine, machine.initial, command, {
      ...SYSTEM,
      record: { confidenceAboveThreshold: confident },
    });
    if (!result.ok) throw workflowProblem(result);
    const candidates = confident
      ? links.candidates
      : [...links.candidates, { reason: `classifier suggestion: ${output.docType}` }];
    const periodEnd = output.periodEnd ?? null;
    await stx
      .update(d)
      .set({
        reviewStatus: result.to,
        docType: confident ? output.docType : null,
        investmentId: links.investmentId,
        sponsorFundId: links.sponsorFundId,
        sponsorId: links.sponsorId,
        periodEnd,
        classificationConfidence: output.confidence,
        classifierEvidence: { keywords: output.evidence, candidates },
        classifiedBy: null,
        classifiedAt: confident ? now : null,
      })
      .where(eq(d.id, row.id));
    if (confident)
      await matchExpectedDocument(stx, {
        id: row.id,
        docType: output.docType,
        periodEnd,
        investmentId: links.investmentId,
        sponsorFundId: links.sponsorFundId,
      });
    return {
      kind: 'indexed',
      id: row.id,
      command,
      state: result.to,
      docType: confident ? output.docType : null,
      reason: confident ? null : 'confidence below the threshold',
    };
  }

  /** Documents newest first with the hub's filters and the full-text query; what the caller may see. */
  async list(
    principal: Principal,
    requestId: string,
    opts: DocumentListOptions,
  ): Promise<DocumentPage> {
    const conditions: (SQL | undefined)[] = [];
    if (opts.q !== undefined)
      conditions.push(sql`${d.searchText} @@ plainto_tsquery('simple', ${opts.q})`);
    if (opts.docType !== undefined) conditions.push(eq(d.docType, opts.docType));
    if (opts.reviewStatus !== undefined) conditions.push(eq(d.reviewStatus, opts.reviewStatus));
    if (opts.investmentId !== undefined) conditions.push(eq(d.investmentId, opts.investmentId));
    if (opts.sponsorFundId !== undefined) conditions.push(eq(d.sponsorFundId, opts.sponsorFundId));
    if (opts.periodEnd !== undefined) conditions.push(eq(d.periodEnd, opts.periodEnd));
    return this.db.run(principal, requestId, (tx) => this.page(tx, opts, conditions));
  }

  /** The review queue: documents the classifier was not sure about, newest first. */
  async reviewQueue(
    principal: Principal,
    requestId: string,
    opts: PageOptions,
  ): Promise<DocumentPage> {
    return this.db.run(principal, requestId, (tx) =>
      this.page(tx, opts, [eq(d.reviewStatus, 'NeedsReview')]),
    );
  }

  /** One page on the (indexedAt, id) cursor (common/cursor.ts), with the latest run of each document. */
  private async page(
    tx: Tx,
    opts: PageOptions,
    conditions: (SQL | undefined)[],
  ): Promise<DocumentPage> {
    if (opts.cursor !== undefined) {
      const key = decodeAtIdCursor(opts.cursor, AT_ID_CURSOR);
      const at = sql`${key.at}::timestamptz`;
      conditions.push(
        or(lt(d.indexedAt, at), and(eq(d.indexedAt, at), lt(d.id, sql`${key.id}::uuid`))),
      );
    }
    const rows = await loadDocuments(tx, { where: and(...conditions), limit: opts.limit + 1 });
    const page = rows.slice(0, opts.limit);
    const runs = await latestRunsFor(
      tx,
      page.map((r) => r.id),
    );
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toSummary(r, runs.get(r.id) ?? null)),
      nextCursor:
        rows.length > opts.limit && last !== undefined
          ? encodeCursor([last.exactAt, last.id])
          : null,
    };
  }

  /** The document with its duplicates and latest run; one the caller cannot see is 404. The open is audited. */
  async detail(principal: Principal, requestId: string, id: string): Promise<DocumentDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const found = await loadDetail(tx, id);
      if (found === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      await audit({ action: 'document.read', entity: ENTITY, entityId: id });
      return found;
    });
  }

  /** The text of every page as lines, read from the store on demand; a document the reader refuses is a 422. */
  async pages(principal: Principal, requestId: string, id: string): Promise<DocumentPages> {
    requireUuid(id, NOT_FOUND);
    const settings = documentSettingsOf(this.definitions);
    const row = await this.db.run(principal, requestId, async (tx, audit) => {
      const found = (
        await tx.select({ id: d.id, sourceItemId: d.sourceItemId }).from(d).where(eq(d.id, id))
      )[0];
      if (found === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
      await audit({ action: 'document.pages.read', entity: ENTITY, entityId: id });
      return found;
    });
    let bytes: Uint8Array;
    try {
      bytes = await this.adapters.documents.read(row.sourceItemId);
    } catch {
      throw new ProblemError(404, 'not-found', 'The document is no longer in the store');
    }
    let doc: PdfDocument;
    try {
      doc = await readDocument(bytes, settings);
    } catch (error) {
      if (isPdfError(error)) throw unreadableProblem(error);
      throw error;
    }
    return {
      documentId: id,
      pageCount: doc.pageCount,
      pages: doc.pages.map((p) => ({ number: p.number, lines: p.lines.map((l) => l.text) })),
    };
  }

  /**
   * classify (deal team, operations): NeedsReview > Classified through the machine with the
   * body's type and links, each checked to exist and to be visible to the caller; a link left out
   * keeps what the classifier found. The row stays locked for the transaction; the expected
   * document is matched and the duplicates take the same links as the system actor; audited
   * with before and after.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: DocumentCommandBody,
  ): Promise<DocumentDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = (
        await tx
          .select({
            id: d.id,
            fileName: d.fileName,
            reviewStatus: d.reviewStatus,
            docType: d.docType,
            investmentId: d.investmentId,
            sponsorFundId: d.sponsorFundId,
            sponsorId: d.sponsorId,
            periodEnd: d.periodEnd,
            rowVersion: d.rowVersion,
          })
          .from(d)
          .where(eq(d.id, id))
          .for('update')
      )[0];
      if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
      const from = reviewStatusOf(locked.reviewStatus);
      const links = await this.checkLinks(tx, body, locked);
      const result = attempt(machine, from, body.command, {
        actorId: principal.userId,
        actorRoles: principal.roles,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        record: {},
      });
      if (!result.ok) throw workflowProblem(result);
      const after = {
        reviewStatus: result.to,
        docType: body.docType,
        investmentId: links.investmentId,
        sponsorFundId: links.sponsorFundId,
        sponsorId: links.sponsorId,
        periodEnd: body.periodEnd ?? locked.periodEnd,
      };
      const claimed = await tx
        .update(d)
        .set({
          ...after,
          classifiedBy: principal.userId,
          classifiedAt: new Date(this.adapters.clock.now()),
        })
        .where(and(eq(d.id, id), eq(d.rowVersion, locked.rowVersion)))
        .returning();
      if (claimed[0] === undefined) throw conflict();
      await asSystemActor(tx, async (stx) => {
        await stx
          .update(d)
          .set({
            investmentId: after.investmentId,
            sponsorFundId: after.sponsorFundId,
            sponsorId: after.sponsorId,
            periodEnd: after.periodEnd,
          })
          .where(eq(d.duplicateOfId, id));
        await matchExpectedDocument(stx, { id, ...after });
      });
      await audit({
        action: 'document.classify',
        entity: ENTITY,
        entityId: id,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        details: {
          fileName: locked.fileName,
          command: body.command,
          before: {
            reviewStatus: from,
            docType: locked.docType,
            investmentId: locked.investmentId,
            sponsorFundId: locked.sponsorFundId,
            periodEnd: locked.periodEnd,
          },
          after: {
            reviewStatus: after.reviewStatus,
            docType: after.docType,
            investmentId: after.investmentId,
            sponsorFundId: after.sponsorFundId,
            periodEnd: after.periodEnd,
          },
        },
      });
      const detail = await loadDetail(tx, id);
      if (detail === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return detail;
    });
  }

  /**
   * The type and the links of a classify command, each checked under the caller's own row-level
   * security: an unknown type, or an investment or fund the caller cannot open, is a 400 naming
   * the field, so nothing reveals whether a hidden record exists beyond "not one you may name".
   */
  private async checkLinks(
    tx: Tx,
    body: DocumentCommandBody,
    locked: { investmentId: string | null; sponsorFundId: string | null; sponsorId: string | null },
  ): Promise<{
    investmentId: string | null;
    sponsorFundId: string | null;
    sponsorId: string | null;
  }> {
    const errors: { path: string; message: string }[] = [];
    const term = (
      await tx
        .select({ code: schema.taxonomyTerm.code })
        .from(schema.taxonomyTerm)
        .where(
          and(
            eq(schema.taxonomyTerm.code, body.docType),
            eq(schema.taxonomyTerm.domain, 'doc_type'),
            eq(schema.taxonomyTerm.active, true),
          ),
        )
    )[0];
    if (term === undefined) errors.push({ path: 'docType', message: 'Unknown document type' });
    let investmentId = locked.investmentId;
    let sponsorFundId = locked.sponsorFundId;
    let sponsorId = locked.sponsorId;
    if (body.investmentId !== undefined) {
      const investment = (
        await tx
          .select({
            id: schema.investment.id,
            sponsorId: schema.investment.sponsorId,
            sponsorFundId: schema.investment.sponsorFundId,
          })
          .from(schema.investment)
          .where(eq(schema.investment.id, body.investmentId))
      )[0];
      if (investment === undefined)
        errors.push({ path: 'investmentId', message: 'Unknown investment' });
      else {
        investmentId = investment.id;
        sponsorId = investment.sponsorId;
        sponsorFundId = investment.sponsorFundId;
      }
    }
    if (body.sponsorFundId !== undefined) {
      const fund = (
        await tx
          .select({ id: schema.sponsorFund.id, sponsorId: schema.sponsorFund.sponsorId })
          .from(schema.sponsorFund)
          .where(eq(schema.sponsorFund.id, body.sponsorFundId))
      )[0];
      if (fund === undefined)
        errors.push({ path: 'sponsorFundId', message: 'Unknown sponsor fund' });
      else {
        sponsorFundId = fund.id;
        if (body.investmentId === undefined) sponsorId = fund.sponsorId;
      }
    }
    if (errors.length > 0)
      throw new ProblemError(400, 'validation', 'Invalid classification', errors);
    return { investmentId, sponsorFundId, sponsorId };
  }
}
