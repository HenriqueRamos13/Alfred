# PHASE 7 — Software Company (projects · kanban · hierarchy · inbox · agent forms)

> Status: **PLAN** (awaiting go). Builds on Phase 4 (scheduler/jobs/governance),
> Phase 5 (team roster, `delegate_to_agent`, per-agent knowledge), Phase 6 (roles
> leaf/orchestrator, spawn bounds). **Reuse-first** — nothing here re-implements
> the event bus, modal idiom, card system, agent runner, project core, or TTS;
> it wires new state onto them. Each stage = one Opus workflow → 3 gates → tag.

## 0. Goal (one line)

Turn Alfred into a *governed software org*: per-project workspaces with a Kanban
board the agents CRUD, a **visual agent hierarchy** (CTO / PM / dev-front /
dev-back / QA …), inter-agent **notification loops** so agents self-orchestrate,
a **user inbox** (any agent can ask you directly; you read, reply, and play TTS),
and a guided **agent-creation form** with optional AI augmentation.

## 1. What we reuse (from the codebase map — do NOT rebuild)

- **Event bus**: `emit(StreamEvent)` → `onStream` (single `alfred:stream` channel).
  New live updates = new `StreamEvent` kinds, nothing else.
- **Modal idiom**: `.overlay` siblings of `.canvas` (`ApprovalPrompt`,
  `ReferenceChat`, factory-reset) — the per-project modal uses this, no lib.
- **Card system**: `CARD_TITLES` + `DraggableCard` + `mergeLayout`/`updateCard`.
- **Agent runner**: `runAgentTurn(ctx, spec)` / `delegate_to_agent`.
- **Project core**: `createProject` / `getProject` (exists; only the IPC bridge
  is missing) / `slugify`.
- **Scheduler**: `JobScheduler`, interval jobs, `jobActionDecision` governance.
- **TTS**: `tts.speak(text)` queue (only the orchestrator calls it today; add one
  IPC to speak arbitrary text).
- **Roles**: `delegationRole` leaf|orchestrator + `restrictGrantForRole` (a leaf
  is already hard-blocked from `notify`/`send`).

## 2. Data model (idempotent column/table migrations, mirror `db.ts:201`)

- `team_agents` **+= `parent_id TEXT NULL`** (the org edge — who this agent reports
  to) **+= `can_message_user INTEGER DEFAULT 0`** (inbox power, per-agent).
- **`kanban_cards`**: `id PK, project_slug, title, body, column
  (backlog|todo|doing|review|done), assignee_id, reviewer_id NULL, created_by
  (agentId|'user'), for_whom NULL (agentId|'user'), priority, order_idx,
  created_ts, updated_ts, done_ts NULL`.
- **`inbox_messages`** (agent → user): `id PK, from_agent_id, project_slug NULL,
  card_id NULL, subject, body, created_ts, read_ts NULL, answered_ts NULL,
  answer TEXT NULL`.
- **`agent_notifications`** (agent → agent, loop-consumed): `id PK, to_agent_id,
  kind (assigned|review_requested|done|question|reply|nudge), card_id NULL,
  text, created_ts, seen_ts NULL`.

All project-scoped by `project_slug` (FK-by-convention to `projects.slug`).

## 3. Tools (agents CRUD their own work — governed by grant)

- **`kanban`**: `create_card | list_cards | get_card | update_card | move_card |
  assign | comment | delete_card`. Risk T1 (delete T2). `assign`/`move_card`
  auto-emit `agent_notifications` (assignee on assign; reviewer on →review;
  creator + `for_whom` on →done).
- **`inbox`**: `ask_user {subject, body, projectSlug?, cardId?}` — an agent posts a
  question to the user. **Gated by `can_message_user`** (fail-closed otherwise).
  Async + audited → **safe to allow even on unattended runs** (unlike the live
  `notify`/`send` channel). `list_answers` lets an agent read replies.
- **`team` (extended)**: `create` accepts `parentId` + `canMessageUser`; new op
  `set_manager {agentId, parentId}` (hierarchy edit, **T2**).
- Inter-agent free-form notify folds into `kanban`/lifecycle (no separate tool
  unless a stage needs it) — a **leaf** may only notify up its manager chain.

## 4. Orchestration / loops (honest about the fail-closed ceiling)

