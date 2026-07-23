# team (agent roster)

Manage the specialist **agent roster** — an open, user-defined list of named
agents that **extends** the fixed three (`main`/`reference`/`curator`, in
`settings.agent_config`); it never touches them. Each agent has its **own model**
and a **private knowledge folder**. Source: `src/main/tools/team.ts`
(+ `core/team.ts` for persistence/scaffold, `core/team-pure.ts` for the pure
id/validation/index logic).

This tool **only persists + scaffolds** an agent — it does **not run** one
(delegation to a named agent ships in a later stage).

## Ops, args, output
| op | args | output | risk |
|----|------|--------|------|
| `create` | `name`, `provider`, `model`, `role?` | `{ agent }` | **T2** |
| `list` | — | `{ agents: [...] }` | T0 |
| `delete` | `id` | `{ deleted }` | **T2** |

`create`/`delete` are **T2** — they establish or remove a capability. `list` is
T0.

## create
- **`name`** (required) — display name (e.g. `Coder`). The agent **id** is a
  unique slug derived from it (`agentIdFromName`): `Coder` → `coder`, colliding
  names get `-2`, `-3`, ….
- **`provider`** (required) — one of `claude-api`, `claude-cli`, `openai`,
  `deepseek`.
- **`model`** (required) — a model id **in that provider's catalog**, e.g.
  `claude-opus-4-8` (Opus 4.8), `claude-sonnet-5`, `deepseek-v4-flash`. An unknown
  provider **or** a model not in the provider's catalog is **rejected** with a
  clear error (`validateAgentSpec`).
- **`role`** (optional) — the specialty / system-prompt role; defaults to empty.

On create it:
1. persists a row in `team_agents` `{ id, name, role, provider, model, created_ts }`;
2. scaffolds `<workspace>/agents/<id>/knowledge/` with a seed `role.md`;
3. rebuilds the shared **who-knows-what** index `<workspace>/agents/index.md`
   (one line per agent, name → specialty), so Alfred can route a task to the right
   specialist.

Each agent reads **only its own** `agents/<id>/knowledge/` folder — cross-agent
sharing goes through Alfred / the index, not by reading each other's folders.

## delete
Removes the `team_agents` row and rebuilds the index (so no orphan entry
survives). The agent's `agents/<id>/` folder is **left on disk** — its knowledge
may be worth keeping, and recursive removal is riskier than it's worth.

```json
{ "op": "create", "name": "Coder", "provider": "claude-cli", "model": "claude-opus-4-8", "role": "TypeScript/Node refactors" }
```
