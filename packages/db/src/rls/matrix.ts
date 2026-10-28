import { encryptBankDetails, maskBankDetails } from '../fieldCrypto.js';
import { FIXTURE_BANK_DETAILS, fixtureCipher } from './fixture.js';

/**
 * The access matrix (docs/12 section 1): expected visible row counts per actor and table on the
 * fixture, and which actors may perform a representative write. Tests are generated from this
 * table so every cell is a positive or negative test (SEC-5.1, SEC-5.2, SEC-5.3, SEC-5.4).
 */
export type ActorName =
  | 'viewer'
  | 'deal_team'
  | 'operations'
  | 'approver'
  | 'investor_relations(A)'
  | 'platform_admin'
  | 'auditor'
  | 'wall_member(deal_team)'
  | 'service';

export const ACTOR_NAMES: ActorName[] = [
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations(A)',
  'platform_admin',
  'auditor',
  'wall_member(deal_team)',
  'service',
];

type Row = Record<ActorName, number>;
const row = (
  v: number,
  dt: number,
  ops: number,
  ap: number,
  ir: number,
  admin: number,
  aud: number,
  wm: number,
  svc: number,
): Row => ({
  viewer: v,
  deal_team: dt,
  operations: ops,
  approver: ap,
  'investor_relations(A)': ir,
  platform_admin: admin,
  auditor: aud,
  'wall_member(deal_team)': wm,
  service: svc,
});

/**
 * Visible row counts. Columns: viewer, deal_team, operations, approver, IR(A), platform_admin,
 * auditor, wall member, service (the system actor: it sees walled records, migration 0008, and
 * holds no client entitlement, no wall membership and no audit or history read).
 */
export const READ_MATRIX: Record<string, Row> = {
  'core.investment': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'core.sponsor': row(1, 1, 1, 1, 1, 1, 1, 1, 1),
  'core.vehicle': row(1, 1, 1, 1, 1, 1, 1, 1, 1),
  'core.client': row(0, 0, 2, 2, 1, 0, 2, 0, 0),
  'core.lp_commitment': row(0, 0, 2, 2, 1, 0, 2, 0, 0),
  'core.commitment': row(1, 1, 2, 2, 1, 1, 2, 1, 1),
  'core.wall': row(0, 0, 0, 1, 0, 1, 0, 1, 0),
  'core.wall_member': row(0, 0, 0, 1, 0, 1, 0, 1, 0),
  // The walled investment and the walled opportunity (migration 0013) share the fixture wall.
  'core.walled_record': row(0, 0, 0, 2, 0, 2, 0, 2, 0),
  'mon.quarterly_performance': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'mon.valuation': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'mon.cash_flow': row(2, 2, 2, 2, 2, 2, 2, 3, 3),
  'mon.valuation_history': row(0, 0, 2, 2, 0, 0, 2, 0, 0),
  'ops.feature_flag': row(10, 10, 10, 10, 10, 10, 10, 10, 10),
  // An exception about a staged row, a document or an extraction run is visible to whoever that
  // record's own policy admits (migrations 0010 and 0012): three fixture exceptions are about the
  // open, the walled and the unlinked accounting row (reviewers only), and four are about the open
  // and the walled document and run (every authenticated user, under the wall).
  'ops.data_exception': row(2, 4, 4, 4, 2, 2, 4, 7, 7),
  'audit.event': row(0, 0, 2, 2, 0, 2, 2, 0, 0),
  // Staging: reviewers (operations, deal team, approver, auditor) and the service read files, and
  // rows under the wall of the investment they link to (migration 0009); an unlinked row is every
  // reviewer's. Three rows: linked to the open investment, linked to the walled one, unlinked.
  'stg.intake_file': row(0, 1, 1, 1, 0, 0, 1, 1, 1),
  'stg.intake_row': row(0, 2, 2, 2, 0, 0, 2, 3, 3),
  // Weekly values carry the wall of the investment they link to the same way (migration 0010).
  'stg.valuation': row(0, 2, 2, 2, 0, 0, 2, 3, 3),
  'core.company_alias': row(1, 1, 1, 1, 1, 1, 1, 1, 1),
  // Documents carry the wall of the investment they are attached to, and so do their expected
  // rows, runs and values (migration 0011); every authenticated user reads the rest. One document
  // per investment, one of them walled, each with one run and two values.
  'doc.document': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'doc.expected_document': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'doc.extraction_run': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'stg.extracted_value': row(2, 2, 2, 2, 2, 2, 2, 4, 4),
  // The Phase 3 controls (migration 0013). The wire register is an operations control read by
  // operations, approvers, auditors, platform admins and the system actor only, and it is not
  // under the investment wall (both fixture versions are on the open investment); its history
  // reads like every history table. Tickets follow their notice; notices, change requests and
  // every deal table carry the wall of the investment or the opportunity they belong to.
  'mon.wire_instruction': row(0, 0, 2, 2, 0, 2, 2, 0, 2),
  'mon.wire_instruction_history': row(0, 0, 2, 2, 0, 0, 2, 0, 0),
  'mon.capital_notice': row(2, 2, 2, 2, 2, 2, 2, 3, 3),
  'mon.trade_ticket': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'mon.trade_ticket_history': row(0, 0, 2, 2, 0, 0, 2, 0, 0),
  'mon.deal_change_request': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'deal.opportunity': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'deal.opportunity_stage_history': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'deal.diligence_task': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'deal.ic_decision': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  // Two allocations on the opportunities and one on the open investment.
  'deal.allocation': row(2, 2, 2, 2, 2, 2, 2, 3, 3),
  'deal.closing': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'deal.closing_item': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'deal.legal_term': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
};

