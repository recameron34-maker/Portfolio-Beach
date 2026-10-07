#!/usr/bin/env bash
# Claude Code cloud environment setup. Tools and local test services only.
# Must NOT download data, call employer systems or use credentials.
set -euo pipefail
corepack enable
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi
if [ -f apps/worker-py/pyproject.toml ]; then
  command -v uv >/dev/null || pip install --quiet uv
  (cd apps/worker-py && uv sync)
fi
# Tests use in-process Postgres (PGlite) and mocks; no Docker required.
bash scripts/check-employer-data.sh || { echo "Employer-data check failed. Fix before working."; exit 1; }
echo "Portfolio Beach sandbox ready (synthetic data only)."
