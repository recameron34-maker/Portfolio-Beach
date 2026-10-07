-- 0004 Monitoring, valuation, cash and capital activity (docs/03 section 3, docs/18 sections 1 and 3).
-- Rollback note: drop mon.* tables and types.

create type mon.valuation_state as enum ('Draft', 'OpsPrepared', 'DealTeamApproved', 'Locked', 'Reopened');
create type mon.capital_notice_state as enum ('Received', 'Extracted', 'Reviewed', 'TicketDrafted', 'TicketApproved', 'Funded', 'Reconciled');

-- Quarterly operating data for equity-style positions (co-invest and CV).
create table mon.quarterly_performance (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null references core.investment (id),
  period_end date not null,
  revenue_ltm numeric(20,2), ebitda_ltm numeric(20,2), ev numeric(20,2), net_debt numeric(20,2),
  cash numeric(20,2), total_equity numeric(20,2),
  currency char(3) not null default 'USD',
  highlights jsonb not null default '[]'::jsonb,
  commentary text,
  is_entry_snapshot boolean not null default false,
  status text not null default 'record_status.draft' references core.taxonomy_term (code) check (status like 'record_status.%'),
  source_document_id uuid, source_page integer, source_locator text, extraction_run_id uuid, prompt_version text, model_id text,
  approved_by uuid references core.app_user (id), approved_at timestamptz, approval_reason text,
  calc_version text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (investment_id, period_end)
);
-- At most one entry snapshot per investment.
create unique index quarterly_performance_entry_idx on mon.quarterly_performance (investment_id) where is_entry_snapshot;

-- Private credit terms (one row per credit investment) and per-period credit metrics.
create table mon.credit_terms (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null unique references core.investment (id),
  facility_type text not null references core.taxonomy_term (code) check (facility_type like 'facility_type.%'),
  seniority_rank integer not null default 1 check (seniority_rank >= 1),
  commitment_amount numeric(20,2) not null check (commitment_amount >= 0),
  currency char(3) not null default 'USD',
  base_rate text not null references core.taxonomy_term (code) check (base_rate like 'base_rate.%'),
  floor numeric(12,8), spread numeric(12,8) not null,
  cash_coupon numeric(12,8) not null default 0, pik_coupon numeric(12,8) not null default 0,
  oid numeric(12,8) not null default 0, upfront_fee numeric(12,8) not null default 0,
  maturity_date date not null,
  payment_frequency text not null default 'quarterly' check (payment_frequency in ('monthly', 'quarterly', 'semiannual', 'annual')),
  amortization jsonb not null default '[]'::jsonb,
  call_protection jsonb not null default '[]'::jsonb,
  covenants jsonb not null default '[]'::jsonb,
  effective_date date not null,
  source_document_id uuid,
  status text not null default 'record_status.draft' references core.taxonomy_term (code) check (status like 'record_status.%'),
  approved_by uuid references core.app_user (id), approved_at timestamptz, approval_reason text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check (maturity_date > effective_date)
);

create table mon.credit_performance (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null references core.investment (id),
  period_end date not null,
  par_value numeric(20,2), cost_basis numeric(20,2), fair_value numeric(20,2), accrued_interest numeric(20,2),
  cash_interest_ltm numeric(20,2), pik_capitalized_ltm numeric(20,2), principal_repaid_ltm numeric(20,2), funded_amount numeric(20,2),
  ebitda_ltm numeric(20,2), cash_interest_expense_ltm numeric(20,2), net_debt_through_tranche numeric(20,2), ev numeric(20,2),
  dscr_inputs jsonb not null default '{}'::jsonb,
  currency char(3) not null default 'USD',
  covenant_status text references core.taxonomy_term (code) check (covenant_status like 'covenant_status.%'),
  payment_status text references core.taxonomy_term (code) check (payment_status like 'payment_status.%'),
  highlights jsonb not null default '[]'::jsonb,
  commentary text,
  is_entry_snapshot boolean not null default false,
  status text not null default 'record_status.draft' references core.taxonomy_term (code) check (status like 'record_status.%'),
  source_document_id uuid, source_page integer, source_locator text, extraction_run_id uuid, prompt_version text, model_id text,
  approved_by uuid references core.app_user (id), approved_at timestamptz, approval_reason text,
  calc_version text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (investment_id, period_end)
);
create unique index credit_performance_entry_idx on mon.credit_performance (investment_id) where is_entry_snapshot;

-- Valuation versions with the docs/18 state machine. One Locked version per investment and period.
create table mon.valuation (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null references core.investment (id),
  period_end date not null,
  version integer not null check (version >= 1),
  method text not null references core.taxonomy_term (code) check (method like 'valuation_method.%'),
  inputs jsonb not null default '{}'::jsonb,
  fair_value numeric(20,2) not null,
  currency char(3) not null default 'USD',
  state mon.valuation_state not null default 'Draft',
  lock_hash text,
  prepared_by uuid references core.app_user (id),
  deal_team_approved_by uuid references core.app_user (id),
  approved_by uuid references core.app_user (id),
  approved_at timestamptz,
  reopen_reason text,
  calc_version text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (investment_id, period_end, version),
  check (state <> 'Locked' or lock_hash is not null),
  check (state not in ('Locked', 'Reopened') or approved_by is not null),
  -- Segregation of duties (SEC-5.6): the preparer is never the final approver.
  check (approved_by is null or prepared_by is null or approved_by <> prepared_by),
  check (deal_team_approved_by is null or prepared_by is null or deal_team_approved_by <> prepared_by)
);
create unique index valuation_one_locked_idx on mon.valuation (investment_id, period_end) where state = 'Locked';
create index valuation_investment_idx on mon.valuation (investment_id, period_end desc, version desc);

