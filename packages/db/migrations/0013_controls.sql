-- 0013 Phase 3 controls: the wire instruction register, trade tickets, deal change requests and the
-- deal schema (opportunities, stage history, diligence tasks, IC decisions, allocations, closings,
-- closing items, legal terms) (docs/03 section 3 deal and mon, docs/04 M5, M8, M10, M11, M16 and M22,
-- docs/05 SEC-5.3, SEC-5.6, SEC-9.2, SEC-11.1, SEC-12.1 to SEC-12.4, docs/18 sections 1, 3, 4, 8,
-- 11 and 12, decision 0013).
-- Rollback note: drop the tables in reverse order of creation (deal.legal_term, deal.closing_item,
-- deal.closing, deal.allocation, deal.ic_decision, deal.diligence_task, deal.opportunity_stage_history,
-- deal.opportunity, mon.deal_change_request, mon.trade_ticket, mon.wire_instruction) with their
-- history tables, policies, indexes and triggers; drop the functions pb.opportunity_visible and
-- pb.closing_visible; drop the types deal.closing_state, deal.stage, mon.change_request_state,
-- mon.trade_ticket_state and mon.wire_instruction_state; alter table mon.capital_notice drop the
-- columns urgency_flag, wire_change_flag, funded_at and funded_by; delete the taxonomy terms of the
-- domains pass_reason, change_type, legal_term_type and diligence_workstream.

----------------------------------------------------------------------------------------------
-- Workflow states (docs/18 sections 4, 8, 11 and 12). Business lists stay in core.taxonomy_term.
----------------------------------------------------------------------------------------------
create type mon.wire_instruction_state as enum ('Proposed', 'Verified', 'Rejected', 'Superseded');
create type mon.trade_ticket_state as enum ('Drafted', 'Approved', 'Funded', 'Withdrawn');
create type mon.change_request_state as enum ('Submitted', 'Routed', 'InProgress', 'Applied', 'Rejected');
create type deal.stage as enum ('Sourced', 'Screening', 'Prescreen', 'Diligence', 'IC', 'Approved', 'Closing', 'Closed', 'Passed');
create type deal.closing_state as enum ('Open', 'OpsConfirmed');

----------------------------------------------------------------------------------------------
-- Reference data: why a deal was passed, what kind of change a request records, the legal terms
-- captured at close and the diligence workstreams. Labels are plain words.
----------------------------------------------------------------------------------------------
insert into core.taxonomy_term (domain, code, label, sort_order) values
  ('pass_reason', 'pass_reason.valuation', 'Valuation', 1),
  ('pass_reason', 'pass_reason.fund_fit', 'Fund fit', 2),
  ('pass_reason', 'pass_reason.sponsor', 'Sponsor', 3),
  ('pass_reason', 'pass_reason.sector', 'Sector', 4),
  ('pass_reason', 'pass_reason.timing', 'Timing', 5),
  ('pass_reason', 'pass_reason.lost_to_competitor', 'Lost to a competitor', 6),
  ('pass_reason', 'pass_reason.diligence_findings', 'Diligence findings', 7),
  ('pass_reason', 'pass_reason.other', 'Other', 8),
  ('change_type', 'change_type.add_on_acquisition', 'Add-on acquisition', 1),
  ('change_type', 'change_type.new_security', 'New security', 2),
  ('change_type', 'change_type.distribution_treatment', 'Distribution treatment', 3),
  ('change_type', 'change_type.recapitalization', 'Recapitalization', 4),
  ('change_type', 'change_type.partial_exit', 'Partial exit', 5),
  ('change_type', 'change_type.ownership_change', 'Ownership change', 6),
  ('change_type', 'change_type.name_change', 'Name change', 7),
  ('change_type', 'change_type.structure_change', 'Structure change', 8),
  ('change_type', 'change_type.other', 'Other', 9),
  ('legal_term_type', 'legal_term_type.management_fee', 'Management fee', 1),
  ('legal_term_type', 'legal_term_type.carried_interest', 'Carried interest', 2),
  ('legal_term_type', 'legal_term_type.preferred_return', 'Preferred return', 3),
  ('legal_term_type', 'legal_term_type.key_person', 'Key person', 4),
  ('legal_term_type', 'legal_term_type.transfer_restriction', 'Transfer restriction', 5),
  ('legal_term_type', 'legal_term_type.information_rights', 'Information rights', 6),
  ('legal_term_type', 'legal_term_type.mfn', 'Most favored nation', 7),
  ('legal_term_type', 'legal_term_type.co_invest_right', 'Co-investment right', 8),
  ('legal_term_type', 'legal_term_type.consent_requirement', 'Consent requirement', 9),
  ('legal_term_type', 'legal_term_type.notice_requirement', 'Notice requirement', 10),
  ('diligence_workstream', 'diligence_workstream.commercial', 'Commercial', 1),
  ('diligence_workstream', 'diligence_workstream.financial', 'Financial', 2),
  ('diligence_workstream', 'diligence_workstream.legal', 'Legal', 3),
  ('diligence_workstream', 'diligence_workstream.tax', 'Tax', 4),
  ('diligence_workstream', 'diligence_workstream.esg', 'ESG', 5),
  ('diligence_workstream', 'diligence_workstream.operational', 'Operational', 6),
  ('diligence_workstream', 'diligence_workstream.references', 'References', 7),
  ('diligence_workstream', 'diligence_workstream.sponsor', 'Sponsor', 8);

