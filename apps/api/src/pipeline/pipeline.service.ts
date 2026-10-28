import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import type {
  AllocationsPutBody,
  ClosingChecklist,
  DiligenceTaskCommandBody,
  DiligenceTaskCreateBody,
  DiligenceTemplates,
  IcDecisionBody,
  OpportunityCommandBody,
  OpportunityCreateBody,
  OpportunityDetail,
  OpportunityGates,
  OpportunityPage,
  opportunityListQuery,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { attempt, dealStageMachine } from '@pb/workflows';
import type { z } from 'zod';
import { loadClosingView, requiredItemsComplete } from '../closing/summary.js';
import type { ClosingView } from '../closing/summary.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { requireIfMatch } from '../common/row-version.js';
import { ADAPTERS, CLOSING_CHECKLIST, DILIGENCE_TEMPLATES } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';
import { allocationsOf, loadAllocationRows, replaceAllocations } from './allocations.js';
import { convertToInvestment } from './convert.js';
import type { Conversion } from './convert.js';
import { createTask, createTemplateTasks, diligenceGate, taskCommand } from './diligence.js';
import { latestDecisionApproved, recordDecision } from './ic.js';
import { requireTaxonomyCodes } from './refs.js';
import {
  ENTITY,
  NOT_FOUND,
  conflict,
  loadIcDecisions,
  loadOpportunities,
  loadStageHistory,
  loadTasks,
  lockOpportunity,
  requireMoney,
  stageOf,
  toOpportunityRow,
} from './rows.js';
import type { LockedOpportunity } from './rows.js';

/*
 * The pipeline (docs/04 M5 skeleton, docs/18 section 4, decision 0013): opportunities with their
 * stage commands through dealStageMachine. A command locks the opportunity, reads the gates from
 * the same rows the detail shows (the diligence tasks, the latest IC decision, the closing's
 * checklist and allocation tie-out), runs the machine for the role, the transition and the
 * preconditions, writes the stage with a guard on the stage and row version it read, appends the
 * stage history row and audits the change with the stage before and after. Advancing Approved to
 * Closing opens the closing record (docs/18 section 12) with the checklist from config; advancing
 * Closing to Closed converts the deal into a position with the data captured once (convert.ts).
 * Anything the caller cannot see is 404 (row-level security carries the opportunity wall).
 */

export type OpportunityListOptions = z.infer<typeof opportunityListQuery>;

const opp = schema.opportunity;
const history = schema.opportunityStageHistory;
const closingTable = schema.closing;
const closingItem = schema.closingItem;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** The cursor is "receivedDate|id" of the last row, the list's sort key (newest received first). */
const CURSOR = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\|(${UUID})$`);

const validation = (path: string, message: string): ProblemError =>
  new ProblemError(400, 'validation', 'Invalid body', [{ path, message }]);

@Injectable()
export class PipelineService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DILIGENCE_TEMPLATES) private readonly templates: DiligenceTemplates,
    @Inject(CLOSING_CHECKLIST) private readonly checklist: ClosingChecklist,
  ) {}

  /** The board's rows, newest received first, paged on (receivedDate, id), filtered by stage and deal lead. */
  async list(
    principal: Principal,
    requestId: string,
    opts: OpportunityListOptions,
  ): Promise<OpportunityPage> {
    const today = this.adapters.clock.today();
    const conditions: (SQL | undefined)[] = [];
    if (opts.stage !== undefined) conditions.push(eq(opp.stage, opts.stage));
    if (opts.ownerId !== undefined) conditions.push(eq(opp.ownerId, opts.ownerId));
    if (opts.cursor !== undefined) {
      const [receivedDate = '', id = ''] = decodeCursor(opts.cursor, CURSOR, [1]);
      const date = sql`${receivedDate}::date`;
      conditions.push(
        or(
          lt(opp.receivedDate, date),
          and(eq(opp.receivedDate, date), lt(opp.id, sql`${id}::uuid`)),
        ),
      );
    }
    return this.db.run(principal, requestId, async (tx) => {
      const rows = await loadOpportunities(tx, {
        where: and(...conditions),
        orderBy: [desc(opp.receivedDate), desc(opp.id)],
        limit: opts.limit + 1,
      });
      const page = rows.slice(0, opts.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => toOpportunityRow(r, today)),
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.receivedDate, last.id])
            : null,
      };
    });
  }

  /** One opportunity with everything the workspace shows; 404 when the caller cannot see it. The open is audited. */
  async detail(principal: Principal, requestId: string, id: string): Promise<OpportunityDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const detail = await this.loadDetail(tx, id);
      await audit({ action: 'opportunity.read', entity: ENTITY, entityId: id });
      return detail;
    });
  }

  /** A new deal at Sourced, led by the creator, with its first stage history row. */
  async create(
    principal: Principal,
    requestId: string,
    body: OpportunityCreateBody,
  ): Promise<OpportunityDetail> {
    requireMoney(body.targetCommitment, 'targetCommitment');
    return this.db.run(principal, requestId, async (tx, audit) => {
      await requireTaxonomyCodes(tx, [
        { code: body.dealType, path: 'dealType' },
        { code: body.sector, path: 'sector' },
        { code: body.geography, path: 'geography' },
      ]);
      const sponsor = (
        await tx
          .select({ id: schema.sponsor.id })
          .from(schema.sponsor)
          .where(eq(schema.sponsor.id, body.sponsorId))
          .limit(1)
      )[0];
      if (sponsor === undefined) throw validation('sponsorId', 'Unknown sponsor');
      if (body.sponsorFundId !== undefined) {
        const fund = (
          await tx
            .select({ sponsorId: schema.sponsorFund.sponsorId })
            .from(schema.sponsorFund)
            .where(eq(schema.sponsorFund.id, body.sponsorFundId))
            .limit(1)
        )[0];
        if (fund?.sponsorId !== body.sponsorId)
          throw validation('sponsorFundId', 'Not a fund of the sponsor');
      }
      const inserted = (
        await tx
          .insert(opp)
          .values({
            name: body.name,
            companyName: body.companyName,
            portfolioCompanyId: null,
            sponsorId: body.sponsorId,
            sponsorFundId: body.sponsorFundId ?? null,
            dealType: body.dealType,
            sector: body.sector ?? null,
            geography: body.geography ?? null,
            stage: 'Sourced',
            ownerId: principal.userId,
            receivedDate: body.receivedDate,
            targetCommitment: body.targetCommitment ?? null,
            currency: 'USD',
            source: body.source ?? null,
          })
          .returning()
      )[0];
      if (inserted === undefined)
        throw new ProblemError(500, 'internal', 'opportunity: the record was not written');
      await tx.insert(history).values({
        opportunityId: inserted.id,
        fromStage: null,
        toStage: 'Sourced',
        command: 'create',
        reason: null,
        changedBy: principal.userId,
      });
      await audit({
        action: 'opportunity.create',
        entity: ENTITY,
        entityId: inserted.id,
        details: {
          name: body.name,
          companyName: body.companyName,
          sponsorId: body.sponsorId,
          sponsorFundId: body.sponsorFundId ?? null,
          dealType: body.dealType,
          stage: 'Sourced',
          receivedDate: body.receivedDate,
          targetCommitment: body.targetCommitment ?? null,
        },
      });
      return this.loadDetail(tx, inserted.id);
    });
  }

  /**
   * advance, pass and reopen through docs/18 section 4. The machine sees the gates as the detail
   * shows them; the service adds what the machine has no flag for: the closing must be confirmed
   * by operations before Closing advances to Closed (M8). The write guards on the stage and the
   * row version read under lock; If-Match, when sent, is checked against that row version first.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: OpportunityCommandBody,
    ifMatch: string | undefined,
  ): Promise<OpportunityDetail> {
    requireUuid(id, NOT_FOUND);
    if (body.command === 'advance') requireMoney(body.commitmentAmount, 'commitmentAmount');
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = await lockOpportunity(tx, id);
      requireIfMatch(ifMatch, locked.rowVersion);
      const from = stageOf(locked.stage);
      const closing = await loadClosingView(tx, eq(closingTable.opportunityId, id), this.checklist);
      const gate = await diligenceGate(tx, id);
      const icApproved = await latestDecisionApproved(tx, id);
      const record = {
        requiredTasksDone: gate.ok,
        icDecisionRecorded: icApproved,
        closingChecklistComplete: closing !== null && requiredItemsComplete(closing.items),
        allocationTiedOut: closing?.summary.allocationTieOut.tiedOut === true,
        closingRecordReady:
          body.command === 'advance' &&
          body.closeDate !== undefined &&
          body.commitmentAmount !== undefined,
        ...(body.command === 'pass' ? { passReasonCode: body.passReasonCode } : {}),
      };
      const reason = body.command === 'pass' ? body.note : body.reason;
      const result = attempt(dealStageMachine, from, body.command, {
        actorId: principal.userId,
        actorRoles: principal.roles,
        ...(reason !== undefined ? { reason } : {}),
        record,
      });
      if (!result.ok) throw workflowProblem(result);
      const to = result.to;

      const patch: Partial<typeof opp.$inferInsert> = { stage: to };
      const details: Record<string, unknown> = { stage: { before: from, after: to } };
      if (body.command === 'pass') {
        await requireTaxonomyCodes(tx, [{ code: body.passReasonCode, path: 'passReasonCode' }]);
        patch.passReasonCode = body.passReasonCode;
        patch.passNote = body.note ?? null;
        details.passReasonCode = { before: locked.passReasonCode, after: body.passReasonCode };
      } else if (body.command === 'reopen') {
        // The pass stays on record in the stage history and the audit trail; the live record is a deal again.
        patch.passReasonCode = null;
        patch.passNote = null;
        details.passReasonCode = { before: locked.passReasonCode, after: null };
      } else if (from === 'Approved' && to === 'Closing') {
        if (body.closeDate === undefined || body.commitmentAmount === undefined)
          throw new ProblemError(
            422,
            'workflow-precondition',
            'a close date and commitment are required to open closing',
          );
        details.closing = await this.openClosing(
          tx,
          audit,
          locked,
          closing,
          body.closeDate,
          body.commitmentAmount,
        );
      } else if (from === 'Closing' && to === 'Closed') {
        if (closing?.summary.state !== 'OpsConfirmed')
          throw new ProblemError(
            422,
            'workflow-precondition',
            'the closing is not confirmed by operations (M8)',
          );
        const created = await this.convert(tx, audit, locked, closing);
        patch.investmentId = created.investmentId;
        details.created = created;
      }
      if (to === 'Diligence')
        details.diligenceTasksCreated = await createTemplateTasks(
          tx,
          audit,
          { id, dealType: locked.dealType, ownerId: locked.ownerId },
          this.templates,
        );

      const updated = await tx
        .update(opp)
        .set(patch)
        .where(and(eq(opp.id, id), eq(opp.stage, from), eq(opp.rowVersion, locked.rowVersion)))
        .returning();
      if (updated[0] === undefined) throw conflict('opportunity');
      await tx.insert(history).values({
        opportunityId: id,
        fromStage: from,
        toStage: to,
        command: body.command,
        reason: reason ?? null,
        changedBy: principal.userId,
      });
      await audit({
        action: `opportunity.${body.command}`,
        entity: ENTITY,
        entityId: id,
        ...(reason !== undefined ? { reason } : {}),
        details,
      });
      return this.loadDetail(tx, id);
    });
  }

  /** A task beside the template ones (deal team). */
  async createTask(
    principal: Principal,
    requestId: string,
    id: string,
    body: DiligenceTaskCreateBody,
  ): Promise<OpportunityDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = await lockOpportunity(tx, id);
      await createTask(tx, audit, locked.id, body);
      return this.loadDetail(tx, id);
    });
  }

  /** complete, waive or reopen one task of the opportunity. */
  async taskCommand(
    principal: Principal,
    requestId: string,
    id: string,
    taskId: string,
    body: DiligenceTaskCommandBody,
  ): Promise<OpportunityDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = await lockOpportunity(tx, id);
      await taskCommand(tx, audit, locked.id, taskId, body);
      return this.loadDetail(tx, id);
    });
  }

  /** The committee's decision, recorded by an approver while the deal is at IC. */
  async recordIcDecision(
    principal: Principal,
    requestId: string,
    id: string,
    body: IcDecisionBody,
  ): Promise<OpportunityDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = await lockOpportunity(tx, id);
      await recordDecision(tx, audit, locked, body, principal.userId);
      return this.loadDetail(tx, id);
    });
  }

  /** The whole allocation list at once (M22): what is sent replaces what was there. */
  async putAllocations(
    principal: Principal,
    requestId: string,
    id: string,
    body: AllocationsPutBody,
  ): Promise<OpportunityDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = await lockOpportunity(tx, id);
      await replaceAllocations(tx, audit, locked, body);
      return this.loadDetail(tx, id);
    });
  }

  /** The detail from the rows the caller can see; the gates are computed from the same rows the machine reads. */
  private async loadDetail(tx: Tx, id: string): Promise<OpportunityDetail> {
    const row = (await loadOpportunities(tx, { where: eq(opp.id, id), limit: 1 }))[0];
    if (row === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
    const stageHistory = await loadStageHistory(tx, id);
    const diligenceTasks = await loadTasks(tx, id);
    const icDecisions = await loadIcDecisions(tx, id);
    const allocations = await loadAllocationRows(tx, allocationsOf(id, row.investmentId));
    const closing = await loadClosingView(tx, eq(closingTable.opportunityId, id), this.checklist);
    const gate = await diligenceGate(tx, id);
    const icApproved = await latestDecisionApproved(tx, id);
    const checklistComplete = closing !== null && requiredItemsComplete(closing.items);
    const allocationTiedOut = closing?.summary.allocationTieOut.tiedOut === true;
    const gates: OpportunityGates = {
      diligence: { requiredOpen: gate.requiredOpen, ok: gate.ok },
      icDecision: { ok: icApproved },
      closing: {
        checklistComplete,
        allocationTiedOut,
        ok:
          closing !== null &&
          closing.summary.state === 'OpsConfirmed' &&
          checklistComplete &&
          allocationTiedOut,
      },
    };
    return {
      ...toOpportunityRow(row, this.adapters.clock.today()),
      source: row.source,
      passNote: row.passNote,
      stageHistory,
      diligenceTasks,
      icDecisions,
      allocations,
      closing: closing?.summary ?? null,
      gates,
    };
  }

  /**
   * The closing record opened by Approved > Closing (docs/18 section 12): Open, with the close
   * date and commitment given and one item per entry of config/closing_checklist.json. A deal
   * that reaches Closing again (passed and reopened) keeps the record it had, with the new date
   * and commitment written and audited.
   */
  private async openClosing(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    locked: LockedOpportunity,
    existing: ClosingView | null,
    closeDate: string,
    commitmentAmount: string,
  ): Promise<Record<string, unknown>> {
    if (existing !== null) {
      await tx
        .update(closingTable)
        .set({ closeDate, commitmentAmount })
        .where(eq(closingTable.id, existing.closing.id));
      await audit({
        action: 'closing.reuse',
        entity: 'deal.closing',
        entityId: existing.closing.id,
        details: {
          opportunityId: locked.id,
          closeDate: { before: existing.closing.closeDate, after: closeDate },
          commitmentAmount: { before: existing.closing.commitmentAmount, after: commitmentAmount },
        },
      });
      return { id: existing.closing.id, closeDate, commitmentAmount, items: existing.items.length };
    }
    const inserted = (
      await tx
        .insert(closingTable)
        .values({
          opportunityId: locked.id,
          investmentId: null,
          closeDate,
          commitmentAmount,
          currency: locked.currency,
          state: 'Open',
        })
        .returning()
    )[0];
    if (inserted === undefined)
      throw new ProblemError(500, 'internal', 'closing: the record was not written');
    await tx.insert(closingItem).values(
      this.checklist.items.map((i) => ({
        closingId: inserted.id,
        itemCode: i.code,
        label: i.label,
        required: i.required,
        status: 'open',
      })),
    );
    await audit({
      action: 'closing.open',
      entity: 'deal.closing',
      entityId: inserted.id,
      details: {
        opportunityId: locked.id,
        closeDate,
        commitmentAmount,
        items: this.checklist.items.map((i) => i.code),
      },
    });
    return { id: inserted.id, closeDate, commitmentAmount, items: this.checklist.items.length };
  }

  /**
   * Closing > Closed: the closing is locked so a close-date change cannot slip in, the position is
   * created from the deal as captured, and the closing, its legal terms and the allocation lines
   * are stamped with the position so they follow it (M22).
   */
  private async convert(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    locked: LockedOpportunity,
    view: ClosingView,
  ): Promise<Conversion> {
    const lockedClosing = (
      await tx
        .select({
          id: closingTable.id,
          state: closingTable.state,
          closeDate: closingTable.closeDate,
          currency: closingTable.currency,
        })
        .from(closingTable)
        .where(eq(closingTable.id, view.closing.id))
        .for('update')
    )[0];
    if (lockedClosing?.state !== 'OpsConfirmed')
      throw new ProblemError(
        422,
        'workflow-precondition',
        'the closing is not confirmed by operations (M8)',
      );
    const created = await convertToInvestment(
      tx,
      audit,
      locked,
      {
        id: lockedClosing.id,
        closeDate: lockedClosing.closeDate,
        currency: lockedClosing.currency,
      },
      view.allocations,
    );
    await tx
      .update(closingTable)
      .set({ investmentId: created.investmentId })
      .where(eq(closingTable.id, lockedClosing.id));
    await tx
      .update(schema.legalTerm)
      .set({ investmentId: created.investmentId })
      .where(eq(schema.legalTerm.closingId, lockedClosing.id));
    await tx
      .update(schema.allocation)
      .set({ investmentId: created.investmentId })
      .where(eq(schema.allocation.opportunityId, locked.id));
    return created;
  }
}
