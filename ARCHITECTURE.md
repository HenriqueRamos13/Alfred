# Alfred — Architecture

Alfred is a personal **Agent OS**: an Electron app in which Claude (or another
model) drives a real Mac and renders its own control-centre UI. This document
describes the architecture as it exists today, framed as **hexagonal / ports &
adapters** — a provider-agnostic domain core surrounded by adapters that either
drive it (the UI) or are driven by it (tools, models, the OS).

> This is a map of the code as it is, not an aspiration. Every module named
> below exists under `src/main` (Node core + adapters), `src/renderer` (React
> UI), `src/preload` (bridge), or `native/` (Swift STT helper).

---

## 1. The shape in one picture

```
                       DRIVING ADAPTERS (primary)                          DRIVEN ADAPTERS (secondary)
   ┌───────────────────────────────────────────────┐        ┌────────────────────────────────────────────────┐
   │  Electron shell         src/main/index.ts       │        │  Tools (driven)          src/main/tools/*        │
   │   • windows / overlay / DisplayManager          │        │   filesystem · shell · browser · system · gmail  │
   │   • global shortcuts · process guards           │        │   memory · ui_layout · render_ui · delegate ·    │
   │                                                 │        │   project                                        │
   │  IPC bridge   src/main/ipc.ts + preload/index   │        │                                                  │
   │   • window.alfred.*  (contextIsolation)         │        │  Providers (driven)     core/providers.ts        │
   │                                                 │        │   Anthropic · OpenAI · DeepSeek  (Vercel AI SDK) │
   │  Renderer (React)      src/renderer/*           │        │   claude-code CLI  core/claudeSpawn.ts           │
   │   • floating cards · generative surface         │        │                                                  │
   │   • command bar · approval prompt               │        │  Voice (driven)     core/{tts,stt,wakeword}.ts   │
   └───────────────────────┬─────────────────────────┘        │   say / kokoro (TTS) · native/alfred-stt (STT)   │
                           │ commands (IPC)                    │                                                  │
                           │ ▲ StreamEvent (emit)              │  Secrets (driven)         core/secrets.ts        │
                           ▼ │                                 │   macOS Keychain (`security`)                    │
   ┌───────────────────────────────────────────────┐          │                                                  │
   │            DOMAIN / CORE   src/main/core         │          │  Persistence (driven)     core/db.ts             │
   │                                                 │◄────────►│   SQLite (better-sqlite3)                        │
   │   Orchestrator  ── the agent use-case           │  ports   └────────────────────────────────────────────────┘
   │     · streamText loop (provider-agnostic)       │
   │     · builds ToolCtx, drives tools              │        PORTS (interfaces, core/types.ts + governance.ts)
   │   Governance · Budget · Pricing                 │          Tool · ToolCtx · ToolResult
   │   Memory · Curator · Projects                   │          Governance · ApprovalStore
   │   Layout · Manifest · Providers (selection)     │          Secrets · BrowserHandle
   │   Types (the single source of truth)            │          LanguageModel (AI SDK) · StreamEvent
   └─────────────────────────────────────────────────┘
```

**Dependency rule.** The core depends only on ports (interfaces). Adapters
depend on the core. `core/types.ts` is the single import surface everything
shares; it deliberately contains **no `enum` / `namespace`** so pure-logic files
run under `node --experimental-strip-types` for the fast test suite.

---

## 2. Domain / core (`src/main/core`)

The core is the logic. It never imports Electron; it touches the native SQLite
driver in exactly one place (`db.ts`) and takes the `Database` as a parameter
everywhere else, so the rest stays strip-types-testable.

