import { and, eq } from 'drizzle-orm';
import { diligenceTemplateFor } from '@pb/contracts';
import type {
  DiligenceTaskCommandBody,
  DiligenceTaskCreateBody,
  DiligenceTemplates,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { ProblemError } from '../common/problem.js';
import { requireUuid } from '../common/validate.js';
import type { AuditEntry } from '../db/db.service.js';
import { requireAppUser, requireTaxonomyCodes, requireVisibleDocument } from './refs.js';

/*
 * The diligence gate (docs/04 M7, docs/18 section 4, migration 0013). Tasks come from the template
 * of the deal type in config/diligence_templates.json when the deal first enters Diligence (a deal
 * that returns to Diligence keeps its tasks), or one at a time from the deal team. A task is
 * completed with optional evidence from the hub, waived with a reason, or reopened; the moves are
 * the small table below, and anything else is a 409 like a forbidden workflow transition. The gate
 * to IC holds while a task required for IC is open; the machine lets an approver override it with
 * a reason, audited like every stage change.
 */

const task = schema.diligenceTask;
const ENTITY = 'deal.diligence_task';
const NOT_FOUND = 'Diligence task not found';

/** The status moves a task command makes; a command from any other status is a 409. */
const MOVES: Record<DiligenceTaskCommandBody['command'], { from: readonly string[]; to: string }> =
  {
    complete: { from: ['open'], to: 'done' },
    waive: { from: ['open'], to: 'waived' },
    reopen: { from: ['done', 'waived'], to: 'open' },
  };

/** The gate as the machine reads it: how many tasks required for IC are still open. */
export async function diligenceGate(
  tx: Tx,
  opportunityId: string,
): Promise<{ requiredOpen: number; ok: boolean }> {
  const rows = await tx
    .select({ status: task.status })
    .from(task)
    .where(and(eq(task.opportunityId, opportunityId), eq(task.requiredForIc, true)));
  const requiredOpen = rows.filter((r) => r.status === 'open').length;
  return { requiredOpen, ok: requiredOpen === 0 };
}

/**
 * The template tasks of the deal type, created when the deal has none yet (the first time it
 * enters Diligence); the deal lead owns them. Answers how many were created.
 */
export async function createTemplateTasks(
  tx: Tx,
  audit: (entry: AuditEntry) => Promise<void>,
  opportunity: { id: string; dealType: string; ownerId: string | null },
  templates: DiligenceTemplates,
): Promise<number> {
  const existing = await tx
    .select({ id: task.id })
    .from(task)
    .where(eq(task.opportunityId, opportunity.id))
    .limit(1);
  if (existing.length > 0) return 0;
  const template = diligenceTemplateFor(templates, opportunity.dealType);
  await tx.insert(task).values(
    template.map((t) => ({
      opportunityId: opportunity.id,
      workstream: t.workstream,
      title: t.title,
      ownerId: opportunity.ownerId,
      status: 'open',
      requiredForIc: t.requiredForIc,
    })),
  );
  await audit({
    action: 'diligence_task.create_from_template',
    entity: ENTITY,
    details: {
      opportunityId: opportunity.id,
      dealType: opportunity.dealType,
      count: template.length,
      requiredForIc: template.filter((t) => t.requiredForIc).length,
    },
  });
  return template.length;
}

/** One task beside the template ones, from the deal team. */
export async function createTask(
  tx: Tx,
  audit: (entry: AuditEntry) => Promise<void>,
  opportunityId: string,
  body: DiligenceTaskCreateBody,
): Promise<void> {
  await requireTaxonomyCodes(tx, [{ code: body.workstream, path: 'workstream' }]);
  if (body.ownerId !== undefined) await requireAppUser(tx, body.ownerId, 'ownerId');
  const inserted = await tx
    .insert(task)
    .values({
      opportunityId,
      workstream: body.workstream,
      title: body.title,
      ownerId: body.ownerId ?? null,
      dueDate: body.dueDate ?? null,
      status: 'open',
      requiredForIc: body.requiredForIc,
    })
    .returning();
  await audit({
    action: 'diligence_task.create',
    entity: ENTITY,
    entityId: inserted[0]?.id ?? null,
    details: {
      opportunityId,
      workstream: body.workstream,
      requiredForIc: body.requiredForIc,
      dueDate: body.dueDate ?? null,
    },
  });
}

/** complete (evidence optional), waive (reason) or reopen a task of the opportunity; audited with the status before and after. */
export async function taskCommand(
  tx: Tx,
  audit: (entry: AuditEntry) => Promise<void>,
  opportunityId: string,
  taskId: string,
  body: DiligenceTaskCommandBody,
): Promise<void> {
  requireUuid(taskId, NOT_FOUND);
  const locked = (
    await tx
      .select({
        id: task.id,
        status: task.status,
        evidenceDocumentId: task.evidenceDocumentId,
        requiredForIc: task.requiredForIc,
      })
      .from(task)
      .where(and(eq(task.id, taskId), eq(task.opportunityId, opportunityId)))
      .for('update')
  )[0];
  if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
  const move = MOVES[body.command];
  if (!move.from.includes(locked.status))
    throw new ProblemError(
      409,
      'workflow-transition',
      `diligence task: ${body.command} is not allowed from ${locked.status}`,
    );
  const patch: Partial<typeof task.$inferInsert> = { status: move.to };
  if (body.command === 'complete') {
    if (body.evidenceDocumentId !== undefined) {
      await requireVisibleDocument(tx, body.evidenceDocumentId, 'evidenceDocumentId');
      patch.evidenceDocumentId = body.evidenceDocumentId;
    }
    patch.waivedReason = null;
  } else if (body.command === 'waive') {
    patch.waivedReason = body.reason;
  } else {
    patch.waivedReason = null;
  }
  const updated = await tx
    .update(task)
    .set(patch)
    .where(and(eq(task.id, taskId), eq(task.status, locked.status)))
    .returning();
  if (updated[0] === undefined)
    throw new ProblemError(
      409,
      'conflict',
      'diligence task: another command changed the task first; open it again',
    );
  await audit({
    action: `diligence_task.${body.command}`,
    entity: ENTITY,
    entityId: taskId,
    ...(body.command === 'waive' ? { reason: body.reason } : {}),
    details: {
      opportunityId,
      requiredForIc: locked.requiredForIc,
      status: { before: locked.status, after: move.to },
      evidenceDocumentId: {
        before: locked.evidenceDocumentId,
        after: patch.evidenceDocumentId ?? locked.evidenceDocumentId,
      },
    },
  });
}
