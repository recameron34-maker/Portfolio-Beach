-- 0005 Staging framework (docs/03 section 1, docs/18 section 2, SEC-9.1).
-- Every intake lands here first. Promotion to production tables happens in one transaction with an audit event.
-- Rollback note: drop stg.* tables and the staging_status type.

create type stg.staging_status as enum ('new', 'validated', 'flagged', 'approved', 'rejected', 'promoted');

create table stg.intake_file (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  file_name text not null,
  content_hash text not null,
  template_signature text,
  received_at timestamptz not null default now(),
  received_by uuid references core.app_user (id),
  row_count integer not null default 0,
  status stg.staging_status not null default 'new',
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (source, content_hash)
);

create table stg.intake_row (
  id uuid primary key default gen_random_uuid(),
  intake_file_id uuid not null references stg.intake_file (id),
  row_no integer not null,
  natural_key text not null,
  target_entity text not null,
  target_id uuid,
  payload jsonb not null,
  diff jsonb not null default '{}'::jsonb,
  validation jsonb not null default '[]'::jsonb,
  status stg.staging_status not null default 'new',
  reviewer_id uuid references core.app_user (id),
  decision text,
  decided_at timestamptz,
  promoted_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (intake_file_id, row_no),
  unique (intake_file_id, natural_key)
);
create index intake_row_status_idx on stg.intake_row (status, target_entity);

-- Weekly valuation intake (M2 weekly-report-intake): prior value, variance and reviewer decision.
create table stg.valuation (
  id uuid primary key default gen_random_uuid(),
  intake_file_id uuid references stg.intake_file (id),
  report_date date not null,
  investment_number text not null,
  investment_id uuid references core.investment (id),
  reported_value numeric(20,2) not null,
  prior_value numeric(20,2),
  variance_pct numeric(12,8),
  flag text,
  match_status text not null default 'unmatched' check (match_status in ('matched', 'unmatched', 'guarded', 'ambiguous')),
  status stg.staging_status not null default 'new',
  reviewer_id uuid references core.app_user (id),
  decision text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (report_date, investment_number)
);

call pb.add_standard_columns_trigger('stg.intake_file');
call pb.add_standard_columns_trigger('stg.intake_row');
call pb.add_standard_columns_trigger('stg.valuation');
