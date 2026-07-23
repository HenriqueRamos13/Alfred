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
import type { Job, ToolCtx } from '../core/types.ts';
import { validateJobSpec, mergeJobSpec, nextRun, type JobSpecInput } from '../core/jobs-pure.ts';
import { createJob, getJob, listJobs, updateJob, deleteJob, rescheduleJob } from '../core/jobs.ts';
import { widgetCreateGuard, declarativeModeWarning } from '../core/widget-html-pure.ts';
import { getSetting } from '../core/db.ts';
import { getAgent } from '../core/team.ts';
import { getLayout } from '../core/layout.ts';

/**
 * Security gate for a tier-2 widget's HTML (§2 + §3): scan for dangerous patterns
 * (refuse), warn on suspicious ones, and — in the default declarative (Widget JS
 * OFF) mode — FAIL LOUD when the HTML has a `<script>` or no `data-alfred*` binding
 * (it would never update). Emits a visible warning; a `dangerous` verdict blocks.
 */
function guardTier2Html(html: string, ctx: ToolCtx): { error?: string; warning?: string } {
  const g = widgetCreateGuard(html);
  if (g.block) {
    ctx.emit({ kind: 'error', sessionId: ctx.sessionId, message: `⚠ widget bloqueado — ${g.error}` });
    return { error: g.error };
  }
  const warnings: string[] = [];
  if (g.warning) warnings.push(g.warning);
  if (getSetting(ctx.db, 'widget_scripts_enabled') !== '1') {
    const dw = declarativeModeWarning(html);
    if (dw) warnings.push(dw);
  }
  if (warnings.length) {
    const msg = warnings.join(' · ');
    ctx.emit({ kind: 'error', sessionId: ctx.sessionId, message: `⚠ widget: ${msg}` });
    return { warning: msg };
  }
  return {};
}

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
    ...(job.kind === 'fetch'
      ? { source: job.source }
      : job.kind === 'study'
        ? { study: job.study }
        : { grant: job.grant, prompt: job.prompt }),
  };
}

