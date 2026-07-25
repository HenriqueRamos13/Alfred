# inbox (async human-in-the-loop)

An agent's **asynchronous** channel to the **user** (Phase 7, stage 3). The lesson
#1 of the research: **HITL is async, NEVER blocking.** When an agent needs a human
decision it **writes** the ask, **checkpoints** the card (`awaiting_human`), and
**yields** — it does not sit blocked waiting. The user answers later; that answer
re-wakes the agent (the automatic resume is Stage 4 — for now the agent polls
`list_answers`). Source: `src/main/tools/inbox.ts` (+ `core/inbox.ts` for
persistence, `core/inbox-pure.ts` for the pure ask-validation / answer
state-machine / dedupe / supersede / unread logic).

Messages persist in `inbox_messages`; every write emits an `inbox.changed`
StreamEvent so the open Inbox + the header unread badge update live.

## Ops, args, output
| op | args | output | risk |
|----|------|--------|------|
| `ask_user` | `kind`, `subject`, `body?`, `projectSlug?`, `cardId?`, `idempotencyKey?` | `{ message, deduped }` | **T1** |
| `list_answers` | `agentId?` | `{ answers: [...] }` | T0 |

`ask_user` **returns immediately** — it NEVER waits for the answer. `list_answers`
returns the `answered`/`rejected` messages (newest first), optionally scoped to one
agent, so a resuming agent reads the user's decision + reason.

## The gate (fail-closed)
Only an agent with **resolved** `can_message_user` power may `ask_user`:
- an **orchestrator** always may;
- a **leaf** may ONLY if its `can_message_user` flag is set;
- otherwise the call is **refused** with a clear error (`agent lacks can_message_user`).

The caller identity is **trusted** — it comes from the delegate runner
(`ctx.caller`), NEVER from model args (which would be spoofable). The top-level
Alfred turn (no delegated caller) is the primary orchestrator and may always ask.
The rule is the same `canMessageUserResolved` used by the `team` tool and the Org
chart, enforced **in code** (see `core/team-format-pure.ts`).

**Scope of enforcement.** The gate is enforced in code on the **in-process
(API-brain) delegate path** — `delegate_to_agent` threads the child's identity
into `ctx.caller`, so a leaf without the flag is refused. A **`claude-cli`**
delegated agent reaches tools via the shared MCP bridge, which runs under the
top-level (caller-less) context, so it is NOT gated here — the same advisory-only
limitation that already applies to per-agent grants on the claude-cli path (see
the ponytail note in `tools/delegate-to-agent.ts`). This is low-risk: `ask_user`
never acts autonomously — it only surfaces a message to the owner.

## The message (fields)
- **`kind`** (required) — the interaction type, one of:
  - `ask_user_questions` — open question(s) needing an answer.
  - `request_confirmation` — a go/no-go on a proposed action.
  - `suggest_tasks` — a proposal (e.g. new cards) for the user to accept/edit.
- **`subject`** (required) — a one-line summary (the list row + reader header).
- **`body`** — the full question / proposal.
- **`projectSlug`** — the project it belongs to (the board Inbox tab filters on it).
- **`cardId`** — the card to **checkpoint**: while the ask is pending the card is
  marked `awaiting_human` (a ⏳ badge on the board). The answer clears it.
- **`idempotencyKey`** — a **dedupe** key: a retried `ask_user` with a key that
  already exists returns the original message (`deduped: true`) and does NOT
  re-checkpoint or duplicate. A blank/absent key never dedupes.

## Lifecycle + the user's typed answer
`pending → answered | rejected` (a typed action) OR `pending → superseded` (zombie).

The user answers with a **typed action** (never a free-text yes/no the agent has to
parse): **`accept`** (take the proposal as-is), **`edit`** (accept with edited args
in the answer), **`respond`** (free-text answer), **`reject`**. **Reject requires a
non-empty reason** — enforced in code (`answerTransition`); the reason returns to
the agent as context. Only a **pending** message is answerable — answering an
already-resolved one is refused, never silently.

**Anti-zombie supersede:** a user **comment** on a card, posted after a still-pending
ask on that card, **supersedes** the ask (`superseded`) and clears `awaiting_human`
— so answering a question the human already moved past can't re-wake a stale thread.

## Two-tier: inbox vs. the formal approvals
The inbox is **separate** from the T0–T3 tool-approval queue (a **two-tier** design):

- **Approvals** gate a **dangerous tool CALL** before it runs (T2/T3 → a HITL
  prompt), enforced by governance. Do NOT fold the inbox into them.
- **The inbox** is a **conversation** the agent starts with the user (a decision,
  a proposal, a question). `ask_user` itself is a benign **T1** write.

## Conversas diretas (user→agent)
The channel is **two-way** (Phase 8, stages 7–9). The sections above are the *agent
asking the user*; this one is the **user opening a plain conversation with a roster
agent** — no card, no typed action, no tool call. It is **not** an inbox message: it
has its **own tables**, and the Inbox overlay simply hosts it under a second tab
(**PEDIDOS | CONVERSAS**). Source: `core/thread-pure.ts` (pure: ladder, chip labels,
prompt window, unread, the `new:<agentId>` sentinel) + `core/threads.ts` (persistence
+ the per-thread drain), UI in `renderer/components/AgentThreads.tsx`.

