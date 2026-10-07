-- 0006 History tables, row-level security and grants (docs/03 section 1, docs/05 SEC-5, SEC-9.2, SEC-11.1).
-- Rollback note: drop policies, revoke grants, drop *_history tables. Never run in production without the
-- RLS matrix tests (packages/db/src/rls) passing first.

-- System actor used by workers and promotion jobs (app.roles = 'service').
insert into core.app_user (id, external_id, display_name, email)
values ('00000000-0000-0000-0000-000000000001', 'system', 'Portfolio Beach system', 'system@portfolio-beach.example');

create or replace function pb.is_authenticated() returns boolean
language sql stable as $$
  select pb.current_user_id() is not null and cardinality(pb.current_roles()) > 0
$$;

-- Visibility of an investment for the current user, reused by every child table. SECURITY DEFINER
-- is not used here on purpose: the subquery runs under core.investment's own policy, so walls and
-- role rules apply exactly once, in one place.
create or replace function pb.investment_visible(inv uuid) returns boolean
language sql stable as $$
  select exists (select 1 from core.investment i where i.id = inv)
$$;

create or replace function pb.commitment_visible(cmt uuid) returns boolean
language sql stable as $$
  select exists (select 1 from core.commitment c where c.id = cmt)
$$;

----------------------------------------------------------------------------------------------
-- History on every financial and approval table (full row image per change).
----------------------------------------------------------------------------------------------
call audit.add_history('core.investment');
call audit.add_history('core.commitment');
call audit.add_history('core.lp_commitment');
call audit.add_history('core.client');
call audit.add_history('mon.quarterly_performance');
call audit.add_history('mon.credit_terms');
call audit.add_history('mon.credit_performance');
call audit.add_history('mon.valuation');
call audit.add_history('mon.cash_flow');
call audit.add_history('mon.capital_notice');
call audit.add_history('mon.realization_outlook');
call audit.add_history('core.walled_record');
call audit.add_history('core.wall_member');
call audit.add_history('ops.feature_flag');

----------------------------------------------------------------------------------------------
-- Grants: pb_app gets exactly what the policies below allow, never DELETE on financial tables.
----------------------------------------------------------------------------------------------
grant select, insert, update on
  core.app_user, core.taxonomy_term, core.sponsor, core.sponsor_fund, core.fund_alias, core.portfolio_company,
  core.fund_holding, core.vehicle, core.investment, core.client, core.commitment, core.lp_commitment,
  core.match_guard, core.wall, core.wall_member, core.walled_record,
  mon.quarterly_performance, mon.credit_terms, mon.credit_performance, mon.valuation, mon.valuation_approval,
  mon.capital_notice, mon.cash_flow, mon.realization_outlook,
  ops.feature_flag, ops.task, ops.data_exception, ops.job, ops.systems_issue, ops.outbox,
  stg.intake_file, stg.intake_row, stg.valuation
to pb_app;
grant delete on core.wall_member, core.walled_record, ops.task to pb_app;
grant select, insert on audit.event to pb_app;
grant usage, select on all sequences in schema audit to pb_app;
grant usage, select on all sequences in schema ops to pb_app;

----------------------------------------------------------------------------------------------
-- Row-level security. Every business table: enabled and forced, so even the owner is bound.
----------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'core.app_user', 'core.taxonomy_term', 'core.sponsor', 'core.sponsor_fund', 'core.fund_alias', 'core.portfolio_company',
    'core.fund_holding', 'core.vehicle', 'core.investment', 'core.client', 'core.commitment', 'core.lp_commitment',
    'core.match_guard', 'core.wall', 'core.wall_member', 'core.walled_record',
    'mon.quarterly_performance', 'mon.credit_terms', 'mon.credit_performance', 'mon.valuation', 'mon.valuation_approval',
    'mon.capital_notice', 'mon.cash_flow', 'mon.realization_outlook',
    'ops.feature_flag', 'ops.task', 'ops.data_exception', 'ops.job', 'ops.systems_issue', 'ops.outbox',
    'stg.intake_file', 'stg.intake_row', 'stg.valuation', 'audit.event']
  loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
end $$;

