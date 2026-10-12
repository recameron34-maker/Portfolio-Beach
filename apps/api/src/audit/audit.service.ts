import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import type { AuditPage, auditQuery } from '@pb/contracts';
import { schema } from '@pb/db';
import type { z } from 'zod';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { DbService } from '../db/db.service.js';

export type AuditListOptions = z.infer<typeof auditQuery>;

/**
 * The cursor is the last row's sort key, "at|id": the event time to the microsecond, as the
 * database holds it, and the event id as digits that fit a bigint. The time comes first because
 * an event is stamped with its transaction's start time, so a slower transaction can write a
 * higher id with an earlier time; a cursor on the id alone would skip it.
 */
const CURSOR = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6})Z\|(\d{1,18})$/;
const AT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const EXACT_AT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /**
   * The audit trail, newest first, as who did what and when (SEC-11.1). RLS limits the rows to
   * operations, approver, auditor and platform_admin; the controller adds a 403 for other roles.
   * The details payload and the before and after hashes never leave the database (SEC-11.4).
   */
  async events(
    principal: Principal,
    requestId: string,
    opts: AuditListOptions,
  ): Promise<AuditPage> {
    const e = schema.auditEvent;
    return this.db.run(principal, requestId, async (tx) => {
      const conditions: (SQL | undefined)[] = [];
      if (opts.cursor !== undefined) {
        const [date = '', time = '', id = ''] = decodeCursor(opts.cursor, CURSOR, [1]);
        const at = sql`${`${date}T${time}Z`}::timestamptz`;
        conditions.push(or(lt(e.at, at), and(eq(e.at, at), lt(e.id, sql`${id}::bigint`))));
      }
      if (opts.entity !== undefined) conditions.push(eq(e.entity, opts.entity));
      if (opts.entityId !== undefined) conditions.push(eq(e.entityId, opts.entityId));
      if (opts.action !== undefined) conditions.push(eq(e.action, opts.action));
      const rows = await tx
        .select({
          event: {
            id: sql<string>`${e.id}::text`,
            at: sql<string>`to_char(${e.at} at time zone 'UTC', ${AT_FORMAT})`,
            actorName: schema.appUser.displayName,
            actorType: e.actorType,
            action: e.action,
            entity: e.entity,
            entityId: e.entityId,
            reason: e.reason,
            requestId: e.requestId,
          },
          exactAt: sql<string>`to_char(${e.at} at time zone 'UTC', ${EXACT_AT_FORMAT})`,
        })
        .from(e)
        .leftJoin(schema.appUser, eq(schema.appUser.id, e.actorId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(e.at), desc(e.id))
        .limit(opts.limit + 1);
      const page = rows.slice(0, opts.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => row.event),
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.exactAt, last.event.id])
            : null,
      };
    });
  }
}
