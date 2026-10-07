#!/usr/bin/env bash
# Installs a pre-push hook that runs the employer-data check. Run once on each machine.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
hook="$root/.git/hooks/pre-push"
cat > "$hook" <<'H'
#!/usr/bin/env bash
"$(git rev-parse --show-toplevel)/scripts/check-employer-data.sh" || { echo "Push blocked by employer-data check."; exit 1; }
H
chmod +x "$hook"
echo "pre-push hook installed"
