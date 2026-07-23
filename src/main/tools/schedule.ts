/**
 * schedule — create and manage Scheduled Jobs (Phase 4, stage 2). A job is a
 * persisted recurring task: a cheap `fetch` (HTTP pull on a timer, zero AI
 * tokens) or an `agent` turn (stage 2.5). This tool ONLY persists jobs (via
 * core/jobs.ts) and re-arms the in-app scheduler — it never runs a job itself.
 *
 * Risk: create/edit/pause/resume/delete = T2 (they establish or change
 * recurring egress/compute); list = T0. In dangerous mode the host auto-approves
 * the T2 like every other tool — the governance of an AGENT job's unattended
 * ACTIONS (the sensitive-action approval queue) is stage 2.5, not here.
 */
import { randomUUID } from 'node:crypto';
import type { Tool } from './types.ts';
import type { Job } from '../core/types.ts';
import { validateJobSpec, nextRun, type JobSpecInput } from '../core/jobs-pure.ts';
import { createJob, getJob, listJobs, updateJob, deleteJob, rescheduleJob } from '../core/jobs.ts';
import { getLayout } from '../core/layout.ts';

type Op = 'create' | 'list' | 'pause' | 'resume' | 'delete' | 'edit';

interface Args extends JobSpecInput {
  op: Op;
  /** pause/resume/delete/edit target job id. */
  id?: string;
}

/** Compact per-job summary for `list` and create/edit results. */
function summarize(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    schedule: job.schedule,
    enabled: job.enabled,
    pausedReason: job.runtime.pausedReason ?? null,
    tokensToday: job.runtime.tokensToday ?? 0,
    tokenBudgetDaily: job.tokenBudgetDaily ?? null,
    lastRunTs: job.runtime.lastRunTs ?? null,
    nextRunTs: job.runtime.nextRunTs ?? null,
    lastResult: job.runtime.lastResult ?? null,
    ...(job.kind === 'fetch' ? { source: job.source } : { grant: job.grant, prompt: job.prompt }),
  };
}

