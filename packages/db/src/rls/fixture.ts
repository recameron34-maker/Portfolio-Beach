import { sql } from 'drizzle-orm';
import type { DbHandle } from '../client.js';
import { withUserContext } from '../context.js';
import { SYSTEM_USER_ID } from '../roles.js';
import type { AppRole } from '../roles.js';

/**
 * A small, hand-built dataset for the access matrix (docs/12 section 1): two investments, one of
 * them walled; two clients; one SMA commitment; one staged accounting file with a row linked to
 * each investment and one with no link; one staged weekly value per investment and one unlinked; one
 * company alias; three data exceptions, one about each staged accounting row; one indexed quarterly
 * report per investment with its expected-document row, one extraction run and two extracted values
 * (migration 0011). Loaded as the owner, outside RLS.
 */
export const ids = {
  users: {
    viewer: '10000000-0000-4000-8000-000000000001',
    dealTeam: '10000000-0000-4000-8000-000000000002',
    operations: '10000000-0000-4000-8000-000000000003',
    approver: '10000000-0000-4000-8000-000000000004',
    investorRelationsA: '10000000-0000-4000-8000-000000000005',
    platformAdmin: '10000000-0000-4000-8000-000000000006',
    auditor: '10000000-0000-4000-8000-000000000007',
    wallMember: '10000000-0000-4000-8000-000000000008',
    operations2: '10000000-0000-4000-8000-000000000009',
  },
  sponsor: '20000000-0000-4000-8000-000000000001',
  sponsorFund: '20000000-0000-4000-8000-000000000002',
  company1: '20000000-0000-4000-8000-000000000003',
  company2: '20000000-0000-4000-8000-000000000004',
  vehicle: '20000000-0000-4000-8000-000000000005',
  investment1: '30000000-0000-4000-8000-000000000001',
  investmentWalled: '30000000-0000-4000-8000-000000000002',
  clientA: '40000000-0000-4000-8000-000000000001',
  clientB: '40000000-0000-4000-8000-000000000002',
  commitmentPooled: '50000000-0000-4000-8000-000000000001',
  commitmentSmaB: '50000000-0000-4000-8000-000000000002',
  wall: '60000000-0000-4000-8000-000000000001',
  valuationLocked: '70000000-0000-4000-8000-000000000001',
  valuationWalledDraft: '70000000-0000-4000-8000-000000000002',
  intakeFile: '80000000-0000-4000-8000-000000000001',
  intakeRowVisible: '80000000-0000-4000-8000-000000000002',
  intakeRowWalled: '80000000-0000-4000-8000-000000000003',
  intakeRowUnlinked: '80000000-0000-4000-8000-000000000004',
  weeklyVisible: '80000000-0000-4000-8000-000000000005',
  weeklyWalled: '80000000-0000-4000-8000-000000000006',
  weeklyUnlinked: '80000000-0000-4000-8000-000000000007',
  companyAlias: '80000000-0000-4000-8000-000000000008',
  exceptionVisibleRow: '90000000-0000-4000-8000-000000000001',
  exceptionWalledRow: '90000000-0000-4000-8000-000000000002',
  exceptionUnlinkedRow: '90000000-0000-4000-8000-000000000003',
  // Documents (migration 0011): one quarterly report per investment, each with its expected-document
  // row, one extraction run and two extracted values.
  documentOpen: 'a0000000-0000-4000-8000-000000000001',
  documentWalled: 'a0000000-0000-4000-8000-000000000002',
  expectedDocumentOpen: 'a0000000-0000-4000-8000-000000000003',
  expectedDocumentWalled: 'a0000000-0000-4000-8000-000000000004',
  extractionRunOpen: 'a0000000-0000-4000-8000-000000000005',
  extractionRunWalled: 'a0000000-0000-4000-8000-000000000006',
  extractedValueOpenRevenue: 'a0000000-0000-4000-8000-000000000007',
  extractedValueOpenEbitda: 'a0000000-0000-4000-8000-000000000008',
  extractedValueWalledRevenue: 'a0000000-0000-4000-8000-000000000009',
  extractedValueWalledEbitda: 'a0000000-0000-4000-8000-00000000000a',
} as const;

export interface Actor {
  name: string;
  userId: string;
  roles: AppRole[];
  clientIds?: string[];
}

