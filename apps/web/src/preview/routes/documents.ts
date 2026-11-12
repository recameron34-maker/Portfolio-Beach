import definitions from '../../../../../config/definitions.json';
import {
  AiError,
  DOC_TYPE_CODES,
  buildInput,
  classifierOutputSchema,
  keywordClassifier,
  parseDocumentFileName,
  redact,
} from '@pb/ai';
import type { ClassifierOutput, DocumentFileName } from '@pb/ai';
import { D, addDays, daysBetween } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import {
  documentCommandBody,
  documentDefinitions,
  documentListQuery,
  expectedDocumentGenerateBody,
  expectedDocumentListQuery,
  pageQuery,
  taxonomy,
} from '@pb/contracts';
import type {
  DocumentCommandBody,
  DocumentDefinitions,
  DocumentDetail,
  DocumentDuplicate,
  DocumentIndexResult,
  DocumentPage,
  DocumentPages,
  DocumentSummary,
  ExpectedDocument,
  ExpectedDocumentGenerateResult,
  ExpectedDocumentPage,
  ExpectedDocumentStatus,
} from '@pb/contracts';
import { PdfError, readPdf } from '@pb/pdf';
import type { PdfDocument } from '@pb/pdf';
import { isNearMiss, linkInvestment, normalizeName } from '@pb/validation';
import { attempt, documentClassificationMachine } from '@pb/workflows';
import type { DocumentCommand } from '@pb/workflows';
import { documentSamplePath } from '../book.js';
import type { BookDocument, BookInvestment, BookSponsorFund, PreviewBook } from '../book.js';
import { sha256Hex } from '../hash.js';
import { browserInflate } from '../inflate.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { latestRunOf } from '../state.js';
import type { PreviewState, SimDocument, SimDocumentPage, SimExpectedDocument } from '../state.js';
import {
  EXCEPTION_SEVERITY,
  SYSTEM_ACTOR,
  canOpen,
  defineSimRoute,
  flagEnabled,
  noBook,
  openException,
  pageNewestFirst,
  recordActivity,
} from './common.js';
import type { SimContext } from './common.js';
import { hashRefusal } from './intake.js';

/**
 * The document hub (docs/04 M3, docs/18 section 6, decision 0012) simulated in the browser, the
 * way apps/api/src/documents/ serves it: the bundled synthetic document set is the store's inbox,
 * and an index reads every item with @pb/pdf (the browser inflater), hashes it with the preview's
 * SHA-256, marks the same bytes under another name a Duplicate of the earliest original, writes
 * the links its file name resolves (the investment by exact company name, the sponsor fund by
 * exact name or alias, never fuzzy) on every path so the wall of the position named holds with
 * or without a model (W1, SEC-5.3), redacts every page, builds the model input with @pb/ai and
 * runs the keyword classifier over it, links the investment again by the number the model read
 * from the book (the system actor's view, decision 0009), and moves the document through
 * documentClassificationMachine as the system actor: autoClassify at or above
 * definitions.classifierConfidenceThreshold, flagForReview below it, when the call fails, when
 * the item is unreadable or when the ai.classifier switch is off (WF-5: nothing stays in
 * Received). A reader sees the documents attached to positions their own recordings let them
 * open; the rest are absent (SEC-8.5, M3 AC).
 * The classify command runs the same table for the caller; the expected-document tracker is
 * generated from the book's investments and committed sponsor funds with the due days of config
 * and judged when read, never stored. Every change is recorded in the session's activity list.
 */

/** The store the prototype indexes (docs/04 M3: SharePoint in production). */
export const SOURCE_SYSTEM = 'local_folder';
const INBOX = 'inbox';
export const NOT_FOUND = 'Document not found';
/** The kill switch for classification during indexing (migration 0011, SEC-8.10): on by default. */
export const CLASSIFIER_SWITCH = 'ai.classifier';
/** The rule of the data exception an unreadable item opens. */
export const UNREADABLE_RULE = 'DOC-READ-01';
/** How much of the text the index keeps for search (doc.document.text_excerpt). */
const TEXT_EXCERPT_CHARS = 2000;
/** The two document types the tracker expects: a report per investment, a statement per sponsor fund. */
export const EXPECTED_DOC_TYPES = {
  quarterlyFinancials: 'doc_type.quarterly_financials',
  capitalAccountStatement: 'doc_type.capital_account_statement',
} as const;
const machine = documentClassificationMachine;

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

/* ---- Config, through the contracts' strict readers (rules 9 and 10) ---- */

/** `definitions.documents`: due days, aging and the PDF reader's limits. */
export function documentSettings(): DocumentDefinitions {
  return documentDefinitions.parse(definitions.documents);
}

/** `definitions.classifierConfidenceThreshold` as a Decimal. */
export function classifierThreshold(): Decimal {
  return D(String(definitions.classifierConfidenceThreshold));
}

/** The record's as-of day, the clock every judgment of the simulation reads (the recordings were made with it). */
export const todayOf = (book: PreviewBook): string => book.asOf;

/* ---- The expected-document rules (apps/api/src/documents/expected.ts) ---- */

export interface ExpectedTiming {
  dueDate: string;
  receivedDocumentId: string | null;
  /** The calendar day (UTC) the matched document was received; null when none is matched. */
  receivedOn: string | null;
}

