import { and, eq } from 'drizzle-orm';
import type { IcDecisionBody } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { icDecisionApproved } from '@pb/workflows';
import { ProblemError } from '../common/problem.js';
import type { AuditEntry } from '../db/db.service.js';
import { instantOf, loadStageMoves, requireMoney } from './rows.js';

/*
 * The IC decision record (docs/04 M7, docs/18 section 4, migration 0013): an approver records the
 * committee's decision while the deal is at IC; a row is never edited, a later decision on another
 * date supersedes it, and the gate from IC to Approved reads the latest one of the current IC
 * round. The amount is in the opportunity's currency.
 *
 * A round starts when the deal enters IC. A deal that was passed and reopened walks to IC again,
 * and what the committee decided before the pass is history, not the gate: only a decision
 * recorded since the deal last entered IC counts, and from a reopen until the next IC none does.
 * "Since" compares the instant the decision row was written with the instant of the stage history
 * row, both the database's clock, rather than the decision date an approver types: that date may
 * rightly be the day the committee met, a day or two before the record moved. The rule (where a
 * round starts, which decision of it the gate reads) is the shared one in @pb/workflows
 * (controls-closing.ts), which the web preview follows too.
 */

const decision = schema.icDecision;
const ENTITY = 'deal.ic_decision';

/**
 * The gate as the machine reads it: the latest decision of the current IC round is an approval.
 * This loads the decisions and the stage history with their instants to the microsecond, as the
 * database holds them; the shared rule picks the round and the decision.
 */
export async function latestDecisionApproved(tx: Tx, opportunityId: string): Promise<boolean> {
  const decisions = await tx
    .select({
      id: decision.id,
      decisionDate: decision.decisionDate,
      decision: decision.decision,
      recordedAt: instantOf(decision.createdAt),
    })
    .from(decision)
    .where(eq(decision.opportunityId, opportunityId));
  return icDecisionApproved(decisions, await loadStageMoves(tx, opportunityId));
}

export async function recordDecision(
  tx: Tx,
  audit: (entry: AuditEntry) => Promise<void>,
  opportunity: { id: string; stage: string; currency: string },
  body: IcDecisionBody,
  actorId: string,
): Promise<void> {
  if (opportunity.stage !== 'IC')
    throw new ProblemError(
      422,
      'workflow-precondition',
      'an IC decision is recorded while the deal is at IC (docs/18 section 4)',
    );
  requireMoney(body.amount, 'amount');
  const sameDay = await tx
    .select({ id: decision.id })
    .from(decision)
    .where(
      and(eq(decision.opportunityId, opportunity.id), eq(decision.decisionDate, body.decisionDate)),
    )
    .limit(1);
  if (sameDay.length > 0)
    throw new ProblemError(
      409,
      'conflict',
      'a decision is already recorded for that date; a decision on another date supersedes it',
    );
  const inserted = await tx
    .insert(decision)
    .values({
      opportunityId: opportunity.id,
      decisionDate: body.decisionDate,
      decision: body.decision,
      amount: body.amount ?? null,
      currency: opportunity.currency,
      conditions: body.conditions,
      recordedBy: actorId,
    })
    .returning();
  await audit({
    action: 'ic_decision.record',
    entity: ENTITY,
    entityId: inserted[0]?.id ?? null,
    details: {
      opportunityId: opportunity.id,
      decisionDate: body.decisionDate,
      decision: body.decision,
      amount: body.amount ?? null,
      conditions: body.conditions.length,
    },
  });
}
