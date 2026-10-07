# 09: Prototype Roadmap

Synthetic data and mock adapters throughout. Every phase ends with: all CI gates green, a recorded demo of the exit journey, and a `docs/SESSION_LOG.md` entry. Do not start a phase until the previous phase's exit criteria pass.

## Phase 0: Foundations
- [ ] P0-0 Tell IT and your manager about the repo; ask whether it can live in the employer's GitHub org now (`docs/16` section 1)
- [ ] P0-1 Repo settings (`docs/16` section 2); Claude Code cloud environment (restricted network, no secrets)
- [ ] P0-2 Monorepo scaffold per `docs/02` and `docs/17` (scripts contract, TS strict, lint, formatting, Python tooling)
- [ ] P0-3 CI completed (`.github/workflows/ci.yml`), actions pinned to SHAs; `scripts/check-employer-data.sh` wired in
- [ ] P0-4 `packages/db`: migrations for `docs/03` core + audit + ops; in-process Postgres test harness; RLS baseline
- [ ] P0-5 `tools/synthetic` small + default profiles with scenario tags (`docs/14`)
- [ ] P0-6 `packages/calc` with every fixture in `docs/08` section 9 + property tests + Python cross-check
- [ ] P0-7 `packages/adapters` interfaces + mocks; production startup guard against mocks (`docs/17` section 6)
- [ ] P0-8 Web shell with theme, mock sign-in and role switcher; RLS matrix test generator
- [ ] P0-9 Telemetry, health endpoints, feature flags and kill switches
**Exit:** CI green; seeded DB loads; calc fixtures pass in both languages; RLS matrix passes for all roles on core tables; app refuses to start in production mode with mocks.

## Phase 1: Data foundation and intake (M1, M2)
- [ ] Entities, linking, aliases, match guards, taxonomy, Data Health and Data Dictionary pages
- [ ] Staging framework + validation library (target 100+ rules, each with pass/fail tests)
- [ ] Accounting import/export (configurable layout), ops-drop parser, weekly-report intake, look-through reconcile
**Exit:** journey: import a synthetic accounting export, see diffs, approve, promote; duplicate import is a no-op; near-miss names go to exceptions.

## Phase 2: Documents, extraction, monitoring (M3, M4, M9)
- [ ] Document index on local adapter; classifier with review queue and evals; duplicate detection
- [ ] Extraction pipeline with citations; review-by-exception UI; batch status board; injection tests
- [ ] Monitoring board, metrics, watchlist, realization outlook, primary fund view
**Exit:** critical journey 2 (`docs/12`) passes; eval thresholds in M4 met with the mock and recorded fixtures.

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
