-- 0011 Documents: the document hub index, the expected-document tracker, extraction runs and the
-- extracted values they stage (docs/03 sections 3 and 6, docs/04 M3 and M4, docs/18 sections 6 and 7,
-- decision 0012).
-- Rollback note: drop table stg.extracted_value, doc.extraction_run, doc.expected_document and
-- doc.document in that order (their policies, indexes and triggers go with them); delete the taxonomy
-- terms of domain doc_type; delete the feature flag ai.classifier. The flag ai.extraction (migration
-- 0003) is untouched here.

----------------------------------------------------------------------------------------------
-- Reference data: the document types a document can be classified as (docs/04 M3), in the order the
-- review queue offers them. Labels are plain words.
----------------------------------------------------------------------------------------------
insert into core.taxonomy_term (domain, code, label, sort_order) values
  ('doc_type', 'doc_type.quarterly_financials', 'Quarterly financials', 1),
  ('doc_type', 'doc_type.quarterly_letter', 'Quarterly letter', 2),
  ('doc_type', 'doc_type.capital_call', 'Capital call', 3),
  ('doc_type', 'doc_type.distribution_notice', 'Distribution notice', 4),
  ('doc_type', 'doc_type.capital_account_statement', 'Capital account statement', 5),
  ('doc_type', 'doc_type.k1', 'K-1', 6),
  ('doc_type', 'doc_type.audited_financials', 'Audited financials', 7),
  ('doc_type', 'doc_type.cim', 'CIM', 8),
  ('doc_type', 'doc_type.management_presentation', 'Management presentation', 9),
  ('doc_type', 'doc_type.lpa', 'LPA', 10),
  ('doc_type', 'doc_type.side_letter', 'Side letter', 11),
  ('doc_type', 'doc_type.subscription_docs', 'Subscription documents', 12),
  ('doc_type', 'doc_type.closing_set', 'Closing set', 13),
  ('doc_type', 'doc_type.valuation_support', 'Valuation support', 14),
  ('doc_type', 'doc_type.agm_materials', 'AGM materials', 15),
  ('doc_type', 'doc_type.other', 'Other', 16);

----------------------------------------------------------------------------------------------
-- doc.document: one row per item the document store holds (docs/04 M3). The store's own id (the path
-- under the root) with the source is the idempotency key of the index; the content hash finds
-- duplicates, which link to the original and are never processed again. Only metadata, the
-- classifier's evidence (keywords and candidates by reason) and the first 2000 characters of the text
-- are kept here, for search; the document itself stays in the store. review_status follows the
-- document classification machine (docs/18 section 6).
----------------------------------------------------------------------------------------------
create table doc.document (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  source_item_id text not null,
  file_name text not null,
  folder text not null,
  title text not null,
  doc_type text references core.taxonomy_term (code) check (doc_type like 'doc_type.%'),
  sponsor_id uuid references core.sponsor (id),
  sponsor_fund_id uuid references core.sponsor_fund (id),
  investment_id uuid references core.investment (id),
  period_end date,
  confidentiality text not null default 'confidential'
    check (confidentiality in ('internal', 'confidential', 'restricted')),
  -- SHA-256 of the bytes, hex.
  content_hash text not null,
  size_bytes integer not null check (size_bytes >= 0),
  page_count integer check (page_count >= 0),
  received_at timestamptz not null,
  indexed_at timestamptz not null default now(),
  review_status text not null default 'Received'
    check (review_status in ('Received', 'Classified', 'NeedsReview', 'Duplicate')),
  classification_confidence numeric(5,4) check (classification_confidence between 0 and 1),
  classifier_evidence jsonb not null default '{}'::jsonb,
  classified_by uuid references core.app_user (id),
  classified_at timestamptz,
  duplicate_of_id uuid references doc.document (id),
  text_excerpt text,
  search_text tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(file_name, '') || ' ' || coalesce(text_excerpt, ''))
  ) stored,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (source_system, source_item_id)
);
create index document_content_hash_idx on doc.document (content_hash);
create index document_investment_idx on doc.document (investment_id);
create index document_sponsor_fund_idx on doc.document (sponsor_fund_id);
create index document_review_status_idx on doc.document (review_status);
create index document_search_idx on doc.document using gin (search_text);
call pb.add_standard_columns_trigger('doc.document');

