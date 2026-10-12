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

## Session 2 (2026-10-07): fix PR, CI fixes and static preview

**Branch:** `claude/gifted-tesla-eg7s85`, PR #7 against `main`. Synthetic data only; no employer information anywhere.

**What changed**

- `main` failed `pnpm typecheck` after PR #1: the pack's `.gitignore` rule `data/` hid `apps/api/src/data/data.controller.ts`, so it was never committed. The rule is now root-anchored (`/data/`) and the controller is in. The branch also keeps the Map-based `buildOpenApi` (no computed object keys from route strings).
- e2e CI job: Playwright installs through the web package (the root has no Playwright, so `pnpm exec playwright` failed); the Vite dev server binds 127.0.0.1 explicitly, because Playwright polls 127.0.0.1 and on GitHub runners `localhost` resolves to `::1` first, which timed out the web server wait; in CI the servers' stdout stays in the job log.
- Static preview of the Phase 0 web app for review without a server: `apps/web/scripts/build-preview.mjs` records every API response the screens can request from the real API over the small synthetic profile (seed 42) for each mock user (request ids pinned so the recordings are byte-stable), then bundles the app with `VITE_PB_PREVIEW=true`, no source maps, asset tags from Vite's manifest, and runs the employer-data guard over the output (`check-employer-data.sh --paths`, new). `src/preview/shim.ts` answers `/api` and `/health` from the recordings and simulates flag changes in memory (the admin page says "simulated in this preview, not audited"); the router uses hash history in that mode; a failed recordings load shows a message instead of a blank page. `scripts/probe-preview.mjs` walks journey 1 against the bundle through a path-confined loopback server. CodeQL's findings on the first version of these scripts (HTML regex, path from request URL) are fixed.
- `src/app/session.ts` keeps an in-memory copy of the mock credential for the page session when storage is blocked (sandboxed frames), with a test.
- The preview is a static bundle, not a deployment: docs/16 section 5 rules out cloud deployment from the prototype and routes hosted demos through IT; the repo only adds the build. Where a bundle may be shared is the owner's call.

**Verified (command output summarized)**

- `pnpm typecheck` and `pnpm lint` clean; `pnpm test` 18 files, 516 tests (web 5 files, 14 tests, including the shim and session tests); cross-check 0 mismatches; classification 566 columns; house-style and employer-data guards OK; `pnpm test:e2e` 7 passing locally and in CI.
- Preview: 410 responses recorded for 11 users; guard over the output OK; `probe:preview` 17 checks passing (3 path-traversal requests served the shell, anonymous redirect, viewer without the walled deal and 404 on its one-pager, wall member with it, credit one-pager, Data Health, Data Dictionary, simulated flag change as platform admin, no page errors, message when the recordings cannot load). Independent review workflow (five lenses, adversarial verification): no blockers; its confirmed items are in this entry.

**Open items for the owner**

- Merge PR #7 to make `main` green again. The `security` job's dependency-review step fails until Dependency graph is enabled in the repository settings (Code security and analysis); CodeQL itself passes.
- The earlier owner items (rulesets, SHA pinning, local deny-list) still stand.
- Follow-up suggested: treat a 401 from `/api/v1/auth/me` as signed out (clear the credential, return to the picker); today a stale credential strands the user on an error card.

## Session 3 (2026-10-08): modern UI, the full read surface and an interactive preview

**Branch:** `claude/gifted-tesla-eg7s85` on top of merged PR #7 (`96c6e1c`); no PR opened this round. Synthetic data only; no employer information anywhere.

**What changed**

