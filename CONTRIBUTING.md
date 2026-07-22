# Contributing to Alfred

Thanks for hacking on Alfred. It is a personal, open-source Agent OS — small,
crash-averse, and deliberately un-over-engineered. Keep changes in that spirit.

## Prerequisites

- **Node 22 LTS** (`.nvmrc`-equivalent: `engines.node >= 22`).
- macOS on **Intel** to run the full app (Electron, voice, `system` tool, Keychain).
  You can develop and run the tests/typecheck on Linux; macOS-only adapters just
  refuse at runtime with a clear error.
- Run `./setup.sh` on a Mac once to install deps, rebuild native modules for
  Electron, fetch Playwright Chromium, and compile the Swift STT helper.

## Run

```bash
npm run dev        # electron-vite dev (the app)
./start.sh         # loads .env and runs dev in one step (day-to-day)
npm run build      # electron-vite build
npm run rebuild    # rebuild native modules (better-sqlite3) for Electron
```

Copy `.env.example` → `.env` and add at least one brain key (or install the
Claude Code CLI) — see the env-var table in the [README](README.md).

## Test & typecheck (must stay green)

```bash
npm test           # node --experimental-strip-types --test test/logic.test.ts
npm run typecheck  # tsc --noEmit
```

- **`tsc --noEmit` must be 0 and the logic test suite must be green** on every
  change. `tsc` green is *not* a substitute for tests.
- The suite is **pure logic only** — no native deps, no Electron. Anything you
  want tested must be a pure function (that is why core keeps parsing/risk/budget
  logic free of `better-sqlite3` and Electron imports, taking the `Database` as a
  parameter). Add a case to `test/logic.test.ts` for any new pure helper.
- Write the test **first** (red → green → refactor). Only skip a test for purely
  cosmetic changes, renames/moves with no behaviour change, or docs.

## Repository layout

```
src/main/core/     Domain core — orchestrator, governance, budget, pricing,
                   memory, curator, layout, providers, projects, manifest, types, db
src/main/tools/    Driven tool adapters (filesystem, shell, browser, system,
                   gmail, memory, ui_layout, render_ui, delegate, project) + registry
src/main/          Electron shell: index.ts (windows/overlay), ipc.ts, displays.ts
src/preload/       contextBridge — the frozen window.alfred API
src/renderer/      React UI: cards, generative surface, command bar, registry
native/            alfred-stt.swift — on-device STT/wake-word helper
docs/              Agent-facing contracts (tools/, governance/, memory/)
skills/            On-demand SKILL.md guides
test/              logic.test.ts (pure-logic suite)
```

Read **[ARCHITECTURE.md](ARCHITECTURE.md)** before a non-trivial change — it maps
the ports & adapters and has "how to extend" recipes (add a tool, a brain, a
card, a skill).

## Conventions

- **Conventional Commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `security:`).
- Code, identifiers, comments, commit messages: **English**.
- Errors: never catch-and-rewrap silently — log the original error with context
  before re-throwing. Adapters (audit, budget, TTS/STT, IPC) degrade-and-log
  rather than throw; keep it that way (a personal HUD must not crash).
- New capability → update `core/manifest.ts` **and** `AGENTS.md` (two hand-synced
  copies) plus a `docs/` contract, so the agent-facing docs never drift from code.
- Governance is enforced in **code**, not docs. Don't rely on prompt text for a
  security property.

## License

By contributing you agree your contributions are licensed under the MIT License
(see [LICENSE](LICENSE)).
