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

import type { Capability, Job, JobKind, JobPlacement, JobRender, JobSchedule, JobSource } from './types.ts';
import { WIDGET_HTML_MAX_BYTES } from './widget-html-pure.ts';

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
const READ = ['read', 'readtext', 'list', 'get', 'search', 'fetch', 'view', 'status', 'info', 'open', 'goto', 'navigate', 'screenshot', 'snapshot', 'ls', 'cat', 'head', 'tail', 'stat', 'find', 'grep', 'recall'];

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

// ── per-run trifecta escalation (§3.1 egress after an untrusted read) ─────────

/** Mutable per-run flag set: has the agent read UNTRUSTED content this run? */
export interface JobRunState {
  readUntrusted: boolean;
}

/**
 * True when a tool call pushes data OUTWARD: an outbound message (send/post/…),
 * a browser interaction that could submit a form (fill/type/click/…), or a shell
 * command that exfiltrates (curl POST/upload, scp, git push — via isDangerousCmd).
 * A plain read / navigation is NOT outbound.
 */
export function isOutboundAction(toolName: string, args?: unknown): boolean {
  const t = opTokens(toolName, args);
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  if (hasAny(t, OUTBOUND)) return true;
  if (hasAny(t, BROWSE_INTERACT)) return true;
  if (hasAny(t, SHELL)) {
    const cmd = String(a.command ?? a.cmd ?? a.script ?? '');
    if (isDangerousCmd(cmd)) return true;
  }
  return false;
}

/**
 * Per-run trifecta escalation. Once the agent has read UNTRUSTED content this
 * run, any OUTBOUND/egress action is escalated to a queued approval — even if
 * jobActionDecision said 'allow' (in-grant, or dangerous-mode). This pierces
 * dangerous mode exactly like the sensitive set does: an in-grant `browse`
 * form-submit could exfiltrate what was just read, so a human must confirm it.
 * Sensitive actions are already queued by jobActionDecision; a 'deny' or an
 * existing 'queue-approval' is never downgraded. Pure.
 */
export function escalateForTrifecta(
  decision: 'allow' | 'deny' | 'queue-approval',
  runState: JobRunState,
  toolName: string,
  args?: unknown,
): 'allow' | 'deny' | 'queue-approval' {
  if (decision === 'allow' && runState.readUntrusted && isOutboundAction(toolName, args)) {
    return 'queue-approval';
  }
  return decision;
}

// ── job approval queue: pure state transition ─────────────────────────────────

export type JobApprovalStatus = 'pending' | 'approved' | 'denied';

/** Next status for an approval. A pending one resolves once; a resolved one is immutable (idempotent). */
export function nextApprovalStatus(current: JobApprovalStatus, approved: boolean): JobApprovalStatus {
  if (current !== 'pending') return current;
  return approved ? 'approved' : 'denied';
}

// ── fetch runner: pure value extraction (stage 2) ─────────────────────────────

/** Minimum interval between fetches — a sane floor so a job can't hammer a source. */
export const MIN_INTERVAL_MS = 30_000;

// ── SSRF guard for fetch sources (§6) ────────────────────────────────────────

/** True when an IPv4 literal is loopback / private / link-local / unspecified. */
function isPrivateIpv4(h: string): boolean {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false; // not a real v4 literal
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 (this-host / unspecified)
  if (a === 127) return true; // loopback 127/8
  if (a === 10) return true; // private 10/8
  if (a === 169 && b === 254) return true; // link-local 169.254/16 (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  return false;
}

/** True when an IPv6 literal (brackets already stripped) is loopback / ULA / link-local / mapped-private. */
function isPrivateIpv6(h: string): boolean {
  const x = h.toLowerCase();
  if (!x.includes(':')) return false;
  if (x === '::1' || x === '::') return true; // loopback / unspecified
  if (x.startsWith('fe80:') || x.startsWith('fe80::')) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]*:/.test(x)) return true; // unique-local fc00::/7
  const mapped = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped ::ffff:a.b.c.d
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * Reject hostnames a scheduled fetch must never reach: localhost, mDNS/internal
 * TLDs, and loopback/private/link-local IP literals (incl. the cloud-metadata
 * address). ponytail: literal-host blocklist only — DNS rebinding (a public name
 * resolving to a private IP) is out of this trivial guard's scope; add a
 * resolve-time check if a job ever legitimately needs a rebinding-prone name.
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 [] brackets
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  return isPrivateIpv4(h) || isPrivateIpv6(h);
}

