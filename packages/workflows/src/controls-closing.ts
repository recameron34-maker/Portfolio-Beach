import { D, ZERO } from '@pb/calc';

/*
 * The pure rules of the pipeline gates and the closing (docs/04 M7, M8, M22; docs/18 sections 4
 * and 12), kept once for the API (apps/api/src/pipeline, apps/api/src/closing) and the web
 * preview's simulation (apps/web/src/preview/routes), so the two cannot drift apart: plain data
 * in, plain data out, no database and no clock. Each caller loads its rows and passes them in.
 *
 * An instant here is text that sorts as time does and is only ever compared, never parsed: the
 * API passes UTC timestamps to the microsecond in one fixed-width format, the preview passes the
 * keys of its own sequence. One call must use one kind of instant throughout.
 */

/* ---- The refusals both sides answer, word for word ---- */

/** 422 for a change to the allocation lines or the checklist items of a confirmed closing. */
export const CLOSING_CONFIRMED_REFUSAL =
  'the closing is confirmed; change the close date or ask operations to reopen it';

/** 422 for a close date change or a reopen once the deal converted: the close date is the position's entry date. */
export const POSITION_EXISTS_REFUSAL =
  'the position exists; record the change through a deal change request';

/** 422 for Closing to Closed while operations have not confirmed the closing. */
export const CLOSING_NOT_CONFIRMED_REFUSAL = 'the closing is not confirmed by operations (M8)';

/** The reason on record when a confirmed closing returns to Open because its deal came back to Closing. */
export const CLOSING_REENTERED_REASON =
  'The deal reached Closing again with a new close date and commitment; operations confirm again';

/* ---- The allocation tie-out (M22) ---- */

/** An allocation line as the tie-out reads it: the amount received, when one is on record. */
export interface ReceivedLine {
  received: string | null;
}

/** The received amounts against the closing commitment, as decimal strings to two places. */
export interface TieOut {
  commitment: string;
  allocated: string;
  difference: string;
  tiedOut: boolean;
}

/** How many lines have no received amount yet. */
export const missingReceived = (rows: readonly ReceivedLine[]): number =>
  rows.filter((r) => r.received === null).length;

/**
 * The M22 tie-out: the received amounts against the commitment, compared exactly. Tied out means
 * every line has a received amount and they sum to the commitment; `allocated` is the sum of the
 * received amounts on record, so a line with none adds nothing and keeps the tie-out false. A
 * requested amount is what was asked for, not what the deal got: it never stands in (rule 10).
 */
export function tieOut(commitment: string, rows: readonly ReceivedLine[]): TieOut {
  const allocated = rows.reduce(
    (sum, r) => (r.received === null ? sum : sum.plus(r.received)),
    ZERO,
  );
  const target = D(commitment);
  return {
    commitment: target.toFixed(2),
    allocated: allocated.toFixed(2),
    difference: allocated.minus(target).toFixed(2),
    tiedOut: missingReceived(rows) === 0 && allocated.comparedTo(target) === 0,
  };
}

/** What a failed tie-out says when received amounts are missing (the plain M22 refusal stands otherwise): null when none is. */
export function missingReceivedRefusal(rows: readonly ReceivedLine[]): string | null {
  const missing = missingReceived(rows);
  return missing === 0
    ? null
    : `received amounts are missing on ${missing} ${missing === 1 ? 'line' : 'lines'} (M22)`;
}

/**
 * The detail the confirmation answers in place of the machine's tie-out refusal when received
 * amounts are missing (M22), or null when the machine's own message stands: the command is not
 * confirm, the refusal is not a precondition, a required item is still open (the checklist
 * refusal comes first, as the machine orders them), or every line has a received amount.
 */
export function confirmRefusal(input: {
  command: string;
  /** The code of the refusal the machine gave. */
  code: 'forbidden' | 'role' | 'precondition';
  itemsComplete: boolean;
  tiedOut: boolean;
  rows: readonly ReceivedLine[];
}): string | null {
  if (
    input.command !== 'confirm' ||
    input.code !== 'precondition' ||
    !input.itemsComplete ||
    input.tiedOut
  )
    return null;
  const missing = missingReceivedRefusal(input.rows);
  return missing === null ? null : `closing: ${missing}`;
}

/* ---- The closing checklist and the closing gate (M8) ---- */

/** A checklist item as the gate reads it. */
export interface ChecklistItem {
  required: boolean;
  /** open, received or waived. */
  status: string;
}

/** The M8 gate: every required item received or waived. */
export const requiredItemsComplete = (items: readonly ChecklistItem[]): boolean =>
  items.every((i) => !i.required || i.status !== 'open');

/** How many items are still open, and how many of those are required. */
export function checklistCounts(items: readonly ChecklistItem[]): {
  itemsOpen: number;
  itemsRequiredOpen: number;
} {
  return {
    itemsOpen: items.filter((i) => i.status === 'open').length,
    itemsRequiredOpen: items.filter((i) => i.required && i.status === 'open').length,
  };
}

