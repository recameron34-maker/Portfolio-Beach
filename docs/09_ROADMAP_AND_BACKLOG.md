# 09: Prototype Roadmap

Synthetic data and mock adapters throughout. Every phase ends with: all CI gates green, a recorded demo of the exit journey, and a `docs/SESSION_LOG.md` entry. Do not start a phase until the previous phase's exit criteria pass.

## Phase 0: Foundations
- [ ] P0-0 Tell IT and your manager about the repo; ask whether it can live in the employer's GitHub org now (`docs/16` section 1)
- [ ] P0-1 Repo settings (`docs/16` section 2); Claude Code cloud environment (restricted network, no secrets)
- [x] P0-2 Monorepo scaffold per `docs/02` and `docs/17` (scripts contract, TS strict, lint, formatting, Python tooling)
- [ ] P0-3 CI completed (`.github/workflows/ci.yml`), actions pinned to SHAs; `scripts/check-employer-data.sh` wired in. Workflow and guards are in place; SHA pinning needs `bash scripts/pin-actions.sh` on a signed-in machine (the sandbox cannot read other repositories)
- [x] P0-4 `packages/db`: migrations for `docs/03` core + audit + ops; in-process Postgres test harness; RLS baseline
- [x] P0-5 `tools/synthetic` small + default profiles with scenario tags (`docs/14`)
- [x] P0-6 `packages/calc` with every fixture in `docs/08` section 9 + property tests + Python cross-check
- [x] P0-7 `packages/adapters` interfaces + mocks; production startup guard against mocks (`docs/17` section 6)
- [x] P0-8 Web shell with theme, mock sign-in and role switcher; RLS matrix test generator
- [x] P0-9 Telemetry, health endpoints, feature flags and kill switches (structured content-free logs, health live and ready, flags with audited changes; OpenTelemetry traces and the synthetic canary are Phase 7 with Beach Ops)
- [x] P0-10 `packages/workflows` typed transition tables for every machine in `docs/18`, with allowed and forbidden transition tests (pulled forward from Phase 3 because API commands depend on them)
**Exit:** CI green; seeded DB loads; calc fixtures pass in both languages; RLS matrix passes for all roles on core tables; app refuses to start in production mode with mocks.
**Status (session 1):** every exit criterion is proven by tests in the repo; CI runs the same commands but the branch ruleset and SHA pinning (P0-1, P0-3) are owner actions still open.

## Phase 1: Data foundation and intake (M1, M2)
- [x] Entities, linking, aliases, match guards, taxonomy, Data Health and Data Dictionary pages (company aliases on record since migration 0010, matched exactly; the exceptions queue under Data; decision 0010)
- [x] Staging framework + validation library (target 100+ rules, each with pass/fail tests): the framework and the library are in place with 62 rules across three intakes (accounting 34, weekly values 15, look-through 13), each with a passing and a failing test and the exact set of findings asserted per case; the target counts every intake's rule set and grows with the document and report intakes of later phases
- [x] Accounting import/export (configurable layout), ops-drop parser (workbooks by template signature), weekly-report intake (valuation staging to Draft valuations), look-through reconcile (differences as data exceptions with an external ticket): decisions 0009 and 0010
**Exit:** journey: import a synthetic accounting export, see diffs, approve, promote; duplicate import is a no-op; near-miss names go to exceptions.
**Status (session 6):** every Phase 1 item is built on synthetic data and proven by tests: the exit journey and the three other intakes each have an API suite and a Playwright journey over the real API (`apps/web/e2e/{intake,weekly,lookthrough,ops-drop}.spec.ts`), walls hold on every intake (a walled position links and waits for a wall member), and the static preview simulates all four intakes and the exceptions queue. Open owner decisions are listed in `docs/SESSION_LOG.md`.

