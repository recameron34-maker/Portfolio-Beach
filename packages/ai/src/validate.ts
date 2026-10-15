import { D, isMoneyUnit, toDollars, unitSanityFlag } from '@pb/calc';
import { z } from 'zod';
import { isQuarterEnd } from './dates.js';
import { AiError } from './errors.js';
import type { BoundsKind, ExtractedField, ExtractionOutput, ExtractionSchema } from './schema.js';
import { UNITS_BY_KIND } from './units.js';

/*
 * Deterministic validation of a model output (SEC-8.4): every rule has an id, a severity and a
 * plain message that names the field, never a person. `invalid` findings mean the value can never
 * be promoted unedited; `flagged` findings put the field first in review. Thresholds come from
 * config (definitions.extraction, definitions.unitSanityBoundsUsd, style.highlights), never from
 * a literal here.
 */

export const EXTRACTION_RULE_IDS = [
  'EXT-REQ-01',
  'EXT-UNIT-01',
  'EXT-UNIT-02',
  'EXT-CITE-01',
  'EXT-CITE-02',
  'EXT-CITE-03',
  'EXT-CONF-01',
  'EXT-DATE-01',
  'EXT-STYLE-01',
  'EXT-TEXT-01',
] as const;
export type ExtractionRuleId = (typeof EXTRACTION_RULE_IDS)[number];

export type FindingSeverity = 'flagged' | 'invalid';
export type ValidationState = 'clean' | FindingSeverity;

export interface ExtractionRule {
  id: ExtractionRuleId;
  severity: FindingSeverity;
  /** One line a reviewer reads in the rule list. */
  title: string;
}

export const EXTRACTION_RULES: Readonly<Record<ExtractionRuleId, ExtractionRule>> = {
  'EXT-REQ-01': { id: 'EXT-REQ-01', severity: 'invalid', title: 'A required field has no value' },
  'EXT-UNIT-01': {
    id: 'EXT-UNIT-01',
    severity: 'invalid',
    title: 'The unit is not one the field kind allows',
  },
  'EXT-UNIT-02': {
    id: 'EXT-UNIT-02',
    severity: 'flagged',
    title:
      'The value converted to dollars is outside the configured range (millions read as dollars, or the reverse)',
  },
  'EXT-CITE-01': { id: 'EXT-CITE-01', severity: 'invalid', title: 'A value has no page or quote' },
  'EXT-CITE-02': {
    id: 'EXT-CITE-02',
    severity: 'invalid',
    title: 'The quote is not found on the cited page',
  },
  'EXT-CITE-03': {
    id: 'EXT-CITE-03',
    severity: 'invalid',
    title: 'The quote is longer than the limit',
  },
  'EXT-CONF-01': {
    id: 'EXT-CONF-01',
    severity: 'flagged',
    title: 'The confidence is below the review threshold',
  },
  'EXT-DATE-01': {
    id: 'EXT-DATE-01',
    severity: 'invalid',
    title: 'The period end is not a quarter end or not the expected period',
  },
  'EXT-STYLE-01': {
    id: 'EXT-STYLE-01',
    severity: 'flagged',
    title: 'The highlights break the house style (count, openings, banned phrases)',
  },
  'EXT-TEXT-01': {
    id: 'EXT-TEXT-01',
    severity: 'flagged',
    title: 'A highlight or the commentary contains an em dash',
  },
};

export interface ValidationFinding {
  ruleId: ExtractionRuleId;
  message: string;
}

export interface FieldValidation {
  validationState: ValidationState;
  findings: ValidationFinding[];
}

export interface ExtractionValidation {
  fields: Record<string, FieldValidation>;
  highlights: ValidationFinding[];
  commentary: ValidationFinding[];
  overall: ValidationState;
}

export interface DollarRange {
  minUsd: string;
  maxUsd: string;
}
/** The dollar range per bounds kind, from definitions.unitSanityBoundsUsd. */
export type UnitBounds = Readonly<Record<BoundsKind, DollarRange>>;

/** The highlights block of config/style.json the validator reads. */
export interface HighlightStyle {
  /** Bullet number (1-based, as text) to the phrase it must open with. */
  requiredOpenings: Readonly<Record<string, string>>;
  bannedPhrases: readonly string[];
}

/** The extraction thresholds of definitions.extraction the validator reads. */
export interface ExtractionSettings {
  /** A confidence below this (decimal text) is flagged for review. */
  confidenceFlagBelow: string;
  /** The longest quote stg.extracted_value stores. */
  quoteMaxChars: number;
}