/** When a quarter's document is due: the period end plus the configured days. */
export function dueDateFor(
  periodEnd: string,
  settings: Pick<DocumentDefinitions, 'expectedDueDaysAfterQuarterEnd'>,
): string {
  return addDays(periodEnd, settings.expectedDueDaysAfterQuarterEnd);
}

/** received when matched; expected until lateAfterDays past the due date, late until missingAfterDays, missing after. */
export function expectedStatusOf(
  row: ExpectedTiming,
  asOf: string,
  settings: Pick<DocumentDefinitions, 'lateAfterDays' | 'missingAfterDays'>,
): ExpectedDocumentStatus {
  if (row.receivedDocumentId !== null) return 'received';
  const overdue = daysBetween(row.dueDate, asOf);
  if (overdue <= settings.lateAfterDays) return 'expected';
  if (overdue <= settings.missingAfterDays) return 'late';
  return 'missing';
}

/** Whole days from the due date to the as-of day (negative while not yet due), or to the receipt day once received. */
export function expectedAgeDays(row: ExpectedTiming, asOf: string): number {
  const judged = row.receivedDocumentId !== null && row.receivedOn !== null ? row.receivedOn : asOf;
  return daysBetween(row.dueDate, judged);
}

export function deriveExpected(
  row: ExpectedTiming,
  asOf: string,
  settings: Pick<DocumentDefinitions, 'lateAfterDays' | 'missingAfterDays'>,
): { status: ExpectedDocumentStatus; ageDays: number } {
  return { status: expectedStatusOf(row, asOf, settings), ageDays: expectedAgeDays(row, asOf) };
}

/* ---- The book's directory: investments, sponsor funds and the links a document gets ---- */

export const investmentOf = (book: PreviewBook, id: string | null): BookInvestment | undefined =>
  id === null ? undefined : book.investments.find((i) => i.id === id);

export const fundOf = (book: PreviewBook, id: string | null): BookSponsorFund | undefined =>
  id === null ? undefined : book.sponsorFunds.find((f) => f.id === id);

/** What the classifier and the file name said about where a document belongs. */
interface LinkHints {
  investmentNumber: string | null;
  companyName: string | null;
  sponsorFundName: string | null;
}

interface DocumentLinks {
  investmentId: string | null;
  sponsorFundId: string | null;
  sponsorId: string | null;
  candidates: { reason: string }[];
}

/** The fund named, matched exactly (after normalization) on its name, canonical name or an alias; near misses by reason only. */
function linkFund(
  name: string | null,
  funds: readonly BookSponsorFund[],
): { fund: BookSponsorFund | null; candidates: { reason: string }[] } {
  const wanted = name === null ? '' : normalizeName(name);
  if (wanted === '') return { fund: null, candidates: [] };
  const exact = funds.filter(
    (f) =>
      normalizeName(f.name) === wanted ||
      normalizeName(f.canonicalName) === wanted ||
      f.aliases.some((a) => normalizeName(a) === wanted),
  );
  if (exact.length === 1) return { fund: exact[0] ?? null, candidates: [] };
  if (exact.length > 1)
    return {
      fund: null,
      candidates: exact.map(() => ({ reason: 'several sponsor funds carry the name given' })),
    };
  const near = funds.filter((f) =>
    [f.name, f.canonicalName, ...f.aliases].some((n) => isNearMiss(name ?? '', n)),
  );
  return {
    fund: null,
    candidates: near.map(() => ({
      reason: 'a sponsor fund on record nearly matches the name given',
    })),
  };
}

/**
 * Links a document from its hints as apps/api/src/documents/link.ts does: the investment by its
 * number, else by the exact company name or alias, through the one linker every intake uses
 * (never fuzzy); the position on record decides the sponsor and the fund; a fund named that
 * differs is a candidate by reason. Without an investment, the fund named sets fund and sponsor.
 */
export function linkDocument(hints: LinkHints, book: PreviewBook): DocumentLinks {
  const link = linkInvestment(
    { investmentNumber: hints.investmentNumber, companyName: hints.companyName },
    book.investments,
    book.matchGuards,
  );
  const candidates: { reason: string }[] = link.candidates.map((c) => ({
    reason: c.reason === 'match guard' ? 'a match guard blocks a name on record' : 'a near miss',
  }));
  const fund = linkFund(hints.sponsorFundName, book.sponsorFunds);
  candidates.push(...fund.candidates);
  if (link.investment !== null) {
    const position = investmentOf(book, link.investment.id);
    const sponsorFundId = position?.sponsorFundId ?? fund.fund?.id ?? null;
    if (
      fund.fund !== null &&
      position?.sponsorFundId !== undefined &&
      position.sponsorFundId !== null &&
      fund.fund.id !== position.sponsorFundId
    )
      candidates.push({ reason: 'the fund named differs from the fund of the position on record' });
    return {
      investmentId: link.investment.id,
      sponsorFundId,
      sponsorId: position?.sponsorId ?? fund.fund?.sponsorId ?? null,
      candidates,
    };
  }
  return {
    investmentId: null,
    sponsorFundId: fund.fund?.id ?? null,
    sponsorId: fund.fund?.sponsorId ?? null,
    candidates,
  };
}

/**
 * The links the file name alone resolves, before any model runs: `<period> <Fund> - <Type> -
 * <Company>.pdf` names the position exactly or not at all, so a report of a walled position is
 * attached to it on every path, the classifier off, failed or the file unreadable (W1).
 */
