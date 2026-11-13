import { z } from 'zod';
import {
  PLAN_METRICS,
  PLAN_METRIC_REASONS,
  PLAN_PATH_REASONS,
  PLAN_PROGRESS_REASONS,
  PLAN_STATUSES,
  UNDERWRITING_FORMS,
} from '@pb/calc';
import * as s from './schemas.js';

/*
 * Performance against the sponsor's underwritten base case (docs/04 M9, docs/08 section 11,
 * docs/18 section 13, decision 0022): the versions of a position's base case as they are read,
 * and the comparison of the position with one of them. The comparison is the answer of
 * underwritingComparison in @pb/calc, as it travels: decimal strings, and null with the reason
 * beside it where a figure is not calculable. The rules a page and the static preview need to
 * agree with the API on (which kind a version is, which one is compared) are here as functions of
 * the versions as they travel.
 */

export const UNDERWRITING_CASE_STATES = ['Draft', 'Confirmed', 'Superseded', 'Withdrawn'] as const;
export const underwritingCaseState = z.enum(UNDERWRITING_CASE_STATES);
export type UnderwritingCaseState = z.infer<typeof underwritingCaseState>;

/** equity: plan points and exit terms. credit: the underwritten yield and loss rate. */
export const underwritingForm = z.enum(UNDERWRITING_FORMS);

/**
 * What a version is among the versions of its position: the entry case, a correction of a case
 * with the same case date, or a re-underwriting at a later date.
 */
export const UNDERWRITING_CASE_KINDS = ['entry', 'correction', 'reunderwrite'] as const;
export const underwritingCaseKind = z.enum(UNDERWRITING_CASE_KINDS);
export type UnderwritingCaseKind = z.infer<typeof underwritingCaseKind>;

/** The plan of an equity case at one date: twelve-month revenue and EBITDA, net debt at the date. */
export const underwritingPoint = z
  .object({
    periodEnd: s.isoDate,
    revenueLtm: s.decimalString.nullable(),
    ebitdaLtm: s.decimalString.nullable(),
    netDebt: s.decimalString.nullable(),
  })
  .strict();
export type UnderwritingPoint = z.infer<typeof underwritingPoint>;

/**
 * Where the figures of a case come from (SEC-9.4): a document of the position, with the page or
 * the sheet and cell, or a note on where the model is held. The document is named only to a
 * reader who can open it.
 */
export const underwritingSource = z
  .object({
    document: z.object({ id: s.uuid, name: z.string() }).nullable(),
    page: z.number().int().nullable(),
    locator: z.string().nullable(),
    note: z.string().nullable(),
  })
  .strict();
export type UnderwritingSource = z.infer<typeof underwritingSource>;

/** One version of a position's base case, in full. */
export const underwritingCaseVersion = z
  .object({
    id: s.uuid,
    investmentId: s.uuid,
    version: z.number().int(),
    form: underwritingForm,
    state: underwritingCaseState,
    kind: underwritingCaseKind,
    caseDate: s.isoDate,
    /** The planned exit; for a loan, the expected repayment. */
    plannedExitDate: s.isoDate,
    /** EV / EBITDA at the planned exit: an equity case has one, a loan has none. */
    exitMultiple: s.decimalString.nullable(),
    /** Gross, from our entry to the planned exit. */
    grossMoic: s.decimalString,
    grossIrr: s.decimalString,
    /** A loan only. */
    underwrittenYield: s.decimalString.nullable(),
    annualLossRate: s.decimalString.nullable(),
    currency: z.string(),
    note: z.string().nullable(),
    /** Why this version replaces or follows the one before it; from version 2. */
    revisionReason: z.string().nullable(),
    withdrawnReason: z.string().nullable(),
    source: underwritingSource,
    /** The last person to change the figures, who therefore cannot confirm them (SEC-5.6). */
    enteredBy: s.person,
    enteredAt: z.string(),
    confirmedBy: s.person.nullable(),
    confirmedAt: z.string().nullable(),
    /** The plan points of an equity case in date order; a loan has none. */
    points: z.array(underwritingPoint),
    rowVersion: z.number().int(),
  })
  .strict();
export type UnderwritingCaseVersion = z.infer<typeof underwritingCaseVersion>;

/* ---- The comparison as it travels (UnderwritingComparison of @pb/calc) ---- */

const figure = s.decimalString.nullable();
/** Where a figure stands against plan: ahead, on plan or behind. */
export const underwritingStatus = z.enum(PLAN_STATUSES);
/** The company figures compared with plan, EBITDA first. */
export const underwritingMetric = z.enum(PLAN_METRICS);

const planMetricRow = z
  .object({
    metric: underwritingMetric,
    actual: figure,
    plan: figure,
    /** True when the plan figure is a straight line between two plan dates, not a sponsor figure. */
    interpolated: z.boolean(),
    variance: figure,
    variancePct: figure,
    status: underwritingStatus.nullable(),
    notCalculable: z.enum(PLAN_METRIC_REASONS).nullable(),
  })
  .strict();

