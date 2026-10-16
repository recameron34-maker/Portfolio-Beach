import type { Decimal } from '@pb/calc';
import { documentDefinitions, extractionDefinitions } from '@pb/contracts';
import type { DocumentDefinitions, ExtractionDefinitions } from '@pb/contracts';
import { configDecimal, configError } from '../common/definitions.js';

/*
 * The config blocks the document hub and the extraction engine read from config/definitions.json
 * (rule 9: config over code), through the contracts' strict readers. A missing or malformed block
 * is a 500 'configuration' problem naming the block, never a default in code (rule 10); the
 * composition calls the same readers at startup so a bad block stops the process before it
 * serves a request. The extraction agent and the monitoring agent read their settings through
 * these too, so every threshold is read in one way.
 */

/** Injection token for config/extraction_schema.json as loadExtractionSchemas parsed it (ExtractionSchemas from @pb/ai). */
export const EXTRACTION_SCHEMAS = 'PB_EXTRACTION_SCHEMAS';

/** `definitions.documents`: due days, aging, the search page size and the PDF reader's limits. */
export function documentSettingsOf(definitions: unknown): DocumentDefinitions {
  const block = (definitions as { documents?: unknown } | null | undefined)?.documents;
  const parsed = documentDefinitions.safeParse(block);
  if (!parsed.success) throw configError('documents');
  return parsed.data;
}

/** `definitions.extraction`: concurrency, token budgets, the quote length, the flag threshold, the retry budget and the cost table. */
export function extractionSettingsOf(definitions: unknown): ExtractionDefinitions {
  const block = (definitions as { extraction?: unknown } | null | undefined)?.extraction;
  const parsed = extractionDefinitions.safeParse(block);
  if (!parsed.success) throw configError('extraction');
  return parsed.data;
}

/** `definitions.classifierConfidenceThreshold`: a classification at or above it is automatic, below it goes to review (docs/04 M3). */
export function classifierThresholdOf(definitions: unknown): Decimal {
  const value = (definitions as { classifierConfidenceThreshold?: unknown } | null | undefined)
    ?.classifierConfidenceThreshold;
  return configDecimal(value, 'classifierConfidenceThreshold');
}
