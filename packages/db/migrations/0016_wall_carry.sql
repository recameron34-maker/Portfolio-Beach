-- 0016 Phase 3 review fixes, the walls: a member reads the wall rows of their own walls only, and
-- the system step of a closing may carry the walls of a deal to the position it becomes (D1-04)
-- (docs/03 section 1, docs/05 SEC-5.3, docs/18 section 4, decision 0013).
-- Rollback note: recreate read_member on core.walled_record as migration 0006 defines it; drop
-- policy carry_read on core.walled_record; drop policy carry_write on core.walled_record.

----------------------------------------------------------------------------------------------
-- core.walled_record, read_member: migration 0006 compared m.wall_id with an unqualified wall_id
-- inside "from core.wall_member m", so the name bound to m's own column and the clause was true for
-- a member of any wall: such a person read the wall rows (wall, entity, record id) of every wall.
-- The walled records themselves stayed hidden (pb.can_see_walled reads as the owner and is not
-- affected), but which records a wall covers is itself restricted (SEC-5.3). The column is now
-- qualified, so a member reads the rows of the walls they belong to and no other.
----------------------------------------------------------------------------------------------
drop policy read_member on core.walled_record;
create policy read_member on core.walled_record for select to pb_app
  using (pb.has_any_role(array['approver', 'platform_admin'])
    or exists (
      select 1 from core.wall_member m
      where m.wall_id = core.walled_record.wall_id and m.user_id = pb.current_user_id()));

----------------------------------------------------------------------------------------------
-- core.walled_record, the carry: when a walled deal closes, the conversion writes the position
-- and must put it behind every wall of the deal in the same transaction, or a restricted deal
-- becomes a position everyone can read (D1-04). The person closing the deal is a member of one of
-- those walls at least, not necessarily of all, and members do not manage walls, so the copy is a
-- system step (the service role; the actor stays the person). The service role may read the wall
-- rows and may insert one for an investment only: it creates no wall, adds no member, walls no
-- other kind of record and removes nothing. Managing walls stays with approvers and platform
-- admins (migration 0006).
----------------------------------------------------------------------------------------------
create policy carry_read on core.walled_record for select to pb_app
  using (pb.has_role('service'));
create policy carry_write on core.walled_record for insert to pb_app
  with check (pb.has_role('service') and entity = 'investment');
