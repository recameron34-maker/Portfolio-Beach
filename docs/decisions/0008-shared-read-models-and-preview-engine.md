# 0008: Shared read models for the aggregate views, and the plan-driven preview engine
- **Status:** Accepted for the prototype
- **Date:** 2026-10-08
- **Deciders:** repo owner (asked for a preview with as much capability as possible); built in Claude Code
## Context
Decision 0006 added read-mostly screens ahead of their phase. Building them in parallel produced fourteen new GET endpoints and about forty pages, and several builders reached for the same helpers at the same time: commitment rows, NAV series, notice rows, config readers, cursors, state words, number cells and the "not available" card. CLAUDE.md rule 7 forbids two components doing one job, so each of these needed one home before the next phase builds on them. The static preview also outgrew its first recorder: it recorded 410 responses by hand-listed loops and simulated one write.
## Options considered
1. Leave each module with its own helpers and reconcile later. Fast now, but the copies had already drifted (one commitment loader reported 0 where the other reported null; one NAV series folded shifted period ends to the quarter and one did not).
2. One shared module per job, named below, and every caller moved to it. Chosen.
3. A generic query layer for all aggregates. More than the prototype needs.
## Decision
API (apps/api/src):
- `portfolio/loaders.ts` loads investment rows, flows and valuations in batches and summarizes positions; every aggregate starts from it.
- `portfolio/metrics.ts` holds the pooled metrics and the one NAV series rule: Locked marks only, each folded to its calendar quarter end when it lies within `priorYearPeriodEndToleranceDays` of it (a sponsor that reports a few days early lands on the quarter), a mark whose quarter end falls after the as-of date keeps its own date, and the latest mark of a position wins on a shared point.
- `portfolio/commitments.ts` is the one commitment loader for the vehicle detail, the commitments board and the sponsor 360. A commitment with no approved flow on or before the as-of date reports null for called, distributed, recallable and unfunded, never 0.
- `capital/notices.ts` builds capital notice rows for the notices endpoints and the weekly report.
- `common/definitions.ts` reads config/definitions.json strictly: a missing or malformed key is a 500 'configuration' problem that names the key, never a silent default in code (rules 9 and 10). `common/cursor.ts` encodes and checks composite cursors.
- Sensitive reads are audited with an action per read (for example `vehicle.read` when client commitments are returned, `client.read`, `capital_notice.read`, `investment.performance.read`); hidden records are 404, never 403.
Web (apps/web/src):
- Workflow state words, tones and the commands a role may issue come from `lib/states.ts` over the `@pb/workflows` tables; every write goes through `app/mutations.ts`, and every refusal is worded by `describeActionError` from its problem status (403 role, 409 transition, 412 stale row, 422 precondition).
- Taxonomy labels come from `GET /api/v1/taxonomy`, loaded once by the shell (`app/useTaxonomyLabels.ts`) before a page renders, so a code reads the same everywhere ("SOFR", "Financial services"); `labelOf` falls back to a label generated from the code only when the taxonomy cannot load.
- 403 and 501 reads degrade through one `UnavailableState`; numeric cells use one `NumCell`.
Preview (apps/web/src/preview, apps/web/scripts):
- `preview-plan.mjs` declares every request family from the dataset; the recorder plays each for all eleven mock users so the API's own guards decide 200, 403 or 404, and stores each distinct body once under a content hash. A test runs every query builder and fails when the plan misses one; the probe visits every route for six users and fails on any unrecorded request.
- Simulated writes (valuation lifecycle, capital notice lifecycle, flags, reset) run the `@pb/workflows` transition tables in the browser and map refusals through `WORKFLOW_REFUSALS` in `packages/contracts/src/simulated.ts`, the mapping the Phase 3 API controller will reuse. State lives in page memory for the session, shared across role switches, never in storage; metrics are never recomputed after a simulated change; every simulated response carries `x-pb-simulated: true` and the pages label it.
## Consequences (security, cost, operations, migration)
Security: no new access path; every read runs under row-level security and the recorder captures each user's real answers, so walls and client entitlements hold in the preview too. The production bundle is checked for simulation code on every preview build. Cost: none. Operations: preview builds are reproducible byte for byte (realization outlook `setAt` is seeded, audit rows are recorded first). Migration: when Phase 3 implements the write routes, the simulated route table is the contract and the shim's handlers are deleted.
## SEC IDs affected
SEC-5.1 and SEC-5.4 (row-level security and client entitlement on every new read), SEC-11.1 and SEC-11.4 (audited reads; the audit view shows no business values), SEC-12.1 to SEC-12.3 (the simulated capital controls refuse approval by the drafter and with an unverified or recently changed wire)
## Verification
Per-module API tests (role visibility, walls, 404s, audit rows, config errors); the preview unit tests over both transition tables (every forbidden pair 409, role refusals 403, preconditions 422); `pnpm --filter @pb/web probe:preview` (every route for six users with no recording miss, and the valuation and capital notice journeys end to end); response dumps diffed before and after each refactor.