const planSeries = z
  .object({
    metric: underwritingMetric,
    points: z.array(
      z
        .object({
          periodEnd: s.isoDate,
          /** Null on a plan date with no approved quarter: an actual is never read off a line. */
          actual: figure,
          plan: figure,
          interpolated: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const drivers = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({ ebitdaGrowth: value, multipleExpansion: value, debtPaydown: value, total: value })
    .strict();

const planProgress = z
  .object({
    planned: drivers(s.decimalString).nullable(),
    actual: drivers(s.decimalString).nullable(),
    /** actual / planned; null for a driver whose planned figure is zero or less. */
    progress: drivers(figure).nullable(),
    timePassed: figure,
    notCalculable: z.enum(PLAN_PROGRESS_REASONS).nullable(),
  })
  .strict();

const planReturns = z
  .object({
    grossIrr: figure,
    irrGap: figure,
    /** Null without a gap and while the IRR carries a flag: the flag is the reason. */
    irrStatus: underwritingStatus.nullable(),
    irrFlag: s.irrFlag,
    grossMoic: figure,
    moicOnPath: figure,
    moicGap: figure,
    pathNotCalculable: z.enum(PLAN_PATH_REASONS).nullable(),
  })
  .strict();

/** A position against one version of its base case (docs/08 section 11). */
export const underwritingComparison = z
  .object({
    /** The date of the current quarter; null without one, and for a loan. */
    quarter: s.isoDate.nullable(),
    /** One row per metric, EBITDA first; empty for a loan. */
    metrics: z.array(planMetricRow),
    /** The status of EBITDA against plan; there is no blended score. */
    headline: underwritingStatus.nullable(),
    /** One series per metric, by approved quarter and plan date; empty for a loan. */
    series: z.array(planSeries),
    valueCreation: planProgress.nullable(),
    returns: planReturns,
    /** A loan's yield to maturity as it stands, shown and never judged; null for equity. */
    yieldToMaturity: figure,
  })
  .strict();
export type UnderwritingComparison = z.infer<typeof underwritingComparison>;

/** Why a position has no comparison: no case on record, or only a Draft a second person has yet to confirm. */
export const UNDERWRITING_NOT_CALCULABLE = ['no_case', 'draft_only'] as const;
export const underwritingNotCalculable = z.enum(UNDERWRITING_NOT_CALCULABLE);

/**
 * The read of a position's base case. `form` is null for a position that holds none (a primary
 * fund), and then nothing else is answered. `comparedVersion` is the version number the
 * comparison is against: the entry case unless the reader named another.
 */
export const underwritingRead = z
  .object({
    asOf: s.isoDate,
    form: underwritingForm.nullable(),
    versions: z.array(underwritingCaseVersion),
    comparedVersion: z.number().int().nullable(),
    comparison: underwritingComparison.nullable(),
    notCalculable: underwritingNotCalculable.nullable(),
    /** The tolerances of config the statuses were judged by. */
    thresholds: z
      .object({ onPlanTolerance: s.decimalString, irrTolerance: s.decimalString })
      .strict(),
    calcVersion: z.string(),
  })
  .strict();
export type UnderwritingRead = z.infer<typeof underwritingRead>;

/** The as-of date, and the version to compare with in place of the entry case. */
export const underwritingQuery = z
  .object({
    asOf: s.isoDate.optional(),
    version: z.coerce.number().int().min(1).max(100000).optional(),
  })
  .strict();
export type UnderwritingQuery = z.infer<typeof underwritingQuery>;

/* ---- Rules over the versions as they travel, shared by the API, the page and the preview ---- */

/** What the rules below read of a version. */
export interface UnderwritingVersionRef {
  version: number;
  state: UnderwritingCaseState;
  caseDate: string;
}

/** A version that stands or stood as the plan: Confirmed, or Superseded by its correction. */
const stood = (v: UnderwritingVersionRef): boolean =>
  v.state === 'Confirmed' || v.state === 'Superseded';

/**
 * The kind of a version among the versions of its position, from those recorded before it that
 * stand or stood as the plan (a withdrawn case never counts): a correction when one of them has
 * its case date, a re-underwriting when one of them is dated earlier, otherwise the entry case.
 */
export function underwritingKindOf(
  version: UnderwritingVersionRef,
  all: readonly UnderwritingVersionRef[],
): UnderwritingCaseKind {
  const earlier = all.filter((v) => v.version < version.version && stood(v));
  if (earlier.some((v) => v.caseDate === version.caseDate)) return 'correction';
  return earlier.some((v) => v.caseDate < version.caseDate) ? 'reunderwrite' : 'entry';
}

/**
 * The case a position is compared with unless the reader picks another: the Confirmed version
 * with the earliest case date, so a re-underwriting never hides the gap to what was first
 * underwritten. Null when no version is Confirmed.
 */
export function entryCaseOf<T extends UnderwritingVersionRef>(versions: readonly T[]): T | null {
  let entry: T | null = null;
  for (const v of versions) {
    if (v.state !== 'Confirmed') continue;
    if (entry === null || v.caseDate < entry.caseDate) entry = v;
  }
  return entry;
}

/** A version a reader may pick for the comparison: one that stands or stood as the plan. */
export const isComparableVersion = (v: UnderwritingVersionRef): boolean => stood(v);
