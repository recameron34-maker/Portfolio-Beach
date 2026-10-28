# 03: Data Model

**Database:** PostgreSQL 16 by default (Azure SQL is an allowed alternative, `docs/13`). The schema lives in code (`packages/db`, Drizzle) and changes only through numbered migrations. Tests run on an in-process Postgres (no Docker needed).

## 1. Conventions
- **Schemas:** `core` (reference entities), `deal` (pipeline, diligence, closing, legal), `mon` (monitoring, valuation, cash, capital activity), `doc` (documents, extraction), `rel` (relationships), `rpt` (reporting, disclosures, statistics), `ops` (tasks, exceptions, config, jobs), `audit` (events, history), `stg` (staging for every intake).
- **Keys:** `uuid` primary keys (`gen_random_uuid()`), plus natural **unique** keys where they exist (investment number, canonical fund name, contact email lowercased, investment + period end).
- **Money:** `numeric(20,2)` in dollars. Percentages `numeric(12,8)` as decimals (0.125 = 12.5%). Multiples `numeric(12,6)`. **Never** `float` / `double` / JS `number` for stored money (use a decimal library, `docs/17`).
- **Currency:** every money column has a sibling `currency char(3)` defaulting to `USD`. The prototype is USD only; mixed-currency math must fail loudly, not convert silently.
- **Dates:** period ends are `date`. Events are `timestamptz` in UTC. Business dates never pass through local time zones.
- **Lists:** Postgres enums only for workflow states (`docs/18`). Business lists live in `core.taxonomy_term` so they change without migrations.
- **Standard columns on every table:** `created_at`, `created_by`, `updated_at`, `updated_by`, `row_version int` (optimistic concurrency, `docs/17`), `deleted_at` (soft delete only where the table allows deletion; financial tables never delete).
- **Lineage columns** on any table with values from outside: `source_document_id`, `source_page`, `source_locator` (sheet/row/cell), `extraction_run_id`, `prompt_version`, `model_id`.
- **Approval columns** on any table that can reach a client or the accounting system: `status`, `approved_by`, `approved_at`, `approval_reason`.
- **History:** financial and approval tables have `<table>_history` populated by triggers (full row image + operation + actor + time). `audit.event` is append-only (no UPDATE / DELETE grants to any role, including the app owner role).
- **Row-level security:** enabled on every business table and forced on all but `core.wall_member` and `core.walled_record`, which `pb.can_see_walled` (security definer) reads as their owner, the migration role (migration 0009). The API sets `app.user_id`, `app.roles` and `app.entitlements` per transaction (`SET LOCAL`); every role is checked by value before it is set. Policies cover roles, client entitlements and walled records (`docs/05` SEC-5).
- **Constraints over code:** foreign keys everywhere; `CHECK` constraints for impossible states; unique partial indexes for state rules (for example one `locked` valuation per investment and period).
- **Staging:** every intake writes to `stg.*` with status (`new`, `validated`, `flagged`, `approved`, `rejected`, `promoted`). Promotion happens in one transaction with an audit event.

## 2. Entity map
```
core.sponsor 1-N core.sponsor_fund 1-N core.fund_holding N-1 core.portfolio_company
core.vehicle 1-N core.investment N-1 core.portfolio_company        (investment = company x vehicle; investment_number unique)
core.vehicle 1-N core.commitment N-1 core.sponsor_fund              (vehicle's commitment to a sponsor fund; unique: vehicle, sponsor_fund, client)
core.client 1-N core.lp_commitment N-1 core.vehicle                 (client's commitment to a firm vehicle; unique: client, vehicle)
core.investment 1-1 mon.credit_terms; core.investment 1-N mon.credit_performance   (private credit positions only)
core.investment 1-N mon.quarterly_performance                      (unique: investment_id, period_end)
core.investment 1-N mon.valuation (versions)  1-N mon.valuation_approval
core.investment 1-N mon.cash_flow             (IRR source of truth)
deal.opportunity 0-1 core.investment          (on close)
rel.contact N-1 core.sponsor; rel.interaction N-N rel.contact via rel.interaction_attendee
doc.document 1-N doc.extraction_run 1-N stg.extracted_value
```