export function linksFromName(fromName: DocumentFileName | null, book: PreviewBook): DocumentLinks {
  return linkDocument(
    {
      investmentNumber: null,
      companyName: fromName?.companyName ?? null,
      sponsorFundName: fromName?.sponsorFundName ?? null,
    },
    book,
  );
}

/* ---- Visibility and the contract shapes ---- */

/** Whether the credential may see the document: unlinked, or linked to a position their recordings let them open (SEC-5.3). */
export function documentVisible(
  ctx: SimContext,
  credential: string,
  doc: { investmentId: string | null },
): boolean {
  return doc.investmentId === null || canOpen(ctx, credential, doc.investmentId);
}

/** The document the credential may see, or undefined (a hidden one is not found, never 403). */
export function visibleDocument(
  ctx: SimContext,
  credential: string,
  id: string,
): SimDocument | undefined {
  const doc = ctx.state.documents.get(id);
  return doc !== undefined && documentVisible(ctx, credential, doc) ? doc : undefined;
}

export function toSummary(ctx: SimContext, doc: SimDocument): DocumentSummary {
  const book = ctx.book;
  const investment = book === null ? undefined : investmentOf(book, doc.investmentId);
  const fund = book === null ? undefined : fundOf(book, doc.sponsorFundId);
  const latest = latestRunOf(ctx.state, doc.id);
  return {
    id: doc.id,
    title: doc.title,
    fileName: doc.fileName,
    folder: doc.folder,
    docType: doc.docType,
    reviewStatus: doc.reviewStatus,
    sponsorId: doc.sponsorId,
    sponsorFundId: doc.sponsorFundId,
    sponsorFundName: fund?.name ?? null,
    investmentId: doc.investmentId,
    investmentNumber: investment?.investmentNumber ?? null,
    companyName: investment?.companyName ?? null,
    periodEnd: doc.periodEnd,
    confidentiality: 'confidential',
    contentHash: doc.contentHash,
    sizeBytes: doc.sizeBytes,
    pageCount: doc.pageCount,
    receivedAt: doc.receivedAt,
    indexedAt: doc.indexedAt,
    classificationConfidence: doc.classificationConfidence,
    classifierEvidence: {
      keywords: [...doc.classifierEvidence.keywords],
      candidates: doc.classifierEvidence.candidates.map((c) => ({ reason: c.reason })),
    },
    classifiedBy: doc.classifiedBy,
    classifiedAt: doc.classifiedAt,
    duplicateOfId: doc.duplicateOfId,
    latestRun: latest === null ? null : { id: latest.id, state: latest.state },
  };
}

const newestFirst = (a: { indexedAt: string; id: string }, b: typeof a): number =>
  b.indexedAt < a.indexedAt ? -1 : b.indexedAt > a.indexedAt ? 1 : b.id < a.id ? -1 : 1;

/** The other indexed items carrying the same content, newest first, as the credential may see them. */
function duplicatesOf(ctx: SimContext, credential: string, doc: SimDocument): DocumentDuplicate[] {
  return [...ctx.state.documents.values()]
    .filter((d) => d.duplicateOfId === doc.id && documentVisible(ctx, credential, d))
    .sort(newestFirst)
    .map((d) => ({
      id: d.id,
      fileName: d.fileName,
      folder: d.folder,
      indexedAt: d.indexedAt,
      reviewStatus: d.reviewStatus,
    }));
}

export function toDetail(ctx: SimContext, credential: string, doc: SimDocument): DocumentDetail {
  return { ...toSummary(ctx, doc), duplicates: duplicatesOf(ctx, credential, doc) };
}

/* ---- The index ---- */

/** A file name with the " (n)" a mail client adds to a second delivery taken out, so the original sorts first. */
const baseName = (name: string): string => name.replace(/ \(\d+\)(\.[^.]*)?$/, '$1');

/**
 * The order the index takes the store's items in (apps/api/src/documents/documents.service.ts
 * indexOrder): by name with any " (n)" suffix removed, the plainly named item before its renamed
 * copies, then by name, compared by code unit so the order never depends on a locale.
 */
export function indexOrder<T extends { fileName: string }>(items: readonly T[]): T[] {
  const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return [...items].sort((a, b) => {
    const base = compare(baseName(a.fileName), baseName(b.fileName));
    if (base !== 0) return base;
    const plain =
      Number(a.fileName !== baseName(a.fileName)) - Number(b.fileName !== baseName(b.fileName));
    return plain !== 0 ? plain : compare(a.fileName, b.fileName);
  });
}

/** The file name without its extension, the title of a document whose Info dictionary has none. */
const stripExtension = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
};

/** The pages as the simulation keeps them: the text, the lines and the positioned runs with text. */
function pagesOf(doc: PdfDocument): SimDocumentPage[] {
  return doc.pages.map((p) => ({
    number: p.number,
    width: p.width,
    height: p.height,
    text: p.text,
    lines: p.lines.map((l) => l.text),
    runs: p.runs
      .filter((r) => r.text !== '')
      .map((r) => ({ x: r.x, y: r.y, size: r.size, text: r.text })),
  }));
}

/** The bundled bytes of an item of the store, fetched as a static asset beside the page. */
async function readItem(ctx: SimContext, item: BookDocument): Promise<Uint8Array | null> {
  const asset = await ctx.fetchAsset(documentSamplePath(item.fileName));
  if (!asset.ok) return null;
  return new Uint8Array(await asset.arrayBuffer());
}