### Tables
| table | row | notes |
|---|---|---|
| `agent_threads` | `id` (`TH-<8hex>`), `agent_id`, `subject`, `created_ts`, `updated_ts` | **v1 = ONE thread per agent** (`getOrCreateThread`); `subject` is reserved for the multi-thread step and stays `''`. `updated_ts` is bumped by every writer and is what the sidebar orders by. |
| `agent_thread_messages` | `id` (`TM-<8hex>` or the renderer's uuid), `thread_id`, `author`, `body`, `status`, `error`, `created_ts`, `read_ts`, `started_ts`, `done_ts` | `author` is the ONLY authorship signal: `'user'` or the `agentId` (no role column). `read_ts` is **dual-meaning**: on a USER row it is when the AGENT read it; on an AGENT row when the USER opened it — that is what the badge counts. |

A thread row **only exists after the first message**, so the UI opens a new
conversation on a `new:<agentId>` **sentinel** (empty history, live composer) and
swaps in the real id from the send's `{ ok, threadId, messageId }` ack.

### The status ladder (one vocabulary, both surfaces)
`queued → delivered → read → executing → done | error` (+ `dropped`). Forward-only,
**skips allowed** (Alfred's own chat jumps `queued→executing` — there is no inbox to
deliver to) and the three terminals **absorb**: nothing can move a settled message
again. Every write goes through `statusTransition`; an illegal move is **skipped and
logged**, never thrown and never silently applied. The renderer **mints** the message
id (`crypto.randomUUID()`, charset-whitelisted at the IPC boundary) and uses it for
its optimistic bubble, so each `turn.status` event patches exactly one bubble.

The **same** ladder drives `messages.status` in the main chat, so **one** chip
renderer (`statusChipPt`) serves both: `na fila · entregue · lida · em execução ·
✓ concluída · ⚠ falhou · descartada (fila cheia)`. The failure **reason** lives in the
chip's tooltip and under the bubble — never in the chip.

### Governance (unchanged by this feature)
- The turn is **ATTENDED** (`delegationDepth 0`): the user is right there, so a
  sensitive tool takes the **normal** approval path (an `approval.request` reaches the
  HUD) — exactly like answering an inbox ask, never the unattended fail-closed queue.
- It runs through the **same** `runRosterAgentAttended` as `delegate_to_agent`: the
  **spawn gate** first (depth · per-parent concurrency · the SPAWN kill-switch), and a
  refusal is reported as an **errored message** (the user sees `⚠ falhou` + why),
  never a silent drop.
- The agent's **grant floor**, its **role blocklist** and **both** budgets (per-agent
  daily + global) apply verbatim. Sending authorises the **turn**, not the tools.
- Messages pile up **per thread**: a same-agent send while a turn runs waits (`na
  fila`) and the batch is **coalesced into ONE prompt**; different agents run in
  parallel under the shared concurrency ceiling. Over the cap the **oldest** pending
  message is `dropped` — loudly, on the ladder.
- History window: the last 20 messages / 8000 chars, whole messages dropped from the
  oldest end (`buildThreadPrompt`) — never half a message.

### Caveat: `claude-cli` agents
An agent on the `claude-cli` provider **does not stream**: no `agent.chat.delta`
arrives, so the thread shows `em execução` and then the whole reply at once. Its
per-agent grant / inbox gate also stay **advisory** on that path (the MCP bridge runs
under the top-level context — the same limitation documented above for `ask_user`).

### Boot reconciliation
A message still mid-ladder when the app died can never be advanced (its runner is
gone), so boot settles **every** non-terminal row — threads *and* main chat — as
`error` with `interrompida por reinício da app`. Terminal rows are skipped, which is
what makes the pass safe to run over the whole table on every start.

## UI
- **Global Inbox** — the header **✉ INBOX** button opens the overlay; its badge is
  the **sum** of unanswered asks + unread agent replies across threads. Two tabs:
  **PEDIDOS** (the asks) and **CONVERSAS** (the direct threads: a sidebar with the
  agent, the last message, its age and an unread count, plus a **✎ Nova conversa**
  roster picker; the reader shows the bubbles, per-message chips, the live reply and
  the composer — `Enter` envia, `Shift+Enter` nova linha). A roster agent deleted
  mid-thread → history stays readable, the composer is **disabled** with
  *agente removido do roster*.
- **Message list** (PEDIDOS) — from-agent, subject, age, unread dot + a reader.
- **Reader** — subject/body, provenance (agent · project · card link · kind tag ·
  "⏳ à espera Xm"), a **▶ Ouvir** button (TTS via `speakText`), a voice affordance,
  and the four typed actions (reject reveals its mandatory reason inline).
- **Project board** — the per-project modal has an **Inbox tab** (the same list
  filtered to that project, PEDIDOS only — the conversation props are optional, so
  that reuse shows no tab strip); cards with a pending ask show a **⏳ waiting
  human** badge.

## Notes / limits
- **Non-blocking is the contract.** `ask_user` never blocks the run; the agent
  writes and yields. Automatic resume-on-answer is Stage 4; today the agent reads
  answers with `list_answers`.
- Governed like every tool — the orchestrator classifies the risk tier and audits
  the call; a delegated agent is additionally bounded by its grant + role.
