# Alfred — documentation index

Every doc in the repo, for humans and agents. Alfred is a personal, open-source
**Agent OS**: an Electron app in which a model drives a real Intel Mac and
renders its own control-centre HUD.

## Start here

| If you are… | Read |
|-------------|------|
| **A developer** (working ON Alfred's code) | [CLAUDE.md](../CLAUDE.md) — dev entry point / router |
| **The runtime agent** (the model that *is* Alfred) | [AGENTS.md](../AGENTS.md) — operating manifest |
| **A user** setting Alfred up | [README.md](../README.md) |
| **A contributor** opening a PR | [CONTRIBUTING.md](../CONTRIBUTING.md) |

## Core docs

- [CLAUDE.md](../CLAUDE.md) — developer entry point: build/run/**the 3 gates**,
  repo map, conventions, macOS caveats, pointers. (Dev sessions only; not read at runtime.)
- [OVERVIEW.md](OVERVIEW.md) — what Alfred does, **version history** (v0.3.0 →
  v1.4.0), design decisions, limitations, the **full env-var table**, roadmap.
- [DEVELOPMENT.md](DEVELOPMENT.md) — dev workflow, the 3 gates, how to add a
  tool / brain / card / skill / memory entry, testing, versioning.
- [ARCHITECTURE.md](../ARCHITECTURE.md) — hexagonal (ports & adapters) map,
  module tables, data-flow diagram, extend recipes.
- [README.md](../README.md) — user-facing setup, brains, voice, Gmail, governance.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — prerequisites, run/test, layout, PR conventions.
- [AGENTS.md](../AGENTS.md) — the runtime agent's always-loaded router
  (capability index, governance summary, task routing, memory pointers).
- [design-language.md](design-language.md) — the neon-HUD visual language
  (palette tokens, typography, chrome) every UI Alfred generates (`render_ui`
  + tier-2 widgets) must follow.

## Tool contracts — [tools/](tools/)

Per-tool input/output/risk contracts. Registered tools live in `src/main/tools/`.

- [filesystem.md](tools/filesystem.md) · [shell.md](tools/shell.md) ·
  [browser.md](tools/browser.md) · [system.md](tools/system.md)
- [gmail.md](tools/gmail.md) · [memory.md](tools/memory.md) ·
  [ui_layout.md](tools/ui_layout.md) · [voice.md](tools/voice.md)
- [models.md](tools/models.md) — the four brains + `delegate_to_claude_code` + MCP bridge.
- [tool-disclosure.md](tools/tool-disclosure.md) — progressive disclosure + the `tool_search`/`tool_describe`/`tool_call` bridge, schema sanitizer, check_fn cache.
- [recall-sessions.md](tools/recall-sessions.md) — zero-LLM FTS5 recall over the raw transcript (discovery / scroll / browse).
- [kanban.md](tools/kanban.md) — the machine-writable project board (cards, gated column moves, Done-gate, atomic claim).

## Governance — [governance/](governance/)

The rails, enforced in `core/governance.ts` + the orchestrator (docs are advisory).

- [risk-tiers.md](governance/risk-tiers.md) — T0–T3 classification.
- [approval-flow.md](governance/approval-flow.md) — the HITL approval broker + trifecta-lite.
- [dangerous-mode.md](governance/dangerous-mode.md) — the user-only approval bypass.
- [grill-me.md](governance/grill-me.md) — the plan-clarity interview.
- [security-model.md](governance/security-model.md) — honest framing (heuristics vs OS isolation) + the Stage-3 vault, SSRF guard, and env-scoping.

## Memory — [memory/](memory/)

- [how-memory-works.md](memory/how-memory-works.md) — the file-first ICM/Obsidian
  vault, curator, and handoff flow.

## Skills — [../skills/](../skills/)

Advisory L2 guides the runtime agent loads on demand: `create-project`,
`deploy-runbook`, `grill-me`.