----------------------------------------------------------------------------------------------
-- doc.expected_document: a document the firm expects for a period, from an investment (a quarterly
-- report) or from a sponsor fund (a capital account statement), one or the other, never both. Its
-- status (expected, received, late, missing) is derived when read from the clock and
-- config/definitions.json documents.*, never stored; received_document_id is set when a classified
-- document matches.
----------------------------------------------------------------------------------------------
create table doc.expected_document (
  id uuid primary key default gen_random_uuid(),
  investment_id uuid references core.investment (id),
  sponsor_fund_id uuid references core.sponsor_fund (id),
  period_end date not null,
  doc_type text not null references core.taxonomy_term (code) check (doc_type like 'doc_type.%'),
  due_date date not null,
  received_document_id uuid references doc.document (id),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  check ((investment_id is null) <> (sponsor_fund_id is null))
);
create unique index expected_document_investment_key
  on doc.expected_document (investment_id, period_end, doc_type) where investment_id is not null;
create unique index expected_document_sponsor_fund_key
  on doc.expected_document (sponsor_fund_id, period_end, doc_type) where sponsor_fund_id is not null;
create index expected_document_period_idx on doc.expected_document (period_end);
call pb.add_standard_columns_trigger('doc.expected_document');

----------------------------------------------------------------------------------------------
-- doc.extraction_run: one model call over one document against one extraction schema (a key of
-- config/extraction_schema.json), through the extraction run machine (docs/18 section 7) with the
-- retry budget per error kind. Tokens and cost are logged per run (SEC-8.9); the investment is
-- denormalized so the run carries the wall of the document it reads. approved_* record the review's
-- approval and promoted_record_id the mon.quarterly_performance row the approved values became.
----------------------------------------------------------------------------------------------
create table doc.extraction_run (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references doc.document (id),
  investment_id uuid references core.investment (id),
  period_end date,
  schema_id text not null,
  prompt_id text not null,
  prompt_version text not null,
  model_id text,
  state text not null default 'Queued'
    check (state in ('Queued', 'Running', 'Succeeded', 'Failed', 'NeedsRetry')),
  batch_id uuid references ops.job (id),
  tokens_in integer check (tokens_in >= 0),
  tokens_out integer check (tokens_out >= 0),
  cost_usd numeric(12,4) check (cost_usd >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_kind text check (error_kind in ('schema', 'transient')),
  schema_retries integer not null default 0 check (schema_retries >= 0),
  transient_retries integer not null default 0 check (transient_retries >= 0),
  requested_by uuid references core.app_user (id),
  approved_by uuid references core.app_user (id),
  approved_at timestamptz,
  promoted_record_id uuid,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1
);
create index extraction_run_document_idx on doc.extraction_run (document_id);
create index extraction_run_state_idx on doc.extraction_run (state);
create index extraction_run_batch_idx on doc.extraction_run (batch_id);
call pb.add_standard_columns_trigger('doc.extraction_run');

----------------------------------------------------------------------------------------------
-- stg.extracted_value: one staged field of a run, as the model answered it (value as decimal text, an
-- ISO date or text, never a float; the unit it declared; the page and the quote of at most 150
-- characters that cite it; its confidence) with the deterministic validation's state and findings,
-- and the reviewer's decision. Nothing here reaches a production table except through the run's
-- approval (SEC-9.1).
----------------------------------------------------------------------------------------------
create table stg.extracted_value (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references doc.extraction_run (id),
  investment_id uuid references core.investment (id),
  field text not null,
  value text,
  unit text check (unit in ('USD', 'USD_K', 'USD_M', 'USD_B', 'PCT', 'COUNT', 'DATE')),
  page integer check (page >= 1),
  quote text check (char_length(quote) <= 150),
  confidence numeric(5,4) check (confidence between 0 and 1),
  validation_state text not null default 'clean'
    check (validation_state in ('clean', 'flagged', 'invalid')),
  findings jsonb not null default '[]'::jsonb,
  reviewer_id uuid references core.app_user (id),
  decision text check (decision in ('accepted', 'edited', 'rejected')),
  edited_value text,
  decided_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  row_version integer not null default 1,
  unique (run_id, field)
);
create index extracted_value_investment_idx on stg.extracted_value (investment_id);
call pb.add_standard_columns_trigger('stg.extracted_value');

----------------------------------------------------------------------------------------------
-- Grants and row-level security. A document, its expected-document row, its runs and its values
-- carry the wall of the investment they are attached to (SEC-5.1, SEC-5.3): the wall clause is in
-- the policy, not only in the API's filter. A document attached to no investment (a sponsor fund's
-- statement, an unclassified scan) is every authenticated user's. No delete is granted: a document
-- leaves the index only when the store no longer has it, and an extraction is never erased.
----------------------------------------------------------------------------------------------
grant select, insert, update on doc.document, doc.expected_document, doc.extraction_run, stg.extracted_value to pb_app;