/** The earliest non-duplicate document carrying the hash, by (indexedAt, id); a Duplicate only when no original exists. */
function originalOf(state: PreviewState, contentHash: string): SimDocument | undefined {
  let found: SimDocument | undefined;
  for (const doc of state.documents.values()) {
    if (doc.contentHash !== contentHash) continue;
    if (found === undefined) {
      found = doc;
      continue;
    }
    const rank = (d: SimDocument): number => (d.reviewStatus === 'Duplicate' ? 1 : 0);
    if (
      rank(doc) < rank(found) ||
      (rank(doc) === rank(found) &&
        (doc.indexedAt < found.indexedAt ||
          (doc.indexedAt === found.indexedAt && doc.id < found.id)))
    )
      found = doc;
  }
  return found;
}

/** Sets the received document on the empty expected row a classified document answers (same parent, period and type). */
export function matchExpectedDocument(
  state: PreviewState,
  doc: Pick<SimDocument, 'id' | 'docType' | 'periodEnd' | 'investmentId' | 'sponsorFundId'>,
): boolean {
  if (doc.docType === null || doc.periodEnd === null) return false;
  if (
    doc.docType !== EXPECTED_DOC_TYPES.quarterlyFinancials &&
    doc.docType !== EXPECTED_DOC_TYPES.capitalAccountStatement
  )
    return false;
  const byInvestment = doc.docType === EXPECTED_DOC_TYPES.quarterlyFinancials;
  const parent = byInvestment ? doc.investmentId : doc.sponsorFundId;
  if (parent === null) return false;
  for (const row of state.expectedDocuments.values()) {
    if (
      row.receivedDocumentId === null &&
      row.docType === doc.docType &&
      row.periodEnd === doc.periodEnd &&
      (byInvestment ? row.investmentId : row.sponsorFundId) === parent
    ) {
      row.receivedDocumentId = doc.id;
      return true;
    }
  }
  return false;
}

/** What the index did with one item of the store. */
type IndexOutcome =
  | { kind: 'unchanged' }
  | { kind: 'duplicate'; doc: SimDocument }
  | { kind: 'indexed'; doc: SimDocument; command: DocumentCommand | null; reason: string | null };

/** The transition the system actor takes on a new item; a table refusal is a fault of the simulation, answered as a problem. */
function transition(
  command: DocumentCommand,
  record: Record<string, unknown>,
): { ok: true; to: SimDocument['reviewStatus'] } | { ok: false; response: Response } {
  const result = attempt(machine, machine.initial, command, { ...SYSTEM_ACTOR, record });
  if (!result.ok) return { ok: false, response: workflowProblem(result, { simulated: true }) };
  return { ok: true, to: result.to };
}

/**
 * One model call over the redacted pages, then the links and the transition: autoClassify at
 * or above the threshold, flagForReview below it or when the input is refused (the document then
 * keeps the links its file name resolved). The input is the shared frame of @pb/ai (metadata,
 * then the pages as data); nothing of the text is kept beyond the search excerpt.
 */
function classify(
  book: PreviewBook,
  doc: SimDocument,
  fromName: DocumentFileName | null,
  pageTexts: readonly string[],
  threshold: Decimal,
  now: string,
): { command: DocumentCommand; reason: string | null } | Response {
  const pages = pageTexts.map((text) => redact(text).text);
  let output: ClassifierOutput | null = null;
  let failure: string | null = null;
  try {
    const input = buildInput({
      metadata: {
        file_name: doc.fileName,
        content_hash: doc.contentHash,
        page_count: doc.pageCount ?? 0,
      },
      pages,
    });
    output = classifierOutputSchema.parse(keywordClassifier(input));
  } catch (error) {
    failure =
      error instanceof AiError
        ? `classifier input refused (${error.code})`
        : 'classifier call failed';
  }
  if (output === null) {
    const flagged = transition('flagForReview', {});
    if (!flagged.ok) return flagged.response;
    doc.reviewStatus = flagged.to;
    doc.classifierEvidence = { keywords: [], candidates: [{ reason: failure ?? '' }] };
    return { command: 'flagForReview', reason: failure };
  }
  const links = linkDocument(
    {
      investmentNumber: output.investmentNumber ?? null,
      companyName: fromName?.companyName ?? null,
      sponsorFundName: output.sponsorFundName ?? fromName?.sponsorFundName ?? null,
    },
    book,
  );
  const confident = D(output.confidence).gte(threshold);
  const command: DocumentCommand = confident ? 'autoClassify' : 'flagForReview';
  const result = transition(command, { confidenceAboveThreshold: confident });
  if (!result.ok) return result.response;
  doc.reviewStatus = result.to;
  doc.docType = confident ? output.docType : null;
  doc.investmentId = links.investmentId;
  doc.sponsorFundId = links.sponsorFundId;
  doc.sponsorId = links.sponsorId;
  doc.periodEnd = output.periodEnd ?? null;
  doc.classificationConfidence = output.confidence;
  doc.classifierEvidence = {
    keywords: output.evidence,
    candidates: confident
      ? links.candidates
      : [...links.candidates, { reason: `classifier suggestion: ${output.docType}` }],
  };
  doc.classifiedAt = confident ? now : null;
  return { command, reason: confident ? null : 'confidence below the threshold' };
}

