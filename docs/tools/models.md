# models (brains) & delegation

Alfred is **provider-agnostic** over the Vercel AI SDK: the agent loop, tools,
and governance are identical whichever brain drives them. Source:
`src/main/core/providers.ts`; delegation `src/main/tools/delegate.ts`.

## The four brains
| id | key / requirement | default model env |
|----|-------------------|-------------------|
| `anthropic` | `ANTHROPIC_API_KEY` (default active) | `ANTHROPIC_MODEL` / `ALFRED_MODEL` → `claude-sonnet-5` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` → `gpt-4o` |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` → `deepseek-v4-flash` |
| `claude-code` | `claude` CLI on PATH | `claude -p` (subscription-billed, external cost) |

- A brain is **enabled** only when its key is present and not a placeholder (keys
  containing `xxxx` are ignored). `claude-code` is enabled when the CLI is on PATH.
- Default brain: `ALFRED_PROVIDER` (else `anthropic`). Effective active brain
  resolves as: persisted UI choice → `ALFRED_PROVIDER` → first enabled (an API
  chat brain preferred; `claude-code` only if it is the sole one).
- You **do not** choose the brain — config/UI does. Your identity stays
  **Alfred** whichever model runs; name the model only if the user asks.
- `claude-code` as the conversational brain runs `claude -p` with `--resume`
  session continuity. It uses its own native tools (Read/Write/Bash/…) AND — via
  the **MCP bridge** below — Alfred's tools, which DO run through Alfred's
  governance. cwd is the workspace, which carries a managed CLAUDE.md.

## MCP bridge — Alfred's tools inside `claude -p`
Source: `src/main/core/mcpServer.ts` (server) + `src/main/core/mcpConfig.ts` (pure
config/mapping). Whenever Alfred spawns `claude -p` (the `claude-code` brain OR
the delegate tool, both through `core/claudeSpawn.ts`), it attaches an
**in-process MCP server**:
- **Transport:** Streamable HTTP, one session per client, bound to an ephemeral
  `127.0.0.1` port — never off-host.
- **Auth:** a random per-boot **bearer token**; requests without it get `401`, so
  no other local process can drive Alfred's tools.
- **What it exposes:** the entire tool registry (`tools/index.ts`) as
  `mcp__alfred__<tool>` MCP tools (name, description, `inputSchema` mapped 1:1).
- **How it runs them:** each MCP tool call executes the real `Tool.execute(args,
  ctx)` with the orchestrator's real `ToolCtx` via the **shared** `runGovernedTool`
  (the same path the streaming agent loop uses). So risk tiers, HITL approvals
  (T2/T3 prompt in the Alfred UI), DANGEROUS-mode auto-approve, the trifecta rule,
  and the audit log **all apply — there is no bypass**. e.g. `ui_layout` moves the
  cards and broadcasts to the UI for real.
- **Wiring:** `claudeSpawn.ts` appends `--mcp-config <json>` (server `type:"http"`,
  `url`, `Authorization: Bearer <token>`) and `--allowedTools mcp__alfred__…` (a
  comma-separated auto-approve list; native tools are unaffected), plus
  `--strict-mcp-config` so the child sees ONLY Alfred's server (never the user's
  own MCP configs). The config is passed inline as a JSON string — no temp file.
- **Fallback:** if the bridge can't start or the CLI can't reach it, `claude -p`
  runs with only its own tools (prior behaviour). No crash. Toggle with
  `ALFRED_MCP_BRIDGE` (default on; `0`/`false`/`off`/`no` disables).

## Curator brain
Memory organising runs on a **cheap** brain: `ALFRED_CURATOR_MODEL` if set, else
the cheapest enabled API brain by published price (usually DeepSeek). It respects
the daily token kill-switch and never competes with the main task.

## delegate_to_claude_code (tool)
Hand a self-contained autonomous task to a headless `claude -p` child that grinds
it to completion and returns parsed JSON.
- Input: `task` (required), `cwd` (default workspace; **confined to the
  workspace** — a cwd outside it is rejected).
- Runs with `--permission-mode acceptEdits --output-format json`.
- **Risk T2** → the orchestrator gates it behind a human approval.
- Missing CLI → clear error (`npm i -g @anthropic-ai/claude-code`).
- Use for chunky sub-tasks (refactors, scaffolding, multi-file edits) you can
  hand off wholesale.

```json
{ "task": "Add a health-check endpoint and a test for it", "cwd": "api" }
```
