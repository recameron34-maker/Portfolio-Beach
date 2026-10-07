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

## Docs
Start with `CLAUDE.md` (doc map). Roadmap with exit criteria: `docs/09`. Completeness: `docs/11`.

`docs/` is the source of truth. To share the guide as one file (for IT, Legal or a reviewer), run `bash scripts/bundle-guide.sh`; the output lands in the gitignored `.bundle/` folder and is never committed, so it cannot drift from `docs/`.

No employer information of any kind in this repo or any session.
