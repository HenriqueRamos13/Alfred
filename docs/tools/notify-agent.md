# notify_agent (explicit agent-to-agent wake)

An agent's way to **explicitly** wake another team agent — a manager pokes a
report, or a report flags its manager — without going through a card lifecycle
(Phase 7, stage 4). It writes ONE **targeted** notification (never a broadcast) to
the recipient's wake feed. Source: `src/main/tools/notify-agent.ts` (+
`core/notify.ts` for persistence, `core/notify-pure.ts` for the pure
`notifyPermission` direction rule).

Notifications persist in `agent_notifications`; the write emits a
`notification.changed` StreamEvent so the open project's Activity feed updates live.

## Args, output
| args | output | risk |
|------|--------|------|
| `toAgentId` (required), `text` (required), `cardId?` | `{ notification }` | **T1** |

- **`toAgentId`** — the roster agent to notify (must exist; `team op=list`).
- **`text`** — the wake message (stored prefixed with the sender id).
- **`cardId`** — optional card the wake is about; when set, the notification is
  scoped to that card's project so it lands in that board's Activity feed.

This is for waking **agents**. To message the **user**, use the `inbox` tool
(`ask_user`) — that is the human channel; `notify_agent` never reaches the user.

## The gate (fail-closed — `notifyPermission`)
Enforced **in code**, not by prompt text:
- a **leaf** may notify ONLY **up** its own manager chain (report upward);
- an **orchestrator** may also notify **down** to its descendants (direct a report);
- a **sideways** (peer / unrelated branch) or **self** ping is **refused** with a
  clear error.

The caller identity is **trusted** — it comes from the delegate runner
(`ctx.caller`), NEVER from model args. The top-level Alfred turn (no delegated
caller) is the primary orchestrator and may notify anyone. Same in-process
(API-brain) enforcement scope as the `inbox` tool: a `claude-cli` delegated agent
reaches tools via the shared MCP bridge under the caller-less top-level context, so
the direction rule is advisory there — low-risk, since the tool only writes a
notification row (no autonomous action, no egress).

## Notification kinds (shared feed)
`notify_agent` writes a `reply`-kind row (an inbound message for you). The same
`agent_notifications` feed also carries the automatic wakes:
`assigned` / `review_requested` / `done` (card lifecycle), `dep_ready` (a
dependency cleared), `reply` (an inbox answer re-wake or a `notify_agent`), and
`nudge` / `escalation` (the self-limiting heartbeat). The Activity tab renders them
all, colour-coded, newest first.

## UI
The per-project modal's **Activity tab** is the append-only governance audit of
this feed; a board card the heartbeat has poked shows a ⟳ overdue pulse; the Org
tab shows each agent's live state (idle / working / blocked / waiting-human).

## Notes / limits
- **Targeted, never a broadcast** — exactly one recipient per call.
- Governed like every tool: the orchestrator classifies + audits the call; a
  delegated agent is additionally bounded by its grant + role.
- Writing a notification is a safe internal write (no egress), so it is a benign
  **T1**.