| Module | Role |
|--------|------|
| `orchestrator.ts` | The **application service**. Runs one user turn to completion: builds the system prompt, opens a provider-agnostic `streamText` loop over the AI SDK, wraps every tool with governance/audit, streams `StreamEvent`s out. Also the composition root (`createOrchestrator`) that wires `ToolCtx`, governance, browser handle, voice and the IPC façade. |
| `governance.ts` | Risk classification (`classifyAction`), the HITL **approval broker** (`createGovernance`), trifecta-lite tracking, secret masking, and the audit writer. Pure predicates (`classifyAction`, `isEgressTool`, `trifectaImpact`, `approvalKey`) are unit-tested. |
| `budget.ts` | Token **kill-switch** + per-day/session counters, per-task step counting, loop detection (`isLoop`), and the estimated-USD `CostSnapshot`. Pure helpers tested; `BudgetTracker` persists to SQLite. |
| `pricing.ts` | Model price table → estimated USD (visibility only; the hard cap is tokens). Optional env/file override. Pure. |
| `providers.ts` | The **brains** layer over the Vercel AI SDK. Enable/select logic (`resolveActiveBrainId`, `selectBrainId`, `parseProviderSpec`) is pure & tested; the AI-SDK factories are touched only in `resolveProvider`. |
| `memory.ts` | File-based long-term memory (journal, facts, Zettelkasten vault) — layout + pure parsers/serializers for notes, wikilinks, frontmatter, MOC/backlink builders. |
| `curator.ts` | The **librarian** brain: drains handoff inbox → atomic notes on a *cheap* model, rebuilds indexes. Idempotent, never throws, respects the kill-switch. |
| `layout.ts` | The floating-card **LayoutStore** — the single source of truth for card geometry/visibility/display, shared by the user's drags and the AI's `ui_layout` tool. Pure geometry (`clampBox`, `tileLayout`, `cardOnDisplay`) tested. |
| `projects.ts` | ICM folder-as-context projects: `.alfred/PROJECT.md` manifest is canonical, SQLite is the index. `slugify` is pure. |
| `manifest.ts` | `CAPABILITY_MANIFEST` — the thin, always-loaded (L1) capability index injected into every system prompt. |
| `types.ts` | The **ports** and shared data contracts (see below). |
| `db.ts` | The one module that value-imports `better-sqlite3`; owns the schema + migrations. |

### Ports (the interfaces the core defines)

Ports live in `core/types.ts` (plus `ApprovalStore` in `governance.ts`). The
core talks to the outside world only through these:

- **`Tool` / `ToolCtx` / `ToolResult`** — the tool contract. A tool declares a
  name, JSON-Schema input, an optional per-call `risk(args)`, and an
  `execute(args, ctx)`. `ToolCtx` is the capability bag handed to every tool:
  `{ sessionId, workspace, db, governance, secrets, browser, emit, sendUi }`.
- **`Governance`** — `classify`, `requestApproval` (blocks until approve/deny),
  `markTrifecta`, `trifecta`. Implemented by `createGovernance`.
- **`ApprovalStore`** — persistence for approval controls (`isDangerous`,
  `rules`, `rememberRule`), injected so governance never imports SQLite.
- **`Secrets`** — `get/set/delete`; implemented by the Keychain adapter.
- **`BrowserHandle`** — a lazy Playwright page factory.
- **`LanguageModel`** (from the AI SDK) — the model port; `resolveProvider`
  returns one for the active brain.
- **`StreamEvent`** — the outbound event contract (the "event bus" to the UI):
  `chat.delta/message`, `tool.start/end`, `approval.request/resolved`,
  `ui.render`, `layout`, `agent.status`, `budget`, `cost`, `stt.*`,
  `wake.detected`, `error`.

---

## 3. Driven adapters (the core reaches out through ports)

### Tools — `src/main/tools/*`
Each tool implements the `Tool` port; the registry (`tools/index.ts`) is the
only file edited to add/remove one. HITL is **tool-driven**: a tool declares its
tier via `risk?(args)` and calls `ctx.governance.requestApproval(...)` itself for
the cases static classification can't see (overwriting a file, destructive
shell, delete, a browser login wall, connecting Gmail).

