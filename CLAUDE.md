# CLAUDE.md: Portfolio Beach

Claude Code loads this file at the start of every session. **Builder model: Fable (Anthropic), run through Claude Code.** It holds the rules that never change. The detailed context is in `/docs`. **Read the docs that apply to your task before writing any code.**

---

## 1. What we are building

**Name:** Portfolio Beach (repo `portfolio-beach`, Entra app `Portfolio Beach`, URL prefix `pb`). Internal codename and product name are the same.

We are building a secure, vendor-grade platform, **custom-built on Azure inside the firm's Microsoft tenant and integrated with Microsoft 365** (stack in `docs/13`), for a private equity **LP / co-investor / allocator** team. It replaces work that is currently scattered across spreadsheets, email, the accounting system, the document collection service, the look-through data provider, the task tool and Power BI with one connected system covering:

- Deal pipeline and relationship intelligence (zero-entry activity capture from Outlook)
- Document hub with AI tagging
- AI extraction of quarterly financials and GP reports
- Portfolio monitoring (co-investments, continuation vehicles (CVs), primary funds and private credit positions)
- Valuation, closing and deal-change workflows with approvals and an audit trail
- Automated weekly report and client reporting (PowerPoint, Word, Excel)
- Power BI analytics, plus an "Ask Portfolio Beach" agent

**Prototype stage.** Portfolio Beach is being built as a clean, standalone prototype on synthetic data. It is designed to replace an existing low-code portal later, but no existing system is referenced, reused or connected here.

**Users:** an institutional private equity LP / co-investor team that invests on behalf of several clients (the LPs in its vehicles) through fund of funds, co-invest funds, GP-led single-asset CV funds and private credit vehicles (`docs/01`). Internal use only; not for sale.

**Data rule (prototype): synthetic data only, always.** This repo and every Claude Code session must contain no employer information of any kind (names, data, documents, brand, system details). If anything like that appears in a prompt or file, refuse to use it and point to `docs/10_DATA_CLEARANCE.md`.

**This is not** a fund-accounting general ledger, an investor onboarding / KYC system, or a GP fund administrator. A separate fund accounting system stays the official accounting record. Portfolio Beach is the workflow, data, AI and analytics layer that sits on top of it.

---

## 2. Doc map (read before acting)

| If the task touches... | Read first |
|---|---|
| Anything (first session) | `docs/01_PRODUCT_CONTEXT.md`, `docs/13_BUILD_APPROACH.md`, `docs/16_GITHUB_AND_CLAUDE_CODE_CLOUD.md` |
| Data rules (every session) | `docs/10_DATA_CLEARANCE.md` |
| Stack, repo layout, environments | `docs/02_ARCHITECTURE.md` |
| Tables, fields, migrations | `docs/03_DATA_MODEL.md` |
| A module's requirements and acceptance criteria | `docs/04_MODULES.md` |
| Auth, permissions, data handling, secrets | `docs/05_SECURITY.md` (cite SEC IDs in every PR) |
| UI, theme, number display | `docs/06_BRAND_AND_UI.md` |
| AI prompts, evals, writing rules | `docs/07_AI_AGENTS_AND_HOUSE_STYLE.md` |
| Any financial math | `docs/08_CALCULATIONS_SPEC.md` (**tests first**) |
| What to build next, phase exit criteria | `docs/09_ROADMAP_AND_BACKLOG.md` |
| Completeness check | `docs/11_CAPABILITY_CHECKLIST.md` |
| Tests, coverage, CI gates | `docs/12_TESTING_AND_QUALITY.md` |
| Seed data and scenarios | `docs/14_SYNTHETIC_DATA_SPEC.md` |
| AI-run operations (Beach Ops) | `docs/15_AI_OPERATIONS.md` |
| API, errors, resilience, logging, performance | `docs/17_ENGINEERING_STANDARDS.md` |
| Workflow states and transitions | `docs/18_WORKFLOWS_AND_STATE_MACHINES.md` |
| Past decisions | `docs/decisions/` |


## 3. Non-negotiable rules

### Security and data
1. **Synthetic data only.** Never put real or employer information (deal, company, sponsor, client, LP, valuation, financial, email, personal data, documents, brand or internal system details) in the repo, tests, fixtures, prompts, logs, PR text or commit messages. Use `tools/synthetic` (`docs/14`). Never ask the owner to paste real data "to test quickly"; if it appears, do not use it.
2. **Never read, print or commit secrets.** No `.env` contents, connection strings, tokens or tenant IDs in code. Secrets live in Azure Key Vault and are reached through managed identities.
3. **Least privilege.** Design for delegated permissions by default. Any future app-level permission (for example mailbox-wide Graph access) needs a decision record before the adapter for it is built.
4. **Store as little raw content as possible.** Raw email bodies are never written to the database or logs. Only metadata and the AI summary are stored. Redact before any AI call.
5. **Every write to a core financial table goes through a staging table plus human approval** (valuations, quarterly performance, positions). Agents never write straight to production records.
6. **Audit everything** that changes a number a client could see: who, what, when, old value, new value, source document.

