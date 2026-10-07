#!/usr/bin/env bash
# House-style check (docs/07, CLAUDE.md rule 15): no em dashes anywhere, and no banned phrases
# from config/style.json in user-facing text, prompts, docs or fixtures.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

mapfile -t FILES < <(git ls-files 2>/dev/null)
TEXT_FILES=()
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue
  case "$f" in
    *.png|*.jpg|*.pdf|*.xlsx|*.docx|*.pptx|*.zip|*.ico|*.woff|*.woff2|pnpm-lock.yaml|uv.lock|config/style.json|scripts/check-style.sh|scripts/check-employer-data.sh) continue ;;
  esac
  TEXT_FILES+=("$f")
done
[[ ${#TEXT_FILES[@]} -eq 0 ]] && { echo "check-style: nothing to scan"; exit 0; }

fail=0
emdash=$(grep -rIl $'\xe2\x80\x94' "${TEXT_FILES[@]}" 2>/dev/null || true)
if [[ -n "$emdash" ]]; then echo "BLOCKED: em dashes in: $(echo "$emdash" | tr '\n' ' ')"; fail=1; fi

# Banned phrases from config/style.json (highlights.bannedPhrases), matched case-insensitively.
if command -v node >/dev/null 2>&1 && [[ -f config/style.json ]]; then
  mapfile -t BANNED < <(node -e 'const s=require("./config/style.json");for(const p of (s.highlights?.bannedPhrases??[]))console.log(p)')
  for phrase in "${BANNED[@]}"; do
    [[ -z "$phrase" ]] && continue
    hits=$(grep -rIil -F -- "$phrase" "${TEXT_FILES[@]}" 2>/dev/null | grep -vE '^(docs/07_AI_AGENTS_AND_HOUSE_STYLE\.md|packages/ai/.*evals?/.*|packages/validation/src/.*\.test\.ts)$' || true)
    if [[ -n "$hits" ]]; then echo "BLOCKED: banned phrase '$phrase' in: $(echo "$hits" | tr '\n' ' ')"; fail=1; fi
  done
fi

if [[ $fail -eq 0 ]]; then echo "check-style: OK (${#TEXT_FILES[@]} files)"; fi
exit $fail