-- Write policies are always split by command. A FOR ALL policy's USING clause would also widen
-- SELECT, so a role allowed to write could see rows the read policy hides (for example walled
-- investments). This procedure creates insert, update and delete policies with the same condition.
create or replace procedure pb.add_write_policies(target regclass, roles text[], extra text default 'true')
language plpgsql as $$
declare
  cond text := format('(pb.has_any_role(%L::text[]) and (%s))', roles, extra);
begin
  execute format('create policy write_insert on %s for insert to pb_app with check %s', target, cond);
  execute format('create policy write_update on %s for update to pb_app using %s with check %s', target, cond, cond);
  execute format('create policy write_delete on %s for delete to pb_app using %s', target, cond);
end $$;

-- Reference data: readable by every authenticated role; maintained by deal team, operations and admins.
create policy read_all on core.app_user for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('core.app_user', array['platform_admin', 'service']);

create policy read_all on core.taxonomy_term for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('core.taxonomy_term', array['platform_admin', 'operations']);

create policy read_all on core.match_guard for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('core.match_guard', array['platform_admin', 'operations']);

create policy read_all on core.sponsor for select to pb_app using (pb.is_authenticated() and pb.can_see_walled('sponsor', id));
call pb.add_write_policies('core.sponsor', array['deal_team', 'operations', 'service'], 'pb.can_see_walled(''sponsor'', id)');

create policy read_all on core.sponsor_fund for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('core.sponsor_fund', array['deal_team', 'operations', 'service']);

create policy read_all on core.fund_alias for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('core.fund_alias', array['deal_team', 'operations', 'service']);

create policy read_all on core.portfolio_company for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('core.portfolio_company', array['deal_team', 'operations', 'service']);

create policy read_all on core.fund_holding for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('core.fund_holding', array['deal_team', 'operations', 'service']);

create policy read_all on core.vehicle for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('core.vehicle', array['operations', 'service']);

-- Investments: walls apply (SEC-5.3). Child tables inherit this through pb.investment_visible().
create policy read_visible on core.investment for select to pb_app using (pb.is_authenticated() and pb.can_see_walled('investment', id));
call pb.add_write_policies('core.investment', array['deal_team', 'operations', 'service'], 'pb.can_see_walled(''investment'', id)');

-- Restricted client data (SEC-5.2, SEC-5.4): entitlement or an all-clients role. Platform admins have neither.
create policy read_entitled on core.client for select to pb_app using (pb.sees_all_clients() or pb.entitled_client(id));
call pb.add_write_policies('core.client', array['operations', 'service']);

create policy read_entitled on core.lp_commitment for select to pb_app using (pb.sees_all_clients() or pb.entitled_client(client_id));
call pb.add_write_policies('core.lp_commitment', array['operations', 'service']);

create policy read_visible on core.commitment for select to pb_app
  using (pb.is_authenticated() and (client_id is null or pb.sees_all_clients() or pb.entitled_client(client_id)));
call pb.add_write_policies('core.commitment', array['operations', 'service']);

-- Walls themselves: members see their walls; approvers and admins manage them.
create policy read_member on core.wall for select to pb_app
  using (pb.has_any_role(array['approver', 'platform_admin']) or exists (select 1 from core.wall_member m where m.wall_id = id and m.user_id = pb.current_user_id()));
call pb.add_write_policies('core.wall', array['approver', 'platform_admin']);
create policy read_member on core.wall_member for select to pb_app
  using (user_id = pb.current_user_id() or pb.has_any_role(array['approver', 'platform_admin']));
call pb.add_write_policies('core.wall_member', array['approver', 'platform_admin']);
create policy read_member on core.walled_record for select to pb_app
  using (pb.has_any_role(array['approver', 'platform_admin']) or exists (select 1 from core.wall_member m where m.wall_id = wall_id and m.user_id = pb.current_user_id()));
call pb.add_write_policies('core.walled_record', array['approver', 'platform_admin']);

-- Monitoring and valuation: visible when the investment is; written by operations and the service actor.
create policy read_visible on mon.quarterly_performance for select to pb_app using (pb.investment_visible(investment_id));
call pb.add_write_policies('mon.quarterly_performance', array['operations', 'deal_team', 'service'], 'pb.investment_visible(investment_id)');

