# Alfred — Overview

The whole story: what Alfred does, how it got here, the decisions behind it, what
it can't do, every environment variable, and where it might go next. For the
code map see [ARCHITECTURE.md](../ARCHITECTURE.md); for the dev workflow see
[DEVELOPMENT.md](DEVELOPMENT.md).

Alfred is a personal, open-source **Agent OS**: an Electron app in which a model
drives a real **Intel Mac** and renders its own always-on control-centre HUD.
The agent loop, tools, and governance are provider-agnostic (Vercel AI SDK);
the guardrails are enforced in code, not prompts.

---

## What Alfred does (features)

- **Provider-agnostic orchestrator** over the Vercel AI SDK — one `streamText`
  loop, four swappable **brains** (Anthropic / OpenAI / DeepSeek / Claude Code
  CLI). The active brain is config-chosen; identity ("you are Alfred") is fixed.
- **Tools that drive the real machine** (each a governed adapter, one registry):
  - `filesystem` — read/write/list/mkdir/delete (no sandbox; approvals are the boundary).
  - `shell` — `/bin/sh -c` with timeout and destructive-command detection.
  - `browser` — real Chromium via Playwright, persistent profile, never types passwords.
  - `system` — battery, volume, brightness, displays, Wi-Fi, apps, notify,
    clipboard, caffeinate, lock/sleep/screenshot, window show/hide/toggle, and
    the grill-me toggle. One `op` per call.
  - `gmail` — read-only Gmail over loopback OAuth (`gmail.readonly` scope only).
  - `memory` — the file-first ICM/Obsidian memory vault.
  - `ui_layout` — inspect and rearrange the floating cards, across monitors.
  - `render_ui` — push a whitelisted UI tree onto the surface (never arbitrary JSX).
  - `project` — ICM folder-as-context projects (`.alfred/PROJECT.md` canonical).
  - `delegate_to_claude_code` — hand a self-contained task to a headless `claude -p`.
- **Governance in code** — every call is risk-tiered T0–T3; T2/T3 block on a
  human approval in the UI; a trifecta-lite rule escalates egress after an
  untrusted read + private data; a token kill-switch, per-task step cap, and
  loop detection hard-stop runaway cost (never bypassed, even in DANGEROUS mode).
- **Generative UI** — the model renders panels, tables, stat tiles, logs, etc.
  through a whitelisted component registry into a live surface.
- **Multi-monitor overlay HUD** — a frameless, transparent, click-through
  window per display (Übersicht-style), with cards that move between monitors;
  a shared `LayoutStore` is the single source of truth for both user drags and
  the AI's `ui_layout` calls.
- **File-first memory (ICM/Obsidian)** — journal, facts, a Zettelkasten vault
  with `[[wikilinks]]`, an MOC index, and a handoff inbox drained by a cheap
  **curator** brain. Plain Markdown under the workspace — human-readable, diffable.
- **Voice** — text-to-speech (macOS `say` for pt-BR / kokoro for English) and
  on-device speech-to-text + an account-free wake word ("Alfred") via Apple
  `SFSpeechRecognizer`. Half-duplex (mutes the mic while speaking).
- **MCP bridge** — when Alfred spawns `claude -p`, an in-process governed
  localhost MCP server exposes Alfred's own tools to the CLI as
  `mcp__alfred__<tool>` — still fully approved/audited.
- **DANGEROUS mode** and **grill-me** — a user-only approval bypass, and a
  plan-clarity interview before ambiguous/high-stakes actions.
- **Secrets in the macOS Keychain**, masked in the audit; SQLite persistence
  for sessions, audit, budget, usage, projects, accounts, settings, messages, layout.

---

## Version history (git tags)

Tags are the source of truth for version (`package.json` still reads `0.1.0`).
Pre-v0.3.0 commits laid the foundation: floating draggable cards + `ui_layout`,
the provider-agnostic orchestrator + claude-code brain, file-based memory + chat
history + `claude --resume`, Gmail connect UI, auto-hide command bar, and the
first Kokoro TTS / Apple STT voice.

