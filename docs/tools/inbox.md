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

## UI
- **Global Inbox** — the header **✉ INBOX** button (with an unread badge) opens an
  overlay: a message list (from-agent, subject, age, unread dot) + a reader.
- **Reader** — subject/body, provenance (agent · project · card link · kind tag ·
  "⏳ à espera Xm"), a **▶ Ouvir** button (TTS via `speakText`), a voice affordance,
  and the four typed actions (reject reveals its mandatory reason inline).
- **Project board** — the per-project modal has an **Inbox tab** (the same list
  filtered to that project); cards with a pending ask show a **⏳ waiting human** badge.

## Notes / limits
- **Non-blocking is the contract.** `ask_user` never blocks the run; the agent
  writes and yields. Automatic resume-on-answer is Stage 4; today the agent reads
  answers with `list_answers`.
- Governed like every tool — the orchestrator classifies the risk tier and audits
  the call; a delegated agent is additionally bounded by its grant + role.
