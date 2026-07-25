# PHASE 8 — Agent UX (edit · details modal · live activity · direct chat · message status · Opus 5)

> Status: **LOCKED** (approved 2026-07-25). Builds on Phase 5 (team roster,
> `delegate_to_agent`, per-agent knowledge), Phase 6 (roles, spawn bounds,
> kill-switch), Phase 7 (inbox, hierarchy, agent form). **Reuse-first** — no new
> event bus, modal lib, or runner; every feature wires onto `emit(StreamEvent)`,
> the `.overlay` modal idiom, and `runAgentTurn`. Each stage = Opus implements →
> 3 gates green (`npx tsc --noEmit` · `npm run build` · `npm test`) → commit.

## 0. Goal (one line)

Make the agent roster *operable*: edit any agent, inspect it in a details modal,
see live what it is doing (working/studying/waiting-approval), talk to any agent
directly from the Inbox in persistent threads, and see every user message's
status (queued → delivered → read → executing → done) — plus ship Claude Opus 5
as the new Anthropic default.

## 1. What we reuse (do NOT rebuild)

- **Event bus**: `emit(StreamEvent)` → single `alfred:stream` channel; new live
  updates = new `StreamEvent` kinds in `core/types.ts` only.
- **Modal idiom**: `.overlay` sibling of `.canvas`; `pm-*` classes (ProjectModal)
  for tabbed modals, `af-*` (AgentForm) for form fields. Everything interactive
  needs `no-drag`.
- **Agent runner**: `runAgentTurn` (grant floor, role blocklist, budgets,
  governance) + the spawn gate (`canSpawn`/`enterChild`/`exitChild`) in
  `delegate-to-agent.ts` — threads run through them, never around them.
- **Validation**: `validateAgentSpec`/`validateFormSpec`, `fillFormSpec`,
  `mergeRole`, `wouldCycle`/`orgDepth`, `findModel` catalog checks.
- **Precedents**: `reference.*` event family (scoped side-conversation),
  `activeByParent` in-process Map (single-orchestrator state), idempotent
  PRAGMA-guarded migrations in `db.ts`.

## 2. Stages

### Stage 1 — Claude Opus 5 in the catalog + new default
`modelCatalog.ts`: add `{ id: 'claude-opus-5', name: 'Opus 5', inputPerM: 5,
outputPerM: 25, vision: true }` to `ANTHROPIC_MODELS` (right after
`claude-fable-5`; list order = dropdown order). `DEFAULT_MODEL['claude-api'|
'claude-cli']` → `'claude-opus-5'`. `providers.ts` env fallback
(`ANTHROPIC_MODEL`/`ALFRED_MODEL`) → `'claude-opus-5'`.
Tests first: new asserts (`findModel`, `catalogPrices` {5,25},
`modelSupportsVision`, `costOf`); update old-default asserts
(`agentClaudeModel` fallbacks, `mainDefault` fixtures — grep
`claude-sonnet-5` in `test/logic.test.ts`).
Doc/example refresh (stale IDs): `manifest.ts:28,33,34` · `AGENTS.md:32-33,
40-42` · `docs/tools/models.md` · `docs/tools/team.md` · `tools/delegate.ts:42`
· `tools/team.ts:50-51,73` · `README.md` · `docs/OVERVIEW.md` · `.env.example`
· `pricing.ts:10-16` provenance comment. Renderer: zero edits (derives from
catalog).

### Stage 2 — Fix studied-topics data loss
Bug: `rebuildIndex` → `buildAgentsIndex` regenerates `agents/index.md` from DB
rows and drops every `· studied:` suffix (team-pure.ts:424-427).
Pure first: `topicsFromKnowledge(files)` (topic = first `# ` heading of each
`knowledge/*.md`, excluding `role`/`seed`; slug fallback; ci-dedupe);
`buildAgentsIndex(agents, topicsById = {})` emits the exact
`parseTopicsFromIndex` format (round-trip + "topics survive rebuild" regression
test). IO: `rebuildIndex` reads the knowledge folders and passes `topicsById`.