| Tag | Brought |
|-----|---------|
| **v0.3.0** | Account-free wake word "Alfred" (continuous Apple STT); green active toggles; dropped the red dangerous border; no verbal approval prompts (host owns approvals). |
| **v0.4.0** | The `system` tool — battery, brightness, volume, displays, Wi-Fi, apps, notify, clipboard, caffeinate, screenshot — with risk tiers. |
| **v0.5.0** | Obsidian-style memory (notes/maps/index MOC/inbox) + a dedicated curator/organizer brain + the 3-tier agent manuals (AGENTS.md + docs/ + skills/). |
| **v0.6.0** | Multi-monitor **per-display overlay windows** (shared LayoutStore + click-through, cards move between monitors) + neon UI fidelity. |
| **v1.0.0** | Audit pass (DRY/KISS/YAGNI, error handling, markdown XSS fix), hexagonal ARCHITECTURE.md + docs + CONTRIBUTING; tests 54 → 71. |
| **v1.0.1** | pt-BR STT falls back to server recognition; stopped the missing-assets spam loop and silence-crash; reliable move-card-between-monitors. |
| **v1.0.2** | Raised per-display overlay window level to screen-saver so Alfred sits above the menu bar and Dock. |
| **v1.1.0** | **MCP bridge** — the claude-code brain (`claude -p`) can call Alfred's own tools via an in-process governed localhost MCP server. |
| **v1.1.1** | Wake word captures + transcribes the command in one session (+ listening UI); `ui_layout` exposes all displays and moves cards across monitors. |
| **v1.2.0** | Voice command intents (esconder/aparecer/enviar + AI window hide/show/toggle); Gmail connect guard (clear message instead of an `invalid_client` page). |
| **v1.2.1** | Wake word no longer dies on the benign "assets not available" error — keeps listening via server recognition, rate-limits the note, recoverable failed state. |
| **v1.2.2** | Half-duplex: mute wake/STT while Alfred speaks (kills the self-transcription echo loop); dictation commits once per activation; barge-in on manual mic. |
| **v1.3.0** | DANGEROUS mode bypasses `claude -p` permissions (`--dangerously-skip-permissions` + awareness); reset-conversation button + total factory-reset (type "confirmar", confined wipe). |
| **v1.3.1** | Fixed app-won't-open: `reset.ts` dragged `node:path` into the renderer bundle; split the pure part into `reset-pure.ts` (caught by `npm run build`). |
| **v1.4.0** | **grill-me** — interview to lock ambiguous/high-stakes plans before acting (skill + governance behaviour + GRILL topbar toggle, AI-toggleable, default on). |

---

## Design decisions (and why)

- **Provider-agnostic core over the AI SDK.** The loop, tools, and governance
  must be identical whichever model runs, so the model is a swappable *port*
  (`LanguageModel`), not a hard dependency. Identity is fixed in the system prompt.
- **File-first memory, not a vector DB.** Plain Markdown is human-readable,
  diffable, git-friendly, portable. An always-loaded L1 index + a recent window
  keeps the prompt small; the long tail is reached lazily via `recall` and
  `[[wikilinks]]`. A cheap **curator** does the filing so the main brain never
  spends budget organizing, and a handoff is never lost (verbatim fallback).
- **3-tier control** — autopilot (T0/T1, no friction), HITL (T2/T3, block on a
  human), and an independent kill-switch (token cap, step cap, loop detection)
  that stops runaway cost even in DANGEROUS mode.
- **Risk tiers + tool-driven escalation.** A cheap static heuristic classifies
  every call, but the authority is each tool's own `risk(args)` plus a runtime
  `requestApproval` for context only the tool can see (an existing file, a login
  wall). **Trifecta-lite** adds a data-flow guard against exfiltration:
  untrusted read + private data + egress in one session forces an approval.
- **Per-display Übersicht-style overlay windows.** A frameless click-through HUD
  per monitor, all reading one shared `LayoutStore`, with pure geometry clamping
  shared by renderer and store so a card can never be pushed off-screen and both
  sides always agree on the next read.
