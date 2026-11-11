-- 0015 The API's Idempotency-Key store (docs/17 section 3, docs/05 SEC-2.1, SEC-5.1, SEC-6.3 and
-- SEC-6.4, decision 0013: the Phase 3 review findings D7-1, VAL-4 and CR-4).
-- Rollback note: drop table ops.idempotency_key (its policies and grants go with it).

----------------------------------------------------------------------------------------------
-- ops.idempotency_key: one row per Idempotency-Key a person sent on a route the contract marks
-- idempotent (packages/contracts routes-controls.ts), so a repeat of the request answers what the
-- first one answered and runs nothing. This is not ops.job.idempotency_key, which keeps a queued
-- job from being queued twice: that one names a job, this one a request and its answer.
--
-- The key is scoped to the person, the method and the path: two people may choose the same key,
-- and the same key on another route is another request. A row is written before the command
-- runs, with response_status null (the request is still running, so a second one with the same
-- key is refused instead of run beside it), and completed with the answer once the command has
-- committed; a command that is refused removes its row, so the key is free for a corrected
-- request. A completed row is never changed or removed through the application role.
--
-- What it holds (SEC-6.4): request_hash is the SHA-256 of the request body sealed with the field
-- key at the application layer (a wire instruction is proposed with its bank details in the
-- body, and a bare digest would let a reader of this table test guesses of an account number
-- against the masked form, SEC-6.3); response_body is the answer as the API sent it, except that
-- bank details in clear are never stored (the API writes null in their place). Nothing else
-- about the request is kept.
----------------------------------------------------------------------------------------------
create table ops.idempotency_key (
  user_id uuid not null references core.app_user (id),
  method text not null check (method in ('POST', 'PUT', 'PATCH', 'DELETE')),
  path text not null check (path like '/api/%' and char_length(path) <= 500),
  -- 1 to 200 visible ASCII characters: '!' (0x21) to '~' (0x7E), so no space and no control character.
  key text not null check (key ~ '^[!-~]{1,200}$'),
  request_hash text not null,
  response_status integer check (response_status between 200 and 299),
  response_body jsonb,
  response_etag text,
  created_at timestamptz not null default now(),
  primary key (user_id, method, path, key),
  -- An answer exists only on a completed row.
  constraint idempotency_key_answer_needs_status
    check (response_status is not null or (response_body is null and response_etag is null))
);

----------------------------------------------------------------------------------------------
-- Grants and row-level security (SEC-5.1): the owner of a row, and nobody else. No role reads
-- another person's keys or answers, the system actor and platform admins included (SEC-5.4): a
-- stored answer is a copy of what one person was shown, under the walls and entitlements they
-- held when the command ran. Only the answer columns may be updated, and only while the row is
-- still pending; only a pending row may be deleted.
----------------------------------------------------------------------------------------------
grant select, insert, delete on ops.idempotency_key to pb_app;
grant update (response_status, response_body, response_etag) on ops.idempotency_key to pb_app;

alter table ops.idempotency_key enable row level security;
alter table ops.idempotency_key force row level security;

create policy read_own on ops.idempotency_key for select to pb_app
  using (user_id = pb.current_user_id());
create policy reserve_own on ops.idempotency_key for insert to pb_app
  with check (user_id = pb.current_user_id() and response_status is null);
create policy complete_own on ops.idempotency_key for update to pb_app
  using (user_id = pb.current_user_id() and response_status is null)
  with check (user_id = pb.current_user_id() and response_status is not null);
create policy release_own on ops.idempotency_key for delete to pb_app
  using (user_id = pb.current_user_id() and response_status is null);