----------------------------------------------------------------------------------------------
-- mon.wire_instruction: the wire instruction register (SEC-12.2). One row per version of a
-- counterparty's instructions; the counterparty is a sponsor fund or an investment, never both. The
-- bank details are encrypted at the application layer (packages/db/src/fieldCrypto.ts, AES-256-GCM,
-- base64 of iv || tag || ciphertext, over the JSON { bankName, accountName, accountNumber,
-- routingCode, reference }) and never stored in plaintext; the masked form ("<bank> ****<last 4>")
-- is what the pages show. A new or changed instruction is a new version in Proposed; it becomes
-- Verified only through a callback to an independently sourced number made by a person other than
-- the proposer, and only a Verified version can be the active one. source_note is plain words about
-- how the instruction reached us, never a document or an email body (SEC-12.1).
----------------------------------------------------------------------------------------------
create table mon.wire_instruction (
  id uuid primary key default gen_random_uuid(),
  sponsor_fund_id uuid references core.sponsor_fund (id),
  investment_id uuid references core.investment (id),
  counterparty_name text not null,
  version integer not null check (version >= 1),
  bank_details_enc text not null,
  bank_details_masked text not null,
  state mon.wire_instruction_state not null default 'Proposed',
  proposed_by uuid not null references core.app_user (id),
  proposed_at timestamptz not null default now(),
  source_note text,
  callback_by uuid references core.app_user (id),
  callback_at timestamptz,
  callback_number_source text check (callback_number_source in ('prior_instruction', 'sponsor_website', 'known_contact', 'fund_administrator')),
  callback_result text check (callback_result in ('confirmed', 'not_confirmed')),
  verified_at timestamptz,
  rejection_reason text,
  active boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  -- Exactly one counterparty kind.
  check ((sponsor_fund_id is null) <> (investment_id is null)),
  -- The callback is made by a second person (SEC-12.2, SEC-5.6).
  check (callback_by is null or callback_by <> proposed_by),
  -- Verified means a confirmed callback by a named person at a known time.
  check (state <> 'Verified' or (callback_result = 'confirmed' and callback_by is not null and verified_at is not null)),
  check (state <> 'Rejected' or rejection_reason is not null),
  -- Only a Verified version can be the active one.
  check (active = false or state = 'Verified')
);
-- Versions are unique per counterparty, and the two kinds each keep one active version. The partial
-- unique indexes also serve the lookups by counterparty.
create unique index wire_instruction_sponsor_fund_version_key on mon.wire_instruction (sponsor_fund_id, version) where sponsor_fund_id is not null;
create unique index wire_instruction_investment_version_key on mon.wire_instruction (investment_id, version) where investment_id is not null;
create unique index wire_instruction_sponsor_fund_active_idx on mon.wire_instruction (sponsor_fund_id) where active and sponsor_fund_id is not null;
create unique index wire_instruction_investment_active_idx on mon.wire_instruction (investment_id) where active and investment_id is not null;
create index wire_instruction_state_idx on mon.wire_instruction (state, proposed_at);
call pb.add_standard_columns_trigger('mon.wire_instruction');

