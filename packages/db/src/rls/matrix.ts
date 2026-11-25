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
  // Client data (SEC-5.2, SEC-5.4): operations, the investment team (the deal team and approvers)
  // and the auditor read every client (pb.sees_all_clients, migration 0017: the owner's decision
  // of 2026-11-11 added the deal team, so the wall member, who is deal team, reads them too);
  // investor relations (A) reads its one client; a viewer, a platform admin and the system actor
  // read none. Three clients, one of them with no commitment and no allocation line.
  'core.client': row(0, 3, 3, 3, 1, 0, 3, 3, 0),
  'core.lp_commitment': row(0, 2, 2, 2, 1, 0, 2, 2, 0),
  // The pooled commitment is everyone's; the separate account of Client Beta follows the client.
  'core.commitment': row(1, 2, 2, 2, 1, 1, 2, 2, 1),
  // Two walls: the fixture wall with its one member, and a second wall nobody in the fixture
  // belongs to (migration 0016).
  'core.wall': row(0, 0, 0, 2, 0, 2, 0, 1, 0),
  'core.wall_member': row(0, 0, 0, 1, 0, 1, 0, 1, 0),
  // The walled investment and the walled opportunity (migration 0013) share the fixture wall, and
  // the second wall covers the walled investment too. A member reads the rows of their own walls
  // only (two of the three), and the service role reads them all to carry the walls of a deal to
  // the position it becomes (migration 0016).
  'core.walled_record': row(0, 0, 0, 3, 0, 3, 0, 2, 3),
  'mon.quarterly_performance': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'mon.valuation': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'mon.cash_flow': row(2, 2, 2, 2, 2, 2, 2, 3, 3),
  'mon.valuation_history': row(0, 0, 2, 2, 0, 0, 2, 0, 0),
  'ops.feature_flag': row(11, 11, 11, 11, 11, 11, 11, 11, 11),
  // An exception about a staged row, a document, an extraction run or a change request is visible
  // to whoever that record's own policy admits (migrations 0010, 0012 and 0014): three fixture
  // exceptions are about the open, the walled and the unlinked accounting row (reviewers only), four
  // are about the open and the walled document and run, and two about the open and the walled
  // change request (every authenticated user, under the wall).
  'ops.data_exception': row(3, 5, 5, 5, 3, 3, 5, 9, 9),
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
  // rows, runs and values (migration 0011); every authenticated user reads the rest. A quarterly
  // report per investment, one of them walled, each expected, with one run and two values; and
  // for the next quarter (migration 0023) a report and a capital account statement on the open
  // investment and a statement on the walled one, each with one approved run and no staged value.
  'doc.document': row(3, 3, 3, 3, 3, 3, 3, 5, 5),
  'doc.expected_document': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'doc.extraction_run': row(3, 3, 3, 3, 3, 3, 3, 5, 5),
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
  // Five lines: a vehicle-level line on each opportunity and on the open investment, and a line
  // for Client Alpha and for Client Beta on the open opportunity. A vehicle-level line follows its
  // deal; a client line is read by whoever reads that client (migration 0017): every role that
  // reads all clients, investor relations (A) for its client, and the system actor, whose totals
  // read keeps the tie-out the same for every reader. A viewer and a platform admin read the two
  // vehicle-level lines of the visible deals only.
  'deal.allocation': row(2, 4, 4, 4, 3, 2, 4, 5, 5),
  'deal.closing': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'deal.closing_item': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'deal.legal_term': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  // The Idempotency-Key store (migration 0015): a row is its owner's and nobody else's, the
  // system actor, the auditor and the platform admin included. The fixture holds one completed
  // key of operations and one pending key of the deal team.
  'ops.idempotency_key': row(0, 1, 1, 0, 0, 0, 0, 0, 0),
  // Reporting packages and their QA findings (migration 0019, SEC-5.2): client data. The roles
  // that read every client read both packages; investor relations (A) reads client Alpha's and
  // its two findings; a viewer and a platform admin read none; the system actor reads both,
  // because it runs the QA step.
  'rpt.package': row(0, 2, 2, 2, 1, 0, 2, 2, 2),
  'rpt.qa_result': row(0, 3, 3, 3, 2, 0, 3, 3, 3),
  // Their history reads like every history table: operations, approvers and the auditor, and
  // nobody else. A package's history holds every snapshot it ever showed, so investor relations
  // entitled to the client, who read the package itself, do not read its past images, and
  // neither does the deal team. One image per insert: two packages and three findings.
  'rpt.package_history': row(0, 0, 2, 2, 0, 0, 2, 0, 0),
  'rpt.qa_result_history': row(0, 0, 3, 3, 0, 0, 3, 0, 0),
  // The underwritten base cases (migration 0021) follow their position: everyone reads the case
  // of the open investment and its two plan points; the two cases of the walled investment (one
  // Confirmed, one Draft) and their four points are read inside the wall and by the system actor
  // only. The history reads like every history table: five images of a case (three inserts and
  // two confirmations) and six of a point.
  'mon.underwriting_case': row(1, 1, 1, 1, 1, 1, 1, 3, 3),
  'mon.underwriting_case_point': row(2, 2, 2, 2, 2, 2, 2, 6, 6),
  'mon.underwriting_case_history': row(0, 0, 5, 5, 0, 0, 5, 0, 0),
  'mon.underwriting_case_point_history': row(0, 0, 6, 6, 0, 0, 6, 0, 0),
  // Valuation suggestions (migration 0023, SEC-5.1, SEC-5.3): operations, the deal team,
  // approvers, auditors and the system actor read them, under the wall of the position; a
  // viewer, investor relations and a platform admin are given nothing, though they can open the
  // position. Two on the open investment (one Superseded, the Open one that replaced it) and an
  // Open one on the walled investment. The history reads like every history table: three inserts
  // and the supersession.
  'mon.valuation_suggestion': row(0, 2, 2, 2, 0, 0, 2, 3, 3),
  'mon.valuation_suggestion_history': row(0, 0, 4, 4, 0, 0, 4, 0, 0),
};

