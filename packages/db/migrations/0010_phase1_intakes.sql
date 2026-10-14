-- 0010 Phase 1 intakes: company aliases, weekly values in valuation staging, data exceptions under the
-- staged row's wall, and the kill switches of the two drop folders (docs/03 sections 3 and 5, docs/04 M1 and
-- M2, docs/18 sections 2 and 9, decision 0010).
-- Rollback note: drop table core.company_alias_history and core.company_alias; on stg.valuation drop the
-- columns company_name, prior_source, prior_date, findings, link, raw, decided_at, promoted_at,
-- valuation_id and row_no, drop the constraint valuation_intake_file_id_row_no_key and the index
-- valuation_report_date_idx, set report_date, investment_number and reported_value not null again and
-- recreate unique (report_date, investment_number); recreate read_review and write_update on stg.valuation
-- as migration 0006 defines them (role checks only) and drop review_update; recreate read_all and
-- write_update on ops.data_exception as migration 0006 defines them, revoke the column update grant and
-- grant update on the whole table again; delete the taxonomy term valuation_method.weekly_report and the
-- feature flags adapter.weekly_drop and adapter.ops_drop.

----------------------------------------------------------------------------------------------
-- core.company_alias: a name a portfolio company is also known by, matched exactly and never fuzzily
-- (docs/03 section 5). The alias is unique across companies so a match is never ambiguous.
----------------------------------------------------------------------------------------------
create table core.company_alias (
  id uuid primary key default gen_random_uuid(),
  portfolio_company_id uuid not null references core.portfolio_company (id),
  alias text not null unique,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);
create index company_alias_company_idx on core.company_alias (portfolio_company_id);
-- Linking compares names after normalization (lower case, letters and digits only), so two aliases that
-- normalize alike would make an exact match ambiguous; the unique index mirrors that normalization.
create unique index company_alias_normalized_key
  on core.company_alias (lower(regexp_replace(alias, '[^a-zA-Z0-9]+', '', 'g')));
call pb.add_standard_columns_trigger('core.company_alias');
call audit.add_history('core.company_alias');
grant select, insert, update on core.company_alias to pb_app;
alter table core.company_alias enable row level security;
alter table core.company_alias force row level security;
create policy read_all on core.company_alias for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('core.company_alias', array['operations', 'platform_admin']);

----------------------------------------------------------------------------------------------
-- stg.valuation: the weekly report values (docs/04 M2 weekly-report-intake). A row is staged as the
-- file wrote it: the typed columns hold the cells that parse, `raw` holds every cell as text, and a
-- cell that is not a date or a decimal is null here and named by a finding. The prior is the latest
-- Locked mark or the weekly value promoted before it; approval creates a Draft valuation of method
-- weekly_report (valuation_id), never a Locked one.
----------------------------------------------------------------------------------------------
alter table stg.valuation
  alter column report_date drop not null,
  alter column investment_number drop not null,
  alter column reported_value drop not null,
  add column company_name text,
  add column prior_source text check (prior_source in ('locked_mark', 'weekly')),
  add column prior_date date,
  add column findings jsonb not null default '[]'::jsonb,
  add column link jsonb not null default '{}'::jsonb,
  add column raw jsonb not null default '{}'::jsonb,
  add column decided_at timestamptz,
  add column promoted_at timestamptz,
  add column valuation_id uuid references mon.valuation (id),
  add column row_no integer not null,
  -- The move against the prior as a decimal fraction; a nominal prior can make it large.
  alter column variance_pct type numeric(20,8);

-- The date a file reports for when it is not in its rows: a look-through run's as-of date. With the
-- content hash it keeps two runs for different dates apart even when their extracts read the same.
alter table stg.intake_file add column as_of date;

-- A file may carry the same investment and date twice; the later row is staged and flagged (DUP rules)
-- so a person decides. Within a file the row number is the row's locator and is unique.
alter table stg.valuation drop constraint valuation_report_date_investment_number_key;
create index valuation_report_date_idx on stg.valuation (report_date, investment_number);
alter table stg.valuation add constraint valuation_intake_file_id_row_no_key unique (intake_file_id, row_no);

-- The wall of the linked investment is the wall of its staged value (migration 0009 for stg.intake_row):
-- a row linked to an investment the reader cannot open is hidden, an unlinked row is every reviewer's.
-- Import (insert) keeps no wall clause: a weekly report covers the whole book. The deal team updates
-- (it approves, docs/18 section 2); operations and the service write.
drop policy read_review on stg.valuation;
create policy read_review on stg.valuation for select to pb_app
  using (pb.has_any_role(array['operations', 'deal_team', 'approver', 'auditor', 'service'])
    and (investment_id is null or pb.investment_visible(investment_id)));
drop policy write_update on stg.valuation;
create policy write_update on stg.valuation for update to pb_app
  using (pb.has_any_role(array['operations', 'service']) and (investment_id is null or pb.investment_visible(investment_id)))
  with check (pb.has_any_role(array['operations', 'service']) and (investment_id is null or pb.investment_visible(investment_id)));
create policy review_update on stg.valuation for update to pb_app
  using (pb.has_role('deal_team') and (investment_id is null or pb.investment_visible(investment_id)))
  with check (pb.has_role('deal_team') and (investment_id is null or pb.investment_visible(investment_id)));

----------------------------------------------------------------------------------------------
-- ops.data_exception: readable by every authenticated user, except that an exception about a staged
-- row is visible only to someone the row's own policy admits, so a walled position's exceptions stay
-- inside the wall (SEC-5.3). Operations works the queue (docs/18 section 9): it may update the state,
-- the owner and the external ticket, and nothing else; the figures an exception carries are written
-- once by the intake that opened it.
----------------------------------------------------------------------------------------------
drop policy read_all on ops.data_exception;
create policy read_all on ops.data_exception for select to pb_app
  using (pb.is_authenticated()
    and (entity <> 'stg.intake_row' or exists (select 1 from stg.intake_row r where r.id = entity_id))
    and (entity <> 'stg.valuation' or exists (select 1 from stg.valuation v where v.id = entity_id)));
drop policy write_update on ops.data_exception;
create policy write_update on ops.data_exception for update to pb_app
  using (pb.has_role('operations')) with check (pb.has_role('operations'));
revoke update on ops.data_exception from pb_app;
grant update (state, owner_id, external_ticket) on ops.data_exception to pb_app;

----------------------------------------------------------------------------------------------
-- Reference data: the weekly report value as a valuation method, and the drop folders' kill switches.
----------------------------------------------------------------------------------------------
insert into core.taxonomy_term (domain, code, label, sort_order) values
  ('valuation_method', 'valuation_method.weekly_report', 'Weekly report value', 6);
insert into ops.feature_flag (key, enabled, description) values
  ('adapter.weekly_drop', true, 'Weekly report values drop folder adapter'),
  ('adapter.ops_drop', true, 'Operations workbook drop folder adapter');
