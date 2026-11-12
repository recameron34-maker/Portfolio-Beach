-- 0007 Accounting intake (docs/04 M2, docs/18 section 2, SEC-9.1).
-- Rollback note: alter table stg.intake_file drop column findings; drop index stg.intake_row_natural_key_idx and
-- recreate the unique constraint on stg.intake_row (intake_file_id, natural_key); drop the review_update policies
-- on stg.intake_file and stg.intake_row.

-- File-level findings (an unknown or missing column, an empty file). A refused file keeps them and holds no rows.
alter table stg.intake_file add column findings jsonb not null default '[]'::jsonb;

-- A file may carry the same investment and period twice. The later row is staged and flagged (DUP-01) so a
-- person decides; idempotency across imports is the file's content hash (unique (source, content_hash)).
alter table stg.intake_row drop constraint intake_row_intake_file_id_natural_key_key;
create index intake_row_natural_key_idx on stg.intake_row (intake_file_id, natural_key);

-- Reviewers approve staged rows (docs/18 section 2: validated > approved by operations or the deal team), which
-- updates the row and the file's status. The deal team gains update only; importing (insert) stays with
-- operations and the service, and the API's role guard keeps POST import to operations.
create policy review_update on stg.intake_file for update to pb_app
  using (pb.has_role('deal_team')) with check (pb.has_role('deal_team'));
create policy review_update on stg.intake_row for update to pb_app
  using (pb.has_role('deal_team')) with check (pb.has_role('deal_team'));
