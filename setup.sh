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

# 4b. Compile the on-device speech-to-text helper (Swift → native binary).
#     Uses SFSpeechRecognizer + AVAudioEngine; only builds on macOS. VOICE INPUT
#     IS OPTIONAL — Alfred runs fine without this binary (stt.ts handles it being
#     absent), so a compile failure here must NOT abort the rest of setup.
#     xcrun pins the correct macOS SDK/toolchain; a bare `swiftc` can fail to
#     resolve CoreFoundation on a half-configured Command Line Tools install.
#     Source is committed; binary is gitignored.
say "Compiling the voice-input helper (native/alfred-stt)"
stt_voice_warning() {
  cat >&2 <<'WARN'

⚠  Warning: failed to compile the voice-input helper (STT).
   Alfred runs fine anyway; text input and voice output (TTS) still work.
   If you want voice INPUT, check the macOS toolchain:
     xcode-select -p            # where are the tools?
     sudo xcode-select --reset  # reset to the default toolchain
     xcode-select --install     # (re)install the Command Line Tools
   Then recompile manually:
     xcrun --sdk macosx swiftc native/alfred-stt.swift -o native/alfred-stt \
       -framework Foundation -framework AVFoundation -framework Speech
WARN
}
if ! command -v xcrun >/dev/null 2>&1 || ! xcode-select -p >/dev/null 2>&1; then
  # Missing toolchain — skip, don't abort (xcrun resolves the SDK for swiftc).
  stt_voice_warning
elif ! xcrun --sdk macosx swiftc native/alfred-stt.swift -o native/alfred-stt \
       -framework Foundation -framework AVFoundation -framework Speech; then
  # swiftc already printed its full error above (we don't silence it).
  stt_voice_warning
fi

# 5. Environment file.
if [[ ! -f .env ]]; then
  say "Creating .env from template — edit it and add your keys"
  cp .env.example .env
fi

# 6. Optional: pre-warm the Kokoro TTS model (voice output). The ~300MB weights
#    otherwise download lazily on Alfred's first spoken reply. Set
#    ALFRED_PREWARM_TTS=1 to fetch them now. Voice defaults to 'af_heart';
#    override with ALFRED_TTS_VOICE.
if [[ "${ALFRED_PREWARM_TTS:-0}" == "1" ]]; then
  say "Pre-warming Kokoro TTS model (downloading weights)"
  node -e "import('kokoro-js').then(m=>m.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX',{dtype:'q8'})).then(()=>console.log('Kokoro model cached')).catch(e=>{console.error(e);process.exit(1)})"
fi

cat <<'EOF'

✅ Alfred is set up.

Next:
  1. Edit .env and add ANTHROPIC_API_KEY (and Gmail OAuth if you want mail).
  2. Grant the terminal (and later the Alfred app) permission under
     System Settings → Privacy & Security → Accessibility AND Screen Recording.
  3. Start it:  ./start.sh

EOF