/** One item of the store, as the system actor: unchanged, a duplicate, or read and classified. */
async function indexOne(
  ctx: SimContext,
  book: PreviewBook,
  item: BookDocument,
  settings: DocumentDefinitions,
  threshold: Decimal,
  classifierOn: boolean,
  instance: string,
): Promise<IndexOutcome | Response> {
  const { state } = ctx;
  const sourceItemId = `${INBOX}/${item.fileName}`;
  for (const existing of state.documents.values())
    if (existing.sourceItemId === sourceItemId) return { kind: 'unchanged' };
  const bytes = await readItem(ctx, item);
  if (bytes === null)
    return problem(
      503,
      'unavailable',
      `The document store is missing from this preview: ${item.fileName}`,
      { instance, simulated: true },
    );
  const contentHash = await sha256Hex(bytes);
  const now = ctx.env.now();
  // The links the file name resolves are written with the document on every path below, so the
  // wall of the position named holds whether or not a model ever reads the document (SEC-5.3).
  const fromName = parseDocumentFileName(item.fileName);
  const named = linksFromName(fromName, book);
  const base: SimDocument = {
    id: ctx.env.newId(),
    sourceItemId,
    fileName: item.fileName,
    folder: item.folder,
    title: stripExtension(item.fileName),
    docType: null,
    reviewStatus: machine.initial,
    sponsorId: named.sponsorId,
    sponsorFundId: named.sponsorFundId,
    investmentId: named.investmentId,
    periodEnd: null,
    contentHash,
    sizeBytes: bytes.length,
    pageCount: null,
    // The store's receipt is the record's as-of day, the clock the recordings were made with.
    receivedAt: `${book.asOf}T12:00:00.000Z`,
    indexedAt: now,
    classificationConfidence: null,
    classifierEvidence: { keywords: [], candidates: [] },
    classifiedById: null,
    classifiedBy: null,
    classifiedAt: null,
    duplicateOfId: null,
    textExcerpt: null,
    pages: null,
    unreadableCode: null,
    rowVersion: 1,
  };

  // The same bytes indexed before: the earliest original is the document; the copy carries its
  // links (not its type, it is not classified) so the wall on the original is the wall on the copy.
  const original = originalOf(state, contentHash);
  if (original !== undefined) {
    const marked = transition('markDuplicate', { sameHashAsExisting: true });
    if (!marked.ok) return marked.response;
    const doc: SimDocument = {
      ...base,
      title: original.title,
      pageCount: original.pageCount,
      reviewStatus: marked.to,
      duplicateOfId: original.id,
      investmentId: original.investmentId,
      sponsorFundId: original.sponsorFundId,
      sponsorId: original.sponsorId,
      periodEnd: original.periodEnd,
      pages: original.pages,
    };
    state.documents.set(doc.id, doc);
    return { kind: 'duplicate', doc };
  }

  let pdf: PdfDocument;
  try {
    pdf = await readPdf(bytes, {
      inflate: browserInflate,
      limits: { maxBytes: settings.maxPdfBytes, maxPages: settings.maxPages },
    });
  } catch (error) {
    if (!(error instanceof PdfError)) throw error;
    const flagged = transition('flagForReview', {});
    if (!flagged.ok) return flagged.response;
    const reason = `unreadable (${error.code})`;
    const doc: SimDocument = {
      ...base,
      reviewStatus: flagged.to,
      classifierEvidence: { keywords: [], candidates: [{ reason }, ...named.candidates] },
      unreadableCode: error.code,
    };
    state.documents.set(doc.id, doc);
    // The exception about the item follows the item's own wall (W2).
    openException(ctx, {
      source: 'documents',
      entity: 'doc.document',
      entityId: doc.id,
      ruleId: UNREADABLE_RULE,
      expected: 'a PDF the reader accepts',
      actual: `the reader refused it (${error.code})`,
      severity: EXCEPTION_SEVERITY,
      candidates: [],
      file: null,
      rowNo: null,
      investmentId: named.investmentId,
    });
    return { kind: 'indexed', doc, command: 'flagForReview', reason };
  }

  const pages = pagesOf(pdf);
  const title = pdf.info.title?.trim() ?? '';
  const doc: SimDocument = {
    ...base,
    title: title === '' ? base.title : title,
    pageCount: pdf.pageCount,
    textExcerpt: pages
      .map((p) => p.text)
      .join('\n')
      .slice(0, TEXT_EXCERPT_CHARS),
    pages,
  };
  state.documents.set(doc.id, doc);
  if (!classifierOn) {
    // The kill switch is a graceful degradation (docs/17 section 5): the item queues for a
    // person through the same transition a failed call takes, so nothing stays in Received.
    const flagged = transition('flagForReview', {});
    if (!flagged.ok) return flagged.response;
    doc.reviewStatus = flagged.to;
    doc.classifierEvidence = { keywords: [], candidates: [...named.candidates] };
    return { kind: 'indexed', doc, command: 'flagForReview', reason: 'classifier off' };
  }
  const classified = classify(
    book,
    doc,
    fromName,
    pages.map((p) => p.text),
    threshold,
    now,
  );
  if (classified instanceof Response) return classified;
  if (doc.reviewStatus === 'Classified') matchExpectedDocument(state, doc);
  return { kind: 'indexed', doc, ...classified };
}

/**
 * POST /api/v1/documents/index (operations): every item of the inbox is indexed, linked to its
 * original or left as it is, with an activity entry per document written and one with the counts.
 * Idempotent: a second scan over the same inbox changes nothing.
 */
