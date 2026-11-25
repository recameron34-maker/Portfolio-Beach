# Handoff: where the build stands and how to pick it up

Written 2026-11-18, about 17:10 UTC, by the build session, because the week's usage was running low. The owner's instruction for the rest of this session: push as much finished product as possible, write down how to resume, and run the full review process later.

Read this before `docs/SESSION_LOG.md` when you pick the work up. Update or delete it when it no longer describes the state.

**Who builds what (the owner, 2026-11-18):** the work listed in section 10 is to be built by Fable only, the builder model `CLAUDE.md` names. A session on any other model works within section 11 (UI work) and leaves section 10 alone.

## 1. State in one table

| Work | State | Where |
|---|---|---|
| Everything up to valuation suggestions (decisions 0016 to 0023) | Built, reviewed three ways, fixed, pushed | Pull request 18, commits up to `44104ff` |
| Reporting, Packages pages (decision 0024) | Built, merged, then reviewed and fixed on 2026-11-25: 22 findings, all fixed, each with a test that failed first. What was found, what was decided and what was left are in decision 0024, "After the verification" | Section 2 |
| The review of every open design question | Paused after collecting. 177 questions listed, none decided | Section 4 |
| The demo artifact | Version 19, built from `62fb769`: has valuation suggestions and the Packages pages (its preview probe passed 223 of 223) | Section 3 |
| Pull request 18 | Open. Not merged. A human merges | Section 5 |

Branch: `claude/gifted-tesla-eg7s85` (the only branch the session may push to). Run `git log --oneline 44104ff..HEAD` to see what landed after this was written.

Next free numbers when this was written: decision record 0025 (0024 is the Packages pages, written in its slice 8), migration 0024, `docs/08` section 13, golden fixture 32, `docs/18` section 15, capability row E16. Check before using one. (Migration 0024 was used on 2026-11-25 for the submitter of a package; the next free migration is 0025. Decision record 0026 is the UI pass.)

## 2. Reporting, Packages pages: finish, then review

**Done (2026-11-25).** Every slice is committed and merged, and the review below has run with its fixes: decision 0024, "After the verification", and the session log entry of that date. What follows is kept as the record of how it was to be done.

Specification: `docs/handoff/spec-report-packages-web.md` (eight slices, section 11 of the file; where it says decision 0022 read 0024).

Committed slices:

| Slice | Commit | What |
|---|---|---|
| 1 | `82f7dd8` | Shared pieces, no behaviour change (`canonicalJson`, `flowKindOf`, `snapshotRequestOf`) |
| 2 | `f6b64b3` | `changeLog` in the contract and the API |
| 3 | `633ce30` | The static preview: the four simulated routes |
| 4 | `e3c91b3` | `StepStrip`, `packages.ts` (words, steps, formats), `formatUsdExact`, the config key |
| 5 | `df97986` | The list page, the start form, the Packages tab, the role focus |
| 6 | `384a82f` | The package page's read only cards |
| 7 | see `git log` | The commands: buttons by role and state, the override dialog, the explanations dialog, If-Match |
| 8 | see `git log` | `failingPackageCase`, the browser journey, the probe walk, decision record 0024, the roadmap line, the session log |

To finish:

1. `git status`. Uncommitted files under `apps/web/src/pages/reporting/packages/` belong to the slice that was being written. Read them against the specification, finish the slice, run the gates below, commit it by itself.
2. Build whichever of slices 7 and 8 has no commit.

Then review it. The earlier features each went through this and each review found real defects, so do not skip it:

1. Every gate from a clean tree (list in section 6), with the whole browser suite.
2. Three independent reviews of the diff since `44104ff`: gates and specification (walk every section of the spec against the code); maths, data and workflow (recompute worked examples, try every forbidden transition, probe the API with scratch tests); access, the static preview and the pages (who can read what, the preview against the API, loading, empty and unavailable states, page copy).
3. Fix what they find, each fix with a test that failed before it, then run the gates again.

The workflow script that does all of this is `docs/handoff/workflow-build-feature.js.txt` (builders in sequence, three verifiers in parallel, one fixer). In the session that started it, it resumes with `resumeFromRunId: 'wf_f3536058-54c'` and the same arguments. A new session has no cache, so pass the script inline with only the slices that remain in `groups`, for example:

