import { PdfError, readPdf } from '@pb/pdf';
import type { PdfDocument } from '@pb/pdf';
import { nodeInflate } from '@pb/pdf/node';
import type { DocumentDefinitions } from '@pb/contracts';
import { ProblemError } from '../common/problem.js';

/*
 * Reading an indexed item with @pb/pdf (decision 0012): the limits come from
 * config/definitions.json documents.* (SEC-10.3), the inflater is Node's, and a PdfError is a
 * plain 422 problem for a caller that asks for the pages (the index itself keeps the row in
 * NeedsReview and opens a data exception instead). Nothing here logs or stores the text.
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
