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
  | 'wall_member(deal_team)';

export const ACTOR_NAMES: ActorName[] = [
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations(A)',
  'platform_admin',
  'auditor',
  'wall_member(deal_team)',
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
): Row => ({
  viewer: v,
  deal_team: dt,
  operations: ops,
  approver: ap,
  'investor_relations(A)': ir,
  platform_admin: admin,
  auditor: aud,
  'wall_member(deal_team)': wm,
});

/** Visible row counts. Columns: viewer, deal_team, operations, approver, IR(A), platform_admin, auditor, wall member. */
export const READ_MATRIX: Record<string, Row> = {
  'core.investment': row(1, 1, 1, 1, 1, 1, 1, 2),
  'core.sponsor': row(1, 1, 1, 1, 1, 1, 1, 1),
  'core.vehicle': row(1, 1, 1, 1, 1, 1, 1, 1),
  'core.client': row(0, 0, 2, 2, 1, 0, 2, 0),
  'core.lp_commitment': row(0, 0, 2, 2, 1, 0, 2, 0),
  'core.commitment': row(1, 1, 2, 2, 1, 1, 2, 1),
  'core.wall': row(0, 0, 0, 1, 0, 1, 0, 1),
  'core.wall_member': row(0, 0, 0, 1, 0, 1, 0, 1),
  'core.walled_record': row(0, 0, 0, 1, 0, 1, 0, 1),
  'mon.quarterly_performance': row(1, 1, 1, 1, 1, 1, 1, 2),
  'mon.valuation': row(1, 1, 1, 1, 1, 1, 1, 2),
  'mon.cash_flow': row(2, 2, 2, 2, 2, 2, 2, 3),
  'mon.valuation_history': row(0, 0, 2, 2, 0, 0, 2, 0),
  'ops.feature_flag': row(7, 7, 7, 7, 7, 7, 7, 7),
  'audit.event': row(0, 0, 2, 2, 0, 2, 2, 0),
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
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)'],
  },
  {
    name: 'insert a client (Restricted)',
    sql: "insert into core.client (name) values ('Client Gamma')",
    allowed: ['operations'],
  },
  {
    name: 'flip a feature flag',
    sql: "update ops.feature_flag set enabled = true where key = 'ai.extraction'",
    allowed: ['platform_admin'],
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
    allowed: ['operations'],
  },
  {
    name: 'update a visible investment',
    sql: "update core.investment set is_active = true where id = '30000000-0000-4000-8000-000000000001'",
    allowed: ['deal_team', 'operations', 'wall_member(deal_team)'],
  },
  {
    name: 'append an audit event',
    sql: "insert into audit.event (actor_type, action, entity) values ('user', 'test', 'test')",
    allowed: ACTOR_NAMES,
  },
  {
    name: 'insert a valuation on the walled investment',
    sql: "insert into mon.valuation (investment_id, period_end, version, method, fair_value) values ('30000000-0000-4000-8000-000000000002', '2024-09-30', 1, 'valuation_method.cost', 1)",
    allowed: [],
  },
];
