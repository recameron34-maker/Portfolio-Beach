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
      where c.relkind = 'r' and n.nspname in ('core','deal','mon','doc','ops','stg','audit')
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

  it('0011: the document hub tables, the doc_type taxonomy and the classifier switch (decision 0012)', async () => {
    const terms = await handle.query<{ code: string; label: string }>(
      "select code, label from core.taxonomy_term where domain = 'doc_type' order by sort_order",
    );
    expect(terms.map((t) => t.code)).toEqual([
      'doc_type.quarterly_financials',
      'doc_type.quarterly_letter',
      'doc_type.capital_call',
      'doc_type.distribution_notice',
      'doc_type.capital_account_statement',
      'doc_type.k1',
      'doc_type.audited_financials',
      'doc_type.cim',
      'doc_type.management_presentation',
      'doc_type.lpa',
      'doc_type.side_letter',
      'doc_type.subscription_docs',
      'doc_type.closing_set',
      'doc_type.valuation_support',
      'doc_type.agm_materials',
      'doc_type.other',
    ]);
    expect(terms.find((t) => t.code === 'doc_type.k1')?.label).toBe('K-1');
    const flags = await handle.query<{ key: string; enabled: boolean }>(
      "select key, enabled from ops.feature_flag where key in ('ai.classifier', 'ai.extraction') order by key",
    );
    expect(flags).toEqual([
      { key: 'ai.classifier', enabled: true },
      { key: 'ai.extraction', enabled: false },
    ]);
    // The search vector is generated from the title, the file name and the text excerpt.
    const generated = await handle.query<{ column_name: string; is_generated: string }>(
      "select column_name, is_generated from information_schema.columns where table_schema = 'doc' and table_name = 'document' and column_name = 'search_text'",
    );
    expect(generated).toEqual([{ column_name: 'search_text', is_generated: 'ALWAYS' }]);
    const indexes = await handle.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'doc' order by indexname",
    );
    const names = indexes.map((i) => i.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'document_content_hash_idx',
        'document_investment_idx',
        'document_sponsor_fund_idx',
        'document_review_status_idx',
        'document_search_idx',
        'expected_document_investment_key',
        'expected_document_sponsor_fund_key',
        'extraction_run_document_idx',
        'extraction_run_state_idx',
        'extraction_run_batch_idx',
      ]),
    );
    expect(indexes.find((i) => i.indexname === 'document_search_idx')?.indexdef).toContain(
      'USING gin',
    );
    // One expected row per investment or per sponsor fund, period and type: partial unique indexes.
    for (const key of ['expected_document_investment_key', 'expected_document_sponsor_fund_key']) {
      const def = indexes.find((i) => i.indexname === key)?.indexdef ?? '';
      expect(def, key).toContain('UNIQUE');
      expect(def, key).toContain('IS NOT NULL');
    }
    const policies = await handle.query<{ table: string; policyname: string; cmd: string }>(
      "select schemaname || '.' || tablename as \"table\", policyname, cmd from pg_policies where (schemaname = 'doc' or tablename = 'extracted_value') order by 1, 2",
    );
    expect(policies).toEqual([
      { table: 'doc.document', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'doc.document', policyname: 'review_update', cmd: 'UPDATE' },
      { table: 'doc.document', policyname: 'write_insert', cmd: 'INSERT' },
      { table: 'doc.document', policyname: 'write_update', cmd: 'UPDATE' },
      { table: 'doc.expected_document', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'doc.expected_document', policyname: 'write_delete', cmd: 'DELETE' },
      { table: 'doc.expected_document', policyname: 'write_insert', cmd: 'INSERT' },
      { table: 'doc.expected_document', policyname: 'write_update', cmd: 'UPDATE' },
      { table: 'doc.extraction_run', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'doc.extraction_run', policyname: 'review_update', cmd: 'UPDATE' },
      { table: 'doc.extraction_run', policyname: 'write_insert', cmd: 'INSERT' },
      { table: 'doc.extraction_run', policyname: 'write_update', cmd: 'UPDATE' },
      { table: 'stg.extracted_value', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'stg.extracted_value', policyname: 'review_update', cmd: 'UPDATE' },
      { table: 'stg.extracted_value', policyname: 'write_insert', cmd: 'INSERT' },
    ]);
    // No delete is granted on any of the four, so nothing an extraction staged can be erased.
    const deletes = await handle.query<{ table: string }>(`
      select table_schema || '.' || table_name as "table" from information_schema.role_table_grants
      where grantee = 'pb_app' and privilege_type = 'DELETE'
        and table_schema || '.' || table_name in ('doc.document', 'doc.expected_document', 'doc.extraction_run', 'stg.extracted_value')`);
    expect(deletes).toEqual([]);
  });

  it('0011: the checks refuse a two-parent expected document, a long quote and a repeated field', async () => {
    const insertDocument = `insert into doc.document (id, source_system, source_item_id, file_name, folder, title, content_hash, size_bytes, received_at)
      values ('a1000000-0000-4000-8000-000000000001', 'local_folder', 'inbox/check.pdf', 'check.pdf', 'inbox', 'check', 'hash-check', 10, now())`;
    await handle.exec(insertDocument);
    await expect(
      handle.exec(
        "insert into doc.expected_document (investment_id, sponsor_fund_id, period_end, doc_type, due_date) values (null, null, '2024-06-30', 'doc_type.quarterly_financials', '2024-08-14')",
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      handle.exec(
        "insert into doc.document (source_system, source_item_id, file_name, folder, title, content_hash, size_bytes, received_at, review_status) values ('local_folder', 'inbox/other.pdf', 'other.pdf', 'inbox', 'other', 'hash-other', 10, now(), 'Pending')",
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      handle.exec(
        "insert into doc.document (source_system, source_item_id, file_name, folder, title, content_hash, size_bytes, received_at) values ('local_folder', 'inbox/check.pdf', 'again.pdf', 'inbox', 'again', 'hash-again', 10, now())",
      ),
    ).rejects.toThrow(/unique/);
    await handle.exec(
      "insert into doc.extraction_run (id, document_id, schema_id, prompt_id, prompt_version) values ('a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'quarterly_financials', 'quarterly_extraction', '1')",
    );
    await expect(
      handle.exec(
        `insert into stg.extracted_value (run_id, field, value, unit, page, quote) values ('a1000000-0000-4000-8000-000000000002', 'revenue_ltm', '1', 'USD_M', 1, '${'x'.repeat(151)}')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await handle.exec(
      "insert into stg.extracted_value (run_id, field, value, unit, page, quote) values ('a1000000-0000-4000-8000-000000000002', 'revenue_ltm', '1', 'USD_M', 1, 'one')",
    );
    await expect(
      handle.exec(
        "insert into stg.extracted_value (run_id, field, value, unit, page, quote) values ('a1000000-0000-4000-8000-000000000002', 'revenue_ltm', '2', 'USD_M', 1, 'two')",
      ),
    ).rejects.toThrow(/unique/);
    await expect(
      handle.exec(
        "insert into stg.extracted_value (run_id, field, value, unit) values ('a1000000-0000-4000-8000-000000000002', 'cash', '1', 'EUR')",
      ),
    ).rejects.toThrow(/check constraint/);
    const searched = await handle.query<{ n: number }>(
      "select count(*)::int as n from doc.document where search_text @@ plainto_tsquery('simple', 'check')",
    );
    expect(searched[0]?.n).toBe(1);
  });

  it("0012: exceptions about documents and runs read under their record's policy, and an edit keeps its own unit", async () => {
    // W2: the read policy on ops.data_exception walls doc.document and doc.extraction_run as it walls
    // the two staging tables (migration 0010), so a walled run's exception stays inside the wall.
    const policy = await handle.query<{ qual: string }>(
      "select qual from pg_policies where schemaname = 'ops' and tablename = 'data_exception' and policyname = 'read_all'",
    );
    expect(policy).toHaveLength(1);
    for (const entity of ['stg.intake_row', 'stg.valuation', 'doc.extraction_run', 'doc.document'])
      expect(policy[0]?.qual, entity).toContain(`'${entity}'`);
    // WF-1: the reviewer's unit sits beside the model's, never over it.
    const columns = await handle.query<{ column_name: string; is_nullable: string }>(
      "select column_name, is_nullable from information_schema.columns where table_schema = 'stg' and table_name = 'extracted_value' and column_name in ('unit', 'edited_value', 'edited_unit') order by column_name",
    );
    expect(columns).toEqual([
      { column_name: 'edited_unit', is_nullable: 'YES' },
      { column_name: 'edited_value', is_nullable: 'YES' },
      { column_name: 'unit', is_nullable: 'YES' },
    ]);
    await expect(
      handle.exec(
        "insert into stg.extracted_value (run_id, field, value, unit, edited_value, edited_unit) values ('a1000000-0000-4000-8000-000000000002', 'ev', '1', 'USD_M', '1000', 'EUR')",
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('0013: the control enums, the taxonomies, the history tables and the capital notice flags (decision 0013)', async () => {
    const enums = await handle.query<{ name: string; labels: string }>(`
      select n.nspname || '.' || t.typname as name, string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
      from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
      where n.nspname || '.' || t.typname in ('mon.wire_instruction_state', 'mon.trade_ticket_state', 'mon.change_request_state', 'deal.stage', 'deal.closing_state')
      group by 1 order by 1`);
    expect(enums).toEqual([
      { name: 'deal.closing_state', labels: 'Open,OpsConfirmed' },
      {
        name: 'deal.stage',
        labels: 'Sourced,Screening,Prescreen,Diligence,IC,Approved,Closing,Closed,Passed',
      },
      { name: 'mon.change_request_state', labels: 'Submitted,Routed,InProgress,Applied,Rejected' },
      { name: 'mon.trade_ticket_state', labels: 'Drafted,Approved,Funded,Withdrawn' },
      { name: 'mon.wire_instruction_state', labels: 'Proposed,Verified,Rejected,Superseded' },
    ]);
    const domains = await handle.query<{ domain: string; n: number }>(
      "select domain, count(*)::int as n from core.taxonomy_term where domain in ('pass_reason', 'change_type', 'legal_term_type', 'diligence_workstream') group by domain order by domain",
    );
    expect(domains).toEqual([
      { domain: 'change_type', n: 9 },
      { domain: 'diligence_workstream', n: 8 },
      { domain: 'legal_term_type', n: 10 },
      { domain: 'pass_reason', n: 8 },
    ]);
    // Full row images where a number a client could see changes or money is released; the stage
    // history is the pipeline's own record, not an image table, and the rest keep no image.
    const history = await handle.query<{ name: string }>(
      "select table_schema || '.' || table_name as name from information_schema.tables where table_schema in ('deal', 'mon') and table_name in ('wire_instruction_history', 'trade_ticket_history', 'deal_change_request_history', 'closing_history', 'allocation_history', 'legal_term_history', 'opportunity_history', 'opportunity_stage_history_history', 'closing_item_history') order by 1",
    );
    expect(history.map((h) => h.name)).toEqual([
      'deal.allocation_history',
      'deal.closing_history',
      'deal.legal_term_history',
      'mon.trade_ticket_history',
      'mon.wire_instruction_history',
    ]);
    const stageHistoryImage = await handle.query<{ n: number }>(
      "select count(*)::int as n from information_schema.columns where table_schema = 'deal' and table_name = 'opportunity_stage_history' and column_name = 'row_image'",
    );
    expect(stageHistoryImage[0]?.n).toBe(0);
    const flags = await handle.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      "select column_name, is_nullable, column_default from information_schema.columns where table_schema = 'mon' and table_name = 'capital_notice' and column_name in ('urgency_flag', 'wire_change_flag', 'funded_at', 'funded_by') order by column_name",
    );
    expect(flags).toEqual([
      { column_name: 'funded_at', is_nullable: 'YES', column_default: null },
      { column_name: 'funded_by', is_nullable: 'YES', column_default: null },
      { column_name: 'urgency_flag', is_nullable: 'NO', column_default: 'false' },
      { column_name: 'wire_change_flag', is_nullable: 'NO', column_default: 'false' },
    ]);
  });

  it('0013: one active instruction and one line per allocation anchor (partial unique indexes), and the visibility functions', async () => {
    const indexes = await handle.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where (schemaname = 'mon' and tablename = 'wire_instruction') or (schemaname = 'deal' and tablename = 'allocation') order by indexname",
    );
    const def = (name: string) => indexes.find((i) => i.indexname === name)?.indexdef ?? '';
    for (const name of [
      'wire_instruction_sponsor_fund_version_key',
      'wire_instruction_investment_version_key',
      'wire_instruction_sponsor_fund_active_idx',
      'wire_instruction_investment_active_idx',
    ]) {
      expect(def(name), name).toContain('UNIQUE');
      expect(def(name), name).toContain('IS NOT NULL');
    }
    expect(def('wire_instruction_sponsor_fund_active_idx')).toContain('active');
    expect(def('wire_instruction_investment_active_idx')).toContain('active');
    for (const name of ['allocation_opportunity_key', 'allocation_investment_key']) {
      expect(def(name), name).toContain('UNIQUE');
      expect(def(name), name).toContain('NULLS NOT DISTINCT');
      expect(def(name), name).toContain('IS NOT NULL');
    }
    const functions = await handle.query<{ proname: string }>(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'pb' and p.proname in ('opportunity_visible', 'closing_visible') order by 1",
    );
    expect(functions.map((f) => f.proname)).toEqual(['closing_visible', 'opportunity_visible']);
  });

  it('0013: the policies per control table, append-only stage history and decisions, delete on allocations only', async () => {
    const policies = await handle.query<{ table: string; policyname: string; cmd: string }>(
      "select schemaname || '.' || tablename as \"table\", policyname, cmd from pg_policies where ((schemaname = 'deal' and (tablename not like '%\\_history' or tablename = 'opportunity_stage_history')) or (schemaname = 'mon' and tablename in ('wire_instruction', 'trade_ticket', 'deal_change_request'))) order by 1, 2",
    );
    expect(policies).toEqual([
      { table: 'deal.allocation', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'deal.allocation', policyname: 'write_delete', cmd: 'DELETE' },
      { table: 'deal.allocation', policyname: 'write_insert', cmd: 'INSERT' },
      { table: 'deal.allocation', policyname: 'write_update', cmd: 'UPDATE' },
      { table: 'deal.closing', policyname: 'confirm_closing', cmd: 'UPDATE' },
      { table: 'deal.closing', policyname: 'open_closing', cmd: 'INSERT' },
      { table: 'deal.closing', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'deal.closing_item', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'deal.closing_item', policyname: 'write_delete', cmd: 'DELETE' },
      { table: 'deal.closing_item', policyname: 'write_insert', cmd: 'INSERT' },
      { table: 'deal.closing_item', policyname: 'write_update', cmd: 'UPDATE' },
      { table: 'deal.diligence_task', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'deal.diligence_task', policyname: 'write_delete', cmd: 'DELETE' },
      { table: 'deal.diligence_task', policyname: 'write_insert', cmd: 'INSERT' },
      { table: 'deal.diligence_task', policyname: 'write_update', cmd: 'UPDATE' },
      { table: 'deal.ic_decision', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'deal.ic_decision', policyname: 'record_decision', cmd: 'INSERT' },
      { table: 'deal.legal_term', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'deal.legal_term', policyname: 'write_delete', cmd: 'DELETE' },
      { table: 'deal.legal_term', policyname: 'write_insert', cmd: 'INSERT' },
      { table: 'deal.legal_term', policyname: 'write_update', cmd: 'UPDATE' },
      { table: 'deal.opportunity', policyname: 'create_deal', cmd: 'INSERT' },
      { table: 'deal.opportunity', policyname: 'move_deal', cmd: 'UPDATE' },
      { table: 'deal.opportunity', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'deal.opportunity_stage_history', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'deal.opportunity_stage_history', policyname: 'record_stage', cmd: 'INSERT' },
      { table: 'mon.deal_change_request', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'mon.deal_change_request', policyname: 'submit', cmd: 'INSERT' },
      { table: 'mon.deal_change_request', policyname: 'work', cmd: 'UPDATE' },
      { table: 'mon.trade_ticket', policyname: 'approve', cmd: 'UPDATE' },
      { table: 'mon.trade_ticket', policyname: 'draft', cmd: 'INSERT' },
      { table: 'mon.trade_ticket', policyname: 'read_visible', cmd: 'SELECT' },
      { table: 'mon.wire_instruction', policyname: 'propose', cmd: 'INSERT' },
      { table: 'mon.wire_instruction', policyname: 'read_register', cmd: 'SELECT' },
      { table: 'mon.wire_instruction', policyname: 'verify', cmd: 'UPDATE' },
    ]);
    // The register is read by the control roles only and is not under the investment wall.
    const register = await handle.query<{ qual: string }>(
      "select qual from pg_policies where schemaname = 'mon' and tablename = 'wire_instruction' and policyname = 'read_register'",
    );
    expect(register[0]?.qual).toContain('has_any_role');
    expect(register[0]?.qual).not.toContain('investment_visible');
    // DELETE is granted on allocations only (replaced as a set); the stage history and the IC
    // decisions are append-only, so no UPDATE is granted on them.
    const grants = await handle.query<{ table: string; privilege: string }>(`
      select table_schema || '.' || table_name as "table", privilege_type as privilege
      from information_schema.role_table_grants
      where grantee = 'pb_app' and (
        (privilege_type = 'DELETE' and (table_schema = 'deal' or table_schema || '.' || table_name in ('mon.wire_instruction', 'mon.trade_ticket', 'mon.deal_change_request')))
        or (privilege_type = 'UPDATE' and table_schema || '.' || table_name in ('deal.opportunity_stage_history', 'deal.ic_decision'))
      ) order by 1, 2`);
    expect(grants).toEqual([{ table: 'deal.allocation', privilege: 'DELETE' }]);
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
