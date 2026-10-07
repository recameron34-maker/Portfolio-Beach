# 12: Testing and Quality

## 1. Test layers
| Layer | Tool | What it proves | Runs in |
|---|---|---|---|
| Unit | Vitest, pytest | Functions and components behave | Session + CI |
| Calc golden + property | Vitest + fast-check, Hypothesis; Python cross-check | Financial math is exact and consistent across two implementations | Session + CI |
| Database | Vitest on in-process Postgres (PGlite or embedded) | Migrations apply, constraints and RLS work | Session + CI |
| **Security / RLS matrix** | Generated tests: every role x every table x read/write | Positive **and negative** access, walls, client entitlements | Session + CI |
| API contract | OpenAPI schema tests; Zod round-trips | Contracts match between web, API and add-ins | CI |
| Workflow | Temporal test environment or Durable Functions emulator | State machines in `docs/18` (every allowed and forbidden transition) | Session + CI |
| AI evals | Eval harness with mock and recorded fixtures | Accuracy, citations, no hallucinated values, injection resistance, style rules | Mock in CI; real model on synthetic data optional |
| End to end | Playwright | Critical journeys (section 3) | CI |
| Accessibility | axe-core in Playwright | WCAG 2.1 AA, zero critical issues | CI |
| Report snapshots | Shape geometry and token-fill snapshots for pptx/docx/xlsx | Layouts never move between runs | CI |
| Performance | k6 or autocannon on seeded data | Budgets in `docs/17` | Nightly |
| Mutation (calc, validation, auth) | Stryker | Tests actually catch defects (score at least 80%) | Weekly |

## 2. Coverage targets
- `packages/calc`, `packages/validation`, auth and RLS policies: **100% branch coverage**.
- Other packages: 85% lines. Coverage is a floor, not a goal; mutation score matters more for critical code.

## 3. Critical journeys (e2e, all on synthetic data)
1. Sign in as each role (mock identity) and see only permitted records, including a walled deal hidden from non-members.
2. Drop a synthetic quarterly report, extract, review flagged fields, approve, see the one-pager update with citations.
3. Prepare, approve and lock a valuation; attempt an edit after lock (new version created, approver alerted).
4. Receive a capital call, draft a trade ticket, try to release with a changed wire instruction (blocked), complete callback, release.
5. Generate a client package, fail a QA check, fix data, regenerate with identical layout, release.
6. Move a deal from Sourced to Closed, with diligence gate and closing checklist.
7. Ask Portfolio Beach a question about a walled deal as a non-member (no leakage).

## 4. Rules
- Tests use only synthetic data from `tools/synthetic` (deterministic seed).
- No network in unit or integration tests. AI calls use the mock client or recorded fixtures.
- Flaky tests are quarantined within 24 hours with an issue, never ignored.
- Every bug fix adds a regression test that fails before the fix.
- Time is injected (a clock interface), never read directly, so date logic is testable.

## 5. CI gates (required to merge)
typecheck, lint, unit, db + RLS matrix, calc golden + property + Python cross-check, workflow tests, mock evals, style check (em dash, banned phrases, employer-data patterns), CodeQL, dependency review, secret scan. E2E, accessibility and report snapshots are required on PRs that touch the web app or report engine.
