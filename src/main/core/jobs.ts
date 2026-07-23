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
import { nextRun } from './jobs-pure.ts';
import type { Job, JobRun, JobRuntime } from './types.ts';

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

export function createJob(db: DB, job: Job): Job {
  db.prepare(
    `INSERT INTO scheduled_jobs
       (id, title, kind, schedule, source, prompt, grant_json, token_budget_daily, render, placement, enabled, runtime)
     VALUES (@id, @title, @kind, @schedule, @source, @prompt, @grant, @budget, @render, @placement, @enabled, @runtime)`,
  ).run({
    id: job.id,
    title: job.title,
    kind: job.kind,
    schedule: JSON.stringify(job.schedule),
    source: J(job.source),
    prompt: job.prompt ?? null,
    grant: J(job.grant),
    budget: job.tokenBudgetDaily ?? null,
    render: JSON.stringify(job.render),
    placement: J(job.placement),
    enabled: job.enabled ? 1 : 0,
    runtime: JSON.stringify(job.runtime ?? {}),
  });
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
       title=@title, kind=@kind, schedule=@schedule, source=@source, prompt=@prompt,
       grant_json=@grant, token_budget_daily=@budget, render=@render, placement=@placement,
       enabled=@enabled, runtime=@runtime
     WHERE id=@id`,
  ).run({
    id,
    title: next.title,
    kind: next.kind,
    schedule: JSON.stringify(next.schedule),
    source: J(next.source),
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

// ── the timer engine ─────────────────────────────────────────────────────────

/** Stage-2 extension port: run a due job (fetch/agent). Default = logged no-op. */
export type JobRunner = (job: Job) => Promise<void>;

export interface SchedulerOpts {
  /** Stage-2 wires the real fetch/agent runner here. */
  runJob?: JobRunner;
  /** Injectable clock (tests pass a fixed reader; boot uses Date.now). */
  now?: () => number;
  log?: (msg: string) => void;
}

export class JobScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly db: DB;
  private readonly runJob: JobRunner;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(db: DB, opts: SchedulerOpts = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[alfred] scheduler: ${m}`));
    this.runJob =
      opts.runJob ??
      (async (job) => {
        // ponytail: stub until stage 2 wires the fetch/agent runners.
        this.log(`would run job ${job.id} (${job.kind}) "${job.title}" — no runner yet`);
      });
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
