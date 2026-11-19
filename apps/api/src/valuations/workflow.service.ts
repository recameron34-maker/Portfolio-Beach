import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte, max } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { D, addDays, alignedQuarterEnd, isQuarterEnd } from '@pb/calc';
import {
  API_PREFIX,
  ROUTES,
  valuationApprovalDecision,
  valuationApprovalStep,
  valuationLockText,
  valuationState,
  valuationStoredInputs,
} from '@pb/contracts';
import type {
  ValuationBatchCommandBody,
  ValuationBatchResult,
  ValuationCommandBody,
  ValuationCreateBody,
  ValuationDetail,
  ValuationEditBody,
  ValuationRow,
  ValuationState,
  ValuationStoredInputs,
} from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import {
  VALUATION_IN_FLIGHT_STATES,
  attempt,
  keepSuggestionKeys,
  sourceReviewersOf,
  valuationMachine,
} from '@pb/workflows';
import { valuationLockHash } from '../common/lock.js';
import { isUniqueViolationOn } from '../common/pg-errors.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { requireFreshRow } from '../common/row-version.js';
import { ADAPTERS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';
import { openChangeRequestsFor } from '../change-requests/queries.js';
import { SuggestionDerivationService } from '../suggestions/derivation.service.js';
import { ValuationsService } from './valuations.service.js';

/*
 * The valuation workflow (docs/04 M10, docs/18 section 1, decision 0013): one controlled
 * valuation per investment and quarter, moved through valuationMachine only. Operations starts a
 * Draft version and prepares it; the deal team approves it (never the preparer); an approver
 * locks it with the hash over the identity, the method, the inputs and the value (SEC-5.6,
 * SEC-9.3); a Locked version never changes in place (the guard trigger of migration 0004
 * enforces it below the API), so a correction reopens it into a new Draft version and alerts the
 * prior approvers through ops.task; operations then edits that Draft (the method, the value, the
 * inputs) before preparing it, and only a Draft can be edited. Reports read Locked versions only
 * (portfolio/metrics.ts latestLockedValuation), which the reporting gate test proves. Every
 * command locks the row for the transaction, guards its write on the state and row version it
 * read (409 when another command got there first, 412 when the caller's If-Match is stale),
 * writes one mon.valuation_approval row and one audit event with the state before and after
 * (SEC-11.1); an edit writes its audit event with the values before and after and no approval
 * row, since it approves nothing. Anything the caller cannot see is 404.
 *
 * A valuation suggestion (docs/18 section 14, decision 0023) never writes a mark by itself: its
 * accept opens a Draft through createDraft and its applyToDraft corrects the open Draft through
 * editDraft, the same two writes the create and the edit of this service make, inside the
 * suggestion command's own transaction. The keys a suggestion leaves on a Draft's inputs
 * (`suggestion.`) say where the value came from: a create or an edit sent by a person can
 * neither forge, change nor drop them, so the lock hash seals them with the mark. Whoever
 * approved a run behind a suggestion accepted onto a version, or typed one of its figures, can
 * take neither approval of that version nor of a later version of the same quarter, which a
 * reopen starts with the same mark (the machine's sourceReviewers).
 */

const valuation = schema.valuation;
const approval = schema.valuationApproval;
const NOT_FOUND = 'Valuation not found';
const ENTITY = 'mon.valuation';
/** The states a version is still being worked in: one chain per investment and quarter. */
const IN_FLIGHT = VALUATION_IN_FLIGHT_STATES;
/** A core.taxonomy_term code of the valuation_method domain. */
const METHOD_CODE = /^valuation_method\.[a-z0-9_]+$/;
/** The unique key of mon.valuation (migration 0004): one row per investment, period end and version. */
const VERSION_KEY = 'valuation_investment_id_period_end_version_key';
/**
 * The roles the change request routes serve, read from the contract's route table: the valuation
 * screen lists a position's open requests for these roles only, so it never shows a viewer or
 * investor relations what GET /change-requests refuses them.
 */
const CHANGE_REQUEST_READERS: readonly string[] =
  ROUTES.find((r) => r.method === 'GET' && r.path === `${API_PREFIX}/change-requests`)?.roles ?? [];

/** The version as locked for a command: every column the commands read, guard on or copy. */
interface LockedVersion {
  id: string;
  investmentId: string;
  periodEnd: string;
  version: number;
  method: string;
  inputs: unknown;
  fairValue: string;
  currency: string;
  state: string;
  lockHash: string | null;
  preparedBy: string | null;
  dealTeamApprovedBy: string | null;
  approvedBy: string | null;
  reopenReason: string | null;
  rowVersion: number;
}

const LOCKED_COLUMNS = {
  id: valuation.id,
  investmentId: valuation.investmentId,
  periodEnd: valuation.periodEnd,
  version: valuation.version,
  method: valuation.method,
  inputs: valuation.inputs,
  fairValue: valuation.fairValue,
  currency: valuation.currency,
  state: valuation.state,
  lockHash: valuation.lockHash,
  preparedBy: valuation.preparedBy,
  dealTeamApprovedBy: valuation.dealTeamApprovedBy,
  approvedBy: valuation.approvedBy,
  reopenReason: valuation.reopenReason,
  rowVersion: valuation.rowVersion,
};

/** A refusal of a create or a command on its preconditions (422), in the machine's wording. */
const precondition = (detail: string): ProblemError =>
  new ProblemError(422, 'workflow-precondition', detail);

/** The problem when a command finds the version already changed by another command. */
const conflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'valuation: another command changed the version first; open it again',
  );

