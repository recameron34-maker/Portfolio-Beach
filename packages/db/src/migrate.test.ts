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

  it('enable row-level security on every business table and force it on all but the wall tables', async () => {
    const tables = await handle.query<{ name: string; enabled: boolean; forced: boolean }>(`
      select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('core','mon','ops','stg','audit')
        and c.relname <> 'schema_migration'
      order by 1`);
    expect(tables.length).toBeGreaterThan(30);
    expect(tables.filter((t) => !t.enabled)).toEqual([]);
    // pb.can_see_walled (security definer) reads these two as their owner, the migration role,
    // which is bound by nothing when forced: enabled keeps pb_app bound (migration 0009).
    expect(tables.filter((t) => !t.forced).map((t) => t.name)).toEqual([
      'core.wall_member',
      'core.walled_record',
    ]);
  });

  it('0010: company aliases, weekly values in valuation staging and the exception queue (decision 0010)', async () => {
    const aliasColumns = await handle.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'core' and table_name = 'company_alias' order by ordinal_position",
    );
    expect(aliasColumns.map((c) => c.column_name)).toEqual([
      'id',
      'portfolio_company_id',
      'alias',
      'created_at',
      'created_by',
      'updated_at',
      'updated_by',
      'row_version',
    ]);
    const history = await handle.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_schema = 'core' and table_name = 'company_alias_history'",
    );
    expect(history[0]?.n).toBe(1);
    // The alias is unique across companies, so an exact match is never ambiguous.
    const aliasUnique = await handle.query<{ n: number }>(
      "select count(*)::int as n from pg_indexes where schemaname = 'core' and tablename = 'company_alias' and indexdef like '%UNIQUE%(alias)%'",
    );
    expect(aliasUnique[0]?.n).toBe(1);
    // A file may repeat a key (DUP rules flag it); the row number is unique within a file.
    const constraints = await handle.query<{ conname: string; def: string }>(
      "select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'stg.valuation'::regclass and contype in ('u', 'c') order by conname",
    );
    expect(constraints.map((c) => c.conname)).not.toContain(
      'valuation_report_date_investment_number_key',
    );
    expect(constraints.find((c) => c.conname === 'valuation_intake_file_id_row_no_key')?.def).toBe(
      'UNIQUE (intake_file_id, row_no)',
    );
    expect(
      constraints.some((c) => c.def.includes("'locked_mark'") && c.def.includes("'weekly'")),
    ).toBe(true);
    const nullable = await handle.query<{ column_name: string; is_nullable: string }>(
      "select column_name, is_nullable from information_schema.columns where table_schema = 'stg' and table_name = 'valuation' and column_name in ('report_date', 'investment_number', 'reported_value', 'raw', 'link', 'findings') order by column_name",
    );
    expect(nullable).toEqual([
      { column_name: 'findings', is_nullable: 'NO' },
      { column_name: 'investment_number', is_nullable: 'YES' },
      { column_name: 'link', is_nullable: 'NO' },
      { column_name: 'raw', is_nullable: 'NO' },
      { column_name: 'report_date', is_nullable: 'YES' },
      { column_name: 'reported_value', is_nullable: 'YES' },
    ]);
    // Operations may update an exception's state, owner and ticket, and nothing else.
    const updatable = await handle.query<{ column_name: string }>(
      "select column_name from information_schema.column_privileges where grantee = 'pb_app' and table_schema = 'ops' and table_name = 'data_exception' and privilege_type = 'UPDATE' order by column_name",
    );
    expect(updatable.map((c) => c.column_name)).toEqual(['external_ticket', 'owner_id', 'state']);
    const term = await handle.query<{ label: string }>(
      "select label from core.taxonomy_term where code = 'valuation_method.weekly_report'",
    );
    expect(term).toEqual([{ label: 'Weekly report value' }]);
    const flags = await handle.query<{ key: string; enabled: boolean }>(
      "select key, enabled from ops.feature_flag where key in ('adapter.weekly_drop', 'adapter.ops_drop') order by key",
    );
    expect(flags).toEqual([
      { key: 'adapter.ops_drop', enabled: true },
      { key: 'adapter.weekly_drop', enabled: true },
    ]);
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
