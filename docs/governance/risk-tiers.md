# Risk tiers

Every tool call is classified into a tier that decides whether it runs freely or
pauses for human approval. **Enforced in code** (`src/main/core/governance.ts`
`classifyAction` + each tool's `risk?()` + the orchestrator wrapper) — this doc
is advisory only.

| tier | meaning | approval |
|------|---------|----------|
| **T0** | read / search / list — autopilot | none |
| **T1** | reversible writes in the workspace | none |
| **T2** | delete / send / install / egress / delegation | **human** |
| **T3** | money / credentials | **human** (out of MVP scope) |

`HITL_TIERS = [T2, T3]` — those block until approved.

## How a tier is decided
1. A tool's own `risk(args)` wins when present (e.g. `filesystem` returns T2 for
   `delete`, `shell` returns T2 for destructive commands).
2. Otherwise `classifyAction(name, args)` applies a token-based heuristic with
   precedence **T3 > T2 > T1 > T0**:
   - shell-like tools: destructive command → T2, else T1.
   - name hints: pay/purchase/credential → T3; delete/send/install/publish/deploy
     → T2; write/create/edit/click/type/download/connect → T1;
     read/list/get/search/open → T0.
   - `args.overwrite === true` or `args.force === true` → T2.
   - `render_ui` → T0; unknown tools default to **T1** (never a free read).

## Beyond the static tier
Some approvals are raised **inside** a tool at runtime, because static
classification can't see them: overwriting an existing file, deleting, a
destructive shell command, a browser login wall, connecting a Gmail account. The
**trifecta rule** can also escalate an otherwise-T0/T1 egress to an approval —
see [approval-flow.md](approval-flow.md).

## Audit
Every call is audited (tool, masked args, tier, status, error, duration, and an
approval provenance note). Secret-looking fields are masked before persist/stream.