----------------------------------------------------------------------------------------------
-- mon.trade_ticket: dual control on funding (SEC-12.3). One ticket per capital notice, prepared by
-- one person and approved by another against a named Verified wire instruction version; a ticket is
-- never Approved or Funded without both. Whether the instruction is still unchanged within the hold
-- window (config/definitions.json capitalActivity.wireChangeHoldDays) is the API's check at approval.
----------------------------------------------------------------------------------------------
create table mon.trade_ticket (
  id uuid primary key default gen_random_uuid(),
  capital_notice_id uuid not null unique references mon.capital_notice (id),
  wire_instruction_id uuid references mon.wire_instruction (id),
  amount numeric(20,2) not null check (amount > 0),
  currency char(3) not null default 'USD',
  funding_date date not null,
  prepared_by uuid not null references core.app_user (id),
  prepared_at timestamptz not null default now(),
  approved_by uuid references core.app_user (id),
  approved_at timestamptz,
  state mon.trade_ticket_state not null default 'Drafted',
  withdrawn_reason text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  -- The preparer never approves (SEC-5.6, SEC-12.3).
  check (approved_by is null or approved_by <> prepared_by),
  check (state not in ('Approved', 'Funded') or (approved_by is not null and wire_instruction_id is not null)),
  check (state <> 'Withdrawn' or withdrawn_reason is not null)
);
create index trade_ticket_state_idx on mon.trade_ticket (state, funding_date);
create index trade_ticket_wire_instruction_idx on mon.trade_ticket (wire_instruction_id);
call pb.add_standard_columns_trigger('mon.trade_ticket');

----------------------------------------------------------------------------------------------
-- mon.capital_notice: the SEC-12.4 alert flags and the funding confirmation. urgency_flag is set by
-- the API from the notice document's text against capitalActivity.urgencyPhrases; wire_change_flag
-- when the document says the instructions changed or a new wire version is proposed for the
-- counterparty. funded_* record who confirmed the wire went out and when.
----------------------------------------------------------------------------------------------
alter table mon.capital_notice
  add column urgency_flag boolean not null default false,
  add column wire_change_flag boolean not null default false,
  add column funded_at timestamptz,
  add column funded_by uuid references core.app_user (id);

----------------------------------------------------------------------------------------------
-- mon.deal_change_request: a change to a position the deal team reports and operations applies
-- in a period (docs/04 M11, docs/18 section 8). details is a small map of plain values, summary one
-- line; applied_period is the quarter end the change was applied in, so the quarter-end check can
-- list every request not yet Applied.
----------------------------------------------------------------------------------------------
create table mon.deal_change_request (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid not null references core.investment (id),
  change_type text not null references core.taxonomy_term (code) check (change_type like 'change_type.%'),
  effective_date date not null,
  details jsonb not null default '{}'::jsonb,
  summary text not null,
  owner_id uuid references core.app_user (id),
  submitted_by uuid not null references core.app_user (id),
  state mon.change_request_state not null default 'Submitted',
  applied_period date,
  applied_by uuid references core.app_user (id),
  applied_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check (state <> 'Applied' or (applied_period is not null and applied_by is not null)),
  check (state <> 'Rejected' or rejection_reason is not null),
  check (state not in ('Routed', 'InProgress', 'Applied') or owner_id is not null)
);
create index deal_change_request_investment_idx on mon.deal_change_request (investment_id, state);
create index deal_change_request_state_idx on mon.deal_change_request (state, effective_date);
call pb.add_standard_columns_trigger('mon.deal_change_request');

