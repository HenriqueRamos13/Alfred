# kanban (project board)

The **machine-writable** interface to a project's Kanban board (Phase 7). Agents
CRUD their own work through these structured verbs (ACI — the interface is
agent-shaped), **separate** from the human drag (which goes through the `kanban`
IPC from the UI). Both write the same `kanban_cards` table and share ONE set of
invariants. Source: `src/main/tools/kanban.ts` (+ `core/kanban.ts` for
persistence, `core/kanban-pure.ts` for the pure column-graph / Done-gate / claim /
reorder / lifecycle logic).

Cards are project-scoped by `projectSlug` (FK-by-convention to `projects.slug`).
Every **write** emits a `kanban.changed {projectSlug}` StreamEvent so the open
project board updates live.

## Ops, args, output
| op | args | output | risk |
|----|------|--------|------|
| `create_card` | `projectSlug`, `title`, + optional fields (below) | `{ card }` | **T1** |
| `list_cards` | `projectSlug` | `{ cards: [...] }` | T0 |
| `get_card` | `id` | `{ card }` | T0 |
| `update_card` | `id`, + any editable fields | `{ card }` | **T1** |
| `move_card` | `id`, `column` | `{ card }` | **T1** |
| `assign` | `id`, `assigneeId?`, `reviewerId?` | `{ card }` | **T1** |
| `comment` | `id`, `text` | `{ card }` | **T1** |
| `claim` | `id`, `agentId` | `{ card }` | **T1** |
| `complete` | `id` | `{ card }` | **T1** |
| `delete_card` | `id` | `{ deleted }` | **T2** |

`delete_card` is **T2** (removes work); the other writes are **T1**; `list_cards`
/ `get_card` are T0. Governed like every tool — the orchestrator classifies the
risk tier and gates approvals; a delegated agent is additionally bounded by its
grant.

## The card (fields)
A card is a **work substrate**, not a note (MetaGPT / ChatDev / Backlog.md):

- **`projectSlug`** (create, required) — the board's project.
- **`title`** (create, required) · **`body`** — description / running notes.
- **`column`** — lane: `backlog | todo | doing | review | done | blocked | failed`
  (default `backlog`). `blocked`/`failed` are the **never-silently-drop** lanes.
- **`assigneeId`** / **`reviewerId`** / **`forWhom`** — agentId or `user` (nullable).
- **`createdBy`** — agentId or `user` (a tool call defaults to `alfred`; the UI sets `user`).
- **`priority`** — `low | med | high` (default `med`).
- **`artifact`** — the concrete expected deliverable (spec / design / code /
  test-report). **The Done-gate needs it non-empty.**
- **`acceptance`** / **`dod`** — checklists `[{text, done}]`. `dod` is the
  **Definition-of-Done** the gate checks.
- **`dependsOn`** — card ids this card depends on (a DAG, not a linear chain).
- **`maxAttempts`** (default 3), **`timeoutMs`**, **`stopCondition`** — the
  bounded-run knobs (consumed by later stages; never an "unlimited" default).
- Runtime: `orderIdx`, `claimedBy`/`claimedTs`, `attempts`, `createdTs`,
  `updatedTs`, `doneTs`.

The card **id** is a per-project, human-friendly `<PREFIX>-<n>` (e.g.
`nimbus-billing` → `NIM-1`, `NIM-2`, …).

## Invariants (enforced in code — `kanban-pure.ts`)

### Done-gate — no hallucinated completion
A card reaches `done` **only** when its `artifact` is non-empty **AND every `dod`
item is ticked** — never on the agent's say-so (`doneGateDecision`). `move_card`
and `complete` both enforce it; a blocked move returns the **reasons** (no silent
refusal). Set the artifact + tick the DoD first, then complete.

### Column transitions (`canMoveColumn`)
Normal flow `backlog ↔ todo ↔ doing ↔ review → done` (and `done → review` to
re-open — no rigid waterfall). `blocked`/`failed` are reachable from **any** lane;
a blocked/failed card re-opens into any active lane but **never straight to
`done`**. An illegal transition is refused with a clear error.

### Atomic claim (409 never retried)
`claim {id, agentId}` checks `claimDecision`: an unclaimed card (or a re-claim by
the same agent) succeeds; a card already claimed by **someone else** is a **409
conflict that must NEVER be retried**, so two agents never grab one card (Paperclip
heartbeat protocol).

### comment
No comments table exists in the data model, so a comment is **appended to the
card `body`** as a dated, authored line. (A dedicated comment thread is the
upgrade path when the Stage-4 Activity/notification work lands.)

## Lifecycle → recipients (Stage 4 preview)
`lifecycleRecipients(card, event)` maps an event to who must be told — `assign`→
assignee, `review`→reviewer, `done`→creator + `forWhom` (deduped). Stage 1 only
computes the list; the `agent_notifications` table + heartbeat land in Stage 4.

## Human vs. agent
The **agent** uses this governed tool. The **user** manipulates the same board
directly from the project modal (drag between lanes, edit a card, delete) via the
`kanban(op, args)` IPC — which routes to the same `core/kanban.ts` with
`createdBy='user'`, bypassing tool approvals (a user action, like a layout drag)
but honouring the identical gated-move / Done-gate / atomic-claim invariants.
