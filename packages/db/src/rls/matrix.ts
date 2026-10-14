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
  'core.walled_record': row(0, 0, 0, 1, 0, 1, 0, 1, 0),
  'mon.quarterly_performance': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'mon.valuation': row(1, 1, 1, 1, 1, 1, 1, 2, 2),
  'mon.cash_flow': row(2, 2, 2, 2, 2, 2, 2, 3, 3),
  'mon.valuation_history': row(0, 0, 2, 2, 0, 0, 2, 0, 0),
  'ops.feature_flag': row(9, 9, 9, 9, 9, 9, 9, 9, 9),
  // An exception about a staged row is visible to whoever the row's own policy admits (migration
  // 0010): the three fixture exceptions are about the open, the walled and the unlinked accounting row.
  'ops.data_exception': row(0, 2, 2, 2, 0, 0, 2, 3, 3),
  'audit.event': row(0, 0, 2, 2, 0, 2, 2, 0, 0),
  // Staging: reviewers (operations, deal team, approver, auditor) and the service read files, and
  // rows under the wall of the investment they link to (migration 0009); an unlinked row is every
  // reviewer's. Three rows: linked to the open investment, linked to the walled one, unlinked.
  'stg.intake_file': row(0, 1, 1, 1, 0, 0, 1, 1, 1),
  'stg.intake_row': row(0, 2, 2, 2, 0, 0, 2, 3, 3),
  // Weekly values carry the wall of the investment they link to the same way (migration 0010).
  'stg.valuation': row(0, 2, 2, 2, 0, 0, 2, 3, 3),
  'core.company_alias': row(1, 1, 1, 1, 1, 1, 1, 1, 1),
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
];
