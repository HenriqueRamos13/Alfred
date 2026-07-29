/**
 * Governance: risk classification, HITL approvals, trifecta-lite, audit.
 *
 * `classifyAction` and the trifecta/egress predicates are pure and strip-types
 * safe (tested in test/logic.test.ts). `createGovernance` builds the stateful
 * approval broker; `recordAudit` writes the audit row (db passed in, so no
 * native import here).
 */

import { randomUUID } from 'node:crypto';
import { HITL_TIERS } from './types.ts';
import type {
  ApprovalRequest,
  ApprovalResolution,
  AuditEntry,
  Governance,
  RiskTier,
  StreamEvent,
  Tool,
  ToolCtx,
  TrifectaFlags,
} from './types.ts';

type DB = import('better-sqlite3').Database;

// ── classification ────────────────────────────────────────────────────────────

const T3_HINTS = ['pay', 'payment', 'purchase', 'charge', 'billing', 'credential', 'credentials', 'transfer', 'wire', 'secret', 'secrets', 'password', 'keychain', 'vault'];
const T2_HINTS = ['delete', 'remove', 'destroy', 'rm', 'send', 'install', 'uninstall', 'publish', 'deploy', 'drop', 'kill'];
const T1_HINTS = ['write', 'create', 'edit', 'update', 'append', 'mkdir', 'make', 'type', 'click', 'fill', 'rename', 'move', 'download', 'connect'];
const T0_HINTS = ['read', 'list', 'get', 'search', 'open', 'goto', 'screenshot', 'view', 'fetch', 'status', 'info'];

function tokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasHint(name: string, hints: readonly string[]): boolean {
  const ts = tokens(name);
  return hints.some((h) => ts.includes(h));
}

function isDestructiveShell(cmd: string): boolean {
  if (!cmd) return false;
  if (/[>]{1,2}/.test(cmd)) return true; // output redirection overwrites/appends
  if (/\b(rm|rmdir|mkfs|dd|shutdown|reboot|kill|killall|chown|chmod|mv|format|del|fdisk)\b/.test(cmd)) return true;
  if (/\b(npm|pnpm|yarn|pip|pip3|brew|apt|apt-get|gem|cargo|go)\b[\s\S]*\b(install|add|remove|uninstall|rm)\b/.test(cmd)) return true;
  if (/\bcurl\b[\s\S]*\|\s*(sh|bash|zsh)\b/.test(cmd)) return true;
  return false;
}

/**
 * Default risk tier for a tool call. A tool's own `risk?(args)` overrides this.
 * Precedence T3 > T2 > T1 > T0; unknown tools default to T1 (reversible, runs
 * freely but not treated as a free read).
 */
export function classifyAction(toolName: string, args: unknown): RiskTier {
  const name = String(toolName ?? '').toLowerCase();
  if (name === 'render_ui') return 'T0';

  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};

  if (tokens(name).some((t) => ['shell', 'exec', 'run', 'command', 'cmd', 'sh', 'bash'].includes(t))) {
    const cmd = String(a.command ?? a.cmd ?? a.script ?? '').toLowerCase();
    return isDestructiveShell(cmd) ? 'T2' : 'T1';
  }

  if (hasHint(name, T3_HINTS)) return 'T3';
  if (hasHint(name, T2_HINTS)) return 'T2';
  if (a.overwrite === true || a.force === true) return 'T2';
  if (hasHint(name, T1_HINTS)) return 'T1';
  if (hasHint(name, T0_HINTS)) return 'T0';
  return 'T1';
}

// ── trifecta-lite ─────────────────────────────────────────────────────────────

/** Flags a tool sets when it runs: reading web/email is untrusted; email is private. */
export function trifectaImpact(toolName: string): Partial<TrifectaFlags> {
  const name = toolName.toLowerCase();
  const flags: Partial<TrifectaFlags> = {};
  if (/browser|gmail|mail|web|fetch|search/.test(name)) flags.readUntrusted = true;
  if (/gmail|mail|email/.test(name)) flags.hasPrivate = true;
  return flags;
}

