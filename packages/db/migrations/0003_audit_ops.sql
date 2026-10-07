-- 0003 Audit trail and operations tables (docs/03 section 3, SEC-11.1).
-- Rollback note: drop ops.* and audit.event (audit exports to WORM storage happen outside the database).

-- Append-only. No UPDATE or DELETE grant to any role, plus a trigger in case a grant ever slips through.
create table audit.event (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_type text not null check (actor_type in ('user', 'service', 'agent')),
  action text not null,
  entity text not null,
  entity_id uuid,
  before_hash text,
  after_hash text,
  reason text,
  request_id text,
  details jsonb not null default '{}'::jsonb
);
create index event_entity_idx on audit.event (entity, entity_id, at);
create index event_actor_idx on audit.event (actor_id, at);
create trigger event_immutable before update or delete on audit.event
  for each row execute function pb.reject_mutation();

create table ops.feature_flag (
  key text primary key,
  enabled boolean not null default false,
  description text not null default '',
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);
insert into ops.feature_flag (key, enabled, description) values
  ('ai.extraction', false, 'Kill switch for AI extraction calls (SEC-8.10)'),
  ('ai.assistant', false, 'Kill switch for Ask Portfolio Beach'),
  ('adapter.mail', false, 'Mail and calendar capture adapter'),
  ('adapter.documents', true, 'Document hub adapter'),
  ('adapter.accounting', true, 'Accounting import and export adapter'),
  ('adapter.lookthrough', true, 'Look-through data adapter'),
  ('ops.autonomy.observe_only', false, 'Global Beach Ops kill switch: drops every agent to L0 (SEC-18.7)');

create table ops.task (
  id uuid primary key default gen_random_uuid(),
  regarding_entity text not null,
  regarding_id uuid,
  title text not null,
  owner_id uuid references core.app_user (id),
  due_date date,
  state text not null default 'open' check (state in ('open', 'in_progress', 'done', 'cancelled')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);
create index task_owner_idx on ops.task (owner_id, state);

create table ops.data_exception (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  entity text not null,
  entity_id uuid,
  rule_id text not null,
  expected text,
  actual text,
  severity text not null references core.taxonomy_term (code) check (severity like 'exception_severity.%'),
  owner_id uuid references core.app_user (id),
  state text not null default 'open' check (state in ('open', 'acknowledged', 'resolved', 'wont_fix')),
  external_ticket text,
  candidates jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);
create index data_exception_state_idx on ops.data_exception (state, severity);

create table ops.job (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  requested_by uuid references core.app_user (id),
  state text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
  progress integer not null default 0 check (progress between 0 and 100),
  result_ref text,
  error_code text,
  idempotency_key text unique,
  started_at timestamptz, finished_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

create table ops.systems_issue (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  problem text not null,
  area text not null,
  severity text not null references core.taxonomy_term (code) check (severity like 'exception_severity.%'),
  lane text not null default 'backlog' check (lane in ('backlog', 'next', 'now', 'done')),
  decision_log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);

-- Outbox (docs/17 section 5): a database change and its event commit together.
create table ops.outbox (
  id bigint generated always as identity primary key,
  topic text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index outbox_unpublished_idx on ops.outbox (created_at) where published_at is null;

call pb.add_standard_columns_trigger('ops.feature_flag');
call pb.add_standard_columns_trigger('ops.task');
call pb.add_standard_columns_trigger('ops.data_exception');
call pb.add_standard_columns_trigger('ops.job');
call pb.add_standard_columns_trigger('ops.systems_issue');
