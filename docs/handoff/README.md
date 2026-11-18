# Handoff: where the build stands and how to pick it up

Written 2026-11-18, about 17:10 UTC, by the build session, because the week's usage was running low. The owner's instruction for the rest of this session: push as much finished product as possible, write down how to resume, and run the full review process later.

Read this before `docs/SESSION_LOG.md` when you pick the work up. Update or delete it when it no longer describes the state.

## 1. State in one table

| Work | State | Where |
|---|---|---|
| Everything up to valuation suggestions (decisions 0016 to 0023) | Built, reviewed three ways, fixed, pushed | Pull request 18, commits up to `44104ff` |
| Reporting, Packages pages (decision 0024) | Slices 1 to 6 of 8 pushed. Slice 7 was being written and slice 8 was not started when this was written. **Not reviewed yet.** | Section 2 |
| The review of every open design question | Paused after collecting. 177 questions listed, none decided | Section 4 |
| The demo artifact | Version 18: has valuation suggestions, does not have the Packages pages | Section 3 |
| Pull request 18 | Open. Not merged. A human merges | Section 5 |

Branch: `claude/gifted-tesla-eg7s85` (the only branch the session may push to). Run `git log --oneline 44104ff..HEAD` to see what landed after this was written.

Next free numbers when this was written: decision record 0025 (0024 is the Packages pages, written in its slice 8), migration 0024, `docs/08` section 13, golden fixture 32, `docs/18` section 15, capability row E16. Check before using one.

## 2. Reporting, Packages pages: finish, then review

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

`https://claude.ai/artifact/UmZvjUFs6NYWwbMbxUFepW`, private to the owner, Version 18. To republish after the Packages pages are in:

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

The scripts are saved as `.txt` so the lint gate does not read them as source.