| Tool | What it drives | Notable risk behaviour |
|------|----------------|------------------------|
| `filesystem` | files/dirs (read/write/list/mkdir/delete) | overwrite existing = T2, delete = T2 (asked inside `execute`) |
| `shell` | `/bin/sh -c` with timeout | destructive-command heuristic = T2 |
| `browser` | real Chromium (Playwright, persistent profile) | `readText` marks `readUntrusted`; login walls pause for T2; never types passwords |
| `system` | the Mac (battery, volume, brightness, displays, Wi-Fi, apps, notify, clipboard, caffeinate, lock/sleep/screenshot) | `app_quit`/`lock`/`sleep` = T2; some ops need macOS TCC |
| `gmail` | read-only Gmail (loopback OAuth) | `connect` = T2; any read marks `readUntrusted` + `hasPrivate` |
| `memory` | the memory vault (read/append/remember/recall/list/note/handoff) | reads T0, writes T1 |
| `ui_layout` | the LayoutStore (get/move/resize/show/hide/arrange/reset) | T1, no approval |
| `render_ui` | pushes a whitelisted UI tree to the surface | T0 |
| `delegate_to_claude_code` | spawns headless `claude -p` for a sub-task | T2; cwd confined to the workspace |
| `project` | ICM projects (create/list/get) | create T1, read T0 |

### Providers — `core/providers.ts`, `core/claudeSpawn.ts`
Three API brains (Anthropic / OpenAI / DeepSeek) resolve to an AI-SDK
`LanguageModel`; the loop is identical for all of them. The **claude-code** brain
is different: `runClaudeTurn` in the orchestrator bypasses `streamText` and
spawns `claude -p --resume` (via `claudeSpawn.ts`), which uses *its own* tools —
Alfred's per-turn HITL does not apply on that path, and its cost is external
(subscription-billed).

### Voice — `core/tts.ts`, `core/stt.ts`, `core/wakeword.ts`, `native/alfred-stt.swift`
- **TTS**: `say` (macOS built-in, pt-BR default) or `kokoro` (kokoro-js, English).
  One serialised queue + a single `stop()` kill-switch.
- **STT / wake word**: the compiled Swift helper (`native/alfred-stt`) does
  on-device recognition with Apple's `SFSpeechRecognizer` and speaks a
  line-delimited JSON protocol that `stt.ts`/`wakeword.ts` relay as
  `StreamEvent`s. A single microphone owner is coordinated by the orchestrator.

### Secrets — `core/secrets.ts`
macOS Keychain via the `security` CLI (service `alfred`). On non-macOS it throws
a clear error so Linux dev still boots (secret-backed features just refuse).

### Persistence — `core/db.ts`
One SQLite file (`data/alfred.db`). Tables: `sessions`, `audit`, `budget`,
`usage_by_model`, `projects`, `accounts`, `settings`, `messages`, `layout`.
Schema is `CREATE TABLE IF NOT EXISTS` + idempotent `ALTER` migrations.

---

## 4. Driving adapters (the outside drives the core)

### Electron shell — `src/main/index.ts`
Boots the DB + orchestrator, loads `.env`, resolves the active brain (with a
secret-free boot log), and creates windows. Two window modes (`ALFRED_WINDOW_MODE`):

- **overlay** (default) — a frameless, transparent, always-on-top, **click-through
  HUD per display**, managed by `DisplayManager` (`src/main/displays.ts`). The
  main-process LayoutStore stays the single source of truth; each window renders
  only the cards whose `displayId` matches its display (`--display-id`/`--primary`
  passed to the preload). A monitor unplugged → its cards fall back to the primary.
  If per-display creation fails, it degrades to a single overlay window.
- **windowed** — a classic bordered window (fallback).

Process guards (`uncaughtException`/`unhandledRejection`) keep a stray throw from
ever closing Alfred; it logs (secret-free) and surfaces an `error` event instead.

### IPC bridge — `src/main/ipc.ts` + `src/preload/index.ts`
The renderer only ever reaches the core through the frozen `window.alfred` API
exposed by the preload (`contextIsolation` on, `nodeIntegration` off). Inbound
IPC is validated at the trust boundary (`sanitizeCardPatch`, decision/coord
checks) and every handler is wrapped so a rejection becomes a readable UI `error`
event, never the truncated "Error invoking remote method". Outbound streaming is
a single `emit` sink fanned out to every live window's `webContents`.

