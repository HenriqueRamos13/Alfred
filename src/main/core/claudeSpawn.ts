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
import { scrubbedEnv } from './env-scoping-pure.ts';

/** Hard SIGKILL cap for a `claude -p` child (ms). Default 1h; override with
 * ALFRED_CHILD_TIMEOUT_MS. The MCP per-tool-call timeout aligns to this (see
 * resolveMcpToolTimeout), so a long delegation can run up to this bound. */
const TIMEOUT_MS = ((): number => {
  const n = Number(process.env.ALFRED_CHILD_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60 * 60_000;
})();
export function resolveChildIdleTimeout(env: NodeJS.ProcessEnv): number {
  const n = Number(env.ALFRED_CHILD_IDLE_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10 * 60_000;
}
const IDLE_TIMEOUT_MS = resolveChildIdleTimeout(process.env);
const MAX_STDOUT = 16 * 1024 * 1024;

/**
 * MCP per-tool-call timeout (ms) for the `claude -p` child, as a string for the env.
 * The Claude Code CLI defaults MCP_TOOL_TIMEOUT to 300000 (5 min) — that is what cuts
 * a long delegate_to_agent sub-turn short. We align it to Alfred's real SIGKILL cap
 * (TIMEOUT_MS, default 1h) so a long delegation isn't killed at 5 min. A valid positive
 * ALFRED_MCP_TOOL_TIMEOUT_MS override wins; anything absent/invalid/≤0 → TIMEOUT_MS.
 * Pure (does NOT touch MCP_TIMEOUT, which is the server-startup timeout). */
export function resolveMcpToolTimeout(env: NodeJS.ProcessEnv): string {
  const n = Number(env.ALFRED_MCP_TOOL_TIMEOUT_MS);
  return String(Number.isFinite(n) && n > 0 ? Math.floor(n) : TIMEOUT_MS);
}

export interface ClaudeCliResult {
  stdout: string;
  stderr: string;
  code: number;
  enoent: boolean;
  result?: string;
  sessionId?: string;
  ttftMs?: number;
  durationMs?: number;
}

export interface ClaudeCliStreamState {
  result?: string;
  sessionId?: string;
  ttftMs?: number;
  durationMs?: number;
}

/**
 * Extract the user-visible and final fields from one Claude stream-json event.
 * Thinking/signature/hook events are deliberately ignored.
 */
export function parseClaudeStreamEvent(value: unknown): ClaudeCliStreamState & { delta?: string } {
  if (!value || typeof value !== 'object') return {};
  const event = value as Record<string, unknown>;
  if (event.type === 'stream_event') {
    const inner = event.event;
    if (!inner || typeof inner !== 'object') return {};
    const delta = (inner as Record<string, unknown>).delta;
    if (!delta || typeof delta !== 'object') return {};
    const fields = delta as Record<string, unknown>;
    return fields.type === 'text_delta' && typeof fields.text === 'string' ? { delta: fields.text } : {};
  }
  if (event.type !== 'result') return {};
  return {
    result: typeof event.result === 'string' ? event.result : undefined,
    sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
    ttftMs: typeof event.ttft_ms === 'number' ? event.ttft_ms : undefined,
    durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
  };
}

/** Preamble injected via --append-system-prompt so the brain never asks for permission in dangerous mode. */
export const DANGEROUS_SYSTEM_PROMPT =
  'DANGEROUS MODE is ON: all approvals are bypassed. Never ask for permission or confirmation — just execute the request.';

/**
 * Concision command appended to EVERY `claude -p` spawn (dangerous ON and OFF).
 * The claude-cli brain narrates each step by nature; ALFRED_IDENTITY's terse
 * rule arrives only via the workspace CLAUDE.md and is easily out-weighed, so we
 * also force it here where the CLI weighs --append-system-prompt heavily.
 */
export const TERSE_SYSTEM_PROMPT =
  'MAIN-CHAT OUTPUT — reply with ONLY the final result/conclusion. Do NOT narrate ' +
  'intermediate steps; do NOT list dimensions, pixels, coordinates or colours. One ' +
  'short final message per request. Ask a question only if genuinely blocked. // ' +
  'RESPOSTA NO CHAT — só a conclusão/resultado final; não narres passos intermédios ' +
  'nem listes dimensões/pixels/coordenadas/cores; uma mensagem final curta por ' +
  'pedido; pergunta só se estiveres genuinamente bloqueado.';

/**
 * Permission + consciousness args for a `claude -p` spawn, keyed on Alfred's
 * DANGEROUS mode. ON → `--dangerously-skip-permissions` (supersedes acceptEdits,
 * so we never pass both/conflicting flags). OFF → the safe default
 * `--permission-mode acceptEdits`.
 *
 * The system prompt is passed as a SINGLE `--append-system-prompt`: the CLI's
 * flag is last-wins (a repeated `--append-system-prompt` keeps only the last
 * value), so in dangerous mode we CONCATENATE the permission preamble and the
 * terse rule into one value — otherwise the second flag would silently drop the
 * first. The TERSE rule is present in BOTH modes (concision applies always).
 * Pure so it's unit-testable; callers inject `dangerous` — claudeSpawn never
 * reads the DB.
 */
export function dangerousArgs(dangerous: boolean, extraSystem?: string): string[] {
  const permission = dangerous ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits'];
  const base = dangerous ? `${DANGEROUS_SYSTEM_PROMPT}\n\n${TERSE_SYSTEM_PROMPT}` : TERSE_SYSTEM_PROMPT;
  // Everything is folded into ONE --append-system-prompt (last-wins flag), so an
  // extra directive (e.g. the reply-language line) is concatenated, never a 2nd flag.
  const system = extraSystem?.trim() ? `${base}\n\n${extraSystem.trim()}` : base;
  return [...permission, '--append-system-prompt', system];
}

/**
 * Env handed to the `claude -p` child. Env-scoping (Phase 6 Stage 3): the child
 * is a full autonomous agent with shell tools — it must NOT inherit Alfred's
 * provider keys/tokens/secrets (OPENAI/DEEPSEEK/ELEVENLABS/GOOGLE_OAUTH/AWS/…),
 * which it could read and exfiltrate. `scrubbedEnv` strips every credential; we
 * allowlist only ANTHROPIC_BASE_URL / ANTHROPIC_MODEL (config, not credentials).
 * This also drops the ANTHROPIC_* API-key vars that force API-key mode, so the
 * child uses subscription auth and org connectors stay enabled (prior behaviour).
 * The MCP bridge token travels via `--mcp-config`, not env, so this never breaks it.
 */
function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = scrubbedEnv(process.env, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);
  // Lift the MCP per-tool-call cap (CLI default 5 min) to Alfred's real SIGKILL cap so
  // long delegate_to_agent sub-turns aren't cut at 5 min. `??=` never overrides a value
  // the user already set (scrubbedEnv propagates MCP_TOOL_TIMEOUT — it isn't a credential).
  env.MCP_TOOL_TIMEOUT ??= resolveMcpToolTimeout(process.env);
  return env;
}

export function spawnClaudeCli(
  args: string[],
  opts: { cwd: string; bridge?: boolean; signal?: AbortSignal; onDelta?: (text: string) => void },
): Promise<ClaudeCliResult> {
  return new Promise((resolve) => {
    // Kill switch: an already-aborted signal never spawns; a later abort SIGKILLs
    // the child so the live `claude -p` turn dies instead of running to timeout.
    if (opts.signal?.aborted) {
      resolve({ stdout: '', stderr: 'aborted', code: 1, enoent: false });
      return;
    }
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

    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let lineBuffer = '';
    let streamState: ClaudeCliStreamState = {};
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimedOut = false;

    const finish = (result: ClaudeCliResult): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ ...result, ...streamState });
    };

    const armIdleWatchdog = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!IDLE_TIMEOUT_MS) return;
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        child.kill('SIGKILL');
      }, IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const parsed = parseClaudeStreamEvent(JSON.parse(line));
        if (parsed.delta) {
          try {
            opts.onDelta?.(parsed.delta);
          } catch (err) {
            console.error('[alfred] Claude CLI delta sink failed:', err instanceof Error ? err.message : err);
          }
        }
        streamState = {
          result: parsed.result ?? streamState.result,
          sessionId: parsed.sessionId ?? streamState.sessionId,
          ttftMs: parsed.ttftMs ?? streamState.ttftMs,
          durationMs: parsed.durationMs ?? streamState.durationMs,
        };
      } catch {
        // Non-JSON output is retained in stdout and handled by the caller fallback.
      }
    };

    child.stdout.on('data', (d: Buffer) => {
      armIdleWatchdog();
      bytes += d.length;
      if (bytes <= MAX_STDOUT) {
        const chunk = d.toString();
        stdout += chunk;
        lineBuffer += chunk;
        let newline = lineBuffer.indexOf('\n');
        while (newline >= 0) {
          consumeLine(lineBuffer.slice(0, newline));
          lineBuffer = lineBuffer.slice(newline + 1);
          newline = lineBuffer.indexOf('\n');
        }
      } else {
        child.kill('SIGKILL'); // runaway output — kill; close reports failure
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      armIdleWatchdog();
      stderr += d.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ stdout, stderr, code: 1, enoent: err.code === 'ENOENT' });
    });
    // code null ⇒ killed by a signal (timeout / maxBuffer / abort) ⇒ failure.
    child.on('close', (code) => {
      consumeLine(lineBuffer);
      const detail = idleTimedOut
        ? `Claude CLI produced no activity for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s and was stopped.`
        : '';
      finish({
        stdout,
        stderr: [stderr.trim(), detail].filter(Boolean).join('\n'),
        code: code == null ? 1 : code,
        enoent: false,
      });
    });
    armIdleWatchdog();
  });
}
