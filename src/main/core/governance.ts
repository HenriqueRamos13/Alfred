/**
 * Governance: risk classification, HITL approvals, trifecta-lite, audit.
 *
 * `classifyAction` and the trifecta/egress predicates are pure and strip-types
 * safe (tested in test/logic.test.ts). `createGovernance` builds the stateful
 * approval broker; `recordAudit` writes the audit row (db passed in, so no
 * native import here).
 */

import { randomUUID } from 'node:crypto';
import type {
  ApprovalRequest,
  ApprovalResolution,
  AuditEntry,
  Governance,
  RiskTier,
  StreamEvent,
  TrifectaFlags,
} from './types.ts';

type DB = import('better-sqlite3').Database;

// ── classification ────────────────────────────────────────────────────────────

const T3_HINTS = ['pay', 'payment', 'purchase', 'charge', 'billing', 'credential', 'credentials', 'transfer', 'wire'];
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

// ── audit ─────────────────────────────────────────────────────────────────────

const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|bearer/i;

/** Redact secret-looking fields before persisting/streaming tool args. */
export function maskSecrets(value: unknown): unknown {
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

export function recordAudit(db: DB, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit (session_id, ts, tool_name, args, tier, status, result, error, duration_ms)
     VALUES (@sessionId, @ts, @toolName, @args, @tier, @status, @result, @error, @durationMs)`,
  ).run({
    sessionId: entry.sessionId,
    ts: entry.ts,
    toolName: entry.toolName,
    args: JSON.stringify(maskSecrets(entry.args) ?? null),
    tier: entry.tier,
    status: entry.status,
    result: entry.result === undefined ? null : JSON.stringify(entry.result),
    error: entry.error ?? null,
    durationMs: entry.durationMs ?? null,
  });
}

// ── approval broker + governance surface ──────────────────────────────────────

export interface GovernanceHandle {
  governance: Governance;
  /** Called by IPC when the human answers an approval prompt. */
  resolveApproval(id: string, decision: ApprovalResolution['decision']): void;
  /** Reset trifecta flags (e.g. at the start of a new task). */
  resetTrifecta(): void;
}

export function createGovernance(opts: {
  sessionId: string;
  emit: (e: StreamEvent) => void;
  /** Fail-safe: unanswered approvals resolve as deny after this many ms. */
  timeoutMs?: number;
}): GovernanceHandle {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pending = new Map<string, (r: ApprovalResolution) => void>();
  let flags: TrifectaFlags = { readUntrusted: false, hasPrivate: false, canEgress: false };

  function finish(res: ApprovalResolution): void {
    const done = pending.get(res.id);
    if (!done) return;
    pending.delete(res.id);
    done(res);
    opts.emit({ kind: 'approval.resolved', resolution: res });
  }

  const governance: Governance = {
    classify: classifyAction,

    requestApproval(reqPartial) {
      const req: ApprovalRequest = { ...reqPartial, id: randomUUID(), createdAt: Date.now() };
      opts.emit({ kind: 'approval.request', request: req });
      return new Promise<ApprovalResolution>((resolve) => {
        const timer = setTimeout(() => finish({ id: req.id, decision: 'deny', timedOut: true }), timeoutMs);
        pending.set(req.id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
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
    resolveApproval(id, decision) {
      finish({ id, decision });
    },
    resetTrifecta() {
      flags = { readUntrusted: false, hasPrivate: false, canEgress: false };
    },
  };
}
