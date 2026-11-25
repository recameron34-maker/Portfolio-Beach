import { z } from 'zod';
import * as s from './schemas.js';

/*
 * Reporting packages (docs/04 M14, docs/18 section 5, docs/08 section 7): one client report for
 * a quarter and a basis, the snapshot it shows, the findings of the report QA rules and the
 * commands that move it from Draft to Released. Money travels as decimal strings; reasons and
 * explanations are bounded plain text, measured and kept without the spaces around them.
 */

export const REPORT_PACKAGE_STATES = [
  'Draft',
  'Generated',
  'QAFailed',
  'QAPassed',
  'InReview',
  'Approved',
  'Released',
] as const;
export const reportPackageState = z.enum(REPORT_PACKAGE_STATES);
export type ReportPackageState = z.infer<typeof reportPackageState>;

export const reportPackageBasis = z.enum(['gross', 'net']);
export const reportPackageLabel = z.enum(['preliminary', 'final']);

/**
 * What a person writes on a package, a reason or an explanation: 3 to 500 characters once the
 * spaces around it are dropped. Text of spaces is no reason: the record refuses a blank one
 * (migration 0019), so the boundary does first, and a blank explanation never replaces a real one.
 */
const written = s.trimmedText(500).min(3);
const reason = written;
/** A position's number, as it keys an explanation. */
const positionRef = z.string().min(1).max(64);

/** One position of a package for the quarter (QaLine of @pb/report-engine). */
export const reportPackageLine = z.object({
  ref: z.string(),
  enteredInPeriod: z.boolean(),
  beginNav: s.decimalString.nullable(),
  contributions: s.decimalString,
  distributions: s.decimalString,
  gainLoss: s.decimalString.nullable(),
  endNav: s.decimalString.nullable(),
  /** The period the end NAV's mark is for; earlier than the package's period when it is stale. */
  endNavPeriodEnd: s.isoDate.nullable(),
  recordedQuarterStartNav: s.decimalString.nullable(),
  latestFigureDate: s.isoDate.nullable(),
});
export type ReportPackageLine = z.infer<typeof reportPackageLine>;

/** The snapshot a package shows (QaSnapshot of @pb/report-engine), stored on the package. */
export const reportPackageContent = z.object({
  periodEnd: s.isoDate,
  asOf: s.isoDate,
  status: reportPackageLabel.nullable(),
  basis: reportPackageBasis.nullable(),
  lines: z.array(reportPackageLine),
  movers: z.array(z.string()),
  commentary: z.array(z.object({ ref: z.string(), moversKey: z.string() })),
  footnotes: z.array(z.object({ ref: z.string(), code: z.string() })),
  clientLines: z.array(
    z.object({
      clientRef: z.string(),
      ref: z.string(),
      ownershipPct: s.decimalString,
      nav: s.decimalString,
    }),
  ),
  priorRelease: z
    .object({
      endNav: z.record(z.string(), s.decimalString),
      explanations: z.record(z.string(), z.string()),
    })
    .nullable(),
});
export type ReportPackageContent = z.infer<typeof reportPackageContent>;

/** One finding of one QA run; `override` is set when an approver overrode a finding that failed. */
export const qaFindingRow = z.object({
  id: s.uuid,
  runNo: z.number().int(),
  rule: z.string(),
  entityRef: z.string(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  passed: z.boolean(),
  detail: z.string(),
  override: z.object({ reason: z.string(), approver: s.person, at: z.string() }).nullable(),
});
export type QaFindingRow = z.infer<typeof qaFindingRow>;

export const reportPackageRow = z.object({
  id: s.uuid,
  client: z.object({ id: s.uuid, name: z.string() }),
  periodEnd: s.isoDate,
  asOf: s.isoDate,
  basis: reportPackageBasis,
  label: reportPackageLabel,
  version: z.number().int(),
  state: reportPackageState,
  preparedBy: s.person,
  reviewer: s.person.nullable(),
  approvedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  /** The latest QA run: how many findings it has, how many failed and how many of those are overridden. */
  qa: z.object({
    runNo: z.number().int().nullable(),
    findings: z.number().int(),
    failed: z.number().int(),
    overridden: z.number().int(),
  }),
  rowVersion: z.number().int(),
});
export type ReportPackageRow = z.infer<typeof reportPackageRow>;

export const reportPackageList = z.object({ items: z.array(reportPackageRow) });
export type ReportPackageList = z.infer<typeof reportPackageList>;

/**
 * One generation run of a package, as its change log lists it (rpt.package.change_log): when it
 * ran, who ran it and what it counted. A generate and every regenerate is a run; the override,
 * the submission, the approval and the release are in the audit trail, not here.
 */
export const reportPackageRun = z.object({
  at: z.string(),
  by: s.person,
  runNo: z.number().int(),
  /** How many positions the run's snapshot has. */
  lines: z.number().int(),
  /** How many findings the run's QA wrote, and how many of them failed. */
  findings: z.number().int(),
  failed: z.number().int(),
});
export type ReportPackageRun = z.infer<typeof reportPackageRun>;

export const reportPackageDetail = reportPackageRow.extend({
  correctionReason: z.string().nullable(),
  /** SHA-256 of the approved content, hex. */
  contentHash: z.string().nullable(),
  releasedBy: s.person.nullable(),
  content: reportPackageContent.nullable(),
  /** The findings of the latest run, failed first. */
  findings: z.array(qaFindingRow),
  tieOutExplanations: z.record(z.string(), z.string()),
  /** The generation runs, in run order. */
  changeLog: z.array(reportPackageRun),
});
export type ReportPackageDetail = z.infer<typeof reportPackageDetail>;

export const reportPackageCreateBody = z
  .object({
    clientId: s.uuid,
    /** A calendar quarter end. */
    periodEnd: s.isoDate,
    /** The date the figures are read as of; the API's own date when left out. */
    asOf: s.isoDate.optional(),
    basis: reportPackageBasis,
    label: reportPackageLabel,
    /** Required when a Released package exists for the client, period and basis: this one corrects it. */
    correctionReason: reason.optional(),
  })
  .strict();
export type ReportPackageCreateBody = z.infer<typeof reportPackageCreateBody>;

/** Why a begin NAV differs from the last released package, by position number. */
const explanations = z.record(positionRef, written);

/**
 * The commands of docs/18 section 5. generate and regenerate build the snapshot and run the QA
 * rules in one step (the QA outcome is the system's, never the caller's to state); overrideQa is
 * the approver's, with a reason; approve is refused to the preparer (SEC-5.6).
 */
export const reportPackageCommandBody = z.discriminatedUnion('command', [
  z.object({ command: z.literal('generate'), explanations: explanations.optional() }).strict(),
  z.object({ command: z.literal('regenerate'), explanations: explanations.optional() }).strict(),
  z.object({ command: z.literal('overrideQa'), reason }).strict(),
  z.object({ command: z.literal('submit') }).strict(),
  z.object({ command: z.literal('approve') }).strict(),
  z.object({ command: z.literal('release') }).strict(),
]);
export type ReportPackageCommandBody = z.infer<typeof reportPackageCommandBody>;
