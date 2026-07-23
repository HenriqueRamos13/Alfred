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

/** Preamble injected via --append-system-prompt so the brain never asks for permission in dangerous mode. */
export const DANGEROUS_SYSTEM_PROMPT =
  'DANGEROUS MODE is ON: all approvals are bypassed. Never ask for permission or confirmation — just execute the request.';

/**
 * Permission + consciousness args for a `claude -p` spawn, keyed on Alfred's
 * DANGEROUS mode. ON → `--dangerously-skip-permissions` (supersedes acceptEdits,
 * so we never pass both/conflicting flags) plus a system-prompt preamble so the
 * brain itself never asks. OFF → the safe default `--permission-mode acceptEdits`.
 * Pure so it's unit-testable; callers inject `dangerous` — claudeSpawn never
 * reads the DB.
 */
export function dangerousArgs(dangerous: boolean): string[] {
  return dangerous
    ? ['--dangerously-skip-permissions', '--append-system-prompt', DANGEROUS_SYSTEM_PROMPT]
    : ['--permission-mode', 'acceptEdits'];
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

export function spawnClaudeCli(args: string[], opts: { cwd: string; bridge?: boolean }): Promise<ClaudeCliResult> {
  return new Promise((resolve) => {
    // Attach the in-process Alfred MCP bridge (both spawn paths — the claude-code
    // brain and the delegate tool — route through here, so both gain Alfred's
    // tools). Empty when no bridge is live or ALFRED_MCP_BRIDGE disabled it.
    // The reference agent opts OUT (bridge:false): it is read-only and must not
    // reach Alfred's governed tools.
    const bridgeArgs = opts.bridge === false ? [] : mcpCliArgs(process.env);
    const child = spawn('claude', [...args, ...bridgeArgs], {
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
