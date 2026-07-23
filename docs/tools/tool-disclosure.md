# progressive tool disclosure & the tool_* bridge

Every tool description + input schema ships on **every** model call. With the
Phase-5 roster and MCP tools the tool array — and the per-call token bill —
bloats. Progressive disclosure keeps a small **core** set always loaded and hides
the rest behind three **bridge tools** until they are actually needed.

Pure decision logic: `src/main/core/tool-disclosure-pure.ts` (unit-tested in
`test/logic.test.ts`). Wiring: `Orchestrator.buildTools()` in
`src/main/core/orchestrator.ts`. Core set: `CORE_TOOLS` in
`src/main/tools/index.ts`.

## Core vs deferrable
- **CORE (always loaded, never defers):** `filesystem`, `shell`, `system`,
  `memory`, `ui_layout`.
- **DEFERRABLE (everything else):** `browser`, `project`, `gmail`, `render_ui`,
  `delegate_to_claude_code`, `delegate_to_agent`, `agent_study`, `team`,
  `schedule`, plus any MCP tools.

## When it engages
On each turn `shouldDefer(tools, budget)` estimates the token size of the
**deferrable** definitions (descriptions + schemas, ~4 chars/token). If that
exceeds the threshold — **~12 % of the model's context window** by default, or the
absolute `ALFRED_TOOL_DISCLOSURE_TOKENS` cap when set — the deferrable tools are
replaced in the model-visible array by the bridge. Below the threshold every tool
is exposed directly and **no bridge appears** (today's behaviour). Core tools are
never counted and never deferred. The catalog is rebuilt **statelessly** every
assembly — no per-session state that could drift.

## The three bridge tools (deferred mode only)
| tool | args | returns |
|------|------|---------|
| `tool_search` | `{ query }` | deferred tools matching the intent: `{ tools: [{ name, summary }] }` (empty query → all) |
| `tool_describe` | `{ name }` | `{ name, description, inputSchema }` of one deferred tool (sanitized schema) |
| `tool_call` | `{ name, args }` | **executes** the named deferred tool and returns its result |

`tool_call` unwraps to the real `Tool` and routes through the **exact same
governed path** as a direct call — `Orchestrator.runTool` → `runGovernedTool` —
so loop detection, risk-tier classification, HITL approvals, trifecta-lite
escalation and the audit trail fire **identically**. The bridge is a
context-saving indirection, **never a governance bypass**. `tool_call` is scoped
to the tools actually available this session; a bridge name cannot be called
through the bridge, and an unknown name returns a clear error (not a throw).

## Cross-provider schema sanitizer
Every tool schema (direct or via `tool_describe`) is normalised by
`sanitizeToolSchema()` before it reaches the backend, so strict providers
(Anthropic) don't 400 on MCP-style schemas:
- **nullable `anyOf`/`oneOf`** collapse to the single non-null branch (or an
  `anyOf` of the non-null branches when several remain);
- **`$ref` siblings** are stripped (only the `$ref` is kept);
- **bare/empty object types** get an explicit `type: 'object'` + `properties`.

It is pure (clones, never mutates) and recursive.

## check_fn availability cache (mechanism ready, no-op today)
Tools may one day carry an availability probe (e.g. "is Gmail connected / the
browser up"). `isProbeFresh()` / `reconcileProbe()` cache a probe result with a
**TTL (~30 s)** plus a **transient-failure grace window (~60 s)**: a probe that
fails shortly after a success serves the **last-good** value instead of yanking
the tool on a flaky probe. The grace shrinks (lastOkTs is not advanced by a
failure) so it eventually expires. No tool ships a `check_fn` yet, so the
mechanism is wired but dormant.