```json
{
  "key": "report-packages-web",
  "title": "The Reporting, Packages pages",
  "spec": "docs/handoff/spec-report-packages-web.md",
  "base": "44104ff",
  "groups": [{ "label": "finish", "slices": "whichever of slices 7 and 8 has no commit yet" }]
}
```

With every slice committed, pass one group whose `slices` text says "no slice remains: confirm the tree is clean and report", and the script goes straight to its verifiers.

## 3. The demo artifact

`https://claude.ai/artifact/UmZvjUFs6NYWwbMbxUFepW`, the owner's, Version 19 (the owner has shared it by link; it holds synthetic data only). To republish after a change:

1. `pnpm --filter @pb/api build && pnpm --filter @pb/web build:preview`
2. From `apps/web`: `node scripts/probe-preview.mjs` (223 checks passed before the Packages pages; slice 8 adds some).
3. List the artifact's published files, compare with `apps/web/dist-preview/publish.json` by content hash, and publish `apps/web/dist-preview/artifact.html` to the same URL with a `files` map of the files that changed (the hashed assets, `preview/book.json`, `preview/fixtures.json`, any new sample document), setting each stale hashed asset to null.

Never run `pnpm --filter @pb/site build` for this: it re-records the website's media.

## 4. The owner's standing instruction, and the paused review

The owner, 2026-11-18, word for word: "I need the system to be smart enough to make these types of decisions its self and make them correctly." It was his answer to a list of design questions the build had left for him. It is recorded in `CLAUDE.md` section 4.

The build's reading of it (ours, not his words):

1. The build decides design and product questions itself, records each decision with its reason and the alternative set aside, and builds it.
2. The product, when it runs, settles whatever the data on hand can prove with a rule that is written down and tested, shows why, and sends a person only what it cannot settle.

What does not change: the non-negotiable rules of `CLAUDE.md` (the system never writes or approves a mark, a cash flow or a client figure without a person; never invents a number), and the "ask before" list of its section 4. Prefer the option that avoids those; a decision that narrows access may be taken, one that widens it may not.

The review that was to decide every open question was paused to save usage:

- `docs/handoff/open-questions-collected.md`: the 177 open questions, by theme, each with where it is recorded, what the code does today, the alternatives and the context a decision touches. Also the three lens reviews (practice, control, product) of two themes: the base case and valuation suggestions. **No judge had run. Nothing in that file is a decision.**
- `docs/handoff/workflow-decide-open-questions.js.txt` and its arguments, `workflow-decide-open-questions.args.json.txt`: per theme a collector, three lenses, a judge, an adversary and one revision; then a completeness critic; then a build specification and a register of decisions, reviewed twice. In the session that started it: `resumeFromRunId: 'wf_dee9e4e9-370'` with the same script and arguments replays the twelve finished agents. In a new session, change the script so each theme's questions are read from `open-questions-collected.md` instead of collected again.
- What follows the review: build its specification with the build script. Its first slice is the record: decision record 0025 (who decides what), and each "Open for the owner" section of the earlier records rewritten as decided.

Cost, for planning: about 35 agents were left in the review, and the build after it is larger than the valuation suggestions build.

## 5. Pull request 18 and CI

- The repository was made public on 2026-11-18 (the owner means to make it private again). Public, GitHub starts the jobs and also runs CodeQL and the dependency review. While it was private, GitHub started no job from 13 to 18 November, before a runner was assigned: the account's included Actions minutes were most likely used up. That will return when it is private again. One push costs about 40 runner minutes, most of it the browser suite.
- On every head since `33f568c` the guard, `security`, `ci` and CodeQL passed. **The `e2e` job had not completed a run when this was written:** a new push cancels the run in progress, and the suite takes about 25 minutes there. Do not push while it is running unless you must, and read its result on the last push.
- Audit exceptions, each with its reason in `pnpm-workspace.yaml` (decision 0016): minimatch `GHSA-g3hv-75wg-m249` and picomatch `GHSA-fc5q-39xc-vjpf`. Remove each when a fixed version can be installed.
- "Workers Builds: portfolio-beach" (Cloudflare) fails on every push to this branch. It is not part of the gate, its log is only in the Cloudflare dashboard, and it is explained in the pull request's comments. Production builds from `main` work.
- The pull request description lists twelve items. Add the Packages pages as the thirteenth, with the evidence, once they are reviewed.

