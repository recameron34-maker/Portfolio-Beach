import { sql } from 'drizzle-orm';
import type { DbHandle } from '../client.js';
import { withUserContext } from '../context.js';
import { DEV_FIELD_KEY, encryptBankDetails, FieldCipher, maskBankDetails } from '../fieldCrypto.js';
import type { BankDetails } from '../fieldCrypto.js';
import { SYSTEM_USER_ID } from '../roles.js';
import type { AppRole } from '../roles.js';

/**
 * A small, hand-built dataset for the access matrix (docs/12 section 1): two investments, one of
 * them walled; two clients; one SMA commitment; one staged accounting file with a row linked to
 * each investment and one with no link; one staged weekly value per investment and one unlinked; one
 * company alias; three data exceptions, one about each staged accounting row; one indexed quarterly
 * report per investment with its expected-document row, one extraction run and two extracted values
 * (migration 0011); one data exception about each document and each run (migration 0012); the
 * Phase 3 controls (migration 0013): two opportunities, one of them walled, each with a stage
 * history row, a diligence task, an IC decision, an allocation, a closing with one checklist item and
 * one legal term, plus an allocation on the open investment; two wire instruction versions on the
 * open investment (one Verified and active, one Proposed); three capital notices (two on the open
 * investment, one walled) with a Funded ticket on the first and a Drafted one on the walled; one
 * change request per investment. Loaded as the owner, outside RLS.
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
  // Exceptions about the documents and the runs (migration 0012): one per document (DOC-READ-01) and
  // one per run (EXT-RUN-01), so the walled ones must stay inside the wall.
  exceptionOpenDocument: 'a0000000-0000-4000-8000-00000000000b',
  exceptionWalledDocument: 'a0000000-0000-4000-8000-00000000000c',
  exceptionOpenRun: 'a0000000-0000-4000-8000-00000000000d',
  exceptionWalledRun: 'a0000000-0000-4000-8000-00000000000e',
  // The Phase 3 controls (migration 0013). The walled opportunity is walled through the same wall as
  // the walled investment, so the wall member sees both.
  opportunityOpen: 'b0000000-0000-4000-8000-000000000001',
  opportunityWalled: 'b0000000-0000-4000-8000-000000000002',
  stageHistoryOpen: 'b0000000-0000-4000-8000-000000000003',
  stageHistoryWalled: 'b0000000-0000-4000-8000-000000000004',
  diligenceTaskOpen: 'b0000000-0000-4000-8000-000000000005',
  diligenceTaskWalled: 'b0000000-0000-4000-8000-000000000006',
  icDecisionOpen: 'b0000000-0000-4000-8000-000000000007',
  icDecisionWalled: 'b0000000-0000-4000-8000-000000000008',
  allocationOpen: 'b0000000-0000-4000-8000-000000000009',
  allocationWalled: 'b0000000-0000-4000-8000-00000000000a',
  allocationInvestment: 'b0000000-0000-4000-8000-00000000000b',
  closingOpen: 'b0000000-0000-4000-8000-00000000000c',
  closingWalled: 'b0000000-0000-4000-8000-00000000000d',
  closingItemOpen: 'b0000000-0000-4000-8000-00000000000e',
  closingItemWalled: 'b0000000-0000-4000-8000-00000000000f',
  legalTermOpen: 'b0000000-0000-4000-8000-000000000010',
  legalTermWalled: 'b0000000-0000-4000-8000-000000000011',
  wireInstructionVerified: 'b0000000-0000-4000-8000-000000000012',
  wireInstructionProposed: 'b0000000-0000-4000-8000-000000000013',
  capitalNoticeOpen: 'b0000000-0000-4000-8000-000000000014',
  capitalNoticeWalled: 'b0000000-0000-4000-8000-000000000015',
  tradeTicketOpen: 'b0000000-0000-4000-8000-000000000016',
  tradeTicketWalled: 'b0000000-0000-4000-8000-000000000017',
  changeRequestOpen: 'b0000000-0000-4000-8000-000000000018',
  changeRequestWalled: 'b0000000-0000-4000-8000-000000000019',
  /** A second notice on the open investment with no ticket yet, so a ticket can be drafted on it. */
  capitalNoticeOpenDistribution: 'b0000000-0000-4000-8000-00000000001a',
} as const;