----------------------------------------------------------------------------------------------
-- deal.opportunity: the pipeline record (docs/04 M5 skeleton, docs/18 section 4). The company is a
-- name until it is known as a portfolio company; the investment is set on close and is unique, so
-- one opportunity becomes at most one position. A Passed deal carries its reason code; a Closed one
-- its investment. The wall is on the opportunity itself (core.walled_record entity 'opportunity').
----------------------------------------------------------------------------------------------
create table deal.opportunity (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company_name text not null,
  portfolio_company_id uuid references core.portfolio_company (id),
  sponsor_id uuid not null references core.sponsor (id),
  sponsor_fund_id uuid references core.sponsor_fund (id),
  deal_type text not null references core.taxonomy_term (code) check (deal_type like 'deal_type.%'),
  sector text references core.taxonomy_term (code) check (sector like 'sector.%'),
  geography text references core.taxonomy_term (code) check (geography like 'geography.%'),
  stage deal.stage not null default 'Sourced',
  owner_id uuid references core.app_user (id),
  received_date date not null,
  target_commitment numeric(20,2),
  currency char(3) not null default 'USD',
  source text,
  pass_reason_code text references core.taxonomy_term (code) check (pass_reason_code like 'pass_reason.%'),
  pass_note text,
  investment_id uuid unique references core.investment (id),
  scenario_tag text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check (stage <> 'Passed' or pass_reason_code is not null),
  check (stage <> 'Closed' or investment_id is not null)
);
create index opportunity_stage_idx on deal.opportunity (stage, received_date);
create index opportunity_sponsor_idx on deal.opportunity (sponsor_id);
create index opportunity_owner_idx on deal.opportunity (owner_id);
call pb.add_standard_columns_trigger('deal.opportunity');

-- Visibility of an opportunity for the current user, reused by its child tables the way
-- pb.investment_visible is: the subquery runs under deal.opportunity's own policy, so the wall and
-- the role rules apply exactly once, in one place.
create or replace function pb.opportunity_visible(opp uuid) returns boolean
language sql stable as $$
  select exists (select 1 from deal.opportunity o where o.id = opp)
$$;

----------------------------------------------------------------------------------------------
-- deal.opportunity_stage_history: one row per stage command (advance, pass, reopen), append-only:
-- no update or delete is granted. Not a *_history image table: it is the pipeline's own record of
-- who moved a deal, when and why.
----------------------------------------------------------------------------------------------
create table deal.opportunity_stage_history (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references deal.opportunity (id),
  from_stage deal.stage,
  to_stage deal.stage not null,
  command text not null,
  reason text,
  changed_by uuid not null references core.app_user (id),
  changed_at timestamptz not null default now()
);
create index opportunity_stage_history_opportunity_idx on deal.opportunity_stage_history (opportunity_id, changed_at);

----------------------------------------------------------------------------------------------
-- deal.diligence_task: the diligence gate (docs/18 section 4). Tasks come from the template per deal
-- type in config/diligence_templates.json; those required for IC must be done or waived with a
-- reason before Diligence advances to IC. Evidence is a document in the hub.
----------------------------------------------------------------------------------------------
create table deal.diligence_task (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references deal.opportunity (id),
  workstream text not null references core.taxonomy_term (code) check (workstream like 'diligence_workstream.%'),
  title text not null,
  owner_id uuid references core.app_user (id),
  due_date date,
  status text not null default 'open' check (status in ('open', 'done', 'waived')),
  required_for_ic boolean not null default false,
  evidence_document_id uuid references doc.document (id),
  waived_reason text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check (status <> 'waived' or waived_reason is not null)
);
create index diligence_task_opportunity_idx on deal.diligence_task (opportunity_id, status);
call pb.add_standard_columns_trigger('deal.diligence_task');

----------------------------------------------------------------------------------------------
-- deal.ic_decision: the committee's decision, recorded by an approver and never edited: a later
-- decision on another date supersedes it. Amount and conditions are in the opportunity's currency.
----------------------------------------------------------------------------------------------
create table deal.ic_decision (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references deal.opportunity (id),
  decision_date date not null,
  decision text not null check (decision in ('approved', 'declined', 'deferred')),
  amount numeric(20,2),
  currency char(3) not null default 'USD',
  conditions jsonb not null default '[]'::jsonb,
  memo_document_id uuid references doc.document (id),
  recorded_by uuid not null references core.app_user (id),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (opportunity_id, decision_date)
);
call pb.add_standard_columns_trigger('deal.ic_decision');

