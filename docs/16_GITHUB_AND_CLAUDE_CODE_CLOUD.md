# 16: Building on GitHub with Claude Code in the Cloud (prototype stage)

## 1. Setup
- **Account:** a GitHub account registered to the owner's **work email**. This is still a personal account, **not** a member of the employer's GitHub organization, so the employer's IT cannot see it, enforce SSO, run access reviews, or remove access on departure. Treat it as a temporary prototype home.
- **Tell IT and your manager** that the repo exists and what it is for. Ask IT whether the employer has GitHub Enterprise (or Enterprise Managed Users). If it does, the best move is to have IT create the repo in the employer's organization now (or add this account to it) and skip the transfer later.
- **Ownership:** this is work product built for the employer. Expect it to belong to the employer. Don't fork it or keep copies outside the account.
- **Repo:** private repo `portfolio-beach`. Never public.
- **Account security:** 2FA with a passkey or security key; no broad personal access tokens; review authorized apps regularly.
- **Claude GitHub app:** installed on **this repo only**.
- **Devices:** follow the employer's acceptable-use policy for devices and outside accounts. Use the device IT approves for this work.

## 2. Repository settings
- Branch ruleset on `main`: PRs required, status checks required (`ci`, `security`), no force pushes. As the solo owner you review and merge Claude's PRs; Claude never merges.
- Turn on: secret scanning with push protection, Dependabot alerts and updates, CodeQL, dependency review, private vulnerability reporting.
- Actions: allow only pinned actions (full commit SHA); default token read-only.
- `CODEOWNERS` lists you; add reviewers later when the repo moves to an organization.

## 3. Claude Code cloud environment
- **Network:** most restrictive setting that works; allow package registries, GitHub and public docs only.
- **Secrets:** none. If you test real model calls, use an Anthropic API key approved for this work **with synthetic data only**, stored in the environment's secret settings, with a low spending limit. Default to the mock AI client.
- **Setup script:** `scripts/cloud-setup.sh` (tools only; no data downloads).
- **Docker** may not be available: tests use in-process Postgres and mocks. Long suites run in GitHub Actions.
- Check Anthropic's current Claude Code docs for network settings, secrets handling, session limits and data retention, and record what you confirmed in `docs/decisions/0003-claude-code-cloud.md`.

## 3b. Local machine (if used)
- Run `bash scripts/install-hooks.sh` once to add the pre-push employer-data check.
- Create `config/local/denylist.txt` (never committed).

## 4. Working pattern
1. Create a GitHub Issue per roadmap item (issue template).
2. Start a cloud session with the Fable model; paste `prompts/01_PHASE_TEMPLATE.md` with the issue number.
3. Claude plans, waits for "go", builds on `pb/<issue#>-<short-name>`, runs tests, opens a PR with the template.
4. CI passes; you review and merge. Keep PRs under about 800 changed lines.
5. Parallel sessions only for independent modules; one open migration PR at a time.
6. Sessions are temporary: commit often and finish every session with `prompts/04_SESSION_CLOSE.md`.
7. Every few PRs, run `prompts/02_REVIEW_PASS.md`; for bugs use `prompts/03_BUGFIX.md`.

## 5. No deployments from the prototype
The prototype runs locally and in CI only. No cloud deployment to any employer resource. If you want a hosted demo, ask IT for a sandbox Azure subscription; use synthetic data and mock identity, and tear it down after demos. Production deployment design (`docs/02`, OIDC, protected environments) is implemented after merge.
