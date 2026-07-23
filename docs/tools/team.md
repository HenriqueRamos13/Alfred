# team (agent roster)

Manage the specialist **agent roster** — an open, user-defined list of named
agents that **extends** the fixed three (`main`/`reference`/`curator`, in
`settings.agent_config`); it never touches them. Each agent has its **own model**
and a **private knowledge folder**. Source: `src/main/tools/team.ts`
(+ `core/team.ts` for persistence/scaffold, `core/team-pure.ts` for the pure
id/validation/index logic).

This tool **persists + scaffolds** an agent; you **run** one with
[`delegate_to_agent`](#delegate_to_agent-run-an-agent) (see below).

## Ops, args, output
| op | args | output | risk |
|----|------|--------|------|
| `create` | `name`, `provider`, `model`, `role?`, `grant?`, `dailyTokenBudget?` | `{ agent }` | **T2** |
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
- **`grant`** (optional) — the agent's **autonomy allowlist** when delegated to,
  an array of capabilities (`read`, `notify`, `write`, `browse`, `shell`, `send`,
  `delete`, `money`, `secrets`). Defaults to `["read","notify"]`. Rows written
  before this column existed load with the default (tolerant `parseGrant`).
- **`dailyTokenBudget`** (optional) — a **per-agent daily token cap** for
  autonomous runs (`delegate_to_agent` + `agent_study` + scheduled `study`). A
  positive number; omitted → **unlimited** beyond the global kill-switch. Usage
  is tracked per-agent per-day (the day-keyed `usage_by_model` rows recorded under
  the `agent:<id>` session), so no separate counter is maintained. The decision is
  pure (`agentBudgetDecision` in `team-pure.ts`): daily reset, then
  `spent + estimate <= cap`; on exhaustion an attended run returns a clear error
  and a scheduled `study` **pauses** its job. *(claude-cli agents can't be metered
  — the external `claude -p` child has no token accounting — so their per-agent
  cap can't bite, same as the global kill-switch.)*

On create it:
1. persists a row in `team_agents` `{ id, name, role, provider, model, grant_json, daily_token_budget, created_ts }`;
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
{ "op": "create", "name": "Coder", "provider": "claude-cli", "model": "claude-opus-4-8", "role": "TypeScript/Node refactors", "grant": ["read", "write", "shell"] }
```

## delegate_to_agent (run an agent)

`delegate_to_agent {agentId, task, model?}` runs **one turn** of a roster agent.
Source: `src/main/tools/delegate-to-agent.ts` (+ `core/team.ts loadAgentContext`,
`core/team-pure.ts buildAgentContext/resolveTeamModel`). **Risk T2** — delegating
autonomous execution, gated once before it runs.

- **`agentId`** (required) — the id from `team op=list`. Unknown → clear error.
- **`task`** (required) — the prompt handed to the agent.
- **`model`** (optional) — overrides the agent's model, but **only** if it is in
  that agent's provider catalog (`resolveTeamModel`); otherwise the agent's own
  model is used.

**Context.** The agent runs with a bounded system context assembled by
`buildAgentContext`: its **role** + the shared **who-knows-what index**
(`agents/index.md`, so it knows what the team knows) + its **own** private notes
(read from ONLY `agents/<id>/knowledge/` — the isolation boundary), each excerpt-
and section-capped (MOC pattern, never the whole folder). One agent can never see
another's notes.

**Execution paths (by provider).**
- **API brains** (`claude-api` / `openai` / `deepseek`) → an in-process AI-SDK
  turn (`streamText` + tools). Every tool call is intercepted.
- **`claude-cli`** → spawns `claude -p --model <id>` with the context prepended
  to the task; the child reaches Alfred's governed tools via the MCP bridge.

**Governance (attended).** A human fired this, so:
- the **grant** decides *which* capabilities the agent may use — a call outside
  the grant is **refused** to the model (enforced in code on the API path; on the
  `claude-cli` path the grant is advisory in the prompt, and the enforceable
  ceiling is the sensitive-action approval below);
- **sensitive** actions (send / pay / delete / secrets / egress) still go through
  **normal** approval — never the unattended fail-closed queue, and dangerous mode
  bypasses approvals but **not** the grant allowlist.

**Budget.** Token spend counts against the agent's **per-agent daily budget**
(`dailyTokenBudget`, if set) checked **before** the turn — an exhausted agent
returns `{ ok:false, error:"orçamento diário do agente … esgotado" }` and never
starts — **and** the **global** daily kill-switch on top. Per-agent usage is the
day-keyed `usage_by_model` spend under the `agent:<id>` session (no separate
counter).

```json
{ "agentId": "coder", "task": "Refactor src/foo.ts to use async/await", "model": "claude-sonnet-5" }
```

## agent_study (teach an agent on demand)

`agent_study {agentId, topic, model?}` makes a roster agent **learn** a topic
now. Source: `src/main/tools/agent-study.ts` (+ `core/team.ts` `saveStudyNote` /
`addStudyTopicToIndex`, `core/team-pure.ts` `studyNoteSlug` / `composeStudyNote`
/ `addTopicToIndex`). **Risk T2** — egress research plus persisted knowledge,
gated once before it runs.

- **`agentId`** (required) — the id from `team op=list`. Unknown → clear error.
- **`topic`** (required) — what to study (e.g. `Rust async runtimes`). Its
  `slugify` slug is the note filename.
- **`model`** (optional) — overrides the agent's model, same rule as
  `delegate_to_agent` (`resolveTeamModel`).

**How it runs.** Both `agent_study` (attended) and scheduled `study` jobs call
one factored core, **`runStudy(ctx, agentId, topic, { unattended })`** (exported
from `agent-study.ts`). The **attended** path reuses the `delegate_to_agent`
runner verbatim — same model, same assembled context, same per-tool grant
enforcement, same attended governance, same per-run trifecta escalation, same
**per-agent + global** daily token budgets — handing the agent a fixed research
brief: *research the topic with the browser (read-only), then output the
synthesis as the final message; do not save files*. To avoid recursion, a
studying/delegated agent's toolset excludes both `delegate_to_agent` and
`agent_study`.

**Scheduled study (unattended).** `schedule` with `kind:"study"` and
`study:{agentId, topic}` runs the SAME `runStudy` with `{ unattended:true }` on a
timer. There is **no human**, so governance is fail-closed: every tool call is
gated by `jobActionDecision` + trifecta escalation — sensitive/outbound actions
**queue** for the user's later approval (never auto-run, even in dangerous mode),
benign in-grant reads proceed. The scheduled agent must be an **API brain**
(`claude-cli` can't run unattended in-process). On per-agent budget exhaustion
the job is **paused** (like a Phase-4 agent job) and the user is notified.

**Grant / governance.**
- Web research is browser **read** (read-only egress) → the `read` capability.
  The agent's grant **must** include `read`, else the run is refused up front
  with a clear error to grant it (`team op=create … grant:["read", …]`).
- **Attended** (a human triggered it) → sensitive actions take the normal
  approval path. Reading untrusted web content is fine; if the agent then
  attempts anything **outbound**, the trifecta escalation (in the reused runner)
  forces human approval. The note write itself is **local** — a file in the
  agent's own folder, confined by a `slugify` slug (no `/`, `.`, `..`), never
  egress — and is done by the **trusted runner**, not by the agent (the agent
  gets no arbitrary file-write tool).

**Persistence.** The runner captures the agent's final synthesised text and:
1. writes it to `agents/<agentId>/knowledge/<slug>.md` — a **fresh** note, or a
   dated `## Update <YYYY-MM-DD>` section **appended** if the topic was studied
   before (`composeStudyNote` — never overwrites);
2. adds the topic to that agent's line in the shared `agents/index.md`
   (`· studied: …`, deduped) so Alfred can route by learned topic
   (`addTopicToIndex`).

Returns `{ agent, topic, note (relative path), mode: "create"|"append",
indexUpdated, findings }`.

```json
{ "agentId": "researcher", "topic": "Rust async runtimes" }
```