create policy read_visible on mon.credit_terms for select to pb_app using (pb.investment_visible(investment_id));
call pb.add_write_policies('mon.credit_terms', array['operations', 'service'], 'pb.investment_visible(investment_id)');

create policy read_visible on mon.credit_performance for select to pb_app using (pb.investment_visible(investment_id));
call pb.add_write_policies('mon.credit_performance', array['operations', 'deal_team', 'service'], 'pb.investment_visible(investment_id)');

create policy read_visible on mon.valuation for select to pb_app using (pb.investment_visible(investment_id));
create policy insert_ops on mon.valuation for insert to pb_app
  with check (pb.has_any_role(array['operations', 'service']) and pb.investment_visible(investment_id));
create policy update_workflow on mon.valuation for update to pb_app
  using (pb.has_any_role(array['operations', 'deal_team', 'approver']) and pb.investment_visible(investment_id))
  with check (pb.has_any_role(array['operations', 'deal_team', 'approver']) and pb.investment_visible(investment_id));

create policy read_visible on mon.valuation_approval for select to pb_app
  using (exists (select 1 from mon.valuation v where v.id = valuation_id));
create policy insert_workflow on mon.valuation_approval for insert to pb_app
  with check (pb.has_any_role(array['operations', 'deal_team', 'approver']) and approver_id = pb.current_user_id());

create policy read_visible on mon.capital_notice for select to pb_app
  using ((investment_id is not null and pb.investment_visible(investment_id)) or (investment_id is null and pb.commitment_visible(commitment_id)));
call pb.add_write_policies('mon.capital_notice', array['operations', 'service'],
  '(investment_id is not null and pb.investment_visible(investment_id)) or (investment_id is null and pb.commitment_visible(commitment_id))');

create policy read_visible on mon.cash_flow for select to pb_app
  using ((investment_id is not null and pb.investment_visible(investment_id)) or (investment_id is null and pb.commitment_visible(commitment_id)));
call pb.add_write_policies('mon.cash_flow', array['operations', 'service'],
  '(investment_id is not null and pb.investment_visible(investment_id)) or (investment_id is null and pb.commitment_visible(commitment_id))');

create policy read_visible on mon.realization_outlook for select to pb_app using (pb.investment_visible(investment_id));
call pb.add_write_policies('mon.realization_outlook', array['deal_team', 'operations'], 'pb.investment_visible(investment_id)');

-- Operations tables.
create policy read_all on ops.feature_flag for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('ops.feature_flag', array['platform_admin', 'service']);

create policy read_all on ops.task for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('ops.task', array['deal_team', 'operations', 'approver', 'investor_relations', 'service']);

create policy read_all on ops.data_exception for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('ops.data_exception', array['deal_team', 'operations', 'service']);

create policy read_all on ops.job for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('ops.job', array['operations', 'service']);

create policy read_all on ops.systems_issue for select to pb_app using (pb.is_authenticated());
call pb.add_write_policies('ops.systems_issue', array['operations', 'platform_admin']);

create policy insert_any on ops.outbox for insert to pb_app with check (pb.is_authenticated());
create policy relay on ops.outbox for select to pb_app using (pb.has_role('service'));
create policy relay_update on ops.outbox for update to pb_app using (pb.has_role('service')) with check (pb.has_role('service'));

-- Staging: operations and the service actor write; reviewers read.
create policy read_review on stg.intake_file for select to pb_app using (pb.has_any_role(array['operations', 'deal_team', 'approver', 'auditor', 'service']));
call pb.add_write_policies('stg.intake_file', array['operations', 'service']);
create policy read_review on stg.intake_row for select to pb_app using (pb.has_any_role(array['operations', 'deal_team', 'approver', 'auditor', 'service']));
call pb.add_write_policies('stg.intake_row', array['operations', 'service']);
create policy read_review on stg.valuation for select to pb_app using (pb.has_any_role(array['operations', 'deal_team', 'approver', 'auditor', 'service']));
call pb.add_write_policies('stg.valuation', array['operations', 'service']);

-- Audit: anyone authenticated appends; auditors, approvers, operations and admins read.
create policy append_any on audit.event for insert to pb_app with check (pb.is_authenticated());
create policy read_audit on audit.event for select to pb_app using (pb.has_any_role(array['auditor', 'approver', 'operations', 'platform_admin']));
