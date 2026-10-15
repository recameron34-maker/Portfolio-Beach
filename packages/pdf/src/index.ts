/**
 * @pb/pdf: a dependency-free PDF writer and reader in pure TypeScript. This entry imports no
 * runtime module, so it bundles for the browser as it is; the inflater is injected
 * (`@pb/pdf/node` provides the zlib one).
 */
export { PdfError, type PdfErrorCode } from './errors.js';
export {
  readPdf,
  READ_LIMITS,
  type ReadLimits,
  type ReadPdfOptions,
  type PdfDocument,
  type PdfInfo,
  type PdfPage,
  type PdfRun,
  type PdfLine,
} from './read.js';
export {
  writePdf,
  DEFAULT_PAGE_WIDTH,
  DEFAULT_PAGE_HEIGHT,
  MAX_TEXT_LENGTH,
  MAX_WRITE_PAGES,
  PDF_VERSION,
  type WritePdfInput,
  type PageInput,
  type PageItem,
  type TextItem,
  type LineItem,
  type RectItem,
} from './write.js';
export {
  measureText,
  standardFontFor,
  STANDARD_FONTS,
  isStandardFont,
  type StandardFont,
} from './metrics.js';
export { BASELINE_TOLERANCE } from './layout.js';
export type { Inflate } from './filters.js';