/**
 * The problem when two writers raced for one version number: both read the same highest version
 * and the unique key of mon.valuation refused the second insert. The caller can act on it (the
 * list now shows the other version), so it is a 409 and not an error: nothing of the failed
 * insert, whose parameters carry the fair value, reaches a log line (SEC-11.4).
 */
const versionTaken = (): ProblemError =>
  new ProblemError(
    409,
    'workflow-transition',
    'valuation: another version was created first; open the list again',
  );

/** True for the unique violation of two writers racing for one version number of mon.valuation. */
export const isVersionRace = (error: unknown): boolean => isUniqueViolationOn(error, VERSION_KEY);

/** The 409 a version race answers: nothing of the failed insert was written. */
export const versionRaceProblem = versionTaken;

/** Where a Draft or its correction came from, for the audit event: a suggestion a person accepted. */
export interface DraftOrigin {
  suggestionId: string;
}

/** A valuation_method code by its shape; whether the taxonomy carries it is checked in the transaction. */
function requireMethodCode(method: string): void {
  if (!METHOD_CODE.test(method))
    throw new ProblemError(400, 'validation', 'Invalid body', [
      { path: 'method', message: 'Not a valuation_method code' },
    ]);
}

@Injectable()
export class ValuationWorkflowService {
  constructor(
    private readonly db: DbService,
    private readonly board: ValuationsService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    private readonly suggestions: SuggestionDerivationService,
  ) {}

  /**
   * The "(new) to Draft" row of docs/18 section 1. The investment must be visible and active
   * (404 otherwise, never a hint that it exists), the period end a quarter end or within the
   * tolerance of one (the quarter the version reports for, alignedQuarterEnd), on or after the
   * entry date; the fair value above zero and the method a valuation_method code on the taxonomy.
   * One chain per investment and quarter: a Locked version must be reopened first and a version
   * in progress continued. The version number follows the period end's highest; when another
   * writer takes that number first the unique key refuses the insert and the answer is 409, never
   * a 500. The fair value is one the column stores exactly as sent (the contract's positiveMoney),
   * and the audit event records the method and the value read back from the row written. Nobody
   * has prepared the Draft yet (prepared_by stays null until the prepare command), so whoever
   * starts it on the board may still be the one who prepares it.
   */
  async create(
    principal: Principal,
    requestId: string,
    body: ValuationCreateBody,
  ): Promise<ValuationRow> {
    this.requireCreatable(body);
    return this.unlessVersionTaken(principal, requestId, (tx, audit) =>
      // A person's own inputs: a key a suggestion would write is not theirs to send.
      this.createDraft(tx, audit, { ...body, inputs: keepSuggestionKeys({}, body.inputs ?? {}) }),
    );
  }

