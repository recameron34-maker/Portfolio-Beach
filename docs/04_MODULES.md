# 04: Modules, Requirements and Acceptance Criteria

Each module lists: **Purpose**, **Features**, **Prototype scope** (what runs on synthetic data and mock adapters), **Depends on**, and **Acceptance criteria** (AC). AC must be provable by automated tests on synthetic data unless marked *(post-merge)*.

Global rules in `CLAUDE.md` apply to every module. Workflow states are defined in `docs/18`, calculations in `docs/08`, test expectations in `docs/12`, engineering conventions in `docs/17`.

---

## M1. Data Foundation
**Purpose:** one trusted, linked, secured data layer.
**Features**
- Core entities from `docs/03`: sponsor, sponsor fund, portfolio company, vehicle, investment, client, commitment (vehicle to sponsor fund), LP commitment (client to vehicle), contact.
- Linking services: portfolio company to sponsor fund; commitment to sponsor fund, with dedup when two vehicles or clients hold the same fund (one canonical fund, many commitments).
- Client look-through: every vehicle position allocated to clients by `lp_commitment.ownership_pct`; ownership percentages per vehicle must sum to 100% after the final close or the vehicle shows a data exception.
- Alias table and **match guards** (pairs of similar names that must never auto-match).
- Taxonomy master (sector, strategy, geography, deal type, doc type) owned by the firm; outside sources are mapped to it and never override it.
- Data Health page: orphans, unresolved names, stale records, open exceptions.
- Data Dictionary page that renders `config/definitions.json`.
**Prototype scope:** fully built on synthetic data.
**Depends on:** none.
**AC**
- Every active investment resolves Investment > Vehicle > Sponsor Fund > Sponsor; orphan count is 0 on the seed data or each orphan has an exception row.
- Client look-through totals equal the vehicle totals for every vehicle whose ownership sums to 100% (test).
- A near-miss name pair from the match-guard config is never linked automatically (test).
- Each role reads exactly what its matrix allows: positive and negative tests per role (`docs/12`).

## M2. Data Intake, Validation and Integration
**Purpose:** remove rekeying; nothing reaches production unvalidated.
**Features**
- `accounting-import`: generic CSV/XLSX export from the accounting system goes to staging, diff vs. current, approval, then upsert.
- `accounting-export`: approved data goes to an upload file in a configurable column layout (`config/accounting_layout.json`).
- `ops-drop-import`: operations workbooks parsed by **template signature** (sheet names + header hash); unknown templates are rejected with a clear message.
- `weekly-report-intake`: weekly values go to valuation staging with prior value, variance %, threshold flag and reviewer decision.
- `lookthrough-reconcile`: outside exposure data compared to the taxonomy and approved values; differences become Data Exceptions with an optional external ticket number.
- `packages/validation`: a rule library (target 100+ rules) in these categories: required fields, types and units, ranges, period continuity, quarter-over-quarter and YoY bounds, totals that tie, duplicates, cross-entity consistency, stale data.
**Prototype scope:** file drops use the local folder adapter.
**Depends on:** M1.
**AC**
- Re-running any intake with the same file creates no duplicates (idempotent by content hash + natural key).
- Nothing is written to production tables before approval (test asserts zero production rows after intake).
- Every promoted value has lineage to file, sheet/row or page.
- Each validation rule has a passing and a failing test case.

## M3. Document Hub and AI Tagging
**Purpose:** find any document in seconds and feed extraction.
**Features**
- Document index over the document adapter (SharePoint in production) with metadata: sponsor, fund, company, period, doc type, confidentiality, hash, received date.
- AI classifier assigns metadata with a confidence score; below the threshold (`classifierConfidenceThreshold`) it goes to a review queue.
- Doc types (config): quarterly financials, quarterly letter, capital call, distribution notice, capital account statement, K-1, audited financials, CIM, management presentation, LPA, side letter, subscription docs, closing set, valuation support, AGM materials, other.
- Expected Document tracker per investment and period with aging and "missing" alerts.
- Full-text and semantic search, filtered by permissions.
- Duplicate detection by content hash.
**Prototype scope:** local folder adapter; synthetic PDFs from `tools/synthetic`.
**Depends on:** M1.
**AC**
- Classifier precision at least 95% on the labeled synthetic eval set for quarterly financials, capital calls and distribution notices before auto-tagging is enabled.
- No document is processed for extraction without an index row.
- A user cannot find, via search, a document attached to a record they cannot see (test).

