import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { containingQuarterEnd, isQuarterEnd } from '@pb/calc';
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
import { requireFreshRow } from '../common/row-version.js';
import { systemStep } from '../common/system-step.js';
import { ADAPTERS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import {
  changeRequest as cr,
  changeRequestsAmong,
  loadChangeRequest,
  pageChangeRequests,
  toChangeRequestRow,
  unappliedRequestStates,
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
 * list, through one data exception per request that the system actor opens (docs/18 section 9),
 * for every request on the book, the ones behind a wall the runner is outside of included; each
 * exception is then read under its request's own policy (migration 0014).
 *
 * Two ways of acting past the caller's own role, each where it belongs (CLAUDE.md rule 7):
 * systemStep (the service role, the actor kept) for the deal team's route, a person's write that
 * the table's update policy leaves to operations and the service, so updated_by names the person;
 * asSystemActor (the system user) for the quarter-end scan and its exceptions, which no person
 * decides and whose rows the runner may not even see.
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
   * route (the deal team, or the service) names the owner, who must be able to open the request
   * (inside the position's wall when it has one), and moves Submitted to Routed; start
   * (operations) opens the work; apply (operations) records the quarter end the change was
   * applied in, which must be a quarter end on or after the effective date and no later than the
   * quarter the clock is in; reject (operations) needs the reason the table requires. The row
   * stays locked until the transaction ends and the write guards on the state and row version
   * read, so a command that lost the race is 409. An If-Match that no longer matches is 412.
   * The table's update policy admits operations and the service (migration 0013), so a deal team
   * member's lock and route write run as a system step once the machine has admitted them: the
   * role is the service's, the actor stays the person, and updated_by and the audit event both
   * name who routed it.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: ChangeRequestCommandBody,
    ifMatch: readonly number[] | undefined,
  ): Promise<ChangeRequestRow> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      // Visibility is the caller's own (404 past a wall). A row locked for update must also pass
      // the table's update policy, which admits operations and the service only: operations locks
      // it as itself, and the deal team's route takes the lock in a system step (the actor kept),
      // or it would never find the row.
      const visible = (await tx.select({ id: cr.id }).from(cr).where(eq(cr.id, id)))[0];
      if (visible === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
      const worksQueue = principal.roles.includes('operations');
      const asWriter = <T>(fn: () => Promise<T>): Promise<T> =>
        worksQueue ? fn() : systemStep(tx, principal, fn);
      const locked = await asWriter(
        async () =>
          (
            await tx
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
      requireFreshRow(ifMatch, locked.rowVersion, 'change_request');
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
      await asWriter(() => claim(tx, locked, from, patch));
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
   * The quarter-end check (docs/18 section 8, the M11 acceptance criterion): every request on
   * the book that is not Applied or Rejected with an effective date on or before the period end
   * gets a data exception unless one is still on the queue, whoever runs the check. The scan and
   * the inserts are the system actor's (the queue's writer for what no person decides, docs/18
   * section 9), so a request behind a wall the runner is outside of is covered like the rest:
   * source change_request, rule CR-QE-01, expected "Applied by <period end>", actual the state.
   * The answer lists the requests the caller may see, read under the caller's own policy, and
   * counts the others as hidden; each exception is read under its request's policy (migration
   * 0014), so the hidden ones stay inside their wall. A second run for the same period opens
   * nothing more. The run is audited with its counts and the ids the caller saw, never a hidden
   * id: the audit trail is read outside the walls.
   */
  async quarterEndCheck(
    principal: Principal,
    requestId: string,
    body: QuarterEndCheckBody,
  ): Promise<QuarterEndCheckResult> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const scan = await asSystemActor(
        tx,
        async (stx): Promise<{ ids: string[]; opened: number }> => {
          const requests = await unappliedRequestStates(stx, body.periodEnd);
          if (requests.length === 0) return { ids: [], opened: 0 };
          const ids = requests.map((r) => r.id);
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
          const missing = requests.filter((r) => !listed.has(r.id));
          if (missing.length > 0)
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
          return { ids, opened: missing.length };
        },
      );
      // What the caller is shown of the scan: the requests their own policy admits. The rest is a count.
      const unapplied = (await changeRequestsAmong(tx, scan.ids)).map(toChangeRequestRow);
      const hidden = scan.ids.length - unapplied.length;
      await audit({
        action: 'change_request.quarter_end_check',
        entity: ENTITY,
        details: {
          periodEnd: body.periodEnd,
          unapplied: scan.ids.length,
          hidden,
          exceptionsOpened: scan.opened,
          requestIds: unapplied.map((r) => r.id),
        },
      });
      return { periodEnd: body.periodEnd, unapplied, hidden, exceptionsOpened: scan.opened };
    });
  }

  /**
   * What a command writes once the table admits it, with the checks the table leaves to the
   * service: route names a known active user who can open the request (inside the position's
   * wall when it has one, asked of pb.user_inside_wall as the caller, who is inside it); apply
   * names a quarter end on or after the effective date and no later than the quarter the clock
   * is in (the contract already refuses a date that is no quarter end).
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
        const wall = await tx.execute<{ inside: boolean }>(
          sql`select pb.user_inside_wall('investment', ${locked.investmentId}::uuid, ${body.ownerId}::uuid) as inside`,
        );
        if (wall.rows[0]?.inside !== true)
          throw precondition(
            'the owner is outside the wall of this position and could not open the request; name an owner inside the wall',
          );
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
        // A change is applied in a quarter that has started: never one the clock has not reached.
        const currentQuarterEnd = containingQuarterEnd(this.adapters.clock.today());
        if (body.appliedPeriod > currentQuarterEnd)
          throw precondition(
            `the applied-in period ${body.appliedPeriod} is after the current quarter end ${currentQuarterEnd}`,
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