export interface WriteCase {
  name: string;
  sql: string;
  /**
   * A statement the same actor sends first, in the same transaction, when the write is one no
   * service sends alone (a plan point is written by whoever has just claimed its Draft). Row-level
   * security may hide its row from the actor, and then it does nothing; the write is still judged
   * on its own.
   */
  before?: string;
  allowed: ActorName[];
}

/** The claim an edit of a Draft makes: its sender becomes the last person to change the figures. */
const CLAIM_WALLED_DRAFT =
  "update mon.underwriting_case set entered_by = pb.current_user_id(), entered_at = now() where id = 'd0000000-0000-4000-8000-000000000003'";

/** A decision on a valuation suggestion names whoever takes it, and when. */
const SUGGESTION_DECIDED = 'decided_by = pb.current_user_id(), decided_at = now()';

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
  // The Idempotency-Key store (migration 0015): each case names one owner, so only that actor may.
  {
    name: 'reserve an idempotency key that names the viewer as its owner',
    sql: "insert into ops.idempotency_key (user_id, method, path, key, request_hash) values ('10000000-0000-4000-8000-000000000001', 'POST', '/api/v1/valuations', 'matrix-key-viewer', 'sealed')",
    allowed: ['viewer'],
  },
  {
    name: 'insert an idempotency key that already carries an answer',
    sql: `insert into ops.idempotency_key (user_id, method, path, key, request_hash, response_status, response_body) values (pb.current_user_id(), 'POST', '/api/v1/valuations', 'matrix-key-forged', 'sealed', 201, '{}')`,
    // A key is reserved first and completed by the request that ran: nobody writes an answer outright.
    allowed: [],
  },
  {
    name: "complete the deal team's pending idempotency key",
    sql: `update ops.idempotency_key set response_status = 200, response_body = '{"ok": true}' where key = 'fixture-key-pending'`,
    allowed: ['deal_team'],
  },
  {
    name: "release the deal team's pending idempotency key",
    sql: "delete from ops.idempotency_key where key = 'fixture-key-pending'",
    allowed: ['deal_team'],
  },
  {
    name: 'rewrite the answer of the completed idempotency key of operations',
    sql: `update ops.idempotency_key set response_body = '{"rewritten": true}' where key = 'fixture-key-completed'`,
    // A stored answer never changes, not even for its owner.
    allowed: [],
  },
  {
    name: 'delete the completed idempotency key of operations',
    sql: "delete from ops.idempotency_key where key = 'fixture-key-completed'",
    allowed: [],
  },
  {
    name: 'change the request an idempotency key was reserved for',
    sql: "update ops.idempotency_key set request_hash = 'another' where key = 'fixture-key-pending'",
    // Only the answer columns are granted for update (column grant).
    allowed: [],
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
    // The third client: the fixture already holds a line for each of the other two (migration 0017).
    name: 'add a client allocation on the open opportunity',
    sql: "insert into deal.allocation (opportunity_id, vehicle_id, client_id, requested) values ('b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000003', 6000000)",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'set the received amount of the Client Beta line on the open opportunity',
    sql: "update deal.allocation set received = 4000000 where id = 'b0000000-0000-4000-8000-00000000001e'",
    // The writers read every client line, so none is left out of a write (migration 0017).
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)', 'service'],
  },
  {
    name: 'delete the Client Alpha line on the open opportunity',
    sql: "delete from deal.allocation where id = 'b0000000-0000-4000-8000-00000000001d'",
    // Investor relations (A) reads this line and still may not write it.
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
  // The walls (migration 0016): the system step carries a wall to a position and to nothing else.
  {
    name: 'put the open investment behind the second wall',
    sql: "insert into core.walled_record (wall_id, entity, entity_id) values ('60000000-0000-4000-8000-000000000002', 'investment', '30000000-0000-4000-8000-000000000001')",
    allowed: ['approver', 'platform_admin', 'service'],
  },
  {
    name: 'put the open opportunity behind the second wall',
    sql: "insert into core.walled_record (wall_id, entity, entity_id) values ('60000000-0000-4000-8000-000000000002', 'opportunity', 'b0000000-0000-4000-8000-000000000001')",
    allowed: ['approver', 'platform_admin'],
  },
  {
    name: 'take the walled investment out from behind the second wall',
    sql: "delete from core.walled_record where wall_id = '60000000-0000-4000-8000-000000000002' and entity = 'investment' and entity_id = '30000000-0000-4000-8000-000000000002'",
    allowed: ['approver', 'platform_admin'],
  },
  // The review fixes (migration 0014).
  {
    name: 'work the quarter-end exception about the open change request',
    sql: "update ops.data_exception set state = 'acknowledged' where id = 'b0000000-0000-4000-8000-00000000001b'",
    allowed: ['operations'],
  },
  {
    name: 'work the quarter-end exception about the walled change request',
    sql: "update ops.data_exception set state = 'acknowledged' where id = 'b0000000-0000-4000-8000-00000000001c'",
    // Hidden from everyone outside the wall (migration 0014); the wall member is deal team and may
    // not work the queue, so nobody in the fixture can.
    allowed: [],
  },
  // Reporting packages (migration 0019, docs/18 section 5).
  {
    name: 'prepare a reporting package for client Alpha',
    sql: "insert into rpt.package (client_id, period_end, as_of, basis, label, prepared_by) values ('40000000-0000-4000-8000-000000000001', '2024-09-30', '2024-11-08', 'net', 'preliminary', '10000000-0000-4000-8000-000000000005')",
    // Investor relations entitled to the client, or the system actor.
    allowed: ['investor_relations(A)', 'service'],
  },
  {
    name: 'prepare a reporting package for client Beta',
    sql: "insert into rpt.package (client_id, period_end, as_of, basis, label, prepared_by) values ('40000000-0000-4000-8000-000000000002', '2024-09-30', '2024-11-08', 'net', 'preliminary', '10000000-0000-4000-8000-000000000005')",
    // Investor relations (A) is not entitled to Beta.
    allowed: ['service'],
  },
  {
    name: 'move the reporting package of client Alpha on',
    sql: "update rpt.package set label = 'preliminary' where id = 'c0000000-0000-4000-8000-000000000001'",
    // The roles the state machine names, each within the clients it reads.
    allowed: ['operations', 'approver', 'investor_relations(A)', 'service'],
  },
  {
    name: 'move the reporting package of client Beta on',
    sql: "update rpt.package set label = 'preliminary' where id = 'c0000000-0000-4000-8000-000000000002'",
    allowed: ['operations', 'approver', 'service'],
  },
  {
    name: 'record a QA finding on the package of client Alpha',
    sql: "insert into rpt.qa_result (package_id, run_no, rule, entity_ref, passed, detail) values ('c0000000-0000-4000-8000-000000000001', 2, 'QA-LBL-01', 'status', true, 'The package is labelled final.')",
    // The QA step is the system actor's; no person types a finding.
    allowed: ['service'],
  },
  {
    name: 'override a failed QA finding on the package of client Alpha',
    sql: "update rpt.qa_result set override_reason = 'Agreed with the client', approver_id = '10000000-0000-4000-8000-000000000004', overridden_at = now() where id = 'c0000000-0000-4000-8000-000000000003'",
    allowed: ['approver', 'service'],
  },
  // The underwritten base cases (migrations 0021 and 0022, docs/18 section 13). The policies say
  // who may write at all: the deal team records a case, the deal team and approvers move a case
  // on, each on a position they can see, and a plan point is written by the deal team member the
  // Draft names as the last person to change its figures. Which of them may send which command
  // is the state machine's. The system actor reads every case and writes none.
  {
    name: 'record a draft base case on the open investment',
    sql: "insert into mon.underwriting_case (investment_id, version, form, case_date, planned_exit_date, exit_multiple, gross_moic, gross_irr, revision_reason, entered_by) values ('30000000-0000-4000-8000-000000000001', 2, 'equity', '2024-06-30', '2028-06-30', 11.5, 2.4, 0.19, 'Re-underwritten after the add-on acquisition', pb.current_user_id())",
    allowed: ['deal_team', 'wall_member(deal_team)'],
  },
  {
    name: 'record a draft base case on the walled investment',
    // One Draft per position: whoever can withdraw the Draft waiting there does so first. Outside
    // the wall that touches no row, and the insert is refused on the position itself.
    before:
      "update mon.underwriting_case set state = 'Withdrawn', withdrawn_reason = 'Replaced by a new draft' where id = 'd0000000-0000-4000-8000-000000000003'",
    sql: "insert into mon.underwriting_case (investment_id, version, form, case_date, planned_exit_date, exit_multiple, gross_moic, gross_irr, revision_reason, entered_by) values ('30000000-0000-4000-8000-000000000002', 3, 'equity', '2025-06-30', '2030-06-30', 10, 1.9, 0.14, 'Re-underwritten after the second year', pb.current_user_id())",
    // Inside the wall only: the deal team outside it is refused, and so is the system actor,
    // which sees the position and is not deal team.
    allowed: ['wall_member(deal_team)'],
  },
  {
    name: 'withdraw the confirmed base case of the open investment',
    sql: "update mon.underwriting_case set state = 'Withdrawn', withdrawn_reason = 'Confirmed against the wrong model' where id = 'd0000000-0000-4000-8000-000000000001'",
    allowed: ['deal_team', 'approver', 'wall_member(deal_team)'],
  },
  {
    name: 'edit the draft base case on the walled investment',
    sql: "update mon.underwriting_case set gross_moic = 2.1, entered_by = pb.current_user_id(), entered_at = now() where id = 'd0000000-0000-4000-8000-000000000003'",
    // Inside the wall only: the deal team and the approver outside it are shown no such row, and
    // the system actor, which sees it, is neither deal team nor approver.
    allowed: ['wall_member(deal_team)'],
  },
  {
    name: 'confirm the draft base case on the walled investment',
    sql: "update mon.underwriting_case set state = 'Confirmed', confirmed_by = pb.current_user_id(), confirmed_at = now() where id = 'd0000000-0000-4000-8000-000000000003'",
    allowed: ['wall_member(deal_team)'],
  },
  // A plan point is written by the person who last changed the figures of its Draft (migration
  // 0022), so each writer claims the Draft first, as an edit through the API does. Nobody in the
  // fixture is that person without claiming it: the three rows after these say so.
  {
    name: 'add a plan point to the draft base case on the walled investment, having claimed it',
    before: CLAIM_WALLED_DRAFT,
    sql: "insert into mon.underwriting_case_point (case_id, period_end, revenue_ltm, ebitda_ltm, net_debt) values ('d0000000-0000-4000-8000-000000000003', '2026-06-30', 95000000, 20000000, 52000000)",
    allowed: ['wall_member(deal_team)'],
  },
  {
    name: 'change a plan point of the draft base case on the walled investment, having claimed it',
    before: CLAIM_WALLED_DRAFT,
    sql: "update mon.underwriting_case_point set net_debt = 61000000 where id = 'd0000000-0000-4000-8000-000000000004'",
    allowed: ['wall_member(deal_team)'],
  },
  {
    name: 'delete a plan point of the draft base case on the walled investment, having claimed it',
    before: CLAIM_WALLED_DRAFT,
    sql: "delete from mon.underwriting_case_point where id = 'd0000000-0000-4000-8000-000000000004'",
    // Points are replaced as a set while the case is a Draft.
    allowed: ['wall_member(deal_team)'],
  },
  {
    name: 'add a plan point to a draft base case somebody else entered',
    sql: "insert into mon.underwriting_case_point (case_id, period_end, revenue_ltm, ebitda_ltm, net_debt) values ('d0000000-0000-4000-8000-000000000003', '2026-06-30', 95000000, 20000000, 52000000)",
    // The person who entered it is outside the wall and cannot see it; the wall member can see
    // it and did not enter it.
    allowed: [],
  },
  {
    name: 'change a plan point of a draft base case somebody else entered',
    sql: "update mon.underwriting_case_point set net_debt = 61000000 where id = 'd0000000-0000-4000-8000-000000000004'",
    allowed: [],
  },
  {
    name: 'delete a plan point of a draft base case somebody else entered',
    sql: "delete from mon.underwriting_case_point where id = 'd0000000-0000-4000-8000-000000000004'",
    allowed: [],
  },
  {
    name: 'delete a base case',
    sql: "delete from mon.underwriting_case where id = 'd0000000-0000-4000-8000-000000000003'",
    // A case is withdrawn, never deleted: no delete is granted to anyone.
    allowed: [],
  },
  // Valuation suggestions (migration 0023, docs/18 section 14). Only the system actor writes
  // one. A person in operations accepts or dismisses, the system actor supersedes, each on a
  // position they can see, and neither can take the other's decision: the two update policies
  // judge the row as it will be. The figures of a suggestion are not granted for update at all.
  {
    name: 'write a valuation suggestion for the next quarter of the open investment',
    sql: `insert into mon.valuation_suggestion (investment_id, period_end, basis, method, reason_code, workings, source_document_id, extraction_run_id, calc_version) values ('30000000-0000-4000-8000-000000000001', '2024-12-31', 'capital_account_balance', 'valuation_method.sponsor_mark', 'no_ending_balance', '{"inputs": []}', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000003', 'matrix')`,
    allowed: ['service'],
  },
  {
    name: 'dismiss the open suggestion on the open investment',
    sql: `update mon.valuation_suggestion set state = 'Dismissed', decision_reason = 'The statement is for another vehicle', ${SUGGESTION_DECIDED} where id = 'e0000000-0000-4000-8000-000000000008'`,
    allowed: ['operations'],
  },
  {
    name: 'accept the open suggestion on the open investment onto a draft valuation',
    // Whoever may open a draft valuation does so first (operations and the system actor); for
    // everyone else that insert is refused. The system actor is then refused the acceptance.
    before:
      "insert into mon.valuation (id, investment_id, period_end, version, method, fair_value) values ('e0000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000001', '2024-09-30', 1, 'valuation_method.sponsor_mark', 46500000)",
    sql: `update mon.valuation_suggestion set state = 'Accepted', valuation_id = 'e0000000-0000-4000-8000-00000000000a', ${SUGGESTION_DECIDED} where id = 'e0000000-0000-4000-8000-000000000008'`,
    allowed: ['operations'],
  },
  {
    name: 'supersede the open suggestion on the open investment',
    sql: `update mon.valuation_suggestion set state = 'Superseded', superseded_reason = 'mark_locked', ${SUGGESTION_DECIDED} where id = 'e0000000-0000-4000-8000-000000000008'`,
    allowed: ['service'],
  },
  {
    name: 'dismiss the open suggestion on the walled investment',
    sql: `update mon.valuation_suggestion set state = 'Dismissed', decision_reason = 'The statement is for another vehicle', ${SUGGESTION_DECIDED} where id = 'e0000000-0000-4000-8000-000000000009'`,
    // Nobody in the fixture: operations is outside the wall and is shown no such row, the wall
    // member is deal team, and the system actor, which sees it, decides nothing for a person.
    allowed: [],
  },
  {
    name: 'supersede the open suggestion on the walled investment',
    sql: `update mon.valuation_suggestion set state = 'Superseded', superseded_reason = 'position_closed', ${SUGGESTION_DECIDED} where id = 'e0000000-0000-4000-8000-000000000009'`,
    allowed: ['service'],
  },
  {
    name: 'rewrite the value of the open suggestion on the open investment',
    sql: "update mon.valuation_suggestion set suggested_value = 50000000 where id = 'e0000000-0000-4000-8000-000000000008'",
    // Only the decision columns are granted for update (column grant).
    allowed: [],
  },
  {
    name: 'move the open suggestion on the open investment to another position',
    sql: "update mon.valuation_suggestion set investment_id = '30000000-0000-4000-8000-000000000002' where id = 'e0000000-0000-4000-8000-000000000008'",
    allowed: [],
  },
  {
    name: 'delete a valuation suggestion',
    sql: "delete from mon.valuation_suggestion where id = 'e0000000-0000-4000-8000-000000000008'",
    // A suggestion is dismissed or superseded, never deleted: no delete is granted to anyone.
    allowed: [],
  },
];
