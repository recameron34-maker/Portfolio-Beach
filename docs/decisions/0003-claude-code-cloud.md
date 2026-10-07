# 0003: Claude Code cloud sessions
- **Status:** Accepted for the prototype (re-verify when Anthropic's documentation or the environment changes)
- **Date:** 2026-10-07 (first build session)
- **Deciders:** repo owner
## Context
The prototype is built in Claude Code cloud sessions on a private GitHub repo. `docs/16` asks for the sandbox facts to be recorded here, not assumed.
## Findings in the first session (observed, not from memory)
- Node 22.22 (matches `.nvmrc`), pnpm 10.28 via corepack 0.34, Python 3.13.16, uv 0.11. Python is newer than the 3.12 the stack doc named, so the Python worker targets "3.12 or later".
- Docker: the CLI exists but no daemon runs. Tests therefore use in-process Postgres (PGlite) and mocks, as `docs/12` requires; Docker Compose is for local machines only.
- Network: outbound HTTPS goes through a pre-configured proxy. The npm registry and PyPI resolve and install; GitHub is reachable for push. No employer system is reachable or configured, and no secrets exist in the environment.
- Secrets: none are set. The mock AI client is the default (`config/definitions.json` > `agentModels`).
- Permissions: `.claude/settings.json` denies reading secrets, `curl`, `az`, `terraform apply` and force pushes, and asks before dependency installs and pushes.
## Decision
Keep the most restrictive network setting that still reaches package registries and GitHub. No secrets in the environment. Every session starts with `scripts/cloud-setup.sh` and ends with `prompts/04_SESSION_CLOSE.md`. Re-check Anthropic's current documentation on data retention and session limits before gate G0 and record the date here.
## Consequences
No long-running services in tests; the full e2e and performance suites run in GitHub Actions. Sessions are temporary, so work is committed and pushed in small slices.
## SEC IDs affected
SEC-17.1, SEC-17.2, SEC-17.7
## Verification
Tool versions and network behavior observed directly in the session on the date above.
