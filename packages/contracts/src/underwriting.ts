import { z } from 'zod';
import {
  D,
  PLAN_METRICS,
  PLAN_METRIC_REASONS,
  PLAN_PATH_REASONS,
  PLAN_PROGRESS_REASONS,
  PLAN_STATUSES,
  UNDERWRITING_FORMS,
} from '@pb/calc';
import type { DecimalInput } from '@pb/calc';
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

/* ---- Recording a case (docs/18 section 13) ---- */

/** The most plan points a case may hold: a point a quarter for thirty years. */
export const UNDERWRITING_MAX_POINTS = 120;

/** Money as numeric(20,2) stores it, of either sign: a plan may hold a loss, or net cash. */
const PLAN_MONEY = /^-?\d{1,18}(\.\d{1,2})?$/;
/** A multiple as numeric(12,6) stores it. */
const MULTIPLE = /^\d{1,6}(\.\d{1,6})?$/;
/** A rate as numeric(12,8) stores it, a decimal: 0.2 is 20%. */
const RATE = /^-?\d{1,4}(\.\d{1,8})?$/;

/**
 * The figures of a case are refused at the boundary unless the columns store them exactly as
 * sent (migration 0021), so what is audited is what was sent and what is compared.
 */
const planMoney = z
  .string()
  .regex(
    PLAN_MONEY,
    'An amount in US dollars: at most 18 digits before the decimal point and two after',
  );
const multiple = z
  .string()
  .regex(
    MULTIPLE,
    'A multiple above zero: at most six digits before the decimal point and six after',
  )
  .refine((value) => !MULTIPLE.test(value) || /[1-9]/.test(value), 'Must be above zero');
const rate = z
  .string()
  .regex(
    RATE,
    'A rate as a decimal (0.2 is 20%): at most four digits before the decimal point and eight after',
  );
const rateAboveMinusOne = rate.refine(
  (value) => !RATE.test(value) || D(value).gt('-1'),
  'Must be above -1 (a loss of everything)',
);
const lossRate = rate.refine(
  (value) => !RATE.test(value) || (!D(value).isNegative() && D(value).lte('1')),
  'Must be between 0 and 1',
);

/** A reason a person writes: at least a few words, bounded, no control characters. */
const reason = s.plainText(500).min(3);

/** One plan point as it is recorded: the date and at least one of the three figures, in US dollars. */
export const underwritingPointBody = z
  .object({
    periodEnd: s.isoDate,
    revenueLtm: planMoney.nullable(),
    ebitdaLtm: planMoney.nullable(),
    netDebt: planMoney.nullable(),
  })
  .strict()
  .refine(
    (p) => p.revenueLtm !== null || p.ebitdaLtm !== null || p.netDebt !== null,
    'Give at least one of revenue, EBITDA and net debt',
  );

/**
 * A base case as the deal team records it, in US dollars: the body of a new Draft, and of an
 * edit, which replaces the Draft and its plan points whole. The form is the position's (equity
 * or credit) and is never sent; what each form needs is judged by underwritingBodyIssues. A
 * source is not needed while the case is a Draft: it is before a second person confirms it. The
 * reason for a revision is needed from version 2 and kept from there; a first version has none.
 */
export const underwritingCaseBody = z
  .object({
    caseDate: s.isoDate,
    /** The planned exit; for a loan, the expected repayment. */
    plannedExitDate: s.isoDate,
    /** EV / EBITDA at the planned exit (equity). */
    exitMultiple: multiple.optional(),
    /** Gross, from our entry to the planned exit. */
    grossMoic: multiple,
    grossIrr: rateAboveMinusOne,
    /** A loan only. */
    underwrittenYield: rateAboveMinusOne.optional(),
    annualLossRate: lossRate.optional(),
    /** Equity: two or more, in date order, the last on the planned exit. */
    points: z.array(underwritingPointBody).max(UNDERWRITING_MAX_POINTS).optional(),
    /**
     * The currency of every figure; US dollars when left out. A code is accepted here so that
     * another currency is refused in words (422), since the prototype keeps US dollars only.
     */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'A three-letter currency code')
      .optional(),
    note: s.plainText(2000).min(1).optional(),
    revisionReason: reason.optional(),
    /** A document of the position, with the page or the sheet and cell the figures are on. */
    sourceDocumentId: s.uuid.optional(),
    sourcePage: z.number().int().min(1).max(100000).optional(),
    sourceLocator: s.plainText(200).min(1).optional(),
    /** Where the model is held, when no document of the position carries it. */
    sourceNote: s.plainText(500).min(3).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.plannedExitDate <= body.caseDate)
      ctx.addIssue({
        code: 'custom',
        path: ['plannedExitDate'],
        message: 'The planned exit is after the case date',
      });
    (body.points ?? []).forEach((p, i, all) => {
      const before = all[i - 1];
      if (before !== undefined && p.periodEnd <= before.periodEnd)
        ctx.addIssue({
          code: 'custom',
          path: ['points', i, 'periodEnd'],
          message: 'Plan dates are in order, each later than the one before',
        });
    });
    if (body.sourceDocumentId === undefined)
      for (const field of ['sourcePage', 'sourceLocator'] as const)
        if (body[field] !== undefined)
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'A page or a sheet and cell goes with a source document',
          });
  });