  /** What a create is refused for before anything is read: the period end, the value and the method's shape. */
  private requireCreatable(body: ValuationCreateBody): { quarterEnd: string; tolerance: number } {
    const tolerance = this.board.tolerance();
    const quarterEnd = alignedQuarterEnd(body.periodEnd, tolerance);
    if (quarterEnd === body.periodEnd && !isQuarterEnd(body.periodEnd))
      throw precondition(
        `valuation: the period end must be a quarter end or within ${tolerance} days of one`,
      );
    if (!D(body.fairValue).gt(0))
      throw new ProblemError(400, 'validation', 'Invalid body', [
        { path: 'fairValue', message: 'Must be above zero' },
      ]);
    requireMethodCode(body.method);
    return { quarterEnd, tolerance };
  }

  /**
   * The one write of a Draft version (the "(new) to Draft" row), in the transaction given and
   * under the identity it holds: the create above, and the accept of a valuation suggestion
   * (docs/18 section 14), which names the suggestion as the Draft's origin. The inputs are
   * stored as given: the caller decides which keys a Draft may start with. A caller that opens
   * its own transaction answers a version race with isVersionRace and versionRaceProblem.
   */
  async createDraft(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    body: ValuationCreateBody,
    origin?: DraftOrigin,
  ): Promise<ValuationRow> {
    const { quarterEnd, tolerance } = this.requireCreatable(body);
    const position = (
      await tx
        .select({
          id: schema.investment.id,
          investmentNumber: schema.investment.investmentNumber,
          isActive: schema.investment.isActive,
          entryDate: schema.investment.entryDate,
        })
        .from(schema.investment)
        .where(eq(schema.investment.id, body.investmentId))
    )[0];
    if (!position?.isActive) throw new ProblemError(404, 'not-found', 'Investment not found');
    await this.requireMethod(tx, body.method);
    if (body.periodEnd < position.entryDate)
      throw precondition('valuation: the investment was not yet held at this period end');

    const chain = await this.sameQuarter(tx, body.investmentId, quarterEnd, tolerance);
    if (chain.some((v) => v.state === 'Locked'))
      throw precondition(
        'valuation: a Locked version exists for this investment and quarter; reopen it to start a new version',
      );
    if (chain.some((v) => IN_FLIGHT.includes(v.state)))
      throw precondition(
        'valuation: a version for this investment and quarter is already in progress; continue that version',
      );

    const version = await this.nextVersion(tx, body.investmentId, body.periodEnd);
    const inserted = (
      await tx
        .insert(valuation)
        .values({
          investmentId: body.investmentId,
          periodEnd: body.periodEnd,
          version,
          method: body.method,
          inputs: body.inputs ?? {},
          fairValue: body.fairValue,
          currency: 'USD',
          state: 'Draft',
          preparedBy: null,
        })
        .returning()
    )[0];
    if (inserted === undefined) throw precondition('valuation: the Draft was not written');
    // The method and the value are read back from the row written, never from the body (rule 6).
    await audit({
      action: 'valuation.create',
      entity: ENTITY,
      entityId: inserted.id,
      details: {
        investmentId: inserted.investmentId,
        investmentNumber: position.investmentNumber,
        periodEnd: inserted.periodEnd,
        quarterEnd,
        version: inserted.version,
        method: inserted.method,
        fairValue: inserted.fairValue,
        state: { before: null, after: 'Draft' },
        ...(origin === undefined ? {} : { fromSuggestion: origin.suggestionId }),
      },
    });
    return this.rowOrThrow(tx, inserted.id);
  }