- **One "company heartbeat"** recurring `kind:'agent'` interval job (NOT one job
  per card — that would flood `scheduled_jobs`). Each tick scans **open** cards
  and delegates a *continue-or-report* turn to each distinct assignee with its
  card list. Cadence = the heartbeat interval → this IS the "notifica de X em X
  tempo" the user asked for.
- **Card lifecycle** drives the rest: assign → notify assignee; →review → notify
  reviewer (optional); →done → notify creator + `for_whom`. When an agent
  finishes, whoever must know is notified — self-orchestration.
- **Ceiling (must be documented, per `security-model.md` honesty rule):** on
  unattended heartbeat ticks the Phase-4/6 governor still holds — agents may work
  within grant, update cards, write `agent_notifications`, and post
  `inbox.ask_user` (async/safe), but **T2+ actions and live `notify`/`send`/spawn
  still queue or deny**. Agents progress on ticks or on live delegation — they are
  *cooperative and governed*, not always-on daemons. Real trust still needs OS
  isolation (unchanged long-term story).

## 5. UI (the deliverable mocked in `/tmp/alfred-phase7-ui.html`)

- **PROJECTS card**: each project row gets an **OPEN** button → a large per-project
  **floating modal** (`.overlay`).
- **Project modal — tabs**: **Overview** (summary/stack/status/key-files + counts)
  · **Board** (Kanban 5 columns, cards draggable between columns; card = title,
  assignee, reviewer, priority, creator→for-whom; click = detail/edit/comments) ·
  **Org** (visual hierarchy tree — each node an agent: name, role, model, token
  spend, open-card count; edit parent) · **Team** (project roster + "+ Agent"
  button) · **Activity** (project event feed).
- **Inbox** (global): a panel/card — message list (from-agent, subject, time,
  unread dot); click → reader with **▶ TTS** (new `speakText` IPC) + reply box
  (reply becomes an `agent_notification` of kind `reply`).
- **Agent-creation form modal**: fields — name, role/type preset (PM / CTO /
  Dev-Front / Dev-Back / QA / custom), provider, model, **parent (manager)**,
  **can-message-me toggle**, delegation role (leaf/orchestrator), daily token
  budget, system prompt, knowledge seed. Each augmentable field carries a **✨
  "deixar a IA escolher/aumentar"** toggle; on submit Alfred augments the flagged
  or blank fields (a cheap-brain turn), shows the filled form for confirm, then
  creates. **Triggered two ways**: the user clicks "+ Agent", OR the user tells
  Alfred "cria um agente" and Alfred emits a new `agent.form` `StreamEvent` that
  opens the modal **pre-filled** instead of silently creating.

## 6. New IPC / events (all ride the existing bridge)

- IPC: `getProject(slug)` (core exists), `kanban(op,args)`, `inbox(op,args)`,
  `listNotifications`, `speakText(text)` (wraps `tts.speak`), `augmentAgentSpec`.
- `StreamEvent` kinds: `kanban.changed`, `inbox.changed`, `agent.form`.

## 7. Stages (each = workflow → 3 gates → tag)

1. **Schema + `kanban` tool + Board.** New tables, `kanban` tool, `getProject`
   IPC, the per-project modal shell + **Board** tab (drag between columns). Pure
   tests: column-move validation, order/reorder, lifecycle→notification mapping.
2. **Hierarchy.** `parent_id`, **Org** tab tree, `team.create` `parentId` +
   `set_manager` (T2). Pure tests: cycle-prevention, tree build, depth.
3. **Inbox.** `inbox_messages`, `inbox` tool, the Inbox panel, `speakText` IPC +
   TTS button, `can_message_user` gate. Pure tests: gate decision, read/answer
   state machine.
4. **Notification loops.** `agent_notifications`, the heartbeat job, card
   lifecycle notifies, leaf-notifies-up rule. Pure tests: heartbeat scan
   (which assignees get nudged), lifecycle→recipient mapping, hierarchy-notify
   permission.
5. **Agent-creation form + AI augment.** Form modal + `agent.form` event +
   `augmentAgentSpec` turn (fills flagged/blank fields). Pure tests: which fields
   augment, spec validation after merge.

## 8. Governance (enforced in CODE, reused from Phase 4/6)