### Stage 3 — Edit team agents (backend + tool + docs)
Pure first: `splitRole(merged)` in `agent-augment-pure.ts` (best-effort inverse
of `mergeRole`: first block is the label only when single-line ≤80 chars +
blank + more text); `validateAgentPatch(agents, id, input)` in `team-pure.ts`
(partial patch vs existing row: **id/slug immutable** — rename changes `name`
only; effective (provider,model) must pass `findModel`; `parentId` via
`wouldCycle`/`orgDepth`/`DEFAULT_MAX_SPAWN_DEPTH`; `dailyTokenBudget` null/0
clears; `canMessageUser` absent = unchanged; grant validated as at create);
`composeRoleNote` extracted from `createAgent`.
DB: `ALTER TABLE team_agents ADD COLUMN updated_ts INTEGER` (teamCols block) +
SCHEMA text + `TeamAgent.updatedTs?`.
Core: `updateAgent(db, workspace, id, input)` — dynamic UPDATE of present
columns + `updated_ts`; rewrite `role.md` only if its first line still equals
`# <oldName> — role`; `rebuildIndex` at the end. Edit-while-running: row is
snapshotted at turn start → patch applies to the next run (documented).
Orchestrator/IPC/preload: `updateTeamAgent(id, spec: AgentFormSpec)` (full-form
via `fillFormSpec` + `mergeRole`; grant/knowledgeSeed untouched) → handler
`alfred:updateTeamAgent` → preload; emits `team.changed`.
Tool: `team` op=`update` (T2, **partial** semantics, `0 = remove o limite`) +
emit `team.changed`. Hand-sync: `manifest.ts:34`, `AGENTS.md:41`,
`docs/tools/team.md` (`## update` section).

### Stage 4 — Live agent activity
Pure first: new `agent-activity-pure.ts` — `AgentActivityState =
idle|working|studying|waiting-approval`; token'd LIFO stack
(`pushActivity`/`removeActivity`, unknown-token no-op); `resolveActivity`
(precedence waiting-approval > studying > working; empty → idle);
`truncateLabel`. `activityLabelPt` in `team-format-pure.ts` (inativo · a
trabalhar · a estudar · aguarda aprovação).
Registry (main-only): new `agent-activity.ts` — `Map<agentId, ActivityEntry[]>`
in memory (ephemeral is truthful across restarts); `beginActivity(emit,
agentId, state, label?) → end()` idempotent; emits `agent.activity` only when
the resolved state changes.
Types: `StreamEvent` += `{ kind: 'agent.activity'; agentId; activity }`;
`TeamAgentInfo` += `activity`.
Hooks: (1) `delegate-to-agent.ts` execute — `beginActivity('working', task)`
after `enterChild`, `end()` in the `finally` (covers API + claude-cli; moves
into `runRosterAgentAttended` in Stage 8); (2) `agent-study.ts` `runStudy` —
`beginActivity('studying', topic)` after agent lookup, try/finally (covers
attended tool AND scheduled study; no jobs.ts change); (3) `runAgentTurn` —
wrap `governance.requestApproval` in `baseCtx` for 'waiting-approval' during
the human wait (unattended auto-deny stub layers on top as today). Accepted
caveat: claude-cli MCP-bridge approvals aren't attributable to the agent.
UI: `listTeamAgents` includes `getActivity(a.id)`; TeamCard status dot (colors
from `AgentStatus.tsx`, pulse) + label; refetch on `agent.activity`;
`.team-dot`/`.team-activity` CSS.

### Stage 5 — TeamAgentDetail projection + IPC
Pure first: `noteMeta(fileName, body)` (title = first heading, ~280-char
excerpt). Types: `AgentKnowledgeNote`, `TeamAgentDetail` (merged role, grant,
delegationRole, budget, parentId, canMessageUser, createdTs/updatedTs,
tokensToday, topics, activity, notes).
Core: `listKnowledgeNotes` / `readKnowledgeNote` in `team.ts`, both guarded by
`/^[a-z0-9-]+$/` on agentId AND slug (IPC-reachable). Orchestrator:
`getTeamAgentDetail(id)` composes `getAgent` + `agentTokensToday` +
`parseTopicsFromIndex` + `getActivity` + `listKnowledgeNotes`;
`readAgentNote(agentId, slug)`. IPC `alfred:getTeamAgentDetail` /
`alfred:readAgentNote` + preload. Delete the dead `getTeamAgent` if tsc allows.