### Renderer — `src/renderer/*`
React. Floating cards (`DraggableCard`), the generative **surface** (`surface.tsx`
+ the whitelisted `registry.tsx`), command bar, approval prompt, activity log.
AI-renderable components are strictly whitelisted (`AI_COMPONENTS` in
`core/types.ts`); app-driven UI (command bar, approval prompt) is not
AI-renderable. In overlay mode the renderer flips its own window interactive
while the pointer is over a card and back to click-through when it leaves.

---

## 5. The turn: command → result

```
 user types / speaks
        │
        ▼
 window.alfred.send(text)        (preload → ipcMain 'alfred:send')
        │
        ▼
 Orchestrator.send(text)         (core/orchestrator.ts)
   • persist user message; reset trifecta; cancel pending curator sweep
   • resolve active brain
        │
        ├── claude-code brain ──► runClaudeTurn → `claude -p --resume`  ──► chat.message
        │                          (its own tools; no per-turn HITL; external cost)
        │
        └── API brain ──► new Orchestrator(...).run(text)
                 │
                 ▼
          streamText loop (Vercel AI SDK)                       ┌── prepareStep (BEFORE each model call)
          system = identity + capability manifest +       ◄─────┤    · step cap reached?  → hardStop
                   stable memory + index (L1) +                 │    · over daily token budget? → hardStop
                   recent 7d + transcript + project             └── onStepFinish (AFTER each call)
                 │                                                    · BudgetTracker.record(usage) → budget + cost events
                 ▼
          model wants a tool  ──►  runTool(tool, args)
                 │                    1. loop detection (identical call >3× → hardStop)
                 │                    2. tier = tool.risk(args) ?? classifyAction(...)
                 │                    3. markTrifecta; if egress + untrusted + private → escalate
                 │                    4. if T2/T3 (or escalated): governance.requestApproval  ── approval.request ──► UI
                 │                       · DANGEROUS mode / auto-rule → auto-approve (audited w/ provenance)
                 │                       · else block until approve/deny (5-min timeout = deny)
                 │                    5. tool.execute(args, ctx)   (does the real OS/web/model work)
                 │                    6. audit row (masked args, tier, status, note)
                 ▼
          tool result back to the model  ──►  … loop …  ──► text deltas ──► chat.delta / chat.message
                 │
                 ▼
          agent.status: done          (all StreamEvents fan out to every window)
        │
        ▼
 turn over → free busy flag → schedule idle curator sweep (debounced, only if inbox non-empty)
```

Guardrails preserved end-to-end regardless of which brain drives the API path:
daily token kill-switch (checked before *and* after each call), per-task step
cap, identical-call loop detection, risk-tiered HITL, trifecta-lite egress
escalation, and a masked audit of every call.

---

## 6. How to extend

### Add a tool
1. Create `src/main/tools/<name>.ts` exporting a `Tool`: `name`, `description`,
   a JSON-Schema `inputSchema`, `execute(args, ctx)`, and an optional
   `risk(args)`.
2. For anything static classification can't see (overwrite, delete, egress),
   call `ctx.governance.requestApproval(...)` inside `execute` and honour the
   decision (`denialError(res)` is the standard message).
3. Register it in `src/main/tools/index.ts` (`tools[]`). That's the only wiring —
   the orchestrator wraps every registry tool automatically.
4. Add a one-liner to `core/manifest.ts` (`CAPABILITY_MANIFEST`) **and** the
   matching card in root `AGENTS.md` (they are two hand-synced copies — see the
   `ponytail:` note in `manifest.ts`), then a `docs/tools/<name>.md` contract.
5. Add a logic test in `test/logic.test.ts` for any pure risk/parse helper.

