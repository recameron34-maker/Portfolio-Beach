-- 0002 Core reference entities (docs/03 section 3, decision 0004).
-- Rollback note: drop the tables in reverse order of creation.

create table core.app_user (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  display_name text not null,
  email text not null unique check (email = lower(email)),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

-- Business lists live here so they change without migrations. Codes carry their domain
-- ("deal_type.co_invest_equity") so a plain foreign key enforces membership.
create table core.taxonomy_term (
  domain text not null,
  code text primary key check (code like domain || '.%'),
  label text not null,
  parent_code text references core.taxonomy_term (code),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);
create index taxonomy_term_domain_idx on core.taxonomy_term (domain, sort_order);

insert into core.taxonomy_term (domain, code, label, sort_order) values
  ('deal_type', 'deal_type.co_invest_equity', 'Co-investment (equity)', 1),
  ('deal_type', 'deal_type.cv_single_asset', 'Continuation vehicle (single asset)', 2),
  ('deal_type', 'deal_type.cv_multi_asset', 'Continuation vehicle (multi asset)', 3),
  ('deal_type', 'deal_type.primary_fund', 'Primary fund commitment', 4),
  ('deal_type', 'deal_type.private_credit', 'Private credit', 5),
  ('vehicle_type', 'vehicle_type.co_invest', 'Co-invest fund', 1),
  ('vehicle_type', 'vehicle_type.cv', 'CV fund', 2),
  ('vehicle_type', 'vehicle_type.primary_program', 'Primary program (fund of funds)', 3),
  ('vehicle_type', 'vehicle_type.private_credit', 'Private credit vehicle', 4),
  ('vehicle_type', 'vehicle_type.client_sma', 'Client separately managed account', 5),
  ('sponsor_tier', 'sponsor_tier.core', 'Core relationship', 1),
  ('sponsor_tier', 'sponsor_tier.active', 'Active', 2),
  ('sponsor_tier', 'sponsor_tier.watch', 'Watch', 3),
  ('sponsor_tier', 'sponsor_tier.new', 'New', 4),
  ('strategy', 'strategy.buyout', 'Buyout', 1),
  ('strategy', 'strategy.growth', 'Growth', 2),
  ('strategy', 'strategy.credit', 'Private credit', 3),
  ('strategy', 'strategy.secondaries', 'Secondaries', 4),
  ('sector', 'sector.software', 'Software', 1),
  ('sector', 'sector.healthcare', 'Healthcare', 2),
  ('sector', 'sector.industrials', 'Industrials', 3),
  ('sector', 'sector.consumer', 'Consumer', 4),
  ('sector', 'sector.business_services', 'Business services', 5),
  ('sector', 'sector.financials', 'Financial services', 6),
  ('sector', 'sector.energy_transition', 'Energy transition', 7),
  ('geography', 'geography.north_america', 'North America', 1),
  ('geography', 'geography.europe', 'Europe', 2),
  ('geography', 'geography.asia_pacific', 'Asia Pacific', 3),
  ('geography', 'geography.other', 'Other', 4),
  ('flow_type', 'flow_type.contribution', 'Contribution', 1),
  ('flow_type', 'flow_type.distribution', 'Distribution', 2),
  ('flow_type', 'flow_type.fee', 'Fee', 3),
  ('flow_type', 'flow_type.expense', 'Expense', 4),
  ('flow_type', 'flow_type.interest', 'Interest', 5),
  ('flow_type', 'flow_type.principal', 'Principal', 6),
  ('flow_type', 'flow_type.recallable', 'Recallable distribution', 7),
  ('notice_type', 'notice_type.capital_call', 'Capital call', 1),
  ('notice_type', 'notice_type.distribution', 'Distribution', 2),
  ('notice_type', 'notice_type.equalization', 'Equalization', 3),
  ('notice_type', 'notice_type.interest_payment', 'Interest payment', 4),
  ('notice_type', 'notice_type.principal_repayment', 'Principal repayment', 5),
  ('notice_type', 'notice_type.fee_notice', 'Fee notice', 6),
  ('valuation_method', 'valuation_method.sponsor_mark', 'Sponsor mark', 1),
  ('valuation_method', 'valuation_method.market_multiple', 'Market multiple', 2),
  ('valuation_method', 'valuation_method.dcf', 'Discounted cash flow', 3),
  ('valuation_method', 'valuation_method.cost', 'Cost', 4),
  ('valuation_method', 'valuation_method.par_plus_accrued', 'Par plus accrued (credit)', 5),
  ('facility_type', 'facility_type.senior_secured', 'Senior secured', 1),
  ('facility_type', 'facility_type.unitranche', 'Unitranche', 2),
  ('facility_type', 'facility_type.second_lien', 'Second lien', 3),
  ('facility_type', 'facility_type.mezzanine', 'Mezzanine', 4),
  ('facility_type', 'facility_type.nav_loan', 'NAV loan', 5),
  ('facility_type', 'facility_type.preferred', 'Preferred equity', 6),
  ('base_rate', 'base_rate.sofr', 'SOFR', 1),
  ('base_rate', 'base_rate.euribor', 'EURIBOR', 2),
  ('base_rate', 'base_rate.sonia', 'SONIA', 3),
  ('base_rate', 'base_rate.fixed', 'Fixed rate', 4),
  ('covenant_status', 'covenant_status.compliant', 'Compliant', 1),
  ('covenant_status', 'covenant_status.waiver', 'Waiver in place', 2),
  ('covenant_status', 'covenant_status.breach', 'Breach', 3),
  ('payment_status', 'payment_status.current', 'Current', 1),
  ('payment_status', 'payment_status.deferred', 'Deferred', 2),
  ('payment_status', 'payment_status.default', 'Default', 3),
  ('realization_outlook', 'realization_outlook.none', 'None expected', 1),
  ('realization_outlook', 'realization_outlook.partial', 'Partial', 2),
  ('realization_outlook', 'realization_outlook.full', 'Full', 3),
  ('exception_severity', 'exception_severity.low', 'Low', 1),
  ('exception_severity', 'exception_severity.medium', 'Medium', 2),
  ('exception_severity', 'exception_severity.high', 'High', 3),
  ('record_status', 'record_status.approved', 'Approved', 1),
  ('record_status', 'record_status.draft', 'Draft', 2),
  ('record_status', 'record_status.superseded', 'Superseded', 3);

create table core.sponsor (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  canonical_name text not null unique,
  tier text not null references core.taxonomy_term (code) check (tier like 'sponsor_tier.%'),
  hq_geography text references core.taxonomy_term (code) check (hq_geography like 'geography.%'),
  description text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

create table core.sponsor_fund (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references core.sponsor (id),
  name text not null,
  canonical_name text not null unique,
  vintage integer check (vintage between 1980 and 2100),
  strategy text references core.taxonomy_term (code) check (strategy like 'strategy.%'),
  size_target numeric(20,2), size_hard_cap numeric(20,2), size_final numeric(20,2),
  currency char(3) not null default 'USD',
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);
create index sponsor_fund_sponsor_idx on core.sponsor_fund (sponsor_id);

create table core.fund_alias (
  id uuid primary key default gen_random_uuid(),
  sponsor_fund_id uuid not null references core.sponsor_fund (id),
  alias text not null unique,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

create table core.portfolio_company (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  canonical_name text not null unique,
  sector text references core.taxonomy_term (code) check (sector like 'sector.%'),
  geography text references core.taxonomy_term (code) check (geography like 'geography.%'),
  description text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

create table core.fund_holding (
  id uuid primary key default gen_random_uuid(),
  sponsor_fund_id uuid not null references core.sponsor_fund (id),
  portfolio_company_id uuid not null references core.portfolio_company (id),
  unique (sponsor_fund_id, portfolio_company_id),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

create table core.vehicle (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  vehicle_type text not null references core.taxonomy_term (code) check (vehicle_type like 'vehicle_type.%'),
  vintage integer check (vintage between 1980 and 2100),
  currency char(3) not null default 'USD',
  closing_count integer not null default 0 check (closing_count >= 0),
  final_close_date date,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

create table core.investment (
  id uuid primary key default gen_random_uuid(),
  investment_number text not null unique,
  vehicle_id uuid not null references core.vehicle (id),
  portfolio_company_id uuid not null references core.portfolio_company (id),
  sponsor_fund_id uuid references core.sponsor_fund (id),
  sponsor_id uuid not null references core.sponsor (id),
  deal_type text not null references core.taxonomy_term (code) check (deal_type like 'deal_type.%'),
  entry_date date not null,
  exit_date date,
  is_active boolean not null default true,
  currency char(3) not null default 'USD',
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check (exit_date is null or exit_date >= entry_date)
);
create index investment_vehicle_idx on core.investment (vehicle_id);
create index investment_company_idx on core.investment (portfolio_company_id);
create index investment_sponsor_idx on core.investment (sponsor_id);

-- Restricted: client (LP) records.
create table core.client (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  reporting_bases jsonb not null default '[]'::jsonb,
  reporting_cadence text not null default 'quarterly',
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

-- The firm vehicle's commitment to a sponsor fund (decision 0004). client_id is set only for
-- client-directed SMA commitments.
create table core.commitment (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references core.vehicle (id),
  sponsor_fund_id uuid not null references core.sponsor_fund (id),
  client_id uuid references core.client (id),
  amount numeric(20,2) not null check (amount >= 0),
  currency char(3) not null default 'USD',
  commitment_date date not null,
  side_letter_flags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique nulls not distinct (vehicle_id, sponsor_fund_id, client_id)
);

-- A client's commitment to a firm vehicle; ownership_pct drives client look-through.
create table core.lp_commitment (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references core.client (id),
  vehicle_id uuid not null references core.vehicle (id),
  amount numeric(20,2) not null check (amount >= 0),
  currency char(3) not null default 'USD',
  commitment_date date not null,
  closing_number integer not null default 1 check (closing_number >= 1),
  ownership_pct numeric(12,8) check (ownership_pct is null or (ownership_pct >= 0 and ownership_pct <= 1)),
  side_letter_flags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (client_id, vehicle_id)
);

-- Pairs of names that must never be auto-matched (docs/03 section 5).
create table core.match_guard (
  id uuid primary key default gen_random_uuid(),
  name_a text not null,
  name_b text not null,
  reason text not null,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (name_a, name_b)
);

-- Information barriers (SEC-5.3): a walled record is visible only to wall members.
create table core.wall (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);
create table core.wall_member (
  wall_id uuid not null references core.wall (id),
  user_id uuid not null references core.app_user (id),
  primary key (wall_id, user_id),
  created_at timestamptz not null default now(), created_by uuid
);
create table core.walled_record (
  wall_id uuid not null references core.wall (id),
  entity text not null check (entity in ('investment', 'opportunity', 'sponsor', 'document')),
  entity_id uuid not null,
  primary key (entity, entity_id, wall_id),
  created_at timestamptz not null default now(), created_by uuid
);
create index walled_record_lookup_idx on core.walled_record (entity, entity_id);

-- True when no wall covers the record, or the current user is a member of one that does.
create or replace function pb.can_see_walled(entity_name text, record_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select not exists (select 1 from core.walled_record w where w.entity = entity_name and w.entity_id = record_id)
      or exists (
        select 1 from core.walled_record w
        join core.wall_member m on m.wall_id = w.wall_id
        where w.entity = entity_name and w.entity_id = record_id and m.user_id = pb.current_user_id())
$$;

call pb.add_standard_columns_trigger('core.app_user');
call pb.add_standard_columns_trigger('core.taxonomy_term');
call pb.add_standard_columns_trigger('core.sponsor');
call pb.add_standard_columns_trigger('core.sponsor_fund');
call pb.add_standard_columns_trigger('core.fund_alias');
call pb.add_standard_columns_trigger('core.portfolio_company');
call pb.add_standard_columns_trigger('core.fund_holding');
call pb.add_standard_columns_trigger('core.vehicle');
call pb.add_standard_columns_trigger('core.investment');
call pb.add_standard_columns_trigger('core.client');
call pb.add_standard_columns_trigger('core.commitment');
call pb.add_standard_columns_trigger('core.lp_commitment');
call pb.add_standard_columns_trigger('core.match_guard');
call pb.add_standard_columns_trigger('core.wall');
