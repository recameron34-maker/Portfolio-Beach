import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import type { AuditPage, auditQuery } from '@pb/contracts';
import { schema } from '@pb/db';
import type { z } from 'zod';

export type AuditListOptions = z.infer<typeof auditQuery>;
import { DEFINITIONS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';

/** Calculation settings from config/definitions.json (docs/03 section 4); only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: number;
  [key: string]: unknown;
}

/** The cursor is the last event id (a bigint, carried as a decimal string) in base64url. */
const encodeCursor = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');
const decodeCursor = (cursor: string): string => {
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d{1,19}$/.test(value)) throw new ProblemError(400, 'validation', 'Invalid cursor');
  return value;
};

@Injectable()
export class AuditService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

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
      const conditions: SQL[] = [];
      if (opts.cursor !== undefined)
        conditions.push(lt(e.id, sql`${decodeCursor(opts.cursor)}::bigint`));
      if (opts.entity !== undefined) conditions.push(eq(e.entity, opts.entity));
      if (opts.entityId !== undefined) conditions.push(eq(e.entityId, opts.entityId));
      if (opts.action !== undefined) conditions.push(eq(e.action, opts.action));
      const rows = await tx
        .select({
          id: sql<string>`${e.id}::text`,
          at: sql<string>`to_char(${e.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
          actorName: schema.appUser.displayName,
          actorType: e.actorType,
          action: e.action,
          entity: e.entity,
          entityId: e.entityId,
          reason: e.reason,
          requestId: e.requestId,
        })
        .from(e)
        .leftJoin(schema.appUser, eq(schema.appUser.id, e.actorId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(e.at), desc(e.id))
        .limit(opts.limit + 1);
      const page = rows.slice(0, opts.limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: rows.length > opts.limit && last !== undefined ? encodeCursor(last.id) : null,
      };
    });
  }
}