## M4. AI Extraction Engine
**Purpose:** turn sponsor reports into reviewed data with citations.
**Features**
- Pipeline: document event, document worker (text, tables, page images), typed extraction call, deterministic validation, staging, review UI, approval, production.
- Schemas per doc type (Zod + Pydantic mirrors). Every number carries `value`, `unit`, `page`, `quote` (150 characters max) and `confidence`.
- Review-by-exception UI: page image beside fields, flagged fields first, accept / edit / reject, bulk-accept clean items.
- Batch runs with a status board (Received, Extracted, In review, Approved, Exported), concurrency limits, retries and cost logging.
- Variants: co-invest quarterly financials; primary fund reports and capital account statements; CIM / pitchbook to a draft Pipeline Opportunity.
- Commentary drafts from **approved** numbers only (`docs/07`).
**Prototype scope:** mock AI client returns fixture outputs; an optional real model on synthetic PDFs only.
**Depends on:** M2, M3.
**AC**
- Golden synthetic set: numeric field accuracy at least 98%, **0 unit errors, 0 values without a citation, 0 hallucinated values**.
- Schema-invalid model output is never written; it is retried once, then flagged.
- Injection test documents (instructions hidden in text) cause no behavior change (test).

## M5. Pipeline and Deal Management
**Purpose:** front-office record from first look to close.
**Features**
- Pipeline board and grid by stage (Sourced, Screening, Prescreen, Diligence, IC, Approved, Closing, Closed, Passed); stage history.
- Required pass reason code + note; searchable pass history.
- Allocation tracking: requested vs. received by vehicle and client.
- Fund-fit flag when the sponsor has no fund commitment from the firm.
- Deal Workspace with tabs per `docs/06`; one shared Reporting Period selector.
- Contact pickers limited to the deal's own sponsor contacts.
- Diagnostic views available only to admins on an admin route.
- AI summary and suggested next steps at the top of each deal (labeled AI draft).
**Prototype scope:** fully built.
**Depends on:** M1.
**AC**
- A deal moves Sourced to Closed with data captured once and converted into an Investment on close.
- Moving to Passed without a reason code fails (API test).
- Contact picker never returns another sponsor's contacts (test).