export interface WriteCase {
  name: string;
  sql: string;
  allowed: ActorName[];
}

/** Representative writes. Everyone not listed must be rejected by RLS or a missing grant. */
export const WRITE_MATRIX: WriteCase[] = [
  {
    name: 'insert a sponsor',
    sql: "insert into core.sponsor (name, canonical_name, tier) values ('New Sponsor', 'new sponsor', 'sponsor_tier.new')",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'insert a client (Restricted)',
    sql: "insert into core.client (name) values ('Client Gamma')",
    allowed: ['operations', 'service'],
  },
  {
    name: 'flip a feature flag',
    sql: "update ops.feature_flag set enabled = true where key = 'ai.extraction'",
    // Kill switches: an administrator, or the system actor on behalf of Beach Ops (docs/15).
    allowed: ['platform_admin', 'service'],
  },
  {
    name: 'insert a taxonomy term',
    sql: "insert into core.taxonomy_term (domain, code, label) values ('sector', 'sector.test', 'Test')",
    allowed: ['operations', 'platform_admin'],
  },
  {
    name: 'create a wall',
    sql: "insert into core.wall (name) values ('Project Dune')",
    allowed: ['approver', 'platform_admin'],
  },
  {
    name: 'insert a cash flow on a visible investment',
    sql: "insert into mon.cash_flow (investment_id, flow_date, flow_type, amount) values ('30000000-0000-4000-8000-000000000001', '2024-09-30', 'flow_type.distribution', 1000000)",
    allowed: ['operations', 'service'],
  },
  {
    name: 'update a visible investment',
    sql: "update core.investment set is_active = true where id = '30000000-0000-4000-8000-000000000001'",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'append an audit event',
    sql: "insert into audit.event (actor_type, action, entity) values ('user', 'test', 'test')",
    allowed: ACTOR_NAMES,
  },
  {
    name: 'insert a valuation on the walled investment',
    sql: "insert into mon.valuation (investment_id, period_end, version, method, fair_value) values ('30000000-0000-4000-8000-000000000002', '2024-09-30', 1, 'valuation_method.cost', 1)",
    // Only the system actor, which promotes approved staging rows for every position (migration 0008).
    allowed: ['service'],
  },
  {
    name: 'insert a staging file',
    sql: "insert into stg.intake_file (source, file_name, content_hash) values ('accounting', 'accounting-export-2024-09-30.csv', 'fixture-hash-0002')",
    // Import is operations' and the service's; the deal team reviews what was imported (migration 0007).
    allowed: ['operations', 'service'],
  },
  {
    name: 'update the status of a staged row linked to the open investment',
    sql: "update stg.intake_row set status = 'approved' where id = '80000000-0000-4000-8000-000000000002'",
    allowed: ['operations', 'deal_team', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'update the status of a staged row linked to the walled investment',
    sql: "update stg.intake_row set status = 'approved' where id = '80000000-0000-4000-8000-000000000003'",
    // The wall on the investment is the wall on its staged row (migration 0009): only a member or
    // the system actor can act on it; everyone else is shown no such row.
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'insert a company alias',
    sql: "insert into core.company_alias (portfolio_company_id, alias) values ('20000000-0000-4000-8000-000000000003', 'Saltmarsh Holdings Group')",
    allowed: ['operations', 'platform_admin'],
  },
  {
    name: 'insert a staged weekly value',
    sql: "insert into stg.valuation (row_no, report_date, investment_number, reported_value) values (9, '2024-07-12', 'INV-0001', 1)",
    allowed: ['operations', 'service'],
  },
  {
    name: 'update the status of a staged weekly value linked to the open investment',
    sql: "update stg.valuation set status = 'approved' where id = '80000000-0000-4000-8000-000000000005'",
    allowed: ['operations', 'deal_team', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'update the status of a staged weekly value linked to the walled investment',
    sql: "update stg.valuation set status = 'approved' where id = '80000000-0000-4000-8000-000000000006'",
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'acknowledge a data exception about a visible row',
    sql: "update ops.data_exception set state = 'acknowledged' where id = '90000000-0000-4000-8000-000000000001'",
    // Operations works the exception queue (docs/18 section 9, migration 0010).
    allowed: ['operations'],
  },
  {
    name: 'acknowledge a data exception about the walled row',
    sql: "update ops.data_exception set state = 'acknowledged' where id = '90000000-0000-4000-8000-000000000002'",
    // The select policy hides it from everyone outside the wall; the wall member is deal team and
    // may not update exceptions, so nobody in the fixture can (migration 0010).
    allowed: [],
  },
  {
    name: 'set the external ticket of a data exception',
    sql: "update ops.data_exception set external_ticket = 'HD-10452' where id = '90000000-0000-4000-8000-000000000003'",
    allowed: ['operations'],
  },
  {
    name: 'change what a data exception expected',
    sql: "update ops.data_exception set expected = 'something else' where id = '90000000-0000-4000-8000-000000000003'",
    // The figures an exception carries are written once by the intake that opened it (column grant).
    allowed: [],
  },
  {
    name: 'index a document',
    sql: "insert into doc.document (source_system, source_item_id, file_name, folder, title, content_hash, size_bytes, received_at) values ('local_folder', 'inbox/scan_0001.pdf', 'scan_0001.pdf', 'inbox', 'scan_0001', 'fixture-doc-hash-0003', 4096, '2024-08-12T09:00:00Z')",
    // The index is operations' and the service's (migration 0011).
    allowed: ['operations', 'service'],
  },
  {
    name: 'classify the document attached to the open investment',
    sql: "update doc.document set review_status = 'Classified', doc_type = 'doc_type.quarterly_letter' where id = 'a0000000-0000-4000-8000-000000000001'",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'classify the document attached to the walled investment',
    sql: "update doc.document set review_status = 'Classified', doc_type = 'doc_type.quarterly_letter' where id = 'a0000000-0000-4000-8000-000000000002'",
    // The wall on the investment is the wall on its document: everyone else is shown no such row.
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'insert an expected document',
    sql: "insert into doc.expected_document (investment_id, period_end, doc_type, due_date) values ('30000000-0000-4000-8000-000000000001', '2024-09-30', 'doc_type.quarterly_financials', '2024-11-14')",
    allowed: ['operations', 'service'],
  },
  {
    name: 'insert an expected document on the walled investment',
    sql: "insert into doc.expected_document (investment_id, period_end, doc_type, due_date) values ('30000000-0000-4000-8000-000000000002', '2024-09-30', 'doc_type.quarterly_financials', '2024-11-14')",
    // Operations outside the wall cannot attach a row to a position it cannot see; the service can.
    allowed: ['service'],
  },
  {
    name: 'queue an extraction run on the open document',
    sql: "insert into doc.extraction_run (document_id, investment_id, period_end, schema_id, prompt_id, prompt_version) values ('a0000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '2024-06-30', 'quarterly_financials', 'quarterly_extraction', '1')",
    allowed: ['operations', 'service'],
  },
  {
    name: 'approve the extraction run on the open investment',
    sql: "update doc.extraction_run set approved_by = '10000000-0000-4000-8000-000000000002', approved_at = now() where id = 'a0000000-0000-4000-8000-000000000005'",
    // The deal team approves what it reviewed; operations and the service drive the run.
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'approve the extraction run on the walled investment',
    sql: "update doc.extraction_run set approved_by = '10000000-0000-4000-8000-000000000008', approved_at = now() where id = 'a0000000-0000-4000-8000-000000000006'",
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'insert an extracted value',
    sql: "insert into stg.extracted_value (run_id, investment_id, field, value, unit, page, quote, confidence) values ('a0000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000001', 'ev', '360.00', 'USD_M', 2, 'Enterprise value 360.00', 0.9)",
    // Only the system actor writes what a model answered (SEC-9.1).
    allowed: ['service'],
  },
  {
    name: 'record a decision on an extracted value of the open run',
    sql: "update stg.extracted_value set decision = 'accepted', reviewer_id = '10000000-0000-4000-8000-000000000002', decided_at = now() where id = 'a0000000-0000-4000-8000-000000000008'",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'record an edit with its own unit on an extracted value of the open run',
    sql: "update stg.extracted_value set decision = 'edited', edited_value = '30000', edited_unit = 'USD_K', reviewer_id = '10000000-0000-4000-8000-000000000002', decided_at = now() where id = 'a0000000-0000-4000-8000-000000000008'",
    // The edit keeps its own unit beside the model's (migration 0012), under the same review policy.
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'record a decision on an extracted value of the walled run',
    sql: "update stg.extracted_value set decision = 'accepted', reviewer_id = '10000000-0000-4000-8000-000000000008', decided_at = now() where id = 'a0000000-0000-4000-8000-00000000000a'",
    allowed: ['wall_member(deal_team)', 'service'],
  },
  // The Phase 3 controls (migration 0013).
  {
    name: 'propose a wire instruction version on the open investment',
    sql: `insert into mon.wire_instruction (investment_id, counterparty_name, version, bank_details_enc, bank_details_masked, proposed_by) values ('30000000-0000-4000-8000-000000000001', 'Harborlight Fund IV', 3, '${encryptBankDetails(fixtureCipher, FIXTURE_BANK_DETAILS)}', '${maskBankDetails(FIXTURE_BANK_DETAILS)}', '10000000-0000-4000-8000-000000000003')`,
    // The register is operations' and the system actor's (SEC-12.2).
    allowed: ['operations', 'service'],
  },
  {
    name: 'record the callback on the proposed wire instruction',
    sql: "update mon.wire_instruction set state = 'Verified', callback_by = '10000000-0000-4000-8000-000000000009', callback_at = now(), callback_number_source = 'prior_instruction', callback_result = 'confirmed', verified_at = now() where id = 'b0000000-0000-4000-8000-000000000013'",
    // Operations and approvers verify; auditors and platform admins read the register only.
    allowed: ['operations', 'approver', 'service'],
  },
  {
    name: 'draft a trade ticket on the open distribution notice',
    sql: "insert into mon.trade_ticket (capital_notice_id, amount, funding_date, prepared_by) values ('b0000000-0000-4000-8000-00000000001a', 500000, '2024-10-15', '10000000-0000-4000-8000-000000000003')",
    allowed: ['operations', 'service'],
  },
  {
    name: 'move the funding date of the ticket on the open notice',
    sql: "update mon.trade_ticket set funding_date = '2024-09-16' where id = 'b0000000-0000-4000-8000-000000000016'",
    allowed: ['operations', 'approver', 'service'],
  },
  {
    name: 'approve the drafted ticket on the walled notice',
    sql: "update mon.trade_ticket set state = 'Approved', approved_by = '10000000-0000-4000-8000-000000000004', approved_at = now(), wire_instruction_id = 'b0000000-0000-4000-8000-000000000012' where id = 'b0000000-0000-4000-8000-000000000017'",
    // The ticket follows its notice into the wall; the wall member is deal team and may not approve.
    allowed: ['service'],
  },
  {
    name: 'submit a change request on the open investment',
    sql: "insert into mon.deal_change_request (investment_id, change_type, effective_date, summary, submitted_by) values ('30000000-0000-4000-8000-000000000001', 'change_type.name_change', '2024-09-01', 'Company renamed after the merger', '10000000-0000-4000-8000-000000000002')",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'submit a change request on the walled investment',
    sql: "insert into mon.deal_change_request (investment_id, change_type, effective_date, summary, submitted_by) values ('30000000-0000-4000-8000-000000000002', 'change_type.name_change', '2024-09-01', 'Company renamed after the merger', '10000000-0000-4000-8000-000000000008')",
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'route the change request on the open investment',
    sql: "update mon.deal_change_request set state = 'Routed', owner_id = '10000000-0000-4000-8000-000000000003' where id = 'b0000000-0000-4000-8000-000000000018'",
    // Operations works the request (docs/18 section 8).
    allowed: ['operations', 'service'],
  },
  {
    name: 'create an opportunity',
    sql: "insert into deal.opportunity (name, company_name, sponsor_id, deal_type, received_date) values ('Project Driftwood', 'Driftwood Logistics', '20000000-0000-4000-8000-000000000001', 'deal_type.co_invest_equity', '2024-10-01')",
    allowed: ['deal_team', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'set the target commitment of the open opportunity',
    sql: "update deal.opportunity set target_commitment = 15000000 where id = 'b0000000-0000-4000-8000-000000000001'",
    allowed: ['deal_team', 'operations', 'approver', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'set the target commitment of the walled opportunity',
    sql: "update deal.opportunity set target_commitment = 9000000 where id = 'b0000000-0000-4000-8000-000000000002'",
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'record a stage change on the open opportunity',
    sql: "insert into deal.opportunity_stage_history (opportunity_id, from_stage, to_stage, command, changed_by) values ('b0000000-0000-4000-8000-000000000001', 'Closing', 'Closed', 'advance', '10000000-0000-4000-8000-000000000002')",
    allowed: ['deal_team', 'operations', 'approver', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'record a stage change on the walled opportunity',
    sql: "insert into deal.opportunity_stage_history (opportunity_id, from_stage, to_stage, command, changed_by) values ('b0000000-0000-4000-8000-000000000002', 'Closing', 'Closed', 'advance', '10000000-0000-4000-8000-000000000008')",
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'rewrite a stage history row',
    sql: "update deal.opportunity_stage_history set reason = 'rewritten' where id = 'b0000000-0000-4000-8000-000000000003'",
    // Append-only: no update is granted to anyone.
    allowed: [],
  },
  {
    name: 'add a diligence task on the open opportunity',
    sql: "insert into deal.diligence_task (opportunity_id, workstream, title) values ('b0000000-0000-4000-8000-000000000001', 'diligence_workstream.tax', 'Tax structuring memo')",
    allowed: ['deal_team', 'approver', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'complete the diligence task on the walled opportunity',
    sql: "update deal.diligence_task set status = 'done' where id = 'b0000000-0000-4000-8000-000000000006'",
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'record an IC decision on the open opportunity',
    sql: "insert into deal.ic_decision (opportunity_id, decision_date, decision, recorded_by) values ('b0000000-0000-4000-8000-000000000001', '2024-10-20', 'deferred', '10000000-0000-4000-8000-000000000004')",
    allowed: ['approver', 'service'],
  },
  {
    name: 'change an IC decision',
    sql: "update deal.ic_decision set decision = 'declined' where id = 'b0000000-0000-4000-8000-000000000007'",
    // A decision is never edited: a new row supersedes it.
    allowed: [],
  },
  {
    name: 'add a client allocation on the open opportunity',
    sql: "insert into deal.allocation (opportunity_id, vehicle_id, client_id, requested) values ('b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000001', 6000000)",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'delete the allocation on the open opportunity',
    sql: "delete from deal.allocation where id = 'b0000000-0000-4000-8000-000000000009'",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'delete the allocation on the walled opportunity',
    sql: "delete from deal.allocation where id = 'b0000000-0000-4000-8000-00000000000a'",
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'open a closing on the open investment',
    sql: "insert into deal.closing (investment_id, close_date, commitment_amount) values ('30000000-0000-4000-8000-000000000001', '2022-03-15', 30000000)",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'confirm the closing of the open opportunity',
    sql: "update deal.closing set state = 'OpsConfirmed', ops_confirmed_by = '10000000-0000-4000-8000-000000000003', ops_confirmed_at = now() where id = 'b0000000-0000-4000-8000-00000000000c'",
    // Operations confirms (docs/04 M8).
    allowed: ['operations', 'service'],
  },
  {
    name: 'confirm the closing of the walled opportunity',
    sql: "update deal.closing set state = 'OpsConfirmed', ops_confirmed_by = '10000000-0000-4000-8000-000000000003', ops_confirmed_at = now() where id = 'b0000000-0000-4000-8000-00000000000d'",
    allowed: ['service'],
  },
  {
    name: 'receive the checklist item of the open closing',
    sql: "update deal.closing_item set status = 'received', document_id = 'a0000000-0000-4000-8000-000000000001' where id = 'b0000000-0000-4000-8000-00000000000e'",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'receive the checklist item of the walled closing',
    sql: "update deal.closing_item set status = 'received', document_id = 'a0000000-0000-4000-8000-000000000002' where id = 'b0000000-0000-4000-8000-00000000000f'",
    allowed: ['wall_member(deal_team)', 'service'],
  },
  {
    name: 'add a legal term on the open closing',
    sql: `insert into deal.legal_term (closing_id, term_type, value) values ('b0000000-0000-4000-8000-00000000000c', 'legal_term_type.mfn', '{"granted": true}')`,
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'confirm the legal term of the walled closing',
    sql: "update deal.legal_term set status = 'confirmed', confirmed_by = '10000000-0000-4000-8000-000000000008', confirmed_at = now() where id = 'b0000000-0000-4000-8000-000000000011'",
    allowed: ['wall_member(deal_team)', 'service'],
  },
];
