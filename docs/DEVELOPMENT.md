# Alfred — Development

The dev workflow. For orientation start at the repo-root
[CLAUDE.md](../CLAUDE.md); for the code map and extend recipes see
[ARCHITECTURE.md](../ARCHITECTURE.md); for features/history/env see
[OVERVIEW.md](OVERVIEW.md). This file is the day-to-day loop.

## Setup

- **Node 22 LTS** (`engines.node >= 22`).
- **macOS on Intel** to run the *full* app (Electron, voice, `system`, Keychain).
  On **Linux** you can develop and pass all three gates; macOS-only adapters
  refuse cleanly at runtime.
- On a Mac, run `./setup.sh` once — it installs Xcode CLT, Homebrew, Node 22,
  deps, rebuilds native modules for Electron, fetches Playwright Chromium, and
  compiles the Swift STT helper. Day-to-day: `./start.sh`.
- Everywhere: `npm install`, then `cp .env.example .env` and add at least one
  brain key (or install the Claude Code CLI). `npm run rebuild` rebuilds
  `better-sqlite3` for Electron when needed.

## The three gates (all must be green)

Before you call any change done:

```bash
npx tsc --noEmit    # 1. typecheck — exit 0
npm run build       # 2. electron-vite build — renderer + main + preload
npm test            # 3. node --experimental-strip-types --test test/logic.test.ts
```

- `tsc` green is **not** a substitute for `npm test`.
- `npm run build` is its own gate: a renderer file that imports `node:*`,
  `electron`, or `better-sqlite3` **typechecks fine but breaks the build** (and
  the app). This regression shipped once (v1.3.1) and is exactly why build is a
  gate. Benign vite "dynamic vs static import" warnings for `db.ts`/`windows.ts`
  are not failures.

**Run it:** `./start.sh` (loads `.env`, ensures deps + Playwright, runs dev) or
`npm run dev`.

## Testing approach

- **One suite, pure logic only:** `test/logic.test.ts`, run with Node's built-in
  test runner under `--experimental-strip-types`. No Electron, no native deps,
  no fixtures.
- Anything you want tested must be a **pure function**. That constraint is why
  the core keeps parsing / risk / budget / geometry / provider-selection logic
  free of `better-sqlite3` and Electron, taking `Database` as a parameter. If the
  renderer needs a node-touching helper, split the pure part into a `*-pure.ts`
  (see `reset-pure.ts`, `settings-pure.ts`).
- **Write the test first** (red → green → refactor). Only skip for purely
  cosmetic changes, renames/moves with no behaviour change, or docs.
- Add a case for every new pure helper (e.g. a tool's `risk`, a parser, a clamp).

## How to extend

Full recipes with exact wiring live in
[ARCHITECTURE.md § "How to extend"](../ARCHITECTURE.md#6-how-to-extend). In short:

- **Add a tool** — new `src/main/tools/<name>.ts` exporting a `Tool` (name,
  JSON-Schema `inputSchema`, `execute`, optional `risk`); call
  `ctx.governance.requestApproval` inside `execute` for anything static
  classification can't see; register in `tools/index.ts` (the only wiring); add a
  line to `core/manifest.ts` **and** the matching `AGENTS.md` card **and** a
  `docs/tools/<name>.md` contract; add a logic test for the risk/parse helper.
- **Add a brain / provider** — extend `apiBrains(env)` in `core/providers.ts`
  (id, label, `enabled`, default model, `makeModel()`); a bespoke loop (like
  `claude-code`) branches in the orchestrator's `send()`; document it in the
  README brains table, `docs/tools/models.md`, and `.env.example`; add pricing to
  `core/pricing.ts` for USD estimates.
- **Add a generative-UI card / component** — build it under
  `src/renderer/components/`; for AI-renderable, add the name to `AI_COMPONENTS`
  (`core/types.ts`) **and** the `REGISTRY` map (`src/renderer/registry.tsx`); for
  a new floating card, add its id/title to `CARD_TITLES` + a first-run box to
  `DEFAULTS` in `core/layout.ts`.
- **Add a skill** — `skills/<name>/SKILL.md` referenced from `AGENTS.md` and
  `core/manifest.ts`. No code wiring; the runtime model opens it on demand.
- **Add a memory entry (as the runtime agent)** — via the `memory` tool
  (`remember`, then `note` + `handoff`); never edit the human-curated stable layer.

## Conventions (enforced)

- **ESM, explicit `.ts` extensions** on relative imports. Conventional Commits;
  English for code/identifiers/commits.
- **Renderer never imports `node:*` / `electron` / `better-sqlite3`** (see gate 2).
- **Governance lives in code** (`governance.ts`, `orchestrator.ts`), never in
  prompt text. Docs are advisory.
- **Never commit** secrets, `.env`, `data/`, `out/`, `node_modules/`.
- Log the original `err` with context before re-throwing; adapters
  degrade-and-log, they never crash the HUD.

## Versioning

Releases are **git tags** (`vMAJOR.MINOR.PATCH`), currently v0.3.0 → v1.4.0 — the
source of truth for version. `package.json` still reads `0.1.0` and has never
been bumped; treat the tags as authoritative until it is. History is in
[OVERVIEW.md](OVERVIEW.md#version-history-git-tags).
