# CLAUDE.md — developer entry point

**You are a developer (human or Claude Code) working ON Alfred's source.** This
file is your router. It is read only by dev sessions opened in this repo — the
shipped app never loads it (see the note at the bottom). Read this first, then
follow the pointers.

> **You vs. the runtime agent.** This file is for **you**, building Alfred.
> [`AGENTS.md`](AGENTS.md) is the operating manifest for the **runtime** agent —
> whichever model *is* Alfred at run time. Do not take `AGENTS.md`'s "you are
> Alfred, operate the Mac" instructions as directed at you; they configure the
> product, not your dev session.

## What Alfred is

A personal, open-source **Agent OS**: an Electron app in which a model (Claude,
OpenAI, DeepSeek, or the Claude Code CLI) drives a real Mac — filesystem, shell,
a real browser, macOS system controls, read-only Gmail, voice — and renders its
own neon control-centre HUD. Provider-agnostic core over the Vercel AI SDK,
governed by risk-tiered approvals enforced **in code**. Hexagonal (ports &
adapters). See [docs/OVERVIEW.md](docs/OVERVIEW.md) for the full story.

**Current version: v1.4.0** (git tags are the source of truth for version;
`package.json` still reads `0.1.0` and has never been bumped). Tags run
v0.3.0 → v1.4.0 — history in [docs/OVERVIEW.md](docs/OVERVIEW.md).

## Build / run / test / VERIFY

Node 22 LTS. `npm install` first (`npm run rebuild` on a Mac to rebuild
`better-sqlite3` for Electron).

**The three gates — all must be green before you call anything done:**

```bash
npx tsc --noEmit    # gate 1: typecheck, exit 0
npm run build       # gate 2: electron-vite build — renderer + main + preload
npm test            # gate 3: node --experimental-strip-types --test test/logic.test.ts
```

`tsc` green is **not** a substitute for `npm test`. `npm run build` is a gate in
its own right: a `node:*` / native import leaking into the renderer bundle
passes `tsc` but breaks the build (and the app) — it has happened (v1.3.1).

**Run the app:** `./start.sh` (loads `.env`, ensures deps + Playwright, runs dev)
or `npm run dev` directly. Both need a Mac for the full experience; on Linux the
app boots but macOS-only adapters refuse cleanly (see caveats).

## Repo map

| Path | What it is |
|------|------------|
| `src/main/index.ts` | Electron shell entry: boots DB + orchestrator, loads `.env`, creates windows/overlays, global shortcuts, process guards |
| `src/main/ipc.ts` | IPC handlers — the trust boundary between renderer and core |
| `src/main/displays.ts` | `DisplayManager` — one overlay window per monitor |
| `src/main/windows.ts` | Window creation (overlay + windowed modes) |
| `src/main/core/*` | **Domain core** (no Electron). orchestrator, governance, budget, pricing, providers, claudeSpawn, memory, curator, layout, projects, manifest, dictation, reset(-pure), settings-pure, secrets, stt, tts, wakeword, mcpServer, mcpConfig, db, **types** (ports + shared contracts) |
| `src/main/tools/*` | **Tool adapters** — filesystem, shell, browser, system, gmail (+gmail-config), memory, uiLayout, renderUi, project, delegate; `index.ts` is the registry (only file edited to add/remove a tool) |
| `src/preload/index.ts` | `contextBridge` — the frozen `window.alfred` API |
| `src/renderer/*` | React UI — `App.tsx`, `surface.tsx` + `registry.tsx` (generative UI whitelist), `components/*`, `theme.css`, `lib/ipc.ts` |
| `native/alfred-stt.swift` | On-device STT + wake-word helper (Apple `SFSpeechRecognizer`) |
| `skills/*` | Advisory L2 guides the runtime agent loads on demand (create-project, deploy-runbook, grill-me) |
| `docs/*` | Human + agent docs: `tools/`, `governance/`, `memory/`, plus OVERVIEW/DEVELOPMENT/README |
| `test/logic.test.ts` | The whole test suite — pure-logic only |

Deeper map + data-flow diagram: [ARCHITECTURE.md](ARCHITECTURE.md).

## Conventions

- **ESM with explicit `.ts` extensions** on relative imports (runs under
  `node --experimental-strip-types`). Conventional Commits, English everywhere.
- **NEVER import `node:*`, `electron`, or `better-sqlite3` into the renderer.**
  It typechecks but breaks `npm run build` and the app. Keep node-only logic in
  `src/main`; split a `*-pure.ts` if the renderer needs a helper (see
  `reset-pure.ts`, `settings-pure.ts`).
- **Tests are pure logic only**, all in `test/logic.test.ts` — no Electron, no
  native deps. Anything tested must be a pure function; that is why core takes
  `Database` as a parameter instead of importing the driver. Write the test
  **first**.
- **Governance is enforced in CODE** (`governance.ts` + `orchestrator.ts`), never
  by prompt text. Docs (`AGENTS.md`, `docs/**`, `manifest.ts`) are advisory and
  are never the security boundary.
- A new capability touches **three hand-synced places**: `core/manifest.ts`,
  `AGENTS.md`, and a `docs/tools/<name>.md` contract. Keep them in step.
- **Never commit** secrets, `.env`, `data/`, `out/`, or `node_modules/`.
  Errors: log the original `err` with context before re-throwing; adapters
  degrade-and-log, they never crash the HUD.

## macOS caveats (what a Linux dev can't fully exercise)

Alfred targets **Intel** Macs. On Linux you get typecheck, build, tests, and an
Electron boot — but these surfaces refuse cleanly (clear error, no crash) off a
Mac:

- **Secrets** (`secrets.ts`) — macOS Keychain via `security`; throws off macOS.
- **Voice** — TTS (`say`/kokoro), STT + wake word need the compiled Swift helper
  (`native/alfred-stt`, built by `setup.sh` via `xcrun`).
- **`system` tool** — some ops need macOS TCC permissions (Automation, Screen
  Recording); `brightness_*` needs the `brightness` CLI.
- **Multi-monitor overlays / spanning** — behave per macOS "Displays have
  separate Spaces"; see README.

## Pointers

- [docs/OVERVIEW.md](docs/OVERVIEW.md) — what Alfred does, version history, design
  decisions, limitations, the **full env-var table**, roadmap.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — dev workflow, the 3 gates, how to
  add a tool / brain / card / skill / memory entry, testing, versioning.
- [ARCHITECTURE.md](ARCHITECTURE.md) — hexagonal map, ports, data flow, extend recipes.
- [docs/README.md](docs/README.md) — index of every doc.
- [docs/tools/*](docs/tools/) · [docs/governance/*](docs/governance/) ·
  [docs/memory/*](docs/memory/) — per-tool contracts, risk tiers/approvals, memory.
- [AGENTS.md](AGENTS.md) — the **runtime** agent's manifest (not for you).
- [README.md](README.md) · [CONTRIBUTING.md](CONTRIBUTING.md) — user setup, PR conventions.

---

**Why this file is safe to be the dev guide.** The runtime system prompt is
built from a hardcoded `ALFRED_IDENTITY` constant in `orchestrator.ts` plus
`CAPABILITY_MANIFEST` — it never reads this repo file. The only `CLAUDE.md` the
running app touches is the **workspace** one (`<ALFRED_WORKSPACE>/CLAUDE.md`),
which Alfred *generates* via `ensureClaudeMd` so the spawned `claude -p` child
(cwd = workspace) picks up the identity. Repurposing this repo-root file as the
dev entry point cannot affect runtime behaviour.
