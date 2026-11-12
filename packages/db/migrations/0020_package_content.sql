-- 0020 What a reporting package shows (docs/04 M14, docs/08 section 7).
-- content is the snapshot built when a package is generated: its lines, movers, footnotes and
-- client lines. It is what the QA rules read, what the content hash covers at approval
-- (SEC-9.3), and what the next package for the same client ties its begin NAVs to.
-- tie_out_explanations holds the preparer's reason when a begin NAV differs from the last
-- released package, by position number; the QA rule reads it (QA-TIE-01).
-- Both follow the table's policies, its history and the trigger that makes a Released package
-- immutable. Client data, classified with the table (restricted).
-- Rollback note: drop the three constraints, then the two columns.

alter table rpt.package
  add column content jsonb,
  add column tie_out_explanations jsonb not null default '{}'::jsonb;

alter table rpt.package
  add constraint package_content_object
    check (content is null or jsonb_typeof(content) = 'object'),
  -- Only a Draft has nothing to show yet.
  add constraint package_content_present
    check (state = 'Draft' or content is not null),
  add constraint package_explanations_object
    check (jsonb_typeof(tie_out_explanations) = 'object');