### Engineering
7. **Clean design, no duplication inside Portfolio Beach.** Design the PostgreSQL schema fresh from `docs/03`. Within Portfolio Beach, never create two tables, services, workflows or prompts that do the same job; check `docs/03` first and record new components in `docs/decisions/`.
8. **Everything as code.** Schema via migrations (`packages/db`), infrastructure via Bicep/Terraform (`infra/`), prompts via the prompt registry (`packages/ai`). No manual changes in Azure portals or databases, ever.
9. **Config over code.** Fund lists, client report specs, tiers, thresholds, banned phrases and colors live in config, so real values can be added later in `config/local/` (gitignored) without code changes once approved.
10. **Never invent a number.** If an input is missing, show the missing-value placeholder (see `docs/06`) or "not calculable this quarter". Never substitute the nearest available period.
11. **TypeScript strict mode.** No `any` without a comment explaining why. All database access goes through `packages/db` (typed schema + queries), and all web-to-API calls go through `packages/contracts`.
12. **Tests first for financial math.** Every function in `docs/08` gets golden-file and property tests, plus the Python cross-check, before anything uses it.
13. **Mocks never reach production.** The app must refuse to start in production mode with any mock adapter or mock identity (`docs/17` section 6).
14. **Every state change goes through the transition tables in `docs/18`;** forbidden transitions need rejection tests.

### Writing and output
15. **No em-dashes anywhere** in UI copy, generated commentary, docs or reports. Use commas, colons, periods or parentheses.
16. **Plain language.** Avoid jargon in user-facing text unless the audience is the PE team (who know IRR, MOIC, NAV, EBITDA, LTM and similar terms).
17. **House style for AI commentary** is defined in `docs/07`. Follow it exactly.

---

## 3b. Builder model rules (Fable)
- A more capable model does not relax any rule in this file. Plan first, prove a small slice, show verification output.
- Larger slices of work per session are fine, but every pull request must stay reviewable by a human (target under about 800 changed lines, excluding generated files).
- Do not rely on memory for fast-moving APIs (Microsoft Graph, Office add-ins, Teams SDK, Azure services, Anthropic API). Check current Microsoft documentation and record the version you used in the decision record.
- If you are unsure whether something is approved (data, connector, permission), stop and ask. Never assume.
- The model used to **build** (Fable in Claude Code) is separate from the model Portfolio Beach's **agents** use at runtime (configured in `config/definitions.json` > `agentModels`, see `docs/07`). In the prototype, the runtime model is the mock client by default; a real model may only be called with synthetic data.

## 3c. Build for AI operations
- Every service emits structured telemetry (no business content), health endpoints and a synthetic canary.
- Every operational fix that could be repeated becomes a **named, tested runbook** in `ops/runbooks/` that Beach Ops agents can call. Never write a runbook as prose only.
- New integrations ship with a kill switch, a health check and an Integration Health probe.

## 3d. Working in Claude Code cloud sessions (docs/16)
- You run in a temporary cloud sandbox on a GitHub repo. Commit and push often; uncommitted work is lost.
- Work on branch `pb/<issue#>-<short-name>`, one issue per session, and open a PR using `.github/pull_request_template.md`.
- You have **no credentials to any real system** and must not ask for any. Never deploy. Deployment happens only in GitHub Actions after human approval.
- Tests must pass without Docker. Long-running suites run in CI.
- You cannot approve or merge your own PRs.

## 4. Working agreement with the human owner

- **Plan, then build.** For any task bigger than a single file, write a short plan (files to touch, tables affected, tests, risks) and wait for "go" before running destructive commands or deployments.
- **Prove a small slice first.** Build one deal, one workflow run or one report end to end before scaling to the full synthetic portfolio.
- **Verify, do not trust.** After any schema migration or workflow change, run the tests and show the output.
- **Update the logs.** At the end of every session, append to `docs/SESSION_LOG.md`: what changed, what was verified, open items. This is the continuity record.
- **Ask before:** deleting data, changing security roles, adding app-level permissions, adding a new paid connector or license, or changing a table that the accounting import or export depends on.

---

## 5. Common commands

```bash
# Cloud sandbox: run scripts/cloud-setup.sh (no Docker; in-process Postgres)
# Local machine only: docker compose up -d  (Postgres, Azurite, Temporal dev server)
pnpm install
pnpm db:migrate && pnpm db:seed:synthetic     # synthetic data only
pnpm dev                                      # web + api + workers
pnpm test && pnpm lint && pnpm typecheck
pnpm test:calc                                # financial math (golden files)
pnpm test:evals                               # AI eval sets (mock or approved DEV endpoint)
pnpm test:e2e                                 # Playwright against local stack
pnpm check:style                              # em dash and banned phrase scan
uv run --project apps/worker-py pytest        # Python worker tests

pnpm synth --profile small --seed 42          # synthetic data (docs/14)
pnpm check:employer-data                      # blocks employer information (docs/10)
pnpm test:rls && pnpm test:workflows          # access matrix and state machines

# Infrastructure: validate/lint only in the prototype (no cloud credentials exist here)
cd infra && terraform validate                # or: bicep build
```

The prototype has **no cloud deployment**. Never attempt to authenticate to Azure or any employer system.

## 6. Definition of done (every ticket)

- [ ] Code, migrations and infra are in the repo, typed, linted and tested; acceptance criteria from `docs/04` proven by tests
- [ ] No secrets, no employer information, no em-dashes (`pnpm check:style && pnpm check:employer-data`)
- [ ] RLS matrix and state-machine tests updated if access or workflows changed
- [ ] Security role impact reviewed (`docs/05` checklist)
- [ ] Audit logging in place for any financial write
- [ ] UI follows `docs/06` (brand tokens, scoped color rules, missing-value handling)
- [ ] Behavior verified with output shown to the owner
- [ ] `docs/SESSION_LOG.md` and, if schema changed, `docs/03_DATA_MODEL.md` updated