## 3. Tables by schema
### core
| Table | Key fields | Notes |
|---|---|---|
| sponsor | name, canonical_name (unique), tier (taxonomy), hq | |
| sponsor_fund | sponsor_id, canonical_name (unique), vintage, size_target, size_hard_cap, size_final, strategy | |
| fund_alias | sponsor_fund_id, alias (unique) | name matching |
| portfolio_company | canonical_name, sector, geography, description | |
| company_alias | portfolio_company_id, alias (unique across companies) | name matching, exact only (section 5); history; readable by every authenticated user, maintained by operations and platform admins (migration 0010) |
| fund_holding | sponsor_fund_id, portfolio_company_id | |
| vehicle | name (unique), type (co_invest, cv, primary_program (fund of funds), private_credit, client_sma), vintage, currency, closing_count | |
| investment | investment_number (unique), vehicle_id, portfolio_company_id, sponsor_fund_id (nullable), deal_type (taxonomy: co_invest_equity, cv_single_asset, cv_multi_asset, primary_fund, private_credit), entry_date, is_active | deal_type decides which monitoring tables apply (`quarterly_performance` for equity and CV, `credit_terms` + `credit_performance` for credit, fund-level rows for primaries) |
| client | name, reporting_bases (json), cadence | Restricted |
| commitment | vehicle_id, sponsor_fund_id, client_id (nullable; set only for client-directed SMA commitments), amount, commitment_date, side_letter_flags | Restricted. The firm vehicle's commitment to a sponsor fund |
| lp_commitment | client_id, vehicle_id, amount, commitment_date, closing_number, ownership_pct (nullable until final close), side_letter_flags | Restricted. A client's commitment to a firm vehicle; ownership_pct drives client look-through |
| taxonomy_term | domain, code, label, parent_id, active | |
| match_guard | name_a, name_b, reason | never auto-match |
| wall | name, description; wall_member(wall_id, user_id); walled_record(wall_id, entity, entity_id) | information barriers; `pb.can_see_walled` admits members and the system actor (`service` role, migration 0008, decision 0009), never anyone else; wall_member and walled_record keep row-level security enabled, not forced, so the definer's owner reads them while `pb_app` stays bound (migration 0009) |

### deal
| Table | Key fields |
|---|---|
| opportunity | name, company_name, portfolio_company_id (null until known), sponsor_id, sponsor_fund_id, deal_type (taxonomy), sector, geography, stage (`docs/18` section 4; enum `deal.stage`), owner_id (the deal lead), received_date, target_commitment, currency, source, pass_reason_code (taxonomy `pass_reason.*`, required when Passed), pass_note, investment_id (unique, set on close, required when Closed), scenario_tag. The wall is on the opportunity (`core.walled_record` entity `opportunity`, migration 0013); the M5 skeleton (ev, multiples, leverage, fund fit) comes in Phase 5 |
| opportunity_stage_history | opportunity_id, from_stage, to_stage, command (advance, pass, reopen), reason, changed_by, changed_at. Append-only: the pipeline's own record of every stage move, not an image table |
| allocation | opportunity_id or investment_id (at least one; both while a deal converts), vehicle_id, client_id (null is the vehicle line), requested, received, currency; unique per anchor, vehicle and client; history. The tie-out compares the lines with the closing commitment (M22) |
| diligence_task | opportunity_id, workstream (taxonomy `diligence_workstream.*`), title, owner_id, due_date, status (open, done, waived: waived needs waived_reason), required_for_ic, evidence_document_id, waived_reason. Tasks come from the template per deal type in `config/diligence_templates.json` (no template table) |
| ic_decision | opportunity_id, decision_date, decision (approved, declined, deferred), amount, currency, conditions (json: sentences), memo_document_id, recorded_by; unique (opportunity_id, decision_date). Never edited: a later row supersedes |
| closing | opportunity_id (unique; null only for a position that predates the pipeline), investment_id (unique, set on conversion), close_date (**the single source of every close date**: no other table has a column by that name), commitment_amount, currency, state (`docs/18` section 12; enum `deal.closing_state`: Open, OpsConfirmed), ops_confirmed_by, ops_confirmed_at, reopen_reason; history |
| closing_item | closing_id, item_code, label, required, document_id, status (open, received: needs document_id, waived: needs waived_reason), waived_reason; unique (closing_id, item_code). The checklist from `config/closing_checklist.json` |
| legal_term | closing_id, investment_id (copied at close), term_type (taxonomy `legal_term_type.*`), value (json), source_document_id, status (draft, confirmed: needs confirmed_by and confirmed_at), confirmed_by, confirmed_at; history |
| consent_request | investment_id, vehicle_id, client_id, status, signed_document_id |
| background_check | opportunity_id, subject_ref, provider, status, result_document_id (Restricted) |