## 6. Gates (what "verified" means here)

```bash
pnpm typecheck && pnpm lint
pnpm exec vitest run
pnpm test:calc && pnpm test:rls && pnpm test:workflows && pnpm test:evals
pnpm --filter @pb/db build && pnpm check:classification
bash scripts/check-style.sh && pnpm check:employer-data
pnpm openapi:generate            # then git status must be clean
pnpm check:dependencies
pnpm --filter @pb/api build && pnpm --filter @pb/web build:preview
( cd apps/web && node scripts/probe-preview.mjs )
( cd apps/web && PB_E2E_API_PORT=3141 PB_E2E_WEB_PORT=5184 PB_E2E_DIR=<an empty scratch folder> pnpm exec playwright test --trace off --reporter=line )
```

In the cloud sandbox set `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` for the last two. The whole browser suite takes about 20 minutes. Last full local run: 71 passed on `44104ff`.

## 7. Small things waiting

- Page copy names a config file: `VARIANCE_TITLE` in `apps/web/src/pages/valuations/board.ts` reads "Above the 10.0% flag (config/definitions.json)". Reword it, and look for other page copy that names a file, a config key or a code identifier (`docs/06` section 6).
- Re-record the website's tour video: the home page changed, and the map, the fit card, the base case card, the Suggestions tab and the Packages pages are not in the site's media.
- Synthetic scenarios `qtd_ytd_basis` and `sign_flip` are specified and not generated. Counts on the role work list.
- The later Phase 4 slices (`docs/09`): the template engine and the client reports themselves.

## 8. What only the owner can do

- Merge pull request 18 (the session cannot merge).
- GitHub Actions minutes or a spending limit, for when the repository is private again.
- In Cloudflare: switch off builds for branches other than `main`, or read the log of a failed branch build.
- Listen to the narration of the demo videos.
- The four questions of decision 0019 (Microsoft 365): they turn on the firm's own tenant and licences.

## 9. Files in this folder

| File | What |
|---|---|
| `spec-report-packages-web.md` | The specification being built (section 2) |
| `spec-valuation-suggestions.md`, `spec-underwriting-base-case.md` | The specifications of the two features built before it, kept as the model for the next one |
| `workflow-build-feature.js.txt` | The build, review and fix workflow |
| `workflow-decide-open-questions.js.txt`, `workflow-decide-open-questions.args.json.txt` | The paused review of open questions and its arguments |
| `open-questions-collected.md` | What that review had collected and reviewed when it was paused |

The scripts are saved as `.txt` so the lint gate does not read them as source. In the copy of the build script the email address of the commit attribution line is replaced by a placeholder (the employer-data guard blocks any address that is not an example): use the attribution lines the session itself gives.

## 10. What still needs to be built: Fable only

By the owner's instruction of 2026-11-18, everything in this section is built by Fable only, the builder model `CLAUDE.md` names. A session running on any other model does not start, continue, review or change this work, and does not run or resume the workflows in this folder. If such a session finds a fault in this work, it writes it in `docs/SESSION_LOG.md` under open items and leaves the code as it is.

In order:

1. **Reporting, Packages pages: the review.** Done on 2026-11-25 (decision 0024, "After the verification"). What it left open is listed there: where focus goes after a start opens a package's page, a table-level check on who overrides, the words of a refusal for a two-role reader, and the two items that were already open (a package inherits the walls of its positions; a way back with a reason).
2. **The open design questions.** Decide the 177 collected questions (section 4), then build what the decisions change: decision record 0025 first, then the slices of the specification that review writes.
3. **The rest of Phase 4** (`docs/09`): the template engine with layout locks and the external change log; the weekly report; the client reports themselves (PowerPoint, Word, Excel) with mover commentary, the disclosure library, approved statistics and the distribution log; the reporting views for analytics. The Phase 4 exit journey needs the template engine.
4. **Phases 5 to 8** as `docs/09` lists them: front office (pipeline, diligence and IC, relationship capture, commitments and pacing); analytics, access and assistants (exposures, benchmarking, liquidity, the read API, Ask Portfolio Beach); Beach Ops; merge readiness.
5. **Data and rules left over:** the synthetic scenarios `qtd_ytd_basis` and `sign_flip`; the counts on the role work list; a fund commitment carrying a mark, so that a fund-level statement can raise a suggestion (question 1 of decision 0023, one of the 177).
6. **Microsoft 365 integration** (decision 0019), once the owner has answered its four questions.

