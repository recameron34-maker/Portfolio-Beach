#!/usr/bin/env bash
# pnpm check:audit:py (decision 0016): known vulnerabilities in the Python worker's locked
# dependencies. uv writes the lock as hashed requirements (the worker itself left out) and
# pip-audit checks exactly those versions against the PyPI advisory database. It needs the
# network; it installs nothing into the project.
set -euo pipefail
cd "$(dirname "$0")/.."

requirements="$(mktemp)"
trap 'rm -f "$requirements"' EXIT

uv export --project apps/worker-py --frozen --format requirements-txt --no-emit-project \
  > "$requirements"
uvx pip-audit@2.10.1 --require-hashes --disable-pip -r "$requirements"
