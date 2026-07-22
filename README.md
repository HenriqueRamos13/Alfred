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
- **System control & status** — the `system` tool lets Alfred use the Mac like
  its own: read battery, volume, brightness, displays and Wi-Fi; list running
  apps / the frontmost app; open and quit apps; post native (Electron)
  notifications; read/write the clipboard; keep the machine awake
  (`caffeinate`); and lock, sleep or screenshot it. It prefers no-TCC shell
  commands and native Electron APIs, and returns a clear error (never a crash)
  when a macOS permission or optional CLI is missing — see **macOS permissions**.
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

It follows a **hexagonal (ports & adapters)** design: a provider-agnostic
domain core (`src/main/core` — orchestrator, governance, budget, memory,
curator, layout, providers) surrounded by driven adapters (`src/main/tools/*`,
the model providers, voice, the macOS Keychain, SQLite) and driving adapters
(the Electron shell, IPC bridge, and React UI). The full map, an ASCII data-flow
diagram, and "how to extend" guides are in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

Everything the AI can render maps through a whitelist:
`Panel, StatTile, Card, DataTable, Markdown, LogFeed, AgentStatus, ProjectList`.
App-driven UI (`CommandBar, ChatLog, ApprovalPrompt`) is not AI-renderable.

Data lives in `data/` (SQLite `alfred.db`, browser profile) — git-ignored.
For the agent-facing operating manual (capabilities, governance summary, task
routing) see **[AGENTS.md](AGENTS.md)** and the `docs/` tree.

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

- **MCP bridge (`claude -p` gets Alfred's tools):** whenever Alfred spawns
  `claude -p` — both the Claude Code brain and the `delegate_to_claude_code`
  tool — it also starts an **in-process MCP server** (Streamable HTTP, bound to a
  random `127.0.0.1` port, bearer-token authenticated) and points the CLI at it
  with `--mcp-config` + `--allowedTools`. That exposes Alfred's whole tool
  registry (`ui_layout`, `system`, `memory`, `filesystem`, `browser`, `render_ui`,
  …) to Claude Code as `mcp__alfred__<tool>` tools. Every such call runs the real
  `Tool.execute` with Alfred's real context, so **governance is not bypassed**:
  T2/T3 still prompt for approval (in the Alfred UI), DANGEROUS mode auto-approves,
  the trifecta rule applies, and every call is audited. This is how Claude Code can
  rearrange your cards with `ui_layout` or read memory. It's on by default;
  disable with `ALFRED_MCP_BRIDGE=0`. If the bridge can't start (or the CLI can't
  reach it), `claude -p` just runs with its own tools — no crash.

Keys are read only from `process.env`, never logged, and masked in the audit log.
The MCP bridge token is likewise never logged and never leaves `127.0.0.1`.

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

### macOS permissions (TCC) for the `system` tool

Most `system` ops need no permission (battery, volume, Wi-Fi, displays,
clipboard, notifications, open apps, caffeinate, lock use plain shell / native
Electron APIs). A few do, and Alfred returns a clear error — never a crash —
when the permission or an optional CLI is missing:

| Op | Needs |
|----|-------|
| `app_quit`, `app_frontmost`, `sleep`, `apps_running` (fallback) | **Automation** (Privacy & Security → Automation) — they drive AppleScript |
| `screenshot` | **Screen Recording** (Privacy & Security → Screen Recording) |
| `brightness_get`, `brightness_set` | the `brightness` CLI → `brew install brightness` |

In `npm run dev` these attach to the **Electron** binary; a packaged build
attaches them to Alfred itself.

## Environment variables

All configuration is via `.env` (loaded at boot; see `.env.example`). Nothing is
required to *launch* Alfred, but at least one brain must be enabled to get a
reply. Keys are read only from `process.env`, never logged, and masked in the
audit.