- Design: a new design system (decision 0007, UI tokens derived from `config/brand.json`), icon navigation, and a sign-in page over a gently animated beach scene that stops under reduced motion. Shared pieces: stat tiles with a sparkline, one focusable frame for every table, numeric cells that mute the missing-value placeholder, plain-language unavailable states, an SVG chart kit with a validated palette and a table behind every chart. Tile rows fill evenly at every width (`lib/tiles.ts`), paired cards stack below 440px each, tab bars wrap rather than hide, and roles read as words ("Blake Mbeki (deal team)").
- API read surface (all through `DbService.run`, so row-level security applies): analytics (exposure, performance, credit book, realizations, clients), the weekly report with late-mark footnotes, audit trail, taxonomy, walls, vehicles, the sponsor 360, the valuation board in quarters, capital notices (register, commitments, notice detail with lineage). Shared read models instead of copies: one commitment loader, one NAV series rule, one notice row builder, strict config readers in one module. Pooled metrics answer null, never 0, for an empty set; impossible calendar dates answer 400.
- `packages/calc`: `valueChange` (the one mark-to-mark change ratio), quarter alignment (`latestQuarterEndOnOrBefore`, `alignedQuarterEnd`) and `lockedNear`, shared by the API and the preview.
- Web pages: Home (tiles, attention list, capital activity, exposure, NAV trend, Data Health, start here), watchlist, vehicles and vehicle detail, the deal workspace tabs, sponsors and the sponsor 360, the valuation board with New valuation and workflow actions, capital activity (paged register, commitments, notice detail with the wire change ticket), the weekly report (printable), client and disclosure views, five analytics tabs, a mock Ask Portfolio Beach, admin (flags, audit, access, health), Data Health, Data Dictionary and Taxonomy. Tabs whose module is a later phase say so plainly (decision 0006).
- Preview engine (decision 0008): plan-driven recordings for all 11 mock users with miss detection; simulated workflow writes run through `@pb/workflows` with the same refusals as the API (segregation of duties, the wire change ticket rule), Idempotency-Key and If-Match, and overlays on every read a write changes; a Reset preview button; a preview guide with five walkthroughs on sign-in and Home. The static preview demonstrates access control from per-user recordings; it does not enforce it.
- Docs: decisions 0006, 0007 and 0008; docs/11 statuses moved for C2, C4, C5, D1, D3, D8, E5 to E9, E11, E13, F1, F2, F12, G3, H3, H8, I3 and I14, each naming what is still pending; the root and web READMEs describe the pages, the shared pieces and the preview's limits.

**Verified (command output summarized)**

- `pnpm typecheck`, `pnpm lint` (eslint and prettier), `pnpm check:style` (476 files) and `pnpm check:employer-data` (477 files): all pass.
- `pnpm test`: 1065 tests in 85 files pass across the api, calc, contracts, synthetic, web and workflows projects.
- `pnpm test:e2e`: 25 Playwright journeys pass against the local stack (10.7 minutes; the a11y spec is the slow one).
- Preview: `build:preview` recorded 3897 request keys (386 distinct bodies) for 11 users, fixtures.json 2.05 MB, reproducibly; `probe:preview` 47 passed, 0 failed, no recording misses, no page errors; the scripted UI journey (valuation lifecycle through four roles, capital notice ticket refusals SEC-12.2 and SEC-12.3, reset) 11 PASS; screenshots at 1280, 1024 and 390 for seven routes show no page overflow; the layout audit at the three widths reports only tables scrolling inside their own frames (tab strips now wrap at phone width instead of scrolling off the edge).
- Review round: an adversarial review workflow kept 35 findings; every one is fixed (commits `7aa967b` to the close-out), the refuted ones recorded in the session transcript. Highlights: one NAV series rule per quarter end with the generator carrying a position at cost until its first sponsor mark; MOIC and IRR never invented from a missing NAV; as-of status derived from entry and exit dates; capital notices settled in their own terms; control characters, year 0 and oversized ids refused at the boundary; the audit cursor on (at, id); new valuation versions offered only where the quarter is open; counts never taken from a partial page; prior-year figures on the one-pager; client totals never partial; the grid sorting numbers; the holding period computed once in the API; a user switch that fetched nothing new (caught by the preview probe during close-out).

