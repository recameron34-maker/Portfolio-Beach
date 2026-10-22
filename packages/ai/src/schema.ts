import { z } from 'zod';
import { ISO_DATE, isCalendarDate } from './dates.js';
import { AiError } from './errors.js';
import { PROMPT_IDS } from './registry.js';
import type { PromptId } from './registry.js';
import { DOC_TYPE_CODES } from './taxonomy.js';
import type { DocTypeCode } from './taxonomy.js';
import { FIELD_KINDS, UNITS } from './units.js';
import type { FieldKind, Unit } from './units.js';

/*
 * The extraction schemas of config/extraction_schema.json and the zod output schemas built from
 * them (SEC-8.4: strict JSON, declared units, a citation slot on every value). Numbers are decimal
 * text validated by a pattern and never parsed to a float here or anywhere downstream.
 */

/** The mon.quarterly_performance columns an extracted figure may promote to. */
export const TARGET_COLUMNS = [
  'revenue_ltm',
  'ebitda_ltm',
  'ev',
  'net_debt',
  'cash',
  'total_equity',
] as const;
export type TargetColumn = (typeof TARGET_COLUMNS)[number];

/** The unitSanityBoundsUsd ranges a converted dollar value is checked against. */
export const BOUNDS_KINDS = ['revenue', 'ebitda'] as const;
export type BoundsKind = (typeof BOUNDS_KINDS)[number];

export interface ExtractionField {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  target: TargetColumn | null;
  bounds: BoundsKind | null;
}

export interface ExtractionSchema {
  /** The key in config/extraction_schema.json (doc.extraction_run.schema_id). */
  id: string;
  label: string;
  docType: DocTypeCode;
  promptId: PromptId;
  fields: readonly ExtractionField[];
  highlights: { bullets: number };
  commentary: boolean;
}

export type ExtractionSchemas = Readonly<Record<string, ExtractionSchema>>;

const SNAKE_KEY = /^[a-z][a-z0-9_]*$/;

const fieldConfig = z.strictObject({
  key: z.string().regex(SNAKE_KEY),
  label: z.string().min(1),
  kind: z.enum(FIELD_KINDS),
  required: z.boolean(),
  target: z.enum(TARGET_COLUMNS).nullable(),
  bounds: z.enum(BOUNDS_KINDS).nullable(),
});

const schemaConfig = z.strictObject({
  label: z.string().min(1),
  docType: z.enum(DOC_TYPE_CODES),
  promptId: z.enum(PROMPT_IDS),
  fields: z.array(fieldConfig).min(1),
  highlights: z.strictObject({ bullets: z.number().int().min(0) }),
  commentary: z.boolean(),
});

const fileConfig = z.object({
  _note: z.string().optional(),
  schemas: z.record(z.string().regex(SNAKE_KEY), schemaConfig),
});

/**
 * Reads config/extraction_schema.json (already parsed from JSON). Every problem is an AiError
 * 'invalid_config' naming the path: an unknown kind, target or bounds, a key or target listed
 * twice in one schema, bounds or a target on a field that is not money.
 */
export function loadExtractionSchemas(config: unknown): ExtractionSchemas {
  const parsed = fileConfig.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join('.') ?? 'schemas';
    throw new AiError(
      `config/extraction_schema.json is not usable at ${path === '' ? 'the root' : path}: ${issue?.message ?? 'unknown problem'}`,
      'invalid_config',
    );
  }
  const out: Record<string, ExtractionSchema> = {};
  for (const [id, schema] of Object.entries(parsed.data.schemas)) {
    const keys = new Set<string>();
    const targets = new Set<string>();
    schema.fields.forEach((field, index) => {
      const at = `schemas.${id}.fields.${index}`;
      if (keys.has(field.key))
        throw new AiError(`${at}: key ${field.key} is listed twice`, 'invalid_config');
      keys.add(field.key);
      if (field.target !== null) {
        if (field.kind !== 'money')
          throw new AiError(`${at}: only a money field can have a target column`, 'invalid_config');
        if (targets.has(field.target))
          throw new AiError(`${at}: target ${field.target} is listed twice`, 'invalid_config');
        targets.add(field.target);
      }
      if (field.bounds !== null && field.kind !== 'money')
        throw new AiError(`${at}: only a money field can have bounds`, 'invalid_config');
    });
    out[id] = { id, ...schema };
  }
  return out;
}