| Variable | Default | What it does |
|----------|---------|--------------|
| `ALFRED_PROVIDER` | `anthropic` | Default active brain: `anthropic` \| `openai` \| `deepseek`. |
| `ANTHROPIC_API_KEY` | — | Enables the Anthropic brain (a key containing `xxxx` is treated as a placeholder = disabled). |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Anthropic model id. |
| `OPENAI_API_KEY` | — | Enables the OpenAI/ChatGPT brain. |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model id. |
| `DEEPSEEK_API_KEY` | — | Enables the DeepSeek brain. |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | DeepSeek model id (`deepseek-v4-pro` also priced). |
| `ALFRED_MODEL` | — | Legacy alias for `ANTHROPIC_MODEL` (used only if it is unset). |
| `ALFRED_CURATOR_MODEL` | cheapest enabled brain | Model the memory curator uses (usually DeepSeek by price). |
| `ALFRED_WORKSPACE` | `~/AlfredWorkspace` | Where projects + memory live. |
| `ALFRED_DAILY_TOKEN_BUDGET` | `2000000` | **Hard** daily token kill-switch across all sessions. |
| `ALFRED_DAILY_USD_BUDGET` | unset | **Soft** daily USD warning (estimated); warns, never blocks. |
| `ALFRED_STEP_CAP` | `40` | Max tool/model steps per task. |
| `ALFRED_MCP_BRIDGE` | on | `0`/`false`/`off`/`no` disables the in-process MCP bridge that gives `claude -p` Alfred's governed tools. |
| `ALFRED_PRICING_JSON` | — | Path to a pricing-override JSON (`{ "model": { inputPerM, outputPerM } }`); else `data/pricing.json`. |
| `ALFRED_WINDOW_MODE` | `overlay` | `overlay` (frameless click-through HUD) or `windowed` (classic window). |
| `ALFRED_SPAN_DISPLAYS` | `0` | `1`/`true` → one overlay spans the whole virtual desktop (see multi-monitor note). |
| `ALFRED_AUTOHIDE_TOP` | on | `0` disables auto-hiding the top command/toolbar strip. |
| `ALFRED_TTS_ENGINE` | `say` | Voice-output engine: `say` (macOS, pt-BR) or `kokoro` (English). |
| `ALFRED_TTS_VOICE` | `Luciana` / `af_heart` | Voice name (per engine). |
| `ALFRED_TTS_RATE` | — | `say` speaking rate (words/min). |
| `ALFRED_TTS_DTYPE` | `fp32` | `kokoro` precision: `q8` \| `q4` \| `fp16` \| `fp32`. |
| `ALFRED_PREWARM_TTS` | `0` | `setup.sh`: `1` pre-downloads the Kokoro weights. |
| `ALFRED_STT_LOCALE` | `pt-BR` | Speech-recognition language (e.g. `en-US`, `pt-PT`). |
| `ALFRED_STT_SILENCE` | `2.0` | Silence (seconds) that ends a push-to-talk session. |
| `ALFRED_WAKEWORD` | `alfred` | Wake trigger (also matches the ASR variant `alfredo`). |
| `GOOGLE_OAUTH_CLIENT_ID` | — | Google OAuth client for read-only Gmail (see below). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | Google OAuth client secret. |

## Voice input (speech-to-text)

Click the 🎙 mic in the command bar to dictate. Recognition runs **on-device**
via Apple's `SFSpeechRecognizer` (on Intel the engine is the classic
`SFSpeechRecognizer`, **not** the newer `SpeechAnalyzer` — that's Apple-Silicon /
newer-OS only). The transcript is dropped into the input; you still press Enter
to send, so nothing is dispatched by accident. It stops when you click again, on
prolonged silence, or via the kill switch. Language defaults to `pt-BR`
(Brazilian Portuguese); override with `ALFRED_STT_LOCALE` (e.g. `en-US`, `pt-PT`)
or the `--locale` helper flag.

**On-device model must be installed for your locale.** On-device recognition
only works if the language pack is present. The default `pt-BR` is **not**
installed on a factory Mac — add it in **System Settings → Keyboard → Dictation
→ Edit** and add *Português (Brasil)* (this downloads the on-device model). Until
then Alfred falls back to **server** recognition, which needs an internet
connection. If neither is available for the locale, the helper reports it **once**
(no error spam) and disables voice for that locale — the fix is one of: install
the model, connect to the internet, or switch to a locale that is installed
(e.g. `ALFRED_STT_LOCALE=en-US`).

A small Swift helper does the listening (`native/alfred-stt`). `./setup.sh`
compiles it via `xcrun` (which pins the correct macOS SDK/toolchain); the source
is committed, the binary is gitignored. Voice input is **optional** — if the
helper fails to build, `setup.sh` warns and continues, and Alfred still runs
(text input and voice output keep working). If you see *"voice input helper not
found"*, re-run `./setup.sh`.

### Wake word ("Alfred", always-on)

Toggle **👂 WAKE** in the top bar to have Alfred listen continuously for the
wake word — say *"Alfred, …"* and the command that follows is dropped into the
input (you still press Enter, exactly like the mic button). It is **local and
account-free**: it reuses the same Apple `SFSpeechRecognizer` helper in a
continuous `--wake` mode (the ~1min request limit is worked around by recycling
the recognition task automatically). The wake word is `alfred` (also matches the
common ASR mishearing *"alfredo"*); override with `ALFRED_WAKEWORD`. Locale is
the shared `ALFRED_STT_LOCALE` (default `pt-BR`).

- **The helper gained a `--wake` mode, so recompile** — `./setup.sh` already does
  this; just re-run it after updating.
- Default: **on** when the STT helper is compiled (it needs no account); off
  otherwise. The choice is persisted.
- **CPU note:** always-on recognition uses noticeably more CPU than push-to-talk,
  and its reliability is **lower than a dedicated wake-word engine** (e.g.
  Porcupine) — it is a best-effort local option, not a precision trigger.
- Single mic owner: pressing the 🎙 mic pauses the wake listener for the manual
  dictation, then resumes it. The kill switch stops both.
