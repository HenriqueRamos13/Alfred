import { execFile } from 'node:child_process';
import path from 'node:path';
import { scrubbedEnv } from '../core/env-scoping-pure.ts';
import type { Tool } from './types.ts';

/**
 * Keys a shell command may legitimately need, kept despite matching the
 * sensitive-key patterns. Comma-separated in ALFRED_SHELL_ENV_ALLOWLIST.
 */
function shellEnvAllowlist(): string[] {
  return (process.env.ALFRED_SHELL_ENV_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Args {
  command: string;
  cwd?: string;
  timeoutMs?: number;
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
      // Env-scoping: a model-driven command must not see provider API keys / OAuth
      // secrets (exfil vector). Allowlist a key via ALFRED_SHELL_ENV_ALLOWLIST.
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL', env: scrubbedEnv(process.env, shellEnvAllowlist()) },
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
    'Shell commands require host approval in normal mode; dangerous mode executes them directly.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line to execute.' },
      cwd: { type: 'string', description: 'Working directory (defaults to the workspace).' },
      timeoutMs: { type: 'number', description: 'Kill after this many ms (default 60000).' },
    },
    required: ['command'],
  },

  // `/bin/sh -c` can hide arbitrary effects behind aliases, scripts, expansion,
  // pipes and substitutions. Static regexes cannot prove a command reversible.
  risk: () => 'T2',

  async execute(a, ctx) {
    const cwd = a.cwd ? (path.isAbsolute(a.cwd) ? a.cwd : path.resolve(ctx.workspace, a.cwd)) : ctx.workspace;
    const timeoutMs = a.timeoutMs && a.timeoutMs > 0 ? a.timeoutMs : 60_000;

    const out = await run(a.command, cwd, timeoutMs);
    if (out.timedOut) return { ok: false, error: `Timed out after ${timeoutMs}ms`, result: out };
    return {
      ok: out.code === 0,
      result: { stdout: out.stdout, stderr: out.stderr, code: out.code },
      error: out.code === 0 ? undefined : `Exit code ${out.code}`,
    };
  },
};
