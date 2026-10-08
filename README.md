# Portfolio Beach

Internal-use private equity platform prototype for an LP / co-investor team: pipeline, relationships, documents, AI extraction with citations, monitoring, valuations, capital activity, reporting and analytics. Built on **synthetic data only** with mock adapters (docs/10, docs/14). Proprietary; see LICENSE.

## Before the first session
1. Private repo `portfolio-beach` on the GitHub account registered to your work email. Tell IT and your manager it exists (docs/16 section 1).
2. Apply repo settings (docs/16 section 2). Install the Claude GitHub app on this repo only.
3. Claude Code cloud environment: most restrictive network that works, no secrets, setup script `bash scripts/cloud-setup.sh`.
4. On any local machine: `bash scripts/install-hooks.sh` and create `config/local/denylist.txt` (never committed).
5. This pack is the first commit; everything after it is built on the roadmap in `docs/09`.

## Sessions
| Purpose | Prompt |
|---|---|
| First session | `prompts/00_FIRST_SESSION.md` |
| Each roadmap ticket | `prompts/01_PHASE_TEMPLATE.md` |
| Periodic review | `prompts/02_REVIEW_PASS.md` |
| Bug fix | `prompts/03_BUGFIX.md` |
| End of every session | `prompts/04_SESSION_CLOSE.md` |

## Quick start (synthetic data only)
```bash
pnpm install && (cd apps/worker-py && uv sync)
pnpm typecheck                                   # builds every package (TypeScript project references)
pnpm synth --profile small --seed 42 --out .synthetic/
pnpm db:seed:synthetic .synthetic/dataset.json   # local in-process Postgres under .pglite/dev
pnpm dev                                         # API on :3001 and web on :5173; sign in as any synthetic user
pnpm test && pnpm test:calc && pnpm test:e2e     # unit, database, calc cross-check, Playwright journey 1
```
What exists after Phase 0: the data layer with row-level security and audit (`packages/db`), the calculation library with a Python cross-check (`packages/calc`), workflow state machines (`packages/workflows`), adapter interfaces with mocks and the production guard (`packages/adapters`), the synthetic data generator (`tools/synthetic`), the API (`apps/api`) and the web shell (`apps/web`). Each has a README. The roadmap in `docs/09` records what is done and what is next.

Since then, and ahead of their phases by decision 0006: read endpoints for analytics, the watchlist, the weekly report, vehicles and commitments, clients, sponsors, the performance series, the valuation board, capital notices, the audit trail, the taxonomy and walls, all under row-level security; and web pages for each of them, including the deal workspace tabs, a printable weekly report, a mock "Ask Portfolio Beach" assistant that answers from the figures without calling a model, and the Horizon Line design system (decision 0007). Writes stay out of the API until Phase 3. A static preview (`pnpm --filter @pb/web build:preview`, then `probe:preview`) replays the API's recorded answers for every mock user and simulates the valuation and capital notice workflows in the browser through the same transition tables, labelled as simulated (decision 0008). `docs/11` keeps every such capability at P until its acceptance tests exist.

## Docs
Start with `CLAUDE.md` (doc map). Roadmap with exit criteria: `docs/09`. Completeness: `docs/11`.

`docs/` is the source of truth. To share the guide as one file (for IT, Legal or a reviewer), run `bash scripts/bundle-guide.sh`; the output lands in the gitignored `.bundle/` folder and is never committed, so it cannot drift from `docs/`.

No employer information of any kind in this repo or any session.
