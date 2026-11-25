-- 0024 Who submitted a reporting package for review, and the reviewer the record refuses
-- (docs/18 section 5, SEC-5.6, decision 0024 "After the verification").
-- A package's figures are the reading of whoever generated it, so preparing a package is starting
-- it or running one of its generations. None of those people approves it, and neither does
-- whoever submitted it for review: the hand-over to review is always between two people.
-- Migration 0019 held the reviewer apart from prepared_by only. submitted_by records the person
-- who submitted (null until then, and on a package from before this column, where it bars
-- nobody); the two checks hold the reviewer apart from the submitter and from every person the
-- change log names as having run a generation. The state machine refuses the same people first
-- (reportingPackageMachine); these checks are the second line (SEC-5.1).
-- No policy changes: who reads, prepares and moves a package is as migration 0019 wrote it.
-- Personal data, classified with the people columns of the table.
-- Rollback note: drop the two constraints, then the column.

alter table rpt.package
  add column submitted_by uuid references core.app_user (id);

alter table rpt.package
  add constraint package_reviewer_not_submitter
    check (reviewer_id is null or submitted_by is null or reviewer_id <> submitted_by),
  -- change_log holds one entry per generation run, each with the user id of who ran it.
  add constraint package_reviewer_not_generator
    check (reviewer_id is null
      or not change_log @> jsonb_build_array(jsonb_build_object('by', reviewer_id::text)));