What marks this work: it touches a financial rule, a state machine, the database and its access policies, the API and its contracts, extraction, the synthetic data, or the static preview's simulation of the API. Those are the layers where a mistake produces a wrong number or shows a figure to the wrong person, and where the tests-first and review process of `CLAUDE.md` applies in full.

## 11. A UI session on another model

The owner plans UI work in a separate session after this one stops. It serves the roadmap line "A UI pass with motion" (`docs/09`, asked 2026-11-12) and `docs/06`.

**Start from this branch's head, not from `main`.** Pull request 18 is not merged, so `main` has none of the work since 12 November (the map, the fit card, the role focus, the base case, valuation suggestions, the Packages pages). Either the owner merges pull request 18 first, or the UI session branches from `claude/gifted-tesla-eg7s85`.

May change: layout, spacing, type, colour within the brand tokens, components, motion, wording and accessibility, in `apps/web/src/components`, the `.tsx` and `.css` files under `apps/web/src/pages` and `apps/web/src/app`, and the website's look in `apps/site`.

Leaves alone:

- `packages/` (calc, workflows, contracts, db, ai, validation, report-engine), `apps/api`, `apps/worker-py`, `tools/`, every migration, `docs/08` and `docs/18`.
- `apps/web/src/preview/routes` and `apps/web/scripts`: the static preview simulates the API there, rule for rule.
- Values in `config/` that are rules (thresholds, tolerances, role lists) and the number formats in `apps/web/src/lib/format.ts`.
- What a page does: which requests it sends, which figures it shows, who is offered which action. The Packages pages in particular are not reviewed yet: restyle them, do not change their logic.

Rules a page keeps (`docs/06`, `CLAUDE.md` section 3):

- No arithmetic on money in a page. A missing value shows the placeholder with its reason, never a zero.
- Who may see or do something comes from the contract's role lists, never from a rule written in a component. Role focus orders and describes; it never grants or hides.
- Page copy never names a file, a config key, a code identifier or the build guide (`lib/copy-guard.test.ts`). No em dashes. Plain words.
- Motion is decoration: it stops under the reduced-motion setting and never carries meaning alone. Every chart keeps its table twin.

Checks for a UI change: `pnpm typecheck && pnpm lint`; `pnpm exec vitest run --project web` (many tests assert visible words, so a wording change updates its test in the same commit); `bash scripts/check-style.sh`; the preview build and its probe (section 3); the accessibility spec, `apps/web/e2e/a11y.spec.ts`; and the whole browser suite once before the session ends (section 6). Record what changed in `docs/SESSION_LOG.md`.

A first small item for it: section 7's page copy that names a config file.

The UI session's plan is `docs/handoff/ui-pass-plan.md` (fourteen slices and a close, built from an audit of 174 screenshots and the owner's direction of 2026-11-18 that the app look "less like a standard anthropic build, throughout"). Its section 4 lists the slices; `git log` shows which are committed.

**Where the UI pass stopped (2026-11-19).** All fourteen slices are built and committed (slice 14 is `1b82e50`). The first round of reviews and fixes covered slices 1 to 9 (fixes `8ae26a3` and `9dcebbc`). Pull request 18 (everything since 12 November, with slices 1 to 13) and pull request 22 (slice 14) were merged into `main` on 2026-11-19 at the owner's request, which deploys the website; every repository check, the whole browser suite included, passed on pull request 22. The demo artifact (Version 22) and the website preview were republished from `main`. Still to run, stopped to save usage: the second round of reviews (a visual review against the before screenshots and a behaviour and scope review of slices 10 to 14), the fixes they confirm, and the close of the plan (every gate of section 6 including the whole browser suite, the website's own checks, the full after screenshots, and the record: `docs/06` read against the code, decision 0026, the session log, this section and the roadmap tick). The script that runs them is `ui-pass-build-rounds` (in the session's workflow scripts); a later session reruns those steps by hand from the plan's section 1.3 and "The close".