- **Needs an installed on-device model too** (same as push-to-talk above): the
  default `pt-BR` requires *Português (Brasil)* added in **System Settings →
  Keyboard → Dictation**, else it uses server recognition (needs internet), else
  `ALFRED_STT_LOCALE=en-US`. If the locale can't run at all, wake reports it
  **once**, disables itself (no respawn loop / no error spam), and stays off
  until you re-toggle **👂 WAKE** after fixing it.

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

## Voice output (text-to-speech)

Alfred can speak his replies — toggle it in the top bar (OFF by default). **The
voice defaults to Brazilian Portuguese (pt-BR)** via the `say` engine and the
`Luciana` voice. Pick the engine with `ALFRED_TTS_ENGINE`:

| Engine | Languages | Config |
|--------|-----------|--------|
| **say** (default, macOS built-in) | pt-BR + many others | `ALFRED_TTS_VOICE`, `ALFRED_TTS_RATE` |
| **kokoro** | English (US/UK) only | `ALFRED_TTS_VOICE`, `ALFRED_TTS_DTYPE` |

**Brazilian Portuguese (pt-BR) → `say` (default).** Uses the macOS `say`
command, which plays the audio itself (nothing to download).

- `ALFRED_TTS_VOICE` — `Luciana` (♀, default) or `Felipe` (♂) for pt-BR. If the
  named voice isn't installed, Alfred retries once with the system default voice
  so it never goes silent. Run `say -v '?'` to list the voices installed on the
  Mac.
- `ALFRED_TTS_RATE` — speaking rate in words/min (optional, e.g. `180`).
- **For far more natural output — and to guarantee the voice is present**,
  download an *enhanced* / *premium* pt-BR voice in **System Settings →
  Accessibility → Spoken Content → Manage Voices**. The compact `Luciana` may not
  be installed (the retry then falls back to the system voice); installing the
  enhanced voice fixes both quality *and* availability.

**Natural English → `kokoro`.** Runs in Node via
[kokoro-js](https://github.com/hexgrad/kokoro) (no Python); the weights download
lazily on the first spoken reply (or pre-warm at setup with
`ALFRED_PREWARM_TTS=1`).

- `ALFRED_TTS_VOICE` — grade-A voices: `af_heart` (default), `af_bella`; male
  `am_michael` / `am_puck` / `bm_george`.
- `ALFRED_TTS_DTYPE` — model precision: `q8 | q4 | fp16 | fp32` (default
  `fp32`). **`fp32` sounds noticeably less robotic**; `q8` is smaller and
  faster on CPU.

```bash
# back to English
ALFRED_TTS_ENGINE=kokoro
ALFRED_TTS_VOICE=af_heart
ALFRED_STT_LOCALE=en-US
```

Both engines share one serialised queue and the same kill switch, so replies
never overlap and a stop silences whatever is mid-sentence.

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

## Security & governance model

Every tool call is classified into a **risk tier** and the rails are **enforced
in code** (`src/main/core/governance.ts` + the orchestrator), not by prompt text:

- **T0** read/search/list · **T1** reversible workspace writes — run freely.
- **T2** delete / send / install / egress / delegation · **T3** money /
  credentials — block on a **human approval** shown in the UI (5-minute timeout =
  deny).
- **Trifecta-lite**: if a session has read untrusted content *and* holds private
  data *and* is about to send data outward, that egress is escalated to an
  approval — a guard against exfiltration.
- **Kill-switch + caps**: a hard daily token budget, a per-task step cap, and
  identical-call loop detection hard-stop a task. These are **not** bypassed by
  DANGEROUS mode.
- **DANGEROUS mode** (user-only toggle) bypasses *approvals* — never the
  kill-switch, step cap, loop detection, or per-tool constraints.
- Secrets live in the macOS Keychain and are masked in the audit; every call is
  audited (tool, masked args, tier, status, provenance).

Details: [docs/governance/risk-tiers.md](docs/governance/risk-tiers.md),
[approval-flow.md](docs/governance/approval-flow.md),
[dangerous-mode.md](docs/governance/dangerous-mode.md).

> **Honest limitations.** Alfred targets **Intel** Macs, so STT is Apple's
> classic `SFSpeechRecognizer` (not the Apple-Silicon `SpeechAnalyzer`), and the
> account-free wake word is best-effort — less reliable than a dedicated engine
> like Porcupine. The `filesystem`/`shell` tools have **no sandbox** (an absolute
> path or command can reach anything the OS user can); the approval rails, not a
> jail, are the boundary. These are acceptable for a **single-user, local dev**
> tool and would need hardening before any multi-user or hosted use.

## Development

```bash
npm run dev        # electron-vite dev
npm run build      # electron-vite build
npm run rebuild    # rebuild native modules for Electron
npm test           # pure-logic tests (node --test, no native deps)
npm run typecheck  # tsc --noEmit
```

Contributing (how to run, test, and the repo layout):
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © 2026 Henrique Ramos
