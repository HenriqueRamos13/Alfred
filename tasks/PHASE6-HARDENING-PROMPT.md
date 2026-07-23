# PHASE 6 — Hermes-inspired hardening

> Status: **LOCKED** (user said build all 5, in this priority order). Build in
> stages; each stage = one Opus workflow, verified against the 3 gates and pushed
> with a tag before the next. Ideas are ported from an analysis of NousResearch's
> hermes-agent; we adapt them to Alfred's stack (Electron/Node/TS, AI SDK +
> claude -p, risk-tier governance, file-vault memory, MCP bridge, Playwright,
> job scheduler, Phase-5 agent team). Only the DELTA vs what Alfred already has.

## Stage 1 — Progressive tool disclosure (HIGHEST: Phase 5 will blow the context)

**Problem:** every tool description ships on every model call; the Phase-5 roster
+ per-agent/MCP tools will bloat the tools array and the prompt.

**Build:** when the deferrable tools (MCP + non-core) would exceed a threshold
(~10-15% of the context window), replace them in the model-visible tool array
with **3 bridge tools** — `tool_search(query)`, `tool_describe(name)`,
`tool_call(name, args)`. A small **core set never defers** (filesystem/shell/
system/memory/ui_layout/browser basics). `tool_call` unwraps to the real tool so
**governance/approvals/audit fire identically**. Catalog rebuilt **stateless**
each assembly (no session-keyed drift). Pure-testable: the defer decision
(which tools defer given the budget) + the catalog builder.

## Stage 2 — Delegation roles + spawn bounds (agent-team safety & cost)

**Build (on the Phase-5 team):**
- **leaf** (default) vs **orchestrator** roles. A **leaf** agent's grant is hard-
  restricted: cannot delegate/spawn, cannot write the shared vault, cannot message
  the user, cannot create jobs (a DELEGATE_BLOCKED tool set). **orchestrator** may
  spawn, bounded by `maxSpawnDepth` (default 2) and `maxConcurrentChildren`
  (default 3), enforced with an **explicit error**, not silent.
- **Spawn kill-switch:** a "pause new fan-out" control that freezes NEW subagent
  creation without killing running children.
- **Fail-closed delegated-child marker** (a context flag) so privilege checks
  distinguish a child; a spawned child gets its own risk-tier-scoped, audit-logged
  approval callback that **defaults to deny**, never silently inherits/auto-allows.
- Pure tests: role→blocklist mapping, depth/concurrency guards.

## Stage 3 — Secret vault + full SSRF (the credit-card/passwords goal)

**Build:**
- **Secret-sources port** (`secrets` adapters): pull service credentials at
  use-time from a real vault (macOS Keychain already exists; add a generic
  command-based source + optional 1Password/Bitwarden CLI) instead of storing
  plaintext. Retrieval is risk-tiered (T3) + audited; values never logged.
- **Full SSRF guard** (port Hermes `url_safety`): validate the **resolved IP right
  before connect** (DNS-rebinding aware, preserve Host/SNI), **always block cloud-
  metadata** (169.254.169.254, etc.) even when private URLs are otherwise allowed,
  and **re-validate every redirect hop**. Apply to the Playwright browser, the
  fetch-job runner (extend the Phase-4 guard), and any MCP HTTP path. Pure-testable:
  the IP/host classifier + redirect re-check decision.

## Stage 4 — Memory auto-review + FTS5 recall (Alfred learns on its own)

**Build:**
- **FTS5 session-transcript search** (zero-LLM recall): index every session's raw
  messages in SQLite FTS5; one `recall_sessions` tool with discovery / scroll /
  browse modes (±N message windows). Distinct from the semantic vault — cheap
  "what did we say weeks ago". Pure-testable: the query/mode dispatch + windowing.
- **Background self-improvement review:** after a turn, a **cheap-brain** pass
  (digest of recent turns) decides whether to write a durable memory note or a
  workflow lesson. Writes are **staged through the existing approval/governance**
  (low-risk approval), not auto-committed. Reuses the curator scheduling.
- **Security-scan memory before it enters the prompt** (prompt-injection /
  credential-exfil / invisible-Unicode) — reuse the widget scanner's core.
- Pure tests: the FTS windowing, the "should we record this" decision, the memory
  scan.

## Stage 5 — Scheduler hardening (robustness for autonomy)

**Build (on the Phase-4/5 scheduler):**
- **Per-run hard-interrupt timeout** (a runaway job/agent can't monopolize the
  tick); a **catchup window** clamped to a range for missed runs; a **grace window**
  for missed one-shots; a **cross-process tick file-lock** so two processes never
  double-fire a job.
- **Tool-loop circuit breaker:** track `exactFailure` / `sameToolFailure` /
  `noProgress` counters; soft-warn by default, **hard-stop for autonomous/scheduled
  runs** so a claude -p / agent loop can't burn the whole budget.
- Pure tests: catchup/grace math, the circuit-breaker counters + trip decision.

## Cross-cutting (apply in the relevant stage, per Hermes)

- **Cross-provider schema sanitizer** for tools handed to strict backends
  (collapse nullable anyOf/oneOf, strip $ref siblings) — fold into Stage 1.
- **check_fn availability probing** with TTL + transient-failure grace (don't drop
  a tool on a flaky probe) — fold into Stage 1.
- **Credential env-scoping** for ALL spawns (claude -p already stripped; extend to
  MCP subprocesses + shell) — fold into Stage 3.
- **Honest security framing** in docs: risk-tier approvals are in-process
  heuristics, NOT a boundary against an adversarial model — real trust needs OS
  isolation. Document in Stage 3.

## Non-goals

Chat-platform channels/gateway, Kanban board, ACP adapter, MoA — deferred (not
requested). Don't re-implement browsing, MCP transport, provider fan-out,
scheduling base, approvals, or memory storage — Alfred already has them.

## Verification (every stage)

`tsc --noEmit`=0 · `npm run build` success (no `node:*` in renderer) ·
`node --experimental-strip-types --test test/logic.test.ts` all pass · secret
grep on the diff · 3-sync (manifest/AGENTS/docs) for any new tool.