export const indexDocumentsRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/documents/index',
  what: 'index',
  body: null,
  handle: async (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const refusal = hashRefusal(instance);
    if (refusal !== null) return refusal;
    const settings = documentSettings();
    const threshold = classifierThreshold();
    const classifierOn = flagEnabled(ctx, req.credential, CLASSIFIER_SWITCH, true);
    const result: DocumentIndexResult = { indexed: 0, duplicates: 0, unchanged: 0 };
    for (const item of indexOrder(book.documents)) {
      const outcome = await indexOne(ctx, book, item, settings, threshold, classifierOn, instance);
      if (outcome instanceof Response) return outcome;
      if (outcome.kind === 'unchanged') {
        result.unchanged += 1;
        continue;
      }
      if (outcome.kind === 'duplicate') {
        result.duplicates += 1;
        recordActivity(ctx, req.actor, {
          action: 'document.index',
          entity: 'document',
          entityId: outcome.doc.id,
          reason: null,
          from: machine.initial,
          to: outcome.doc.reviewStatus,
        });
        continue;
      }
      result.indexed += 1;
      recordActivity(ctx, req.actor, {
        action: 'document.index',
        entity: 'document',
        entityId: outcome.doc.id,
        reason: outcome.reason,
        from: machine.initial,
        to: outcome.doc.reviewStatus,
      });
    }
    recordActivity(ctx, req.actor, {
      action: 'documents.index',
      entity: 'document',
      entityId: INBOX,
      reason: null,
      from: null,
      to: null,
      details: { ...result },
    });
    return jsonResponse(200, result, { simulated: true });
  },
});

/* ---- The lists, the detail and the pages ---- */

/** The words of a text as `plainto_tsquery('simple')` would see them: lower case, split on anything that is not a letter or a digit. */
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');

/** Every word of the query must be a word of the title, the file name or the text excerpt (the API's search_text). */
function matchesQuery(doc: SimDocument, q: string): boolean {
  const wanted = wordsOf(q);
  if (wanted.length === 0) return true;
  const words = new Set(wordsOf(`${doc.title} ${doc.fileName} ${doc.textExcerpt ?? ''}`));
  return wanted.every((w) => words.has(w));
}

function documentPageOf(
  ctx: SimContext,
  credential: string,
  docs: readonly SimDocument[],
  query: { limit: number; cursor?: string | undefined },
  instance: string,
): Response {
  const page = pageNewestFirst(
    docs.filter((d) => documentVisible(ctx, credential, d)),
    (d) => ({ at: d.indexedAt, id: d.id }),
    query,
  );
  if (page === null)
    return problem(400, 'validation', 'Invalid cursor', { instance, simulated: true });
  const body: DocumentPage = {
    items: page.items.map((d) => toSummary(ctx, d)),
    nextCursor: page.nextCursor,
  };
  return jsonResponse(200, body, { simulated: true });
}

/** GET /api/v1/documents: documents newest first with the hub's filters and the full-text query; what the caller may see. */
export const documentsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/documents',
  what: 'query',
  body: null,
  query: documentListQuery,
  handle: (req, ctx) => {
    const q = req.query;
    const docs = [...ctx.state.documents.values()].filter(
      (d) =>
        (q.q === undefined || matchesQuery(d, q.q)) &&
        (q.docType === undefined || d.docType === q.docType) &&
        (q.reviewStatus === undefined || d.reviewStatus === q.reviewStatus) &&
        (q.investmentId === undefined || d.investmentId === q.investmentId) &&
        (q.sponsorFundId === undefined || d.sponsorFundId === q.sponsorFundId) &&
        (q.periodEnd === undefined || d.periodEnd === q.periodEnd),
    );
    return documentPageOf(ctx, req.credential, docs, q, req.url.pathname);
  },
});

/** GET /api/v1/documents/review-queue: the documents the classifier was not sure about, newest first. */
export const reviewQueueRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/documents/review-queue',
  what: 'query',
  body: null,
  query: pageQuery,
  handle: (req, ctx) =>
    documentPageOf(
      ctx,
      req.credential,
      [...ctx.state.documents.values()].filter((d) => d.reviewStatus === 'NeedsReview'),
      req.query,
      req.url.pathname,
    ),
});

/** GET /api/v1/documents/{id}: the document with its duplicates and latest run; one the caller cannot see is 404. */
export const documentRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/documents/{id}',
  what: 'document',
  body: null,
  handle: (req, ctx) => {
    const doc = visibleDocument(ctx, req.credential, req.params.id ?? '');
    if (doc === undefined) return notFound(req.url.pathname);
    return jsonResponse(200, toDetail(ctx, req.credential, doc), { simulated: true });
  },
});

/** GET /api/v1/documents/{id}/pages: the text of every page as lines; an item the reader refused is a 422. */
export const documentPagesRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/documents/{id}/pages',
  what: 'pages',
  body: null,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const doc = visibleDocument(ctx, req.credential, req.params.id ?? '');
    if (doc === undefined) return notFound(instance);
    if (doc.pages === null)
      return problem(
        422,
        'unreadable-document',
        `unreadable document (${doc.unreadableCode ?? 'corrupt'}): the reader refused this item`,
        { instance, simulated: true },
      );
    const body: DocumentPages = {
      documentId: doc.id,
      pageCount: doc.pages.length,
      pages: doc.pages.map((p) => ({ number: p.number, lines: [...p.lines] })),
    };
    return jsonResponse(200, body, { simulated: true });
  },
});

/* ---- The classify command ---- */