/** Tools capable of pushing data outward. */
export function isEgressTool(toolName: string): boolean {
  const ts = tokens(toolName);
  const egress = ['send', 'post', 'upload', 'submit', 'publish', 'deploy', 'push', 'type', 'fill'];
  return ts.some((t) => egress.includes(t)) || ts.includes('shell') || ts.includes('exec');
}

export function fullTrifecta(f: TrifectaFlags): boolean {
  return f.readUntrusted && f.hasPrivate && f.canEgress;
}

// ── auto-approve rules ─────────────────────────────────────────────────────────

/**
 * Persisted-rule key for a tool call: `tool:op` when the args carry an `op`
 * field (e.g. `filesystem:delete`), otherwise the bare tool name. Storing and
 * matching both go through this, so "don't ask again" scopes exactly to the
 * op the human approved, not the whole tool.
 */
export function approvalKey(toolName: string, args: unknown): string {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const op = typeof a.op === 'string' ? a.op.trim() : '';
  return op ? `${toolName}:${op}` : toolName;
}

/** True when a persisted auto-approve rule covers this call. */
export function isAutoApproved(rules: readonly string[], toolName: string, args: unknown): boolean {
  return rules.includes(approvalKey(toolName, args));
}

/** Standard tool-facing error string for a denied/timed-out approval. */
export function denialError(res: { timedOut?: boolean }): string {
  return res.timedOut ? 'Approval timed out — denied' : 'Denied by user';
}

// ── audit ─────────────────────────────────────────────────────────────────────

const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|bearer/i;
const PRIVATE_PAYLOAD_KEY = /^(?:body|content|html|image|message|snippet|stderr|stdout|text)$/i;

/** Redact common credential formats when a secret appears inside free-form text. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '***')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,})\b/g, '***')
    .replace(
      /\b(password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret)(\s*[:=]\s*)(["']?)[^\s"',;}]+\3/gi,
      '$1$2***',
    );
}

/** Redact secret-looking fields before persisting/streaming tool args. */
export function maskSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '***' : maskSecrets(v);
    }
    return out;
  }
  return value;
}

function textSummary(value: unknown): string {
  return `[redacted: ${typeof value === 'string' ? value.length : 0} chars]`;
}

function summarizePrivateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(summarizePrivateFields);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      out[key] = PRIVATE_PAYLOAD_KEY.test(key) ? textSummary(field) : summarizePrivateFields(field);
    }
    return out;
  }
  return maskSecrets(value);
}

/** Keep an actionable audit trail without duplicating private tool payloads. */
export function sanitizeAuditArgs(toolName: string, args: unknown): unknown {
  const name = toolName.toLowerCase();
  const masked = maskSecrets(args);
  if (!masked || typeof masked !== 'object' || Array.isArray(masked)) return masked;

  const out = { ...(masked as Record<string, unknown>) };
  if (name === 'filesystem' && typeof out.content === 'string') out.content = textSummary(out.content);
  if (name === 'browser' && typeof out.text === 'string') out.text = textSummary(out.text);
  if (name === 'system' && typeof out.text === 'string') out.text = textSummary(out.text);
  if (name === 'system' && typeof out.body === 'string') out.body = textSummary(out.body);
  return out;
}

/** Results from content-reading tools are reduced to non-content metadata. */
export function sanitizeAuditResult(toolName: string, result: unknown): unknown {
  if (result === undefined) return undefined;
  const name = toolName.toLowerCase();
  const r = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : null;

  if (name === 'shell' && r) {
    return {
      code: typeof r.code === 'number' ? r.code : undefined,
      timedOut: r.timedOut === true || undefined,
      stdoutChars: typeof r.stdout === 'string' ? r.stdout.length : 0,
      stderrChars: typeof r.stderr === 'string' ? r.stderr.length : 0,
    };
  }
  if (name === 'filesystem' && r) {
    return {
      path: r.path,
      bytes: r.bytes ?? (typeof r.content === 'string' ? r.content.length : undefined),
      entryCount: Array.isArray(r.entries) ? r.entries.length : undefined,
      deleted: r.deleted,
    };
  }
  if (name === 'gmail' && r) {
    return {
      connected: typeof r.email === 'string' || undefined,
      messageId: r.id,
      messageCount: Array.isArray(r.messages) ? r.messages.length : undefined,
    };
  }
  if (name === 'browser' && r) {
    return {
      url: r.url,
      path: r.path,
      textChars: typeof r.text === 'string' ? r.text.length : undefined,
    };
  }

  return summarizePrivateFields(result);
}

