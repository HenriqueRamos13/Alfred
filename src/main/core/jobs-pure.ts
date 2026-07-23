/**
 * Scheduled-jobs PURE logic (Phase 4, stage 1). Renderer-safe: MUST stay free
 * of any `node:*` / better-sqlite3 import so it can be shared with the UI and
 * unit-tested via `node --experimental-strip-types` (see reset-pure.ts).
 *
 * This is the security heart of the subsystem: next-run computation, the
 * per-job daily budget decision, the grant allowlist, and the sensitive-action
 * classifier that pierces dangerous mode for unattended jobs (§3.1/§6 of
 * tasks/PHASE4-SCHEDULED-JOBS-PROMPT.md). All deterministic — time is passed in
 * as `now`, never read here.
 */

import type { Capability, Job, JobSchedule } from './types.ts';

/** Default per-job daily token cap when a job sets none (agent jobs). */
export const DEFAULT_TOKEN_BUDGET_DAILY = 100_000;

/** Default autonomy grant for a new job: read + notify only (§3). */
export const DEFAULT_GRANT: readonly Capability[] = ['read', 'notify'];

// ── time helpers (self-contained; mirrors budget.dayKey to avoid dragging the
//    pricing/native chain into a renderer-safe module) ─────────────────────────

/** Local calendar day, YYYY-MM-DD, for a given epoch-ms instant. */
export function dayKey(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── next-run computation ───────────────────────────────────────────────────────

/**
 * Next fire time (epoch ms) for a schedule, given `now` and the last run.
 *
 * - interval: lastRun (or now, for a fresh job) + everyMs; an overdue slot
 *   (e.g. after the app was closed) fires immediately (returns `now`).
 * - daily: the next wall-clock HH:MM in local time; if that time already passed
 *   today, tomorrow. `setDate(+1)` keeps the local hour correct across DST
 *   rather than blindly adding 24h.
 */
export function nextRun(schedule: JobSchedule, now: number, lastRunTs?: number): number {
  if (schedule.type === 'interval') {
    const base = lastRunTs ?? now;
    const next = base + schedule.everyMs;
    return next <= now ? now : next;
  }
  // daily
  const [h, m] = schedule.at.split(':').map((s) => Number(s));
  const d = new Date(now);
  const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
  if (cand.getTime() <= now) cand.setDate(cand.getDate() + 1);
  return cand.getTime();
}

// ── per-job daily budget ─────────────────────────────────────────────────────

export interface BudgetDecision {
  /** May the job spend `addTokens` now? */
  allowed: boolean;
  /** Counter for `tokensDay` AFTER any daily reset, BEFORE adding the estimate. */
  tokensToday: number;
  /** Today's day key (what tokensDay should become). */
  tokensDay: string;
  /** Set to 'budget' when the estimate would blow the cap (pause, don't kill). */
  pausedReason: 'budget' | null;
  /** True when a new day rolled the counter back to 0. */
  reset: boolean;
}

/**
 * Decide whether an `agent` job may spend an estimated `addTokens` more today,
 * applying the daily reset first. On exhaustion the caller PAUSES the job
 * (pausedReason='budget') + notifies — it never kills a run mid-flight. The
 * global kill-switch (budget.ts) still applies on top of this.
 */
export function budgetDecision(job: Job, now: number, addTokens: number): BudgetDecision {
  const today = dayKey(now);
  const reset = job.runtime.tokensDay !== today;
  const tokensToday = reset ? 0 : job.runtime.tokensToday ?? 0;
  const cap = job.tokenBudgetDaily ?? DEFAULT_TOKEN_BUDGET_DAILY;
  const allowed = tokensToday + addTokens <= cap;
  return { allowed, tokensToday, tokensDay: today, pausedReason: allowed ? null : 'budget', reset };
}

// ── grant / sensitive-action classifiers (§3.1, §6) ──────────────────────────

function toks(name: string): string[] {
  return String(name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Tokens of the tool name AND its `op` arg (so `filesystem` + op `delete` matches). */
function opTokens(toolName: string, args?: unknown): string[] {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const op = typeof a.op === 'string' ? a.op : '';
  return toks(`${toolName} ${op}`);
}

function hasAny(names: readonly string[], set: readonly string[]): boolean {
  return set.some((s) => names.includes(s));
}

// Verb sets. Order matters in toolCapability: sensitive categories win.
const OUTBOUND = ['send', 'reply', 'forward', 'post', 'publish', 'submit', 'tweet', 'dm', 'sms', 'mail', 'email'];
const MONEY = ['pay', 'payment', 'purchase', 'buy', 'charge', 'billing', 'checkout', 'transfer', 'wire', 'refund', 'invoice', 'card'];
const DESTRUCTIVE = ['delete', 'remove', 'destroy', 'drop', 'truncate', 'wipe', 'erase', 'overwrite', 'rm', 'rmdir', 'unlink'];
const SECRET = ['credential', 'credentials', 'password', 'passwd', 'secret', 'secrets', 'keychain', 'apikey', 'bearer', 'token', 'oauth'];
const SHELL = ['shell', 'exec', 'bash', 'sh', 'command', 'run', 'spawn'];
const BROWSE_INTERACT = ['click', 'fill', 'type', 'press', 'select', 'drag'];
const WRITE = ['write', 'create', 'edit', 'append', 'mkdir', 'save', 'update', 'rename', 'move', 'download', 'set'];
const NOTIFY = ['notify', 'notification', 'alert', 'toast', 'say', 'speak'];
const READ = ['read', 'list', 'get', 'search', 'fetch', 'view', 'status', 'info', 'open', 'goto', 'navigate', 'screenshot', 'snapshot', 'ls', 'cat', 'head', 'tail', 'stat', 'find', 'grep', 'recall'];

/** True when a shell command line mutates, deletes, or pipes-to-shell (egress). */
function isDangerousCmd(cmd: string): boolean {
  if (!cmd) return false;
  if (/[>]{1,2}/.test(cmd)) return true; // redirection overwrites/appends
  if (/\b(rm|rmdir|unlink|mkfs|dd|shutdown|reboot|kill|killall|chown|chmod|mv|format|del|fdisk|truncate|shred)\b/.test(cmd)) return true;
  if (/\b(npm|pnpm|yarn|pip|pip3|brew|apt|apt-get|gem|cargo|go)\b[\s\S]*\b(install|add|remove|uninstall|rm)\b/.test(cmd)) return true;
  if (/\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh)\b/.test(cmd)) return true;
  if (/\b(scp|rsync|ftp|nc|netcat)\b/.test(cmd)) return true; // exfil vectors
  // Outbound HTTP: curl/wget that POST/PUT or upload a body/file are egress —
  // a plain `curl https://…` GET stays non-sensitive (fetch jobs rely on it).
  if (/\b(curl|wget)\b/.test(cmd)) {
    if (/-X\s*(POST|PUT|PATCH|DELETE)/i.test(cmd)) return true;
    if (/(^|\s)(-d|--data(-\w+)?|-F|--form|-T|--upload-file|--post-data|--post-file)(=|\s|$)/.test(cmd)) return true;
  }
  if (/\bgit\s+push\b/.test(cmd)) return true; // publishing/exfil to a remote
  if (/\b(DROP|DELETE|TRUNCATE|ALTER)\b/i.test(cmd)) return true; // destructive SQL via a db client
  return false;
}

/**
 * The capability a tool call needs. Sensitive categories map to their own
 * capability (send/money/delete/secrets) — those never sit in a normal grant
 * and are gated by isSensitiveAction anyway. Unrecognised tools fall back to
 * 'write' (conservative: NOT auto-allowed by the read+notify default).
 */
export function toolCapability(toolName: string, args?: unknown): Capability {
  const t = opTokens(toolName, args);
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  if (hasAny(t, OUTBOUND)) return 'send';
  if (hasAny(t, MONEY)) return 'money';
  if (hasAny(t, DESTRUCTIVE) || a.overwrite === true || a.force === true) return 'delete';
  if (hasAny(t, SECRET)) return 'secrets';
  if (hasAny(t, SHELL)) return 'shell';
  if (hasAny(t, BROWSE_INTERACT)) return 'browse';
  if (hasAny(t, NOTIFY)) return 'notify';
  if (hasAny(t, READ)) return 'read';
  if (hasAny(t, WRITE)) return 'write';
  return 'write';
}

/** True when the tool call's needed capability is in the job's grant (default read+notify). */
export function grantAllows(grant: readonly Capability[] | undefined, toolName: string, args?: unknown): boolean {
  const g = grant ?? DEFAULT_GRANT;
  return g.includes(toolCapability(toolName, args));
}

/**
 * A "sensitive" action (§3.1) that must NEVER auto-run in an unattended job —
 * even in dangerous mode. Outbound send / egress, money, destructive
 * (delete/overwrite/db/shell), or credentials-store access.
 */
export function isSensitiveAction(toolName: string, args?: unknown): boolean {
  const t = opTokens(toolName, args);
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  if (hasAny(t, OUTBOUND)) return true;
  if (hasAny(t, MONEY)) return true;
  if (hasAny(t, DESTRUCTIVE) || a.overwrite === true || a.force === true) return true;
  if (hasAny(t, SECRET)) return true;
  if (hasAny(t, SHELL)) {
    const cmd = String(a.command ?? a.cmd ?? a.script ?? '');
    if (isDangerousCmd(cmd)) return true;
  }
  return false;
}

export interface JobActionCtx {
  grant?: readonly Capability[];
  /** DANGEROUS mode on. */
  dangerous: boolean;
  /** The job runs with no human watching (always true for scheduled jobs). */
  unattended: boolean;
}

/**
 * The autonomy decision for one tool call inside a job run (§6):
 *  - sensitive + unattended  → 'queue-approval' ALWAYS (pierces dangerous mode)
 *  - non-sensitive, in grant → 'allow'
 *  - non-sensitive, out of grant, dangerous → 'allow'
 *  - non-sensitive, out of grant, not dangerous → 'deny'
 * (Stage 2 wires this to the real runner + approval queue; here it is pure.)
 */
export function jobActionDecision(ctx: JobActionCtx, toolName: string, args?: unknown): 'allow' | 'deny' | 'queue-approval' {
  if (ctx.unattended && isSensitiveAction(toolName, args)) return 'queue-approval';
  if (grantAllows(ctx.grant, toolName, args)) return 'allow';
  return ctx.dangerous ? 'allow' : 'deny';
}