  /**
   * The correction of a Draft (docs/18 section 1, SEC-9.3): operations changes any of the method,
   * the fair value and the method inputs before the version is prepared, which is how a reopened
   * valuation comes to carry a corrected value (the new Draft starts as a copy of the locked
   * one). Only a Draft can be edited: a version that is prepared, approved, Locked or Reopened
   * answers 409 and keeps every value (an OpsPrepared one is sent back first; a Locked one is
   * reopened). The row is locked for the transaction, an If-Match naming another row version is
   * 412, and the write guards on the state and the row version read. Inputs replace the stored
   * ones whole. It moves no state and approves nothing, so it writes no approval row; the audit
   * event carries the method, the value and the inputs before and after, read back from the row.
   */
  async edit(
    principal: Principal,
    requestId: string,
    id: string,
    body: ValuationEditBody,
    ifMatch?: readonly number[],
  ): Promise<ValuationRow> {
    requireUuid(id, NOT_FOUND);
    if (body.method !== undefined) requireMethodCode(body.method);
    return this.db.run(principal, requestId, (tx, audit) =>
      this.editDraft(
        tx,
        audit,
        id,
        (stored) => ({
          ...(body.method !== undefined ? { method: body.method } : {}),
          ...(body.fairValue !== undefined ? { fairValue: body.fairValue } : {}),
          // The keys a suggestion left stay as stored, whatever the body sends for them.
          ...(body.inputs !== undefined ? { inputs: keepSuggestionKeys(stored, body.inputs) } : {}),
        }),
        ifMatch,
      ),
    );
  }

