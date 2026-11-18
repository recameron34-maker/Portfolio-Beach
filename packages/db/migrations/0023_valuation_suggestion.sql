-- 0023 Valuation suggestions (docs/04 M10, docs/08 section 12, docs/18 section 14, docs/03,
-- decision 0023).
-- mon.valuation_suggestion is one row per mark the platform worked out from an approved capital
-- account statement or sponsor report, for one position and one calendar quarter: the value (or
-- the reason there is none), the rule it rests on, every input with where it was read, the run
-- that produced it and who stood behind that run. A person in operations opens a draft valuation
-- from it, puts it on a Draft already open, or dismisses it; a later approval replaces it. A
-- suggestion is never a mark: mon.valuation is written only through the valuation workflow
-- (docs/18 section 1), so the accounting export reads what it read before. No existing table
-- changes.
--
-- Not stg.valuation: that table belongs to an intake file, is keyed on a report date and an
-- investment number, follows the staging states and cannot be superseded (decision 0023).
--
-- Access (SEC-5.1, SEC-5.3): operations, the deal team, approvers, auditors and the system actor
-- read a suggestion, inside the wall of its position; viewers, investor relations and platform
-- admins read none. Only the system actor writes one. Operations accept or dismiss and the system
-- actor supersedes (two update policies, so the database refuses the other's decision), and the
-- application role may set the decision columns and nothing else.
--
-- Also here: the valuation method a draft opened from a report-based suggestion carries, and the
-- switch that stops suggestions being derived and accepted.
--
-- Rollback note: drop mon.valuation_suggestion with its history table, the function
-- mon.guard_valuation_suggestion and the type mon.valuation_suggestion_state; delete the taxonomy
-- term valuation_method.report_indication (no valuation may carry it) and the feature flag
-- valuation.suggestions.

create type mon.valuation_suggestion_state as enum ('Open', 'Accepted', 'Dismissed', 'Superseded');

create table mon.valuation_suggestion (
  id uuid primary key default gen_random_uuid(),
  -- The position (the wall) and the calendar quarter end the suggestion is for.
  investment_id uuid not null references core.investment (id),
  period_end date not null
    check (extract(day from (period_end + 1)) = 1 and extract(month from (period_end + 1)) in (1, 4, 7, 10)),
  -- What the value rests on (docs/08 section 12): the ending balance of a position-level capital
  -- account statement, the equity value the sponsor's report states, or that report with the
  -- earlier multiple held. Never a blend.
  basis text not null check (basis in ('capital_account_balance', 'sponsor_equity_value', 'held_multiple')),
  -- The valuation method a draft opened from the suggestion carries.
  method text not null references core.taxonomy_term (code) check (method like 'valuation_method.%'),
  -- Dollars to the cent and above zero, or the reason there is no value (a code of docs/08
  -- section 12): exactly one of the two. "Not calculable" is data, not a state.
  suggested_value numeric(20,2) check (suggested_value is null or suggested_value > 0),
  reason_code text check (reason_code is null or reason_code ~ '^[a-z]+(_[a-z]+)*$'),
  -- { inputs: [{ key, value, periodEnd, source: { kind, id, page }, edited }] }: each figure the
  -- rule read, the period it is for and where it came from (a page of a document, a reviewer who
  -- typed it, the approved record or a valuation).
  workings jsonb not null default '{"inputs": []}'::jsonb,
  -- The approved run that produced the row and its document (SEC-9.4), and where the first input
  -- read from that document sits; null when no input was read from it.
  source_document_id uuid not null references doc.document (id),
  extraction_run_id uuid not null references doc.extraction_run (id),
  source_page integer check (source_page is null or source_page >= 1),
  source_locator text,
  -- The approver of each run an input came from, and whoever typed one over what was read. None of
  -- them may approve a valuation the suggestion is accepted onto (docs/18 section 1).
  source_reviewer_ids uuid[] not null default '{}',
  prompt_version text,
  model_id text,
  calc_version text not null,
  state mon.valuation_suggestion_state not null default 'Open',
  -- Who moved the suggestion out of Open, and when: a person in operations (accepted, dismissed)
  -- or the system actor (superseded).
  decided_by uuid references core.app_user (id),
  decided_at timestamptz,
  decision_reason text,
  -- The draft valuation the suggestion was accepted onto. Not unique: a Draft can take the value
  -- of a second suggestion after the first.
  valuation_id uuid references mon.valuation (id),
  superseded_reason text
    check (superseded_reason is null
      or superseded_reason in ('better_source', 'figures_changed', 'mark_locked', 'position_closed')),
  -- The suggestion written in place of this one. It is written after this one is superseded (one
  -- Open suggestion per position and quarter), so the reference is checked when the transaction
  -- commits.
  superseded_by_id uuid references mon.valuation_suggestion (id) deferrable initially deferred,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check ((suggested_value is null) <> (reason_code is null)),
  check (jsonb_typeof(workings) = 'object' and coalesce(jsonb_typeof(workings -> 'inputs'), '') = 'array'),
  -- An Open suggestion names nobody; every other state names who decided, and when.
  check ((state = 'Open') = (decided_by is null)),
  check ((decided_by is null) = (decided_at is null)),
  -- A dismissal says why, and only a dismissal carries that reason.
  check ((state = 'Dismissed') = (decision_reason is not null)),
  check (decision_reason is null or length(btrim(decision_reason)) > 0),
  -- An accepted suggestion has a value and names the valuation it went onto; no other state does.
  check ((state = 'Accepted') = (valuation_id is not null)),
  check (state <> 'Accepted' or suggested_value is not null),
  -- A superseded suggestion says why. Only one replaced by another names its replacement: one
  -- that a better source replaced always does, one whose figures changed does when anything took
  -- its place, and one closed by a Locked mark or a closed position never does.
  check ((state = 'Superseded') = (superseded_reason is not null)),
  check (superseded_by_id is null
    or (superseded_reason is not null and superseded_reason in ('better_source', 'figures_changed'))),
  check (superseded_reason is distinct from 'better_source' or superseded_by_id is not null),
  check (superseded_by_id is null or superseded_by_id <> id)
);
-- One Open suggestion per position and quarter.
create unique index valuation_suggestion_one_open_idx on mon.valuation_suggestion (investment_id, period_end) where state = 'Open';
create index valuation_suggestion_investment_idx on mon.valuation_suggestion (investment_id, period_end desc, created_at desc);
create index valuation_suggestion_run_idx on mon.valuation_suggestion (extraction_run_id);
create index valuation_suggestion_valuation_idx on mon.valuation_suggestion (valuation_id) where valuation_id is not null;
create index valuation_suggestion_replacement_idx on mon.valuation_suggestion (superseded_by_id) where superseded_by_id is not null;
call pb.add_standard_columns_trigger('mon.valuation_suggestion');

----------------------------------------------------------------------------------------------
-- The life of a suggestion (docs/18 section 14). It starts Open, from an approved run of its own
-- position. It keeps its figures and its source for good: a change in the figures is a new
-- suggestion that replaces it. It leaves Open once, to Accepted, Dismissed or Superseded, and the
-- three are final. Inside a user transaction a decision names whoever is acting; which role may
-- take which decision is the policies' below. The owner connection (migrations and the local
-- seed) has no user, so it supplies the name itself; the rest binds it too.
----------------------------------------------------------------------------------------------
create or replace function mon.guard_valuation_suggestion() returns trigger
language plpgsql as $$
declare
  actor uuid := pb.current_user_id();
  run_investment uuid;
  run_document uuid;
  run_approver uuid;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'Open' then
      raise exception 'a valuation suggestion starts Open' using errcode = 'P0001';
    end if;
    select r.investment_id, r.document_id, r.approved_by into run_investment, run_document, run_approver
    from doc.extraction_run r where r.id = new.extraction_run_id;
    -- No such run: the foreign key refuses the row.
    if found and (run_investment is distinct from new.investment_id
        or run_document is distinct from new.source_document_id or run_approver is null) then
      raise exception 'a valuation suggestion comes from an approved run of its own position and names that run''s document'
        using errcode = 'P0001';
    end if;
    -- A suggestion superseded in this transaction may already name this one as its replacement.
    if exists (
      select 1 from mon.valuation_suggestion s
      where s.superseded_by_id = new.id
        and (s.investment_id <> new.investment_id or s.period_end <> new.period_end)) then
      raise exception 'a valuation suggestion is replaced by one for the same position and quarter'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if old.state <> 'Open' then
    raise exception 'valuation suggestion % is % and cannot change; a later approval writes a new one', old.id, old.state
      using errcode = 'P0001';
  end if;
  if new.id <> old.id or new.investment_id <> old.investment_id or new.period_end <> old.period_end
     or new.basis <> old.basis or new.method <> old.method
     or new.suggested_value is distinct from old.suggested_value
     or new.reason_code is distinct from old.reason_code
     or new.workings <> old.workings
     or new.source_document_id <> old.source_document_id
     or new.extraction_run_id <> old.extraction_run_id
     or new.source_page is distinct from old.source_page
     or new.source_locator is distinct from old.source_locator
     or new.source_reviewer_ids <> old.source_reviewer_ids
     or new.prompt_version is distinct from old.prompt_version
     or new.model_id is distinct from old.model_id
     or new.calc_version <> old.calc_version then
    raise exception 'a valuation suggestion keeps its figures and its source; a new one replaces it'
      using errcode = 'P0001';
  end if;
  if new.state = 'Open' then
    return new;
  end if;

  if actor is not null and new.decided_by is distinct from actor then
    raise exception 'a decision on a valuation suggestion names whoever made it' using errcode = 'P0001';
  end if;
  if new.state = 'Accepted' and new.valuation_id is not null and not exists (
      select 1 from mon.valuation v where v.id = new.valuation_id and v.investment_id = new.investment_id) then
    raise exception 'a valuation suggestion is accepted onto a valuation of its own position'
      using errcode = 'P0001';
  end if;
  -- The replacement is normally written next; one written before must be for the same quarter.
  if new.superseded_by_id is not null and exists (
      select 1 from mon.valuation_suggestion s
      where s.id = new.superseded_by_id
        and (s.investment_id <> new.investment_id or s.period_end <> new.period_end)) then
    raise exception 'a valuation suggestion is replaced by one for the same position and quarter'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger guard_suggestion before insert or update on mon.valuation_suggestion
  for each row execute function mon.guard_valuation_suggestion();