----------------------------------------------------------------------------------------------
-- deal.allocation: how a deal is allocated across the firm's vehicles and, inside a vehicle, its
-- clients (docs/04 M22). Anchored on the opportunity before close and on the investment after (both
-- while converting). One line per anchor, vehicle and client (two partial unique indexes, one per
-- anchor, with nulls not distinct so the vehicle-level line, client null, is unique too). The
-- tie-out compares the lines with the closing commitment.
----------------------------------------------------------------------------------------------
create table deal.allocation (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references deal.opportunity (id),
  investment_id uuid references core.investment (id),
  vehicle_id uuid not null references core.vehicle (id),
  client_id uuid references core.client (id),
  requested numeric(20,2) not null check (requested >= 0),
  received numeric(20,2) check (received >= 0),
  currency char(3) not null default 'USD',
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check (opportunity_id is not null or investment_id is not null)
);
create unique index allocation_opportunity_key on deal.allocation (opportunity_id, vehicle_id, client_id) nulls not distinct where opportunity_id is not null;
create unique index allocation_investment_key on deal.allocation (investment_id, vehicle_id, client_id) nulls not distinct where investment_id is not null;
call pb.add_standard_columns_trigger('deal.allocation');

----------------------------------------------------------------------------------------------
-- deal.closing: the closing record (docs/04 M8). close_date is the single source of every close
-- date in Portfolio Beach: no other table carries one. The opportunity is null only for a position
-- that predates the pipeline (seeded from the investment); the investment is set when the deal
-- converts. Operations confirms once the checklist is complete and the allocations tie out; a close
-- date change afterwards returns the record to Open with a reason and needs a new confirmation.
----------------------------------------------------------------------------------------------
create table deal.closing (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid unique references deal.opportunity (id),
  investment_id uuid unique references core.investment (id),
  close_date date not null,
  commitment_amount numeric(20,2) not null check (commitment_amount > 0),
  currency char(3) not null default 'USD',
  state deal.closing_state not null default 'Open',
  ops_confirmed_by uuid references core.app_user (id),
  ops_confirmed_at timestamptz,
  reopen_reason text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check (opportunity_id is not null or investment_id is not null),
  check (state <> 'OpsConfirmed' or (ops_confirmed_by is not null and ops_confirmed_at is not null))
);
create index closing_close_date_idx on deal.closing (close_date);
call pb.add_standard_columns_trigger('deal.closing');

-- Visibility of a closing: its opportunity's when it has one, otherwise its investment's.
create or replace function pb.closing_visible(closing_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from deal.closing c where c.id = closing_id)
$$;

----------------------------------------------------------------------------------------------
-- deal.closing_item: the required-document checklist from config/closing_checklist.json, one row per
-- item and closing. A received item names its document; a waived one its reason.
----------------------------------------------------------------------------------------------
create table deal.closing_item (
  id uuid primary key default gen_random_uuid(),
  closing_id uuid not null references deal.closing (id),
  item_code text not null,
  label text not null,
  required boolean not null,
  document_id uuid references doc.document (id),
  status text not null default 'open' check (status in ('open', 'received', 'waived')),
  waived_reason text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (closing_id, item_code),
  check (status <> 'waived' or waived_reason is not null),
  check (status <> 'received' or document_id is not null)
);
call pb.add_standard_columns_trigger('deal.closing_item');

