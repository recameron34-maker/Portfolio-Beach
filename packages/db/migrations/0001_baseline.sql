-- 0001 Baseline: schemas, application role, helper functions (docs/03 section 1, docs/05 SEC-5).
-- Rollback note: drop schemas core, deal, mon, doc, rel, rpt, ops, stg, audit, pb cascade; drop role pb_app.

create schema if not exists core;
create schema if not exists deal;
create schema if not exists mon;
create schema if not exists doc;
create schema if not exists rel;
create schema if not exists rpt;
create schema if not exists ops;
create schema if not exists stg;
create schema if not exists audit;
create schema if not exists pb;

-- The API connects as pb_app (never as the owner). In the prototype it is a NOLOGIN role that
-- tests and the API adopt with SET LOCAL ROLE; in production it is a login role whose credential
-- lives in Key Vault (SEC-4.6). Everything pb_app can do is listed explicitly in grants below.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pb_app') then
    create role pb_app nologin;
  end if;
end $$;

grant usage on schema core, deal, mon, doc, rel, rpt, ops, stg, audit, pb to pb_app;

-- Per-transaction identity, set by the API with set_config(..., true) (docs/03 section 1).
create or replace function pb.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function pb.current_roles() returns text[]
language sql stable as $$
  select coalesce(string_to_array(nullif(current_setting('app.roles', true), ''), ','), '{}'::text[])
$$;

create or replace function pb.has_role(role_name text) returns boolean
language sql stable as $$
  select role_name = any (pb.current_roles())
$$;

create or replace function pb.has_any_role(role_names text[]) returns boolean
language sql stable as $$
  select pb.current_roles() && role_names
$$;

-- Client entitlements (SEC-5.2): comma-separated client ids set per transaction.
create or replace function pb.entitled_client(client uuid) returns boolean
language sql stable as $$
  select client::text = any (coalesce(string_to_array(nullif(current_setting('app.client_ids', true), ''), ','), '{}'::text[]))
$$;

-- Roles that see every client's Restricted data without an entitlement (operations, approvers,
-- auditors). Platform admins are deliberately absent (SEC-5.4).
create or replace function pb.sees_all_clients() returns boolean
language sql stable as $$
  select pb.has_any_role(array['operations', 'approver', 'auditor'])
$$;

-- Standard column maintenance: created_by / updated_by / updated_at / row_version.
create or replace function pb.touch_row() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.created_by := coalesce(new.created_by, pb.current_user_id());
    new.updated_at := new.created_at;
    new.updated_by := new.created_by;
    new.row_version := 1;
  else
    new.updated_at := now();
    new.updated_by := coalesce(pb.current_user_id(), new.updated_by);
    new.row_version := old.row_version + 1;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  return new;
end $$;

-- Attaches the standard-column trigger to a table.
create or replace procedure pb.add_standard_columns_trigger(target regclass)
language plpgsql as $$
begin
  execute format('drop trigger if exists touch_row on %s', target);
  execute format('create trigger touch_row before insert or update on %s for each row execute function pb.touch_row()', target);
end $$;

-- History tables (docs/03 section 1, SEC-9.2): <table>_history holds a full row image per change.
-- The trigger function is SECURITY DEFINER so pb_app cannot write history directly.
create or replace function audit.record_history() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  history_table text := tg_table_schema || '.' || tg_table_name || '_history';
  image jsonb;
  row_id uuid;
begin
  if tg_op = 'DELETE' then
    image := to_jsonb(old);
  else
    image := to_jsonb(new);
  end if;
  -- Tables with composite keys (wall_member, walled_record) have no id column; the image still carries their key.
  row_id := (image ->> 'id')::uuid;
  execute format('insert into %s (row_id, op, actor_id, at, row_image) values ($1, $2, $3, now(), $4)', history_table)
    using row_id, tg_op, pb.current_user_id(), image;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create or replace procedure audit.add_history(target regclass)
language plpgsql as $$
declare
  schema_name text;
  table_name text;
begin
  select n.nspname, c.relname into schema_name, table_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = target;
  execute format(
    'create table if not exists %I.%I (history_id bigint generated always as identity primary key, row_id uuid, op text not null check (op in (''INSERT'',''UPDATE'',''DELETE'')), actor_id uuid, at timestamptz not null default now(), row_image jsonb not null)',
    schema_name, table_name || '_history');
  execute format('create index if not exists %I on %I.%I (row_id, at)', table_name || '_history_row_idx', schema_name, table_name || '_history');
  execute format('alter table %I.%I enable row level security', schema_name, table_name || '_history');
  execute format('alter table %I.%I force row level security', schema_name, table_name || '_history');
  execute format('grant select on %I.%I to pb_app', schema_name, table_name || '_history');
  execute format('drop policy if exists history_read on %I.%I', schema_name, table_name || '_history');
  execute format('create policy history_read on %I.%I for select to pb_app using (pb.has_any_role(array[''operations'',''approver'',''auditor'']))', schema_name, table_name || '_history');
  execute format('drop trigger if exists record_history on %s', target);
  execute format('create trigger record_history after insert or update or delete on %s for each row execute function audit.record_history()', target);
end $$;

-- Immutability guard used on audit.event and Locked rows.
create or replace function pb.reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'rows in % are immutable (%)', tg_table_name, tg_op using errcode = 'P0001';
end $$;
