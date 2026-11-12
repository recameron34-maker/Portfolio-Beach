import type { Truth } from '../models/extractor.js';
import type { DocTypeCode } from '../taxonomy.js';

/**
 * One gold case of the eval set (docs/07 section 7, SEC-8.8): a synthetic document's text per
 * page and its truth sidecar. The synthetic generator writes them; tests build tiny ones inline.
 */
export interface GoldCase {
  contentHash: string;
  fileName: string;
  /** The labeled document type. */
  docType: DocTypeCode;
  pageTexts: readonly string[];
  truth: Truth;
  /** Linked investment number and company name when the document has them (the extraction metadata). */
  investmentNumber?: string | null;
  companyName?: string | null;
}