export const actors: Actor[] = [
  { name: 'viewer', userId: ids.users.viewer, roles: ['viewer'] },
  { name: 'deal_team', userId: ids.users.dealTeam, roles: ['deal_team'] },
  { name: 'operations', userId: ids.users.operations, roles: ['operations'] },
  { name: 'approver', userId: ids.users.approver, roles: ['approver'] },
  {
    name: 'investor_relations(A)',
    userId: ids.users.investorRelationsA,
    roles: ['investor_relations'],
    clientIds: [ids.clientA],
  },
  { name: 'platform_admin', userId: ids.users.platformAdmin, roles: ['platform_admin'] },
  { name: 'auditor', userId: ids.users.auditor, roles: ['auditor'] },
  { name: 'wall_member(deal_team)', userId: ids.users.wallMember, roles: ['deal_team'] },
  // The system actor (migration 0006 inserts its user row; no fixture row is needed).
  { name: 'service', userId: SYSTEM_USER_ID, roles: ['service'] },
];

/** The rows of a table an actor sees under their own row-level security context. */
export async function countAs(handle: DbHandle, actor: Actor, table: string): Promise<number> {
  return withUserContext(
    handle.db,
    {
      userId: actor.userId,
      roles: actor.roles,
      ...(actor.clientIds ? { clientIds: actor.clientIds } : {}),
    },
    async (tx) => {
      const r = await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`));
      return r.rows[0]?.n ?? -1;
    },
  );
}

export async function loadFixture(handle: DbHandle): Promise<void> {
  const u = ids.users;
  await handle.exec(`
    insert into core.app_user (id, external_id, display_name, email) values
      ('${u.viewer}', 'viewer', 'Viewer One', 'viewer@portfolio-beach.example'),
      ('${u.dealTeam}', 'dealteam', 'Deal Team One', 'deal@portfolio-beach.example'),
      ('${u.operations}', 'ops', 'Operations One', 'ops@portfolio-beach.example'),
      ('${u.approver}', 'approver', 'Approver One', 'approver@portfolio-beach.example'),
      ('${u.investorRelationsA}', 'ir', 'IR One', 'ir@portfolio-beach.example'),
      ('${u.platformAdmin}', 'admin', 'Admin One', 'admin@portfolio-beach.example'),
      ('${u.auditor}', 'auditor', 'Auditor One', 'auditor@portfolio-beach.example'),
      ('${u.wallMember}', 'walled', 'Wall Member', 'walled@portfolio-beach.example'),
      ('${u.operations2}', 'ops2', 'Operations Two', 'ops2@portfolio-beach.example');
    insert into core.sponsor (id, name, canonical_name, tier) values ('${ids.sponsor}', 'Harborlight Capital', 'harborlight capital', 'sponsor_tier.core');
    insert into core.sponsor_fund (id, sponsor_id, name, canonical_name, vintage, strategy) values ('${ids.sponsorFund}', '${ids.sponsor}', 'Harborlight Fund IV', 'harborlight fund iv', 2021, 'strategy.buyout');
    insert into core.portfolio_company (id, name, canonical_name, sector, geography) values
      ('${ids.company1}', 'Saltmarsh Holdings', 'saltmarsh holdings', 'sector.software', 'geography.north_america'),
      ('${ids.company2}', 'Tidewater Diagnostics', 'tidewater diagnostics', 'sector.healthcare', 'geography.europe');
    insert into core.vehicle (id, name, vehicle_type, vintage) values ('${ids.vehicle}', 'Beach Co-Invest Fund I', 'vehicle_type.co_invest', 2021);
    insert into core.investment (id, investment_number, vehicle_id, portfolio_company_id, sponsor_fund_id, sponsor_id, deal_type, entry_date) values
      ('${ids.investment1}', 'INV-0001', '${ids.vehicle}', '${ids.company1}', '${ids.sponsorFund}', '${ids.sponsor}', 'deal_type.co_invest_equity', '2022-03-15'),
      ('${ids.investmentWalled}', 'INV-0002', '${ids.vehicle}', '${ids.company2}', '${ids.sponsorFund}', '${ids.sponsor}', 'deal_type.co_invest_equity', '2023-06-30');
    insert into core.client (id, name) values ('${ids.clientA}', 'Client Alpha'), ('${ids.clientB}', 'Client Beta');
    insert into core.lp_commitment (id, client_id, vehicle_id, amount, commitment_date, closing_number, ownership_pct) values
      (gen_random_uuid(), '${ids.clientA}', '${ids.vehicle}', 60000000, '2021-06-30', 1, 0.6),
      (gen_random_uuid(), '${ids.clientB}', '${ids.vehicle}', 40000000, '2021-06-30', 1, 0.4);
    insert into core.commitment (id, vehicle_id, sponsor_fund_id, client_id, amount, commitment_date) values
      ('${ids.commitmentPooled}', '${ids.vehicle}', '${ids.sponsorFund}', null, 25000000, '2021-09-30'),
      ('${ids.commitmentSmaB}', '${ids.vehicle}', '${ids.sponsorFund}', '${ids.clientB}', 5000000, '2021-09-30');
    insert into core.wall (id, name, description) values ('${ids.wall}', 'Project Tidewater', 'Restricted deal');
    insert into core.wall_member (wall_id, user_id) values ('${ids.wall}', '${u.wallMember}');
    insert into core.walled_record (wall_id, entity, entity_id) values ('${ids.wall}', 'investment', '${ids.investmentWalled}');
    insert into mon.quarterly_performance (investment_id, period_end, revenue_ltm, ebitda_ltm, ev, net_debt, status) values
      ('${ids.investment1}', '2024-06-30', 120000000, 30000000, 360000000, 90000000, 'record_status.approved'),
      ('${ids.investmentWalled}', '2024-06-30', 80000000, 16000000, 200000000, 60000000, 'record_status.approved');
    insert into mon.valuation (id, investment_id, period_end, version, method, fair_value, state, lock_hash, prepared_by, deal_team_approved_by, approved_by, approved_at) values
      ('${ids.valuationLocked}', '${ids.investment1}', '2024-06-30', 1, 'valuation_method.sponsor_mark', 45000000, 'Locked', 'abc123', '${u.operations}', '${u.dealTeam}', '${u.approver}', now()),
      ('${ids.valuationWalledDraft}', '${ids.investmentWalled}', '2024-06-30', 1, 'valuation_method.sponsor_mark', 30000000, 'Draft', null, '${u.operations}', null, null, null);
    insert into mon.cash_flow (investment_id, flow_date, flow_type, amount, status) values
      ('${ids.investment1}', '2022-03-15', 'flow_type.contribution', -30000000, 'record_status.approved'),
      ('${ids.investment1}', '2024-01-31', 'flow_type.distribution', 5000000, 'record_status.approved'),
      ('${ids.investmentWalled}', '2023-06-30', 'flow_type.contribution', -20000000, 'record_status.approved');
    insert into audit.event (actor_id, actor_type, action, entity, entity_id) values
      ('${u.operations}', 'user', 'valuation.lock', 'mon.valuation', '${ids.valuationLocked}'),
      ('${u.operations}', 'user', 'cash_flow.promote', 'mon.cash_flow', null);
    insert into stg.intake_file (id, source, file_name, content_hash, received_by, row_count, status) values
      ('${ids.intakeFile}', 'accounting', 'accounting-export-2024-06-30.csv', 'fixture-hash-0001', '${u.operations}', 3, 'validated');
    insert into stg.intake_row (id, intake_file_id, row_no, natural_key, target_entity, payload, status) values
      ('${ids.intakeRowVisible}', '${ids.intakeFile}', 1, 'INV-0001|2024-06-30', 'quarterly_performance',
        '{"link": {"status": "matched", "investmentId": "${ids.investment1}", "investmentNumber": "INV-0001"}}', 'validated'),
      ('${ids.intakeRowWalled}', '${ids.intakeFile}', 2, 'INV-0002|2024-06-30', 'quarterly_performance',
        '{"link": {"status": "matched", "investmentId": "${ids.investmentWalled}", "investmentNumber": "INV-0002"}}', 'validated'),
      ('${ids.intakeRowUnlinked}', '${ids.intakeFile}', 3, 'INV-9999|2024-06-30', 'quarterly_performance',
        '{"link": {"status": "unmatched", "investmentId": null, "investmentNumber": null}}', 'flagged');
    insert into stg.valuation (id, intake_file_id, row_no, report_date, investment_number, investment_id, reported_value, match_status, status) values
      ('${ids.weeklyVisible}', null, 1, '2024-07-05', 'INV-0001', '${ids.investment1}', 46000000, 'matched', 'validated'),
      ('${ids.weeklyWalled}', null, 2, '2024-07-05', 'INV-0002', '${ids.investmentWalled}', 31000000, 'matched', 'validated'),
      ('${ids.weeklyUnlinked}', null, 3, '2024-07-05', 'INV-9999', null, 1, 'unmatched', 'flagged');
    insert into core.company_alias (id, portfolio_company_id, alias) values
      ('${ids.companyAlias}', '${ids.company1}', 'Saltmarsh Group');
    insert into ops.data_exception (id, source, entity, entity_id, rule_id, severity, state) values
      ('${ids.exceptionVisibleRow}', 'accounting_import', 'stg.intake_row', '${ids.intakeRowVisible}', 'TIE-01', 'exception_severity.high', 'open'),
      ('${ids.exceptionWalledRow}', 'accounting_import', 'stg.intake_row', '${ids.intakeRowWalled}', 'TIE-01', 'exception_severity.high', 'open'),
      ('${ids.exceptionUnlinkedRow}', 'accounting_import', 'stg.intake_row', '${ids.intakeRowUnlinked}', 'XREF-01', 'exception_severity.high', 'open');
    insert into doc.document (id, source_system, source_item_id, file_name, folder, title, doc_type, sponsor_id, sponsor_fund_id, investment_id, period_end, content_hash, size_bytes, page_count, received_at, review_status, classification_confidence) values
      ('${ids.documentOpen}', 'local_folder', 'inbox/2024-06-30 Harborlight Fund IV - Quarterly financials - Saltmarsh Holdings.pdf',
        '2024-06-30 Harborlight Fund IV - Quarterly financials - Saltmarsh Holdings.pdf', 'inbox', 'Saltmarsh Holdings quarterly report Q2 2024',
        'doc_type.quarterly_financials', '${ids.sponsor}', '${ids.sponsorFund}', '${ids.investment1}', '2024-06-30', 'fixture-doc-hash-0001', 20480, 4, '2024-08-10T09:00:00Z', 'Classified', 0.97),
      ('${ids.documentWalled}', 'local_folder', 'inbox/2024-06-30 Harborlight Fund IV - Quarterly financials - Tidewater Diagnostics.pdf',
        '2024-06-30 Harborlight Fund IV - Quarterly financials - Tidewater Diagnostics.pdf', 'inbox', 'Tidewater Diagnostics quarterly report Q2 2024',
        'doc_type.quarterly_financials', '${ids.sponsor}', '${ids.sponsorFund}', '${ids.investmentWalled}', '2024-06-30', 'fixture-doc-hash-0002', 20992, 4, '2024-08-11T09:00:00Z', 'Classified', 0.97);
    insert into doc.expected_document (id, investment_id, sponsor_fund_id, period_end, doc_type, due_date, received_document_id) values
      ('${ids.expectedDocumentOpen}', '${ids.investment1}', null, '2024-06-30', 'doc_type.quarterly_financials', '2024-08-14', '${ids.documentOpen}'),
      ('${ids.expectedDocumentWalled}', '${ids.investmentWalled}', null, '2024-06-30', 'doc_type.quarterly_financials', '2024-08-14', '${ids.documentWalled}');
    insert into doc.extraction_run (id, document_id, investment_id, period_end, schema_id, prompt_id, prompt_version, model_id, state, tokens_in, tokens_out, cost_usd, started_at, finished_at, requested_by) values
      ('${ids.extractionRunOpen}', '${ids.documentOpen}', '${ids.investment1}', '2024-06-30', 'quarterly_financials', 'quarterly_extraction', '1', 'mock', 'Succeeded', 1200, 300, 0.0081, '2024-08-12T10:00:00Z', '2024-08-12T10:00:05Z', '${u.operations}'),
      ('${ids.extractionRunWalled}', '${ids.documentWalled}', '${ids.investmentWalled}', '2024-06-30', 'quarterly_financials', 'quarterly_extraction', '1', 'mock', 'Succeeded', 1250, 310, 0.0084, '2024-08-12T10:01:00Z', '2024-08-12T10:01:05Z', '${u.operations}');
    insert into stg.extracted_value (id, run_id, investment_id, field, value, unit, page, quote, confidence, validation_state) values
      ('${ids.extractedValueOpenRevenue}', '${ids.extractionRunOpen}', '${ids.investment1}', 'revenue_ltm', '120.00', 'USD_M', 2, 'LTM revenue 120.00', 0.95, 'clean'),
      ('${ids.extractedValueOpenEbitda}', '${ids.extractionRunOpen}', '${ids.investment1}', 'ebitda_ltm', '30.00', 'USD_M', 2, 'LTM EBITDA 30.00', 0.72, 'flagged'),
      ('${ids.extractedValueWalledRevenue}', '${ids.extractionRunWalled}', '${ids.investmentWalled}', 'revenue_ltm', '80.00', 'USD_M', 2, 'LTM revenue 80.00', 0.95, 'clean'),
      ('${ids.extractedValueWalledEbitda}', '${ids.extractionRunWalled}', '${ids.investmentWalled}', 'ebitda_ltm', '16.00', 'USD_M', 2, 'LTM EBITDA 16.00', 0.95, 'clean');
  `);
}
