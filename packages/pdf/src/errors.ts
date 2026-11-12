/**
 * The one error the package throws. Every message is plain language a reviewer can read on the
 * documents page; the code lets the caller map it (a refused upload, a damaged file, a limit).
 */
export type PdfErrorCode =
  /** The bytes do not start with a PDF header, so this is not a PDF file. */
  | 'not_pdf'
  /** The document is encrypted (its trailer names an /Encrypt dictionary). */
  | 'encrypted'
  /** A filter, a font or a construct the reader does not handle (LZW, JBIG2, a Crypt filter). */
  | 'unsupported'
  /** The file is damaged: an object, a stream, a cross-reference entry or a page is not what it claims. */
  | 'corrupt'
  /** A limit guarding the parser (bytes, objects, pages, stream size, operators, nesting) was passed. */
  | 'too_large'
  /** The writer or the measurer was given something it cannot handle (a character outside WinAnsi, a bad number). */
  | 'invalid_input';

export class PdfError extends Error {
  constructor(
    message: string,
    public readonly code: PdfErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PdfError';
  }
}