- **MCP bridge for `claude -p`.** Rather than give the delegated CLI a second,
  ungoverned toolset, an in-process localhost MCP server (bearer-token,
  `127.0.0.1` only) re-exposes Alfred's real tools so every call runs through the
  same governance and audit — no bypass.
- **DANGEROUS mode** is a user-only setting that bypasses *approvals* — never the
  kill-switch, caps, or loop detection. The model can never enable it.
- **grill-me** is about plan *clarity* only; it interviews before ambiguous or
  high-stakes work and does not replace approvals or governance.
- **Curator on a cheap model** keeps memory tidy without spending the main
  brain's budget; it is idempotent, never throws, and respects the kill-switch.
- **Wake word via Apple STT** — account-free and local, but best-effort (see
  limitations). **TTS via `say` or kokoro** — `say` for natural pt-BR with no
  download, kokoro for offline English in Node (no Python).
- **Governance enforced in code, docs advisory.** `AGENTS.md`, `docs/**`, and the
  capability manifest shape behaviour but are never the security boundary — a
  jailbroken or confused model still hits the same rails in `governance.ts`.
- **Crash-averse by construction.** Audit, budget, TTS/STT, curator, and IPC all
  degrade-and-log rather than throw; process-level guards keep the HUD alive.
- **Secrets in the macOS Keychain** via `security`, never on disk; audit args
  masked before persist/stream.

---

## Known limitations & Mac-only surfaces

- **Intel Mac target.** STT is Apple's classic `SFSpeechRecognizer` (not the
  Apple-Silicon `SpeechAnalyzer`), and the account-free wake word is best-effort
  — less reliable than a dedicated engine (e.g. Porcupine) and uses more CPU.
- **No filesystem/shell sandbox.** An absolute path or command can reach anything
  the OS user can; the approval rails, not a jail, are the boundary. Acceptable
  for a single-user local dev tool; would need hardening before multi-user/hosted use.
- **Gmail is read-only** (`gmail.readonly`); cannot send. You supply your own
  OAuth desktop client.
- **T3 (money / credentials)** is out of MVP scope — always human.
- **Mac-only at runtime** (refuse cleanly off macOS): Keychain secrets, voice
  (TTS/STT/wake + the Swift helper), several `system` ops (Automation / Screen
  Recording TCC, the `brightness` CLI), and multi-monitor overlay behaviour that
  depends on macOS "Displays have separate Spaces".
- **What works on Linux for dev:** `npx tsc --noEmit`, `npm run build`, `npm test`,
  and an Electron boot via `npm run dev` — the app launches, but the surfaces
  above return a clear error instead of functioning.

---

## Environment variables (complete)

All configuration is via `.env`, loaded at boot. Nothing is required to *launch*
Alfred, but at least one brain must be enabled to get a reply. Keys are read only
from `process.env`, never logged, and masked in the audit. Defaults live in code
(see the cited files); `.env.example` is the annotated template.

### Brains / providers

| Variable | Default | What it does |
|----------|---------|--------------|
| `ALFRED_PROVIDER` | `anthropic` | Default active brain: `anthropic` \| `openai` \| `deepseek`. |
| `ANTHROPIC_API_KEY` | — | Enables the Anthropic brain (a key containing `xxxx` is a placeholder = disabled). |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Anthropic model id. |
| `OPENAI_API_KEY` | — | Enables the OpenAI/ChatGPT brain. |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model id. |
| `DEEPSEEK_API_KEY` | — | Enables the DeepSeek brain. |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | DeepSeek model id (`deepseek-v4-pro` also priced). |
| `ALFRED_MODEL` | — | Legacy alias for `ANTHROPIC_MODEL` (used only if that is unset). |
| `ALFRED_CURATOR_MODEL` | cheapest enabled brain | `provider:model` spec the memory curator uses (usually DeepSeek by price). |
| `ALFRED_MCP_BRIDGE` | on | `0`/`false`/`off`/`no` disables the in-process MCP bridge that gives `claude -p` Alfred's governed tools. |

