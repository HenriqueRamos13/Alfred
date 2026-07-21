#!/usr/bin/env bash
# Alfred setup — from a factory Intel Mac to a running dev app.
set -euo pipefail

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Alfred targets macOS (Intel). This script only runs on a Mac." >&2
  exit 1
fi

# 1. Xcode Command Line Tools (compiler + git) — needed for native modules.
if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing Xcode Command Line Tools (a dialog will appear — accept it)"
  xcode-select --install || true
  echo "Re-run ./setup.sh once the Command Line Tools finish installing."
  exit 0
fi

# 2. Node 22 LTS via nvm.
export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  say "Installing nvm"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

say "Installing Node 22 (LTS) via nvm"
nvm install 22 && nvm use 22 && nvm alias default 22

# 3. Dependencies + native module rebuild for Electron.
say "Installing npm dependencies"
npm install

say "Rebuilding native modules for Electron"
npm run rebuild

# 4. Playwright Chromium (the browser tool uses it).
say "Installing Playwright Chromium"
npx playwright install chromium

# 5. Environment file.
if [[ ! -f .env ]]; then
  say "Creating .env from template — edit it and add your keys"
  cp .env.example .env
fi

cat <<'EOF'

✅ Alfred is set up.

Next:
  1. Edit .env and add ANTHROPIC_API_KEY (and Gmail OAuth if you want mail).
  2. Grant the terminal (and later the Alfred app) permission under
     System Settings → Privacy & Security → Accessibility AND Screen Recording.
  3. Start it:  ./start.sh

EOF
