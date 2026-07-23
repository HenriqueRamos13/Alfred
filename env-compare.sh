#!/usr/bin/env bash
# env-compare.sh — compare your local .env against .env.example.
#
# `git pull` updates .env.example but never your .env (it's gitignored), so after
# an update this tells you what changed WITHOUT printing any secret values:
#   - keys new in the template you don't have yet (all optional — they have
#     defaults, so you rarely need to add them);
#   - keys you have that the template no longer lists (renamed / removed);
#   - values that would break `source .env` in start.sh (unquoted parens/specials).
#
# Usage: ./env-compare.sh [envfile] [examplefile]   (defaults: .env .env.example)
set -euo pipefail
cd "$(dirname "$0")"

ENVFILE="${1:-.env}"
EXAMPLE="${2:-.env.example}"

[[ -f "$EXAMPLE" ]] || { echo "no $EXAMPLE here — run this from the repo root" >&2; exit 1; }
if [[ ! -f "$ENVFILE" ]]; then
  echo "You have no $ENVFILE yet. Create it:  cp $EXAMPLE $ENVFILE"
  exit 0
fi

# Key names only — handles commented optional keys ("# KEY=") in the example.
# Never emits values, so secrets in .env are never printed.
keys() { grep -oE '^[[:space:]]*#?[[:space:]]*[A-Z_][A-Z0-9_]*=' "$1" 2>/dev/null | tr -cd 'A-Z0-9_=\n' | sed 's/=$//' | sort -u; }

new_keys=$(comm -23 <(keys "$EXAMPLE") <(keys "$ENVFILE") || true)
extra_keys=$(comm -13 <(keys "$EXAMPLE") <(keys "$ENVFILE") || true)
# Footgun: an unquoted value containing () breaks `set -a; source .env` in start.sh.
bad=$(grep -nE '^[A-Z_][A-Z0-9_]*=[^"'\''].*[()]' "$ENVFILE" 2>/dev/null | sed -E 's/=.*/= <hidden>/' || true)

echo "== new in $EXAMPLE, missing from $ENVFILE (optional — have defaults) =="
[[ -n "$new_keys" ]] && echo "$new_keys" | sed 's/^/  + /' || echo "  (none — you're up to date)"
echo
echo "== in your $ENVFILE but not in $EXAMPLE (extra / renamed / removed) =="
[[ -n "$extra_keys" ]] && echo "$extra_keys" | sed 's/^/  - /' || echo "  (none)"
echo
echo "== values that break 'source .env' (unquoted parens — wrap in \"quotes\") =="
if [[ -n "$bad" ]]; then
  echo "$bad" | sed 's/^/  ! line /'
else
  echo "  (none)"
fi
