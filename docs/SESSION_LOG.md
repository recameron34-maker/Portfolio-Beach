# Session Log (append newest at bottom)

## Baseline
- Prototype pack created. Synthetic data only, mock adapters, no employer information.
- Repo: private, on a GitHub account registered to the owner's work email, outside the employer's GitHub organization. Planned move into the employer's organization before any employer data or configuration (docs/10 section 4).
- Improvement pass: rebuilt docs/03 and docs/04 (acceptance criteria, prototype scope, dependencies); added docs/08 (calculations), 12 (testing), 14 (synthetic data), 17 (engineering standards), 18 (state machines); roadmap with exit criteria covering all modules; working employer-data checker + pre-push hook; CI with guard, RLS, workflow, e2e and license gates; tighter Claude permissions; decision records; review, bugfix and session-close prompts; repo hygiene files.

## Session 1 (2026-10-07): pack landed, guide extended, Phase 0 built
**Branch:** `claude/gifted-tesla-eg7s85`. Synthetic data only; no employer information anywhere.

**What changed**
- Unpacked the prototype pack into the repo structure; the single-file guide is now generated on demand by `scripts/bundle-guide.sh` so it cannot drift from `docs/`.
- Guide improvements: removed the duplicated doc map in `CLAUDE.md` and redaction leftovers; added private credit as a first-class deal type (`docs/01`, `03`, `04`, `06`, `08` section 10, `11`, `14`); split commitments into vehicle-to-fund and client-to-vehicle (LP) with ownership-based look-through (decision 0004); added `packages/adapters` and `packages/workflows` to the layout; P0-10 for workflow tables; decision records 0003 (sandbox facts), 0004 (scope), 0005 (toolchain).
- Monorepo scaffold with the docs/17 scripts contract, strict TypeScript project references, ESLint 10 with domain rules, Prettier, Vitest projects, house-style and employer-data guards, CI workflow, SHA-pinning helper.
- `packages/calc`: docs/08 on exact decimals with 17 golden fixtures, property tests and an independent Python implementation (`apps/worker-py/calc_check`) that runs the same fixtures and a seeded 1,500-case cross-check (0 mismatches).
- `packages/db`: six SQL migrations (core with LP commitments and credit tables, audit, ops, mon, stg, history and RLS), hash-checked migrator, Drizzle mirror with drift test, per-transaction user context, 566-column classification registry with a CI gate, generated RLS access matrix (positive and negative cells), database guards (lock immutability, segregation of duties, append-only audit, history triggers, sign constraints).
- `tools/synthetic`: deterministic generator (small and default profiles) with 18 data-level scenario tags, verify step, seed loader.
- `packages/adapters`: interfaces, resilience wrapper (timeout, idempotent retry with jitter, circuit breaker, kill switch), mocks, production guard.
- `packages/workflows`: the eight docs/18 state machines with 147 generated tests including every forbidden pair.
- `packages/contracts` and `apps/api`: zod contracts, route table and OpenAPI builder; NestJS API with identity to RLS context, problem details, content-free logging with redaction, health, audited flags, portfolio grid and one-pager reads with calc metrics, sponsors, vehicles, Data Health, Data Dictionary (23 e2e tests over a seeded in-memory database).
- `apps/web`: theme from `config/brand.json`, mock sign-in and role switcher, navigation groups, portfolio grid, one-pager (equity and credit), Data Health, Data Dictionary, admin flags; Playwright journey 1 and axe-core WCAG checks.

**Verified (command output summarized)**
- `pnpm typecheck` clean across 8 projects; `pnpm lint` clean; `pnpm check:style` and `pnpm check:employer-data` OK.
- `pnpm test`: 16 files, 509 tests passing (calc 46, db 259, synthetic 7, adapters 16, workflows 147, contracts 4, api 23, web 7).
- `pnpm test:calc`: Python 22 tests passing; cross-check 1,500 cases, 0 mismatches.
- `pnpm check:classification`: 566 columns classified.
- `pnpm test:e2e`: 7 Playwright tests passing (journey 1 plus accessibility on sign-in, home, portfolio and one-pager).
- CLI journeys: `pnpm synth` (default profile: 200 investments, 8,085 rows) -> `pnpm synth:verify` OK -> `pnpm db:seed:synthetic` loads; `pnpm db:migrate` idempotent; `pnpm db:reset`; `pnpm openapi:generate` (12 paths).

**Open items for the owner**
- P0-0 and P0-1: tell IT and your manager about the repo; apply the branch ruleset and repo settings (docs/16 section 2); run `bash scripts/pin-actions.sh` on a signed-in machine to pin actions to SHAs, then enable required status checks.
- Create `config/local/denylist.txt` on your machine and run `bash scripts/install-hooks.sh`.
- Review decision 0004 (private credit and the two-layer commitment model) and the RLS matrix in `packages/db/src/rls/matrix.ts`; both encode judgment calls about who sees what.
- Decide whether Data Health should be visible to viewers (today every authenticated role can read the counts; the counts respect that role's visibility).

**Next step**
Phase 1 (M1, M2): linking services with match guards, the staging framework and validation rule library (100+ rules), accounting import and export, ops-drop parser, weekly report intake, look-through reconcile. Start with `prompts/01_PHASE_TEMPLATE.md` and one issue per item.

## Session 2 (2026-10-07): fix PR and static preview
**Branch:** `claude/gifted-tesla-eg7s85`, PR #7 against `main`. Synthetic data only; no employer information anywhere.

**What changed**
- `main` failed `pnpm typecheck` after PR #1: the pack's `.gitignore` rule `data/` hid `apps/api/src/data/data.controller.ts`, so it was never committed. The rule is now root-anchored (`/data/`) and the controller is in. The branch also keeps the Map-based `buildOpenApi` (no computed object keys from route strings).
- Static preview of the Phase 0 web app for review without a server: `apps/web/scripts/build-preview.mjs` records every API response the screens can request from the real API over the small synthetic profile (seed 42) for each mock user, then bundles the app with `VITE_PB_PREVIEW=true`; `src/preview/shim.ts` answers `/api` and `/health` from the recordings and simulates flag changes in memory; the router uses hash history in that mode. `scripts/probe-preview.mjs` walks journey 1 against the built bundle. The preview is a static bundle, not a deployment (docs/16 section 5): no server, no credentials, no employer systems.

**Verified (command output summarized)**
- Clean-worktree run of the fix: `pnpm typecheck` and `pnpm lint` clean; `pnpm test` 16 files, 509 tests; cross-check 0 mismatches; classification 566 columns; house-style and employer-data guards OK.
- Preview: 410 responses recorded for 11 users; `probe:preview` 13 checks passing (anonymous redirect, viewer without the walled deal and 404 on its one-pager, wall member with it, credit one-pager, Data Health, Data Dictionary, simulated flag change as platform admin, no page errors); shim unit tests 5 passing.

**Open items for the owner**
- Merge PR #7 to make `main` green again; the earlier owner items (rulesets, SHA pinning, Dependency graph for dependency review, local deny-list) still stand.
