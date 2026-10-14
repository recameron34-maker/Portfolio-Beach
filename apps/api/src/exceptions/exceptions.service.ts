import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Principal } from '@pb/adapters';
import { dataExceptionState } from '@pb/contracts';
import type {
  DataException,
  DataExceptionCommandBody,
  DataExceptionPage,
  DataExceptionState,
  dataExceptionListQuery,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { attempt, exceptionMachine } from '@pb/workflows';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';

/*
 * The data exceptions queue (docs/04 M1 Data Health, docs/18 section 9, decision 0010): what an
 * intake could not decide for itself, opened by the intakes and worked by operations. Every read
 * runs under the caller's row-level security: the select policy of migration 0010 shows an
 * exception about a staged row only to someone the row's own policy admits, so a walled
 * position's exceptions stay inside the wall. A command moves the exception through
 * exceptionMachine (acknowledge, resolve, wont_fix) or sets the external ticket, with the row
 * locked for the transaction and a state guard on the write, and is audited with the old and
 * new state. The figures an exception carries are never written here (the column grant of
 * migration 0010 allows state, owner and ticket only).
 */

export type ExceptionListOptions = z.infer<typeof dataExceptionListQuery>;

const NOT_FOUND = 'Data exception not found';
const ENTITY = 'ops.data_exception';

const x = schema.dataException;
const stagedRow = schema.intakeRow;
const stagedValue = schema.stagedValuation;
const file = schema.intakeFile;
const owner = alias(schema.appUser, 'owner');
const candidateList = z.array(z.object({ reason: z.string() }));

/** The cursor is "createdAt|id" of the last exception: the opening time to the microsecond and the id. */
const CURSOR =
  /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6})Z\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const EXACT_AT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** An exception row as the queue reads it, with the staged row or value it is about, when there is one. */
interface LoadedException {
  id: string;
  source: string;
  entity: string;
  entityId: string | null;
  ruleId: string;
  expected: string | null;
  actual: string | null;
  severity: string;
  owner: string | null;
  state: string;
  externalTicket: string | null;
  candidates: unknown;
  createdAt: Date;
  updatedAt: Date;
  rowVersion: number;
  exactAt: string;
  intakeFileId: string | null;
  intakeFileName: string | null;
  rowNo: number | null;
  investmentId: string | null;
}

/** The exception as locked for a command: the columns the command reads and guards on. */
interface LockedException {
  id: string;
  state: string;
  ownerId: string | null;
  externalTicket: string | null;
  rowVersion: number;
}

/** The problem when a command finds the exception already changed by another command. */
const conflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'data_exception: another command changed the exception first; open it again',
  );

@Injectable()
export class ExceptionsService {
  constructor(private readonly db: DbService) {}

