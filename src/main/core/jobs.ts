/**
 * Scheduled jobs — persistence + the in-app timer engine (Phase 4, stage 1).
 * MAIN-only: takes the Database by parameter (never value-imports the driver),
 * so the pure logic (jobs-pure.ts) stays testable and this file stays thin.
 *
 * The engine re-arms persisted jobs on boot, computes next-run times, and fires
 * due jobs. There is NO real runner yet (fetch/agent land in stage 2): a
 * `runJob` port is injected and defaults to a logged no-op. Timers are
 * `.unref()`d so an idle scheduler never keeps the process alive (dormant-safe).
 */

import { randomUUID } from 'node:crypto';
import { streamText, tool, jsonSchema, stepCountIs } from 'ai';
import type { ToolSet } from 'ai';
import {
  nextRun,
  extractValue,
  fetchUrlError,
  budgetDecision,
  jobActionDecision,
  escalateForTrifecta,
  nextApprovalStatus,
  DEFAULT_GRANT,
  type JobRunState,
} from './jobs-pure.ts';
import { runGovernedTool, classifyAction, trifectaImpact, maskSecrets } from './governance.ts';
import { addWidgetCard, removeWidgetCard, widgetBox, WIDGET_PREFIX, DISPLAY_MAIN, type Bounds } from './layout.ts';
import { getSetting } from './db.ts';
import { BudgetTracker, isOverDailyBudget } from './budget.ts';
import { resolveProvider } from './providers.ts';
import { runStudy } from '../tools/agent-study.ts';
import type { Capability, Governance, Job, JobApproval, JobRun, JobRuntime, StreamEvent, Tool, ToolCtx } from './types.ts';

type DB = import('better-sqlite3').Database;

// setTimeout truncates delays above ~24.8 days (2^31-1 ms) and would fire
// immediately; clamp and re-arm past the ceiling.
const MAX_DELAY = 2_147_483_647;

// ── persistence (thin IO; no pure logic here) ────────────────────────────────

interface JobRow {
  id: string;
  title: string;
  kind: string;
  schedule: string;
  source: string | null;
  study: string | null;
  prompt: string | null;
  grant_json: string | null;
  token_budget_daily: number | null;
  render: string;
  placement: string | null;
  enabled: number;
  runtime: string;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind as Job['kind'],
    schedule: JSON.parse(r.schedule),
    source: r.source ? JSON.parse(r.source) : undefined,
    study: r.study ? JSON.parse(r.study) : undefined,
    prompt: r.prompt ?? undefined,
    grant: r.grant_json ? JSON.parse(r.grant_json) : undefined,
    tokenBudgetDaily: r.token_budget_daily ?? undefined,
    render: JSON.parse(r.render),
    placement: r.placement ? JSON.parse(r.placement) : undefined,
    enabled: r.enabled === 1,
    runtime: JSON.parse(r.runtime),
  };
}

const J = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

/** Last canvas size the renderer reported (settings), for first-placing a widget by corner. */
function widgetBounds(db: DB): Bounds {
  const m = getSetting(db, 'viewport')?.match(/^(\d+)x(\d+)$/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1280, h: 800 };
}

/**
 * Register the layout row for a job's data widget when its render tier draws one
 * (tier 1|2). The widget then lives in the layout store like any panel: the user's
 * drag persists, ui_layout move_card/resize move it, get_layout lists it. Placed
 * from job.placement (corner + optional monitor), staggered past existing widgets.
 * Tier-3 jobs render into a builtin/project card, not a floating widget → no row.
 */
function registerJobWidget(db: DB, job: Job): void {
  if (job.render?.tier !== 1 && job.render?.tier !== 2) return;
  const existing = (db.prepare(`SELECT COUNT(*) AS n FROM layout WHERE cardId LIKE '${WIDGET_PREFIX}%'`).get() as { n: number }).n;
  const box = widgetBox(job.placement?.corner, existing, widgetBounds(db));
  const displayId = job.placement?.displayId != null ? String(job.placement.displayId) : DISPLAY_MAIN;
  addWidgetCard(db, job.id, box, displayId);
}

