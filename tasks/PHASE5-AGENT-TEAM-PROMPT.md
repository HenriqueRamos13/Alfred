# PHASE 5 — Agent Team (self-learning specialist roster)

> Status: **LOCKED** (grill-me). Build in stages; each stage = one Opus workflow,
> verified against the 3 gates and pushed with a tag before the next. Read this
> whole doc before implementing any stage. Builds on Phase 4 (scheduler, jobs,
> governance) and the existing memory vault, delegate, claudeSpawn, browser.

## 1. Goal (one line)

Named, persistent specialist agents — each with its own model and a private
knowledge folder — that research/specialize (on demand and on a schedule) and
that you or Alfred can call and delegate tasks to. A team that self-improves.

## 2. Decisions (locked)

- **Roster**: a persisted list of user-defined agents, each
  `{ id, name, role (specialty/system prompt), provider, model }` (e.g. a
  "Coder" on `opus-4.8`). Extends today's fixed 3-agent `agent_config`
  (main/reference/curator) into an open roster.
- **Knowledge = private + shared index**: each agent reads ONLY its own folder
  `<workspace>/agents/<id>/knowledge/` (focused specialist, cheap context). A
  single shared **index** ("who knows what") lets Alfred route a task to the
  right specialist. Cross-agent sharing goes through Alfred/the user, not by
  reading each other's folders.
- **Learning = on-demand + scheduled**: "study X" runs a research turn now;
  learning can also be **scheduled** (reuse the Phase 4 scheduler — a job that
  runs a study task on an agent). Each agent has a **daily token budget** (cap
  on autonomous cost). Research uses the browser/web and writes findings to the
  agent's folder + updates the shared index.
- **Invocation = both**: you call an agent directly by name ("ask the Coder to
  …") AND Alfred can delegate to it (a `delegate_to_agent` tool). The agent runs
  with ITS model + ITS knowledge folder loaded as context.
- **Governance = Phase 4 model**: per-agent **grant** (allowlist); sensitive
  actions (§3.1 of Phase 4) queue for approval, never auto-run unattended, even
  in dangerous mode; per-run trifecta escalation (research reads untrusted web →
  any outbound escalates). Per-agent daily token budget + global kill-switch.
- **Prerequisite**: expose a `model` parameter on delegation / the agent runner
  (claude -p already supports `--model`; the tool just never exposed it) so an
  agent can be Opus 4.8 / Sonnet / etc.

## 3. Data model

- Roster: a `team_agents` table (or extend `agent_config`): rows
  `{ id, name, role, provider, model, createdAt }`.
- Knowledge: `<workspace>/agents/<id>/knowledge/*.md` (the agent's private
  notes) + `<workspace>/agents/index.md` — the shared "who-knows-what" MOC that
  each study run updates (agent → topics/specialties).
- Loading: when an agent runs, its system context = its `role` + its knowledge
  index + relevant notes (MOC pattern, not the whole folder, to bound context).

## 4. Stages (each = workflow → 3 gates → push + tag)

1. **Roster + model param + create-agent.** `team_agents` persistence + a tool/
   command to create an agent (`{name, role, provider, model}`) that scaffolds
   `agents/<id>/knowledge/` + a seed role note. Expose `model` on the delegate/
   agent runner (claude -p `--model`). Pure tests: roster CRUD helpers, slug/id.
2. **Delegate to a named agent.** `delegate_to_agent {agentId, task, model?}` —
   runs that agent (its model + its knowledge index/notes as context), governed
   by its grant (Phase 4 `jobActionDecision`), returns the result. Direct-by-name
   invocation path too. Pure tests: context assembly, grant enforcement.
3. **Learn on demand.** "study X" → the agent runs a research turn (browser/web,
   read-only egress) and writes findings to its folder + updates the shared
   index. Governed (grant, trifecta). Pure tests: index update, note write plan.
4. **Scheduled learning + per-agent budget.** Reuse the Phase 4 scheduler: a job
   that runs a study task on an agent on a schedule; enforce the per-agent daily
   token budget (pause on exhaustion, like Phase 4). Pure tests: budget/schedule.
5. **Team UI card + routing.** A "TEAM" card: roster, each agent's model,
   knowledge topics (from the index), last-studied, token budget/spend, pending
   approvals, study/pause/delete. Alfred routes tasks to specialists via the
   shared index. Renderer + pure formatters.

## 5. Non-goals / deferred

- No fully-autonomous continuous learning (agents don't decide on their own what
  to study — always user-triggered or scheduled). Cost stays bounded.
- No inter-agent direct reads (private folders); sharing is via Alfred/index.
- No remote/hosted agents; all local, same single user.

## 6. Governance & safety (enforced in CODE, reused from Phase 4)

- Creating/deleting an agent and scheduling learning = T2.
- Every agent tool call routes through `jobActionDecision` (grant + sensitive →
  approval, pierces dangerous; unattended → fail-closed on runtime-sensitive).
- Research egress (browser/web read) is fine; any OUTBOUND after untrusted read
  escalates (trifecta). Per-agent + global token caps. Audit every run; mask
  secrets; no base64/blobs in logs.

## 7. Verification (every stage)

- `npx tsc --noEmit` = 0 · `npm run build` = success (no `node:*`/native in the
  renderer) · `node --experimental-strip-types --test test/logic.test.ts` all pass.
- secret grep on the diff; 3-sync (manifest/AGENTS/docs) for any new tool.