alter table doc.document enable row level security;
alter table doc.document force row level security;
alter table doc.expected_document enable row level security;
alter table doc.expected_document force row level security;
alter table doc.extraction_run enable row level security;
alter table doc.extraction_run force row level security;
alter table stg.extracted_value enable row level security;
alter table stg.extracted_value force row level security;

-- doc.document: operations and the service index (insert) and classify (update); the deal team
-- classifies (update) what it can see.
create policy read_visible on doc.document for select to pb_app
  using (pb.is_authenticated() and (investment_id is null or pb.can_see_walled('investment', investment_id)));
create policy write_insert on doc.document for insert to pb_app
  with check (pb.has_any_role(array['operations', 'service'])
    and (investment_id is null or pb.can_see_walled('investment', investment_id)));
create policy write_update on doc.document for update to pb_app
  using (pb.has_any_role(array['operations', 'service'])
    and (investment_id is null or pb.can_see_walled('investment', investment_id)))
  with check (pb.has_any_role(array['operations', 'service'])
    and (investment_id is null or pb.can_see_walled('investment', investment_id)));
create policy review_update on doc.document for update to pb_app
  using (pb.has_role('deal_team')
    and (investment_id is null or pb.can_see_walled('investment', investment_id)))
  with check (pb.has_role('deal_team')
    and (investment_id is null or pb.can_see_walled('investment', investment_id)));

-- doc.expected_document: generated and matched by operations and the service.
create policy read_visible on doc.expected_document for select to pb_app
  using (pb.is_authenticated() and (investment_id is null or pb.can_see_walled('investment', investment_id)));
call pb.add_write_policies('doc.expected_document', array['operations', 'service'],
  'investment_id is null or pb.can_see_walled(''investment'', investment_id)');

-- doc.extraction_run: operations and the service start and drive runs; the deal team approves
-- (update) the runs it can see.
create policy read_visible on doc.extraction_run for select to pb_app
  using (pb.is_authenticated() and (investment_id is null or pb.can_see_walled('investment', investment_id)));
create policy write_insert on doc.extraction_run for insert to pb_app
  with check (pb.has_any_role(array['operations', 'service'])
    and (investment_id is null or pb.can_see_walled('investment', investment_id)));
create policy write_update on doc.extraction_run for update to pb_app
  using (pb.has_any_role(array['operations', 'service'])
    and (investment_id is null or pb.can_see_walled('investment', investment_id)))
  with check (pb.has_any_role(array['operations', 'service'])
    and (investment_id is null or pb.can_see_walled('investment', investment_id)));
create policy review_update on doc.extraction_run for update to pb_app
  using (pb.has_role('deal_team')
    and (investment_id is null or pb.can_see_walled('investment', investment_id)))
  with check (pb.has_role('deal_team')
    and (investment_id is null or pb.can_see_walled('investment', investment_id)));

-- stg.extracted_value: only the service writes what a model answered; the deal team, operations
-- and the service record review decisions (update).
create policy read_visible on stg.extracted_value for select to pb_app
  using (pb.is_authenticated() and (investment_id is null or pb.can_see_walled('investment', investment_id)));
create policy write_insert on stg.extracted_value for insert to pb_app
  with check (pb.has_role('service')
    and (investment_id is null or pb.can_see_walled('investment', investment_id)));
create policy review_update on stg.extracted_value for update to pb_app
  using (pb.has_any_role(array['deal_team', 'operations', 'service'])
    and (investment_id is null or pb.can_see_walled('investment', investment_id)))
  with check (pb.has_any_role(array['deal_team', 'operations', 'service'])
    and (investment_id is null or pb.can_see_walled('investment', investment_id)));

----------------------------------------------------------------------------------------------
-- Kill switch for the classifier (SEC-8.10). ai.extraction (migration 0003) stays off by default:
-- the API enables it for the test harness and the synthetic composition through this table.
----------------------------------------------------------------------------------------------
insert into ops.feature_flag (key, enabled, description) values
  ('ai.classifier', true, 'Kill switch for AI document classification calls (SEC-8.10)');
