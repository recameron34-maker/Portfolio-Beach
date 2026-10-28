import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import type {
  ClosingChecklist,
  ClosingCommandBody,
  ClosingDetail,
  ClosingItemCommandBody,
  ClosingState,
  LegalTermCommandBody,
  LegalTermCreateBody,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { attempt, closingMachine } from '@pb/workflows';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { requireIfMatch } from '../common/row-version.js';
import { ADAPTERS, CLOSING_CHECKLIST } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import { allocationsOf, loadAllocationRows, tieOut } from '../pipeline/allocations.js';
import { requireTaxonomyCodes, requireVisibleDocument } from '../pipeline/refs.js';
import {
  CLOSING_ENTITY,
  CLOSING_NOT_FOUND,
  closingStateOf,
  loadClosingItems,
  loadClosingView,
  requiredItemsComplete,
} from './summary.js';

/*
 * The closing workflow (docs/04 M8, docs/18 section 12, decision 0013): the record the deal team
 * hands to operations, its required-document checklist, the operations confirmation and the
 * audited close-date change, plus the legal terms captured at close (M22). A command locks the
 * closing, reads the gates from the same rows the detail shows, runs closingMachine for the role,
 * the transition and the preconditions, writes with a guard on the state and row version it read
 * and audits the change with the values before and after. The close date on this record is the
 * single source of every close date (the investment detail reads it from here). Anything the
 * caller cannot see is 404: the closing follows its opportunity's wall.
 */

const closing = schema.closing;
const item = schema.closingItem;
const term = schema.legalTerm;
const ITEM_NOT_FOUND = 'Closing item not found';
const TERM_NOT_FOUND = 'Legal term not found';
const ITEM_CODE = /^[a-z0-9_]{1,64}$/;

/** The status moves an item command makes; a command from any other status is a 409. */
const ITEM_MOVES: Record<
  ClosingItemCommandBody['command'],
  { from: readonly string[]; to: string }
> = {
  receive: { from: ['open', 'waived'], to: 'received' },
  waive: { from: ['open'], to: 'waived' },
  reopen: { from: ['received', 'waived'], to: 'open' },
};

/** The closing as a command locks it: the columns the command reads and guards on. */
interface LockedClosing {
  id: string;
  opportunityId: string;
  investmentId: string | null;
  closeDate: string;
  commitmentAmount: string;
  state: string;
  opsConfirmedBy: string | null;
  rowVersion: number;
}

const conflict = (what: string): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    `${what}: another command changed the record first; open it again`,
  );