### Add a brain / provider
1. In `core/providers.ts`, add the brain to `apiBrains(env)` (id, label,
   `enabled` from its key, default model, `makeModel()` factory) — reuse the
   AI-SDK `create*` pattern. Extend `withModel` for `provider:model` overrides.
2. If it needs a bespoke loop (like `claude-code`), branch in the orchestrator's
   `send()` instead of the `streamText` path.
3. Document it in the README brains table, `docs/tools/models.md`, and
   `.env.example`. Add pricing to `core/pricing.ts` if you want USD estimates.

### Add a generative-UI card / component
1. Build the React component under `src/renderer/components/`.
2. If the **AI** should be able to render it, add its name to `AI_COMPONENTS`
   (`core/types.ts`) **and** the `REGISTRY` map (`src/renderer/registry.tsx`).
   Anything not in the whitelist is rejected by `render_ui` — never arbitrary JSX.
3. For a new **floating card** (control-centre widget), add its id+title to
   `CARD_TITLES` and a first-run box to `DEFAULTS` in `core/layout.ts`, then
   render it in the renderer. `getLayout` seeds missing cards idempotently.

### Add a skill
Skills are advisory L2 docs the model loads on demand. Add
`skills/<name>/SKILL.md` and reference it from the routing table in `AGENTS.md`
and `core/manifest.ts`. No code wiring — the model opens it when a task matches.

### Add a memory entry (as the agent)
Call the `memory` tool: `remember` for durable facts/events, or — when a task
completes — `note` (one atomic idea with typed `[[wikilink]]` relations) then
`handoff` (a short summary + note path). The curator files handoffs into the
vault later. Never edit the human-curated stable layer.

---

## 7. Design decisions (why it is like this)

- **Provider-agnostic core over the Vercel AI SDK.** The agent loop, tools and
  governance must be identical whichever model runs, so the model is a swappable
  *port* (`LanguageModel`), not a hard dependency. The identity ("you are Alfred")
  is fixed in the system prompt regardless of engine.

- **File-first memory (Obsidian/ICM), not a vector DB.** Memory is plain Markdown
  under the workspace: human-readable, diffable, git-friendly, and portable
  between agents. An always-loaded L1 index + recent window keeps the prompt
  small; the long tail is reached lazily via `recall` and `[[wikilinks]]`. A
  separate cheap **curator** does the organising so the main brain never spends
  its budget filing notes, and a handoff is never lost (verbatim fallback).

- **3-tier control (autopilot / HITL / kill-switch).** Free actions (T0/T1) run
  without friction; consequential ones (T2/T3) block on a human; and independent
  of approvals, hard limits (token kill-switch, step cap, loop detection) stop
  runaway cost or loops — these are *not* bypassed even in DANGEROUS mode.

- **Risk tiers + tool-driven escalation.** A cheap static heuristic classifies
  every call, but the authority is each tool's own `risk(args)` plus runtime
  `requestApproval` for context only the tool can see (an existing file, a login
  wall). The **trifecta-lite** rule adds a data-flow guard: untrusted read +
  private data + egress in one session forces an approval, mitigating exfiltration.

- **Governance enforced in code, docs are advisory.** `AGENTS.md`, `docs/**` and
  the capability manifest shape behaviour but are never the security boundary —
  the real guardrails live in `governance.ts`/`orchestrator.ts`, so a jailbroken
  or confused model still hits the same rails.

- **The LayoutStore is a single shared source of truth.** Both the user's drags
  (IPC) and the AI's `ui_layout` tool read/write the same SQLite-backed store,
  with pure geometry clamping shared by renderer and store, so a card can never
  be pushed off-screen and both sides always agree on the next read.

- **Crash-averse by construction.** A personal always-on HUD must not die: audit
  writes, budget accounting, TTS/STT, curator runs and IPC handlers all
  degrade-and-log rather than throw, and process-level guards keep the app alive.

- **macOS Keychain for secrets.** OAuth tokens live in the OS keychain via
  `security`, never on disk; audit args are masked before persist/stream.
```