  /**
   * Exceptions newest first, paged on (createdAt, id), filtered by state, source and severity.
   * Row-level security decides which the caller sees; the controller adds a 403 for roles
   * outside the queue.
   */
  async list(
    principal: Principal,
    requestId: string,
    opts: ExceptionListOptions,
  ): Promise<DataExceptionPage> {
    return this.db.run(principal, requestId, async (tx) => {
      const conditions: (SQL | undefined)[] = [];
      if (opts.state !== undefined) conditions.push(eq(x.state, opts.state));
      if (opts.source !== undefined) conditions.push(eq(x.source, opts.source));
      if (opts.severity !== undefined) conditions.push(eq(x.severity, opts.severity));
      if (opts.cursor !== undefined) {
        const [date = '', time = '', id = ''] = decodeCursor(opts.cursor, CURSOR, [1]);
        const at = sql`${`${date}T${time}Z`}::timestamptz`;
        conditions.push(
          or(lt(x.createdAt, at), and(eq(x.createdAt, at), lt(x.id, sql`${id}::uuid`))),
        );
      }
      const rows = await this.select(tx)
        .where(and(...conditions))
        .orderBy(desc(x.createdAt), desc(x.id))
        .limit(opts.limit + 1);
      const page = rows.slice(0, opts.limit);
      const items = await this.withContext(tx, page);
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.exactAt, last.id])
            : null,
      };
    });
  }

  /** One exception with its context; one the caller cannot see is 404. The open is audited. */
  async detail(principal: Principal, requestId: string, id: string): Promise<DataException> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const found = await this.loadOne(tx, id);
      if (found === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      await audit({ action: 'data_exception.read', entity: ENTITY, entityId: id });
      return found;
    });
  }

  /**
   * acknowledge, resolve and wont_fix move the exception through docs/18 section 9 (operations
   * only; resolve and wont_fix need the reason the table requires); set_ticket records the
   * external ticket and changes no state. The row stays locked until the transaction ends, so a
   * second command waits and then reads the state this one left; the write guards on the state
   * it read all the same, and answers 409 when it no longer holds. Every command is audited with
   * the state before and after, the reason and the ticket.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: DataExceptionCommandBody,
  ): Promise<DataException> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = (
        await tx
          .select({
            id: x.id,
            state: x.state,
            ownerId: x.ownerId,
            externalTicket: x.externalTicket,
            rowVersion: x.rowVersion,
          })
          .from(x)
          .where(eq(x.id, id))
          .for('update')
      )[0];
      if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
      const from = this.stateOf(locked);

      if (body.command === 'set_ticket') {
        const ticket = body.externalTicket ?? null;
        const updated = await tx
          .update(x)
          .set({ externalTicket: ticket })
          .where(and(eq(x.id, id), eq(x.state, from), eq(x.rowVersion, locked.rowVersion)))
          .returning();
        if (updated[0] === undefined) throw conflict();
        await audit({
          action: 'data_exception.set_ticket',
          entity: ENTITY,
          entityId: id,
          details: {
            state: from,
            externalTicket: { before: locked.externalTicket, after: ticket },
          },
        });
      } else {
        const result = attempt(exceptionMachine, from, body.command, {
          actorId: principal.userId,
          actorRoles: principal.roles,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          record: {},
        });
        if (!result.ok) throw workflowProblem(result);
        // The acknowledging operator takes the exception; a later resolve or close keeps the owner.
        const ownerId = body.command === 'acknowledge' ? principal.userId : locked.ownerId;
        const updated = await tx
          .update(x)
          .set({ state: result.to, ownerId })
          .where(and(eq(x.id, id), eq(x.state, from)))
          .returning();
        if (updated[0] === undefined) throw conflict();
        await audit({
          action: `data_exception.${body.command}`,
          entity: ENTITY,
          entityId: id,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          details: {
            state: { before: from, after: result.to },
            owner: { before: locked.ownerId, after: ownerId },
            externalTicket: locked.externalTicket,
          },
        });
      }
      const after = await this.loadOne(tx, id);
      if (after === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return after;
    });
  }

  /** The stored state as the machine knows it; anything else is a record the queue cannot work. */
  private stateOf(locked: LockedException): DataExceptionState {
    const parsed = dataExceptionState.safeParse(locked.state);
    if (!parsed.success)
      throw new ProblemError(
        500,
        'internal',
        'data_exception: the stored state is not one the queue knows',
      );
    return parsed.data;
  }

  /**
   * The queue's one select: the exception, its owner's display name and the staged row or value
   * it is about, each joined under the caller's own row-level security. The joins are left joins
   * so an exception about anything else still reads, with no context.
   */
  private select(tx: Tx) {
    return tx
      .select({
        id: x.id,
        source: x.source,
        entity: x.entity,
        entityId: x.entityId,
        ruleId: x.ruleId,
        expected: x.expected,
        actual: x.actual,
        severity: x.severity,
        owner: owner.displayName,
        state: x.state,
        externalTicket: x.externalTicket,
        candidates: x.candidates,
        createdAt: x.createdAt,
        updatedAt: x.updatedAt,
        rowVersion: x.rowVersion,
        exactAt: sql<string>`to_char(${x.createdAt} at time zone 'UTC', ${EXACT_AT_FORMAT})`,
        intakeFileId: sql<
          string | null
        >`coalesce(${stagedRow.intakeFileId}, ${stagedValue.intakeFileId})`,
        intakeFileName: file.fileName,
        rowNo: sql<number | null>`coalesce(${stagedRow.rowNo}, ${stagedValue.rowNo})`,
        investmentId: sql<
          string | null
        >`coalesce(${stagedRow.payload}->'link'->>'investmentId', ${stagedValue.investmentId}::text)`,
      })
      .from(x)
      .leftJoin(stagedRow, and(eq(x.entity, 'stg.intake_row'), eq(stagedRow.id, x.entityId)))
      .leftJoin(stagedValue, and(eq(x.entity, 'stg.valuation'), eq(stagedValue.id, x.entityId)))
      .leftJoin(
        file,
        eq(file.id, sql`coalesce(${stagedRow.intakeFileId}, ${stagedValue.intakeFileId})`),
      )
      .leftJoin(owner, eq(owner.id, x.ownerId))
      .$dynamic();
  }

  private async loadOne(tx: Tx, id: string): Promise<DataException | null> {
    const rows = await this.select(tx).where(eq(x.id, id));
    const [item] = await this.withContext(tx, rows);
    return item ?? null;
  }

  /**
   * The position each exception is about, named only when the caller may open it: the number and
   * company name are read through the caller's own row-level security on core.investment, so a
   * position past their walls is left as null (SEC-5.3).
   */
  private async withContext(tx: Tx, rows: readonly LoadedException[]): Promise<DataException[]> {
    const ids = [
      ...new Set(rows.flatMap((r) => (r.investmentId === null ? [] : [r.investmentId]))),
    ];
    const seen =
      ids.length === 0
        ? []
        : await tx
            .select({
              id: schema.investment.id,
              investmentNumber: schema.investment.investmentNumber,
              companyName: schema.portfolioCompany.name,
            })
            .from(schema.investment)
            .innerJoin(
              schema.portfolioCompany,
              eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
            )
            .where(inArray(schema.investment.id, ids));
    const visible = new Map(seen.map((s) => [s.id, s]));
    return rows.map((r) => {
      const position = r.investmentId === null ? undefined : visible.get(r.investmentId);
      return {
        id: r.id,
        source: r.source,
        entity: r.entity,
        entityId: r.entityId,
        ruleId: r.ruleId,
        expected: r.expected,
        actual: r.actual,
        severity: r.severity,
        owner: r.owner,
        state: dataExceptionState.parse(r.state),
        externalTicket: r.externalTicket,
        candidates: candidateList.parse(r.candidates),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        rowVersion: r.rowVersion,
        context: {
          intakeFileId: r.intakeFileId,
          intakeFileName: r.intakeFileName,
          rowNo: r.rowNo,
          investmentId: position?.id ?? null,
          investmentNumber: position?.investmentNumber ?? null,
          companyName: position?.companyName ?? null,
        },
      };
    });
  }
}
