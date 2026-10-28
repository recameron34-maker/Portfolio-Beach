import { and, desc, eq } from 'drizzle-orm';
import type { IcDecisionBody } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { ProblemError } from '../common/problem.js';
import type { AuditEntry } from '../db/db.service.js';
import { requireMoney } from './rows.js';

/*
 * The IC decision record (docs/04 M7, docs/18 section 4, migration 0013): an approver records the
 * committee's decision while the deal is at IC; a row is never edited, a later decision on another
 * date supersedes it, and the gate from IC to Approved reads the latest one. The amount is in the
 * opportunity's currency.
 */

const decision = schema.icDecision;
const ENTITY = 'deal.ic_decision';

/** The gate as the machine reads it: the latest decision is an approval. */
export async function latestDecisionApproved(tx: Tx, opportunityId: string): Promise<boolean> {
  const latest = await tx
    .select({ decision: decision.decision })
    .from(decision)
    .where(eq(decision.opportunityId, opportunityId))
    .orderBy(desc(decision.decisionDate), desc(decision.createdAt), desc(decision.id))
    .limit(1);
  return latest[0]?.decision === 'approved';
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