/** The active doc_type codes: the credential's recorded taxonomy, else the codes @pb/ai knows (the same sixteen as migration 0011). */
function docTypeCodes(ctx: SimContext, credential: string): Set<string> {
  const recorded = ctx.recordings
    .read(credential, '/api/v1/taxonomy', taxonomy)
    ?.domains.find((d) => d.domain === 'doc_type');
  if (recorded === undefined) return new Set(DOC_TYPE_CODES);
  return new Set(recorded.terms.filter((t) => t.active).map((t) => t.code));
}

/** The plain label of a document type from the credential's recorded taxonomy, or the code when it has none. */
export function docTypeLabel(ctx: SimContext, credential: string, docType: string | null): string {
  if (docType === null) return 'an unclassified document';
  const term = ctx.recordings
    .read(credential, '/api/v1/taxonomy', taxonomy)
    ?.domains.flatMap((d) => d.terms)
    .find((t) => t.code === docType);
  return term?.label ?? docType;
}

/**
 * The type and the links of a classify command, each checked under the caller's own view: an
 * unknown type, or an investment they cannot open or a fund the book lacks, is a 400 naming the
 * field, so nothing reveals whether a hidden record exists beyond "not one you may name".
 */
function checkLinks(
  ctx: SimContext,
  credential: string,
  book: PreviewBook,
  body: Extract<DocumentCommandBody, { command: 'classify' }>,
  doc: SimDocument,
  instance: string,
):
  | { investmentId: string | null; sponsorFundId: string | null; sponsorId: string | null }
  | Response {
  const errors: { path: string; message: string }[] = [];
  if (!docTypeCodes(ctx, credential).has(body.docType))
    errors.push({ path: 'docType', message: 'Unknown document type' });
  let { investmentId, sponsorFundId, sponsorId } = doc;
  if (body.investmentId !== undefined) {
    const investment = investmentOf(book, body.investmentId);
    if (investment === undefined || !canOpen(ctx, credential, investment.id))
      errors.push({ path: 'investmentId', message: 'Unknown investment' });
    else {
      investmentId = investment.id;
      sponsorId = investment.sponsorId;
      sponsorFundId = investment.sponsorFundId;
    }
  }
  if (body.sponsorFundId !== undefined) {
    const fund = fundOf(book, body.sponsorFundId);
    if (fund === undefined) errors.push({ path: 'sponsorFundId', message: 'Unknown sponsor fund' });
    else {
      sponsorFundId = fund.id;
      if (body.investmentId === undefined) sponsorId = fund.sponsorId;
    }
  }
  if (errors.length > 0)
    return problem(400, 'validation', 'Invalid classification', {
      instance,
      simulated: true,
      errors,
    });
  return { investmentId, sponsorFundId, sponsorId };
}

/**
 * POST /api/v1/documents/{id}/commands (deal team, operations): NeedsReview > Classified through
 * the table with the body's type and links; a link left out keeps what the classifier found. The
 * duplicates take the same links and the expected document is matched, as the system actor.
 */
export const documentCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/documents/{id}/commands',
  what: 'command',
  body: documentCommandBody,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const doc = visibleDocument(ctx, req.credential, req.params.id ?? '');
    if (doc === undefined) return notFound(instance);
    const body = req.body;
    const links = checkLinks(ctx, req.credential, book, body, doc, instance);
    if (links instanceof Response) return links;
    const result = attempt(machine, doc.reviewStatus, body.command, {
      actorId: req.actor.userId,
      actorRoles: req.actor.roles,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      record: {},
    });
    if (!result.ok) return workflowProblem(result, { instance, simulated: true });
    const from = doc.reviewStatus;
    doc.reviewStatus = result.to;
    doc.docType = body.docType;
    doc.investmentId = links.investmentId;
    doc.sponsorFundId = links.sponsorFundId;
    doc.sponsorId = links.sponsorId;
    doc.periodEnd = body.periodEnd ?? doc.periodEnd;
    doc.classifiedById = req.actor.userId;
    doc.classifiedBy = req.actor.displayName;
    doc.classifiedAt = ctx.env.now();
    doc.rowVersion += 1;
    for (const copy of ctx.state.documents.values()) {
      if (copy.duplicateOfId !== doc.id) continue;
      copy.investmentId = doc.investmentId;
      copy.sponsorFundId = doc.sponsorFundId;
      copy.sponsorId = doc.sponsorId;
      copy.periodEnd = doc.periodEnd;
    }
    matchExpectedDocument(ctx.state, doc);
    recordActivity(ctx, req.actor, {
      action: 'document.classify',
      entity: 'document',
      entityId: doc.id,
      reason: body.reason ?? null,
      from,
      to: doc.reviewStatus,
    });
    return jsonResponse(200, toDetail(ctx, req.credential, doc), { simulated: true });
  },
});

/* ---- The expected-document tracker ---- */

/** Held on the day: entered by it and not exited by it (apps/api/src/portfolio/loaders.ts heldOn). */
export const heldOn = (inv: Pick<BookInvestment, 'entryDate' | 'exitDate'>, day: string): boolean =>
  inv.entryDate <= day && (inv.exitDate === null || inv.exitDate > day);

/** The calendar day (UTC) a document was received. */
const receivedOnOf = (doc: SimDocument | undefined): string | null =>
  doc === undefined ? null : doc.receivedAt.slice(0, 10);

