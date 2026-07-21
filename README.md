# Alfred

A personal, open-source **Agent OS** for your Mac. Alfred is an Electron app
that runs natively on **Intel Macs** (Mac Pro 2019, MacBook Pro 2018–2020 — not
Apple Silicon) and gives Claude a control-centre UI plus the tools to actually
drive the machine: filesystem, shell, a real browser, and read-only Gmail.

> Not "Jarvis". Alfred.

## What it does (MVP)

- **Provider-agnostic orchestrator** on top of the [Vercel AI SDK](https://sdk.vercel.ai),
  streaming to a neon control UI. Swap brains without touching the loop (see
  **Brains / Providers** below). Default brain: Anthropic `claude-sonnet-5`.
- **Generative UI** — Claude renders panels, tables, stat tiles, logs, etc. into
  a live "surface" through a whitelisted component registry (never arbitrary JSX).
- **Governance** — every action is risk-tiered (T0–T3). Destructive / sending /
  installing actions pause for **human approval** in the UI. A trifecta rule
  blocks data egress when untrusted + private + outbound all meet in a session.
- **Budget & kill-switch** — per-day/per-session token caps, per-task step cap,
  and loop detection. Exceed → hard stop.
- **Projects (ICM)** — "build me a todo app" creates a folder under the
  workspace with a canonical `.alfred/PROJECT.md` manifest, indexed in SQLite.
- **Memory (ICM)** — stable, human-curated `preferences.md` / `house-rules.md`
  plus per-session working notes.
- **Secrets** — stored in the macOS Keychain via the `security` CLI, never on disk.
- **Overlay window** — by default the HUD opens on the **current screen** (the
  display under the cursor) and is sized to fill it, so it is always fully
  visible. Toggle visibility with `⌘/Ctrl+Shift+A` or `⌘/Ctrl+Shift+H`.
- **Multi-monitor spanning (opt-in)** — set `ALFRED_SPAN_DISPLAYS=1` to have the
  overlay span the whole virtual desktop (union of all displays), so cards drag
  freely between monitors.
  > macOS note: spanning requires **turning OFF** "Displays have separate
  > Spaces" (System Settings → Desktop & Dock → Mission Control) and logging
  > out/in, and ideally monitors on the same scale. If it's ON — or scales
  > differ — macOS confines the overlay to a single monitor and the content can
  > end up outside the visible area. Leave spanning off if unsure.

## Architecture

Electron, three processes:

| Process   | Responsibility |
|-----------|----------------|
| **main** (Node) | orchestrator, tools, governance, SQLite, IPC |
| **preload**     | `contextBridge` safe API (`contextIsolation` on, `nodeIntegration` off) |
| **renderer** (React) | control window + generative UI surface |

Everything the AI can render maps through a whitelist:
`Panel, StatTile, Card, DataTable, Markdown, LogFeed, AgentStatus, ProjectList`.
App-driven UI (`CommandBar, ChatLog, ApprovalPrompt`) is not AI-renderable.

Data lives in `data/` (SQLite `alfred.db`, browser profile) — git-ignored.

## Brains / Providers

Alfred is provider-agnostic (Vercel AI SDK). Four brains ship by default; each is
selectable and independently configurable in `.env`. A brain is **enabled** only
when its key (or CLI) is present. The default active brain is **Anthropic** —
set `ALFRED_PROVIDER` to change it.

| Brain | Env | Default model | Notes |
|-------|-----|---------------|-------|
| **Anthropic** (default) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | `claude-sonnet-5` | The active brain out of the box. |
| **OpenAI / ChatGPT** | `OPENAI_API_KEY`, `OPENAI_MODEL` | `gpt-4o` | |
| **DeepSeek** | `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | `deepseek-v4-flash` | `deepseek-v4-pro` also available. (`deepseek-chat`/`deepseek-reasoner` retired 2026-07-24.) |
| **Claude Code CLI** | — (binary on `PATH`) | `claude -p` | Delegation brain, not a chat API — see below. |

- **Pick the default brain:** `ALFRED_PROVIDER=anthropic|openai|deepseek`.
- **Model IDs are adjustable** — the defaults above are just placeholders; set
  them to whatever your account can access.
- **Fallback:** if the selected brain isn't enabled, Alfred falls back to the
  first enabled brain and logs it clearly.
- **Delegation (`claude -p`):** the `delegate_to_claude_code` tool spawns the
  headless Claude Code CLI to grind a self-contained task to completion and
  returns its JSON result. It's a **T2** action (needs approval) and requires the
  CLI on your `PATH`:

  ```bash
  npm i -g @anthropic-ai/claude-code
  ```

  If `claude` isn't found, the tool returns a clear error instead of crashing.

Keys are read only from `process.env`, never logged, and masked in the audit log.

## Setup (from a factory Intel Mac)

```bash
git clone <your-fork-url> alfred && cd alfred
./setup.sh          # installs Xcode CLT, Homebrew, Node 22, deps, native rebuild
cp .env.example .env  # then fill in your keys (setup.sh does this for you)
./start.sh          # day-to-day: this is all you need to launch Alfred
```

After the initial setup, day-to-day launching is just `./start.sh` — it loads
`.env` and runs the dev app in one command.

Then grant the app the macOS permissions it needs to control the Mac:
**System Settings → Privacy & Security → Accessibility** and **Screen Recording**
→ enable your terminal (and later the packaged Alfred app).

Requirements: macOS on Intel (x86_64), Node 22 LTS.

## Voice input (speech-to-text)

Click the 🎙 mic in the command bar to dictate. Recognition runs **on-device**
via Apple's `SFSpeechRecognizer` (on Intel the engine is the classic
`SFSpeechRecognizer`, **not** the newer `SpeechAnalyzer` — that's Apple-Silicon /
newer-OS only). The transcript is dropped into the input; you still press Enter
to send, so nothing is dispatched by accident. It stops when you click again, on
prolonged silence, or via the kill switch. Language defaults to `en-US`; override
with `ALFRED_STT_LOCALE` (e.g. `pt-PT`) or the `--locale` helper flag.

A small Swift helper does the listening (`native/alfred-stt`). `./setup.sh`
compiles it via `xcrun` (which pins the correct macOS SDK/toolchain); the source
is committed, the binary is gitignored. Voice input is **optional** — if the
helper fails to build, `setup.sh` warns and continues, and Alfred still runs
(text input and voice output keep working). If you see *"voice input helper not
found"*, re-run `./setup.sh`.

### Troubleshooting: CoreFoundation / Swift build

If the Swift compile fails (e.g. *"failed to load module CoreFoundation"*), the
macOS toolchain is usually mis-pointed. `./setup.sh` now attempts this repair
automatically (it resets the toolchain and, if needed, reinstalls the Command
Line Tools) before compiling — so re-running `./setup.sh` is usually enough. To
repair it by hand instead, then recompile manually:

```sh
xcode-select -p            # show the active developer dir
sudo xcode-select --reset  # reset to the default toolchain
xcode-select --install     # (re)install the Command Line Tools

# recompile the helper (xcrun resolves the SDK + frameworks):
xcrun --sdk macosx swiftc native/alfred-stt.swift -o native/alfred-stt \
  -framework Foundation -framework AVFoundation -framework Speech
```

**Permissions (dev-mode caveat):** on first use macOS prompts for **Microphone**
and **Speech Recognition**. In `npm run dev` those permissions attach to the
**Electron binary** (Alfred appears in *System Settings › Privacy & Security ›
Microphone* and *› Speech Recognition* as Electron), not to a "Alfred.app" — a
packaged build attaches them to Alfred itself. Grant both or dictation fails
with an authorization error.

## Connecting Gmail (read-only)

Alfred reads mail with the `gmail.readonly` scope only. You supply your own
OAuth client:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → create
   (or pick) a project.
2. **APIs & Services → Enable APIs** → enable the **Gmail API**.
3. **OAuth consent screen** → External → add yourself as a test user.
4. **Credentials → Create credentials → OAuth client ID** → *Desktop app*.
5. Copy the client ID and secret into `.env`
   (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`).
6. In Alfred, ask it to *connect Gmail*; it runs the OAuth flow and stores the
   token in your Keychain. The token never touches disk.

## Development

```bash
npm run dev        # electron-vite dev
npm run build      # electron-vite build
npm run rebuild    # rebuild native modules for Electron
npm test           # pure-logic tests (node --test, no native deps)
npm run typecheck  # tsc --noEmit
```

## License

MIT © 2026 Henrique Ramos