export function createJob(db: DB, job: Job): Job {
  db.prepare(
    `INSERT INTO scheduled_jobs
       (id, title, kind, schedule, source, study, prompt, grant_json, token_budget_daily, render, placement, enabled, runtime)
     VALUES (@id, @title, @kind, @schedule, @source, @study, @prompt, @grant, @budget, @render, @placement, @enabled, @runtime)`,
  ).run({
    id: job.id,
    title: job.title,
    kind: job.kind,
    schedule: JSON.stringify(job.schedule),
    source: J(job.source),
    study: J(job.study),
    prompt: job.prompt ?? null,
    grant: J(job.grant),
    budget: job.tokenBudgetDaily ?? null,
    render: JSON.stringify(job.render),
    placement: J(job.placement),
    enabled: job.enabled ? 1 : 0,
    runtime: JSON.stringify(job.runtime ?? {}),
  });
  registerJobWidget(db, job);
  return job;
}

export function getJob(db: DB, id: string): Job | undefined {
  const r = db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as JobRow | undefined;
  return r ? rowToJob(r) : undefined;
}

export function listJobs(db: DB): Job[] {
  const out: Job[] = [];
  // A single corrupt JSON column must NOT hide every other job (and, via
  // start(), must never brick boot). Skip + log the bad row, keep the rest.
  for (const r of db.prepare('SELECT * FROM scheduled_jobs ORDER BY rowid').all() as JobRow[]) {
    try {
      out.push(rowToJob(r));
    } catch (err) {
      console.error(`[alfred] scheduler: skipping malformed job row ${r?.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/** Patch a job. `runtime` is replaced wholesale (callers pass the merged object). */
export function updateJob(db: DB, id: string, patch: Partial<Job>): Job | undefined {
  const cur = getJob(db, id);
  if (!cur) return undefined;
  const next: Job = { ...cur, ...patch };
  db.prepare(
    `UPDATE scheduled_jobs SET
       title=@title, kind=@kind, schedule=@schedule, source=@source, study=@study, prompt=@prompt,
       grant_json=@grant, token_budget_daily=@budget, render=@render, placement=@placement,
       enabled=@enabled, runtime=@runtime
     WHERE id=@id`,
  ).run({
    id,
    title: next.title,
    kind: next.kind,
    schedule: JSON.stringify(next.schedule),
    source: J(next.source),
    study: J(next.study),
    prompt: next.prompt ?? null,
    grant: J(next.grant),
    budget: next.tokenBudgetDaily ?? null,
    render: JSON.stringify(next.render),
    placement: J(next.placement),
    enabled: next.enabled ? 1 : 0,
    runtime: JSON.stringify(next.runtime ?? {}),
  });
  return next;
}

export function deleteJob(db: DB, id: string): void {
  db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
  db.prepare('DELETE FROM job_runs WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM job_approvals WHERE job_id = ?').run(id);
  removeWidgetCard(db, id); // drop the widget row so no orphan card survives the job
}

/** Append one run-log entry (id auto-filled when absent). */
export function logRun(db: DB, run: Omit<JobRun, 'id'> & { id?: string }): JobRun {
  const full: JobRun = { id: run.id ?? randomUUID(), ...run };
  db.prepare(
    `INSERT INTO job_runs (id, job_id, ts, ok, tokens, summary, error)
     VALUES (@id, @jobId, @ts, @ok, @tokens, @summary, @error)`,
  ).run({
    id: full.id,
    jobId: full.jobId,
    ts: full.ts,
    ok: full.ok ? 1 : 0,
    tokens: full.tokens,
    summary: full.summary ?? null,
    error: full.error ?? null,
  });
  return full;
}

// ── sensitive-action approval queue (§3.1) ────────────────────────────────────

interface ApprovalRow {
  id: string;
  job_id: string;
  ts: number;
  tool_name: string;
  args_json: string | null;
  status: JobApproval['status'];
  resolved_ts: number | null;
}

function rowToApproval(r: ApprovalRow): JobApproval {
  let args: unknown = null;
  try {
    args = r.args_json ? JSON.parse(r.args_json) : null;
  } catch {
    args = null; // a corrupt args blob must not hide the pending item
  }
  return {
    id: r.id,
    jobId: r.job_id,
    ts: r.ts,
    toolName: r.tool_name,
    args,
    status: r.status,
    resolvedTs: r.resolved_ts ?? undefined,
  };
}

/** Mask secret-looking args before an approval leaves the process (UI/stream). Execution reads the verbatim row. */
function maskApproval(a: JobApproval): JobApproval {
  return { ...a, args: maskSecrets(a.args) };
}

/**
 * Park a sensitive tool call for the user to approve/deny later. Secret-KEYED
 * arg fields (token/password/apiKey/authorization/…) are masked BEFORE they hit
 * the DB — the agent never legitimately supplies real credential values (secrets
 * live in the keychain and are injected by adapters at execute time, not by the
 * model), so masking them costs nothing and keeps plaintext creds out of the
 * queue at rest. Content fields (email body, url, shell command) are preserved
 * so resolveApproval re-executes the exact action.
 * ponytail: key-masking only — a secret pasted INSIDE a string (e.g. a bearer in
 * a `curl -H` command) can't be masked without breaking re-execution; that is
 * inherent to storing an executable command, same as the messages/audit tables.
 */
export function createApproval(db: DB, a: { jobId: string; toolName: string; args: unknown }): JobApproval {
  const appr: JobApproval = {
    id: randomUUID(),
    jobId: a.jobId,
    ts: Date.now(),
    toolName: a.toolName,
    args: maskSecrets(a.args ?? null),
    status: 'pending',
  };
  db.prepare(
    `INSERT INTO job_approvals (id, job_id, ts, tool_name, args_json, status)
     VALUES (@id, @jobId, @ts, @toolName, @args, 'pending')`,
  ).run({ id: appr.id, jobId: appr.jobId, ts: appr.ts, toolName: appr.toolName, args: JSON.stringify(appr.args ?? null) });
  return appr;
}

/** Verbatim single approval (used by resolveApproval to execute). */
export function getApproval(db: DB, id: string): JobApproval | undefined {
  const r = db.prepare('SELECT * FROM job_approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  return r ? rowToApproval(r) : undefined;
}

/** Pending approvals (all jobs, or one), MASKED for display. */
export function listPendingApprovals(db: DB, jobId?: string): JobApproval[] {
  const rows = (
    jobId
      ? db.prepare("SELECT * FROM job_approvals WHERE status='pending' AND job_id=? ORDER BY ts").all(jobId)
      : db.prepare("SELECT * FROM job_approvals WHERE status='pending' ORDER BY ts").all()
  ) as ApprovalRow[];
  return rows.map((r) => maskApproval(rowToApproval(r)));
}

/** Collaborators resolveApproval needs to EXECUTE an approved action through normal governance. */
export interface ApprovalExecEnv {
  ctx: ToolCtx;
  tools: Tool[];
  notify?: (title: string, body: string) => void;
}

/**
 * Resolve a pending approval. `approved=true` EXECUTES the stored tool+args
 * through the NORMAL governance path (the human is present now, so dangerous
 * mode / rules / HITL all apply as usual) and logs the run; `approved=false`
 * discards it. Idempotent — a non-pending approval is returned unchanged.
 * Emits `job.approval` (action:'resolved') via ctx.emit for the UI.
 */
export async function resolveApproval(
  db: DB,
  id: string,
  approved: boolean,
  exec?: ApprovalExecEnv,
): Promise<JobApproval | undefined> {
  const appr = getApproval(db, id);
  if (!appr || appr.status !== 'pending') return appr;

  const status = nextApprovalStatus(appr.status, approved);
  const resolvedTs = Date.now();
  db.prepare('UPDATE job_approvals SET status=?, resolved_ts=? WHERE id=?').run(status, resolvedTs, id);
  const resolved: JobApproval = { ...appr, status, resolvedTs };

  if (approved && exec) {
    const t = exec.tools.find((x) => x.name === appr.toolName);
    if (!t) {
      logRun(db, { jobId: appr.jobId, ts: resolvedTs, ok: false, tokens: 0, error: `approval ${id}: tool "${appr.toolName}" not found` });
    } else {
      try {
        const out = await runGovernedTool(t, appr.args, exec.ctx);
        const failed = !!out && typeof out === 'object' && 'error' in (out as Record<string, unknown>);
        logRun(db, {
          jobId: appr.jobId,
          ts: resolvedTs,
          ok: !failed,
          tokens: 0,
          summary: `approval executed: ${appr.toolName}`,
          error: failed ? String((out as Record<string, unknown>).error) : undefined,
        });
      } catch (err) {
        logRun(db, {
          jobId: appr.jobId,
          ts: resolvedTs,
          ok: false,
          tokens: 0,
          error: `approval ${id} execution failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
  exec?.ctx.emit({ kind: 'job.approval', action: 'resolved', approval: maskApproval(resolved) });
  return resolved;
}

// ── the timer engine ─────────────────────────────────────────────────────────

/** Extension port: run a due job (fetch/agent). Default = the real fetch + agent runners. */
export type JobRunner = (job: Job) => Promise<void>;

/**
 * Everything the AGENT runner needs, injected from the orchestrator (which owns
 * the governed ToolCtx + tool registry + brain resolution). Absent → agent jobs
 * are logged and skipped (tests / headless). Kept out of jobs-pure so this file
 * stays the only place that pulls the AI SDK + governance into the scheduler.
 */
export interface JobAgentEnv {
  /** Full governed ctx (real governance) — reused for tool execution + emit. */
  ctx: ToolCtx;
  tools: Tool[];
  dailyTokenBudget: number;
  stepCap: number;
  dailyUsdBudget?: number;
  /** provider:model spec for the job's brain (agent_config.main); undefined → default. */
  agentSpec?: () => string | undefined;
  /** Live DANGEROUS-mode state. */
  dangerous?: () => boolean;
  /** System notification (injected so core stays Electron-free). */
  notify?: (title: string, body: string) => void;
  env?: Record<string, string | undefined>;
}

export interface SchedulerOpts {
  /** Override the runner (tests / future wiring); default runs fetch + agent jobs for real. */
  runJob?: JobRunner;
  /** Injectable clock (tests pass a fixed reader; boot uses Date.now). */
  now?: () => number;
  log?: (msg: string) => void;
  /** Stream sink so a fetch refresh / agent job can emit events to the UI. */
  emit?: (event: StreamEvent) => void;
  /** Agent-runner environment; absent → agent jobs are skipped-with-a-log. */
  agent?: JobAgentEnv;
}

/** Unattended-agent system prompt: single autonomous turn, no human, grant-limited. */
const AGENT_JOB_SYSTEM =
  'You are Alfred running an UNATTENDED scheduled task. Complete the task autonomously in this single turn ' +
  'using the available tools, then stop and briefly report what you did. NO human is watching: never ask ' +
  'questions or for confirmation. You are limited to this task\'s granted capabilities — calls outside the ' +
  'grant are refused, and sensitive actions (sending messages, payments, deletes, secret access, or egress ' +
  'of data you have just read) are queued for the user\'s later approval, NOT executed now. Do not retry a ' +
  'refused or queued action; note it and continue with what you can. Be economical with tokens.';

/**
 * Single active scheduler, so the `schedule` tool can re-arm a job after
 * create/edit/pause/resume/delete without threading the instance through
 * ToolCtx. ponytail: one global scheduler (there is exactly one per process).
 */
let activeScheduler: JobScheduler | undefined;

/** Re-arm/disarm one job on the active scheduler; no-op when none is running (tests). */
export function rescheduleJob(jobId: string): void {
  activeScheduler?.reschedule(jobId);
}

export class JobScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly db: DB;
  private readonly runJob: JobRunner;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly emit?: (event: StreamEvent) => void;
  private readonly agentEnv?: JobAgentEnv;

  constructor(db: DB, opts: SchedulerOpts = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[alfred] scheduler: ${m}`));
    this.emit = opts.emit;
    this.agentEnv = opts.agent;
    this.runJob =
      opts.runJob ??
      (async (job) => {
        if (job.kind === 'fetch') return this.runFetch(job);
        if (job.kind === 'study') return this.runStudyJob(job);
        return this.runAgent(job);
      });
    activeScheduler = this;
  }

  /**
   * The real `fetch` runner: pull source.url (GET), extract the card value, save
   * it to runtime.lastResult + a run-log entry, and emit `job.data`. Zero AI
   * tokens (never touches the budget). Any failure is logged, never thrown — a
   * bad fetch must not kill the scheduler.
   */
  private async runFetch(job: Job): Promise<void> {
    const ts = this.now();
    const url = job.source?.url;
    if (!url) {
      logRun(this.db, { jobId: job.id, ts, ok: false, tokens: 0, error: 'fetch job has no source.url' });
      return;
    }
    // Defence in depth: re-check the SSRF floor at run time in case a row was
    // written straight to the DB (bypassing the schedule tool's validation).
    const urlErr = fetchUrlError(url);
    if (urlErr) {
      this.log(`fetch job ${job.id} "${job.title}" blocked: ${urlErr}`);
      logRun(this.db, { jobId: job.id, ts, ok: false, tokens: 0, error: urlErr });
      return;
    }
    try {
      const res = await fetch(url, { method: job.source?.method ?? 'GET', headers: job.source?.headers });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        data = body; // non-JSON source: extract with no spec returns the text
      }
      const value = extractValue(data, job.source?.extract);
      const cur = getJob(this.db, job.id);
      if (cur) updateJob(this.db, job.id, { runtime: { ...cur.runtime, lastResult: value } });
      const summary = typeof value === 'string' ? value.slice(0, 200) : JSON.stringify(value)?.slice(0, 200);
      logRun(this.db, { jobId: job.id, ts, ok: true, tokens: 0, summary });
      this.emit?.({ kind: 'job.data', jobId: job.id, title: job.title, value, ts });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`fetch job ${job.id} "${job.title}" failed: ${msg}`);
      logRun(this.db, { jobId: job.id, ts, ok: false, tokens: 0, error: msg });
    }
  }

  /**
   * The AGENT runner (§1/§2/§3): ONE autonomous, unattended turn driven by
   * job.prompt, over the AI SDK in-process (streamText + tools) so EVERY tool
   * call is intercepted by the job governor before it can execute. Bounded by the
   * job's grant + the per-job daily budget + the global kill-switch + the step
   * cap. Never throws — a failed run is logged, the scheduler survives.
   */
  private async runAgent(job: Job): Promise<void> {
    const env = this.agentEnv;
    const startTs = this.now();
    if (!env) {
      this.log(`agent job ${job.id} "${job.title}" skipped: no agent environment wired`);
      logRun(this.db, { jobId: job.id, ts: startTs, ok: false, tokens: 0, error: 'agent runner not available' });
      return;
    }

    // Per-job daily budget: apply the reset first, then refuse if exhausted.
    const pre = budgetDecision(job, startTs, 1);
    if (pre.reset) {
      const cur = getJob(this.db, job.id);
      if (cur) job = updateJob(this.db, job.id, { runtime: { ...cur.runtime, tokensToday: 0, tokensDay: pre.tokensDay } }) ?? job;
    }
    if (!pre.allowed) {
      logRun(this.db, { jobId: job.id, ts: startTs, ok: false, tokens: 0, error: 'per-job daily token budget exhausted' });
      const cur = getJob(this.db, job.id);
      if (cur) updateJob(this.db, job.id, { runtime: { ...cur.runtime, pausedReason: 'budget' } });
      env.notify?.('Alfred — tarefa pausada', `"${job.title}" atingiu o orçamento de tokens do dia.`);
      return;
    }

    // Global kill-switch (budget.ts) applies on top; count this run's usage into it.
    const jobSessionId = `job:${job.id}`;
    const tracker = new BudgetTracker(
      this.db,
      { dailyLimit: env.dailyTokenBudget, stepCap: env.stepCap, dailyUsdBudget: env.dailyUsdBudget },
      jobSessionId,
    );
    if (isOverDailyBudget(tracker.snapshot())) {
      logRun(this.db, { jobId: job.id, ts: startTs, ok: false, tokens: 0, error: 'global daily token budget exhausted' });
      return; // global resets daily and is app-wide — don't pause the job itself
    }

    // Resolve the brain via the AI SDK (in-process → tool calls are interceptable).
    let provider: ReturnType<typeof resolveProvider>;
    try {
      provider = resolveProvider(env.agentSpec?.(), env.env ?? process.env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`agent job ${job.id} "${job.title}" has no usable brain: ${msg}`);
      logRun(this.db, { jobId: job.id, ts: startTs, ok: false, tokens: 0, error: `no brain: ${msg}` });
      return;
    }

    const dangerous = env.dangerous?.() ?? false;
    const grant = job.grant ?? [...DEFAULT_GRANT];
    const runState: JobRunState = { readUntrusted: false };

    // Job-run governance: an unattended job has NO human to approve, so this
    // ALWAYS denies — even in dangerous mode. The sensitive set is queued by the
    // job governor (gateJobTool) BEFORE execute, but some sensitive sub-ops are
    // only discoverable at execute time (e.g. filesystem `write` OVERWRITING an
    // existing file — the tool stats the path itself and raises its own approval).
    // Riding dangerous-mode here would auto-overwrite/-mutate unattended, piercing
    // §3.1. Denying fails those closed; the model is told and continues. Trifecta
    // is done per-run below, so markTrifecta/trifecta are inert (no double logic).
    const jobGovernance: Governance = {
      classify: classifyAction,
      requestApproval: async () => ({
        id: randomUUID(),
        decision: 'deny',
        note: 'unattended job — no human to approve (sensitive sub-op refused, not auto-run)',
      }),
      markTrifecta: () => {},
      trifecta: () => ({ readUntrusted: false, hasPrivate: false, canEgress: false }),
    };
    const jobCtx: ToolCtx = { ...env.ctx, sessionId: jobSessionId, governance: jobGovernance };

    const controller = new AbortController();
    const set: ToolSet = {};
    for (const t of env.tools) {
      set[t.name] = tool({
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema(t.inputSchema as any),
        execute: (args: unknown) => this.gateJobTool(job, t, args, { grant, dangerous, runState, jobCtx, jobSessionId, notify: env.notify }),
      });
    }

    try {
      const result = streamText({
        model: provider.languageModel,
        system: AGENT_JOB_SYSTEM,
        prompt: job.prompt ?? '',
        maxOutputTokens: 4096,
        tools: set,
        stopWhen: stepCountIs(env.stepCap),
        abortSignal: controller.signal,
        // Global kill-switch mid-run: abort the loop if the app-wide budget is now spent.
        prepareStep: () => {
          if (isOverDailyBudget(tracker.snapshot())) controller.abort();
          return {};
        },
        onStepFinish: ({ usage }) => {
          try {
            tracker.record({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 }, provider.model);
          } catch (err) {
            console.error('[alfred] job step accounting failed:', err instanceof Error ? err.message : err);
          }
        },
      });

      let text = '';
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') text += part.text;
        else if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
      let spent = 0;
      try {
        const u = await result.usage;
        spent = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      } catch {
        /* usage unavailable (e.g. aborted) — spent stays 0 */
      }
      this.applyAgentBudget(job, startTs, spent, text.trim(), env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`agent job ${job.id} "${job.title}" failed: ${msg}`);
      logRun(this.db, { jobId: job.id, ts: startTs, ok: false, tokens: 0, error: msg });
    }
  }

  /**
   * The STUDY runner (Phase 5 stage 4): a scheduled `study` job runs a named
   * roster agent's read-only research turn UNATTENDED via the factored runStudy,
   * then the trusted runner persists the note + updates the shared index. Bounded
   * by the agent's per-agent daily budget (pause the job on exhaustion) + the
   * global kill-switch. Sensitive actions queue for later approval (fail-closed).
   * Never throws — a failed run is logged and the scheduler survives.
   */
  private async runStudyJob(job: Job): Promise<void> {
    const env = this.agentEnv;
    const ts = this.now();
    if (!env) {
      this.log(`study job ${job.id} "${job.title}" skipped: no agent environment wired`);
      logRun(this.db, { jobId: job.id, ts, ok: false, tokens: 0, error: 'agent runner not available' });
      return;
    }
    const s = job.study;
    if (!s?.agentId || !s?.topic) {
      logRun(this.db, { jobId: job.id, ts, ok: false, tokens: 0, error: 'study job missing study.agentId/topic' });
      return;
    }

    // Global kill-switch on top of the per-agent budget (enforced inside runStudy).
    const tracker = new BudgetTracker(
      this.db,
      { dailyLimit: env.dailyTokenBudget, stepCap: env.stepCap, dailyUsdBudget: env.dailyUsdBudget },
      `agent:${s.agentId}`,
    );
    if (isOverDailyBudget(tracker.snapshot())) {
      logRun(this.db, { jobId: job.id, ts, ok: false, tokens: 0, error: 'global daily token budget exhausted' });
      return; // global resets daily and is app-wide — don't pause the job itself
    }

    let res;
    try {
      res = await runStudy(env.ctx, s.agentId, s.topic, {
        unattended: true,
        dangerous: env.dangerous?.() ?? false,
        // A sensitive action the studying agent attempts is parked for the user (fail-closed).
        queueApproval: (toolName, args) => {
          const appr = createApproval(this.db, { jobId: job.id, toolName, args });
          env.notify?.('Alfred — aprovação pendente', `"${job.title}" quer executar ${toolName}; aprova na app.`);
          this.emit?.({ kind: 'job.approval', action: 'created', approval: maskApproval(appr) });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`study job ${job.id} "${job.title}" threw: ${msg}`);
      logRun(this.db, { jobId: job.id, ts, ok: false, tokens: 0, error: msg });
      return;
    }

    if (res.budgetExhausted) {
      const cur = getJob(this.db, job.id);
      if (cur) updateJob(this.db, job.id, { runtime: { ...cur.runtime, pausedReason: 'budget' } });
      logRun(this.db, { jobId: job.id, ts, ok: false, tokens: 0, error: `per-agent daily token budget exhausted (${s.agentId})` });
      env.notify?.('Alfred — estudo pausado', `"${job.title}" atingiu o orçamento de tokens do agente.`);
      return;
    }
    if (!res.ok) {
      this.log(`study job ${job.id} "${job.title}" failed: ${res.error}`);
      logRun(this.db, { jobId: job.id, ts, ok: false, tokens: res.tokens ?? 0, error: res.error });
      return;
    }
    const findings = res.result?.findings ?? '';
    logRun(this.db, { jobId: job.id, ts, ok: true, tokens: res.tokens ?? 0, summary: `studied "${s.topic}" → ${res.result?.note ?? ''}` });
    this.emit?.({ kind: 'job.data', jobId: job.id, title: job.title, value: findings.slice(0, 2000), ts });
  }

  /**
   * The JOB GOVERNOR (§2): gate ONE tool call from an agent job.
   *  - deny            → refuse, tell the model it is outside the grant.
   *  - queue-approval  → park it (createApproval) + notify + emit; refuse to the model.
   *  - allow           → execute through the shared governed executor (audit + events),
   *                      using the non-blocking jobGovernance.
   * Sensitive actions + post-untrusted-read egress ALWAYS take the queue path,
   * even in dangerous mode — never the governance dangerous-auto-approve.
   */
  private async gateJobTool(
    job: Job,
    t: Tool,
    args: unknown,
    g: { grant: Capability[]; dangerous: boolean; runState: JobRunState; jobCtx: ToolCtx; jobSessionId: string; notify?: (title: string, body: string) => void },
  ): Promise<unknown> {
    let decision = jobActionDecision({ grant: g.grant, dangerous: g.dangerous, unattended: true }, t.name, args);
    decision = escalateForTrifecta(decision, g.runState, t.name, args);

    if (decision === 'deny') {
      this.emit?.({ kind: 'tool.start', sessionId: g.jobSessionId, toolName: t.name, args: maskSecrets(args), tier: classifyAction(t.name, args) });
      this.emit?.({ kind: 'tool.end', sessionId: g.jobSessionId, toolName: t.name, status: 'blocked', error: 'out of grant' });
      return { ok: false, error: `não permitido pelo grant desta tarefa: ${t.name}` };
    }

    if (decision === 'queue-approval') {
      const appr = createApproval(this.db, { jobId: job.id, toolName: t.name, args });
      g.notify?.('Alfred — aprovação pendente', `"${job.title}" quer executar ${t.name}; aprova na app.`);
      this.emit?.({ kind: 'tool.start', sessionId: g.jobSessionId, toolName: t.name, args: maskSecrets(args), tier: classifyAction(t.name, args) });
      this.emit?.({ kind: 'tool.end', sessionId: g.jobSessionId, toolName: t.name, status: 'blocked', error: 'queued for approval' });
      this.emit?.({ kind: 'job.approval', action: 'created', approval: maskApproval(appr) });
      return { ok: false, error: 'ação sensível colocada em fila para a tua aprovação' };
    }

    // allow → execute through the shared governance path (audit + tool.start/end).
    const out = await runGovernedTool(t, args, g.jobCtx);
    // Trifecta: once the agent has read untrusted content, later egress escalates.
    if (trifectaImpact(t.name).readUntrusted) g.runState.readUntrusted = true;
    return out;
  }

  /**
   * Fold this run's token spend into the per-job daily counter and pause the job
   * (never kill it mid-run) if the spend blew the cap. Records lastResult + a
   * run-log entry and emits `job.data` so a card can show the outcome.
   */
  private applyAgentBudget(job: Job, startTs: number, spent: number, text: string, env: JobAgentEnv): void {
    const cur = getJob(this.db, job.id);
    if (!cur) return;
    const bd = budgetDecision(cur, this.now(), spent);
    const tokensToday = bd.tokensToday + spent; // bd.tokensToday is reset-adjusted, pre-add
    const runtime: JobRuntime = {
      ...cur.runtime,
      tokensToday,
      tokensDay: bd.tokensDay,
      lastResult: text || cur.runtime.lastResult,
    };
    // `spent` has already been consumed; if it exceeded the cap, pause going forward.
    if (!bd.allowed) runtime.pausedReason = 'budget';
    updateJob(this.db, job.id, { runtime });
    logRun(this.db, { jobId: job.id, ts: startTs, ok: true, tokens: spent, summary: text.slice(0, 200) || undefined });
    this.emit?.({ kind: 'job.data', jobId: job.id, title: job.title, value: text.slice(0, 2000), ts: startTs });
    if (!bd.allowed) env.notify?.('Alfred — tarefa pausada', `"${job.title}" atingiu o orçamento de tokens do dia.`);
  }

  /** Re-arm one job from its fresh DB row (create/edit/resume); disarm if gone/disabled/paused. */
  reschedule(jobId: string): void {
    this.disarm(jobId);
    let job: Job | undefined;
    try {
      job = getJob(this.db, jobId);
    } catch (err) {
      this.log(`reschedule: could not read job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (job && job.enabled && !job.runtime.pausedReason) {
      try {
        this.arm(job);
      } catch (err) {
        this.log(`reschedule: could not arm job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Re-arm every enabled, non-paused job. Dormant-safe: no jobs → does nothing. */
  start(): void {
    let jobs: Job[] = [];
    try {
      jobs = listJobs(this.db);
    } catch (err) {
      // Boot must survive a broken jobs table — log and stay dormant.
      this.log(`start: could not read jobs (staying dormant): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const job of jobs) {
      // One job with a malformed schedule must not stop the others (or crash boot).
      try {
        if (job.enabled && !job.runtime.pausedReason) this.arm(job);
      } catch (err) {
        this.log(`start: could not arm job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private arm(job: Job): void {
    this.disarm(job.id);
    const now = this.now();
    let next = job.runtime.nextRunTs ?? nextRun(job.schedule, now, job.runtime.lastRunTs);
    if (job.runtime.nextRunTs !== next) {
      job = updateJob(this.db, job.id, { runtime: { ...job.runtime, nextRunTs: next } }) ?? job;
    }
    const delay = Math.max(0, next - now);
    const capped = Math.min(delay, MAX_DELAY);
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      if (capped < delay) {
        // ceiling hit — re-arm from the fresh row for the remaining wait.
        const fresh = getJob(this.db, job.id);
        if (fresh) this.arm(fresh);
      } else {
        void this.fire(job.id);
      }
    }, capped);
    timer.unref?.();
    this.timers.set(job.id, timer);
  }

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  private async fire(jobId: string): Promise<void> {
    const job = getJob(this.db, jobId);
    if (!job || !job.enabled || job.runtime.pausedReason) return;
    const startTs = this.now();
    try {
      await this.runJob(job);
    } catch (err) {
      // Log the original error with context; a bad run must not kill the engine.
      this.log(`job ${jobId} runner threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Reschedule from the FRESH row — the runner may have mutated runtime
    // (tokens, pausedReason). A run that paused the job is not re-armed.
    const after = getJob(this.db, jobId);
    if (!after || !after.enabled || after.runtime.pausedReason) return;
    const runtime: JobRuntime = {
      ...after.runtime,
      lastRunTs: startTs,
      nextRunTs: nextRun(after.schedule, this.now(), startTs),
    };
    const updated = updateJob(this.db, jobId, { runtime });
    if (updated) this.arm(updated);
  }
}