export type UnderwritingCaseBody = z.infer<typeof underwritingCaseBody>;

/** The revenue a plan point may hold, in US dollars (config/definitions.json unitSanityBoundsUsd). */
export interface UnderwritingRevenueBounds {
  revenueMin: DecimalInput;
  revenueMax: DecimalInput;
}

/**
 * What a body lacks or should not carry for the form of its position, as validation issues (400).
 * Equity: an exit multiple, two plan points or more with the last on the planned exit, revenue
 * inside the bounds (a figure typed in millions, 200 for 200,000,000, is refused and never
 * guessed), and no yield or loss rate. Credit: an underwritten yield, and no exit multiple or
 * plan points. An empty list means the body is good for the form.
 */
export function underwritingBodyIssues(
  form: z.infer<typeof underwritingForm>,
  body: UnderwritingCaseBody,
  bounds: UnderwritingRevenueBounds,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const points = body.points ?? [];
  if (form === 'credit') {
    if (body.underwrittenYield === undefined)
      issues.push({ path: 'underwrittenYield', message: 'A loan has an underwritten yield' });
    if (body.exitMultiple !== undefined)
      issues.push({
        path: 'exitMultiple',
        message: 'Only an equity base case has an exit multiple',
      });
    if (points.length > 0)
      issues.push({ path: 'points', message: 'Only an equity base case has plan points' });
    return issues;
  }
  if (body.exitMultiple === undefined)
    issues.push({ path: 'exitMultiple', message: 'An equity base case has an exit multiple' });
  if (body.underwrittenYield !== undefined)
    issues.push({ path: 'underwrittenYield', message: 'Only a loan has an underwritten yield' });
  if (body.annualLossRate !== undefined)
    issues.push({ path: 'annualLossRate', message: 'Only a loan has a loss rate' });
  if (points.length < 2)
    issues.push({ path: 'points', message: 'An equity base case has two plan points or more' });
  else if (points[points.length - 1]?.periodEnd !== body.plannedExitDate)
    issues.push({
      path: `points.${points.length - 1}.periodEnd`,
      message: 'The last plan point is dated the planned exit',
    });
  const min = D(bounds.revenueMin);
  const max = D(bounds.revenueMax);
  points.forEach((p, i) => {
    if (p.revenueLtm !== null && (D(p.revenueLtm).lt(min) || D(p.revenueLtm).gt(max)))
      issues.push({
        path: `points.${i}.revenueLtm`,
        message: `Revenue is in US dollars, between ${min.toFixed()} and ${max.toFixed()}`,
      });
  });
  return issues;
}

/**
 * The "(new) to Draft" row of docs/18 section 13 on the case date: with Confirmed cases on
 * record, a new or edited Draft is dated as one of them (it will correct that one) or later than
 * every one of them (a re-underwriting). With none, any date stands.
 */
export function isCaseDateAllowed(
  caseDate: string,
  others: readonly UnderwritingVersionRef[],
): boolean {
  const confirmed = others.filter((v) => v.state === 'Confirmed').map((v) => v.caseDate);
  return confirmed.includes(caseDate) || confirmed.every((date) => date < caseDate);
}

/**
 * The refusals of a create or an edit that are not the state machine's, in the machine's wording
 * (its name first), so the API and the static preview answer the same sentence.
 */
export const UNDERWRITING_REFUSALS = {
  /** 422: a primary fund. */
  noBaseCase: 'underwriting_case: this kind of position holds no base case',
  /** 409: one Draft per position. */
  draftExists:
    'underwriting_case: a Draft already exists for this position; edit it or withdraw it first',
  /** 409: only a Draft is edited; `state` is where the case stands. */
  notDraft: (state: UnderwritingCaseState): string =>
    `underwriting_case: edit is not allowed from ${state}; only a Draft can be edited`,
  /** 422: the prototype keeps US dollars only (docs/03 section 1). */
  currency: 'underwriting_case: a base case is recorded in US dollars',
  /** 422: from version 2. */
  reasonRequired: 'underwriting_case: a revision of the base case needs a reason',
  /** 422. */
  caseDate:
    "underwriting_case: the case date must be a Confirmed case's (a correction) or later than every Confirmed case's (a re-underwriting)",
  /** 422: one sentence for a document the caller cannot see and for one of another position. */
  sourceDocument: "underwriting_case: the source document is not one of this position's documents",
  /** 422: an equity case is confirmed with its plan. */
  planRequired:
    'underwriting_case: an equity base case is confirmed with two plan points or more, the last on its planned exit',
  /** 409: another change reached the record first. */
  raced: 'underwriting_case: another change got there first; open the base case again',
} as const;

/**
 * The commands a person sends (docs/18 section 13). confirm is the second person's, never the
 * one who last changed the figures (SEC-5.6); withdraw takes a Draft back; retire withdraws a
 * case confirmed in error. supersede is not here: it is a step of the confirmation of a
 * correction, and nobody sends it.
 */
export const underwritingCommandBody = z.discriminatedUnion('command', [
  z.object({ command: z.literal('confirm') }).strict(),
  z.object({ command: z.literal('withdraw'), reason }).strict(),
  z.object({ command: z.literal('retire'), reason }).strict(),
]);
export type UnderwritingCommandBody = z.infer<typeof underwritingCommandBody>;
