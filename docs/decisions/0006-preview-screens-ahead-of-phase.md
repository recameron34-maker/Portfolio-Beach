# 0006: Read-mostly preview screens built ahead of their phase
- **Status:** Accepted for the prototype
- **Date:** 2026-10-08
- **Deciders:** repo owner (requested a preview with as much capability as possible for the approval decision)
## Context
`docs/09` sequences the modules into phases and says not to start a phase until the previous one passes its exit criteria. The owner needs a static preview that shows the product's reach to the people who will approve it, before Phase 1 and 2 are complete. The synthetic dataset already carries vehicles, clients, commitments, valuations, capital notices, credit terms and walls, so most Phase 3 to 6 screens can be shown as read views on real API responses without new tables.
## Options considered
1. Keep the preview at the Phase 0 scope. Honest to the sequence, but it shows one grid and one page and does not demonstrate workflows, analytics, client look-through or capital activity.
2. Build the later screens with their own tables and write paths now. Pulls Phase 3 to 6 schema and approval design forward without the exit criteria behind it.
3. Build read-mostly screens on the existing schema, computed server side under row-level security, and simulate the write workflows in the browser through the `packages/workflows` transition tables, labelled as simulated. Chosen.
## Decision
- New read endpoints (analytics summary, watchlist, weekly report, vehicle detail, commitments, clients, sponsor 360, valuation board, capital notices, performance series, audit events, taxonomy, walls) are real: they run under RLS, audit sensitive reads and are tested like every other endpoint. They add no tables and no migrations.
- Write routes the preview demonstrates (valuation lifecycle, capital notice lifecycle, preview reset) live in `packages/contracts/src/simulated.ts` as `SIMULATED_ROUTES`, separate from `ROUTES`. The API does not implement them until Phase 3 adds staging and human approval (`docs/18`); the static preview simulates them in the browser with the same transition tables, rejects forbidden transitions exactly as the API will, and labels every simulated action "simulated in this preview, not saved, not audited".
- `docs/11` statuses stay at P for every capability shown this way until the module's acceptance criteria tests exist; a preview screen is not a built capability.
- Pipeline, documents, change requests, reporting packages, coverage and disclosures need tables that do not exist yet; they stay as phase pages that say what will appear and when. Where the module's workflow is already in `packages/workflows` (deal stages, document classification, extraction runs), the phase page also shows that transition table, states, steps, roles and rules, read from the code (`components/WorkflowSpec.tsx`): the specification is built and tested, the screens are not.
## Consequences (security, cost, operations, migration)
Security: no new access path; every read is 404 for records the caller cannot see. Simulated state lives in page memory only and never reaches storage or the network. Cost: none. Operations: the recorder enumerates every request the screens can issue for every mock user, so the preview is reproducible byte for byte. Migration: when Phase 3 implements the write routes, the simulated route table becomes the contract and the shim's handlers are deleted.
## SEC IDs affected
SEC-5.1 (RLS on every new read), SEC-11.1 (audited sensitive reads), SEC-17.3 (reviewed like any change)
## Verification
`apps/api/src/test/*.test.ts` per module (role visibility, walls, 404s, audit rows); `apps/web/scripts/probe-preview.mjs` walks the preview including the simulated journeys; the module statuses in `docs/11` were re-checked against this record.
