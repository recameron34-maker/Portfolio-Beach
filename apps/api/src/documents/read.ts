import type { DocumentStore } from '@pb/adapters';
import { PdfError, readPdf } from '@pb/pdf';
import type { PdfDocument } from '@pb/pdf';
import { nodeInflate } from '@pb/pdf/node';
import type { DocumentDefinitions } from '@pb/contracts';
import { ProblemError } from '../common/problem.js';

/*
 * Reading an indexed item with @pb/pdf (decision 0012): the limits come from
 * config/definitions.json documents.* (SEC-10.3), the inflater is Node's, and a PdfError is a
 * plain 422 problem for a caller that asks for the pages (the index itself keeps the row in
 * NeedsReview and opens a data exception instead). readStoredDocument is the one read of an
 * item already indexed: the pages route, the layouts route and the extraction runner share it,
 * and storedDocumentProblem is the one answer a route gives when it fails. Nothing here logs or
 * stores the text.
 */

/** How much of the text the index keeps for search (doc.document.text_excerpt). */
export const TEXT_EXCERPT_CHARS = 2000;

/** The problem code of a document the reader refuses. */
export const UNREADABLE = 'unreadable-document';

/** Reads the bytes within the configured limits; throws the reader's PdfError as it is. */
export function readDocument(
  bytes: Uint8Array,
  settings: Pick<DocumentDefinitions, 'maxPdfBytes' | 'maxPages'>,
): Promise<PdfDocument> {
  return readPdf(bytes, {
    inflate: nodeInflate,
    limits: { maxBytes: settings.maxPdfBytes, maxPages: settings.maxPages },
  });
}

export const isPdfError = (error: unknown): error is PdfError => error instanceof PdfError;

/** The store no longer has the item an indexed row names (moved or deleted since the index); the store's own error is the cause. */
export class DocumentMissingError extends Error {
  constructor(options: { cause: unknown }) {
    super('The document is no longer in the store', options);
    this.name = 'DocumentMissingError';
  }
}

/**
 * An indexed item read from the store and parsed within the configured limits. Throws
 * DocumentMissingError when the store refuses the item and the reader's PdfError as it is; a
 * route answers through storedDocumentProblem, the runner maps each to its own outcome (a
 * transient error to retry, a failed run).
 */
export async function readStoredDocument(
  store: Pick<DocumentStore, 'read'>,
  settings: Pick<DocumentDefinitions, 'maxPdfBytes' | 'maxPages'>,
  sourceItemId: string,
): Promise<PdfDocument> {
  let bytes: Uint8Array;
  try {
    bytes = await store.read(sourceItemId);
  } catch (cause) {
    throw new DocumentMissingError({ cause });
  }
  return readDocument(bytes, settings);
}

/** A failed read as the route's problem: 404 for a vanished item, 422 for one the reader refuses; any other error is rethrown. */
export function storedDocumentProblem(error: unknown): ProblemError {
  if (error instanceof DocumentMissingError)
    return new ProblemError(404, 'not-found', error.message);
  if (isPdfError(error)) return unreadableProblem(error);
  throw error;
}

/** The reader's refusal as the caller's problem: the code and the plain message, never a byte of the file. */
export function unreadableProblem(error: PdfError): ProblemError {
  return new ProblemError(422, UNREADABLE, `unreadable document (${error.code}): ${error.message}`);
}

/** The file name without its extension, the title of a document whose Info dictionary has none. */
export function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** The document's title: the Info dictionary's, else the file name without its extension. */
export function titleOf(doc: Pick<PdfDocument, 'info'>, fileName: string): string {
  const title = doc.info.title?.trim() ?? '';
  return title === '' ? stripExtension(fileName) : title;
}

/** The first TEXT_EXCERPT_CHARS characters of the page texts joined, for search only. */
export function excerptOf(pageTexts: readonly string[]): string {
  return pageTexts.join('\n').slice(0, TEXT_EXCERPT_CHARS);
}