### mon
| Table | Key fields |
|---|---|
| quarterly_performance | investment_id, period_end, revenue_ltm, ebitda_ltm, ev, net_debt, cash, total_equity, highlights (json), commentary, is_entry_snapshot, status |
| valuation | investment_id, period_end, version, method, inputs (json), fair_value, state, lock_hash, prepared_by, approved_by |
| valuation_approval | valuation_id, approver_id, decision, comment, at |
| valuation_staging | report_date, investment_number, reported_value, prior_value, variance_pct, flag, match_status, reviewer_id, decision |
| cash_flow | investment_id or commitment_id, flow_date, flow_type (contribution, distribution, fee, expense, interest, principal, recallable), amount, source_notice_id, status | PIK capitalization is not a cash flow: it raises par in `credit_performance` and shows in unrealized value |
| capital_notice | notice_type (taxonomy: capital_call, distribution, equalization, interest_payment, principal_repayment, fee_notice), vehicle_id, investment_id or commitment_id, issue_date, due_date, amount, split (json), ilpa_fields (json), preferred_funding_date, state, urgency_flag and wire_change_flag (SEC-12.4 alerts, migration 0013), funded_at, funded_by |
| trade_ticket | capital_notice_id (unique: one ticket per notice), wire_instruction_id (the version it was approved against), amount, currency, funding_date, prepared_by, prepared_at, approved_by (never the preparer, SEC-12.3), approved_at, state (`docs/18` section 3; enum `mon.trade_ticket_state`: Drafted, Approved, Funded, Withdrawn: Approved and Funded need an approver and an instruction, Withdrawn a withdrawn_reason), withdrawn_reason; history. Visible to whoever sees the notice |
| wire_instruction | sponsor_fund_id or investment_id (exactly one), counterparty_name, version (unique per counterparty), bank_details_enc (AES-256-GCM at the application layer, `packages/db/src/fieldCrypto.ts`, never plaintext), bank_details_masked ("<bank> ****<last 4>"), state (`docs/18` section 11; enum `mon.wire_instruction_state`: Proposed, Verified, Rejected, Superseded), proposed_by, proposed_at, source_note (plain words, never a document body), callback_by (never the proposer, SEC-12.2), callback_at, callback_number_source (prior_instruction, sponsor_website, known_contact, fund_administrator), callback_result (confirmed, not_confirmed), verified_at, rejection_reason, active (one per counterparty, Verified only); history. Read by operations, approvers, auditors, platform admins and the system actor only; not under the investment wall (an operations control, migration 0013) |
| deal_change_request | investment_id, change_type (taxonomy `change_type.*`), effective_date, details (json: a small map of plain values), summary (one line), owner_id (required from Routed on), submitted_by, state (`docs/18` section 8; enum `mon.change_request_state`), applied_period (a quarter end, required when Applied), applied_by, applied_at, rejection_reason (required when Rejected). Carries the investment wall |
| realization_outlook | investment_id, horizon_months, outlook (none, partial, full), set_by, set_at |
| subline_facility / subline_activity | vehicle_id, lender, cap, rate, maturity; activity: date, type, amount, source |
| pacing_plan | vehicle_id, year, target_commitments, gp_count_min, gp_count_max, exposure_targets (json) |
| track_record | sponsor_fund_id, as_of, gross_irr, net_irr, gross_moic, net_moic, dpi, source |
| advisory_seat | sponsor_fund_id, holder_id, seat_type, start, end |
| credit_terms | investment_id (unique), facility_type (taxonomy: senior_secured, unitranche, second_lien, mezzanine, nav_loan, preferred), seniority_rank, commitment_amount, base_rate (taxonomy), floor, spread, cash_coupon, pik_coupon, oid, upfront_fee, maturity_date, amortization (json), call_protection (json), covenants (json: name, level, test frequency), effective_date, source_document_id, status | Private credit only |
| credit_performance | investment_id, period_end, par_value, cost_basis, fair_value, accrued_interest, cash_interest_ltm, pik_capitalized_ltm, principal_repaid_ltm, funded_amount, ebitda_ltm, cash_interest_expense_ltm, net_debt_through_tranche, ev, dscr_inputs (json), covenant_status (taxonomy: compliant, waiver, breach), payment_status (taxonomy: current, deferred, default), highlights (json), commentary, status | unique: investment_id, period_end. Same period-selection rules as quarterly_performance |