/** An expected row for the caller, judged on the as-of day. */
export function toExpected(
  ctx: SimContext,
  row: SimExpectedDocument,
  asOf: string,
  settings: DocumentDefinitions,
): ExpectedDocument {
  const book = ctx.book;
  const investment = book === null ? undefined : investmentOf(book, row.investmentId);
  const fund = book === null ? undefined : fundOf(book, row.sponsorFundId);
  const received =
    row.receivedDocumentId === null ? undefined : ctx.state.documents.get(row.receivedDocumentId);
  return {
    id: row.id,
    investmentId: row.investmentId,
    investmentNumber: investment?.investmentNumber ?? null,
    companyName: investment?.companyName ?? null,
    sponsorFundId: row.sponsorFundId,
    sponsorFundName: fund?.name ?? null,
    periodEnd: row.periodEnd,
    docType: row.docType,
    dueDate: row.dueDate,
    receivedDocumentId: row.receivedDocumentId,
    ...deriveExpected(
      {
        dueDate: row.dueDate,
        receivedDocumentId: row.receivedDocumentId,
        receivedOn: receivedOnOf(received),
      },
      asOf,
      settings,
    ),
  };
}

/**
 * GET /api/v1/expected-documents: the rows the caller may see (a row of a walled position only for
 * its members), newest due date first, judged on the day asked (the record's as-of day otherwise),
 * with the status filter applied after the judgment and cursor paging.
 */
export const expectedDocumentsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/expected-documents',
  what: 'query',
  body: null,
  query: expectedDocumentListQuery,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const settings = documentSettings();
    const q = req.query;
    const asOf = q.asOf ?? todayOf(book);
    const rows = [...ctx.state.expectedDocuments.values()]
      .filter(
        (r) =>
          (r.investmentId === null || canOpen(ctx, req.credential, r.investmentId)) &&
          (q.periodEnd === undefined || r.periodEnd === q.periodEnd) &&
          (q.investmentId === undefined || r.investmentId === q.investmentId) &&
          (q.sponsorFundId === undefined || r.sponsorFundId === q.sponsorFundId),
      )
      .map((r) => toExpected(ctx, r, asOf, settings))
      .filter((r) => q.status === undefined || r.status === q.status);
    const page = pageNewestFirst(rows, (r) => ({ at: `${r.dueDate}T00:00:00.000Z`, id: r.id }), q);
    if (page === null)
      return problem(400, 'validation', 'Invalid cursor', { instance, simulated: true });
    const body: ExpectedDocumentPage = page;
    return jsonResponse(200, body, { simulated: true });
  },
});

/**
 * POST /api/v1/expected-documents/generate (operations): one quarterly_financials row per
 * investment held on the quarter end whose deal type reports quarterly figures, one
 * capital_account_statement row per sponsor fund with a commitment dated on or before it, each
 * due the configured days after the quarter end; rows the quarter already has are kept and
 * counted; documents classified earlier are matched. Recorded with the counts only.
 */
export const generateExpectedDocumentsRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/expected-documents/generate',
  what: 'generation',
  body: expectedDocumentGenerateBody,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const settings = documentSettings();
    const { periodEnd } = req.body;
    const dueDate = dueDateFor(periodEnd, settings);
    const defaults = book.expectedDocumentDefaults;
    const wanted: Pick<SimExpectedDocument, 'investmentId' | 'sponsorFundId' | 'docType'>[] = [
      ...book.investments
        .filter((i) => heldOn(i, periodEnd) && defaults.reportingDealTypes.includes(i.dealType))
        .map((i) => ({
          investmentId: i.id,
          sponsorFundId: null,
          docType: EXPECTED_DOC_TYPES.quarterlyFinancials,
        })),
      ...defaults.fundCommitments
        .filter((c) => c.commitmentDate <= periodEnd)
        .map((c) => ({
          investmentId: null,
          sponsorFundId: c.sponsorFundId,
          docType: EXPECTED_DOC_TYPES.capitalAccountStatement,
        })),
    ];
    const key = (r: Pick<SimExpectedDocument, 'investmentId' | 'sponsorFundId' | 'docType'>) =>
      `${r.investmentId ?? ''}|${r.sponsorFundId ?? ''}|${r.docType}`;
    const have = new Set(
      [...ctx.state.expectedDocuments.values()].filter((r) => r.periodEnd === periodEnd).map(key),
    );
    const missing = wanted.filter((w) => !have.has(key(w)));
    const createdAt = ctx.env.now();
    for (const m of missing) {
      const row: SimExpectedDocument = {
        id: ctx.env.newId(),
        ...m,
        periodEnd,
        dueDate,
        receivedDocumentId: null,
        createdAt,
      };
      ctx.state.expectedDocuments.set(row.id, row);
    }
    // The empty rows of the quarter take the earliest indexed Classified document of the same
    // parent, period and type.
    let matched = 0;
    const classified = [...ctx.state.documents.values()]
      .filter((d) => d.reviewStatus === 'Classified' && d.periodEnd === periodEnd)
      .sort((a, b) => -newestFirst(a, b));
    for (const doc of classified) if (matchExpectedDocument(ctx.state, doc)) matched += 1;
    const result: ExpectedDocumentGenerateResult = {
      periodEnd,
      created: missing.length,
      existing: wanted.length - missing.length,
    };
    recordActivity(ctx, req.actor, {
      action: 'expected_documents.generate',
      entity: 'expected_document',
      entityId: periodEnd,
      reason: null,
      from: null,
      to: null,
      details: { created: result.created, existing: result.existing, matched },
    });
    return jsonResponse(201, result, { simulated: true });
  },
});