export interface ValidateExtractionOptions extends ExtractionSettings {
  schema: ExtractionSchema;
  /** One text per page, page 1 first: the same texts buildInput framed. */
  pageTexts: readonly string[];
  bounds: UnitBounds;
  style: HighlightStyle;
  /** The period end the run was opened for; a date field that differs is EXT-DATE-01. */
  expectedPeriodEnd?: string;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;
const decimalDigits = z
  .union([z.number(), z.string().regex(DECIMAL)])
  .transform((value) => D(typeof value === 'number' ? String(value) : value).toFixed());
const wholeNumber = z.number().int().min(0);

const boundsDefinitions = z.object({
  unitSanityBoundsUsd: z.object({
    revenueMin: decimalDigits,
    revenueMax: decimalDigits,
    ebitdaMin: decimalDigits.optional(),
    ebitdaMax: decimalDigits.optional(),
  }),
});

const settingsDefinitions = z.object({
  extraction: z.object({
    confidenceFlagBelow: decimalDigits,
    quoteMaxChars: wholeNumber,
  }),
});

const styleFile = z.object({
  highlights: z.object({
    requiredOpenings: z.record(z.string().regex(/^[1-9]\d*$/), z.string().min(1)),
    bannedPhrases: z.array(z.string().min(1)),
  }),
});

function configError(file: string, error: z.ZodError): AiError {
  const path = error.issues[0]?.path.map(String).join('.') ?? '';
  return new AiError(
    `${file} is missing a usable ${path === '' ? 'block' : path}`,
    'invalid_config',
  );
}

/**
 * The dollar ranges from config/definitions.json: revenueMin and revenueMax apply to revenue;
 * EBITDA takes ebitdaMin and ebitdaMax when the file gives them and the revenue range otherwise.
 */
export function boundsFrom(definitions: unknown): UnitBounds {
  const parsed = boundsDefinitions.safeParse(definitions);
  if (!parsed.success) throw configError('config/definitions.json', parsed.error);
  const b = parsed.data.unitSanityBoundsUsd;
  return {
    revenue: { minUsd: b.revenueMin, maxUsd: b.revenueMax },
    ebitda: { minUsd: b.ebitdaMin ?? b.revenueMin, maxUsd: b.ebitdaMax ?? b.revenueMax },
  };
}

/** The extraction thresholds from config/definitions.json (`extraction.confidenceFlagBelow`, `extraction.quoteMaxChars`). */
export function extractionSettingsFrom(definitions: unknown): ExtractionSettings {
  const parsed = settingsDefinitions.safeParse(definitions);
  if (!parsed.success) throw configError('config/definitions.json', parsed.error);
  return {
    confidenceFlagBelow: parsed.data.extraction.confidenceFlagBelow,
    quoteMaxChars: parsed.data.extraction.quoteMaxChars,
  };
}

/** The highlights rules from config/style.json (`highlights.requiredOpenings`, `highlights.bannedPhrases`). */
export function highlightStyleFrom(style: unknown): HighlightStyle {
  const parsed = styleFile.safeParse(style);
  if (!parsed.success) throw configError('config/style.json', parsed.error);
  return {
    requiredOpenings: parsed.data.highlights.requiredOpenings,
    bannedPhrases: parsed.data.highlights.bannedPhrases,
  };
}

/** Runs of whitespace (spaces, tabs, line breaks) become one space; the ends are trimmed. Case is kept. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const EM_DASH = String.fromCharCode(0x2014);

function finding(ruleId: ExtractionRuleId, message: string): ValidationFinding {
  return { ruleId, message };
}

function stateOf(findings: readonly ValidationFinding[]): ValidationState {
  if (findings.some((f) => EXTRACTION_RULES[f.ruleId].severity === 'invalid')) return 'invalid';
  return findings.length === 0 ? 'clean' : 'flagged';
}

const ABSENT: ExtractedField = {
  value: null,
  unit: null,
  page: null,
  quote: null,
  confidence: '0',
};

/** Counted as Postgres char_length counts: code points, not UTF-16 units. */
function charLength(text: string): number {
  return Array.from(text).length;
}

function containsBanned(text: string, phrases: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const phrase of phrases) if (lower.includes(phrase.toLowerCase())) return phrase;
  return null;
}

/**
 * Validates one model output against its schema, the page texts, the configured bounds and the
 * house style. Every field of the schema gets a state; highlights and commentary get their own
 * finding lists; `overall` is invalid when any field is, flagged when any finding is, else clean.
 */
