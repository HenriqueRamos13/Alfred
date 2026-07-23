# PHASE 4 — Scheduled Jobs, Live Widgets & Autonomous Tasks

> Status: **LOCKED** (grill-me interview complete). Build in stages; each stage
> is a separate Opus workflow, verified against the 3 gates and pushed with a
> tag before the next begins. This document is the source of truth for the
> phase — read it fully before implementing any stage.

## 1. Goal (one line)

By voice/text command, Alfred creates a **fixed card that fetches data and
auto-refreshes on a schedule and persists across restarts** — and, more
generally, schedules **recurring autonomous tasks** (e.g. "every 30 min check
Gmail and summarise new mail") that self-invoke, each with its own daily token
budget and governed autonomy, surfaced in a management card.

## 2. The unifying idea

Widgets and autonomous tasks are the **same subsystem**: a persisted
**Scheduled Job**. A job's refresh is one of two kinds:

- **`fetch`** — a cheap code-level fetch (HTTP/API/shell) on a timer. **Zero AI
  tokens** per refresh. Feeds a data card. (The weather example.)
- **`agent`** — an autonomous Alfred/subagent turn driven by an initial prompt
  (e.g. Gmail triage). Costs tokens; bounded by a per-job daily budget. May feed
  a card and/or a notification.

Only **creation** (and `agent` refreshes) spend tokens. `fetch` refreshes are free.

## 3. Decisions (locked in grill-me)

- **Scheduler is in-app** (main process), persisted in the DB, **re-armed on
  boot**. Not OS cron (cron would fire with the app closed — nothing to update).
- **Refresh cadence:** interval (`every 5 min`) **and** fixed clock times
  (`at 09:00`). Both supported.
- **Hybrid + Alfred asks:** on creation Alfred asks the user how they want it
  (source, cadence, and — for `agent` jobs — the autonomy level).
- **Render is tiered** (see §5). Solves "charts without compiling".
- **Per-job daily token budget**, set by the user. On exhaustion the job
  **pauses until the next day + notifies** (never killed mid-run). Global
  `ALFRED_DAILY_TOKEN_BUDGET` kill-switch still applies on top.
- **Autonomy is per-job, granted at creation** (allowlist, enforced in code).
  Default grant = **read + notify** only.
- **Sensitive actions pierce dangerous mode.** Because a scheduled job runs
  **unattended**, sensitive actions never auto-execute — even when dangerous
  mode is ON. They **queue an approval + notify the user; the job pauses that
  action** until the user responds.
- **Management card "Scheduled Tasks"**: per job — schedule, tokens today/limit,
  last/next run, last result, **pending approvals**, pause/resume/delete.

### 3.1 "Sensitive" actions (confirmed) — never auto-run unattended

Even in dangerous mode, for scheduled jobs these queue for approval:

- **Sending / replying / forwarding** email or any outbound message.
- **Money / payments / credit card** — any spend.
- **Deleting or overwriting** data (filesystem delete/overwrite, memory delete,
  DB destructive ops).
- **Credentials / passwords / secrets** — any read or use of the secret store.
- **Egress of private data** (the existing trifecta: untrusted-read + private +
  outbound send → escalate).

Everything else (reading, searching, browsing read-only, summarising,
notifying, writing to the job's own card/workspace notes) runs autonomously
under the job's grant.

## 4. Domain model

New core module `src/main/core/jobs.ts` (+ a `jobs-pure.ts` for renderer-safe /
pure logic, mirroring `reset-pure.ts` / `settings-pure.ts`).

```
Job {
  id: string
  title: string
  kind: 'fetch' | 'agent'
  schedule: { type: 'interval'; everyMs: number } | { type: 'daily'; at: 'HH:MM' }
  // fetch:
  source?: { url: string; method?: 'GET'; headers?: Record<string,string>;
             extract?: string /* jsonpath-ish / template for the card value */ }
  // agent:
  prompt?: string                 // the initial task prompt
  grant?: Capability[]            // allowlisted actions (default: ['read','notify'])
  tokenBudgetDaily?: number       // per-job cap; undefined => a sane default
  // render:
  render: { tier: 1 | 2 | 3; card: string /* builtin card id | 'html' | 'project' */ }
  placement?: { displayId?: number; corner?: 'tl'|'tr'|'bl'|'br' }
  enabled: boolean
  // runtime (persisted):
  lastRunTs?: number; nextRunTs?: number; lastResult?: unknown
  tokensToday?: number; tokensDay?: string /* YYYY-MM-DD for reset */
  pausedReason?: 'budget' | 'approval' | 'error' | null
}
```

### 4.1 Persistence (DB)

- `scheduled_jobs` — one row per job (the struct above, JSON columns where handy).
- `job_runs` — append-only run log: `{ id, jobId, ts, ok, tokens, summary, error }`.
- Pending approvals reuse / extend the existing approval mechanism, tagged with
  `jobId` so the card can show them.

## 5. Render tiers

- **T1 — builtin data card + `fetch`.** Known sources (weather, clock, battery /
  system stats, a generic single-value / small-chart card). A charting lib is
  **vendored** (single-file, e.g. uPlot) and bundled in the renderer — **no npm,
  no compile**. Refresh feeds card props via a `job.data` event. Covers ~90%.
- **T2 — generative self-contained HTML in a sandboxed `<webview>`.** For
  arbitrary / custom viz. Alfred **writes** `<workspace>/widgets/<id>/index.html`
  (JS + vendored lib inline) — the browser is the runtime, **nothing is
  compiled**. Refresh = the page polls a local `data.json` that the job runner
  rewrites. **Security: `nodeIntegration:false`, `contextIsolation:true`, no
  access to Alfred's IPC/preload, a restrictive CSP, network limited to the
  job's declared source(s).**
- **T3 — full project (opt-in, rare).** Scaffold a real project (npm + deps +
  dev server) embedded in a webview. Heavy; only on explicit request; the
  scaffold/install is governed (T2). **Out of MVP** — stage 5, optional.

## 6. Governance & safety (enforced in CODE)

- Creating a job is **T2** (it establishes recurring egress/compute).
- `agent` job runs execute under the job's **grant**; any tool call outside the
  grant is denied in code.
- The **sensitive set (§3.1)** is checked in code on every job tool call and
  **overrides dangerous mode** for unattended jobs: it queues an approval +
  notifies + pauses that action. Not prompt-enforced.
- Per-job token budget + global kill-switch both enforced; budget resets daily.
- Audit every job run (`job_runs` + the existing audit log, secrets masked, no
  base64 blobs — see the vision-phase leak fixes).
- T2 webview is sandboxed as in §5; generated HTML is treated as untrusted.

## 7. Stages (each = one workflow → verify 3 gates → push + tag)

1. **Scheduler core + persistence + budget** (no UI, no webview). `jobs.ts` +
   `jobs-pure.ts`, DB tables, the timer engine (due-calc, re-arm on boot, daily
   budget reset/pause), grant + sensitive-action classification. **Pure tests:**
   next-run computation (interval + daily), budget reset/exhaustion, grant check,
   sensitive-action classifier.
2. **Job lifecycle tool + runners.** A governed `schedule` tool (create / list /
   pause / resume / delete / edit) so Alfred creates jobs on command; the
   creation-time autonomy interview; the `fetch` runner and the `agent` runner
   (subagent turn under grant + budget); the sensitive-action approval queue +
   notifications.
3. **T1 cards + "Scheduled Tasks" management card.** Builtin data cards
   (weather / value / small chart via the vendored lib) fed by `job.data`; the
   management card (schedule, tokens today/limit, last/next, pending approvals,
   pause/resume/delete). Live updates over the existing event stream.
4. **T2 generative HTML widgets in a sandboxed webview.** Generate + write
   self-contained HTML, render in the sandboxed webview, poll `data.json`.
   **Dedicated security review** (sandbox escape, CSP, network confinement,
   untrusted-HTML handling) — the riskiest stage.
5. **T3 full project (optional, deferred).** Only if requested later.

## 8. Non-goals / deferred

- T3 (full npm project + dev server) is deferred to stage 5 / later.
- No OS-level cron; no external scheduler.
- No multi-user; single local user as everywhere else in Alfred.

## 9. Verification (every stage, non-negotiable)

- `npx tsc --noEmit` → 0
- `npm run build` → success (renderer must not import `node:*` / `better-sqlite3`)
- `node --experimental-strip-types --test test/logic.test.ts` → all pass
- secret grep on the diff; no base64 blobs into logs/audit/DB
- Sync the 3 hand-synced places for any new tool: `core/manifest.ts`,
  `AGENTS.md`, `docs/tools/<name>.md`.
