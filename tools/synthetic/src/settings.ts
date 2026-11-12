import { D } from '@pb/calc';
import definitions from '../../../config/definitions.json' with { type: 'json' };

/**
 * The intake thresholds the sample drops are built against, read from config/definitions.json
 * the way the accounting export reads its tolerance (CLAUDE.md rule 9): a key that is present
 * must be usable or the build stops naming it; a key the file does not carry yet takes the value
 * docs/04 M2 names, so the generator and the intake that reads the same file agree on it.
 */
export const INTAKE_DEFAULTS = {
  /** The move against the prior value that flags a weekly value (a decimal: 0.1 is 10%). */
  weeklyVarianceThresholdPct: '0.1',
  /** How many days before the as-of date a weekly report date may sit before it is stale. */
  weeklyStaleDays: 10,
  /** The NAV difference a look-through reconcile lets pass (a decimal of the record's NAV). */
  lookthroughNavTolerancePct: '0.02',
  /** The cost difference, in dollars, a look-through reconcile lets pass. */
  lookthroughCostToleranceUsd: '1',
} as const;

export type IntakeDecimalKey =
  'weeklyVarianceThresholdPct' | 'lookthroughNavTolerancePct' | 'lookthroughCostToleranceUsd';
export type IntakeWholeNumberKey = 'weeklyStaleDays';

function intakeValue(key: string, source: unknown): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  const intake: unknown = (source as Record<string, unknown>).intake;
  if (typeof intake !== 'object' || intake === null) return undefined;
  return (intake as Record<string, unknown>)[key];
}

/**
 * A positive decimal threshold under `intake` as plain decimal digits (never exponent form), or
 * its default when the file does not carry the key.
 */
export function intakeDecimal(key: IntakeDecimalKey, source: unknown = definitions): string {
  const value = intakeValue(key, source);
  if (value === undefined) return INTAKE_DEFAULTS[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`config/definitions.json: intake.${key} must be a number above zero`);
  return D(String(value)).toFixed();
}

/** A whole number of days under `intake`, or its default when the file does not carry the key. */
export function intakeWholeNumber(
  key: IntakeWholeNumberKey,
  source: unknown = definitions,
): number {
  const value = intakeValue(key, source);
  if (value === undefined) return INTAKE_DEFAULTS[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new Error(`config/definitions.json: intake.${key} must be a whole number of days`);
  return value;
}

/**
 * The pipeline stage aging (docs/04 M5, config pipeline.stageAgingDays): the days a deal may sit
 * in a stage before the board flags it, which the synthetic stage history is spaced by.
 */
export const PIPELINE_DEFAULTS = {
  stageAgingDays: {
    Sourced: 30,
    Screening: 30,
    Prescreen: 45,
    Diligence: 90,
    IC: 14,
    Approved: 30,
    Closing: 45,
  },
} as const;
export type PipelineStageKey = keyof typeof PIPELINE_DEFAULTS.stageAgingDays;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The whole days per stage under `pipeline.stageAgingDays`, or the defaults when the file does
 * not carry the key; a key that is present must name every stage with a whole number above zero.
 */
export function pipelineStageAgingDays(
  source: unknown = definitions,
): Record<PipelineStageKey, number> {
  const pipeline = isRecord(source) ? source.pipeline : undefined;
  const aging = isRecord(pipeline) ? pipeline.stageAgingDays : undefined;
  if (aging === undefined) return { ...PIPELINE_DEFAULTS.stageAgingDays };
  const days = (stage: PipelineStageKey): number => {
    const value = isRecord(aging) ? aging[stage] : undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
      throw new Error(
        `config/definitions.json: pipeline.stageAgingDays.${stage} must be a whole number of days above zero`,
      );
    return value;
  };
  return {
    Sourced: days('Sourced'),
    Screening: days('Screening'),
    Prescreen: days('Prescreen'),
    Diligence: days('Diligence'),
    IC: days('IC'),
    Approved: days('Approved'),
    Closing: days('Closing'),
  };
}