/** A decimal amount, rate or fraction as text, never a float (the contracts pattern). */
export const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;
/** A whole number of zero or more as text. */
export const COUNT_TEXT = /^\d+$/;
/** A confidence from 0 to 1 as decimal text: 0, 0.85, 1, 1.0. */
export const CONFIDENCE_TEXT = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

export const decimalText = z.string().regex(DECIMAL_TEXT);
export const countText = z.string().regex(COUNT_TEXT);
export const confidenceText = z.string().regex(CONFIDENCE_TEXT);
export const isoDateText = z
  .string()
  .regex(ISO_DATE)
  .refine((value) => isCalendarDate(value), 'not a real calendar date');

function valueSchemaFor(kind: FieldKind): z.ZodType<string> {
  switch (kind) {
    case 'date':
      return isoDateText;
    case 'count':
      return countText;
    case 'money':
    case 'percent':
      return decimalText;
  }
}

/** One extracted value as the model answers it and stg.extracted_value stores it. */
export interface ExtractedField {
  /** Decimal text, ISO date or null when the document does not state the field. */
  value: string | null;
  unit: Unit | null;
  page: number | null;
  quote: string | null;
  /** 0 to 1 as decimal text. */
  confidence: string;
}

export interface ExtractionOutput {
  fields: Record<string, ExtractedField>;
  highlights: string[];
  commentary: string | null;
}

/** The largest page number a PostgreSQL `integer` column (stg.extracted_value.page) can hold. */
export const PAGE_STORAGE_MAX = 2_147_483_647;

export interface OutputSchemaOptions {
  /**
   * The highest page number an answer may cite: the caller's `documents.maxPages`, the most
   * pages the reader ever returns. Without it the storage limit applies, so an answer that no
   * column could hold is still a schema failure and not a failed write after the run started.
   */
  maxPage?: number;
}

/**
 * The strict output schema of an extraction call for one config schema: exactly the schema's
 * field keys, each with value (typed by the field's kind), unit (one of the known units or
 * null), page (1 to `maxPage`), quote and confidence. Length, citation and range rules are the
 * validator's, so that a wrong-but-parseable answer becomes a finding a person reviews rather
 * than a schema failure that is retried; a page beyond any document is not an answer at all.
 */
export function outputSchemaFor(
  schema: ExtractionSchema,
  options: OutputSchemaOptions = {},
): z.ZodType<ExtractionOutput> {
  const maxPage = options.maxPage ?? PAGE_STORAGE_MAX;
  if (!Number.isInteger(maxPage) || maxPage < 1 || maxPage > PAGE_STORAGE_MAX)
    throw new AiError(
      `outputSchemaFor: maxPage must be a whole number from 1 to ${PAGE_STORAGE_MAX}`,
      'invalid_config',
    );
  const shape: Record<string, z.ZodType<ExtractedField>> = {};
  for (const field of schema.fields) {
    shape[field.key] = z.strictObject({
      value: valueSchemaFor(field.kind).nullable(),
      unit: z.enum(UNITS).nullable(),
      page: z.number().int().min(1).max(maxPage).nullable(),
      quote: z.string().nullable(),
      confidence: confidenceText,
    });
  }
  return z.strictObject({
    fields: z.strictObject(shape),
    highlights: z.array(z.string()),
    commentary: z.string().nullable(),
  });
}

/** The strict output schema of the document classifier. */
export const classifierOutputSchema = z.strictObject({
  docType: z.enum(DOC_TYPE_CODES),
  confidence: confidenceText,
  /** The words or phrases that decided the type; the index stores them as classifier evidence. */
  evidence: z.array(z.string()),
  periodEnd: isoDateText.optional(),
  investmentNumber: z
    .string()
    .regex(/^INV-\d{4}$/)
    .optional(),
  sponsorFundName: z.string().min(1).optional(),
});
export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;
