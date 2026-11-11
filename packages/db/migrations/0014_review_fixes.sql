-- 0014 Phase 3 review fixes: data exceptions about change requests read under the request's own
-- policy (CR-1, D1-02), and the wall question asked about a named person, for the owner a change
-- request is routed to (CR-3) (docs/03 sections 1 and 3, docs/05 SEC-5.3, docs/18 section 8,
-- decision 0013).
-- Rollback note: recreate read_all on ops.data_exception as migration 0012 defines it (the four
-- clauses without mon.deal_change_request); drop function pb.user_inside_wall(text, uuid, uuid).

----------------------------------------------------------------------------------------------
-- ops.data_exception: migrations 0010 and 0012 wall an exception about a staged row, a document or an
-- extraction run by that record's own policy. Migration 0013 added one more entity, the quarter-end
-- exception about a change request not applied (mon.deal_change_request, rule CR-QE-01), without
-- extending the clause, so an exception about a walled position's request was listed to every queue
-- reader. The same rule now covers it: visible only to someone the request's own policy admits (the
-- investment wall), so a walled position's exceptions stay inside the wall (SEC-5.3). The update
-- policy and the column grant are unchanged: an exception the reader cannot see cannot be worked.
----------------------------------------------------------------------------------------------
drop policy read_all on ops.data_exception;
create policy read_all on ops.data_exception for select to pb_app
  using (pb.is_authenticated()
    and (entity <> 'stg.intake_row' or exists (select 1 from stg.intake_row r where r.id = entity_id))
    and (entity <> 'stg.valuation' or exists (select 1 from stg.valuation v where v.id = entity_id))
    and (entity <> 'doc.extraction_run' or exists (select 1 from doc.extraction_run x where x.id = entity_id))
    and (entity <> 'doc.document' or exists (select 1 from doc.document d where d.id = entity_id))
    and (entity <> 'mon.deal_change_request' or exists (select 1 from mon.deal_change_request c where c.id = entity_id)));

----------------------------------------------------------------------------------------------
-- pb.user_inside_wall: the wall question about a named person instead of the caller: true when no
-- wall covers the record, or the person is a member of one that does. The API asks it before a change
-- request on a walled position is routed, so the owner named is someone who can open the request
-- (docs/18 section 8). It answers only for a record the caller can see (pb.can_see_walled first), so
-- it tells nobody outside a wall anything the wall hides. Security definer with the pinned search
-- path, for the reason pb.can_see_walled is: core.walled_record and core.wall_member are read as the
-- owner (migration 0009), and a member reads only their own membership row.
----------------------------------------------------------------------------------------------
create or replace function pb.user_inside_wall(entity_name text, record_id uuid, person_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select pb.can_see_walled(entity_name, record_id)
     and (not exists (select 1 from core.walled_record w where w.entity = entity_name and w.entity_id = record_id)
       or exists (
         select 1 from core.walled_record w
         join core.wall_member m on m.wall_id = w.wall_id
         where w.entity = entity_name and w.entity_id = record_id and m.user_id = person_id))
$$;
