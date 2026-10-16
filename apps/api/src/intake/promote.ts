import { and, eq } from 'drizzle-orm';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { ProblemError } from '../common/problem.js';
import type { AuditEntry } from '../db/db.service.js';

/*
 * The one write into mon.quarterly_performance (docs/04 M2 and M4, SEC-9.1, SEC-9.4, CLAUDE.md
 * rules 5, 6 and 7): the accounting import promotes an approved staged row through it, and the
 * extraction review promotes an approved run through it. The quarter on record is read again in
 * the approval transaction (decision 0009, promotion safety), the entry snapshot is never written
 * by a promotion, the promoter's own check runs before anything is written, and the figures
 * replace the matched quarter or create the quarter the record lacked, with the approver, the
 * time, the reason and the lineage columns. The audit event carries the figures before and after
 * as the record now holds them, read back from the row written, never from the file or the model.
 */

const quarter = schema.quarterlyPerformance;
/** The record status a promotion writes (docs/03): what reports and the one-pager read. */
const APPROVED = 'record_status.approved';

/** The figure columns a promotion may write, in the record's order. */
export const QUARTERLY_FIGURE_KEYS = [
  'revenueLtm',
  'ebitdaLtm',
  'ev',
  'netDebt',
  'cash',
  'totalEquity',
] as const;
export type QuarterlyFigureKey = (typeof QUARTERLY_FIGURE_KEYS)[number];

/** What a promotion writes: only the keys given are written; a null writes the missing placeholder. */
export type QuarterlyFigures = Partial<Record<QuarterlyFigureKey, string | null>>;

/** The quarter on record as the promotion reads it, under the identity the caller holds. */
export interface QuarterOnRecord {
  id: string;
  periodEnd: string;
  revenueLtm: string | null;
  ebitdaLtm: string | null;
  ev: string | null;
  netDebt: string | null;
  cash: string | null;
  totalEquity: string | null;
  status: string;
  isEntrySnapshot: boolean;
}

export interface QuarterApproval {
  approvedBy: string;
  approvedAt: Date;
  approvalReason: string;
}

/** The lineage columns of mon.quarterly_performance (SEC-9.4); a key left out keeps what the record holds. */
export interface QuarterLineage {
  sourceDocumentId?: string | null;
  sourcePage?: number | null;
  sourceLocator?: string | null;
  extractionRunId?: string | null;
  promptVersion?: string | null;
  modelId?: string | null;
}

/** The narrative of the quarter; a key left out keeps what the record holds (an empty list and null on a new row). */
export interface QuarterNarrative {
  highlights?: string[];
  commentary?: string | null;
}

export interface PromoteQuarterInput {
  /** Names the promoter in refusals ('staging' for an intake, 'extraction' for a run). */
  label: string;
  investmentId: string;
  periodEnd: string;
  /** The row the reviewer was shown (the staged row's target); else any row at (investment, period end). */
  targetId?: string | null;
  figures: QuarterlyFigures;
  approval: QuarterApproval;
  lineage?: QuarterLineage;
  narrative?: QuarterNarrative;
  /** The promoter's own check of the quarter on record (null when none), before anything is written; it throws to refuse. */
  check?: (existing: QuarterOnRecord | null) => void;
  /** What the audit event carries beside the figures before and after: ids and names, never content. */
  details: Record<string, unknown>;
}

export interface PromotedQuarter {
  id: string;
  /** True when the quarter was created, false when the quarter on record was replaced. */
  created: boolean;
  before: QuarterlyFigures;
  after: QuarterlyFigures;
}

/** A refusal of the promotion: the record is not in the state the reviewer was shown (422). */
export const quarterPrecondition = (detail: string): ProblemError =>
  new ProblemError(422, 'workflow-precondition', detail);