/** The synthetic bank details every fixture wire instruction carries, encrypted with the prototype key. */
export const FIXTURE_BANK_DETAILS: BankDetails = {
  bankName: 'Harbor Street Bank',
  accountName: 'Harborlight Fund IV',
  accountNumber: '4455667788',
  routingCode: '021000021',
};
export const fixtureCipher = new FieldCipher(DEV_FIELD_KEY);

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
    insert into ops.data_exception (id, source, entity, entity_id, rule_id, severity, state) values
      ('${ids.exceptionOpenDocument}', 'documents', 'doc.document', '${ids.documentOpen}', 'DOC-READ-01', 'exception_severity.high', 'open'),
      ('${ids.exceptionWalledDocument}', 'documents', 'doc.document', '${ids.documentWalled}', 'DOC-READ-01', 'exception_severity.high', 'open'),
      ('${ids.exceptionOpenRun}', 'extraction', 'doc.extraction_run', '${ids.extractionRunOpen}', 'EXT-RUN-01', 'exception_severity.high', 'open'),
      ('${ids.exceptionWalledRun}', 'extraction', 'doc.extraction_run', '${ids.extractionRunWalled}', 'EXT-RUN-01', 'exception_severity.high', 'open');
  `);
  // The Phase 3 controls (migration 0013). Base64 ciphertext carries no quotes, so it interpolates.
  const enc = encryptBankDetails(fixtureCipher, FIXTURE_BANK_DETAILS);
  const masked = maskBankDetails(FIXTURE_BANK_DETAILS);
  await handle.exec(`
    insert into deal.opportunity (id, name, company_name, portfolio_company_id, sponsor_id, sponsor_fund_id, deal_type, sector, geography, stage, owner_id, received_date, target_commitment) values
      ('${ids.opportunityOpen}', 'Project Saltmarsh II', 'Saltmarsh Holdings', '${ids.company1}', '${ids.sponsor}', '${ids.sponsorFund}', 'deal_type.co_invest_equity', 'sector.software', 'geography.north_america', 'Closing', '${u.dealTeam}', '2024-03-01', 10000000),
      ('${ids.opportunityWalled}', 'Project Tidewater II', 'Tidewater Diagnostics', '${ids.company2}', '${ids.sponsor}', '${ids.sponsorFund}', 'deal_type.co_invest_equity', 'sector.healthcare', 'geography.europe', 'Closing', '${u.wallMember}', '2024-04-01', 8000000);
    insert into core.walled_record (wall_id, entity, entity_id) values ('${ids.wall}', 'opportunity', '${ids.opportunityWalled}');
    insert into deal.opportunity_stage_history (id, opportunity_id, from_stage, to_stage, command, changed_by, changed_at) values
      ('${ids.stageHistoryOpen}', '${ids.opportunityOpen}', 'Approved', 'Closing', 'advance', '${u.dealTeam}', '2024-09-20T10:00:00Z'),
      ('${ids.stageHistoryWalled}', '${ids.opportunityWalled}', 'Approved', 'Closing', 'advance', '${u.wallMember}', '2024-09-21T10:00:00Z');
    insert into deal.diligence_task (id, opportunity_id, workstream, title, owner_id, status, required_for_ic) values
      ('${ids.diligenceTaskOpen}', '${ids.opportunityOpen}', 'diligence_workstream.financial', 'Quality of earnings review', '${u.dealTeam}', 'done', true),
      ('${ids.diligenceTaskWalled}', '${ids.opportunityWalled}', 'diligence_workstream.financial', 'Quality of earnings review', '${u.wallMember}', 'open', true);
    insert into deal.ic_decision (id, opportunity_id, decision_date, decision, amount, conditions, recorded_by) values
      ('${ids.icDecisionOpen}', '${ids.opportunityOpen}', '2024-09-15', 'approved', 10000000, '["Close by year end"]', '${u.approver}'),
      ('${ids.icDecisionWalled}', '${ids.opportunityWalled}', '2024-09-16', 'approved', 8000000, '[]', '${u.approver}');
    insert into deal.allocation (id, opportunity_id, investment_id, vehicle_id, client_id, requested, received) values
      ('${ids.allocationOpen}', '${ids.opportunityOpen}', null, '${ids.vehicle}', null, 10000000, null),
      ('${ids.allocationWalled}', '${ids.opportunityWalled}', null, '${ids.vehicle}', null, 8000000, null),
      ('${ids.allocationInvestment}', null, '${ids.investment1}', '${ids.vehicle}', null, 30000000, 30000000);
    insert into deal.closing (id, opportunity_id, investment_id, close_date, commitment_amount, state) values
      ('${ids.closingOpen}', '${ids.opportunityOpen}', null, '2024-10-31', 10000000, 'Open'),
      ('${ids.closingWalled}', '${ids.opportunityWalled}', null, '2024-11-15', 8000000, 'Open');
    insert into deal.closing_item (id, closing_id, item_code, label, required, status) values
      ('${ids.closingItemOpen}', '${ids.closingOpen}', 'signed_documents', 'Signed subscription and transaction documents', true, 'open'),
      ('${ids.closingItemWalled}', '${ids.closingWalled}', 'signed_documents', 'Signed subscription and transaction documents', true, 'open');
    insert into deal.legal_term (id, closing_id, term_type, value, status) values
      ('${ids.legalTermOpen}', '${ids.closingOpen}', 'legal_term_type.management_fee', '{"rate": "0.0100"}', 'draft'),
      ('${ids.legalTermWalled}', '${ids.closingWalled}', 'legal_term_type.management_fee', '{"rate": "0.0125"}', 'draft');
    insert into mon.wire_instruction (id, investment_id, counterparty_name, version, bank_details_enc, bank_details_masked, state, proposed_by, proposed_at, source_note, callback_by, callback_at, callback_number_source, callback_result, verified_at, active) values
      ('${ids.wireInstructionVerified}', '${ids.investment1}', 'Harborlight Fund IV', 1, '${enc}', '${masked}', 'Verified', '${u.operations}', '2024-08-01T09:00:00Z', 'Subscription documents at close', '${u.operations2}', '2024-08-02T15:00:00Z', 'prior_instruction', 'confirmed', '2024-08-02T15:05:00Z', true),
      ('${ids.wireInstructionProposed}', '${ids.investment1}', 'Harborlight Fund IV', 2, '${enc}', '${masked}', 'Proposed', '${u.operations}', '2024-09-02T09:00:00Z', 'Changed instructions received in the notice', null, null, null, null, null, false);
    insert into mon.capital_notice (id, notice_type, vehicle_id, investment_id, issue_date, due_date, amount, state, wire_change_flag, urgency_flag, funded_at, funded_by) values
      ('${ids.capitalNoticeOpen}', 'notice_type.capital_call', '${ids.vehicle}', '${ids.investment1}', '2024-09-01', '2024-09-15', 2000000, 'Funded', true, true, '2024-09-15T14:00:00Z', '${u.operations}'),
      ('${ids.capitalNoticeOpenDistribution}', 'notice_type.distribution', '${ids.vehicle}', '${ids.investment1}', '2024-10-01', '2024-10-15', 500000, 'Reviewed', false, false, null, null),
      ('${ids.capitalNoticeWalled}', 'notice_type.capital_call', '${ids.vehicle}', '${ids.investmentWalled}', '2024-09-05', '2024-09-20', 1000000, 'TicketDrafted', false, false, null, null);
    insert into mon.trade_ticket (id, capital_notice_id, wire_instruction_id, amount, funding_date, prepared_by, prepared_at, approved_by, approved_at, state) values
      ('${ids.tradeTicketOpen}', '${ids.capitalNoticeOpen}', '${ids.wireInstructionVerified}', 2000000, '2024-09-15', '${u.operations}', '2024-09-03T09:00:00Z', '${u.approver}', '2024-09-04T09:00:00Z', 'Funded'),
      ('${ids.tradeTicketWalled}', '${ids.capitalNoticeWalled}', null, 1000000, '2024-09-20', '${u.operations}', '2024-09-06T09:00:00Z', null, null, 'Drafted');
    insert into mon.deal_change_request (id, investment_id, change_type, effective_date, summary, owner_id, submitted_by, state) values
      ('${ids.changeRequestOpen}', '${ids.investment1}', 'change_type.add_on_acquisition', '2024-08-15', 'Add-on acquisition of a regional competitor closed', null, '${u.dealTeam}', 'Submitted'),
      ('${ids.changeRequestWalled}', '${ids.investmentWalled}', 'change_type.recapitalization', '2024-08-20', 'Dividend recapitalization completed', '${u.operations}', '${u.wallMember}', 'Routed');
  `);
}