The Claude Code brain needs no key — just the `claude` binary on `PATH`
(`npm i -g @anthropic-ai/claude-code`). When Alfred spawns `claude -p` it strips
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_AWS_API_KEY`, and
`ANTHROPIC_FOUNDRY_API_KEY` from the child env so the CLI uses its own
(subscription) auth (`claudeSpawn.ts`).

### Workspace & guardrails

| Variable | Default | What it does |
|----------|---------|--------------|
| `ALFRED_WORKSPACE` | `~/AlfredWorkspace` | Where projects + memory live. |
| `ALFRED_DAILY_TOKEN_BUDGET` | `2000000` | **Hard** daily token kill-switch across all sessions. |
| `ALFRED_DAILY_USD_BUDGET` | unset | **Soft** daily USD warning (estimated); warns, never blocks. |
| `ALFRED_STEP_CAP` | `40` | Max tool/model steps per task. |
| `ALFRED_JOB_MAX_RUN_MS` | `300000` | Per-run hard-interrupt for a scheduled job (fetch/agent/study); a run that exceeds it is aborted + logged, so one runaway job can't monopolise the scheduler. |
| `ALFRED_PRICING_JSON` | — | Path to a pricing-override JSON (`{ "model": { inputPerM, outputPerM } }`); else `data/pricing.json`. |

### Window / overlay

| Variable | Default | What it does |
|----------|---------|--------------|
| `ALFRED_WINDOW_MODE` | `overlay` | `overlay` (frameless click-through HUD, one per display) or `windowed` (classic window). |
| `ALFRED_SPAN_DISPLAYS` | `0` | `1`/`true` → one overlay spans the whole virtual desktop (see README multi-monitor note). |
| `ALFRED_AUTOHIDE_TOP` | on | `0` disables auto-hiding the top command/toolbar strip. |

### Voice (macOS only)

| Variable | Default | What it does |
|----------|---------|--------------|
| `ALFRED_TTS_ENGINE` | `say` | Voice output engine: `say` (macOS, pt-BR) or `kokoro` (English). |
| `ALFRED_TTS_VOICE` | `Luciana` / `af_heart` | Voice name (per engine). |
| `ALFRED_TTS_RATE` | — | `say` speaking rate (words/min). |
| `ALFRED_TTS_DTYPE` | `fp32` | `kokoro` precision: `q8` \| `q4` \| `fp16` \| `fp32`. |
| `ALFRED_TTS_TAIL_MS` | `700` | How long the mic stays muted after TTS stops (half-duplex tail; `tts.ts`). |
| `ALFRED_PREWARM_TTS` | `0` | `setup.sh` only: `1` pre-downloads the Kokoro weights. |
| `ALFRED_STT_LOCALE` | `pt-BR` | Speech-recognition language (e.g. `en-US`, `pt-PT`). |
| `ALFRED_STT_SILENCE` | `2.0` | Silence (seconds) that ends a push-to-talk session (read by the Swift helper). |
| `ALFRED_WAKEWORD` | `alfred` | Wake trigger, also matches the ASR variant `alfredo` (read by the Swift helper). |

### Gmail (read-only)

| Variable | Default | What it does |
|----------|---------|--------------|
| `GOOGLE_OAUTH_CLIENT_ID` | — | Google OAuth desktop client id (must end `.apps.googleusercontent.com`). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | Google OAuth client secret. |

---

## Roadmap / possible next steps

None of this is committed — it is the honest "where it could go" list implied by
the current limitations:

- **Apple-Silicon support** (`SpeechAnalyzer` STT; universal build).
- **A real filesystem/shell sandbox** (path jail, allowlist) for anything beyond
  single-user local dev.
- **T3 tier** (money / credentials) if the trust model ever warrants it.
- **A dedicated wake-word engine** (e.g. Porcupine) for precision over best-effort STT.
- **Write-scope Gmail / more connectors** behind the same governance.
- **Packaged, signed app** with permissions attached to Alfred.app rather than Electron.
- Bump `package.json` version to track the git tags.