## M6. Relationship Intelligence
**Purpose:** relationship history that builds itself.
**Features**
- Capture from mail and calendar adapters: match participants to contacts by email, log Interactions, update counters, add an AI summary following the discretion rules in `docs/07`.
- Outlook add-in "Log to Portfolio Beach" for manual capture *(post-merge for real mailboxes)*.
- Relationship score (nightly, explainable): recency, frequency, reciprocity, breadth across team, seniority weights in config.
- Warm paths, cooling-contact alerts (interaction below the contact's normal pattern), Sponsor 360 page.
- Opt-in per user; users can view and remove their captured items.
**Prototype scope:** synthetic mailbox fixtures.
**Depends on:** M1.
**AC**
- No raw email body is persisted anywhere (schema test + log scan test).
- Same message processed twice creates one Interaction.
- Score components are shown and sum to the displayed score.

## M7. Diligence and IC Workflow
**Purpose:** diligence inside the deal, with gates.
**Features**
- Templates by deal type (co-invest, CV single-asset, CV multi-asset, primary) create tasks on entering Diligence.
- Tasks: owner, due date, status, evidence link, comments, reminders, required-for-IC flag.
- IC gate: cannot enter IC with open required tasks; an Approver can override with a reason (audited).
- Generators: prescreen deck (one pass from the record), IC memo sections, DDQ answers from an approved answer library, all labeled AI draft.
- IC Decision record; conditions become tasks.
- Background check requests (M23) appear as diligence tasks.
**Prototype scope:** fully built; generators use the mock AI client.
**Depends on:** M5.
**AC**
- The IC gate is enforced server side (API test bypassing the UI fails).

## M8. Closing Workflow
**Purpose:** controlled handoff from deal team to operations.
**Features**
- Closing record: close date (single source for every report), commitment by vehicle, securities, ownership %, documents.
- Required-document checklist (signed docs, cap table, funds flow, wire confirmation, consents).
- Operations confirmation; change of close date after confirmation needs a reason and re-confirmation.
- Monthly new-deal confirmation sent to deal teams for approval.
- Legal terms and allocation capture (M22).
**Prototype scope:** fully built; approvals in-app (Teams cards post-merge).
**Depends on:** M5, M19 (consents), M22.
**AC**
- Cannot complete closing with a required document missing.
- Every report reads the close date from the closing record only (test asserts no other close-date column exists).

## M9. Portfolio Monitoring
**Purpose:** the quarterly view of the whole portfolio.
**Features**
- Monitoring board: investment x quarter status with aging, fed by Expected Documents and extraction status.
- Metrics from `packages/calc` (`docs/08`): MOIC, IRR, TVPI, DPI, RVPI, entry vs. current EV/EBITDA, net debt/EBITDA, margin, YoY (exact fiscal quarter), growth since entry, holding period.
- Watchlist rules in config (leverage, EBITDA decline, markdown, covenant flags, missing financials); alerts to the deal team.
- Realization outlook (next 18 months, partial or full) changes **only** by explicit edit, audited.
- Primary fund monitoring: fund NAV, calls, distributions, unfunded, reported net metrics.
- Private credit monitoring: credit terms (facility, coupon split cash / PIK, floor, spread, OID, maturity, amortization, call protection, covenants); per period par, cost, fair value, accrued and PIK, cash interest received, principal repaid; current yield, yield to maturity, interest coverage, leverage through the tranche, LTV, DSCR (`docs/08` section 10); covenant and payment status; maturity ladder across the credit vehicle.
- Credit watchlist rules in config: coverage below covenant level, PIK toggle or deferred interest, LTV above threshold, maturity inside 12 months, payment status not current.
- Entry snapshot pinned by flag, never inferred from the earliest date.
**Prototype scope:** fully built.
**Depends on:** M1, M4.
**AC**
- Latest-period selection ignores forward-dated snapshots without approved data (test).
- Prior Year shows the missing placeholder when the exact quarter is absent (test).
- "Monitoring status for a quarter" export lists every active investment with its status.
- A credit position with EBITDA at or below zero shows the missing placeholder for coverage and leverage, never a number (test).

## M10. Valuation Workflow
**Purpose:** one controlled valuation per investment per period.
**Features**
- Valuation versions with the state machine in `docs/18` (Draft, Ops Prepared, Deal Team Approved, Locked, Reopened).
- Lock hash over inputs and value; any change after Locked creates a new version, reopens and alerts.
- Batch approval screen with filters and variance vs. prior.
- Reporting gate: reports read only Locked valuations.
- Open deal change requests (M11) shown on the valuation screen.
**Prototype scope:** fully built.
**Depends on:** M9.
**AC**
- A Locked valuation cannot be updated in place: database constraint + API test.
- Preparer cannot be final approver (segregation of duties test).

## M11. Deal Change Requests
**Features:** one form (add-on, new security, distribution treatment, recap, partial exit, other); routing to operations; status until applied; quarter-end list of unapplied changes.
**Depends on:** M9. **AC:** every request has an owner and an applied-in-period value before quarter close, or appears on the exceptions list.

## M12. Weekly Report and Live Dashboard
**Features:** generated weekly report (PDF + XLSX) from approved data: pipeline, schedule of investments by vehicle (credit vehicle shows par, fair value, yield and maturity), valuations, cash activity, subline section, movers; portfolio analysis page (sector, vintage, sponsor, average check size, deal type, concentration); snapshot archive of every issued report.
**Depends on:** M9, M10, M16. **AC:** every figure ties to the data snapshot at issue time (automated tie-out).

## M13. Analytics (Power BI and in-app)
**Features:** reporting schema (views) for Power BI with row-level security matching app roles; five report areas (Portfolio, Pipeline, Sponsor, Vehicle, Client); in-app charts for the same core views so the prototype does not need Power BI.
**Prototype scope:** in-app analytics + reporting views; PBIP project *(post-merge)*.
**Depends on:** M9. **AC:** reporting views return only rows the querying role may see (test).

## M14. Reporting Automation and Report QA
**Purpose:** repeatable client and internal reports without manual rebuilds.
**Features**
- `packages/report-engine`: templates (pptx, docx, xlsx) with bound tokens; "copy last period and update" from approved data.
- Layout locks: charts keep identical size and position; status markers and versioned visuals never move unless data changes; realization boxes change only through Report Overrides.
- Change log stored on the Reporting Package and shown in the UI, **never inside the output file**.
- Client configurations: per-vehicle documents, summary deck, multiple reporting bases per client.
- Mover commentary per `docs/07`.
- Request routing for ad hoc client and DDQ requests with templated drafts.
- **Report QA engine (release gate):** NAV roll-forward per position; QTD tables start from beginning-of-quarter values; prior-report tie-out with recorded explanations; sign sanity; movers recalculated after any correction (commentary against a superseded list is flagged); preliminary vs. final and gross vs. net labeling; per-vehicle data readiness; client-only fields validated separately.
**Depends on:** M10, M19.
**AC**
- Regenerating a package with unchanged data produces identical shape geometry (snapshot test).
- Any failed QA check blocks release unless an Approver overrides with a reason.

## M15. Shared Services and Assistants
**Features**
- Task and notification hub; login digest of missed items (deterministic filter, then AI classifier).
- Audit: history tables, `audit.event`, ODD evidence export.
- Exceptions dashboard; systems issue log.
- Cost tracking (cloud + AI tokens by module).
- Assistants: **Ask Portfolio Beach** (permission-aware read tools, cites records, respects walls), Market Intelligence (research library with dated citations), IRR workbook reviewer, email drafting from deal context.
**AC:** Ask Portfolio Beach never returns data from a record the user cannot open, including walled deals (test with walled seed records).

## M16. Capital Activity: Calls, Distributions and Funding
**Features**
- Notice intake (ILPA template aware): issue and due dates, amount, split (investment, fees, expenses, interest), cumulative figures, unfunded. Interest and principal payment notices on credit positions follow the same intake and create `interest` and `principal` cash flows; PIK capitalization notices update par only.
- Funding tracker per `docs/18` with alerts at T-3, T-1 and due date.
- Trade ticket generator; preparer and approver must differ.
- **Wire safety:** bank details only from the approved Wire Instruction register; extraction may flag "instructions present" but never fills bank fields; any change requires a callback to an independently sourced number by a second person.
- Cash Flow rows via staging and approval; unfunded reconciles across the notice sequence (equalization, recallables, late-close interest, expense true-ups).
**Depends on:** M1, M3. **AC:** a ticket cannot be released with an unverified or recently changed instruction (test); unfunded reconciliation test passes on synthetic notice sequences, including an equalization case.

## M17. Commitments, Primary Program and Portfolio Construction
**Features:** commitment record (target, hard cap, final size updates, close date, vehicle split); LP commitments to firm vehicles with closing number and ownership percentage after each close (equalization handled in M16); monthly new commitment report with approval; GP track record by vintage; fund terms; pacing plan and exposure targets (config); advisory seats; market reference data on peer programs.
**Depends on:** M1. **AC:** pacing view flags targets out of range from config; a vehicle whose LP ownership percentages do not sum to 100% after final close appears on the exceptions list.

## M18. GP Coverage, Annual Meetings and Notes
**Features:** coverage map with delegates and effective dates; AGM calendar with RSVP, attendees and travel-by date (config days); materials filed to the hub; AGM notes drafted as statements about the GP and portfolio (not a meeting recap) and approved by the attendee; weekly team meeting pack.
**Depends on:** M6. **AC:** a coverage change updates warm-path owners and notifies the coverage owner.

## M19. Client Compliance, Disclosures and Approved Statistics
**Features:** affiliated-party consent workflow that blocks closing until recorded; versioned disclosure library referenced by ID from templates; automatic stale-valuation footnotes; approved statistics register (value, as-of, source query, approver, expiry); distribution log.
**Depends on:** M8, M14. **AC:** a template cannot contain free-text disclosure (lint); an expired statistic cannot be used in a generated document.

## M20. Advanced Analytics
**Features:** look-through exposures at cost and NAV; benchmarking with quartiles and PME (Kaplan-Schoar, Direct Alpha); liquidity forecasting (Takahashi-Alexander with tunable parameters); value creation attribution (revenue, margin, multiple, leverage); exit analytics; credit analytics (maturity ladder, weighted average yield and spread, exposure by seniority and base rate, PIK share of income); manager diligence pack.
**Prototype scope:** synthetic benchmark and index series.
**Depends on:** M9, M16. **AC:** PME and attribution results match the worked examples in `docs/08`.

## M21. Data Access: Excel Add-in, API and Warehouse Feed
**Features:** read API (OpenAPI documented, permission-scoped, rate-limited); Excel add-in custom functions returning approved values with source links; daily governed extract for a data warehouse with reconciliation counts.
**Prototype scope:** API + add-in against the local stack; extract to files.
**Depends on:** M9. **AC:** the API returns 404 (not 403) for records the caller cannot see, so existence is not revealed.

## M22. Legal Terms and Allocation Tracker
**Features:** structured legal terms at closing (LPA and side letter provisions, MFN elections, consent and notice requirements, transfer restrictions, fee terms); AI-assisted extraction to review; allocation tie-out against commitments and closing.
**Depends on:** M8. **AC:** allocation totals must equal the closing commitment or closing cannot complete.

## M23. Background Check Workflow
**Features:** request, track and store background checks as diligence tasks; provider adapter (mock in prototype); results stored as Restricted with limited access.
**Depends on:** M7. **AC:** only roles entitled to Restricted personal data can open results (test).