----------------------------------------------------------------------------------------------
-- deal.legal_term: a term captured at close (docs/04 M22), typed by the legal_term_type taxonomy
-- with its value as a small JSON document and the document it was read from. The investment is
-- copied at close so the terms follow the position after the closing is done. Who confirmed a term
-- and when is set by the confirm command (the API, wave 2), not enforced here.
----------------------------------------------------------------------------------------------
create table deal.legal_term (
  id uuid primary key default gen_random_uuid(),
  closing_id uuid not null references deal.closing (id),
  investment_id uuid references core.investment (id),
  term_type text not null references core.taxonomy_term (code) check (term_type like 'legal_term_type.%'),
  value jsonb not null,
  source_document_id uuid references doc.document (id),
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  confirmed_by uuid references core.app_user (id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);
create index legal_term_closing_idx on deal.legal_term (closing_id);
create index legal_term_investment_idx on deal.legal_term (investment_id);
call pb.add_standard_columns_trigger('deal.legal_term');

----------------------------------------------------------------------------------------------
-- History (SEC-9.2): a full row image per change on the tables whose numbers a client could see or
-- that release money. The register's image carries the ciphertext only.
----------------------------------------------------------------------------------------------
call audit.add_history('mon.wire_instruction');
call audit.add_history('mon.trade_ticket');
call audit.add_history('deal.closing');
call audit.add_history('deal.allocation');
call audit.add_history('deal.legal_term');

----------------------------------------------------------------------------------------------
-- Grants: exactly what the policies allow. The stage history and IC decisions are append-only;
-- allocations may be replaced as a set (delete); nothing else is ever deleted.
----------------------------------------------------------------------------------------------
grant select, insert, update on
  mon.wire_instruction, mon.trade_ticket, mon.deal_change_request,
  deal.opportunity, deal.diligence_task, deal.allocation, deal.closing, deal.closing_item, deal.legal_term
to pb_app;
grant select, insert on deal.opportunity_stage_history, deal.ic_decision to pb_app;
grant delete on deal.allocation to pb_app;

do $$
declare t text;
begin
  foreach t in array array[
    'mon.wire_instruction', 'mon.trade_ticket', 'mon.deal_change_request',
    'deal.opportunity', 'deal.opportunity_stage_history', 'deal.diligence_task', 'deal.ic_decision',
    'deal.allocation', 'deal.closing', 'deal.closing_item', 'deal.legal_term']
  loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
end $$;

----------------------------------------------------------------------------------------------
-- Row-level security.
----------------------------------------------------------------------------------------------

-- mon.wire_instruction: an operations control, not a deal record. The register is read by
-- operations, approvers, auditors, platform admins and the system actor only, and it is not under
-- the investment wall: an instruction for a walled position is still visible to operations, because
-- the people who pay must see every verified instruction and every change to one (SEC-12.2). The
-- bank details are still only ciphertext here; the API decrypts for operations and approvers alone.
create policy read_register on mon.wire_instruction for select to pb_app
  using (pb.has_any_role(array['operations', 'approver', 'auditor', 'platform_admin', 'service']));
create policy propose on mon.wire_instruction for insert to pb_app
  with check (pb.has_any_role(array['operations', 'service']));
create policy verify on mon.wire_instruction for update to pb_app
  using (pb.has_any_role(array['operations', 'approver', 'service']))
  with check (pb.has_any_role(array['operations', 'approver', 'service']));

-- mon.trade_ticket follows its notice (the notice carries the investment's or the commitment's
-- visibility); operations and the service draft, approvers join them to approve.
create policy read_visible on mon.trade_ticket for select to pb_app
  using (exists (select 1 from mon.capital_notice n where n.id = capital_notice_id));
create policy draft on mon.trade_ticket for insert to pb_app
  with check (pb.has_any_role(array['operations', 'service'])
    and exists (select 1 from mon.capital_notice n where n.id = capital_notice_id));
create policy approve on mon.trade_ticket for update to pb_app
  using (pb.has_any_role(array['operations', 'approver', 'service'])
    and exists (select 1 from mon.capital_notice n where n.id = capital_notice_id))
  with check (pb.has_any_role(array['operations', 'approver', 'service'])
    and exists (select 1 from mon.capital_notice n where n.id = capital_notice_id));

-- mon.deal_change_request carries the investment wall; the deal team and operations submit,
-- operations works the request.
create policy read_visible on mon.deal_change_request for select to pb_app
  using (pb.is_authenticated() and pb.investment_visible(investment_id));
create policy submit on mon.deal_change_request for insert to pb_app
  with check (pb.has_any_role(array['deal_team', 'operations', 'service']) and pb.investment_visible(investment_id));
create policy work on mon.deal_change_request for update to pb_app
  using (pb.has_any_role(array['operations', 'service']) and pb.investment_visible(investment_id))
  with check (pb.has_any_role(array['operations', 'service']) and pb.investment_visible(investment_id));

-- deal.opportunity: the wall is on the opportunity (SEC-5.3); the deal team creates, and the deal
-- team, operations and approvers move it.
create policy read_visible on deal.opportunity for select to pb_app
  using (pb.is_authenticated() and pb.can_see_walled('opportunity', id));
create policy create_deal on deal.opportunity for insert to pb_app
  with check (pb.has_any_role(array['deal_team', 'service']) and pb.can_see_walled('opportunity', id));
create policy move_deal on deal.opportunity for update to pb_app
  using (pb.has_any_role(array['deal_team', 'operations', 'approver', 'service']) and pb.can_see_walled('opportunity', id))
  with check (pb.has_any_role(array['deal_team', 'operations', 'approver', 'service']) and pb.can_see_walled('opportunity', id));

-- Children of the opportunity follow it through pb.opportunity_visible.
create policy read_visible on deal.opportunity_stage_history for select to pb_app
  using (pb.opportunity_visible(opportunity_id));
create policy record_stage on deal.opportunity_stage_history for insert to pb_app
  with check (pb.has_any_role(array['deal_team', 'operations', 'approver', 'service']) and pb.opportunity_visible(opportunity_id));

create policy read_visible on deal.diligence_task for select to pb_app
  using (pb.opportunity_visible(opportunity_id));
call pb.add_write_policies('deal.diligence_task', array['deal_team', 'approver', 'service'], 'pb.opportunity_visible(opportunity_id)');

create policy read_visible on deal.ic_decision for select to pb_app
  using (pb.opportunity_visible(opportunity_id));
create policy record_decision on deal.ic_decision for insert to pb_app
  with check (pb.has_any_role(array['approver', 'service']) and pb.opportunity_visible(opportunity_id));

-- deal.allocation follows the opportunity when it has one, otherwise the investment.
create policy read_visible on deal.allocation for select to pb_app
  using ((opportunity_id is not null and pb.opportunity_visible(opportunity_id))
    or (opportunity_id is null and pb.investment_visible(investment_id)));
call pb.add_write_policies('deal.allocation', array['deal_team', 'operations', 'service'],
  '(opportunity_id is not null and pb.opportunity_visible(opportunity_id)) or (opportunity_id is null and pb.investment_visible(investment_id))');

-- deal.closing follows the opportunity when it has one, otherwise the investment; the deal team
-- and operations open it, operations confirms it.
create policy read_visible on deal.closing for select to pb_app
  using ((opportunity_id is not null and pb.opportunity_visible(opportunity_id))
    or (opportunity_id is null and pb.investment_visible(investment_id)));
create policy open_closing on deal.closing for insert to pb_app
  with check (pb.has_any_role(array['deal_team', 'operations', 'service'])
    and ((opportunity_id is not null and pb.opportunity_visible(opportunity_id))
      or (opportunity_id is null and pb.investment_visible(investment_id))));
create policy confirm_closing on deal.closing for update to pb_app
  using (pb.has_any_role(array['operations', 'service'])
    and ((opportunity_id is not null and pb.opportunity_visible(opportunity_id))
      or (opportunity_id is null and pb.investment_visible(investment_id))))
  with check (pb.has_any_role(array['operations', 'service'])
    and ((opportunity_id is not null and pb.opportunity_visible(opportunity_id))
      or (opportunity_id is null and pb.investment_visible(investment_id))));

-- Children of the closing follow it through pb.closing_visible.
create policy read_visible on deal.closing_item for select to pb_app
  using (pb.closing_visible(closing_id));
call pb.add_write_policies('deal.closing_item', array['operations', 'deal_team', 'service'], 'pb.closing_visible(closing_id)');

create policy read_visible on deal.legal_term for select to pb_app
  using (pb.closing_visible(closing_id));
call pb.add_write_policies('deal.legal_term', array['deal_team', 'operations', 'service'], 'pb.closing_visible(closing_id)');