### Stage 6 — AgentModal + TeamCard affordance
New `AgentModal.tsx` (ProjectModal dialect, self-contained fetch, refetch on
`team.changed` / matching `agent.activity` / `job.approval`). Tabs (PT-PT):
**visão geral** (stat tiles: tokens hoje/tópicos/notas; kv rows: papel, ✉,
reporta a, criado/atualizado; role via `splitRole`) · **editar** (AgentForm
fields, dependent provider→model selects, manager select excluding self, no ✨
augment/knowledgeSeed; seed `fillFormSpec({...detail, ...splitRole(...)})`;
validate `validateFormSpec`; `alfred.updateTeamAgent` → `✓ Guardado`) ·
**conhecimento** (topic chips + note list; click → `.pm-overlay2` viewer with
`readAgentNote` + `Markdown`) · **atividade** (current state + since, tokens/
budget, pending approvals with APROVAR/RECUSAR, recent notes).
**Esc-to-close** on AgentModal + retrofit into `AgentForm.tsx` and
`ProjectModal.tsx` (none has it today). TeamCard: `onOpenAgent` prop, clickable
row + `ver detalhes ›` button, `stopPropagation` on delete/approve. App.tsx:
`openAgentId` state + modal sibling. Deleted-while-open → "agente removido"
empty state.

### Stage 7 — User↔agent threads: pure + DB
Decisions: **new tables** (`agent_threads`, `agent_thread_messages`) — do not
touch `inbox_messages` ask/answer semantics; **v1 = one thread per agent**
(`getOrCreateThread`); one status ladder for BOTH Alfred chat and threads:
`queued → delivered → read → executing → done|error` (+`dropped`), forward-only
with skips allowed, terminals absorbing.
Pure first: new `thread-pure.ts` — `statusTransition`, `reconcileStaleStatus`
(boot: non-terminal → error "interrompida por reinício da app"),
`validateUserMessage` (trim/blank/8000 cap), `buildThreadPrompt` (window: last
20 messages / ~8000 chars, whole messages), `threadUnreadCount`,
`ThreadMessage`/`ThreadInfo` shapes. `turn-queue-pure.ts` — `TurnItem
{id,text}`, `enqueueTurnItem`, `coalesceTurnItems` (ids preserved).
DB: `CREATE TABLE IF NOT EXISTS agent_threads` (`TH-<8hex>`, agent_id, subject,
created_ts, updated_ts) + `agent_thread_messages` (`TM-<8hex>`, thread_id,
author 'user'|agentId, body, status, error, created_ts, read_ts, started_ts,
done_ts) + indexes; `ALTER TABLE messages ADD COLUMN status TEXT` (FTS trigger
churn accepted + commented); `insertMessage`/`getRecentMessages` carry status;
`setMessageStatus`. IO: new `threads.ts` (main-only, db-by-parameter) — CRUD +
`deliverMessages`/`markMessagesRead`/`markExecuting`/`markDone`/`markError`
via `statusTransition` + `reconcileThreadsAtBoot`.

