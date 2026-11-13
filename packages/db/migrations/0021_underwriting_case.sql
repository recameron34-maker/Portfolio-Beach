-- 0021 The sponsor's underwritten base case of a position (docs/04 M9, docs/08 section 11,
-- docs/18 section 13, docs/03, decision 0022).
-- mon.underwriting_case is one row per version of the base case the sponsor underwrote when we
-- invested: the case date, the planned exit, the exit multiple, the underwritten gross MOIC and
-- IRR and, for a loan, the underwritten yield and loss rate, with its source, who entered it and
-- who confirmed it. mon.underwriting_case_point holds the plan of an equity case at each date
-- (twelve-month revenue and EBITDA and net debt, on the basis mon.quarterly_performance uses).
-- No existing table changes, so the accounting import and export are untouched.
--
-- Two people (SEC-5.6, SEC-9.1): a case starts as a Draft, a second person confirms it, and only a
-- Confirmed case is compared. Versions are kept (SEC-9.2): a Confirmed case never changes, it is
-- superseded by a correction dated as it is, or withdrawn with a reason; nothing is deleted.
--
-- Access (SEC-5.1, SEC-5.3): a base case follows its position. Whoever can open the position
-- reads it, so a wall on the position covers it; the deal team records and edits, the deal team
-- and approvers confirm and withdraw (the state machine narrows each command to its role).
--
-- Rollback note: drop mon.underwriting_case_point and mon.underwriting_case with their history
-- tables, the functions mon.guard_underwriting_case_point, mon.guard_underwriting_case and
-- pb.underwriting_case_visible, and the type mon.underwriting_case_state.

create type mon.underwriting_case_state as enum ('Draft', 'Confirmed', 'Superseded', 'Withdrawn');

