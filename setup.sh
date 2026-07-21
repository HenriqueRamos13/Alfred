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

# 2. Homebrew.
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# Load brew into this shell (Intel Homebrew lives in /usr/local).
eval "$(/usr/local/bin/brew shellenv 2>/dev/null || /opt/homebrew/bin/brew shellenv)"

# 3. Node 22 LTS.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  say "Installing Node 22 (LTS)"
  brew install node@22
  brew link --overwrite --force node@22
fi

# 4. Dependencies + native module rebuild for Electron.
say "Installing npm dependencies"
npm install

say "Rebuilding native modules for Electron"
npm run rebuild

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
  3. Start it:  npm run dev

EOF
