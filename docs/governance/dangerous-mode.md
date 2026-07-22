# DANGEROUS mode

A user-controlled setting that **bypasses all approvals**: every T2/T3 (and every
trifecta/tool-raised approval) auto-resolves to approve without prompting.
**Enforced in code** (`ApprovalStore.isDangerous` → `requestApproval` short-circuit
in `src/main/core/governance.ts`); read per turn so toggling it takes effect on
the next turn.

## Rules
- It is a **user setting only** — toggled in the UI, persisted (`dangerous_mode`).
  The agent **never** enables it and cannot enable it via any tool.
- When ON, the system prompt tells the agent: *"never ask for permission or
  confirmation, just execute."* Do not stall waiting for a human — there won't be
  a prompt.
- Auditing still records everything, with the provenance note
  `auto (dangerous mode)`, so the forensic trail shows the bypass.

## What it does NOT bypass
- The **token kill-switch** and **step cap** still hard-stop a task (see budget).
- **Loop detection** still halts an identical-call loop.
- Path/cwd confinement and read-only constraints baked into individual tools
  (e.g. gmail is read-only, delegate's cwd stays in the workspace) still hold.

Use with care: it removes the human checkpoint, not the safety rails that prevent
runaway cost or loops.