- Every card/inbox/team tool routes `jobActionDecision` (grant). `can_message_user`
  gates `inbox.ask_user`; leaf without it → denied. Hierarchy edits + create/delete
  agent = **T2**. Heartbeat unattended = fail-closed. Audit every write; mask
  secrets; no blobs in logs. Cycle-prevention on `parent_id` (no manager loops).

## 9. Non-goals / deferred

- No real-time daemon agents (heartbeat/live only). No inter-agent private-folder
  reads (sharing via cards/inbox/index). No external chat gateways. No billing.

## 10. Verification (every stage)

`npx tsc --noEmit`=0 · `npm run build` success (no `node:*`/native in renderer) ·
`node --experimental-strip-types --test test/logic.test.ts` all pass · secret grep
on the diff · **3-sync** (`manifest.ts` / `AGENTS.md` / `docs/tools/<name>.md`) for
each new tool.

---

## 11. Research-validated refinements (fold into the stages)

Web research across MetaGPT, ChatDev, CrewAI, AutoGen/AG2, OpenHands, SWE-agent,
Backlog.md, GitHub Copilot coding agent, LangGraph Agent Inbox, HumanLayer, and
**Paperclip** (see §13). Only the load-bearing deltas — each cited.

**Stage 1 (Board) — card is a work substrate, not a note:**
- Card += `artifact` (the concrete expected deliverable — spec/design/code/
  test-report). **Done-gate: a card can only reach Done when its artifact exists
  and its check is green** — never accept an agent's self-declaration
  ("hallucinated completion"). Reuse Alfred's own 3-gate ethos as the check.
  — MetaGPT (arxiv 2308.00352), ChatDev (2307.07924).
- Card += `acceptance_criteria[]` + `dod[]` (Definition-of-Done checklist) — the
  agent self-ticks, the reviewer re-checks. — Backlog.md.
- Card += `depends_on[]` (a DAG, not a linear chain) → this is what makes
  "notify who needs to know" a graph query, not a guess. — CrewAI `context`.
- **Board is machine-writable (ACI)**: agents CRUD via the structured `kanban`
  tool verbs (create/move/comment/**claim**/complete), *separate* from the human
  drag. Agent success depends on the interface being agent-shaped. — SWE-agent
  (2405.15793).
- **Atomic claim/checkout**: an agent claims a card (`claimed_by`/`claimed_ts`);
  a claim conflict (409) is **never retried** → two agents never grab one card.
  — Paperclip heartbeat protocol.
- **Blocked/Failed lane** kept on the board with the error logged — never
  silently drop a failed card (matches our error-handling rule). — Backlog.md.
- **WIP limits** per column / per agent (small cards + cap) — prevents an agent
  hoarding the board; oversized cards fail (Copilot ~59-min session cap forces
  decomposition). Columns come from an **editable per-project SOP template**, not
  hard-coded. — Copilot coding agent; ChatDev ChatChain.
- Per-card **isolation** (own git branch/workspace) so parallel agents don't
  collide — matches the concurrent-agents rule. — Vibe Kanban (pattern only; it's
  sunsetting, don't depend on it).

**Stage 2 (Hierarchy):** manager-orchestrates / workers-leaf maps 1:1 to
`parent_id`; delegation opt-in + fail-closed (leaf default) is already ours.
Each level owns an artifact type (PM→spec, CTO→design, dev→code, QA→test-report)
→ gives `for_whom` its semantics. **Cap parent_id chain depth + detect cycles**
(A→B→A). — CrewAI processes/agents; MetaGPT.

**Stage 3 (Inbox) — THE load-bearing lesson: async, never blocking.**
- An agent asking the human **writes an inbox item, checkpoints its card
  (`status='waiting_human'`), and yields** — it must NOT block the run. Blocking
  mid-run leaves the run "unstable … cannot be saved or resumed". The reply
  **resumes** the card. — AutoGen HITL **[consensus w/ LangGraph, Paperclip]**.
- **Typed interactions, never free-text yes/no**: `accept | edit-then-accept |
  respond | reject`. Adopt LangGraph's **edit** (human fixes the proposed args
  before approving). **Reject requires a reason** → returned as context to the
  agent's next wake. — Paperclip Issues API; LangGraph Agent Inbox; HumanLayer.