const RECORD_COLUMNS = {
  id: quarter.id,
  periodEnd: quarter.periodEnd,
  revenueLtm: quarter.revenueLtm,
  ebitdaLtm: quarter.ebitdaLtm,
  ev: quarter.ev,
  netDebt: quarter.netDebt,
  cash: quarter.cash,
  totalEquity: quarter.totalEquity,
  status: quarter.status,
  isEntrySnapshot: quarter.isEntrySnapshot,
};

/** The figures of a row for the keys a promotion names. */
function figuresOf(
  row: Record<QuarterlyFigureKey, string | null>,
  keys: readonly QuarterlyFigureKey[],
): QuarterlyFigures {
  const out: QuarterlyFigures = {};
  for (const key of keys) out[key] = row[key];
  return out;
}

/** Keys with a value given; an undefined value is not a write. */
function given<T extends object>(value: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (value === undefined) return out;
  for (const [k, v] of Object.entries(value))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/**
 * Writes the approved figures into the quarter on record, or creates it, in the transaction
 * given, under the identity the transaction holds (the caller's own row-level security for an
 * intake, the system actor for an extraction run), and audits the promotion with the figures
 * before and after. Refuses the entry snapshot and whatever the promoter's check refuses.
 */
export async function promoteQuarterlyPerformance(
  tx: Tx,
  audit: (entry: AuditEntry) => Promise<void>,
  input: PromoteQuarterInput,
): Promise<PromotedQuarter> {
  const { label } = input;
  const existing: QuarterOnRecord | null =
    (
      await tx
        .select(RECORD_COLUMNS)
        .from(quarter)
        .where(
          input.targetId !== undefined && input.targetId !== null
            ? eq(quarter.id, input.targetId)
            : and(
                eq(quarter.investmentId, input.investmentId),
                eq(quarter.periodEnd, input.periodEnd),
              ),
        )
        .limit(1)
    )[0] ?? null;
  // The entry snapshot is the position's opening record (docs/03): no import and no extraction
  // ever changes it.
  if (existing?.isEntrySnapshot === true)
    throw quarterPrecondition(
      `${label}: the quarter on record is the entry snapshot, which a promotion never changes`,
    );
  input.check?.(existing);

  const keys = QUARTERLY_FIGURE_KEYS.filter((key) => key in input.figures);
  const figures = given(input.figures);
  const lineage = given(input.lineage);
  const narrative = given(input.narrative);
  let written: Record<QuarterlyFigureKey, string | null> & { id: string };
  let before: QuarterlyFigures;
  let created: boolean;
  if (existing !== null) {
    const updated = await tx
      .update(quarter)
      .set({ ...figures, status: APPROVED, ...input.approval, ...lineage, ...narrative })
      .where(eq(quarter.id, existing.id))
      .returning();
    const result = updated[0];
    if (result === undefined)
      throw quarterPrecondition(`${label}: the quarter on record cannot be updated by this caller`);
    written = result;
    before = figuresOf(existing, keys);
    created = false;
  } else {
    const inserted = await tx
      .insert(quarter)
      .values({
        investmentId: input.investmentId,
        periodEnd: input.periodEnd,
        ...figures,
        status: APPROVED,
        ...input.approval,
        ...lineage,
        isEntrySnapshot: false,
        currency: 'USD',
        highlights: narrative.highlights ?? [],
        commentary: narrative.commentary ?? null,
      })
      .returning();
    const result = inserted[0];
    if (result === undefined) throw quarterPrecondition(`${label}: the quarter was not written`);
    written = result;
    before = Object.fromEntries(keys.map((key) => [key, null]));
    created = true;
  }
  // The figures after are the values as stored, read back from the row written (rule 6: the
  // audit records what the record now holds).
  const after = figuresOf(written, keys);
  await audit({
    action: 'quarterly_performance.promote',
    entity: 'mon.quarterly_performance',
    entityId: written.id,
    reason: input.approval.approvalReason,
    details: { ...input.details, before, after },
  });
  return { id: written.id, created, before, after };
}
