import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbHandle, Tx } from '@pb/db';
import { SYSTEM_USER_ID, withUserContext } from '@pb/db';
import type { Principal } from '@pb/adapters';
import { DB_HANDLE } from '../common/tokens.js';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  reason?: string;
  details?: Record<string, unknown>;
}

/** Every business query runs inside withUserContext so Postgres RLS sees the caller (SEC-5.1). */
@Injectable()
export class DbService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  get raw(): DbHandle {
    return this.handle;
  }

  run<T>(
    principal: Principal,
    requestId: string,
    fn: (tx: Tx, audit: (entry: AuditEntry) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return withUserContext(
      this.handle.db,
      { userId: principal.userId, roles: principal.roles, clientIds: principal.clientIds },
      (tx) =>
        fn(tx, async (entry) => {
          await tx.execute(sql`
          insert into audit.event (actor_id, actor_type, action, entity, entity_id, reason, request_id, details)
          values (${principal.userId}, 'user', ${entry.action}, ${entry.entity}, ${entry.entityId ?? null}, ${entry.reason ?? null}, ${requestId}, ${JSON.stringify(entry.details ?? {})}::jsonb)`);
        }),
    );
  }

  /**
   * A transaction as the system actor (`service` role, migration 0006): the one actor that sees
   * every position, walled ones included (migration 0008), for the mechanical steps no person
   * performs: linking an import to the book, promoting approved rows, running workers. Nothing it
   * reads is returned to a caller as such; the policies on what it writes filter per reader.
   * It audits nothing by itself: the caller's transaction records the business event.
   */
  runAsSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withUserContext(this.handle.db, { userId: SYSTEM_USER_ID, roles: ['service'] }, fn);
  }

  async ping(): Promise<boolean> {
    try {
      await this.handle.query('select 1');
      return true;
    } catch {
      return false;
    }
  }
}
