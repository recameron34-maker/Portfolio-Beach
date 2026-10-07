#!/usr/bin/env bash
# Regenerates the single-file build guide from the canonical sources in the repo.
# The output is gitignored: docs/ is the source of truth, the bundle is for sharing with IT, Legal or reviewers.
# Usage: bash scripts/bundle-guide.sh [output-path]   (default: .bundle/Portfolio_Beach_Build_Guide.md)
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
out="${1:-.bundle/Portfolio_Beach_Build_Guide.md}"
mkdir -p "$(dirname "$out")"

files=(
  README.md
  CLAUDE.md
  docs/10_DATA_CLEARANCE.md
  docs/16_GITHUB_AND_CLAUDE_CODE_CLOUD.md
  docs/01_PRODUCT_CONTEXT.md
  docs/02_ARCHITECTURE.md
  docs/03_DATA_MODEL.md
  docs/04_MODULES.md
  docs/05_SECURITY.md
  docs/06_BRAND_AND_UI.md
  docs/07_AI_AGENTS_AND_HOUSE_STYLE.md
  docs/08_CALCULATIONS_SPEC.md
  docs/09_ROADMAP_AND_BACKLOG.md
  docs/11_CAPABILITY_CHECKLIST.md
  docs/12_TESTING_AND_QUALITY.md
  docs/13_BUILD_APPROACH.md
  docs/14_SYNTHETIC_DATA_SPEC.md
  docs/15_AI_OPERATIONS.md
  docs/17_ENGINEERING_STANDARDS.md
  docs/18_WORKFLOWS_AND_STATE_MACHINES.md
)
# Decision records and prompts in name order.
while IFS= read -r f; do files+=("$f"); done < <(ls docs/decisions/*.md prompts/*.md | sort)

: > "$out"
first=1
for f in "${files[@]}"; do
  [[ -f "$f" ]] || { echo "bundle-guide: missing $f" >&2; exit 1; }
  if [[ $first -eq 1 ]]; then first=0; else printf '\n---\n<!-- FILE: %s -->\n' "$f" >> "$out"; fi
  cat "$f" >> "$out"
done
echo "bundle-guide: wrote $out ($(wc -l < "$out") lines from ${#files[@]} files)"