### doc, rel, rpt, ops, stg, audit
| Table | Key fields |
|---|---|
| doc.document | source_system, source_item_id (unique per source: the store's path), file_name, folder, title, doc_type (taxonomy `doc_type.*`, null until classified), sponsor_id, sponsor_fund_id, investment_id, period_end, confidentiality (internal, confidential, restricted), content_hash, size_bytes, page_count, received_at, indexed_at, review_status (`docs/18` section 6: Received, Classified, NeedsReview, Duplicate), classification_confidence, classifier_evidence (json: keywords and candidates by reason only), classified_by, classified_at, duplicate_of_id, text_excerpt (the first 2000 characters, for search only), search_text (generated tsvector over title, file name and excerpt). A document attached to a walled investment carries that wall (migration 0011) |
| doc.expected_document | investment_id or sponsor_fund_id (exactly one), period_end, doc_type, due_date, received_document_id; status (expected, received, late, missing) is derived at read time from the clock and `config/definitions.json` `documents`, never stored |
| doc.extraction_run | document_id, investment_id (the wall), period_end, schema_id (`config/extraction_schema.json`), prompt_id, prompt_version, model_id, state (`docs/18` section 7), batch_id (ops.job), tokens_in, tokens_out, cost_usd, started_at, finished_at, error_code, error_kind (schema, transient), schema_retries, transient_retries, requested_by, approved_by, approved_at, promoted_record_id |
| rel.contact | email (unique, lowercased), full_name, sponsor_id, title |
| rel.interaction | type (email, meeting, call, event), occurred_at, subject_hash, ai_summary (1000 chars max), captured_by, source_message_id (unique) |
| rel.interaction_attendee | interaction_id, contact_id or user_id |
| rel.coverage | sponsor_id, primary_user_id, secondary_user_id, delegate_user_id, effective_from, effective_to |
| rel.agm_event | sponsor_id, date, location, rsvp, attendees (json), travel_by, notes_state |
| rel.capture_optin | user_id, scopes, opted_in_at |
| rpt.template | name, format, client_id, token_map_version, file_ref |
| rpt.package | client_id, period_end, template_id, state, reviewer_id, released_at, change_log (json) |
| rpt.override | package_id, element_id, value, reason, set_by |
| rpt.qa_result | package_id, rule, entity_ref, expected, actual, passed, override_reason, approver_id |
| rpt.disclosure | code, version, text, effective_from, effective_to, applies_to (json) |
| rpt.approved_statistic | name, value, as_of, source_query, approver_id, expires_at |
| rpt.distribution_log | package_id, recipient, version, sent_at |
| ops.task | regarding_entity, regarding_id, title, owner_id, due, state, priority |
| ops.data_exception | source, entity, entity_id, rule_id, expected, actual, severity, owner_id, state (open, acknowledged, resolved, wont_fix: `docs/18` section 9), external_ticket, candidates (json: by reason only). Readable by every authenticated user, except that an exception about a staged row (`stg.intake_row`, `stg.valuation`), a document (`doc.document`) or an extraction run (`doc.extraction_run`) is visible only to someone that record's own policy admits (migrations 0010 and 0012), so a walled position's exceptions stay inside the wall; operations alone updates it, and only state, owner_id and external_ticket (column grant, migration 0010) |
| ops.job | type, requested_by, state, progress, result_ref, error_code |
| ops.feature_flag | key, enabled, updated_by |
| ops.systems_issue | code, problem, area, severity, lane, decision_log (json) |
| stg.intake_file | source (accounting, weekly, lookthrough, ops_drop), file_name, content_hash (unique with source: an import is idempotent by content), as_of (the date a look-through run reports for), template_signature (the ops-drop template the workbook matched), received_at, received_by, row_count, status, findings (json: file-level findings such as an unknown column; a refused file holds no rows) |
| stg.intake_row | intake_file_id, row_no (unique per file, the row's locator), natural_key (the layout's key columns; a file may repeat one, which DUP-01 flags), target_entity, target_id, payload (json: names, period, figures, raw cells and the link), diff (json), validation (json: findings), status, reviewer_id, decision, decided_at, promoted_at. A row carries the wall of the investment its payload links to: `pb.intake_row_visible(payload)` on the select and update policies (migration 0009); an unlinked row is every reviewer's; import (insert) covers the whole book and the file's counts are taken by the system actor |
| stg.valuation | intake_file_id, row_no (unique per file), report_date, investment_number, company_name, investment_id, reported_value, prior_value, prior_source (locked_mark, weekly), prior_date, variance_pct, flag, match_status, link (json), findings (json), raw (json: every cell as the file wrote it), status, reviewer_id, decision, decided_at, promoted_at, valuation_id (the Draft valuation of method weekly_report the approval created). The weekly report values (M2); a file may repeat (report_date, investment_number) and the DUP rules flag it. The typed cells are nullable so a row the file got wrong is staged and flagged, never refused. Same wall rule as intake_row, on investment_id (migration 0010) |
| stg.extracted_value | run_id, investment_id (the wall), field (a key of the run's extraction schema, plus `highlights` and `commentary`), value (decimal text, ISO date or text, never a float), unit (USD, USD_K, USD_M, USD_B, PCT, COUNT, DATE), page, quote (150 characters at most), confidence, validation_state (clean, flagged, invalid), findings (json: rule ids and messages), reviewer_id, decision (accepted, edited, rejected), edited_value, edited_unit (the edit's own unit, migration 0012: `value` and `unit` stay what the model declared, an edit promotes edited_value in edited_unit), decided_at; unique (run_id, field). The reviewed values of a run; approval promotes the target fields into mon.quarterly_performance with the lineage columns |
| stg.* | one table per intake type |
| audit.event | at, actor_id, actor_type (user, service, agent), action, entity, entity_id, before_hash, after_hash, reason, request_id |

## 4. Data definitions (single source of truth)
Stored in `config/definitions.json`, rendered on the Data Dictionary page. Formulas and edge cases are in `docs/08`.
- **NAV date:** period end of the latest Locked valuation.
- **Status as of a date:** a position exists from its entry date and is held until its exit date; `is_active` records only how things stand today, so every as-of read derives status from the two dates (`apps/api/src/portfolio/loaders.ts`). Notices count from their issue date, cash flows from their flow date and commitments from their commitment date.
- **Close date:** the closing record only.
- **Prior Year:** the same fiscal quarter one year earlier only; otherwise the missing placeholder.
- **Units:** money stored in dollars; AI output declares units; conversion only in `packages/calc/units.ts`.
- **Deal type branching:** investment deal type controls which fields and tables apply (CV-only fields hidden for direct co-invests; credit terms and credit metrics shown only for private credit; fund-level metrics only for primaries).
- **Client look-through:** a client's share of any vehicle position is `position x lp_commitment.ownership_pct` for that vehicle, computed at read time from approved values; never stored per client.

## 5. Linking and matching rules
- Resolve by investment number first, then canonical name or alias exact match (`core.fund_alias` for sponsor funds, `core.company_alias` for portfolio companies). Never fuzzy auto-link.
- Near-misses and unresolved names go to `ops.data_exception` with suggested candidates for a human.
- Match guards (`core.match_guard`) block specific pairs permanently.

## 6. Migration rules
- One migration per PR; numbered; forward-only with a documented rollback note.
- Backward compatible within a release (expand, migrate, contract over separate releases).
- Every migration has a test that runs it on the seeded database.