@Injectable()
export class ClosingService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(CLOSING_CHECKLIST) private readonly checklist: ClosingChecklist,
  ) {}

  /** One closing with its checklist, legal terms and allocation tie-out; 404 when the caller cannot see it. The open is audited. */
  async detail(principal: Principal, requestId: string, id: string): Promise<ClosingDetail> {
    requireUuid(id, CLOSING_NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const detail = await this.loadDetail(tx, id);
      await audit({ action: 'closing.read', entity: CLOSING_ENTITY, entityId: id });
      return detail;
    });
  }

  /** receive (with the hub document), waive (with a reason) or reopen one checklist item. */
  async itemCommand(
    principal: Principal,
    requestId: string,
    id: string,
    itemCode: string,
    body: ClosingItemCommandBody,
  ): Promise<ClosingDetail> {
    requireUuid(id, CLOSING_NOT_FOUND);
    if (!ITEM_CODE.test(itemCode)) throw new ProblemError(404, 'not-found', ITEM_NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      await this.read(tx, id, false);
      const locked = (
        await tx
          .select({
            id: item.id,
            status: item.status,
            required: item.required,
            documentId: item.documentId,
          })
          .from(item)
          .where(and(eq(item.closingId, id), eq(item.itemCode, itemCode)))
          .for('update')
      )[0];
      if (locked === undefined) throw new ProblemError(404, 'not-found', ITEM_NOT_FOUND);
      const move = ITEM_MOVES[body.command];
      if (!move.from.includes(locked.status))
        throw new ProblemError(
          409,
          'workflow-transition',
          `closing item: ${body.command} is not allowed from ${locked.status}`,
        );
      const patch: Partial<typeof item.$inferInsert> = { status: move.to };
      if (body.command === 'receive') {
        await requireVisibleDocument(tx, body.documentId, 'documentId');
        patch.documentId = body.documentId;
        patch.waivedReason = null;
      } else if (body.command === 'waive') {
        patch.waivedReason = body.reason;
        patch.documentId = null;
      } else {
        patch.waivedReason = null;
        patch.documentId = null;
      }
      const updated = await tx
        .update(item)
        .set(patch)
        .where(and(eq(item.id, locked.id), eq(item.status, locked.status)))
        .returning();
      if (updated[0] === undefined) throw conflict('closing item');
      await audit({
        action: `closing_item.${body.command}`,
        entity: 'deal.closing_item',
        entityId: locked.id,
        ...(body.command === 'waive' ? { reason: body.reason } : {}),
        details: {
          closingId: id,
          itemCode,
          required: locked.required,
          status: { before: locked.status, after: move.to },
          documentId: { before: locked.documentId, after: patch.documentId ?? null },
        },
      });
      return this.loadDetail(tx, id);
    });
  }

  /**
   * confirm (operations, once every required item is in and the allocations tie out) and
   * changeCloseDate (operations, with a reason). After confirmation the date change returns the
   * record to Open through the machine, so operations confirm again (docs/04 M8); while the
   * closing is still Open the table has no Open to Open row, so the same command is a plain,
   * audited date change with no state move. If-Match, when sent, is checked against the row
   * version read under lock.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: ClosingCommandBody,
    ifMatch: string | undefined,
  ): Promise<ClosingDetail> {
    requireUuid(id, CLOSING_NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = await this.read(tx, id, true);
      requireIfMatch(ifMatch, locked.rowVersion);
      const from = closingStateOf(locked.state);
      const items = await loadClosingItems(tx, id, this.checklist);
      const allocations = await loadAllocationRows(
        tx,
        allocationsOf(locked.opportunityId, locked.investmentId),
      );
      const tie = tieOut(locked.commitmentAmount, allocations);

      if (body.command === 'changeCloseDate' && from === 'Open') {
        await this.claim(tx, locked, from, { closeDate: body.closeDate });
        await audit({
          action: 'closing.changeCloseDate',
          entity: CLOSING_ENTITY,
          entityId: id,
          reason: body.reason,
          details: {
            state: { before: from, after: from },
            closeDate: { before: locked.closeDate, after: body.closeDate },
          },
        });
        return this.loadDetail(tx, id);
      }

      const result = attempt(closingMachine, from, body.command, {
        actorId: principal.userId,
        actorRoles: principal.roles,
        ...(body.command === 'changeCloseDate' ? { reason: body.reason } : {}),
        record: {
          requiredItemsComplete: requiredItemsComplete(items),
          allocationTiedOut: tie.tiedOut,
        },
      });
      if (!result.ok) throw workflowProblem(result);

      if (body.command === 'confirm') {
        await this.claim(tx, locked, from, {
          state: result.to,
          opsConfirmedBy: principal.userId,
          opsConfirmedAt: new Date(this.adapters.clock.now()),
          reopenReason: null,
        });
        await audit({
          action: 'closing.confirm',
          entity: CLOSING_ENTITY,
          entityId: id,
          details: {
            state: { before: from, after: result.to },
            closeDate: locked.closeDate,
            commitmentAmount: locked.commitmentAmount,
            allocationTieOut: tie,
            itemsRequiredOpen: items.filter((i) => i.required && i.status === 'open').length,
            opsConfirmedBy: { before: locked.opsConfirmedBy, after: principal.userId },
          },
        });
      } else {
        await this.claim(tx, locked, from, {
          state: result.to,
          closeDate: body.closeDate,
          reopenReason: body.reason,
          opsConfirmedBy: null,
          opsConfirmedAt: null,
        });
        await audit({
          action: 'closing.changeCloseDate',
          entity: CLOSING_ENTITY,
          entityId: id,
          reason: body.reason,
          details: {
            state: { before: from, after: result.to },
            closeDate: { before: locked.closeDate, after: body.closeDate },
            opsConfirmedBy: { before: locked.opsConfirmedBy, after: null },
          },
        });
      }
      return this.loadDetail(tx, id);
    });
  }

  /** A structured term in draft (M22), typed by the legal_term_type taxonomy, with its source document when known. */
  async createLegalTerm(
    principal: Principal,
    requestId: string,
    id: string,
    body: LegalTermCreateBody,
  ): Promise<ClosingDetail> {
    requireUuid(id, CLOSING_NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = await this.read(tx, id, false);
      await requireTaxonomyCodes(tx, [{ code: body.termType, path: 'termType' }]);
      if (body.sourceDocumentId !== undefined)
        await requireVisibleDocument(tx, body.sourceDocumentId, 'sourceDocumentId');
      const inserted = (
        await tx
          .insert(term)
          .values({
            closingId: id,
            investmentId: locked.investmentId,
            termType: body.termType,
            value: body.value,
            sourceDocumentId: body.sourceDocumentId ?? null,
            status: 'draft',
          })
          .returning()
      )[0];
      if (inserted === undefined)
        throw new ProblemError(500, 'internal', 'legal term: the record was not written');
      await audit({
        action: 'legal_term.create',
        entity: 'deal.legal_term',
        entityId: inserted.id,
        details: {
          closingId: id,
          termType: body.termType,
          value: { before: null, after: body.value },
          sourceDocumentId: body.sourceDocumentId ?? null,
        },
      });
      return this.loadDetail(tx, id);
    });
  }

  /** confirm: the term as captured is checked against its source; a confirmed term is not confirmed again. */
  async legalTermCommand(
    principal: Principal,
    requestId: string,
    id: string,
    termId: string,
    body: LegalTermCommandBody,
  ): Promise<ClosingDetail> {
    requireUuid(id, CLOSING_NOT_FOUND);
    requireUuid(termId, TERM_NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      await this.read(tx, id, false);
      const locked = (
        await tx
          .select({ id: term.id, status: term.status, termType: term.termType, value: term.value })
          .from(term)
          .where(and(eq(term.id, termId), eq(term.closingId, id)))
          .for('update')
      )[0];
      if (locked === undefined) throw new ProblemError(404, 'not-found', TERM_NOT_FOUND);
      if (locked.status !== 'draft')
        throw new ProblemError(
          409,
          'workflow-transition',
          `legal term: ${body.command} is not allowed from ${locked.status}`,
        );
      const updated = await tx
        .update(term)
        .set({
          status: 'confirmed',
          confirmedBy: principal.userId,
          confirmedAt: new Date(this.adapters.clock.now()),
        })
        .where(and(eq(term.id, termId), eq(term.status, 'draft')))
        .returning();
      if (updated[0] === undefined) throw conflict('legal term');
      await audit({
        action: 'legal_term.confirm',
        entity: 'deal.legal_term',
        entityId: termId,
        details: {
          closingId: id,
          termType: locked.termType,
          status: { before: locked.status, after: 'confirmed' },
          value: locked.value,
        },
      });
      return this.loadDetail(tx, id);
    });
  }

  private async loadDetail(tx: Tx, id: string): Promise<ClosingDetail> {
    const view = await loadClosingView(tx, eq(closing.id, id), this.checklist);
    if (view === null) throw new ProblemError(404, 'not-found', CLOSING_NOT_FOUND);
    if (view.closing.opportunityId === null)
      throw new ProblemError(404, 'not-found', CLOSING_NOT_FOUND);
    return {
      ...view.summary,
      opportunityId: view.closing.opportunityId,
      investmentId: view.closing.investmentId,
      items: view.items,
      legalTerms: view.legalTerms,
      allocations: view.allocations,
      rowVersion: view.closing.rowVersion,
    };
  }

  /**
   * The closing as a command reads it; 404 when the caller cannot see it or it names no
   * opportunity. The closing's own commands lock the row (operations, who may update it); the
   * item and legal term commands only read it, since a row lock passes through the update policy
   * and the deal team, who may write items and terms, may not update the closing itself.
   */
  private async read(tx: Tx, id: string, lock: boolean): Promise<LockedClosing> {
    const query = tx
      .select({
        id: closing.id,
        opportunityId: closing.opportunityId,
        investmentId: closing.investmentId,
        closeDate: closing.closeDate,
        commitmentAmount: closing.commitmentAmount,
        state: closing.state,
        opsConfirmedBy: closing.opsConfirmedBy,
        rowVersion: closing.rowVersion,
      })
      .from(closing)
      .where(eq(closing.id, id))
      .$dynamic();
    const found = (await (lock ? query.for('update') : query))[0];
    if (found === undefined) throw new ProblemError(404, 'not-found', CLOSING_NOT_FOUND);
    if (found.opportunityId === null) throw new ProblemError(404, 'not-found', CLOSING_NOT_FOUND);
    return { ...found, opportunityId: found.opportunityId };
  }

  /** The one write of a command, guarded on the state and row version read under lock. */
  private async claim(
    tx: Tx,
    locked: LockedClosing,
    from: ClosingState,
    patch: Partial<
      Pick<
        typeof closing.$inferInsert,
        'state' | 'closeDate' | 'opsConfirmedBy' | 'opsConfirmedAt' | 'reopenReason'
      >
    >,
  ): Promise<void> {
    const updated = await tx
      .update(closing)
      .set(patch)
      .where(
        and(
          eq(closing.id, locked.id),
          eq(closing.state, from),
          eq(closing.rowVersion, locked.rowVersion),
        ),
      )
      .returning();
    if (updated[0] === undefined) throw conflict('closing');
  }
}
