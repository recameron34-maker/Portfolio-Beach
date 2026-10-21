-- 0012 Phase 2 review fixes: data exceptions about documents and extraction runs read under the
-- record's own policy (W2), and the reviewer's unit beside the model's on a staged extracted value
-- (WF-1) (docs/03 sections 3 and 6, docs/05 SEC-5.3 and SEC-9.1, decision 0012).
-- Rollback note: recreate read_all on ops.data_exception as migration 0010 defines it (the two staging
-- clauses only); alter table stg.extracted_value drop column edited_unit.

----------------------------------------------------------------------------------------------
-- ops.data_exception: migration 0010 walls an exception about a staged row by the row's own policy.
-- Migration 0011 added two entities, doc.document (DOC-READ-01) and doc.extraction_run (EXT-RUN-01),
-- without extending the clause, so an exception about a walled position's failed run or unreadable
-- report was listed to everyone signed in. The same rule now covers them: visible only to someone the
-- document's or the run's own policy admits, so a walled position's exceptions stay inside the wall
-- (SEC-5.3). Everything else about the table (the update policy and the column grant) is unchanged.
----------------------------------------------------------------------------------------------
drop policy read_all on ops.data_exception;
create policy read_all on ops.data_exception for select to pb_app
  using (pb.is_authenticated()
    and (entity <> 'stg.intake_row' or exists (select 1 from stg.intake_row r where r.id = entity_id))
    and (entity <> 'stg.valuation' or exists (select 1 from stg.valuation v where v.id = entity_id))
    and (entity <> 'doc.extraction_run' or exists (select 1 from doc.extraction_run x where x.id = entity_id))
    and (entity <> 'doc.document' or exists (select 1 from doc.document d where d.id = entity_id)));

----------------------------------------------------------------------------------------------
-- stg.extracted_value: a reviewer's edit carries its own unit (edited_unit beside edited_value), so
-- the unit the model declared is never overwritten and an accept after an edit still promotes the
-- model's value in the model's unit, the edit its value in its own (rule 10, SEC-9.1). The same
-- units as `unit`; null until a reviewer edits the row.
----------------------------------------------------------------------------------------------
alter table stg.extracted_value
  add column edited_unit text check (edited_unit in ('USD', 'USD_K', 'USD_M', 'USD_B', 'PCT', 'COUNT', 'DATE'));