/** The closing gate as the opportunity shows it; `ok` is what Closing to Closed needs. */
export interface ClosingGate {
  checklistComplete: boolean;
  allocationTiedOut: boolean;
  /** Operations confirmed the closing record (docs/18 section 12). */
  confirmed: boolean;
  ok: boolean;
}

/**
 * The closing gate from the closing's state, its checklist and its tie-out; a deal with no
 * closing record yet has none of the three. Clear only when the checklist is complete, the
 * allocations tie out and operations confirmed.
 */
export function closingGate(
  closing: { state: string; items: readonly ChecklistItem[]; tiedOut: boolean } | null,
): ClosingGate {
  const checklistComplete = closing !== null && requiredItemsComplete(closing.items);
  const allocationTiedOut = closing?.tiedOut === true;
  const confirmed = closing?.state === 'OpsConfirmed';
  return {
    checklistComplete,
    allocationTiedOut,
    confirmed,
    ok: checklistComplete && allocationTiedOut && confirmed,
  };
}

/* ---- The stage history as the gates read it (docs/18 section 4) ---- */

/** One stage history row: where the deal moved from and to, and the instant it moved. */
export interface StageMove {
  fromStage: string | null;
  toStage: string;
  at: string;
}

const latest = (instants: readonly string[]): string | null =>
  instants.reduce<string | null>((max, at) => (max === null || at > max ? at : max), null);

/** The instant of the latest reopen from Passed; null when the deal was never reopened. */
export function latestReopen(history: readonly StageMove[]): string | null {
  return latest(history.filter((h) => h.fromStage === 'Passed').map((h) => h.at));
}

/**
 * The instant the current IC round began: the latest move into IC, or a later reopen from Passed
 * (no decision can follow that one until the deal is at IC again, since a decision is recorded
 * only at IC). Null when the deal never reached IC.
 */
export function icRoundStart(history: readonly StageMove[]): string | null {
  return latest(
    history.filter((h) => h.toStage === 'IC' || h.fromStage === 'Passed').map((h) => h.at),
  );
}

/* ---- The diligence gate (M7) ---- */

/** A diligence task as the gate reads it, with the instant of its last change (null when none is on record). */
export interface GateTask {
  /** open, done or waived. */
  status: string;
  requiredForIc: boolean;
  changedAt: string | null;
}

/** The diligence gate as the detail shows it; the machine reads `ok`. */
export interface DiligenceGate {
  /** Tasks required for IC that are still open. */
  requiredOpen: number;
  ok: boolean;
  /** Tasks required for IC that were done or waived before the deal was last reopened from Passed. */
  carriedOver: number;
}

/**
 * The gate to IC: how many tasks required for IC are still open. A task done or waived before a
 * pass stays done when the deal is reopened (the work was done); the gate counts those as carried
 * over, from the task's last change against the latest reopen in the stage history, so the people
 * taking the deal to IC again can see what predates the reopen.
 */
export function diligenceGate(
  tasks: readonly GateTask[],
  history: readonly StageMove[],
): DiligenceGate {
  const required = tasks.filter((t) => t.requiredForIc);
  const reopenedAt = latestReopen(history);
  const requiredOpen = required.filter((t) => t.status === 'open').length;
  return {
    requiredOpen,
    ok: requiredOpen === 0,
    carriedOver: required.filter(
      (t) =>
        t.status !== 'open' &&
        reopenedAt !== null &&
        t.changedAt !== null &&
        t.changedAt < reopenedAt,
    ).length,
  };
}

/* ---- The IC decision gate (M7) ---- */

/** An IC decision as the gate reads it, with the instant its record was written. */
export interface RoundDecision {
  id: string;
  /** The day the committee decided, as yyyy-mm-dd. */
  decisionDate: string;
  /** approved, declined or deferred. */
  decision: string;
  recordedAt: string;
}

const descending = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

/**
 * The decision the gate reads: the latest of the current IC round, by decision date, then by the
 * instant it was recorded, then by id. A round starts when the deal enters IC; a deal that was
 * passed and reopened walks to IC again, and what the committee decided before the pass is
 * history, not the gate: only a decision recorded since the round began counts, and from a reopen
 * until the next IC none does. "Since" compares the instant the record was written, not the
 * decision date an approver types: that date may rightly be the day the committee met, a day or
 * two before the record moved. Null when the round has no decision.
 */
export function icGateDecision<T extends RoundDecision>(
  decisions: readonly T[],
  history: readonly StageMove[],
): T | null {
  const start = icRoundStart(history);
  if (start === null) return null;
  return (
    decisions
      .filter((d) => d.recordedAt >= start)
      .sort(
        (a, b) =>
          descending(a.decisionDate, b.decisionDate) ||
          descending(a.recordedAt, b.recordedAt) ||
          descending(a.id, b.id),
      )[0] ?? null
  );
}

/** The gate from IC to Approved: the latest decision of the current IC round is an approval. */
export const icDecisionApproved = (
  decisions: readonly RoundDecision[],
  history: readonly StageMove[],
): boolean => icGateDecision(decisions, history)?.decision === 'approved';
