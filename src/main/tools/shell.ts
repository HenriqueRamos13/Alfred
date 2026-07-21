import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Tool } from './types.ts';

interface Args {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Heuristic detector for irreversible / destructive shell commands.
 * ponytail: regex heuristic, not a real parser. Errs toward asking. Upgrade to a
 * shell-lexer allowlist if false-positives get annoying.
 */
const DESTRUCTIVE =
  /(\brm\b|\bmkfs\b|\bdd\b|\bshutdown\b|\breboot\b|\bkillall\b|\bkill\s+-9\b|>\s*\/dev\/|\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b|\bgit\s+.*\b(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)|:\(\)\s*\{|\bnpm\s+publish\b|\bmv\s+.*\s+\/)/i;

function isDestructive(cmd: string): boolean {
  return DESTRUCTIVE.test(cmd);
}

function run(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number; killed?: boolean; signal?: string }) | null;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: e && typeof e.code === 'number' ? e.code : e ? 1 : 0,
          timedOut: !!e?.killed || e?.signal === 'SIGKILL' || e?.signal === 'SIGTERM',
        });
      },
    );
    child.on('error', () => {
      /* handled via callback */
    });
  });
}

export const shell: Tool<Args> = {
  name: 'shell',
  description:
    'Run a shell command on the Mac (via /bin/sh -c) with a timeout and captured output. ' +
    'Destructive commands (rm -rf, dd, sudo, git reset --hard, ...) require human approval first.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line to execute.' },
      cwd: { type: 'string', description: 'Working directory (defaults to the workspace).' },
      timeoutMs: { type: 'number', description: 'Kill after this many ms (default 60000).' },
    },
    required: ['command'],
  },

  risk: (a) => (isDestructive(a.command) ? 'T2' : 'T1'),

  async execute(a, ctx) {
    const cwd = a.cwd ? (path.isAbsolute(a.cwd) ? a.cwd : path.resolve(ctx.workspace, a.cwd)) : ctx.workspace;
    const timeoutMs = a.timeoutMs && a.timeoutMs > 0 ? a.timeoutMs : 60_000;

    if (isDestructive(a.command)) {
      const res = await ctx.governance.requestApproval({
        sessionId: ctx.sessionId,
        toolName: this.name,
        args: { command: a.command, cwd },
        tier: 'T2',
        reason: `Run destructive command: ${a.command}`,
      });
      if (res.decision !== 'approve')
        return { ok: false, error: res.timedOut ? 'Approval timed out — denied' : 'Denied by user' };
    }

    const out = await run(a.command, cwd, timeoutMs);
    if (out.timedOut) return { ok: false, error: `Timed out after ${timeoutMs}ms`, result: out };
    return {
      ok: out.code === 0,
      result: { stdout: out.stdout, stderr: out.stderr, code: out.code },
      error: out.code === 0 ? undefined : `Exit code ${out.code}`,
    };
  },
};
