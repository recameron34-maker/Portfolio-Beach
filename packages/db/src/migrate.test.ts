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

  it("0014: exceptions about change requests read under the request's policy, and the wall question about a named person", async () => {
    // CR-1: the read policy on ops.data_exception walls mon.deal_change_request as it walls the
    // staging tables, the documents and the runs (migrations 0010 and 0012).
    const queue = await handle.query<{ qual: string }>(
      "select qual from pg_policies where schemaname = 'ops' and tablename = 'data_exception' and policyname = 'read_all'",
    );
    expect(queue).toHaveLength(1);
    for (const entity of [
      'stg.intake_row',
      'stg.valuation',
      'doc.extraction_run',
      'doc.document',
      'mon.deal_change_request',
    ])
      expect(queue[0]?.qual, entity).toContain(`'${entity}'`);
    // CR-3: the wall question about a named person is a definer with the pinned search path, as
    // pb.can_see_walled is (migration 0009).
    const fn = await handle.query<{ secdef: boolean; config: string[] | null; args: string }>(
      `select p.prosecdef as secdef, p.proconfig as config, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'pb' and p.proname = 'user_inside_wall'`,
    );
    expect(fn).toEqual([
      {
        secdef: true,
        config: ['search_path=pg_catalog, public'],
        args: 'entity_name text, record_id uuid, person_id uuid',
      },
    ]);
  });

  it('0016: a member reads the wall rows of their own walls, and the service role carries a wall to a position only', async () => {
    const policies = await handle.query<{
      name: string;
      cmd: string;
      qual: string | null;
      check: string | null;
    }>(
      `select policyname as name, cmd, qual, with_check as "check" from pg_policies
       where schemaname = 'core' and tablename = 'walled_record' and policyname in ('read_member', 'carry_read', 'carry_write')
       order by policyname`,
    );
    expect(policies.map((p) => `${p.name}:${p.cmd}`)).toEqual([
      'carry_read:SELECT',
      'carry_write:INSERT',
      'read_member:SELECT',
    ]);
    const byName = new Map(policies.map((p) => [p.name, p]));
    // The membership is compared with the wall of the row read, not with the member row itself
    // (the defect of migration 0006: an unqualified wall_id bound to core.wall_member).
    expect(byName.get('read_member')?.qual).toContain('m.wall_id = walled_record.wall_id');
    expect(byName.get('carry_read')?.qual).toContain("'service'");
    expect(byName.get('carry_write')?.check).toContain("'service'");
    expect(byName.get('carry_write')?.check).toContain("'investment'");
  });

  it('0017: the investment team reads every client, and a client allocation line is read by whoever reads its client', async () => {
    // The roles that read every client without an entitlement: operations, the deal team and
    // approvers (the investment team) and the auditor. A platform admin is still not one (SEC-5.4).
    const fn = await handle.query<{ src: string; secdef: boolean }>(
      `select p.prosrc as src, p.prosecdef as secdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'pb' and p.proname = 'sees_all_clients'`,
    );
    expect(fn).toHaveLength(1);
    expect(fn[0]?.secdef).toBe(false);
    for (const role of ['operations', 'deal_team', 'approver', 'auditor'])
      expect(fn[0]?.src, role).toContain(`'${role}'`);
    for (const role of ['viewer', 'investor_relations', 'platform_admin', 'service'])
      expect(fn[0]?.src, role).not.toContain(`'${role}'`);
    // The three client policies of migration 0006 still call the one function.
    const clientPolicies = await handle.query<{ table: string; qual: string }>(
      `select tablename as "table", qual from pg_policies
       where schemaname = 'core' and tablename in ('client', 'lp_commitment', 'commitment') and cmd = 'SELECT'
       order by tablename`,
    );
    expect(clientPolicies.map((p) => p.table)).toEqual(['client', 'commitment', 'lp_commitment']);
    for (const p of clientPolicies) {
      expect(p.qual, p.table).toContain('sees_all_clients()');
      expect(p.qual, p.table).toContain('entitled_client(');
    }
    // deal.allocation, read_visible: the deal's own visibility as migration 0013 has it, and for a
    // client line the client rule on top; the system actor reads every line for the totals.
    const read = await handle.query<{ qual: string; cmd: string }>(
      "select qual, cmd from pg_policies where schemaname = 'deal' and tablename = 'allocation' and policyname = 'read_visible'",
    );
    expect(read).toHaveLength(1);
    expect(read[0]?.cmd).toBe('SELECT');
    for (const part of [
      'opportunity_visible(opportunity_id)',
      'investment_visible(investment_id)',
      'client_id IS NULL',
      "has_role('service'",
      'sees_all_clients()',
      'entitled_client(client_id)',
    ])
      expect(read[0]?.qual, part).toContain(part);
    // The write policies are the ones migration 0013 made: the deal team, operations and the
    // system actor, who all read every line.
    const writes = await handle.query<{ policyname: string; roles: string }>(
      `select policyname, coalesce(qual, with_check) as roles from pg_policies
       where schemaname = 'deal' and tablename = 'allocation' and cmd <> 'SELECT' order by policyname`,
    );
    expect(writes.map((w) => w.policyname)).toEqual([
      'write_delete',
      'write_insert',
      'write_update',
    ]);
    for (const w of writes)
      expect(w.roles, w.policyname).toContain('{deal_team,operations,service}');
    // Row-level security stays forced on the table and no definer function reads it.
    const forced = await handle.query<{ forced: boolean }>(
      "select c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'deal' and c.relname = 'allocation'",
    );
    expect(forced).toEqual([{ forced: true }]);
  });

  it('0021 and 0022: the base case of a position and its plan points (decision 0022)', async () => {
    const enums = await handle.query<{ labels: string }>(`
      select string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
      from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
      where n.nspname = 'mon' and t.typname = 'underwriting_case_state'`);
    expect(enums).toEqual([{ labels: 'Draft,Confirmed,Superseded,Withdrawn' }]);
    // Money in dollars to the cent, rates to eight places, multiples to six (docs/03 section 1).
    const numerics = await handle.query<{ col: string; precision: number; scale: number }>(`
      select table_name || '.' || column_name as col, numeric_precision as precision, numeric_scale as scale
      from information_schema.columns
      where table_schema = 'mon' and table_name in ('underwriting_case', 'underwriting_case_point') and data_type = 'numeric'
      order by 1`);
    expect(numerics).toEqual([
      { col: 'underwriting_case.annual_loss_rate', precision: 12, scale: 8 },
      { col: 'underwriting_case.exit_multiple', precision: 12, scale: 6 },
      { col: 'underwriting_case.gross_irr', precision: 12, scale: 8 },
      { col: 'underwriting_case.gross_moic', precision: 12, scale: 6 },
      { col: 'underwriting_case.underwritten_yield', precision: 12, scale: 8 },
      { col: 'underwriting_case_point.ebitda_ltm', precision: 20, scale: 2 },
      { col: 'underwriting_case_point.net_debt', precision: 20, scale: 2 },
      { col: 'underwriting_case_point.revenue_ltm', precision: 20, scale: 2 },
    ]);
    // One Draft per position and one Confirmed case per position and case date.
    const indexes = await handle.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'mon' and tablename = 'underwriting_case' order by indexname",
    );
    const def = (name: string) => indexes.find((i) => i.indexname === name)?.indexdef ?? '';
    expect(def('underwriting_case_one_draft_idx')).toContain('UNIQUE');
    expect(def('underwriting_case_one_draft_idx')).toContain('(investment_id)');
    expect(def('underwriting_case_one_draft_idx')).toContain("'Draft'");
    expect(def('underwriting_case_confirmed_date_idx')).toContain('UNIQUE');
    expect(def('underwriting_case_confirmed_date_idx')).toContain('(investment_id, case_date)');
    expect(def('underwriting_case_confirmed_date_idx')).toContain("'Confirmed'");
    // Policies by command: whoever can open the position reads; the deal team records a case and
    // writes its points; the deal team and approvers move a case on. Nobody else writes, the
    // system actor included.
    const policies = await handle.query<{
      table: string;
      policyname: string;
      cmd: string;
      rule: string;
    }>(
      "select tablename as \"table\", policyname, cmd, coalesce(qual, '') || ' ' || coalesce(with_check, '') as rule from pg_policies where schemaname = 'mon' and tablename in ('underwriting_case', 'underwriting_case_point') order by 1, 2",
    );
    expect(policies.map((p) => `${p.table}.${p.policyname}:${p.cmd}`)).toEqual([
      'underwriting_case.move_case:UPDATE',
      'underwriting_case.read_visible:SELECT',
      'underwriting_case.record_case:INSERT',
      'underwriting_case_point.read_visible:SELECT',
      'underwriting_case_point.write_delete:DELETE',
      'underwriting_case_point.write_insert:INSERT',
      'underwriting_case_point.write_update:UPDATE',
    ]);
    const rule = (table: string, name: string) =>
      policies.find((p) => p.table === table && p.policyname === name)?.rule ?? '';
    expect(rule('underwriting_case', 'read_visible')).toContain(
      'investment_visible(investment_id)',
    );
    expect(rule('underwriting_case', 'read_visible')).not.toContain('has_');
    expect(rule('underwriting_case', 'record_case')).toContain("has_role('deal_team'");
    expect(rule('underwriting_case', 'record_case')).toContain('investment_visible(investment_id)');
    expect(rule('underwriting_case', 'move_case')).toContain(
      "ARRAY['deal_team'::text, 'approver'::text]",
    );
    expect(rule('underwriting_case', 'move_case')).toContain('investment_visible(investment_id)');
    expect(rule('underwriting_case_point', 'read_visible')).toContain(
      'underwriting_case_visible(case_id)',
    );
    // A point is written by the deal team member its case names as the last person to change
    // the figures (migration 0022), no longer by anyone who can see the case.
    for (const name of ['write_insert', 'write_update', 'write_delete']) {
      expect(rule('underwriting_case_point', name), name).toContain('{deal_team}');
      expect(rule('underwriting_case_point', name), name).toContain(
        'underwriting_case_entered_by_me(case_id)',
      );
      expect(rule('underwriting_case_point', name), name).not.toContain(
        'underwriting_case_visible',
      );
    }
    for (const p of policies) expect(p.rule, p.policyname).not.toContain('service');
    // The visibility of a point is its case's, and so is the question of who entered it, both
    // asked as the caller (no definer): the wall and the role rules apply once, on the position.
    const fn = await handle.query<{ name: string; secdef: boolean }>(
      "select p.proname as name, p.prosecdef as secdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'pb' and p.proname in ('underwriting_case_visible', 'underwriting_case_entered_by_me') order by 1",
    );
    expect(fn).toEqual([
      { name: 'underwriting_case_entered_by_me', secdef: false },
      { name: 'underwriting_case_visible', secdef: false },
    ]);
    const forced = await handle.query<{ name: string; enabled: boolean; forced: boolean }>(
      "select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'mon' and c.relname in ('underwriting_case', 'underwriting_case_point', 'underwriting_case_history', 'underwriting_case_point_history') order by 1",
    );
    expect(forced).toEqual([
      { name: 'underwriting_case', enabled: true, forced: true },
      { name: 'underwriting_case_history', enabled: true, forced: true },
      { name: 'underwriting_case_point', enabled: true, forced: true },
      { name: 'underwriting_case_point_history', enabled: true, forced: true },
    ]);
    // A case is never deleted; its points are replaced as a set while it is a Draft.
    const grants = await handle.query<{ table: string; privileges: string }>(`
      select table_name as "table", string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants
      where grantee = 'pb_app' and table_schema = 'mon' and table_name like 'underwriting_case%'
      group by table_name order by 1`);
    expect(grants).toEqual([
      { table: 'underwriting_case', privileges: 'INSERT,SELECT,UPDATE' },
      { table: 'underwriting_case_history', privileges: 'SELECT' },
      { table: 'underwriting_case_point', privileges: 'DELETE,INSERT,SELECT,UPDATE' },
      { table: 'underwriting_case_point_history', privileges: 'SELECT' },
    ]);
    // No existing table changed: the accounting import and export read what they read before.
    const added = await handle.query<{ n: number }>(
      "select count(*)::int as n from information_schema.columns where table_schema in ('core', 'mon', 'stg') and column_name like '%underwrit%' and table_name not like 'underwriting_case%'",
    );
    expect(added[0]?.n).toBe(0);
  });

  it('0023: valuation suggestions, their method and their switch (decision 0023)', async () => {
    const enums = await handle.query<{ labels: string }>(`
      select string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
      from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
      where n.nspname = 'mon' and t.typname = 'valuation_suggestion_state'`);
    expect(enums).toEqual([{ labels: 'Open,Accepted,Dismissed,Superseded' }]);
    // The value is money in dollars to the cent (docs/03 section 1); who stood behind it is a list of people.
    const columns = await handle.query<{ col: string; type: string; nullable: string }>(`
      select column_name as col,
        case when data_type = 'numeric' then 'numeric(' || numeric_precision || ',' || numeric_scale || ')'
             when data_type = 'ARRAY' then udt_name else data_type end as type,
        is_nullable as nullable
      from information_schema.columns
      where table_schema = 'mon' and table_name = 'valuation_suggestion'
        and column_name in ('investment_id', 'period_end', 'suggested_value', 'reason_code', 'workings', 'source_document_id', 'extraction_run_id', 'source_reviewer_ids', 'calc_version', 'valuation_id')
      order by 1`);
    expect(columns).toEqual([
      { col: 'calc_version', type: 'text', nullable: 'NO' },
      { col: 'extraction_run_id', type: 'uuid', nullable: 'NO' },
      { col: 'investment_id', type: 'uuid', nullable: 'NO' },
      { col: 'period_end', type: 'date', nullable: 'NO' },
      { col: 'reason_code', type: 'text', nullable: 'YES' },
      { col: 'source_document_id', type: 'uuid', nullable: 'NO' },
      { col: 'source_reviewer_ids', type: '_uuid', nullable: 'NO' },
      { col: 'suggested_value', type: 'numeric(20,2)', nullable: 'YES' },
      { col: 'valuation_id', type: 'uuid', nullable: 'YES' },
      { col: 'workings', type: 'jsonb', nullable: 'NO' },
    ]);
    // One Open suggestion per position and quarter.
    const indexes = await handle.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'mon' and tablename = 'valuation_suggestion' order by indexname",
    );
    const open = indexes.find((i) => i.indexname === 'valuation_suggestion_one_open_idx');
    expect(open?.indexdef).toContain('UNIQUE');
    expect(open?.indexdef).toContain('(investment_id, period_end)');
    expect(open?.indexdef).toContain("'Open'");
    // The replacement is written after the suggestion it replaces is superseded, so that
    // reference alone is checked at commit.
    const deferred = await handle.query<{ column: string; deferred: boolean }>(`
      select a.attname as "column", c.condeferred as deferred
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.conrelid = 'mon.valuation_suggestion'::regclass and c.contype = 'f'
      order by 1`);
    expect(deferred).toEqual([
      { column: 'decided_by', deferred: false },
      { column: 'extraction_run_id', deferred: false },
      { column: 'investment_id', deferred: false },
      { column: 'method', deferred: false },
      { column: 'source_document_id', deferred: false },
      { column: 'superseded_by_id', deferred: true },
      { column: 'valuation_id', deferred: false },
    ]);
    // Policies by command. The four roles that work on valuations and the system actor read,
    // under the position's wall; the system actor inserts; operations accept or dismiss and the
    // system actor supersedes, each judged on the row as it will be.
    const policies = await handle.query<{
      policyname: string;
      cmd: string;
      qual: string;
      check: string;
    }>(
      "select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as \"check\" from pg_policies where schemaname = 'mon' and tablename = 'valuation_suggestion' order by 1",
    );
    expect(policies.map((p) => `${p.policyname}:${p.cmd}`)).toEqual([
      'decide_operations:UPDATE',
      'insert_service:INSERT',
      'read_reviewers:SELECT',
      'supersede_service:UPDATE',
    ]);
    const policy = (name: string) => {
      const found = policies.find((p) => p.policyname === name);
      if (found === undefined) throw new Error(`no policy ${name}`);
      return found;
    };
    for (const p of policies)
      expect(`${p.qual} ${p.check}`, p.policyname).toContain('investment_visible(investment_id)');
    expect(policy('read_reviewers').qual).toContain(
      "ARRAY['operations'::text, 'deal_team'::text, 'approver'::text, 'auditor'::text, 'service'::text]",
    );
    for (const absent of ['viewer', 'investor_relations', 'platform_admin'])
      for (const p of policies) expect(`${p.qual} ${p.check}`, p.policyname).not.toContain(absent);
    expect(policy('insert_service').check).toContain("has_role('service'");
    expect(policy('insert_service').check).not.toContain('operations');
    expect(policy('decide_operations').qual).toContain("has_role('operations'");
    expect(policy('decide_operations').check).toContain("has_role('operations'");
    expect(policy('decide_operations').check).toContain("'Accepted'");
    expect(policy('decide_operations').check).toContain("'Dismissed'");
    expect(policy('decide_operations').check).not.toContain("'Superseded'");
    expect(policy('supersede_service').qual).toContain("has_role('service'");
    expect(policy('supersede_service').check).toContain("'Superseded'");
    expect(policy('supersede_service').check).not.toContain("'Accepted'");
    expect(policy('supersede_service').check).not.toContain("'Dismissed'");
    const forced = await handle.query<{ name: string; enabled: boolean; forced: boolean }>(
      "select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'mon' and c.relname in ('valuation_suggestion', 'valuation_suggestion_history') order by 1",
    );
    expect(forced).toEqual([
      { name: 'valuation_suggestion', enabled: true, forced: true },
      { name: 'valuation_suggestion_history', enabled: true, forced: true },
    ]);
    // A suggestion is never deleted, and the application role sets its decision columns only.
    const grants = await handle.query<{ table: string; privileges: string }>(`
      select table_name as "table", string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants
      where grantee = 'pb_app' and table_schema = 'mon' and table_name like 'valuation_suggestion%'
      group by table_name order by 1`);
    expect(grants).toEqual([
      { table: 'valuation_suggestion', privileges: 'INSERT,SELECT' },
      { table: 'valuation_suggestion_history', privileges: 'SELECT' },
    ]);
    const updatable = await handle.query<{ columns: string }>(`
      select string_agg(column_name, ',' order by column_name) as columns
      from information_schema.column_privileges
      where grantee = 'pb_app' and table_schema = 'mon' and table_name = 'valuation_suggestion' and privilege_type = 'UPDATE'`);
    expect(updatable).toEqual([
      {
        columns:
          'decided_at,decided_by,decision_reason,state,superseded_by_id,superseded_reason,valuation_id',
      },
    ]);
    // The method a draft opened from a report-based suggestion carries, after the six before it.
    const methods = await handle.query<{ code: string; label: string; sort_order: number }>(
      "select code, label, sort_order from core.taxonomy_term where domain = 'valuation_method' order by sort_order",
    );
    expect(methods.map((m) => m.code)).toEqual([
      'valuation_method.sponsor_mark',
      'valuation_method.market_multiple',
      'valuation_method.dcf',
      'valuation_method.cost',
      'valuation_method.par_plus_accrued',
      'valuation_method.weekly_report',
      'valuation_method.report_indication',
    ]);
    expect(methods.at(-1)?.label).toBe('Indication from sponsor report');
    // The switch is on from the start.
    const flag = await handle.query<{ key: string; enabled: boolean }>(
      "select key, enabled from ops.feature_flag where key = 'valuation.suggestions'",
    );
    expect(flag).toEqual([{ key: 'valuation.suggestions', enabled: true }]);
    // No existing table changed: the accounting import and export read what they read before.
    const added = await handle.query<{ n: number }>(
      "select count(*)::int as n from information_schema.columns where table_schema in ('core', 'mon', 'stg', 'doc') and column_name like '%suggest%' and table_name not like 'valuation_suggestion%'",
    );
    expect(added[0]?.n).toBe(0);
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
