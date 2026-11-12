import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import type { AuditPage, auditQuery } from '@pb/contracts';
import { schema } from '@pb/db';
import type { z } from 'zod';
import {
  AT_BIGINT_CURSOR,
  EXACT_AT_FORMAT,
  decodeAtIdCursor,
  encodeCursor,
} from '../common/cursor.js';
import { DbService } from '../db/db.service.js';

export type AuditListOptions = z.infer<typeof auditQuery>;

/** The event time as the response shows it (milliseconds); the cursor carries the exact time (common/cursor.ts). */
const AT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

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
        const key = decodeAtIdCursor(opts.cursor, AT_BIGINT_CURSOR);
        const at = sql`${key.at}::timestamptz`;
        conditions.push(or(lt(e.at, at), and(eq(e.at, at), lt(e.id, sql`${key.id}::bigint`))));
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
