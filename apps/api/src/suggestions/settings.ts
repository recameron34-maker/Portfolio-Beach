import type { ExtractionSchema, ExtractionSchemas, TargetColumn } from '@pb/ai';
import { promotesToRecord } from '@pb/ai';
import { EXPECTED_DOC_TYPES } from '@pb/validation';
import { SuggestionConfigError, suggestionSettings } from '@pb/workflows';
import type { SuggestionSettings } from '@pb/workflows';
import { configError } from '../common/definitions.js';
import { ProblemError } from '../common/problem.js';

/*
 * What the valuation suggestions read of the configuration (docs/04 M10, docs/18 section 14,
 * decision 0023; rule 9): the settings block of config/definitions.json through the one reader
 * the static preview uses too (suggestionSettings of @pb/workflows), and which extraction schemas
 * are a capital account statement and a sponsor report. Nothing here has a default in code: a
 * missing or unusable key is a 500 'configuration' problem naming the key, and the composition
 * calls the same reader at startup so the API refuses to start without it.
 */

/** The switch (ops.feature_flag, migration 0023): off, nothing is derived and nothing is accepted; reads and dismiss still work. */
export const SUGGESTIONS_SWITCH = 'valuation.suggestions';

/** `valuationSuggestions`, the two tolerances and the variance flag, or the 500 that names the key. */
export function suggestionSettingsOf(definitions: unknown): SuggestionSettings {
  try {
    return suggestionSettings(definitions);
  } catch (error) {
    if (error instanceof SuggestionConfigError) throw configError(error.key);
    throw error;
  }
}

/**
 * The lines of a capital account statement the suggestion rules read (docs/08 rule 12.1), by
 * the key config/extraction_schema.json gives each. The keys are the schema's own: a statement
 * schema that lacks one is refused when the schemas are read (statementSchemasOf).
 */
export const STATEMENT_LINE_KEYS = {
  beginningBalance: 'beginning_capital_balance',
  contributionsInPeriod: 'contributions_in_period',
  distributionsInPeriod: 'distributions_in_period',
  netGainLoss: 'net_gain_loss',
  endingBalance: 'ending_capital_balance',
  contributionsToDate: 'contributions_to_date',
} as const;
/** Our share of the vehicle, when the statement's lines are for the whole vehicle: a fraction of one. */
export const STATEMENT_SHARE_KEY = 'investor_share_pct';
/** The period a run's figures are for: every schema states it under this key. */
export const PERIOD_END_KEY = 'period_end';

/** The schemas of a kind, by id. */
export interface SuggestionSchemas {
  /** A capital account statement: no record figure, the document type of a statement. */
  statements: ReadonlyMap<string, ExtractionSchema>;
  /** A sponsor report: it writes to the quarterly record. */
  reports: ReadonlyMap<string, ExtractionSchema>;
}

const configuration = (detail: string): ProblemError =>
  new ProblemError(500, 'configuration', `config/extraction_schema.json ${detail}`);

/**
 * The extraction schemas the suggestions read. A statement schema is one of the capital account
 * statement document type that writes nothing to the quarterly record; it must carry the lines
 * of rule 12.1 as money fields and the share as a percent, or it is refused by name. A report
 * schema is one that writes to the quarterly record.
 */
export function suggestionSchemasOf(schemas: ExtractionSchemas): SuggestionSchemas {
  const statements = new Map<string, ExtractionSchema>();
  const reports = new Map<string, ExtractionSchema>();
  for (const schema of Object.values(schemas)) {
    if (promotesToRecord(schema)) {
      reports.set(schema.id, schema);
      continue;
    }
    if (schema.docType !== EXPECTED_DOC_TYPES.capitalAccountStatement) continue;
    const kindOf = new Map(schema.fields.map((field) => [field.key, field.kind]));
    for (const key of Object.values(STATEMENT_LINE_KEYS))
      if (kindOf.get(key) !== 'money')
        throw configuration(`has no money field ${key} in the schema ${schema.id}`);
    if (kindOf.get(STATEMENT_SHARE_KEY) !== 'percent')
      throw configuration(`has no percent field ${STATEMENT_SHARE_KEY} in the schema ${schema.id}`);
    statements.set(schema.id, schema);
  }
  return { statements, reports };
}

/** The key of the field a report schema promotes to a column of the quarterly record, or null when it has none. */
export function fieldKeyOf(schema: ExtractionSchema, target: TargetColumn): string | null {
  return schema.fields.find((field) => field.target === target)?.key ?? null;
}