/**
 * Validate a fetch source URL: http(s) only, and not a local/internal address
 * (SSRF floor, §6). Returns an error string, or null when the URL is allowed.
 * Reused by validateJobSpec (create/edit) AND the runtime runner (defence in
 * depth against a row written straight to the DB).
 */
export function fetchUrlError(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'fetch job needs source.url starting with http:// or https://';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'fetch job needs source.url starting with http:// or https://';
  }
  if (isBlockedHost(u.hostname)) {
    return `fetch job may not target a local/internal address (${u.hostname}) — SSRF guard`;
  }
  return null;
}

/**
 * Split a dot/bracket path ("current.temperature_2m", "list[0].main", "['a.b'].c")
 * into keys. A QUOTED bracket key is taken verbatim — so ['a.b'] is the single
 * key "a.b", not a descent a→b (the whole point of the quoted form). Tokenised
 * directly instead of transform-then-split, which broke on dotted quoted keys.
 */
function parsePath(spec: string): string[] {
  const keys: string[] = [];
  // quoted-bracket ['k'] / ["k"]  |  bare-bracket [k]  |  dot segment
  const re = /\[\s*(['"])(.*?)\1\s*\]|\[\s*([^\]]*?)\s*\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(spec)) !== null) {
    const key = m[2] ?? m[3] ?? m[4];
    if (key !== undefined && key !== '') keys.push(key);
  }
  return keys;
}

/**
 * Pull the value a fetch card should show out of a parsed response.
 * `spec` is a simple dot/bracket path; missing segments → undefined (never
 * throws). No spec → the whole payload (the card renders it compactly).
 * ponytail: path-only; add a template ({{a.b}}-style) when a card actually needs it.
 */
export function extractValue(data: unknown, spec?: string): unknown {
  if (!spec) return data;
  let cur: unknown = data;
  for (const key of parsePath(spec)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// ── schedule tool: pure input validation for create/edit ─────────────────────

/** Normalised, validated job spec ready to build a Job (no id/enabled/runtime). */
export interface ValidatedJobSpec {
  title: string;
  kind: JobKind;
  schedule: JobSchedule;
  source?: JobSource;
  prompt?: string;
  grant?: Capability[];
  tokenBudgetDaily?: number;
  render: JobRender;
  placement?: JobPlacement;
}

export type ValidateResult =
  | { ok: true; spec: ValidatedJobSpec }
  | { ok: false; error: string };

function validateSchedule(s: unknown): { ok: true; schedule: JobSchedule } | { ok: false; error: string } {
  if (!s || typeof s !== 'object') {
    return { ok: false, error: 'schedule is required: {type:"interval",everyMs} or {type:"daily",at:"HH:MM"}' };
  }
  const o = s as Record<string, unknown>;
  if (o.type === 'interval') {
    if (typeof o.everyMs !== 'number' || !Number.isFinite(o.everyMs)) {
      return { ok: false, error: 'interval schedule needs a numeric everyMs' };
    }
    if (o.everyMs < MIN_INTERVAL_MS) {
      return { ok: false, error: `everyMs must be >= ${MIN_INTERVAL_MS} (30s) so a job can't hammer the source` };
    }
    return { ok: true, schedule: { type: 'interval', everyMs: o.everyMs } };
  }
  if (o.type === 'daily') {
    if (typeof o.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.at)) {
      return { ok: false, error: 'daily schedule needs at:"HH:MM" (24-hour, local time)' };
    }
    return { ok: true, schedule: { type: 'daily', at: o.at } };
  }
  return { ok: false, error: 'schedule.type must be "interval" or "daily"' };
}

const ALL_CAPS: readonly Capability[] = ['read', 'notify', 'write', 'browse', 'shell', 'send', 'delete', 'money', 'secrets'];

function validateGrant(g: unknown): { ok: true; grant: Capability[] } | { ok: false; error: string } {
  if (g === undefined) return { ok: true, grant: [...DEFAULT_GRANT] };
  if (!Array.isArray(g) || g.some((c) => !ALL_CAPS.includes(c as Capability))) {
    return { ok: false, error: `grant must be an array of capabilities (${ALL_CAPS.join(', ')})` };
  }
  return { ok: true, grant: g as Capability[] };
}

function validateRender(r: unknown): { ok: true; render: JobRender } | { ok: false; error: string } {
  if (r === undefined) return { ok: true, render: { tier: 1, card: 'value' } };
  const o = r as Record<string, unknown>;
  if (!o || typeof o !== 'object' || (o.tier !== 1 && o.tier !== 2 && o.tier !== 3) || typeof o.card !== 'string') {
    return { ok: false, error: 'render must be {tier:1|2|3, card:string}' };
  }
  const render: JobRender = { tier: o.tier as 1 | 2 | 3, card: o.card };
  if (o.tier === 2) {
    if (typeof o.html !== 'string' || o.html.trim() === '') {
      return { ok: false, error: 'render.tier=2 requires an html string (the self-contained widget page)' };
    }
    if (o.html.length > WIDGET_HTML_MAX_BYTES) {
      return { ok: false, error: `render.html exceeds the ${WIDGET_HTML_MAX_BYTES}-byte cap` };
    }
    render.html = o.html;
  }
  return { ok: true, render };
}

/** Loosely-typed create/edit input from the schedule tool (validated here). */
export interface JobSpecInput {
  title?: unknown;
  kind?: unknown;
  schedule?: unknown;
  source?: unknown;
  prompt?: unknown;
  grant?: unknown;
  tokenBudgetDaily?: unknown;
  render?: unknown;
  placement?: unknown;
}

/**
 * Field-by-field overlay for `edit`: return `current` with every field the
 * `patch` actually provides overwritten. An `undefined` patch field keeps the
 * current value — so editing just the interval preserves render.html/source/
 * prompt/grant/placement (the bug: a full replace wiped a custom tier-2 render).
 * The caller feeds the result to validateJobSpec. Pure.
 */
export function mergeJobSpec(current: JobSpecInput, patch: JobSpecInput): JobSpecInput {
  const pick = <K extends keyof JobSpecInput>(k: K): JobSpecInput[K] =>
    patch[k] !== undefined ? patch[k] : current[k];
  return {
    title: pick('title'),
    kind: pick('kind'),
    schedule: pick('schedule'),
    source: pick('source'),
    prompt: pick('prompt'),
    grant: pick('grant'),
    tokenBudgetDaily: pick('tokenBudgetDaily'),
    render: pick('render'),
    placement: pick('placement'),
  };
}

/**
 * Validate + normalise a create/edit spec. Pure so the tool can reject bad
 * input before touching the DB and the tests can exercise every rejection.
 */
export function validateJobSpec(input: JobSpecInput): ValidateResult {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) return { ok: false, error: 'title is required' };
  if (input.kind !== 'fetch' && input.kind !== 'agent') return { ok: false, error: 'kind must be "fetch" or "agent"' };

  const sched = validateSchedule(input.schedule);
  if (!sched.ok) return sched;

  const render = validateRender(input.render);
  if (!render.ok) return render;

  let tokenBudgetDaily: number | undefined;
  if (input.tokenBudgetDaily !== undefined) {
    if (typeof input.tokenBudgetDaily !== 'number' || !Number.isFinite(input.tokenBudgetDaily) || input.tokenBudgetDaily <= 0) {
      return { ok: false, error: 'tokenBudgetDaily must be a positive number' };
    }
    tokenBudgetDaily = input.tokenBudgetDaily;
  }

  const placement = input.placement as JobPlacement | undefined;

  if (input.kind === 'fetch') {
    const src = (input.source ?? {}) as Record<string, unknown>;
    const url = typeof src.url === 'string' ? src.url : '';
    const urlErr = fetchUrlError(url);
    if (urlErr) return { ok: false, error: urlErr };
    if (src.method !== undefined && src.method !== 'GET') return { ok: false, error: 'fetch source.method must be "GET"' };
    if (src.headers !== undefined && (typeof src.headers !== 'object' || src.headers === null || Array.isArray(src.headers))) {
      return { ok: false, error: 'source.headers must be an object of string values' };
    }
    if (src.extract !== undefined && typeof src.extract !== 'string') return { ok: false, error: 'source.extract must be a string path' };
    const source: JobSource = { url, method: 'GET' };
    if (src.headers) source.headers = src.headers as Record<string, string>;
    if (typeof src.extract === 'string') source.extract = src.extract;
    return { ok: true, spec: { title, kind: 'fetch', schedule: sched.schedule, source, render: render.render, placement } };
  }

  // agent
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'agent job needs a prompt' };
  const grant = validateGrant(input.grant);
  if (!grant.ok) return grant;
  return {
    ok: true,
    spec: { title, kind: 'agent', schedule: sched.schedule, prompt, grant: grant.grant, tokenBudgetDaily, render: render.render, placement },
  };
}