-- A Locked valuation never changes in place (SEC-9.3). The only permitted update is the transition
-- to Reopened (with a reason); every other column must stay exactly as locked.
create or replace function mon.guard_locked_valuation() returns trigger
language plpgsql as $$
begin
  if old.state = 'Locked' then
    if new.state <> 'Reopened' then
      raise exception 'valuation % is Locked and cannot be updated in place', old.id using errcode = 'P0001';
    end if;
    if new.reopen_reason is null or length(trim(new.reopen_reason)) = 0 then
      raise exception 'reopening a Locked valuation requires a reason' using errcode = 'P0001';
    end if;
    if new.fair_value <> old.fair_value or new.inputs <> old.inputs or new.method <> old.method
       or new.lock_hash is distinct from old.lock_hash or new.period_end <> old.period_end
       or new.investment_id <> old.investment_id or new.version <> old.version
       or new.approved_by is distinct from old.approved_by or new.prepared_by is distinct from old.prepared_by then
      raise exception 'a Locked valuation keeps its locked values; create a new version instead' using errcode = 'P0001';
    end if;
  elsif old.state = 'Reopened' then
    raise exception 'valuation % is Reopened and is read-only; work on the new version', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger guard_locked before update on mon.valuation for each row execute function mon.guard_locked_valuation();
create trigger no_delete before delete on mon.valuation for each row execute function pb.reject_mutation();

create table mon.valuation_approval (
  id uuid primary key default gen_random_uuid(),
  valuation_id uuid not null references mon.valuation (id),
  approver_id uuid not null references core.app_user (id),
  step text not null check (step in ('ops_prepared', 'deal_team', 'final', 'reopen')),
  decision text not null check (decision in ('approve', 'reject', 'reopen')),
  comment text,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(), created_by uuid
);
create index valuation_approval_valuation_idx on mon.valuation_approval (valuation_id, at);

-- Capital activity notices (ILPA-aware fields kept as json until M16 types them fully).
create table mon.capital_notice (
  id uuid primary key default gen_random_uuid(),
  notice_type text not null references core.taxonomy_term (code) check (notice_type like 'notice_type.%'),
  vehicle_id uuid not null references core.vehicle (id),
  investment_id uuid references core.investment (id),
  commitment_id uuid references core.commitment (id),
  issue_date date not null,
  due_date date not null,
  amount numeric(20,2) not null,
  currency char(3) not null default 'USD',
  split jsonb not null default '{}'::jsonb,
  ilpa_fields jsonb not null default '{}'::jsonb,
  preferred_funding_date date,
  state mon.capital_notice_state not null default 'Received',
  source_document_id uuid,
  scenario_tag text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check (investment_id is not null or commitment_id is not null),
  check (due_date >= issue_date)
);
create index capital_notice_due_idx on mon.capital_notice (state, due_date);

-- Cash flows: the IRR source of truth. Signed from the investor's perspective (docs/08 section 1).
create table mon.cash_flow (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid references core.investment (id),
  commitment_id uuid references core.commitment (id),
  flow_date date not null,
  flow_type text not null references core.taxonomy_term (code) check (flow_type like 'flow_type.%'),
  amount numeric(20,2) not null,
  currency char(3) not null default 'USD',
  source_notice_id uuid references mon.capital_notice (id),
  status text not null default 'record_status.draft' references core.taxonomy_term (code) check (status like 'record_status.%'),
  source_document_id uuid, source_page integer, source_locator text, extraction_run_id uuid, prompt_version text, model_id text,
  approved_by uuid references core.app_user (id), approved_at timestamptz, approval_reason text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check (investment_id is not null or commitment_id is not null),
  -- Sign discipline: outflows negative, inflows positive.
  check (
    (flow_type in ('flow_type.contribution', 'flow_type.fee', 'flow_type.expense') and amount <= 0) or
    (flow_type in ('flow_type.distribution', 'flow_type.interest', 'flow_type.principal', 'flow_type.recallable') and amount >= 0)
  )
);
create index cash_flow_investment_idx on mon.cash_flow (investment_id, flow_date);
create index cash_flow_commitment_idx on mon.cash_flow (commitment_id, flow_date);
create trigger cash_flow_no_delete before delete on mon.cash_flow for each row execute function pb.reject_mutation();

-- Realization outlook changes only by explicit edit (M9); history keeps every change.
create table mon.realization_outlook (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null unique references core.investment (id),
  horizon_months integer not null default 18 check (horizon_months > 0),
  outlook text not null references core.taxonomy_term (code) check (outlook like 'realization_outlook.%'),
  note text,
  set_by uuid references core.app_user (id),
  set_at timestamptz not null default now(),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

call pb.add_standard_columns_trigger('mon.quarterly_performance');
call pb.add_standard_columns_trigger('mon.credit_terms');
call pb.add_standard_columns_trigger('mon.credit_performance');
call pb.add_standard_columns_trigger('mon.valuation');
call pb.add_standard_columns_trigger('mon.capital_notice');
call pb.add_standard_columns_trigger('mon.cash_flow');
call pb.add_standard_columns_trigger('mon.realization_outlook');
