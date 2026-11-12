# 0016: Security checks on a private repository

- **Status:** Accepted for the prototype
- **Date:** 2026-11-12
- **Deciders:** repo owner (chose to keep the repository private and use free tools); built in Claude Code

## Context

The build guide asks for two things of a personal repository that turned out not to go together: private visibility and CodeQL (SEC-17.5), with static analysis, dependency scanning and a licence list in CI (SEC-10.4).

On 2026-11-12 the owner made the repository private and switched Dependency graph on. The next run of the `security` job analysed the code and was refused at the upload:

> Code scanning is not enabled for this repository. Please enable code scanning in the repository settings.

The same job had passed on `main` an hour earlier, while the repository was public. GitHub offers code scanning and dependency review to public repositories at no charge, and to private ones as part of its paid code security. That is this record's understanding and not a quoted page: GitHub's documentation is outside the session's allowed network, so the refusal in the job log is the evidence. For the same reason CodeQL itself is not run on the private repository at all, not even without the upload: its terms, as understood here, cover open source and paying customers.

## Options considered

1. **Make the repository public again.** Both checks work unchanged. Against the private visibility SEC-17.5 asks for, though everything in the repository is synthetic.
2. **Pay for GitHub's code security.** No code change. A new paid licence for a prototype, which the working agreement says to ask about first; the owner did not want it.
3. **Keep it private and run free equivalents (chosen by the owner).** Checks that need no GitHub product: they run in a session, on a laptop and in CI alike.
4. **Semgrep Community Edition for the static analysis.** Considered and left out for now. It installs and runs here, but its rules are downloaded from a host this session cannot reach, so not one finding could be seen before relying on it. A later session with that host allowed can add it beside the lint rules.

## Decision

**Static analysis runs in the lint gate.** `pnpm lint` (the `ci` job) gains three ESLint plugins, curated in `eslint.config.js`:

- `eslint-plugin-regexp`: `no-super-linear-backtracking` and `no-super-linear-move`, the exact analysis of patterns that can take quadratic time or worse.
- `eslint-plugin-security`: evaluated code, child processes started from a computed command, computed `require`, patterns built at run time, comparisons of secrets that leak timing, unsafe buffer calls, pseudo-random bytes, bidirectional control characters and three framework checks. Two of its rules are left out because they flag every computed property and every file path (654 and 247 findings here, none a defect), and its star-height check gives way to the regexp plugin.
- `eslint-plugin-no-unsanitized`: HTML written into the page from anything but a literal.

Tests, browser journeys, build scripts and fixtures are exempt from the four rules about patterns and timing: they read this repository's own pages and fixtures, never outside input. The Python worker's lint adds ruff's `S` rules (flake8-bandit); `S101` is ignored there because that package is the cross-check of the calculations and states what it expects with `assert`.

**Dependencies are checked by three commands**, together `pnpm check:dependencies`:

- `pnpm check:audit`: `pnpm audit --audit-level moderate` over the whole lockfile. An advisory with no installable fix is listed under `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` with its reason, and removed when a fix can be installed.
- `pnpm check:audit:py`: `uv export` writes `uv.lock` as hashed requirements and `pip-audit` (2.10.1, run through `uvx`, installed nowhere) checks exactly those versions.
- `pnpm check:licenses`: `tools/dependency-check` reads `pnpm licenses list` and fails on the deny list the workflow already carried (GPL-2.0, GPL-3.0, AGPL-3.0). It reads SPDX expressions as they mean: "A OR B" is denied only when both sides are, "A AND B" when either is. A licence it cannot read is reported as unknown, never passed as fine.

**The workflow keeps GitHub's steps for the day they are offered.** In `.github/workflows/ci.yml` the CodeQL steps and the dependency review run when the repository is public or the repository variable `CODE_SCANNING` is `on`. The free checks run always: the licence list on every run, the two audits on pull requests (they ask advisory databases, as the dependency review does). The job's token also gains `actions: read`, which the CodeQL action needs on a private repository.

## What this changed in the code

- Ten patterns in product code were rewritten to run in linear time: the thousands grouping (API and web), the trailing zeros of a decimal string (`trimFractionZeros` in `@pb/calc`, also used by the valuation form; the PDF writer), the PDF number token, the acronym split in state names, the cursor's padding and the site's base path.
- Seven patterns built at run time and two comparisons were reviewed and carry a one-line reason where they stand: each is built from constants or names written in code.
- `zod` 4.6.5 to 4.6.7 in two packages and `wrangler` 4.146.0 to 4.161.0 in the site, which clears ten of eleven advisories. The eleventh (minimatch through eslint, GHSA-g3hv-75wg-m249) has no installable fix and is the one listed exception.

## What is weaker, said plainly

- **Pattern rules, not data-flow analysis.** Of the eight findings CodeQL raised on pull request 17, the lint rules catch the three slow patterns (shown by running them over the old files) and not the five about incomplete sanitising and escaping. Those five are fixed and have tests, but the next one of that kind would not be flagged.
- **The audit reads the whole tree on the day of the pull request.** That is stricter than the review it replaces, which looked only at what a pull request added. A pull request can therefore go red for an advisory published that morning. The remedy is an update, or an exception with a reason.
- **Python licences are not read.** The worker has fifteen packages, all tooling for the cross-check.
- **No list of code findings in GitHub's Security tab.** Dependabot alerts remain, now that Dependency graph is on.

## Verification

```
pnpm lint                                   clean with the security rules on
the regexp rules over the three old files   3 errors, the three CodeQL slow patterns
pnpm --filter @pb/worker-py lint            All checks passed (ruff with S), mypy clean
pnpm check:licenses                         OK (545 packages, none on GPL-2.0, GPL-3.0, AGPL-3.0)
  with a licence that is present denied     exit 1
pnpm check:audit                            exit 0 (1 moderate, ignored by the listed exception)
  with the exception removed                exit 1
pnpm check:audit:py                         No known vulnerabilities found
  pip-audit on an old requests              exit 1
vitest --project dependency-check           6 passed
```

The first CI run on the private repository is the test of the workflow's conditions; a session cannot run GitHub Actions.

## Consequences

- Three development dependencies (Apache-2.0, MIT, MPL-2.0) and one tool run on demand (`pip-audit`). No paid service, no new permission beyond `actions: read` on one job's token.
- If the repository becomes public, or moves to an organization with GitHub's code security, set the repository variable `CODE_SCANNING` to `on` (or do nothing, if public) and GitHub's steps run again beside the free ones.
- `docs/12` section 5 and `docs/16` section 2 name the gate as it now runs.

## SEC IDs affected

SEC-10.4 (static analysis, dependency scanning and the licence list run, by other tools than the one it names), SEC-17.5 (private visibility kept; CodeQL waits for a repository where GitHub offers it).
