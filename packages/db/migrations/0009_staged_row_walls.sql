-- 0009 Walls on staged rows, and the wall tables the definer reads (docs/05 SEC-5.1, SEC-5.3, decision 0009).
-- Rollback note: drop function pb.intake_row_visible(jsonb) after recreating read_review, review_update and
-- write_update on stg.intake_row as migrations 0006 and 0007 define them (role checks only); alter table
-- core.walled_record force row level security; alter table core.wall_member force row level security.

-- A staged row linked to a walled investment is itself a walled record: its figures, its diff and its
-- findings carry the same wall as the investment, in the policy and not only in the API's filter
-- (SEC-5.1: a bug in one layer must not expose data). A row with no link is every reviewer's to see.
-- The clause runs under the caller's own row-level security on core.investment (pb.investment_visible),
-- so walls and roles apply exactly once, in one place.
create or replace function pb.intake_row_visible(payload jsonb) returns boolean
language sql stable as $$
  select (payload->'link'->>'investmentId') is null
      or pb.investment_visible((payload->'link'->>'investmentId')::uuid)
$$;

-- The roles stay as 0006 and 0007 set them: reviewers read, operations and the service write, the deal
-- team updates. Import (insert) keeps no wall clause: an export covers the whole book and the importer's
-- own transaction writes every row (decision 0009); the file's counts come from the system actor.
drop policy read_review on stg.intake_row;
create policy read_review on stg.intake_row for select to pb_app
  using (pb.has_any_role(array['operations', 'deal_team', 'approver', 'auditor', 'service']) and pb.intake_row_visible(payload));
drop policy review_update on stg.intake_row;
create policy review_update on stg.intake_row for update to pb_app
  using (pb.has_role('deal_team') and pb.intake_row_visible(payload))
  with check (pb.has_role('deal_team') and pb.intake_row_visible(payload));
drop policy write_update on stg.intake_row;
create policy write_update on stg.intake_row for update to pb_app
  using (pb.has_any_role(array['operations', 'service']) and pb.intake_row_visible(payload))
  with check (pb.has_any_role(array['operations', 'service']) and pb.intake_row_visible(payload));

-- pb.can_see_walled is security definer: it reads core.walled_record and core.wall_member as the role
-- that owns it, the migration role, which outside the test harness is neither a superuser nor bypassrls.
-- With row-level security forced on those two tables that owner is bound by policies written for pb_app
-- only, sees no wall row, and every wall switches off for everyone. Enabled, not forced: pb_app stays
-- bound by the member policies, the owner reads the wall tables. The function keeps its body and its
-- search_path = pg_catalog, public from migration 0008.
alter table core.walled_record no force row level security;
alter table core.wall_member no force row level security;