**Open items for the owner**

- Valuation policy to confirm: the synthetic generator now books a Locked cost mark at the entry quarter end of a position whose first sponsor mark comes later (carry at cost), and the NAV series shows a quarter as not calculable while any held position has no Locked mark for it or an earlier one. If the firm's policy differs (for example no mark until the sponsor reports), the generator rule in `tools/synthetic` and docs/14 change, not the API rule.
- Client look-through totals are not calculable while any vehicle share is not; today the primary program has no pooled figures (G8 look-through pending), so clients holding it show the placeholder with the reason. Say if a labelled partial total is preferred.
- Audit trail cursors changed shape (event time and id); a cursor saved from an earlier build answers 400. Cursors are opaque and not meant to be stored, so no migration.
- Size: this branch is 90 commits and about 36,000 changed lines, far above the roughly 800-line review target (CLAUDE.md section 3b). Decide how to land it: split by area (calc and contracts; API read models; web shell and design system; pages by module; preview engine) or review it as one with the commit history as the guide.
- `apps/api/src/data/data.controller.ts` cannot be read in these sessions, because the repo's `Read(./data/**)` deny rule also matches `apps/api/src/data/`. Observed through the API: `?asOf=2025-02-30` answers 500, a malformed `asOf` silently becomes today, and the stale threshold falls back to 75 days when config is missing. The fix is `parseOrProblem` for `asOf` and `configInteger` for `watchlist.missingFinancialsDays`; either narrow the deny rule to the root `data/` folder or make the change by hand.
- The preview's entry script is about 2.1 MB (600 kB compressed); splitting routes into chunks would halve first load.
- The earlier owner items still stand: rulesets and SHA pinning, the local deny-list, and Dependency graph for the dependency-review step.
- Where the preview link may be shared is your call; it stays private until you share it.

