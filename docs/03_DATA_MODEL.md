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
- **Row-level security:** enabled on every business table. The API sets `app.user_id`, `app.roles` and `app.entitlements` per transaction (`SET LOCAL`). Policies cover roles, client entitlements and walled records (`docs/05` SEC-5).
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
| fund_holding | sponsor_fund_id, portfolio_company_id | |
| vehicle | name (unique), type (co_invest, cv, primary_program (fund of funds), private_credit, client_sma), vintage, currency, closing_count | |
| investment | investment_number (unique), vehicle_id, portfolio_company_id, sponsor_fund_id (nullable), deal_type (taxonomy: co_invest_equity, cv_single_asset, cv_multi_asset, primary_fund, private_credit), entry_date, is_active | deal_type decides which monitoring tables apply (`quarterly_performance` for equity and CV, `credit_terms` + `credit_performance` for credit, fund-level rows for primaries) |
| client | name, reporting_bases (json), cadence | Restricted |
| commitment | vehicle_id, sponsor_fund_id, client_id (nullable; set only for client-directed SMA commitments), amount, commitment_date, side_letter_flags | Restricted. The firm vehicle's commitment to a sponsor fund |
| lp_commitment | client_id, vehicle_id, amount, commitment_date, closing_number, ownership_pct (nullable until final close), side_letter_flags | Restricted. A client's commitment to a firm vehicle; ownership_pct drives client look-through |
| taxonomy_term | domain, code, label, parent_id, active | |
| match_guard | name_a, name_b, reason | never auto-match |
| wall | name, description; wall_member(wall_id, user_id); walled_record(wall_id, entity, entity_id) | information barriers |

### deal
| Table | Key fields |
|---|---|
| opportunity | company, sponsor_id, sponsor_fund_id, deal_type, stage, owner_id, ev, entry_multiple, leverage, check_requested, check_received, pass_reason_code, pass_note, fund_fit_flag |
| opportunity_stage_history | opportunity_id, from_stage, to_stage, actor, at |
| allocation | opportunity_id or investment_id, vehicle_id, client_id, requested, received |
| diligence_template / diligence_task | template by deal type; task: opportunity_id, workstream, owner_id, due, status, evidence_document_id, required_for_ic |
| ic_decision | opportunity_id, date, decision, amount, conditions (json), memo_document_id |
| closing | investment_id, close_date, ops_confirmed_by, ops_confirmed_at, status |
| closing_item | closing_id, item, required, document_id, status |
| legal_term | investment_id, term_type, value (json), source_document_id, status |
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
| capital_notice | notice_type (taxonomy: capital_call, distribution, equalization, interest_payment, principal_repayment, fee_notice), vehicle_id, investment_id or commitment_id, issue_date, due_date, amount, split (json), ilpa_fields (json), preferred_funding_date, state |
| trade_ticket | capital_notice_id, amount, funding_date, prepared_by, approved_by, state |
| wire_instruction | counterparty, version, bank_details (encrypted at app layer), callback_by, callback_at, callback_number_source, active |
| deal_change_request | investment_id, change_type, effective_date, details (json), owner_id, state, applied_period |
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
| doc.document | source_system, source_item_id (unique per source), title, doc_type, sponsor_id, sponsor_fund_id, investment_id, period_end, confidentiality, content_hash, received_at, classification_confidence, review_status |
| doc.expected_document | investment_id or sponsor_fund_id, period_end, doc_type, due_date, received_document_id |
| doc.extraction_run | document_id, schema_id, prompt_version, model_id, state, tokens_in, tokens_out, cost, started_at, finished_at, error_code |
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
| ops.data_exception | source, entity, entity_id, rule_id, expected, actual, severity, owner_id, state, external_ticket |
| ops.job | type, requested_by, state, progress, result_ref, error_code |
| ops.feature_flag | key, enabled, updated_by |
| ops.systems_issue | code, problem, area, severity, lane, decision_log (json) |
| stg.* | one table per intake type, plus stg.extracted_value (run_id, field, value, unit, page, quote, confidence, validation_state, reviewer_id, decision) |
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
- Resolve by investment number first, then canonical name or alias exact match. Never fuzzy auto-link.
- Near-misses and unresolved names go to `ops.data_exception` with suggested candidates for a human.
- Match guards (`core.match_guard`) block specific pairs permanently.

## 6. Migration rules
- One migration per PR; numbered; forward-only with a documented rollback note.
- Backward compatible within a release (expand, migrate, contract over separate releases).
- Every migration has a test that runs it on the seeded database.
