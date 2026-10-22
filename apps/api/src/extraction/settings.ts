import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiError, highlightStyleFrom } from '@pb/ai';
import type { ExtractionSchema, ExtractionSchemas, HighlightStyle } from '@pb/ai';
import { D } from '@pb/calc';
import type { ExtractionDefinitions } from '@pb/contracts';

/*
 * The names and config the extraction engine runs on (docs/04 M4, docs/18 section 7, decision
 * 0012): the kill switch, the job type of a batch, the data exception rule of a failed run, the
 * two staged rows that are not schema fields (the highlights and the commentary, promoted only
 * when accepted), the house style the validator reads from config/style.json, and the cost
 * formula over config/definitions.json extraction.costPerThousandTokensUsd (decimal text, never a
 * float; SEC-8.9). The extraction block itself is read through documents/settings.ts
 * extractionSettingsOf, the one reader of it.
 */

/** The kill switch for batch creation and run processing (migration 0003, SEC-8.10). */
export const EXTRACTION_SWITCH = 'ai.extraction';
/** The ops.job type of a batch. */
export const BATCH_JOB_TYPE = 'extraction_batch';
/** The data exception a failed run opens (source 'extraction', entity 'doc.extraction_run'). */
export const RUN_EXCEPTION_RULE = 'EXT-RUN-01';
export const EXCEPTION_SOURCE = 'extraction';
/** The staged row holding the drafted highlights (a JSON array of strings as text). */
export const HIGHLIGHTS_FIELD = 'highlights';
/** The staged row holding the drafted commentary (text, or null when the model gave none). */
export const COMMENTARY_FIELD = 'commentary';
/** The rows of a run that are not schema fields: decided like a value, promoted only when accepted. */
export const NARRATIVE_FIELDS: readonly string[] = [HIGHLIGHTS_FIELD, COMMENTARY_FIELD];

/** Injection token for the highlights block of config/style.json as highlightStyleFrom reads it. */
export const HIGHLIGHT_STYLE = 'PB_HIGHLIGHT_STYLE';

/** config/style.json through @pb/ai's reader: a missing or unusable file stops the process. */
export function loadHighlightStyle(configDir: string): HighlightStyle {
  const fileName = 'style.json';
  const path = join(configDir, fileName);
  if (!existsSync(path)) throw new Error(`config file is missing: ${fileName}`);
  try {
    return highlightStyleFrom(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof AiError)
      throw new Error(`config file is not valid (${fileName}): ${error.message}`, { cause: error });
    throw error;
  }
}

/** The schema whose docType is the one given, or null when no schema extracts that type. */
export function schemaForDocType(
  schemas: ExtractionSchemas,
  docType: string,
): ExtractionSchema | null {
  return Object.values(schemas).find((s) => s.docType === docType) ?? null;
}

/** The keys of a schema's money fields: an edit of one of them needs a money unit (contract). */
export function moneyFieldKeys(schema: ExtractionSchema): string[] {
  return schema.fields.filter((f) => f.kind === 'money').map((f) => f.key);
}

/** The cost of a call: tokens per thousand times the configured rate, in and out, rounded to four places. */
export function costOf(
  tokensIn: number,
  tokensOut: number,
  settings: Pick<ExtractionDefinitions, 'costPerThousandTokensUsd'>,
): string {
  const rate = settings.costPerThousandTokensUsd;
  return D(String(tokensIn))
    .div(1000)
    .times(D(rate.in))
    .plus(D(String(tokensOut)).div(1000).times(D(rate.out)))
    .toFixed(4);
}