  /**
   * The one write of a Draft's correction, in the transaction given: the edit above, and the
   * applyToDraft of a valuation suggestion (docs/18 section 14), which puts its value, its
   * method and its keys on the Draft and names itself as the origin. `change` is handed the
   * inputs the Draft stores and answers what to write; the Draft keeps its period end.
   */
  async editDraft(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    id: string,
    change: (stored: ValuationStoredInputs) => {
      method?: string;
      fairValue?: string;
      inputs?: ValuationStoredInputs;
    },
    ifMatch?: readonly number[],
    origin?: DraftOrigin,
  ): Promise<ValuationRow> {
    const locked = (
      await tx.select(LOCKED_COLUMNS).from(valuation).where(eq(valuation.id, id)).for('update')
    )[0];
    if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
    requireFreshRow(ifMatch, locked.rowVersion, 'valuation');
    const from = this.stateOf(locked);
    if (from !== 'Draft')
      throw new ProblemError(
        409,
        'workflow-transition',
        `valuation: edit is not allowed from ${from}; only a Draft can be edited`,
      );
    const position = (
      await tx
        .select({ investmentNumber: schema.investment.investmentNumber })
        .from(schema.investment)
        .where(eq(schema.investment.id, locked.investmentId))
    )[0];
    if (position === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
    const patch = change(this.storedInputs(locked.inputs));
    if (patch.method !== undefined) await this.requireMethod(tx, patch.method);

    const written = await this.claim(tx, locked, from, patch);
    await audit({
      action: 'valuation.edit',
      entity: ENTITY,
      entityId: locked.id,
      details: {
        investmentId: locked.investmentId,
        investmentNumber: position.investmentNumber,
        periodEnd: locked.periodEnd,
        version: locked.version,
        state: { before: from, after: from },
        method: { before: locked.method, after: written.method },
        fairValue: { before: locked.fairValue, after: written.fairValue },
        inputs: { before: locked.inputs, after: written.inputs },
        ...(origin === undefined ? {} : { fromSuggestion: origin.suggestionId }),
      },
    });
    return this.rowOrThrow(tx, locked.id);
  }

  /**
   * One version with its stored method inputs, its approval trail (joined names), the open
   * change requests of its investment (M11) and, once Locked, the exact text its hash covers: the
   * identity, the method, the stored inputs and the value. The inputs are returned in every
   * state, an empty record when the version has none, so the edit of a Draft starts from them (a
   * PATCH replaces them whole) and whoever approves sees what the lock will cover before it is
   * taken. The requests are listed for the roles the change request routes serve and are an empty
   * list for everyone else, so this screen shows nobody what those routes refuse them. 404 for a
   * version the caller cannot see; a successful open is audited (SEC-11.1).
   */
  async detail(principal: Principal, requestId: string, id: string): Promise<ValuationDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const row = await this.board.rowById(tx, id);
      if (row === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      const trail = await tx
        .select({
          id: approval.id,
          step: approval.step,
          decision: approval.decision,
          actorId: approval.approverId,
          actorName: schema.appUser.displayName,
          at: approval.at,
          reason: approval.comment,
        })
        .from(approval)
        .innerJoin(schema.appUser, eq(schema.appUser.id, approval.approverId))
        .where(eq(approval.valuationId, id))
        .orderBy(asc(approval.at), asc(approval.createdAt), asc(approval.id));
      const openChangeRequests = principal.roles.some((role) =>
        CHANGE_REQUEST_READERS.includes(role),
      )
        ? await openChangeRequestsFor(tx, row.investmentId)
        : [];
      // The board row carries no inputs: they are read beside it, for the screen and for the
      // lock text, which is taken over the ones the hash covers.
      const inputs = await this.inputsOf(tx, id);
      const lockText = row.state === 'Locked' ? valuationLockText({ ...row, inputs }) : null;
      await audit({ action: 'valuation.read', entity: ENTITY, entityId: id });
      return {
        ...row,
        inputs,
        approvals: trail.map((a) => ({
          id: a.id,
          step: valuationApprovalStep.parse(a.step),
          decision: valuationApprovalDecision.parse(a.decision),
          actorId: a.actorId,
          actorName: a.actorName,
          at: a.at.toISOString(),
          reason: a.reason,
        })),
        openChangeRequests,
        lockText,
      };
    });
  }

  /**
   * One command through valuationMachine on one version (docs/18 section 1). The row stays locked
   * until the transaction ends; the write guards on the state and the row version it read and
   * answers 409 when they no longer hold; an If-Match naming another row version is 412 before
   * anything is tried. prepare records the preparer; sendBack returns the version to Draft with
   * the reason; dealTeamApprove records the deal team approver (never the preparer: the machine
   * refuses and the table's check refuses again); lock records the approver, the time and the
   * hash over the lock text (SEC-5.6, SEC-9.3) and keeps one Locked version per investment and
   * quarter; reopen marks the Locked version Reopened with its reason (the one update the guard
   * trigger allows), starts the next version as a Draft with the same method, inputs and value,
   * and opens an ops.task for each prior approver who is not the actor; its answer is that new
   * Draft. Every command writes one approval row and one audit event with before and after.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: ValuationCommandBody,
    ifMatch?: readonly number[],
  ): Promise<ValuationRow> {
    requireUuid(id, NOT_FOUND);
    return this.unlessVersionTaken(principal, requestId, async (tx, audit) => {
      const locked = (
        await tx.select(LOCKED_COLUMNS).from(valuation).where(eq(valuation.id, id)).for('update')
      )[0];
      if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
      requireFreshRow(ifMatch, locked.rowVersion, 'valuation');
      const from = this.stateOf(locked);
      const position = (
        await tx
          .select({ investmentNumber: schema.investment.investmentNumber })
          .from(schema.investment)
          .where(eq(schema.investment.id, locked.investmentId))
      )[0];
      if (position === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);

      // The hash the lock would write, computed before the machine is asked so its precondition
      // sees it; every other command carries the hash the row holds.
      const lockHash = body.command === 'lock' ? valuationLockHash(locked) : locked.lockHash;
      const result = attempt(valuationMachine, from, body.command, {
        actorId: principal.userId,
        actorRoles: principal.roles,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        record: {
          inputsComplete: locked.method.length > 0 && locked.fairValue.length > 0,
          validationPassed: D(locked.fairValue).gt(0),
          preparedBy: locked.preparedBy,
          lockHash,
          // Read for the two approvals that ask for it: no list bars nobody.
          ...(body.command === 'dealTeamApprove' || body.command === 'lock'
            ? { sourceReviewers: await this.sourceReviewers(tx, locked) }
            : {}),
        },
      });
      if (!result.ok) throw workflowProblem(result);
      const to = result.to;
      const now = new Date(this.adapters.clock.now());
      const actor = principal.userId;

      const base = {
        investmentId: locked.investmentId,
        investmentNumber: position.investmentNumber,
        periodEnd: locked.periodEnd,
        version: locked.version,
        method: locked.method,
        fairValue: locked.fairValue,
        state: { before: from, after: to },
      };
      let patch: Partial<typeof valuation.$inferInsert>;
      let step: string;
      let decision: string;
      let details: Record<string, unknown> = base;
      switch (body.command) {
        case 'prepare':
          patch = { state: to, preparedBy: actor };
          step = 'ops_prepared';
          decision = 'approve';
          details = { ...base, preparedBy: { before: locked.preparedBy, after: actor } };
          break;
        case 'sendBack':
          patch = { state: to };
          step = principal.roles.includes('deal_team') ? 'deal_team' : 'ops_prepared';
          decision = 'reject';
          break;
        case 'dealTeamApprove':
          patch = { state: to, dealTeamApprovedBy: actor };
          step = 'deal_team';
          decision = 'approve';
          details = {
            ...base,
            dealTeamApprovedBy: { before: locked.dealTeamApprovedBy, after: actor },
          };
          break;
        case 'lock': {
          // One Locked version per investment and quarter: the partial unique index of migration
          // 0004 guards the exact period end, the quarter rule (alignedQuarterEnd) is checked here.
          const tolerance = this.board.tolerance();
          const chain = await this.sameQuarter(
            tx,
            locked.investmentId,
            alignedQuarterEnd(locked.periodEnd, tolerance),
            tolerance,
          );
          if (chain.some((v) => v.state === 'Locked' && v.id !== locked.id))
            throw new ProblemError(
              409,
              'conflict',
              'valuation: another version is Locked for this investment and quarter; reopen it before locking this one',
            );
          patch = { state: to, approvedBy: actor, approvedAt: now, lockHash };
          step = 'final';
          decision = 'approve';
          details = {
            ...base,
            approvedBy: { before: locked.approvedBy, after: actor },
            lockHash: { before: locked.lockHash, after: lockHash },
          };
          break;
        }
        case 'reopen':
          patch = { state: to, reopenReason: body.reason ?? null };
          step = 'reopen';
          decision = 'reopen';
          break;
      }

      await this.claim(tx, locked, from, patch);
      await tx.insert(approval).values({
        valuationId: locked.id,
        approverId: actor,
        step,
        decision,
        comment: body.reason ?? null,
        at: now,
      });

      if (body.command !== 'reopen') {
        await audit({
          action: `valuation.${body.command}`,
          entity: ENTITY,
          entityId: locked.id,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          details,
        });
        // A Locked mark closes the Open suggestion of its quarter and of any earlier one, and is
        // the mark a later quarter's suggestion is now worked out from (docs/18 section 14).
        if (body.command === 'lock')
          await this.suggestions.refreshPosition(tx, audit, locked.investmentId);
        return this.rowOrThrow(tx, locked.id);
      }
      const next = await this.reopenInto(tx, audit, locked, position.investmentNumber, actor, body);
      await audit({
        action: 'valuation.reopen',
        entity: ENTITY,
        entityId: locked.id,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        details: {
          ...base,
          reopenReason: { before: locked.reopenReason, after: body.reason ?? null },
          newVersion: { id: next.id, version: next.version },
          tasks: next.tasks,
        },
      });
      // The mark is no longer Locked: a later quarter's Open suggestion rested on it.
      await this.suggestions.refreshPosition(tx, audit, locked.investmentId);
      return this.rowOrThrow(tx, next.id);
    });
  }

  /**
   * The batch approval screen (docs/04 M10): the same command on each id, each in its own
   * transaction, so one refusal rolls back that version alone and the rest go through. The
   * answer carries, per id in the order sent, the new state or the problem that refused it; the
   * batch itself writes no audit event, each version's command does.
   */
  async batch(
    principal: Principal,
    requestId: string,
    body: ValuationBatchCommandBody,
  ): Promise<ValuationBatchResult> {
    const results: ValuationBatchResult['results'] = [];
    for (const id of body.ids) {
      try {
        const row = await this.command(principal, requestId, id, {
          command: body.command,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        });
        results.push({ id, ok: true, state: row.state });
      } catch (error: unknown) {
        if (!(error instanceof ProblemError)) throw error;
        results.push({
          id,
          ok: false,
          problem: { status: error.getStatus(), code: error.code, detail: error.message },
        });
      }
    }
    return { results };
  }

  /**
   * The next version after a reopen: a Draft with the same method, inputs and value for the
   * same period end, and an open ops.task for each prior approver other than the actor, so they
   * learn the mark they approved is being revisited (docs/18 section 1, SEC-9.3). Only operations
   * and the system actor may insert a version (migration 0006, the "(new) to Draft" row), while an
   * approver may reopen: the Draft is therefore written as the system actor inside the actor's
   * transaction, a mechanical consequence of the reopen the audit event attributes to the actor.
   */
  private async reopenInto(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    locked: LockedVersion,
    investmentNumber: string,
    actor: string,
    body: ValuationCommandBody,
  ): Promise<{ id: string; version: number; tasks: { id: string; ownerId: string }[] }> {
    const version = await this.nextVersion(tx, locked.investmentId, locked.periodEnd);
    const inserted = (
      await asSystemActor(tx, (system) =>
        system
          .insert(valuation)
          .values({
            investmentId: locked.investmentId,
            periodEnd: locked.periodEnd,
            version,
            method: locked.method,
            inputs: locked.inputs,
            fairValue: locked.fairValue,
            currency: locked.currency,
            state: 'Draft',
            preparedBy: null,
          })
          .returning(),
      )
    )[0];
    if (inserted === undefined) throw precondition('valuation: the new version was not written');
    const owners = [
      ...new Set(
        [locked.dealTeamApprovedBy, locked.approvedBy].filter(
          (who): who is string => who !== null && who !== actor,
        ),
      ),
    ];
    const tasks: { id: string; ownerId: string }[] = [];
    for (const ownerId of owners) {
      const task = (
        await tx
          .insert(schema.task)
          .values({
            regardingEntity: ENTITY,
            regardingId: inserted.id,
            title: `Valuation reopened: ${investmentNumber} ${locked.periodEnd}`,
            ownerId,
            state: 'open',
            priority: 'normal',
          })
          .returning()
      )[0];
      if (task !== undefined) tasks.push({ id: task.id, ownerId });
    }
    await audit({
      action: 'valuation.create',
      entity: ENTITY,
      entityId: inserted.id,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      details: {
        investmentId: locked.investmentId,
        investmentNumber,
        periodEnd: locked.periodEnd,
        version,
        method: locked.method,
        fairValue: locked.fairValue,
        reopenedFrom: { id: locked.id, version: locked.version },
        state: { before: null, after: 'Draft' },
      },
    });
    return { id: inserted.id, version, tasks };
  }

  /**
   * A transaction that inserts a version (a create, or the Draft a reopen starts). The version
   * number is the highest read plus one, so two writers can read the same highest and the unique
   * key of mon.valuation then refuses the second insert: that one answers 409, with nothing
   * written by it. Every other error is handed on as it came.
   */
  private async unlessVersionTaken<T>(
    principal: Principal,
    requestId: string,
    fn: (tx: Tx, audit: (entry: AuditEntry) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.run(principal, requestId, fn);
    } catch (error: unknown) {
      if (isUniqueViolationOn(error, VERSION_KEY)) throw versionTaken();
      throw error;
    }
  }

  /** 400 on the method field unless the taxonomy carries the code as an active valuation method. */
  private async requireMethod(tx: Tx, method: string): Promise<void> {
    const term = (
      await tx
        .select({ code: schema.taxonomyTerm.code })
        .from(schema.taxonomyTerm)
        .where(
          and(
            eq(schema.taxonomyTerm.code, method),
            eq(schema.taxonomyTerm.domain, 'valuation_method'),
            eq(schema.taxonomyTerm.active, true),
          ),
        )
    )[0];
    if (term === undefined)
      throw new ProblemError(400, 'validation', 'Invalid body', [
        { path: 'method', message: 'Unknown valuation method' },
      ]);
  }

  /**
   * The stored method inputs of a version the caller can see (the screen shows them and the lock
   * text covers them): the record the column holds, empty when the version has none. The column
   * is jsonb and the API writes records only (the create and edit bodies, a reopen's copy);
   * anything else is a version the screen cannot show, which is said rather than passed on.
   */
  private async inputsOf(tx: Tx, id: string): Promise<ValuationStoredInputs> {
    const [row] = await tx
      .select({ inputs: valuation.inputs })
      .from(valuation)
      .where(eq(valuation.id, id));
    return this.storedInputs(row?.inputs);
  }

  /** The inputs column as the record it holds; anything else is said, never passed on. */
  private storedInputs(inputs: unknown): ValuationStoredInputs {
    const parsed = valuationStoredInputs.safeParse(inputs ?? {});
    if (!parsed.success)
      throw new ProblemError(
        500,
        'internal',
        'valuation: the stored inputs are not a record of names to values',
      );
    return parsed.data;
  }

  /**
   * Who cannot approve this version because they stood behind a suggested mark it carries
   * (docs/18 sections 1 and 14): the union of the source reviewers of every Accepted suggestion
   * whose valuation is a version of the same investment and quarter. A reopen copies the mark and
   * the suggestion's keys to the next version while the suggestion still names the version it was
   * accepted onto, so the rule follows the chain and not the one row. Read as the system actor,
   * so the control never passes because the person asking could not read the suggestion.
   */
  private async sourceReviewers(tx: Tx, locked: LockedVersion): Promise<string[]> {
    const tolerance = this.board.tolerance();
    return asSystemActor(tx, async (stx) => {
      const chain = await this.sameQuarter(
        stx,
        locked.investmentId,
        alignedQuarterEnd(locked.periodEnd, tolerance),
        tolerance,
      );
      const accepted = await stx
        .select({
          state: schema.valuationSuggestion.state,
          sourceReviewerIds: schema.valuationSuggestion.sourceReviewerIds,
        })
        .from(schema.valuationSuggestion)
        .where(
          inArray(
            schema.valuationSuggestion.valuationId,
            chain.map((version) => version.id),
          ),
        );
      return sourceReviewersOf(accepted);
    });
  }

  /**
   * The one write of a command or an edit: the columns given, on the version as it was read (its
   * state and its row version), answered with the row as written. Nothing written means another
   * command changed it first, in the window between this command's read and its write; that is
   * the conflict, and the transaction rolls back.
   */
  private async claim(
    tx: Tx,
    locked: LockedVersion,
    from: ValuationState,
    patch: Partial<typeof valuation.$inferInsert>,
  ): Promise<typeof valuation.$inferSelect> {
    const updated = await tx
      .update(valuation)
      .set(patch)
      .where(
        and(
          eq(valuation.id, locked.id),
          eq(valuation.state, from),
          eq(valuation.rowVersion, locked.rowVersion),
        ),
      )
      .returning();
    const written = updated[0];
    if (written === undefined) throw conflict();
    return written;
  }

  /** The versions of an investment that report for a quarter end (alignedQuarterEnd). */
  private async sameQuarter(
    tx: Tx,
    investmentId: string,
    quarterEnd: string,
    tolerance: number,
  ): Promise<{ id: string; periodEnd: string; version: number; state: ValuationState }[]> {
    const rows = await tx
      .select({
        id: valuation.id,
        periodEnd: valuation.periodEnd,
        version: valuation.version,
        state: valuation.state,
      })
      .from(valuation)
      .where(
        and(
          eq(valuation.investmentId, investmentId),
          gte(valuation.periodEnd, addDays(quarterEnd, -tolerance)),
          lte(valuation.periodEnd, addDays(quarterEnd, tolerance)),
        ),
      );
    return rows.filter((v) => alignedQuarterEnd(v.periodEnd, tolerance) === quarterEnd);
  }

  /** max(version) + 1 for the investment and the exact period end (the unique key of mon.valuation). */
  private async nextVersion(tx: Tx, investmentId: string, periodEnd: string): Promise<number> {
    const [row] = await tx
      .select({ highest: max(valuation.version) })
      .from(valuation)
      .where(and(eq(valuation.investmentId, investmentId), eq(valuation.periodEnd, periodEnd)));
    return Number(row?.highest ?? 0) + 1;
  }

  /** The stored state as the machine knows it; anything else is a version the workflow cannot work. */
  private stateOf(locked: LockedVersion): ValuationState {
    const parsed = valuationState.safeParse(locked.state);
    if (!parsed.success)
      throw new ProblemError(
        500,
        'internal',
        'valuation: the stored state is not one the workflow knows',
      );
    return parsed.data;
  }

  /** The version as a board row after a write in this transaction; it was just written, so it reads. */
  private async rowOrThrow(tx: Tx, id: string): Promise<ValuationRow> {
    const row = await this.board.rowById(tx, id);
    if (row === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
    return row;
  }
}
