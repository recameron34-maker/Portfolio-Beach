import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { isQuarterEnd } from '@pb/calc';
import { changeRequestState } from '@pb/contracts';
import type {
  ChangeRequestCommandBody,
  ChangeRequestCreateBody,
  ChangeRequestPage,
  ChangeRequestRow,
  ChangeRequestState,
  QuarterEndCheckBody,
  QuarterEndCheckResult,
  changeRequestListQuery,
} from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { attempt, dealChangeRequestMachine } from '@pb/workflows';
import type { z } from 'zod';
import { AT_ID_CURSOR, decodeAtIdCursor, encodeCursor } from '../common/cursor.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { ADAPTERS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import { requireFreshIfMatch } from './if-match.js';
import {
  changeRequest as cr,
  loadChangeRequest,
  pageChangeRequests,
  toChangeRequestRow,
  unappliedChangeRequests,
} from './queries.js';

/*
 * Deal change requests (docs/04 M11, docs/18 section 8, decision 0013): the one form the deal
 * team submits when a position changes (an add-on, a new security, a distribution treatment, a
 * recapitalization, a partial exit), routed to an operations owner, worked, and applied in a
 * quarter or rejected with a reason. Every state change goes through dealChangeRequestMachine
 * with the row locked for the transaction and a state guard on the write, and is audited with
 * the state before and after (SEC-11.1). Reads run under the caller's row-level security: a
 * request on a walled position is 404 outside the wall (SEC-5.3). The quarter-end check is the
 * M11 acceptance criterion: a request not applied by the quarter end appears on the exceptions
 * list, through one data exception per request that the system actor opens (docs/18 section 9).
 */

export type ChangeRequestListOptions = z.infer<typeof changeRequestListQuery>;

const NOT_FOUND = 'Change request not found';
const ENTITY = 'mon.deal_change_request';
/** The data exception the quarter-end check opens (ops.data_exception.source and rule_id). */
export const QUARTER_END_SOURCE = 'change_request';
export const QUARTER_END_RULE = 'CR-QE-01';
/** A warning, not a failed figure: the taxonomy's medium severity (exception_severity.{low,medium,high}). */
export const QUARTER_END_SEVERITY = 'exception_severity.medium';
/** The exception states still on the queue (docs/18 section 9): one of these means the request is already listed. */
const EXCEPTION_OPEN_STATES = ['open', 'acknowledged'] as const;

const x = schema.dataException;

/** The request as locked for a command: the columns the command reads and guards on. */
interface LockedRequest {
  id: string;
  investmentId: string;
  state: string;
  ownerId: string | null;
  effectiveDate: string;
  appliedPeriod: string | null;
  rowVersion: number;
}

/** What one command writes besides the new state. */
type Patch = Partial<
  Pick<
    typeof cr.$inferInsert,
    'state' | 'ownerId' | 'appliedPeriod' | 'appliedBy' | 'appliedAt' | 'rejectionReason'
  >
>;

const conflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'deal_change_request: another command changed the request first; open it again',
  );

const precondition = (detail: string): ProblemError =>
  new ProblemError(422, 'workflow-precondition', `deal_change_request: ${detail}`);

