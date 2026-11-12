/**
 * The one error the package throws. Every message is plain language a reviewer can read on the
 * intake page; the code lets the caller map it (a refused upload, a configuration problem).
 */
export type WorkbookErrorCode =
  /** The bytes are not a zip archive, so not an .xlsx file. */
  | 'not_zip'
  /** An encrypted workbook (an OLE container) or an encrypted zip entry. */
  | 'encrypted'
  /** A zip feature or a workbook construct the reader does not handle. */
  | 'unsupported'
  /** The archive or a part inside it is damaged. */
  | 'corrupt'
  /** A part the workbook needs is not in the archive. */
  | 'missing_part'
  /** A part is not well-formed XML, or a cell is not what the reader expects. */
  | 'malformed'
  /** A limit guarding the parser (cells, nesting, part size) was passed. */
  | 'too_large'
  /** The writer was given something it cannot write (a bad sheet name, a bad cell). */
  | 'invalid_input';

export class WorkbookError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbookErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkbookError';
  }
}