create table mon.underwriting_case (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null references core.investment (id),
  version integer not null check (version >= 1),
  -- equity: plan points and exit terms (co-investments and continuation vehicles). credit: the
  -- underwritten yield and loss rate. The API takes the form from the position's deal type.
  form text not null check (form in ('equity', 'credit')),
  state mon.underwriting_case_state not null default 'Draft',
  -- The date the case was underwritten as of, and the planned exit (a loan: expected repayment).
  case_date date not null,
  planned_exit_date date not null,
  -- EV / EBITDA at the planned exit.
  exit_multiple numeric(12,6),
  -- From our entry to the planned exit, gross.
  gross_moic numeric(12,6) not null check (gross_moic > 0),
  gross_irr numeric(12,8) not null check (gross_irr > -1),
  underwritten_yield numeric(12,8),
  annual_loss_rate numeric(12,8),
  -- Covers the plan points too. The prototype is US dollars only (docs/03 section 1).
  currency char(3) not null default 'USD' check (currency = 'USD'),
  note text,
  -- Why this version replaces or follows the one before it.
  revision_reason text,
  withdrawn_reason text,
  -- Where the figures come from (SEC-9.4): a document of the position with a page or a sheet and
  -- cell, or a note on where the model is held.
  source_document_id uuid references doc.document (id),
  source_page integer check (source_page is null or source_page >= 1),
  source_locator text,
  source_note text,
  -- The last person to change the figures, and when. Every edit resets both.
  entered_by uuid not null references core.app_user (id),
  entered_at timestamptz not null default now(),
  confirmed_by uuid references core.app_user (id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (investment_id, version),
  check (planned_exit_date > case_date),
  -- An equity case has an exit multiple above zero; a loan has none.
  check ((form = 'equity') = (exit_multiple is not null)),
  check (exit_multiple is null or exit_multiple > 0),
  -- A loan has an underwritten yield; an equity case has neither a yield nor a loss rate.
  check ((form = 'credit') = (underwritten_yield is not null)),
  check (underwritten_yield is null or underwritten_yield > -1),
  check (annual_loss_rate is null or (form = 'credit' and annual_loss_rate >= 0 and annual_loss_rate <= 1)),
  check (version = 1 or (revision_reason is not null and length(btrim(revision_reason)) > 0)),
  -- A withdrawn case says why, and only a withdrawn case carries that reason.
  check ((state = 'Withdrawn') = (withdrawn_reason is not null)),
  check (withdrawn_reason is null or length(btrim(withdrawn_reason)) > 0),
  -- Outside a Draft a case names its source (SEC-9.4).
  check (state = 'Draft' or source_document_id is not null
    or (source_note is not null and length(btrim(source_note)) > 0)),
  -- The person who last changed the figures never confirms them (SEC-5.6).
  check (confirmed_by is null or confirmed_by <> entered_by),
  check ((confirmed_by is null) = (confirmed_at is null)),
  check (state <> 'Draft' or confirmed_by is null),
  check (state not in ('Confirmed', 'Superseded') or confirmed_by is not null)
);
-- One Draft per position, and one Confirmed case per position and case date: a correction
-- supersedes the case it corrects before it is confirmed; a later date is a re-underwriting and
-- both stay.
create unique index underwriting_case_one_draft_idx on mon.underwriting_case (investment_id) where state = 'Draft';
create unique index underwriting_case_confirmed_date_idx on mon.underwriting_case (investment_id, case_date) where state = 'Confirmed';
call pb.add_standard_columns_trigger('mon.underwriting_case');

create table mon.underwriting_case_point (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references mon.underwriting_case (id),
  period_end date not null,
  -- Revenue and EBITDA are the twelve months ending on period_end; net debt is at that date. A
  -- figure the sponsor did not give is null, never a zero.
  revenue_ltm numeric(20,2),
  ebitda_ltm numeric(20,2),
  net_debt numeric(20,2),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (case_id, period_end),
  check (revenue_ltm is not null or ebitda_ltm is not null or net_debt is not null)
);
call pb.add_standard_columns_trigger('mon.underwriting_case_point');

----------------------------------------------------------------------------------------------
-- The life of a case (docs/18 section 13). A case starts as a Draft. A Draft may change in full,
-- and is confirmed or withdrawn. A Confirmed case changes only by being superseded or withdrawn.
-- Superseded and Withdrawn are final. The two-person rule is the database's too: inside a user
-- transaction a new case and every edit of a Draft name the person acting as entered_by, a
-- confirmation names the person acting as confirmed_by and changes nothing else, and the check
-- above refuses a confirmation by entered_by. The owner connection (migrations and the local
-- seed) has no user, so it supplies the names itself.
----------------------------------------------------------------------------------------------
create or replace function mon.guard_underwriting_case() returns trigger
language plpgsql as $$
declare
  actor uuid := pb.current_user_id();
  figures_changed boolean;
  point_count integer;
  last_point date;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'Draft' then
      raise exception 'a base case starts as a Draft' using errcode = 'P0001';
    end if;
    if actor is not null and new.entered_by <> actor then
      raise exception 'a base case names the person who enters it' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if old.state in ('Superseded', 'Withdrawn') then
    raise exception 'base case % is % and cannot change; record a new version', old.id, old.state
      using errcode = 'P0001';
  end if;
  if new.id <> old.id or new.investment_id <> old.investment_id or new.version <> old.version
     or new.form <> old.form then
    raise exception 'a base case keeps its position, version and form' using errcode = 'P0001';
  end if;
  figures_changed :=
    new.case_date <> old.case_date or new.planned_exit_date <> old.planned_exit_date
    or new.exit_multiple is distinct from old.exit_multiple
    or new.gross_moic <> old.gross_moic or new.gross_irr <> old.gross_irr
    or new.underwritten_yield is distinct from old.underwritten_yield
    or new.annual_loss_rate is distinct from old.annual_loss_rate
    or new.currency <> old.currency
    or new.note is distinct from old.note
    or new.revision_reason is distinct from old.revision_reason
    or new.source_document_id is distinct from old.source_document_id
    or new.source_page is distinct from old.source_page
    or new.source_locator is distinct from old.source_locator
    or new.source_note is distinct from old.source_note
    or new.entered_by <> old.entered_by or new.entered_at <> old.entered_at;

  if old.state = 'Draft' then
    if new.state = 'Draft' then
      if actor is not null and new.entered_by <> actor then
        raise exception 'an edit of a base case names the person who made it' using errcode = 'P0001';
      end if;
    elsif new.state = 'Confirmed' then
      if figures_changed then
        raise exception 'a confirmation changes nothing but who confirmed the base case and when'
          using errcode = 'P0001';
      end if;
      if actor is not null and new.confirmed_by is distinct from actor then
        raise exception 'a confirmation names the person confirming' using errcode = 'P0001';
      end if;
      -- An equity case is confirmed with its plan: two points at least, the last on the planned exit.
      if new.form = 'equity' then
        select count(*), max(p.period_end) into point_count, last_point
        from mon.underwriting_case_point p where p.case_id = new.id;
        if point_count < 2 or last_point <> new.planned_exit_date then
          raise exception 'an equity base case is confirmed with two plan points or more, the last on its planned exit'
            using errcode = 'P0001';
        end if;
      end if;
    elsif new.state = 'Withdrawn' then
      if figures_changed then
        raise exception 'a withdrawal changes nothing but the state and its reason' using errcode = 'P0001';
      end if;
    else
      raise exception 'a Draft base case is confirmed or withdrawn, nothing else' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- Confirmed: only the state moves, with the reason when it is withdrawn.
  if new.state not in ('Superseded', 'Withdrawn') then
    raise exception 'base case % is Confirmed and changes only by being superseded or withdrawn', old.id
      using errcode = 'P0001';
  end if;
  if figures_changed or new.confirmed_by is distinct from old.confirmed_by
     or new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'a Confirmed base case keeps its figures; record a new version instead'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger guard_case before insert or update on mon.underwriting_case
  for each row execute function mon.guard_underwriting_case();
create trigger no_delete before delete on mon.underwriting_case
  for each row execute function pb.reject_mutation();

-- Visibility of a case's points: the case's own (the policy on mon.underwriting_case decides,
-- and that one asks the position, so the wall and the role rules apply exactly once).
create or replace function pb.underwriting_case_visible(case_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from mon.underwriting_case c where c.id = case_id)
$$;

-- Plan points belong to an equity case and are written only while it is a Draft: they are
-- replaced as a set by an edit, and fixed with the case once it is confirmed.
create or replace function mon.guard_underwriting_case_point() returns trigger
language plpgsql as $$
declare
  target uuid;
  case_state mon.underwriting_case_state;
  case_form text;
begin
  if tg_op = 'DELETE' then
    target := old.case_id;
  else
    target := new.case_id;
    if tg_op = 'UPDATE' and new.case_id <> old.case_id then
      raise exception 'a plan point stays with its base case' using errcode = 'P0001';
    end if;
  end if;
  select c.state, c.form into case_state, case_form from mon.underwriting_case c where c.id = target;
  if not found then
    -- No such case, or none the writer can see: the foreign key or the policy refuses the row.
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if case_state <> 'Draft' then
    raise exception 'base case % is % and its plan points cannot change; record a new version', target, case_state
      using errcode = 'P0001';
  end if;
  if case_form <> 'equity' then
    raise exception 'plan points belong to an equity base case' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
create trigger guard_point before insert or update or delete on mon.underwriting_case_point
  for each row execute function mon.guard_underwriting_case_point();

call audit.add_history('mon.underwriting_case');
call audit.add_history('mon.underwriting_case_point');

-- Grants: exactly what the policies allow. A case is never deleted; its points are replaced as a
-- set while it is a Draft, as the lines of deal.allocation are.
grant select, insert, update on mon.underwriting_case, mon.underwriting_case_point to pb_app;
grant delete on mon.underwriting_case_point to pb_app;

alter table mon.underwriting_case enable row level security;
alter table mon.underwriting_case force row level security;
alter table mon.underwriting_case_point enable row level security;
alter table mon.underwriting_case_point force row level security;

-- mon.underwriting_case follows its position: whoever can open the position reads its base case,
-- so a walled position's case is invisible outside the wall. The deal team records a case; the
-- deal team and approvers move it on (confirm, supersede, withdraw).
create policy read_visible on mon.underwriting_case for select to pb_app
  using (pb.investment_visible(investment_id));
create policy record_case on mon.underwriting_case for insert to pb_app
  with check (pb.has_role('deal_team') and pb.investment_visible(investment_id));
create policy move_case on mon.underwriting_case for update to pb_app
  using (pb.has_any_role(array['deal_team', 'approver']) and pb.investment_visible(investment_id))
  with check (pb.has_any_role(array['deal_team', 'approver']) and pb.investment_visible(investment_id));

-- The points follow their case; the deal team writes them.
create policy read_visible on mon.underwriting_case_point for select to pb_app
  using (pb.underwriting_case_visible(case_id));
call pb.add_write_policies('mon.underwriting_case_point', array['deal_team'], 'pb.underwriting_case_visible(case_id)');
