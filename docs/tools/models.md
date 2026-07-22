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
  session continuity and uses **its own** tools — Alfred's per-turn tools/HITL do
  not apply on that path (cwd is the workspace, which carries a managed CLAUDE.md).

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
