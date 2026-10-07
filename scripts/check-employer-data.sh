#!/usr/bin/env bash
# Blocks employer information and risky content from entering the repo.
# 1) Terms from config/local/denylist.txt (local machine only, gitignored).
# 2) Generic patterns that work everywhere (CI, cloud sandbox).
# Usage: scripts/check-employer-data.sh [--staged]
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

if [[ "${1:-}" == "--staged" ]]; then
  mapfile -t FILES < <(git diff --cached --name-only --diff-filter=ACMR)
else
  mapfile -t FILES < <(git ls-files 2>/dev/null || find . -type f -not -path './.git/*')
fi

# Skip binaries, lockfiles and this script itself.
TEXT_FILES=()
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue
  case "$f" in
    *.png|*.jpg|*.pdf|*.xlsx|*.docx|*.pptx|*.zip|*.ico|*.woff|*.woff2|pnpm-lock.yaml|*/pnpm-lock.yaml|uv.lock|*/uv.lock|scripts/check-employer-data.sh) continue ;;
  esac
  TEXT_FILES+=("$f")
done
[[ ${#TEXT_FILES[@]} -eq 0 ]] && { echo "check-employer-data: nothing to scan"; exit 0; }

fail=0
report() { echo "BLOCKED: $1"; fail=1; }

# 1) Local deny-list (exact terms, case-insensitive). Never printed in full.
DENY="config/local/denylist.txt"
if [[ -f "$DENY" ]]; then
  while IFS= read -r term || [[ -n "$term" ]]; do
    term="${term%%#*}"; term="$(echo "$term" | xargs)"
    [[ -z "$term" ]] && continue
    hits=$(grep -rIil -F -- "$term" "${TEXT_FILES[@]}" 2>/dev/null || true)
    [[ -n "$hits" ]] && report "deny-list term found in: $(echo "$hits" | tr '\n' ' ')"
  done < "$DENY"
fi

# 2a) Email addresses outside reserved example domains.
emails=$(grep -rIhoE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" "${TEXT_FILES[@]}" 2>/dev/null \
  | grep -viE "@(example\.(com|org|net)|[a-z0-9-]+\.example|[a-z0-9-]+\.test|[a-z0-9-]+\.invalid|users\.noreply\.github\.com)$" | sort -u || true)
[[ -n "$emails" ]] && report "non-example email addresses: $(echo "$emails" | tr '\n' ' ')"

# 2b) Phone numbers in common US formats (synthetic data should use 555-01xx).
phones=$(grep -rIhoE "\(?\b[2-9][0-9]{2}\)?[-. ][0-9]{3}[-. ][0-9]{4}\b" "${TEXT_FILES[@]}" 2>/dev/null | grep -vE "555[-. ]01[0-9]{2}" | sort -u || true)
[[ -n "$phones" ]] && report "phone numbers (use 555-01xx in synthetic data): $(echo "$phones" | tr '\n' ' ')"

# 2c) Bank routing / SWIFT-like identifiers next to banking words.
bank=$(grep -rIniE "\b(aba|routing|swift|iban|account (number|no))\b[^a-z0-9]{0,15}[0-9A-Z]{8,}" "${TEXT_FILES[@]}" 2>/dev/null | grep -viE "example|placeholder|xxxx|0000000" || true)
[[ -n "$bank" ]] && report "possible bank details: $(echo "$bank" | cut -c1-120 | tr '\n' ' ')"

# 2d) Secrets that slipped past secret scanning.
secrets=$(grep -rIlE "(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AccountKey=[A-Za-z0-9+/=]{20,})" "${TEXT_FILES[@]}" 2>/dev/null || true)
[[ -n "$secrets" ]] && report "possible secrets in: $(echo "$secrets" | tr '\n' ' ')"

# 2e) Em dashes (house style).
emdash=$(grep -rIl $'\xe2\x80\x94' "${TEXT_FILES[@]}" 2>/dev/null || true)
[[ -n "$emdash" ]] && report "em dashes in: $(echo "$emdash" | tr '\n' ' ')"

if [[ $fail -eq 0 ]]; then echo "check-employer-data: OK (${#TEXT_FILES[@]} files)"; fi
exit $fail
