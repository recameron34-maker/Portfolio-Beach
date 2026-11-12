-- 0019 The reporting package and its QA findings (docs/04 M14, docs/18 section 5, docs/03).
-- rpt.package is one client report for one period and basis; rpt.qa_result holds what the report
-- QA engine found on each run (docs/08 section 7). A package is prepared by one person and
-- reviewed by another (SEC-5.6), is locked with a content hash when approved (SEC-9.3), and once
-- Released never changes: a correction is a new version with a reason. A failed finding blocks
-- release unless an approver overrides it with a reason (SEC-9.5); what the engine found is never
-- edited, only the override is added.
--
-- Access (SEC-5.2): a package is client data. It is read by the roles that read every client
-- (pb.sees_all_clients), by investor relations entitled to its client, and by the system actor,
-- which runs the QA step. Investor relations prepare it for a client they are entitled to;
-- approvers override and approve; operations may release. Nobody deletes one.
--
-- rpt.template and rpt.override (layout elements) arrive with the template engine.
-- Rollback note: drop rpt.qa_result and rpt.package with their history tables, the two functions
-- rpt.guard_released_package and rpt.guard_qa_result, pb.package_visible, and the three types.

create type rpt.package_state as enum
  ('Draft', 'Generated', 'QAFailed', 'QAPassed', 'InReview', 'Approved', 'Released');
create type rpt.package_basis as enum ('gross', 'net');
create type rpt.package_label as enum ('preliminary', 'final');

create table rpt.package (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references core.client (id),
  period_end date not null,
  -- The date the package's figures were read as of.
  as_of date not null,
  basis rpt.package_basis not null,
  label rpt.package_label not null,
  version integer not null default 1 check (version >= 1),
  state rpt.package_state not null default 'Draft',
  prepared_by uuid not null references core.app_user (id),
  reviewer_id uuid references core.app_user (id),
  approved_at timestamptz,
  -- SHA-256 of the approved content, hex (SEC-9.3).
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  released_at timestamptz,
  released_by uuid references core.app_user (id),
  -- Why this version replaces the released one before it.
  correction_reason text,
  -- What changed between generations, kept on the package and never inside an output file (M14).
  change_log jsonb not null default '[]'::jsonb check (jsonb_typeof(change_log) = 'array'),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (client_id, period_end, basis, version),
  check (period_end <= as_of),
  check (version = 1 or (correction_reason is not null and length(btrim(correction_reason)) > 0)),
  check (reviewer_id is null or reviewer_id <> prepared_by),
  check (state not in ('Approved', 'Released')
    or (reviewer_id is not null and approved_at is not null and content_hash is not null)),
  check (state <> 'Released' or (released_at is not null and released_by is not null))
);
create index package_client_period_idx on rpt.package (client_id, period_end);
call pb.add_standard_columns_trigger('rpt.package');

-- Released is immutable (docs/18 section 5): the row never changes again and is never deleted.
create or replace function rpt.guard_released_package() returns trigger
language plpgsql as $$
begin
  if old.state = 'Released' then
    raise exception 'reporting package % is Released and cannot change; create a new version', old.id
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger guard_released before update on rpt.package
  for each row execute function rpt.guard_released_package();
create trigger no_delete before delete on rpt.package
  for each row execute function pb.reject_mutation();

-- Visibility of a package's children: the package's own (the policy on rpt.package decides).
create or replace function pb.package_visible(package_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from rpt.package p where p.id = package_id)
$$;

create table rpt.qa_result (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references rpt.package (id),
  -- Each generation runs the rules again; the findings of every run are kept.
  run_no integer not null check (run_no >= 1),
  rule text not null check (rule ~ '^QA-[A-Z]+-[0-9]{2}$'),
  -- A position number, "client:position", or "package", "status", "basis".
  entity_ref text not null check (length(btrim(entity_ref)) > 0),
  expected text,
  actual text,
  passed boolean not null,
  detail text not null check (length(btrim(detail)) > 0),
  override_reason text,
  approver_id uuid references core.app_user (id),
  overridden_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (package_id, run_no, rule, entity_ref),
  -- An override is whole or absent, has a reason, and is only ever on a finding that failed.
  check ((override_reason is null) = (approver_id is null)
    and (override_reason is null) = (overridden_at is null)),
  check (override_reason is null or (not passed and length(btrim(override_reason)) > 0))
);
create index qa_result_package_idx on rpt.qa_result (package_id, run_no);
call pb.add_standard_columns_trigger('rpt.qa_result');

-- What the engine found is fixed; only the override may be added. Nothing is written under a
-- Released package.
create or replace function rpt.guard_qa_result() returns trigger
language plpgsql as $$
declare
  package_state rpt.package_state;
begin
  select p.state into package_state from rpt.package p where p.id = new.package_id;
  if package_state = 'Released' then
    raise exception 'reporting package % is Released and cannot change; create a new version', new.package_id
      using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    if new.package_id <> old.package_id or new.run_no <> old.run_no or new.rule <> old.rule
       or new.entity_ref <> old.entity_ref or new.passed <> old.passed
       or new.expected is distinct from old.expected or new.actual is distinct from old.actual
       or new.detail <> old.detail then
      raise exception 'a QA finding is fixed once recorded; only its override may be added'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger guard_finding before insert or update on rpt.qa_result
  for each row execute function rpt.guard_qa_result();
create trigger no_delete before delete on rpt.qa_result
  for each row execute function pb.reject_mutation();

call audit.add_history('rpt.package');
call audit.add_history('rpt.qa_result');

grant select, insert, update on rpt.package, rpt.qa_result to pb_app;

alter table rpt.package enable row level security;
alter table rpt.package force row level security;
alter table rpt.qa_result enable row level security;
alter table rpt.qa_result force row level security;

-- rpt.package: client data. The system actor reads it to run the QA step.
create policy read_entitled on rpt.package for select to pb_app
  using (pb.has_role('service') or pb.sees_all_clients() or pb.entitled_client(client_id));
-- Prepared by investor relations for a client they are entitled to, or by the system actor.
create policy prepare_package on rpt.package for insert to pb_app
  with check ((pb.has_role('service') or (pb.has_role('investor_relations') and pb.entitled_client(client_id))));
-- Moved on by the roles the state machine names (docs/18 section 5), each within what it reads.
create policy move_package on rpt.package for update to pb_app
  using (pb.has_role('service')
    or (pb.has_role('investor_relations') and pb.entitled_client(client_id))
    or (pb.has_any_role(array['approver', 'operations']) and pb.sees_all_clients()))
  with check (pb.has_role('service')
    or (pb.has_role('investor_relations') and pb.entitled_client(client_id))
    or (pb.has_any_role(array['approver', 'operations']) and pb.sees_all_clients()));

-- rpt.qa_result follows its package. Findings are written by the QA step (the system actor);
-- an approver adds the override.
create policy read_visible on rpt.qa_result for select to pb_app
  using (pb.package_visible(package_id));
create policy record_finding on rpt.qa_result for insert to pb_app
  with check (pb.has_role('service') and pb.package_visible(package_id));
create policy override_finding on rpt.qa_result for update to pb_app
  using (pb.has_any_role(array['approver', 'service']) and pb.package_visible(package_id))
  with check (pb.has_any_role(array['approver', 'service']) and pb.package_visible(package_id));
