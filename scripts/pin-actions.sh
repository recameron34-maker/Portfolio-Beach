#!/usr/bin/env bash
# Pins every `uses: owner/repo@vN` in .github/workflows to the full commit SHA of that tag,
# keeping the tag as a trailing comment (docs/16 section 2, SEC-17.5). Run on a machine with the
# GitHub CLI signed in; the cloud sandbox deliberately cannot read other repositories.
# Usage: bash scripts/pin-actions.sh            (rewrites in place)
#        bash scripts/pin-actions.sh --check    (fails if any action is still tag-pinned)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mode="${1:-}"
status=0
for wf in .github/workflows/*.yml; do
  while IFS= read -r line; do
    ref=$(sed -nE 's/.*uses:[[:space:]]*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.\/-]+)?)@(v[0-9][A-Za-z0-9_.-]*)[[:space:]]*(#.*)?$/\1@\3/p' <<<"$line")
    [[ -z "$ref" ]] && continue
    action="${ref%@*}"; tag="${ref##*@}"; repo="$(cut -d/ -f1,2 <<<"$action")"
    if [[ "$mode" == "--check" ]]; then echo "unpinned: $wf: $action@$tag"; status=1; continue; fi
    sha=$(gh api "repos/$repo/git/ref/tags/$tag" --jq '.object.sha' 2>/dev/null || true)
    if [[ -n "$sha" ]]; then
      obj=$(gh api "repos/$repo/git/tags/$sha" --jq '.object.sha' 2>/dev/null || true) # annotated tag -> commit
      [[ -n "$obj" ]] && sha="$obj"
    fi
    if [[ -z "$sha" ]]; then echo "could not resolve $action@$tag" >&2; status=1; continue; fi
    sed -i -E "s#(uses:[[:space:]]*)${action//./\\.}@${tag}([[:space:]]*#.*)?\$#\1${action}@${sha} # ${tag}#" "$wf"
    echo "pinned $action@$tag -> $sha"
  done < "$wf"
done
exit $status
