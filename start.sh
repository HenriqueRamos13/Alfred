#!/usr/bin/env bash
# Alfred — one-command day-to-day start. Run ./setup.sh once first.
set -euo pipefail

cd "$(dirname "$0")"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

# Load nvm if present so the nvm-managed node is on PATH.
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

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

# 3. Playwright Chromium present? (idempotent — quick if already installed.)
say "Ensuring Playwright Chromium is installed"
npx playwright install chromium

# 4. Environment file present?
if [[ ! -f .env ]]; then
  say "Creating .env from template"
  cp .env.example .env
  echo "Edit .env and set your ANTHROPIC_API_KEY / DEEPSEEK_API_KEY, then run ./start.sh again." >&2
  exit 1
fi

# 5. Load .env into the environment (works even before the app reads it itself).
set -a; source ./.env; set +a

# 6. Go.
say "Starting Alfred"
exec npm run dev