export const schedule: Tool<Args> = {
  name: 'schedule',
  description:
    'Create and manage Scheduled Jobs — recurring tasks that persist across restarts and re-arm on boot. ' +
    'A job is a `fetch` (a cheap HTTP GET on a timer that pulls a value to show — ZERO AI tokens), an ' +
    '`agent` (an autonomous Alfred turn from a prompt — costs tokens, runs unattended), or a `study` (a roster agent ' +
    'learns a topic on a schedule — read-only web research saved to its private knowledge + the shared index, bounded ' +
    'by that agent\'s OWN per-agent daily token budget). This tool only PERSISTS and (re)schedules jobs; it never runs one. ops: ' +
    'create (title, kind, schedule, and per-kind fields), list, pause {id}, resume {id}, delete {id}, edit {id, ...fields to change} (MERGES onto the current spec — send only what changes; omitted fields keep their value, so editing just the schedule preserves a custom render.html). ' +
    'schedule is {type:"interval", everyMs} (everyMs >= 30000) or {type:"daily", at:"HH:MM"} (24h local). ' +
    'For kind:"fetch" pass source:{url (http/https), method?:"GET", headers?, extract?} where extract is a dot/bracket ' +
    'path into the JSON response (e.g. "current.temperature_2m"). ' +
    'For kind:"study" pass study:{agentId, topic} — the agent must exist (team op=list) and be an API brain (not claude-cli); ' +
    'the scheduled study runs UNATTENDED (sensitive actions queue for approval, never auto-run) and its cost is capped by the agent\'s per-agent daily budget. ' +
    'For kind:"agent" pass prompt and grant (an allowlist of capabilities the unattended job may use). ' +
    'BEFORE creating an agent job you MUST ASK the user how much autonomy to grant (default ["read","notify"] — ' +
    'read + notify only); sensitive actions (send/pay/delete/secrets) never auto-run unattended regardless of grant. ' +
    'render {tier,card} and placement are optional (sensible defaults). A tier:2 widget must follow the DESIGN LANGUAGE — the theme tokens (var(--acc) etc.) are injected, so use them + mono for data for a coherent neon-HUD look. create/edit/delete/pause/resume are T2; list is T0.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['create', 'list', 'pause', 'resume', 'delete', 'edit'] },
      id: { type: 'string', description: 'Job id — required for pause/resume/delete/edit.' },
      title: { type: 'string', description: 'Human-readable job title.' },
      kind: { type: 'string', enum: ['fetch', 'agent', 'study'], description: 'fetch = HTTP pull (0 tokens); agent = autonomous turn; study = a roster agent learns a topic (per-agent budget).' },
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
      study: {
        type: 'object',
        description: 'study jobs: {agentId, topic} — the roster agent to teach (must exist + be an API brain) and what to research each run.',
        properties: {
          agentId: { type: 'string', description: 'The roster agent id (team op=list).' },
          topic: { type: 'string', description: 'What to study each run (e.g. "Rust async runtimes").' },
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
          'Optional render hint. Default {tier:1, card:"value"} — builtin data card. PREFER tier:1 for almost everything: ' +
          'the builtin card auto-updates live and reliably with NO custom HTML. It renders a single VALUE when the ' +
          'extracted data is a scalar, and a live SPARKLINE when the extract returns a numeric ARRAY (e.g. the last 30 ' +
          'days of prices, or hourly temps). For a series/chart via tier:1 just make source.extract return an array of ' +
          'numbers — the card draws and re-draws the sparkline on every refresh automatically. ' +
          'Use tier:2 ONLY for bespoke visuals the builtin card cannot do. tier:2 is DECLARATIVE: you write pretty ' +
          'HTML/CSS (any CSS/HTML you like) and mark the live parts with data-attributes; you do NOT write JavaScript ' +
          '(a strict CSP hash-pins the trusted runtime and BLOCKS every model <script>) and you do NOT fetch (no network). ' +
          'A hash-pinned runtime fills your bindings on EVERY refresh: `data-alfred="path"` sets the element textContent ' +
          'to the value at that dot/bracket path (e.g. "current.temperature_2m"); `data-alfred-sparkline="path"` draws an ' +
          'inline-SVG sparkline of the numeric array at that path into the element; `data-alfred-attr="attr:path"` sets an ' +
          'attribute. FOLLOW THE DESIGN LANGUAGE (see the manifest / AGENTS.md / docs/design-language.md): the theme tokens are ' +
          'INJECTED into every widget, so use the CSS vars — var(--acc) ciano primary, var(--amb) amber, var(--mag) magenta, ' +
          'var(--grn) ok, var(--red) danger, on the dark var(--bg)/var(--card) glass — NOT raw hexes, and Share Tech Mono for ' +
          'data/numbers (the exact shell fonts do not travel, but the colour tokens do). Aim for the neon-HUD look. ' +
          'Example html: `<div style="font:40px \'Share Tech Mono\',monospace;color:var(--acc)" data-alfred="current.temperature_2m"></div>` ' +
          '— the runtime writes the latest temperature into it each refresh. Do NOT bake a fixed value into the markup, use a ' +
          'binding. No <script>, no <script src>, no external libraries. The data pipeline (fetch/agent) is unchanged — ' +
          'tier:2 only changes the render.',
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

    if (op === 'create') {
      const v = validateJobSpec(a);
      if (!v.ok) return { ok: false, error: v.error };
      // A study job's agent must exist and be an API brain (scheduled study runs
      // unattended in-process; a claude-cli agent can only run attended).
      if (v.spec.kind === 'study') {
        const agent = getAgent(ctx.db, v.spec.study!.agentId);
        if (!agent) return { ok: false, error: `no roster agent with id "${v.spec.study!.agentId}" (team op=list to see them)` };
        if (agent.provider === 'claude-cli') {
          return { ok: false, error: `${agent.id} is a claude-cli agent — scheduled study needs an API-brain agent (claude-api / openai / deepseek)` };
        }
      }
      // Tier-2 (custom HTML): scan for dangerous patterns (refuse), warn on
      // suspicious ones, and fail loud if it won't update in declarative mode.
      let widgetWarning: string | undefined;
      if (v.spec.render.tier === 2) {
        const guard = guardTier2Html(v.spec.render.html ?? '', ctx);
        if (guard.error) return { ok: false, error: guard.error };
        widgetWarning = guard.warning;
      }
      const job: Job = { id: randomUUID(), ...v.spec, enabled: true, runtime: {} };
      createJob(ctx.db, job);
      rescheduleJob(job.id);
      // A tier-1/2 job registered a widget layout row — push the new layout so
      // the widget card appears (and get_layout/move_card can reach it).
      ctx.emit({ kind: 'layout', cards: getLayout(ctx.db) });
      // Re-read so the returned nextRunTs reflects what the scheduler armed.
      const armed = getJob(ctx.db, job.id) ?? job;
      return {
        ok: true,
        result: {
          job: summarize(armed),
          nextRun: armed.runtime.nextRunTs ?? nextRun(job.schedule, Date.now()),
          ...(widgetWarning ? { warning: widgetWarning } : {}),
        },
      };
    }

    if (op === 'edit') {
      // edit = MERGE, not replace: overlay only the fields the caller sent onto
      // the current spec, so editing just the interval keeps a custom tier-2
      // render.html / source / prompt / grant / placement (it used to wipe them).
      if (!id) return { ok: false, error: 'edit needs an id' };
      const cur = getJob(ctx.db, id);
      if (!cur) return { ok: false, error: `no job with id ${id}` };
      const current: JobSpecInput = {
        title: cur.title,
        kind: cur.kind,
        schedule: cur.schedule,
        source: cur.source,
        study: cur.study,
        prompt: cur.prompt,
        grant: cur.grant,
        tokenBudgetDaily: cur.tokenBudgetDaily,
        render: cur.render,
        placement: cur.placement,
      };
      const v = validateJobSpec(mergeJobSpec(current, a));
      if (!v.ok) return { ok: false, error: v.error };
      // Re-scan the (possibly new) tier-2 HTML on edit too — refuse dangerous, warn suspicious/declarative.
      let widgetWarning: string | undefined;
      if (v.spec.render.tier === 2) {
        const guard = guardTier2Html(v.spec.render.html ?? '', ctx);
        if (guard.error) return { ok: false, error: guard.error };
        widgetWarning = guard.warning;
      }
      // Keep runtime but drop the stale nextRunTs so the scheduler recomputes
      // from the (possibly new) schedule.
      const { nextRunTs: _drop, ...runtime } = cur.runtime;
      updateJob(ctx.db, id, {
        title: v.spec.title,
        kind: v.spec.kind,
        schedule: v.spec.schedule,
        source: v.spec.source,
        study: v.spec.study,
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
      return {
        ok: true,
        result: { job: summarize(after), nextRun: after.runtime.nextRunTs ?? null, ...(widgetWarning ? { warning: widgetWarning } : {}) },
      };
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