export const schedule: Tool<Args> = {
  name: 'schedule',
  description:
    'Create and manage Scheduled Jobs — recurring tasks that persist across restarts and re-arm on boot. ' +
    'A job is either a `fetch` (a cheap HTTP GET on a timer that pulls a value to show — ZERO AI tokens) or an ' +
    '`agent` (an autonomous Alfred turn from a prompt — costs tokens, runs unattended; the agent runner ships in a ' +
    'later stage). This tool only PERSISTS and (re)schedules jobs; it never runs one. ops: ' +
    'create (title, kind, schedule, and per-kind fields), list, pause {id}, resume {id}, delete {id}, edit {id, ...create fields}. ' +
    'schedule is {type:"interval", everyMs} (everyMs >= 30000) or {type:"daily", at:"HH:MM"} (24h local). ' +
    'For kind:"fetch" pass source:{url (http/https), method?:"GET", headers?, extract?} where extract is a dot/bracket ' +
    'path into the JSON response (e.g. "current.temperature_2m"). ' +
    'For kind:"agent" pass prompt and grant (an allowlist of capabilities the unattended job may use). ' +
    'BEFORE creating an agent job you MUST ASK the user how much autonomy to grant (default ["read","notify"] — ' +
    'read + notify only); sensitive actions (send/pay/delete/secrets) never auto-run unattended regardless of grant. ' +
    'render {tier,card} and placement are optional (sensible defaults). create/edit/delete/pause/resume are T2; list is T0.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['create', 'list', 'pause', 'resume', 'delete', 'edit'] },
      id: { type: 'string', description: 'Job id — required for pause/resume/delete/edit.' },
      title: { type: 'string', description: 'Human-readable job title.' },
      kind: { type: 'string', enum: ['fetch', 'agent'], description: 'fetch = HTTP pull (0 tokens); agent = autonomous turn.' },
      schedule: {
        type: 'object',
        description: '{type:"interval", everyMs>=30000} or {type:"daily", at:"HH:MM"} (24h local time).',
        properties: {
          type: { type: 'string', enum: ['interval', 'daily'] },
          everyMs: { type: 'number', description: 'interval: milliseconds between runs (>= 30000).' },
          at: { type: 'string', description: 'daily: "HH:MM" 24-hour local time.' },
        },
      },
      source: {
        type: 'object',
        description: 'fetch jobs: where and what to pull.',
        properties: {
          url: { type: 'string', description: 'http:// or https:// URL to GET.' },
          method: { type: 'string', enum: ['GET'] },
          headers: { type: 'object', description: 'Optional request headers.' },
          extract: { type: 'string', description: 'Dot/bracket path into the JSON response, e.g. "current.temperature_2m". Omit to keep the whole payload.' },
        },
      },
      prompt: { type: 'string', description: 'agent jobs: the initial task prompt run each time the job fires.' },
      grant: {
        type: 'array',
        items: { type: 'string', enum: ['read', 'notify', 'write', 'browse', 'shell', 'send', 'delete', 'money', 'secrets'] },
        description: 'agent jobs: the allowlist of capabilities the unattended job may use. ASK the user first; default ["read","notify"].',
      },
      tokenBudgetDaily: { type: 'number', description: 'agent jobs: per-day token cap (positive). Omitted → a sane default.' },
      render: {
        type: 'object',
        description:
          'Optional render hint. Default {tier:1, card:"value"} — builtin data card. ' +
          'For a CUSTOM chart/visualization, use tier:2 and provide `html`: a self-contained page YOU write. ' +
          'The page has NO network (a strict CSP blocks all fetch/xhr/ws and external scripts/styles) and runs in a ' +
          'sandboxed iframe. Do NOT add external libraries or your own <script src>. Get the live value via the ' +
          'injected runtime: `Alfred.onData(function(v){ ... })` fires on every refresh with the job value; ' +
          '`Alfred.sparkline(el, numberArray)` draws a minimal line chart. Style with inline <style>/attributes. ' +
          'The data pipeline (fetch/agent) is unchanged — tier:2 only changes the render.',
        properties: {
          tier: { type: 'number', enum: [1, 2, 3] },
          card: { type: 'string' },
          html: { type: 'string', description: 'tier:2 only — the self-contained widget page (<= 256KB). Required when tier=2.' },
        },
      },
      placement: {
        type: 'object',
        description: 'Optional card placement {displayId?, corner?}.',
        properties: { displayId: { type: 'number' }, corner: { type: 'string', enum: ['tl', 'tr', 'bl', 'br'] } },
      },
    },
    required: ['op'],
  },

  risk: (a) => (a.op === 'list' ? 'T0' : 'T2'),

  async execute(a, ctx) {
    const { op, id } = a;

    if (op === 'list') {
      const jobs = listJobs(ctx.db).map(summarize);
      return { ok: true, result: { jobs } };
    }

    if (op === 'create' || op === 'edit') {
      const v = validateJobSpec(a);
      if (!v.ok) return { ok: false, error: v.error };

      if (op === 'create') {
        const job: Job = { id: randomUUID(), ...v.spec, enabled: true, runtime: {} };
        createJob(ctx.db, job);
        rescheduleJob(job.id);
        // A tier-1/2 job registered a widget layout row — push the new layout so
        // the widget card appears (and get_layout/move_card can reach it).
        ctx.emit({ kind: 'layout', cards: getLayout(ctx.db) });
        // Re-read so the returned nextRunTs reflects what the scheduler armed.
        const armed = getJob(ctx.db, job.id) ?? job;
        return { ok: true, result: { job: summarize(armed), nextRun: armed.runtime.nextRunTs ?? nextRun(job.schedule, Date.now()) } };
      }

      // edit: replace the spec, keep runtime but drop the stale nextRunTs so the
      // scheduler recomputes from the (possibly new) schedule.
      if (!id) return { ok: false, error: 'edit needs an id' };
      const cur = getJob(ctx.db, id);
      if (!cur) return { ok: false, error: `no job with id ${id}` };
      const { nextRunTs: _drop, ...runtime } = cur.runtime;
      updateJob(ctx.db, id, {
        title: v.spec.title,
        kind: v.spec.kind,
        schedule: v.spec.schedule,
        source: v.spec.source,
        prompt: v.spec.prompt,
        grant: v.spec.grant,
        tokenBudgetDaily: v.spec.tokenBudgetDaily,
        render: v.spec.render,
        placement: v.spec.placement,
        runtime,
      });
      rescheduleJob(id);
      ctx.emit({ kind: 'layout', cards: getLayout(ctx.db) }); // reflect a retitled widget
      const after = getJob(ctx.db, id)!;
      return { ok: true, result: { job: summarize(after), nextRun: after.runtime.nextRunTs ?? null } };
    }

    // pause / resume / delete — all need an id
    if (!id) return { ok: false, error: `${op} needs an id` };
    const cur = getJob(ctx.db, id);
    if (!cur) return { ok: false, error: `no job with id ${id}` };

    if (op === 'delete') {
      deleteJob(ctx.db, id);
      rescheduleJob(id); // disarms (job is gone)
      ctx.emit({ kind: 'layout', cards: getLayout(ctx.db) }); // drop the removed widget card
      return { ok: true, result: { deleted: id } };
    }

    if (op === 'pause') {
      updateJob(ctx.db, id, { enabled: false });
      rescheduleJob(id); // disarms (enabled=false)
      return { ok: true, result: { job: summarize(getJob(ctx.db, id)!) } };
    }

    // resume: re-enable and clear any auto-pause reason (budget/error/approval), then re-arm.
    updateJob(ctx.db, id, { enabled: true, runtime: { ...cur.runtime, pausedReason: null, nextRunTs: undefined } });
    rescheduleJob(id);
    return { ok: true, result: { job: summarize(getJob(ctx.db, id)!) } };
  },
};
