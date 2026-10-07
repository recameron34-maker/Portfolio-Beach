import type { DbHandle } from '../client.js';
import type { AppRole } from '../roles.js';

/**
 * A small, hand-built dataset for the access matrix (docs/12 section 1): two investments, one of
 * them walled; two clients; one SMA commitment. Loaded as the owner, outside RLS.
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
];

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
  `);
}