### Stage 8 — Shared attended runner + thread orchestration + IPC
`delegate-to-agent.ts`: extract exported `runRosterAgentAttended(ctx, agent,
task, opts?)` (spawn gate + enterChild/exitChild + provider branch + the
Stage-4 'working' hook moves in); `execute` calls it (behavior-identical);
`AgentTurnSpec` gains `onDelta?` (text-delta branch).
`threads.ts` `sendUserMessage({db, ctx, emit}, agentId, text, messageId?)`:
validate → `getAgent` → `queued` row + events → per-thread FIFO single-flight
drain → `delivered` → `buildThreadPrompt` → `read` → `executing` →
`await runRosterAgentAttended(…, {onDelta → agent.chat.delta})` → reply row +
`done`|`error`. Governance: the user's send authorizes the TURN (same trust
model as `answerInbox`); every tool inside still hits grant floor/blocklist/
budgets/`approval.request`. claude-cli agents supported (attended; no deltas;
grant advisory — existing documented caveat).
`orchestrator.ts`: `turnQueue: TurnItem[]`; `send(text, messageId?)` —
renderer-generated `crypto.randomUUID()` correlation; insert `status:'queued'`
+ `turn.status {queueDepth}`; drain marks batch `executing`→`done|error`;
overflow → `dropped` + event; the 4 queue-clear sites mark `dropped`; voice
send generates the id in main (`voice.command` gains `messageId?`). Handle:
`messageAgent`, `listThreads`, `listThreadMessages`, `markThreadRead`; boot
reconciliation.
Types: `StreamEvent` += `agent.chat.delta|message|done|error` (threadId-scoped,
mirroring `reference.*`), `thread.changed`, `turn.status {messageId, state,
queueDepth?, error?}`. IPC: `alfred:send` gains validated 2nd arg
(`/^[A-Za-z0-9-]{1,64}$/`); new `alfred:messageAgent`/`listThreads`/
`listThreadMessages`/`markThreadRead`.
Concurrency: same-agent FIFO visible as "na fila"; different agents parallel
under the shared `maxConcurrentChildren` ceiling (refusal → error status with
reason); Alfred main turn concurrent = allowed. Single approval slot in App is
a pre-existing limitation (flagged, not fixed).

### Stage 9 — Renderer: conversations + status chips
New `AgentThreads.tsx` (props-driven like ReferenceChat): `ThreadsPane` (list +
"✎ Nova conversa" roster picker) + `ThreadView` (bubbles, per-message status
chips, live streaming, composer; roster-removed agent → disabled composer +
banner). `Inbox.tsx`: `PEDIDOS | CONVERSAS` tab strip; new props all optional
(ProjectModal reuse keeps compiling). `ChatLog.tsx`: user-bubble chip — `na
fila · entregue · lida · em execução · ✓ concluída · ⚠ falhou · descartada
(fila cheia)`. `App.tsx`: `doSend` generates the uuid; `turn.status` patches
`messages`; `agent.chat.*` scoped by `openThreadRef` (mirror `refThreadRef`);
`thread.changed` refetch; header badge = inbox unread + thread unread; thread
props into `InboxOverlay`. `theme.css` chips/threads. Doc sync: `manifest.ts`
inbox bullet (user can open a direct thread; message arrives as a normal
ATTENDED turn with recent history), `AGENTS.md`, `docs/tools/inbox.md`
("Conversas diretas": tables, status ladder, governance, claude-cli caveat).

## 3. Edge cases (decided)

| Case | Decision |
|---|---|
| Agent rename | slug/id immutable; only `name` changes (folder, `agent:<id>` budget key, parent refs intact) |
| Provider change | effective (provider,model) validated; UI resets incompatible model |
| Edit while running | turn snapshots the row; patch applies next run |
| Agent deleted mid-thread | compose refused / queued msg → `error`; composer disabled |
| Budget exhausted mid-reply | msg → `error` with existing PT text; thread usable next day |
| Restart with in-flight msgs | boot reconciliation → `error` "interrompida por reinício da app" |
| Queue overflow | `dropped` status + event (was silent console.warn) |
| Activity state | in-memory only (single orchestrator process); clean reset on relaunch |

## 4. Gates & verification

Per stage: `npx tsc --noEmit` · `npm run build` · `npm test` — all green before
the Conventional Commit (no AI attribution). ~25 new pure-logic test cases
across the stages (always written first). Final smoke on Linux: `npm run dev` —
HUD boots; create → edit agent in the modal; activity dot during a
delegate/study; Inbox conversation with progressing status chips; Opus 5 in
every picker and as the new-config default.