export function validateExtraction(
  output: ExtractionOutput,
  options: ValidateExtractionOptions,
): ExtractionValidation {
  const { schema, pageTexts, bounds, style, confidenceFlagBelow, quoteMaxChars } = options;
  const normalizedPages = pageTexts.map(normalizeWhitespace);
  const fields: Record<string, FieldValidation> = {};

  for (const field of schema.fields) {
    const found = Object.prototype.hasOwnProperty.call(output.fields, field.key)
      ? output.fields[field.key]
      : undefined;
    const present = found !== undefined;
    const f = found ?? ABSENT;
    const findings: ValidationFinding[] = [];
    const label = field.label;

    if (f.value === null) {
      if (field.required)
        findings.push(finding('EXT-REQ-01', `${label} is required but the document gave no value`));
    } else {
      const allowed = UNITS_BY_KIND[field.kind];
      const unitOk = f.unit !== null && allowed.includes(f.unit);
      if (!unitOk)
        findings.push(
          finding(
            'EXT-UNIT-01',
            `${label} carries unit ${f.unit ?? 'none'}; a ${field.kind} field takes ${allowed.join(', ')}`,
          ),
        );
      if (unitOk && field.kind === 'money' && field.bounds !== null && isMoneyUnit(f.unit ?? '')) {
        const range = bounds[field.bounds];
        const dollars = toDollars(f.value, f.unit ?? '');
        if (unitSanityFlag(dollars, { min: range.minUsd, max: range.maxUsd }))
          findings.push(
            finding(
              'EXT-UNIT-02',
              `${label} converts to ${dollars.toFixed()} dollars, outside the ${field.bounds} range ${range.minUsd} to ${range.maxUsd}; check whether the unit is right`,
            ),
          );
      }
      if (f.page === null || f.quote === null || f.quote.trim() === '') {
        findings.push(
          finding('EXT-CITE-01', `${label} has a value but no page or quote to support it`),
        );
      } else if (f.page > pageTexts.length) {
        findings.push(
          finding(
            'EXT-CITE-02',
            `${label} cites page ${f.page}, but the document has ${pageTexts.length} pages`,
          ),
        );
      } else {
        const page = normalizedPages[f.page - 1] ?? '';
        if (!page.includes(normalizeWhitespace(f.quote)))
          findings.push(
            finding('EXT-CITE-02', `${label}: the quote was not found on page ${f.page}`),
          );
      }
      if (D(f.confidence).lt(D(confidenceFlagBelow)))
        findings.push(
          finding(
            'EXT-CONF-01',
            `${label} has confidence ${f.confidence}, below the review threshold ${confidenceFlagBelow}`,
          ),
        );
      if (field.kind === 'date') {
        if (!isQuarterEnd(f.value))
          findings.push(finding('EXT-DATE-01', `${label} ${f.value} is not a quarter end`));
        else if (options.expectedPeriodEnd !== undefined && f.value !== options.expectedPeriodEnd)
          findings.push(
            finding(
              'EXT-DATE-01',
              `${label} is ${f.value}, but the run expected ${options.expectedPeriodEnd}`,
            ),
          );
      }
    }
    if (present && f.quote !== null && charLength(f.quote) > quoteMaxChars)
      findings.push(
        finding(
          'EXT-CITE-03',
          `${label}: the quote is ${charLength(f.quote)} characters, over the limit of ${quoteMaxChars}`,
        ),
      );
    fields[field.key] = { validationState: stateOf(findings), findings };
  }

  const highlights: ValidationFinding[] = [];
  const wanted = schema.highlights.bullets;
  if (output.highlights.length !== wanted)
    highlights.push(
      finding(
        'EXT-STYLE-01',
        `The document type asks for ${wanted} highlight bullets; ${output.highlights.length} were given`,
      ),
    );
  output.highlights.forEach((text, index) => {
    const n = index + 1;
    const opening = style.requiredOpenings[String(n)];
    if (opening !== undefined && !text.trimStart().startsWith(opening))
      highlights.push(finding('EXT-STYLE-01', `Highlight ${n} does not open with "${opening}"`));
    const banned = containsBanned(text, style.bannedPhrases);
    if (banned !== null)
      highlights.push(
        finding('EXT-STYLE-01', `Highlight ${n} contains the banned phrase "${banned}"`),
      );
    if (text.includes(EM_DASH))
      highlights.push(finding('EXT-TEXT-01', `Highlight ${n} contains an em dash`));
  });

  const commentary: ValidationFinding[] = [];
  if (output.commentary !== null) {
    const banned = containsBanned(output.commentary, style.bannedPhrases);
    if (banned !== null)
      commentary.push(
        finding('EXT-STYLE-01', `The commentary contains the banned phrase "${banned}"`),
      );
    if (output.commentary.includes(EM_DASH))
      commentary.push(finding('EXT-TEXT-01', 'The commentary contains an em dash'));
  }

  const states = Object.values(fields).map((f) => f.validationState);
  let overall: ValidationState = 'clean';
  if (states.includes('invalid')) overall = 'invalid';
  else if (states.includes('flagged') || highlights.length > 0 || commentary.length > 0)
    overall = 'flagged';
  return { fields, highlights, commentary, overall };
}