create trigger no_delete before delete on mon.valuation_suggestion
  for each row execute function pb.reject_mutation();

call audit.add_history('mon.valuation_suggestion');

-- Grants: exactly what the policies allow. A suggestion is inserted whole and never deleted, and
-- the application role may set its decision columns only.
grant select, insert on mon.valuation_suggestion to pb_app;
grant update (state, decided_by, decided_at, decision_reason, valuation_id, superseded_reason, superseded_by_id)
  on mon.valuation_suggestion to pb_app;

alter table mon.valuation_suggestion enable row level security;
alter table mon.valuation_suggestion force row level security;

-- A suggestion follows its position (pb.investment_visible asks core.investment, so the wall
-- applies exactly once), and of those who can open the position only the roles that work on
-- valuations read it: a viewer, investor relations and a platform admin are given nothing.
create policy read_reviewers on mon.valuation_suggestion for select to pb_app
  using (pb.has_any_role(array['operations', 'deal_team', 'approver', 'auditor', 'service'])
    and pb.investment_visible(investment_id));
create policy insert_service on mon.valuation_suggestion for insert to pb_app
  with check (pb.has_role('service') and pb.investment_visible(investment_id));
-- Two update policies, one per writer. The row as it will be must pass one of them, so a person
-- in operations can accept or dismiss and never supersede, and the system actor can supersede
-- and never decide for a person.
create policy decide_operations on mon.valuation_suggestion for update to pb_app
  using (pb.has_role('operations') and pb.investment_visible(investment_id))
  with check (pb.has_role('operations') and pb.investment_visible(investment_id)
    and state in ('Open', 'Accepted', 'Dismissed'));
create policy supersede_service on mon.valuation_suggestion for update to pb_app
  using (pb.has_role('service') and pb.investment_visible(investment_id))
  with check (pb.has_role('service') and pb.investment_visible(investment_id)
    and state in ('Open', 'Superseded'));

----------------------------------------------------------------------------------------------
-- Reference data. A draft opened from a statement-based suggestion carries the existing method
-- "Sponsor mark"; one opened from a report-based suggestion carries this one (not "Market
-- multiple": the multiple held is the sponsor's own earlier one, not one from comparable
-- companies). The flag is on: off, nothing is derived and nothing is accepted, and open
-- suggestions can still be read and dismissed.
----------------------------------------------------------------------------------------------
insert into core.taxonomy_term (domain, code, label, sort_order) values
  ('valuation_method', 'valuation_method.report_indication', 'Indication from sponsor report', 7);
insert into ops.feature_flag (key, enabled, description) values
  ('valuation.suggestions', true, 'Valuation suggestions from approved statements and sponsor reports');