**Next step**
Phase 1 (M1, M2) as planned in Session 1, now with every read screen in place to receive real workflows: staging and approval for valuations and capital notices (the preview's simulated writes become API writes), then the linking services and the validation rule library.

## Session 4 (2026-10-12): API intake module for the accounting import (docs/04 M2)

**Branch:** the worktree branch for the intake API, on top of the intake foundation commit (`55a10e4`: packages/validation, the layout config, the synthetic accounting export, the intake contract). Synthetic data only; no employer information anywhere.

**What changed**

- `apps/api/src/intake`: the five contract routes under `/api/v1/intake`. POST import reads an upload or a drop-folder export by id, refuses a file over `definitions.intake.maxFileBytes`, hashes the text (SHA-256) and answers the file staged before with `duplicate: true` when the content was seen (idempotent by content). Otherwise, in one transaction: the file is read against `config/accounting_layout.json` (a file the layout refuses holds no rows and keeps its file-level findings), every row is linked by number then exact name with the match guards (docs/03 section 5), diffed against the approved quarter for its aligned quarter end, run through `ACCOUNTING_RULES` with the thresholds from `definitions.intake`, `priorYearPeriodEndToleranceDays` and `unitSanityBoundsUsd` (strict readers, no defaults), and staged in `stg.intake_row` with its payload, diff and findings. Unresolved names and fair values that do not tie open `ops.data_exception` rows (`exception_severity.high`, the taxonomy code the table requires). One `intake.import` audit event carries counts only.
- Reads: the file list newest first with a cursor on (received_at, id) and a status filter; the detail with rows in file order, where rows linked to an investment the caller cannot open (a walled deal for a non-member) are left out and counted in `hiddenRows` (added to `intakeFileDetail` in the contract); each detail open is audited as `intake_file.read` with no values.
- Commands: approve runs `validated > approved` (the caller, through `stagingMachine`) and `approved > promoted` (the service) per row in the same transaction; promotion upserts `mon.quarterly_performance` with the four figures, `approved_by`, `approved_at`, `approval_reason` and `source_locator = intake_file:<id>/row:<n>`, and audits `quarterly_performance.promote` with the figures before and after. Reject needs the reason the machine requires (422 otherwise) and is operations only (the machine's row; the deal team gets 403). A repeated command finds nothing to do and answers the unchanged file. Refusals map through `WORKFLOW_REFUSALS` via a shared `workflowProblem` helper in `common/problem.ts`.
- Migration `0007_intake.sql`: `stg.intake_file.findings jsonb`; the unique constraint on `(intake_file_id, natural_key)` becomes a plain index so a repeated key is staged and flagged (DUP-01) rather than refused; update-only RLS policies let the deal team approve staged rows (docs/18 section 2). Mirrored in `packages/db/src/schema/stg.ts` and docs/03.
- `config/accounting_layout.json` is loaded in `composition.ts` and injected as `ACCOUNTING_LAYOUT`; a malformed layout is a 500 `configuration` problem at use, like a missing definitions key.
- `app.ts`: the JSON body limit is 8 MB so an upload of the contract's largest CSV can arrive.

**Verified (command output summarized)**

- `pnpm typecheck`, `pnpm lint` (eslint and prettier), `pnpm check:style` (490 files), `pnpm check:employer-data` (491 files), `pnpm check:classification` (567 columns): all pass.
- `pnpm vitest run --project api src/test/intake.test.ts`: 18 tests pass (role guards, malformed bodies with paths only, clean, update and defects imports against the synthetic exports, duplicate by content, zero production change before approval, walled rows hidden and counted, approval with lineage and one audit event per promoted row, named-row approval, reject with and without a reason, list paging and filters, drop-folder listing and import by id, refused layouts, the byte limit, a malformed layout and a missing `intake` block). `api.test.ts` contract parity passes again. `pnpm vitest run --project db`: 259 tests pass with migration 0007.

**Open items for the owner**

- Security role impact (docs/05 checklist): migration 0007 adds update-only RLS policies for `deal_team` on `stg.intake_file` and `stg.intake_row`, matching the staging machine's approve row. Inserting files and rows stays with operations and the service.
- (Resolved later in the session, see the Session 4 close-out below.) The intake test first put `ops.one` on the wall because an importer outside the wall could not link the walled position; the e2e journey then showed the real import flagging that position as "no match" with a false exception. Linking now runs as the system actor (migration 0008, `DbService.runAsSystem`, decision 0009) and the test workaround is gone.
- Approval promotes every validated row the caller sees, including unchanged ones (the record then carries the accounting file as its lineage); say if unchanged rows should instead be marked promoted without a production write.
- A validated row cannot be rejected (the machine has no `validated > rejected`), so a reviewer who disagrees with a validated figure has no action yet other than approving or leaving it; a `sendBack`-style command is a docs/18 decision.

## Session 5 (2026-10-12): the accounting import in the static preview (docs/04 M2, decision 0009)

**Branch:** the worktree branch for the preview intake, on top of the intake fix commit (`8555746`). Synthetic data only; no employer information anywhere.

**What changed**

- `packages/validation`: `intakeSettingsFrom(definitions)` is the one reader of the intake thresholds in `config/definitions.json` (zod, plain decimal digits, an `IntakeSettingsError` naming the first bad key, never a default); `countsOf`, `emptyCounts` and `fileStatusOf` moved here from the API. The API's `IntakeService.settings()` now calls the shared reader and maps its error to the 500 configuration problem, so the browser and the API cannot differ on a threshold or on a file's status.
- `tools/synthetic`: `previewBook(dataset)` is the book as the system actor sees it (investment directory with company names, match guards, approved quarters oldest first with their ids, Locked marks with the latest version first, the three samples with the generator's expectations) and `previewSampleFileName(scenario)` the fixed name a sample is bundled under.
- `apps/web/scripts/build-preview.mjs` writes `preview/book.json` and `preview/samples/accounting-{clean,update,defects}.csv` next to the recordings, and `dist-preview/publish.json`, the list of files a publisher maps beside `artifact.html` by path. The recording plan no longer records the intake routes (their records exist only once the simulation stages a file); `plan.test.ts` knows a query a simulated GET route answers needs no recording.
- `apps/web/src/preview`: `book.ts` (the book schema and `parseBook`), `hash.ts` (the SubtleCrypto SHA-256 both the valuation lock hash and the intake content hash use), `routes/intake.ts` (the five intake routes: the samples as the drop folder; an import by sample id or as uploaded text, size limit, idempotent by SHA-256 of the text, read against `config/accounting_layout.json`, linked, diffed and checked with `@pb/validation` against the book as the system actor; the per-credential detail that leaves out and counts rows linked past the reader's wall and drops candidates they cannot open; list paging with a status filter and an opaque cursor; approve and reject through `stagingMachine` with the caller then the system actor, counts-only activity records). `defineSimRoute` takes GET routes and a contract query schema; the shim loads the book next to the recordings and hands the routes the page's own fetch for the samples; `PreviewState.intakeFiles` resets with everything else. The preview's standing rule holds: promotion changes the staged rows only, never the recorded figures.
- The probe stages the clean sample before the route walk (so `/data/intake/$id` renders for every user, 403 for the roles outside intake), then walks the intake journey in the UI (the defects sample, the Flagged and Exceptions tiles, the hidden-rows note, approve, reject with a reason, the wall member's view, a viewer's refusal) and checks the intake list is empty after a reset. The guide gains a sixth walkthrough, "Accounting import". The web README describes the simulated intake, the book, the samples and `publish.json`.

**Verified (command output summarized)**

- `pnpm typecheck`, `pnpm lint` (eslint and prettier), `pnpm check:style` (507 files) and `pnpm check:employer-data` (508 files): all pass.
- `pnpm vitest run --project validation --project synthetic`: 75 tests pass (the settings reader with its key naming, the counts and file status rule, the preview book). `pnpm vitest run --project api src/test/intake.test.ts`: 19 tests pass with the shared reader. `pnpm vitest run --project web`: 458 tests in 62 files pass, among them `routes/intake.test.ts` (12 tests over the real generator: the exports list, the update sample's counts, the duplicate by content, each defect row flagged by the rule the generator names with the exception count, the wall for ops.one, deal.one and deal.three, approve-all by operations then the wall member, reject without a reason and by the deal team, the viewer and unknown ids, a refused layout and the byte limit, cursor paging and reset).
- `pnpm build:preview`: book.json 43,776 bytes, the three samples under 2.2 kB each, fixtures.json unchanged at 2.05 MB, publish.json listing 8 files; `pnpm probe:preview`: 56 passed, 0 failed, 0 skipped, no recording misses, no page errors.

**Open items for the owner**

- The preview book carries the record's figures for the diff and the rules of every investment, walled ones included, in one static file, as `fixtures.json` already does for every mock user's answers (decision 0008): acceptable only because every figure is synthetic.
- The samples are bundled under fixed names (`accounting-<scenario>.csv`) that the intake page, the generator and the book schema all know; a rename needs all three.

## Session 5 close-out (2026-10-12): the wall fix, the adversarial review and its fixes, publish

**Branch:** `claude/gifted-tesla-eg7s85` (133 commits over `main`; the PR is still to be opened by the owner's request). Synthetic data only; no employer information anywhere.

**What changed after the Session 4 and Session 5 entries above**

- The e2e intake journey over the real API showed the first real defect of the slice: an importer outside a wall saw the walled position as "no match", with a flagged row and a false data exception. Linking, the diff and the rules now run as the system actor (`DbService.runAsSystem`); migration 0008 lets the `service` role past walls in `pb.can_see_walled`; the RLS matrix carries that actor; a credential that carries the service role is never signed in (`identity.middleware.ts`). Readers see only rows and candidates for positions they may open, the `XREF` messages name nobody, exceptions carry a candidate's reason only, and the page gates approve and reject on the rows the reviewer sees. The journey ends with a wall member finishing the file.
- An adversarial review of the whole intake slice (five finders by dimension, three refuters per finding) confirmed 36 of 44 findings; four parallel fix groups landed them, each checked by a reviewer. Highlights: promotion refuses a stale diff and an entry snapshot and runs the file's commands serialized with status guards (409 on a race); a refused file is re-stageable once the layout is corrected; the Locked mark is found by the quarter tolerance (`lockedNear`); the audit `after` figures are the stored values; new rules PERIOD-05 (entry snapshot quarter), TYPE-05 (figure scale and digits) and TIE-03 (no Locked mark to tie to); TYPE-03 (a period end off the quarter) is an error, so a bulk approve never writes a mid-month quarter; DUP-01 keys on the linked position and the aligned quarter; the bound rules compare aligned quarters and question a sign flip; STALE-01 counts calendar quarters; every threshold is in config; migration 0009 puts the wall on `stg.intake_row` itself and the definer function's wall tables drop `force row level security` so a non-superuser migration owner keeps walls on (tested with such a role); roles are validated at runtime and in the mock users file; the pages show a new quarter's figures and exact diff figures, refuse an empty file, keep focus after a command, and count only visible rows in the reject dialog; the generator exports the shifted sponsor at its own period end and reports every row of the walled position.
- The static preview simulates the five intake endpoints through the same validation library (see the Session 5 entry), and after the review the per-row preparation lives once in `packages/validation` (`prepare.ts`: `linkRows`, `prepareRows`, `exceptionsOpenedBy`, `selectTargets`) for the API and the browser alike; a missing preview book disables only Data > Intake.

**Verified (command output summarized, final tree `1b5d860` and later)**

- `pnpm typecheck`, `pnpm lint` (eslint and prettier), `pnpm check:style` (521 files), `pnpm check:employer-data` (522 files), `pnpm check:classification` (567 columns): all pass.
- `pnpm test`: 100 files, 1496 tests pass (validation 89 with a passing and a failing case per rule and the exact finding set per case; api intake 26; db 488 with the matrix's service actor, the staged-row wall and the definer-owner case; web 469 with the preview intake routes and the candidate filter; synthetic 22 on seeds 42, 7 and 14).
- `pnpm test:e2e`: 27 of 27 pass (11.1 minutes), the intake journey rerun on the final tree: 2 of 2.
- `pnpm build:preview` and `pnpm probe:preview`: 56 passed, 0 failed, no recording misses, no page errors; the artifact at the same private URL is republished with the book and the three samples (version 4, then the final tree).

**Open items for the owner**

- Security role impact (docs/05 checklist): migration 0007 gives `deal_team` update on the staging tables; migration 0008 lets the system actor (`service`) see walled records; migration 0009 puts the wall on `stg.intake_row` and takes `force row level security` off `core.wall_member` and `core.walled_record` (they stay `enable`d; the owner of `pb.can_see_walled` reads them). The RLS matrix proves each; say if any should be reverted.
- Rejection is operations' call under the staging machine, so a wall must include an operations member for a walled position's flagged row to be rejected (the test puts `ops.two` on the wall to finish the file); and a validated row still has no reject path. Both are docs/18 decisions.
- A file whose staged diff went stale (the record changed after staging) is refused at approval and cannot be staged again from the same bytes (its hash is a duplicate); it waits for a fresh export. A "stage again" command is a decision.
- Approval promotes unchanged rows too (the record then carries the file as its lineage); say if they should be marked promoted without a write.
- The preview book bundles the record's figures of every investment, walled ones included, in one static file (synthetic only); the three sample names are fixed in the page, the generator and the book schema.
- Earlier items still open: carry-at-cost policy, client totals null while any share is not calculable, the audit cursor shape, the branch size, the rulesets and SHA pinning on the repository.
