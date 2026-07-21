#!/usr/bin/env bash
# Alfred — one-command day-to-day start. Run ./setup.sh once first.
set -euo pipefail

cd "$(dirname "$0")"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

# 1. Node present?
if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Run ./setup.sh first." >&2
  exit 1
fi

# 2. Dependencies installed?
if [[ ! -d node_modules ]]; then
  say "Installing npm dependencies"
  npm install
  say "Rebuilding native modules for Electron"
  npm run rebuild
fi

# 3. Environment file present?
if [[ ! -f .env ]]; then
  say "Creating .env from template"
  cp .env.example .env
  echo "Edit .env and set your ANTHROPIC_API_KEY / DEEPSEEK_API_KEY, then run ./start.sh again." >&2
  exit 1
fi

# 4. Load .env into the environment (works even before the app reads it itself).
set -a; source ./.env; set +a

# 5. Go.
say "Starting Alfred"
exec npm run dev
