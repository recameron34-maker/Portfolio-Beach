import { D } from '@pb/calc';
import { z } from 'zod';
import type { AccountingRuleConfig } from './rules/accounting.js';

/**
 * The intake settings of config/definitions.json (CLAUDE.md rules 9 and 10): every threshold the
 * accounting rules read, the row and byte limits of one import and the period-end tolerance. The
 * API and the preview map the same file through this one reader, so a threshold can never differ
 * between the two. A missing or malformed key is an IntakeSettingsError naming the key, never a
 * default in code.
 */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A whole number of zero or more, such as a row limit or a number of quarters. */
const wholeNumber = z.number().int().min(0);

/** A rate or threshold as plain decimal digits (never exponent form), from a JSON number or a decimal string. */
const decimalDigits = z
  .union([z.number(), z.string().regex(DECIMAL)])
  .transform((value) => D(typeof value === 'number' ? String(value) : value).toFixed());

/** Only the keys the intake reads; the rest of the file is ignored here. */
export const intakeDefinitions = z.object({
  intake: z.object({
    maxRowsPerFile: wholeNumber,
    maxFileBytes: wholeNumber,
    fairValueTieToleranceUsd: decimalDigits,
    quarterOverQuarterMaxChangePct: decimalDigits,
    yearOverYearMaxChangePct: decimalDigits,
    staleQuarters: wholeNumber,
    evToEbitdaMax: decimalDigits,
  }),
  priorYearPeriodEndToleranceDays: wholeNumber,
  unitSanityBoundsUsd: z.object({ revenueMin: decimalDigits, revenueMax: decimalDigits }),
});

export interface IntakeSettings {
  /** Data lines one import takes (definitions.intake.maxRowsPerFile). */
  maxRows: number;
  /** Bytes of file text one import accepts (definitions.intake.maxFileBytes). */
  maxFileBytes: number;
  /** How far a period end may sit from its quarter end (definitions.priorYearPeriodEndToleranceDays). */
  toleranceDays: number;
  rules: AccountingRuleConfig;
}

/** A definitions key the intake needs is missing or unusable; `key` names it, dotted. */
export class IntakeSettingsError extends Error {
  constructor(public readonly key: string) {
    super(`config/definitions.json is missing a usable ${key}`);
    this.name = 'IntakeSettingsError';
  }
}

/** The intake settings from the parsed definitions file, or an IntakeSettingsError naming the first bad key. */
export function intakeSettingsFrom(definitions: unknown): IntakeSettings {
  const parsed = intakeDefinitions.safeParse(definitions);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String) ?? [];
    throw new IntakeSettingsError(path.length === 0 ? 'intake' : path.join('.'));
  }
  const { intake, priorYearPeriodEndToleranceDays, unitSanityBoundsUsd } = parsed.data;
  return {
    maxRows: intake.maxRowsPerFile,
    maxFileBytes: intake.maxFileBytes,
    toleranceDays: priorYearPeriodEndToleranceDays,
    rules: {
      revenueMinUsd: unitSanityBoundsUsd.revenueMin,
      revenueMaxUsd: unitSanityBoundsUsd.revenueMax,
      fairValueTieToleranceUsd: intake.fairValueTieToleranceUsd,
      quarterOverQuarterMaxChangePct: intake.quarterOverQuarterMaxChangePct,
      yearOverYearMaxChangePct: intake.yearOverYearMaxChangePct,
      staleQuarters: intake.staleQuarters,
      evToEbitdaMax: intake.evToEbitdaMax,
      periodEndToleranceDays: priorYearPeriodEndToleranceDays,
    },
  };
}
