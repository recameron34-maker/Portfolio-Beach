import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import type { DbHandle } from './client.js';
import { loadMigrations, migrate } from './migrate.js';

describe('migrations', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb({ kind: 'pglite' });
  });
  afterAll(async () => {
    await handle.close();
  });

  it('apply in order on an empty database and are recorded', async () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(6);
    const first = await migrate(handle, migrations);
    expect(first.applied).toEqual(migrations.map((m) => m.id));
    const rows = await handle.query<{ id: string; hash: string }>(
      'select id, hash from ops.schema_migration order by id',
    );
    expect(rows.map((r) => r.id)).toEqual(migrations.map((m) => m.id));
  });

  it('are idempotent on a second run', async () => {
    const second = await migrate(handle);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThanOrEqual(6);
  });

  it('refuse a migration whose content changed after it was applied', async () => {
    const migrations = loadMigrations();
    const tampered = migrations.map((m, i) =>
      i === 0 ? { ...m, sql: m.sql + '\n-- edited', hash: 'deadbeef' } : m,
    );
    await expect(migrate(handle, tampered)).rejects.toThrow(/immutable/);
  });

  it('create every schema from docs/03 and the application role', async () => {
    const schemas = await handle.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname in ('core','deal','mon','doc','rel','rpt','ops','stg','audit','pb') order by 1",
    );
    expect(schemas.map((s) => s.nspname)).toEqual([
      'audit',
      'core',
      'deal',
      'doc',
      'mon',
      'ops',
      'pb',
      'rel',
      'rpt',
      'stg',
    ]);
    const role = await handle.query<{ rolname: string; rolsuper: boolean }>(
      "select rolname, rolsuper from pg_roles where rolname = 'pb_app'",
    );
    expect(role).toEqual([{ rolname: 'pb_app', rolsuper: false }]);
  });

  it('enable and force row-level security on every business table', async () => {
    const unprotected = await handle.query<{ name: string }>(`
      select n.nspname || '.' || c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('core','mon','ops','stg','audit')
        and c.relname <> 'schema_migration'
        and not (c.relrowsecurity and c.relforcerowsecurity)
      order by 1`);
    expect(unprotected).toEqual([]);
  });

  it('never grant DELETE on financial tables or UPDATE/DELETE on the audit trail to the application role', async () => {
    const grants = await handle.query<{ table: string; privilege: string }>(`
      select table_schema || '.' || table_name as "table", privilege_type as privilege
      from information_schema.role_table_grants
      where grantee = 'pb_app' and (
        (privilege_type = 'DELETE' and table_schema || '.' || table_name in ('mon.valuation','mon.cash_flow','mon.quarterly_performance','core.investment','core.client','core.commitment','core.lp_commitment'))
        or (table_schema = 'audit' and privilege_type in ('UPDATE','DELETE','TRUNCATE'))
      )`);
    expect(grants).toEqual([]);
  });
});