## Phase 2: Documents, extraction, monitoring (M3, M4, M9)
- [x] Document index on local adapter; classifier with review queue and evals; duplicate detection (the hub over the local folder store, `packages/pdf`, the keyword classifier under `ai.classifier`, the review queue, duplicates by content hash, the expected-document tracker; decision 0012)
- [x] Extraction pipeline with citations; review-by-exception UI; batch status board; injection tests (batches as jobs, runs through the docs/18 machine with retry and token budgets, ten validation rules, the review page with the page drawn beside the fields and the quote highlighted, approval promoting into `mon.quarterly_performance` with lineage; the injection document extracts its real figures in the API suite, the eval harness and journey 2)
- [x] Monitoring board, metrics, watchlist, realization outlook, primary fund view (the board under Portfolio with derived document status, run state, flags and approval and a CSV export; the audited outlook edit on the Performance tab; metrics and the watchlist from Phase 0 and session 3; watchlist alert dispatch and primary fund report extraction stay open, docs/11 E4 and E7)
**Exit:** critical journey 2 (`docs/12`) passes; eval thresholds in M4 met with the mock and recorded fixtures.
**Status (session 7):** journey 2 passes over the real API (`apps/web/e2e/journey2.spec.ts`: index, generate, batch, review flagged values, approve and promote, the one-pager shows the figure with its source link); `pnpm test:evals` builds the gold set from the synthetic documents and asserts the docs/04 thresholds (classifier precision 1.0 per type, numeric accuracy 1.0, no unit errors, no missing citations, no hallucinations, the injection probe changes nothing). OCR, semantic search and a real model stay out of the prototype (decision 0012).

## Phase 3: Controls (M10, M11, M8, M16, M22)
- [ ] Valuation state machine, lock hash, batch approval, reporting gate
- [ ] Deal change requests; closing checklist; legal terms and allocation tie-out
- [ ] Capital notices, funding workflow, trade tickets, wire register with callback and dual control
**Exit:** critical journeys 3, 4 and 6 pass; every forbidden transition in `docs/18` has a passing rejection test.

## Phase 4: Reporting (M12, M14, M19, M13)
- [ ] Report QA engine first; then template engine with layout locks and external change log
- [ ] Weekly report, client packages, mover commentary, disclosure library, approved statistics, distribution log
- [ ] Reporting views for analytics with RLS; in-app analytics
**Exit:** critical journey 5 passes; layout snapshot tests stable; QA catches every reporting scenario tag in `docs/14`.

## Phase 5: Front office (M5, M6, M7, M17, M18, M23)
- [ ] Pipeline board, pass log, allocations, fund-fit flag
- [ ] Diligence templates, IC gate, IC decisions, generators; background check workflow (mock provider)
- [ ] Relationship capture on mail fixtures, scores, warm paths, cooling alerts, Sponsor 360
- [ ] Commitments, track record, pacing, advisory seats; coverage map, AGM calendar and notes, weekly pack
**Exit:** journey 6 passes end to end with diligence and closing; no raw email body persisted (scan test).

## Phase 6: Analytics, access and assistants (M20, M21, M15)
- [ ] Exposures, benchmarking (KS-PME, Direct Alpha), liquidity forecast, attribution, exit analytics
- [ ] Read API (OpenAPI), Excel add-in prototype, warehouse extract to files
- [ ] Ask Portfolio Beach with permission-aware tools; Market Intelligence on a synthetic research library; missed-items digest
**Exit:** journey 7 passes (no leakage of walled data); analytics match `docs/08` worked examples.

## Phase 7: Beach Ops on the prototype (`docs/15`)
- [ ] Runbook library with tests; Sentinel, Data Flow Monitor and Integration Health at L0/L1 against the local stack
- [ ] Patch Pilot, Shield and Scribe as CI workflows producing PRs only
**Exit:** synthetic incident replays produce correct diagnoses; no agent action outside its allowed level (test).

## Phase 8: Merge readiness (`docs/10` section 4)
- [ ] Self-assessment against every SEC ID in `docs/05`; open gaps listed
- [ ] SBOM, license report, dependency audit, pen-test scope document
- [ ] Demo package and walkthrough on synthetic data
- [ ] Transfer approvals, then repo transfer into the employer's GitHub org; employer configuration starts there
