-- 0008 The system actor sees walled records (docs/05 SEC-5.3, decision 0009).
-- Rollback note: recreate pb.can_see_walled as migration 0002 defines it (the same body without the
-- pb.has_role('service') clause).

-- Walls restrict people: only named members may see a walled record, and nothing a person is shown
-- reveals that it exists. The system actor (core.app_user 00000000-0000-0000-0000-000000000001,
-- app.roles = 'service') is not a person: it links an accounting export to every position on record,
-- promotes approved staging rows and runs the workers, and what it produces is filtered again per
-- reader by the policies on the tables it writes. Without this clause an import by an operations
-- user outside a wall would report the walled position as "no match", flag the row and open a false
-- data exception. The service role is never a sign-in role: the API refuses a credential that
-- carries it (apps/api/src/auth/identity.middleware.ts), so only server code runs as this actor.
create or replace function pb.can_see_walled(entity_name text, record_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select pb.has_role('service')
      or not exists (select 1 from core.walled_record w where w.entity = entity_name and w.entity_id = record_id)
      or exists (
        select 1 from core.walled_record w
        join core.wall_member m on m.wall_id = w.wall_id
        where w.entity = entity_name and w.entity_id = record_id and m.user_id = pb.current_user_id())
$$;
