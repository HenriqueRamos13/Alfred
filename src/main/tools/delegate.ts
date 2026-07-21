/**
 * delegate_to_claude_code — hand an autonomous task to the Claude Code CLI
 * (`claude -p`, headless) running as a child process. This is Alfred's
 * delegation brain: it spawns a full agent to grind a task to completion and
 * returns its parsed JSON result.
 *
 * Risk T2 (delegates autonomous execution) → the orchestrator gates it behind a
 * human approval before execute() runs. If the `claude` binary isn't on PATH we
 * return a clear error instead of crashing.
 */
import path from 'node:path';
import { spawnClaudeCli } from '../core/claudeSpawn.ts';
import type { Tool } from './types.ts';

interface Args {
  task: string;
  cwd?: string;
}

interface ClaudeJson {
  result?: string;
  [key: string]: unknown;
}

export const delegate: Tool<Args> = {
  name: 'delegate_to_claude_code',
  description:
    'Delegate an autonomous coding/ops task to the Claude Code CLI (`claude -p`, headless). ' +
    'Spawns a full agent that works the task to completion and returns its result. ' +
    'Use for self-contained sub-tasks (refactors, scaffolding, multi-file edits). ' +
    'Requires the Claude Code CLI on PATH (npm i -g @anthropic-ai/claude-code). Requires approval.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task/prompt to hand to the delegated agent.' },
      cwd: { type: 'string', description: 'Working directory (defaults to the workspace; kept inside it).' },
    },
    required: ['task'],
  },

  // Delegating autonomous execution is always a T2 verify-first action.
  risk: () => 'T2',

  async execute(a, ctx) {
    if (!a.task || !a.task.trim()) return { ok: false, error: 'task is required' };

    // Keep cwd inside the workspace (defence in depth; relative paths resolve there).
    const cwd = a.cwd ? (path.isAbsolute(a.cwd) ? a.cwd : path.resolve(ctx.workspace, a.cwd)) : ctx.workspace;
    if (!cwd.startsWith(ctx.workspace)) {
      return { ok: false, error: `cwd must be inside the workspace (${ctx.workspace})` };
    }

    const out = await spawnClaudeCli(
      ['-p', a.task, '--output-format', 'json', '--permission-mode', 'acceptEdits'],
      { cwd },
    );
    if (out.enoent) {
      return {
        ok: false,
        error: 'Claude Code CLI not found on PATH. Install it: npm i -g @anthropic-ai/claude-code',
      };
    }
    if (out.code !== 0) {
      return { ok: false, error: `claude -p exited ${out.code}: ${out.stderr.trim() || out.stdout.trim()}` };
    }

    // --output-format json prints a single JSON object; fall back to raw text.
    let parsed: ClaudeJson | null = null;
    try {
      parsed = JSON.parse(out.stdout) as ClaudeJson;
    } catch {
      /* not JSON — return raw below */
    }
    return { ok: true, result: parsed ?? { result: out.stdout.trim() } };
  },
};