/**
 * Run one tool through the FULL governance pipeline: risk classification,
 * trifecta-lite escalation, HITL approval, execution, audit, and the UI stream
 * events. Returns the tool's result value, or `{ error }` — it never throws, so
 * the caller (model) can react. Shared by the orchestrator's agent loop AND the
 * MCP bridge, so `claude -p` calling an Alfred tool gets identical guardrails.
 *
 * Loop detection is the caller's concern (only the streaming loop tracks a call
 * history); everything else lives here so there is a single governance path.
 */
export async function runGovernedTool(t: Tool, args: unknown, ctx: ToolCtx): Promise<unknown> {
  const tier: RiskTier = t.risk?.(args) ?? classifyAction(t.name, args);

  // Trifecta-lite: reading web/email marks untrusted/private; an egress tool that
  // would complete the trifecta is escalated to a mandatory approval.
  ctx.governance.markTrifecta(trifectaImpact(t.name));
  let needApproval = HITL_TIERS.includes(tier);
  let reason = `Risk tier ${tier}`;
  if (isEgressTool(t.name)) {
    const tf = ctx.governance.trifecta();
    if (tf.readUntrusted && tf.hasPrivate) {
      ctx.governance.markTrifecta({ canEgress: true });
      needApproval = true;
      reason = 'Trifecta: untrusted read + private data + egress in one session';
    }
  }

  ctx.emit({ kind: 'tool.start', sessionId: ctx.sessionId, toolName: t.name, args: maskSecrets(args), tier });

  // Never let an audit write failure crash a turn — log and continue.
  const audit = (e: Omit<AuditEntry, 'sessionId' | 'ts'>): void => {
    try {
      recordAudit(ctx.db, { ...e, sessionId: ctx.sessionId, ts: Date.now() });
    } catch (err) {
      console.error('[alfred] audit write failed:', err instanceof Error ? err.message : err);
    }
  };

  // Provenance persisted in the audit when the call ran without a human prompt
  // (auto-approve rule or DANGEROUS mode) — so the forensic trail shows the bypass.
  let approvalNote: string | undefined;
  if (needApproval) {
    ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'awaiting-approval' });
    const resolution = await ctx.governance.requestApproval({
      sessionId: ctx.sessionId,
      toolName: t.name,
      args: maskSecrets(args),
      tier,
      reason,
    });
    approvalNote = resolution.note;
    if (resolution.decision === 'deny') {
      audit({
        toolName: t.name,
        args,
        tier,
        status: 'denied',
        error: resolution.timedOut ? 'approval timed out' : 'denied by user',
      });
      ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status: 'denied' });
      ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'thinking' });
      return { error: resolution.timedOut ? 'Approval timed out (treated as deny).' : 'Denied by the human.' };
    }
  }
  ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'tool' });

  const started = Date.now();
  try {
    const out = await t.execute(args, ctx);
    const status = out.ok ? 'ok' : 'error';
    audit({
      toolName: t.name,
      args,
      tier,
      status,
      result: out.ok ? out.result : undefined,
      error: out.error,
      durationMs: Date.now() - started,
      note: approvalNote,
    });
    ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status, error: out.error });
    return out.ok ? out.result ?? {} : { error: out.error };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Log the ORIGINAL error (stack) with context — the audit/UI keep only the
    // message string, so without this the root cause is lost.
    console.error(`[alfred] tool "${t.name}" threw (session ${ctx.sessionId}):`, err);
    audit({ toolName: t.name, args, tier, status: 'error', error, durationMs: Date.now() - started, note: approvalNote });
    ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status: 'error', error });
    return { error };
  }
}