- `idempotencyKey` + **supersedeOnUserComment**: a later human comment invalidates
  a stale pending ask → no zombie questions. — Paperclip.
- **Two-tier gate**: keep formal immutable approvals (reuse T0–T3 for
  spend/security) *separate* from light inline confirmations (plan/task).
- **TTS is our genuine differentiator** — Paperclip is text-only, has no
  `can_message_user`. Read-aloud + voice-respond on the same payload = net-new.

**Stage 4 (Loops) — event-driven first, heartbeat as fallback:**
- **Wake by event, not blind time**: when a dependency card → Done, wake only the
  downstream assignee(s); a child completion wakes the parent — no busy-polling.
  — OpenHands event stream; Paperclip **[consensus]**.
- **Targeted wake, never broadcast** (broadcast trains the human to ignore the
  inbox and burns budget): a `@mention`/one question = one principal woken.
- Heartbeat **self-limiting**: after N nudges, **escalate up `parent_id`** and
  leave an audit comment — fail to a human, not to an infinite loop.
- **Two separate values**: poke interval vs hard `max_execution_time` (the
  timeout can trip termination → card stale → escalate). — CrewAI; AutoGen
  ExternalTermination.
- **Anti-loop is explicit config, never implicit**: `max_iter`, `max_retry`,
  depth cap, max children — a card declares its stop-condition *before* it starts.
  **Never ship an "unlimited" default** for retry/reasoning/spawn on an
  unattended run. — CrewAI; MetaGPT **[consensus]**.

**Stage 5 (Form / review):**
- Field set two mature frameworks converged on: `description`,
  `expected_output/artifact`, `responsavel`, `revisor`, `depends_on`, `async?`,
  `max_attempts/timeout`, acceptance-criteria, DoD. Don't invent a different set.
  — CrewAI Tasks; Backlog.md **[consensus]**.
- **Assignment two modes**: fixed `responsavel`, OR null → an orchestrator routes
  by capability. Prefer **deterministic assignment for unattended runs**; LLM
  routing only when a human is watching.
- **Review is runtime-enforced, not agent-remembered**: the runtime intercepts
  `done→review` and reassigns to the reviewer. The reviewer is a **guardrail**
  (deterministic check OR LLM review) with a bounded retry that **bounces to the
  responsavel with a visible reason** (no hidden retry — matches never-catch-and-
  rewrap). Keep the reviewer **separable** from the assigning orchestrator.
  — Paperclip Execution Policy; CrewAI guardrails.
- New tab **Audit** (append-only WAL of delegations/assignments/completions/
  guardrail verdicts/human answers per project) = the fail-closed governance view.
  — AG2 Hub write-ahead-log; Paperclip `issue_execution_decisions`.

## 12. Anti-patterns (hard "do NOT")

Blocking the agent on the human · free-text yes/no · hallucinated completion
(Done without a green check) · rigid waterfall with no re-open · unbounded
retry/reasoning defaults · no depth cap → delegation cycles · free LLM routing
unattended · a manager reviewing its own output · broadcast notifications ·
silently swallowing a guardrail failure · oversized cards · parallel agents
sharing one workspace/branch · dropping failed cards · depending on Vibe Kanban
as a lib · designing against AutoGen's deprecated GroupChat (AG2 v1.0 = Hub).

## 13. Prior art — Paperclip (converge toward, differentiate on voice)

`paperclipai/paperclip` (MIT, ~74k★) already ships most of this vision: org-chart
with reportsTo+budgets, an issue-kanban with atomic checkout + parent/goal links,
projects/goals, execution policies with review/approval stages, a heartbeat
runtime, and structured human interactions. **Treat it as the primary reference
implementation** and map our fields to theirs (executionState, heartbeat
protocol, Issues API `ask_user_questions|request_confirmation|suggest_tasks` →
`/accept /reject /respond`). Alfred's **genuine differentiators**: voice/TTS
inbox (read + voice-respond), deep native macOS control, and governance enforced
in code. Adjacent: `paperclip-aperture` (now/next/ambient triage), `paperclip-mcp`
(Issues/Agents/Goals/Approvals as MCP tools), `paperclip-plugin-company-wizard`
(role bootstrap). We copy patterns, not the dependency.
