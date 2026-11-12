import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { createTestDb } from './testing.js';
import type { DbHandle } from './client.js';
import { withUserContext } from './context.js';
import type { Tx } from './context.js';
import { ids, loadFixture } from './rls/fixture.js';
import { expectDbRejection } from './test-utils.js';

/**
 * ops.idempotency_key (migration 0015, docs/17 section 3): what the table itself refuses,
 * whatever the API does. Who may read and write a row is the access matrix's (rls/matrix.ts).
 */
describe('the Idempotency-Key store (migration 0015)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
    await loadFixture(handle);
  });
  afterAll(async () => {
    await handle.close();
  });

  const asViewer = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withUserContext(handle.db, { userId: ids.users.viewer, roles: ['viewer'] }, fn);
  /** Runs one statement as the viewer and answers the rows it changed. */
  const change = (statement: SQL): Promise<number> =>
    asViewer(async (tx) => {
      const result = await tx.execute(statement);
      return ('affectedRows' in result ? result.affectedRows : result.rowCount) ?? 0;
    });
  const reserve = (key: string, path = '/api/v1/valuations', method = 'POST'): Promise<number> =>
    change(
      sql`insert into ops.idempotency_key (user_id, method, path, key, request_hash) values (${ids.users.viewer}, ${method}, ${path}, ${key}, 'sealed')`,
    );

  it('has exactly the columns the store needs, keyed by the person, the method, the path and the key', async () => {
    const columns = await handle.query<{ column_name: string; is_nullable: string }>(
      "select column_name, is_nullable from information_schema.columns where table_schema = 'ops' and table_name = 'idempotency_key' order by ordinal_position",
    );
    expect(columns.map((c) => [c.column_name, c.is_nullable])).toEqual([
      ['user_id', 'NO'],
      ['method', 'NO'],
      ['path', 'NO'],
      ['key', 'NO'],
      ['request_hash', 'NO'],
      ['response_status', 'YES'],
      ['response_body', 'YES'],
      ['response_etag', 'YES'],
      ['created_at', 'NO'],
    ]);
    const key = await handle.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'ops.idempotency_key'::regclass and contype = 'p'",
    );
    expect(key.map((k) => k.def)).toEqual(['PRIMARY KEY (user_id, method, path, key)']);
  });

  it('grants the application role the answer columns only for update, and one policy per command', async () => {
    const updatable = await handle.query<{ column_name: string }>(
      "select column_name from information_schema.column_privileges where grantee = 'pb_app' and table_schema = 'ops' and table_name = 'idempotency_key' and privilege_type = 'UPDATE' order by column_name",
    );
    expect(updatable.map((c) => c.column_name)).toEqual([
      'response_body',
      'response_etag',
      'response_status',
    ]);
    const policies = await handle.query<{ policyname: string; cmd: string }>(
      "select policyname, cmd from pg_policies where schemaname = 'ops' and tablename = 'idempotency_key' order by policyname",
    );
    expect(policies).toEqual([
      { policyname: 'complete_own', cmd: 'UPDATE' },
      { policyname: 'read_own', cmd: 'SELECT' },
      { policyname: 'release_own', cmd: 'DELETE' },
      { policyname: 'reserve_own', cmd: 'INSERT' },
    ]);
  });

  it('accepts a key of 1 to 200 visible ASCII characters and refuses anything else', async () => {
    await reserve('k'.repeat(200));
    await reserve('!~-_.:/=+A9');
    const bad = ['', 'two words', 'k'.repeat(201), `caf${String.fromCharCode(0xe9)}`, 'tab\tkey'];
    for (const key of bad) await expectDbRejection(reserve(key), /idempotency_key_key_check/);
  });

  it('accepts the write methods on an API path and refuses a read or another path', async () => {
    await reserve('method-put', '/api/v1/opportunities/x/allocations', 'PUT');
    await expectDbRejection(reserve('method-get', '/api/v1/valuations', 'GET'), /method_check/);
    await expectDbRejection(reserve('path-other', '/health/live'), /path_check/);
  });

  it('is unique per person, method, path and key: the second reservation conflicts, another path does not', async () => {
    await reserve('once');
    await expectDbRejection(reserve('once'), /idempotency_key_pkey|duplicate key/);
    await reserve('once', '/api/v1/opportunities');
    const mine = await asViewer(async (tx) => {
      const result = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from ops.idempotency_key where key = 'once'`,
      );
      return result.rows[0]?.n;
    });
    expect(mine).toBe(2);
  });

  it('stores only a 2xx answer, and no answer without its status', async () => {
    await reserve('answer');
    const complete = (set: SQL): Promise<number> =>
      change(sql`update ops.idempotency_key set ${set} where key = 'answer'`);
    await expectDbRejection(complete(sql`response_status = 422`), /response_status_check/);
    await expectDbRejection(
      complete(sql`response_body = '{"id": 1}'`),
      /idempotency_key_answer_needs_status|row-level security/,
    );
    expect(
      await complete(
        sql`response_status = 201, response_body = '{"id": 1}', response_etag = '"1"'`,
      ),
    ).toBe(1);
    // Completed: its owner can no longer change or remove it.
    expect(await complete(sql`response_status = 200`)).toBe(0);
    expect(await change(sql`delete from ops.idempotency_key where key = 'answer'`)).toBe(0);
    const kept = await handle.query<{ response_status: number; response_body: unknown }>(
      "select response_status, response_body from ops.idempotency_key where key = 'answer'",
    );
    expect(kept).toEqual([{ response_status: 201, response_body: { id: 1 } }]);
  });
});