@Injectable()
export class ChangeRequestsService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  /** Requests newest first, paged on (createdAt, id), filtered by position and state; walls apply through RLS. */
  async list(
    principal: Principal,
    requestId: string,
    opts: ChangeRequestListOptions,
  ): Promise<ChangeRequestPage> {
    return this.db.run(principal, requestId, async (tx) => {
      const conditions: (SQL | undefined)[] = [];
      if (opts.investmentId !== undefined) conditions.push(eq(cr.investmentId, opts.investmentId));
      if (opts.state !== undefined) conditions.push(eq(cr.state, opts.state));
      if (opts.cursor !== undefined) {
        const key = decodeAtIdCursor(opts.cursor, AT_ID_CURSOR);
        const at = sql`${key.at}::timestamptz`;
        conditions.push(
          or(lt(cr.createdAt, at), and(eq(cr.createdAt, at), lt(cr.id, sql`${key.id}::uuid`))),
        );
      }
      const rows = await pageChangeRequests(tx, conditions, opts.limit + 1);
      const page = rows.slice(0, opts.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toChangeRequestRow),
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.exactAt, last.id])
            : null,
      };
    });
  }

  /** One request; one the caller cannot see is 404. */
  async detail(principal: Principal, requestId: string, id: string): Promise<ChangeRequestRow> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx) => {
      const found = await loadChangeRequest(tx, id);
      if (found === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return found;
    });
  }

  /**
   * The one form (M11): a visible position (404 otherwise), a change type from the taxonomy, the
   * effective date, a one-line summary and the form's fields as plain text. The submitter is the
   * actor and the request starts Submitted (the machine's initial state); the submission is audited.
   */
  async create(
    principal: Principal,
    requestId: string,
    body: ChangeRequestCreateBody,
  ): Promise<ChangeRequestRow> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const investment = (
        await tx
          .select({ id: schema.investment.id })
          .from(schema.investment)
          .where(eq(schema.investment.id, body.investmentId))
      )[0];
      if (investment === undefined)
        throw new ProblemError(404, 'not-found', 'Investment not found');
      const term = (
        await tx
          .select({ code: schema.taxonomyTerm.code })
          .from(schema.taxonomyTerm)
          .where(
            and(
              eq(schema.taxonomyTerm.code, body.changeType),
              eq(schema.taxonomyTerm.domain, 'change_type'),
              eq(schema.taxonomyTerm.active, true),
            ),
          )
      )[0];
      if (term === undefined)
        throw new ProblemError(400, 'validation', 'Invalid body', [
          { path: 'changeType', message: 'Unknown change type' },
        ]);
      const inserted = (
        await tx
          .insert(cr)
          .values({
            investmentId: body.investmentId,
            changeType: body.changeType,
            effectiveDate: body.effectiveDate,
            details: body.details,
            summary: body.summary,
            submittedBy: principal.userId,
            state: dealChangeRequestMachine.initial,
          })
          .returning()
      )[0];
      if (inserted === undefined)
        throw new ProblemError(500, 'internal', 'deal_change_request: the request was not written');
      await audit({
        action: 'change_request.create',
        entity: ENTITY,
        entityId: inserted.id,
        details: {
          investmentId: body.investmentId,
          changeType: body.changeType,
          effectiveDate: body.effectiveDate,
          summary: body.summary,
          state: { before: null, after: dealChangeRequestMachine.initial },
        },
      });
      const row = await loadChangeRequest(tx, inserted.id);
      if (row === null)
        throw new ProblemError(
          500,
          'internal',
          'deal_change_request: the request was not read back',
        );
      return row;
    });
  }

  /**
   * route (the deal team, or the service) names the operations owner and moves Submitted to
   * Routed; start (operations) opens the work; apply (operations) records the quarter end the
   * change was applied in, which must be a quarter end on or after the effective date; reject
   * (operations) needs the reason the table requires. The row stays locked until the transaction
   * ends and the write guards on the state and row version read, so a command that lost the race
   * is 409. An If-Match that no longer matches is 412. The route write runs as the system actor:
   * the table's update policy admits operations and the service (migration 0013), and the machine
   * has already admitted the deal team member; the audit event names the person.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: ChangeRequestCommandBody,
    ifMatch: string | undefined,
  ): Promise<ChangeRequestRow> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      // Visibility is the caller's own (404 past a wall); the lock is taken as the system actor,
      // because a row locked for update must also pass the table's update policy, which admits
      // operations and the service only, and the deal team's route would otherwise never find it.
      const visible = (await tx.select({ id: cr.id }).from(cr).where(eq(cr.id, id)))[0];
      if (visible === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
      const locked = await asSystemActor(
        tx,
        async (stx) =>
          (
            await stx
              .select({
                id: cr.id,
                investmentId: cr.investmentId,
                state: cr.state,
                ownerId: cr.ownerId,
                effectiveDate: cr.effectiveDate,
                appliedPeriod: cr.appliedPeriod,
                rowVersion: cr.rowVersion,
              })
              .from(cr)
              .where(eq(cr.id, id))
              .for('update')
          )[0],
      );
      if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
      requireFreshIfMatch(ifMatch, locked.rowVersion);
      const from = stateOf(locked);
      const result = attempt(dealChangeRequestMachine, from, body.command, {
        actorId: principal.userId,
        actorRoles: principal.roles,
        ...(body.command === 'reject' ? { reason: body.reason } : {}),
        record: {
          ownerId: body.command === 'route' ? body.ownerId : locked.ownerId,
          ...(body.command === 'apply' ? { appliedPeriod: body.appliedPeriod } : {}),
        },
      });
      if (!result.ok) throw workflowProblem(result);
      const patch = await this.patchFor(tx, locked, body, result.to, principal.userId);
      if (body.command === 'route')
        await asSystemActor(tx, (stx) => claim(stx, locked, from, patch));
      else await claim(tx, locked, from, patch);
      await audit({
        action: `change_request.${body.command}`,
        entity: ENTITY,
        entityId: id,
        ...(body.command === 'reject' ? { reason: body.reason } : {}),
        details: {
          investmentId: locked.investmentId,
          state: { before: from, after: result.to },
          owner: { before: locked.ownerId, after: patch.ownerId ?? locked.ownerId },
          appliedPeriod: {
            before: locked.appliedPeriod,
            after: patch.appliedPeriod ?? locked.appliedPeriod,
          },
        },
      });
      const after = await loadChangeRequest(tx, id);
      if (after === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return after;
    });
  }

  /**
   * The quarter-end check (docs/18 section 8, the M11 acceptance criterion): every request the
   * caller sees that is not Applied or Rejected with an effective date on or before the period
   * end is listed, and each one without a data exception still on the queue gets one, opened as
   * the system actor (the queue's writer for what no person decides): source change_request,
   * rule CR-QE-01, expected "Applied by <period end>", actual the state. A second run for the
   * same period opens nothing more. The run is audited with its counts.
   */
  async quarterEndCheck(
    principal: Principal,
    requestId: string,
    body: QuarterEndCheckBody,
  ): Promise<QuarterEndCheckResult> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const rows = await unappliedChangeRequests(tx, body.periodEnd);
      const unapplied = rows.map(toChangeRequestRow);
      const ids = unapplied.map((r) => r.id);
      const exceptionsOpened =
        ids.length === 0
          ? 0
          : await asSystemActor(tx, async (stx) => {
              const listed = new Set(
                (
                  await stx
                    .select({ entityId: x.entityId })
                    .from(x)
                    .where(
                      and(
                        eq(x.entity, ENTITY),
                        eq(x.ruleId, QUARTER_END_RULE),
                        inArray(x.state, [...EXCEPTION_OPEN_STATES]),
                        inArray(x.entityId, ids),
                      ),
                    )
                ).map((e) => e.entityId),
              );
              const missing = unapplied.filter((r) => !listed.has(r.id));
              if (missing.length === 0) return 0;
              await stx.insert(x).values(
                missing.map((r) => ({
                  source: QUARTER_END_SOURCE,
                  entity: ENTITY,
                  entityId: r.id,
                  ruleId: QUARTER_END_RULE,
                  expected: `Applied by ${body.periodEnd}`,
                  actual: r.state,
                  severity: QUARTER_END_SEVERITY,
                  state: 'open',
                  candidates: [],
                })),
              );
              return missing.length;
            });
      await audit({
        action: 'change_request.quarter_end_check',
        entity: ENTITY,
        details: {
          periodEnd: body.periodEnd,
          unapplied: ids.length,
          exceptionsOpened,
          requestIds: ids,
        },
      });
      return { periodEnd: body.periodEnd, unapplied, exceptionsOpened };
    });
  }

  /**
   * What a command writes once the table admits it, with the checks the table leaves to the
   * service: route names a known active user; apply names a quarter end on or after the
   * effective date (the contract already refuses a date that is no quarter end).
   */
  private async patchFor(
    tx: Tx,
    locked: LockedRequest,
    body: ChangeRequestCommandBody,
    to: ChangeRequestState,
    actorId: string,
  ): Promise<Patch> {
    switch (body.command) {
      case 'route': {
        const owner = (
          await tx
            .select({ id: schema.appUser.id })
            .from(schema.appUser)
            .where(and(eq(schema.appUser.id, body.ownerId), eq(schema.appUser.isActive, true)))
        )[0];
        if (owner === undefined) throw precondition('the owner is not a known active user');
        return { state: to, ownerId: body.ownerId };
      }
      case 'start':
        return { state: to };
      case 'apply': {
        if (!isQuarterEnd(body.appliedPeriod))
          throw precondition('the applied-in period must be a quarter end');
        if (body.appliedPeriod < locked.effectiveDate)
          throw precondition(
            `the applied-in period ${body.appliedPeriod} is before the effective date ${locked.effectiveDate}`,
          );
        return {
          state: to,
          appliedPeriod: body.appliedPeriod,
          appliedBy: actorId,
          appliedAt: new Date(this.adapters.clock.now()),
        };
      }
      case 'reject':
        return { state: to, rejectionReason: body.reason };
    }
  }
}

/**
 * The one write of a command: the columns given, on the request as it was read (its state and
 * row version). Nothing written means another command changed it first; that is the conflict,
 * and the transaction rolls back.
 */
async function claim(
  tx: Tx,
  locked: LockedRequest,
  from: ChangeRequestState,
  patch: Patch,
): Promise<void> {
  const updated = await tx
    .update(cr)
    .set(patch)
    .where(and(eq(cr.id, locked.id), eq(cr.state, from), eq(cr.rowVersion, locked.rowVersion)))
    .returning();
  if (updated[0] === undefined) throw conflict();
}

/** The stored state as the machine knows it; anything else is a record the queue cannot work. */
function stateOf(locked: LockedRequest): ChangeRequestState {
  const parsed = changeRequestState.safeParse(locked.state);
  if (!parsed.success)
    throw new ProblemError(
      500,
      'internal',
      'deal_change_request: the stored state is not one the table knows',
    );
  return parsed.data;
}
