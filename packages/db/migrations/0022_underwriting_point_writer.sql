-- 0022 The two-person rule of a base case covers its plan points (docs/18 section 13, docs/03,
-- SEC-5.6, decision 0022).
-- Migration 0021 holds the rule on the case row: inside a user transaction every edit of a Draft
-- names the person acting as entered_by, and that person never confirms. The plan points were
-- written under the case's visibility alone, so a second deal team member could rewrite the points
-- of a Draft somebody else had entered and then confirm it: the record named two people for
-- figures one of them had both changed and confirmed. No route of the API did so (an edit writes
-- the case row first, naming its editor, and only then replaces the points), but the database is
-- a line of its own.
--
-- Now a plan point is written only by the person its case names as entered_by. Whoever wants to
-- change a point first claims the Draft, as the API does, and so cannot confirm it; the person
-- named before them can. The read policy is unchanged: a point is read by whoever reads its case.
-- The owner connection (migrations and the local seed) is outside row-level security, as before.
--
-- Rollback note: drop the three write policies on mon.underwriting_case_point, recreate them with
-- pb.underwriting_case_visible(case_id) as migration 0021 does, and drop the function
-- pb.underwriting_case_entered_by_me.

-- True when the caller is the person who last changed the figures of the case. Asked as the
-- caller (no definer), so a case the caller cannot see is not theirs either: the wall and the
-- role rules of the position still apply.
create or replace function pb.underwriting_case_entered_by_me(case_id uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from mon.underwriting_case c
    where c.id = case_id and c.entered_by = pb.current_user_id()
  )
$$;

drop policy write_insert on mon.underwriting_case_point;
drop policy write_update on mon.underwriting_case_point;
drop policy write_delete on mon.underwriting_case_point;
call pb.add_write_policies('mon.underwriting_case_point', array['deal_team'], 'pb.underwriting_case_entered_by_me(case_id)');