export function recordAudit(db: DB, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit (session_id, ts, tool_name, args, tier, status, result, error, duration_ms, note)
     VALUES (@sessionId, @ts, @toolName, @args, @tier, @status, @result, @error, @durationMs, @note)`,
  ).run({
    sessionId: entry.sessionId,
    ts: entry.ts,
    toolName: entry.toolName,
    args: JSON.stringify(sanitizeAuditArgs(entry.toolName, entry.args) ?? null),
    tier: entry.tier,
    status: entry.status,
    result: entry.result === undefined ? null : JSON.stringify(sanitizeAuditResult(entry.toolName, entry.result)),
    error: entry.error ? redactSensitiveText(entry.error) : null,
    durationMs: entry.durationMs ?? null,
    note: entry.note ? redactSensitiveText(entry.note) : null,
  });
}

// ── approval broker + governance surface ──────────────────────────────────────

export interface GovernanceHandle {
  governance: Governance;
  /** Called by IPC when the human answers an approval prompt. `remember` persists an auto-approve rule. */
  resolveApproval(id: string, decision: ApprovalResolution['decision'], remember?: boolean): void;
  /** Reset trifecta flags (e.g. at the start of a new task). */
  resetTrifecta(): void;
}

/**
 * Persisted approval controls, injected so governance stays free of the native
 * DB import (keeps it strip-types testable). The orchestrator wires these to
 * `settings`. Absent → no bypass, every T2/T3 asks the human.
 */
export interface ApprovalStore {
  /** DANGEROUS mode: auto-approve everything. */
  isDangerous(): boolean;
  /** Current auto-approve rule keys. */
  rules(): string[];
  /** Persist a new auto-approve rule ("don't ask again"). */
  rememberRule(key: string): void;
}

export function createGovernance(opts: {
  sessionId: string;
  emit: (e: StreamEvent) => void;
  /** Fail-safe: unanswered approvals resolve as deny after this many ms. */
  timeoutMs?: number;
  store?: ApprovalStore;
}): GovernanceHandle {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pending = new Map<string, { done: (r: ApprovalResolution) => void; req: ApprovalRequest }>();
  let flags: TrifectaFlags = { readUntrusted: false, hasPrivate: false, canEgress: false };

  function finish(res: ApprovalResolution): void {
    const entry = pending.get(res.id);
    if (!entry) return;
    pending.delete(res.id);
    entry.done(res);
    opts.emit({ kind: 'approval.resolved', resolution: res });
  }

  /** Resolve without prompting the human; the tool still runs (and is audited normally). */
  function autoApprove(req: ApprovalRequest, note: string): Promise<ApprovalResolution> {
    const res: ApprovalResolution = { id: req.id, decision: 'approve', note };
    opts.emit({ kind: 'approval.resolved', resolution: res });
    return Promise.resolve(res);
  }

  const governance: Governance = {
    classify: classifyAction,

    requestApproval(reqPartial) {
      const req: ApprovalRequest = { ...reqPartial, id: randomUUID(), createdAt: Date.now() };
      // Precedence: DANGEROUS mode > auto-approve rule > ask the human.
      if (opts.store?.isDangerous()) return autoApprove(req, 'auto (dangerous mode)');
      if (opts.store && isAutoApproved(opts.store.rules(), req.toolName, req.args)) {
        return autoApprove(req, 'auto (rule)');
      }
      opts.emit({ kind: 'approval.request', request: req });
      return new Promise<ApprovalResolution>((resolve) => {
        const timer = setTimeout(() => finish({ id: req.id, decision: 'deny', timedOut: true }), timeoutMs);
        pending.set(req.id, { req, done: (r) => { clearTimeout(timer); resolve(r); } });
      });
    },

    markTrifecta(patch) {
      flags = { ...flags, ...patch };
    },

    trifecta() {
      return { ...flags };
    },
  };

  return {
    governance,
    resolveApproval(id, decision, remember) {
      const entry = pending.get(id);
      if (entry && decision === 'approve' && remember && opts.store) {
        opts.store.rememberRule(approvalKey(entry.req.toolName, entry.req.args));
      }
      finish({ id, decision });
    },
    resetTrifecta() {
      flags = { readUntrusted: false, hasPrivate: false, canEgress: false };
    },
  };
}
