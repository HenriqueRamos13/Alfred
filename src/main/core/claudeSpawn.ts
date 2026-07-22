/**
 * Shared launcher for the Claude Code CLI (`claude`), used by BOTH the
 * delegation tool (tools/delegate.ts) and the claude-code brain (orchestrator.ts).
 *
 * Two things this fixes vs a plain execFile/spawn, both of which made `claude -p`
 * fail with "Claude AI connectors are disabled … redirect stdin explicitly to
 * < /dev/null":
 *   1. STDIN is IGNORED (`stdio: ['ignore', …]`) so the child sees EOF at once —
 *      equivalent to `claude … < /dev/null`. A non-TTY stdin left open makes the
 *      CLI wait for input and time out/fail.
 *   2. The environment drops the API-key vars (ANTHROPIC_API_KEY,
 *      ANTHROPIC_AUTH_TOKEN, ANTHROPIC_AWS_API_KEY, ANTHROPIC_FOUNDRY_API_KEY).
 *      Their presence forces the CLI into API-key mode, which disables the org
 *      connectors. The user authenticates by SUBSCRIPTION (CLI login), so we hand
 *      the child an env without those and let it use that auth. ANTHROPIC_BASE_URL
 *      and ANTHROPIC_MODEL are kept — they don't affect connectors.
 *
 * Preserves the previous behaviour: 30-min timeout (SIGKILL), a 16 MB stdout cap,
 * and ENOENT surfaced as a flag so callers can print a clear "binary missing" error.
 */
import { spawn } from 'node:child_process';
import { mcpCliArgs } from './mcpConfig.ts';

const TIMEOUT_MS = 30 * 60_000;
const MAX_STDOUT = 16 * 1024 * 1024;

export interface ClaudeCliResult {
  stdout: string;
  stderr: string;
  code: number;
  enoent: boolean;
}

/** Copy of process.env with the vars that force API-key mode removed. */
function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_AWS_API_KEY;
  delete env.ANTHROPIC_FOUNDRY_API_KEY;
  return env;
}

export function spawnClaudeCli(args: string[], opts: { cwd: string }): Promise<ClaudeCliResult> {
  return new Promise((resolve) => {
    // Attach the in-process Alfred MCP bridge (both spawn paths — the claude-code
    // brain and the delegate tool — route through here, so both gain Alfred's
    // tools). Empty when no bridge is live or ALFRED_MCP_BRIDGE disabled it.
    const child = spawn('claude', [...args, ...mcpCliArgs(process.env)], {
      cwd: opts.cwd,
      env: subscriptionEnv(),
      stdio: ['ignore', 'pipe', 'pipe'], // stdin=EOF immediately (== < /dev/null)
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;

    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes <= MAX_STDOUT) stdout += d.toString();
      else child.kill('SIGKILL'); // runaway output — kill; close reports failure
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ stdout, stderr, code: 1, enoent: err.code === 'ENOENT' });
    });
    // code null ⇒ killed by a signal (timeout / maxBuffer) ⇒ treat as failure.
    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code == null ? 1 : code, enoent: false });
    });
  });
}
