/**
 * delegate_to_agent — run ONE turn of a named roster agent (Phase 5, stage 2).
 *
 * The agent runs with ITS model + ITS assembled context (role + the shared
 * who-knows-what index + its OWN private notes) and is bounded by ITS grant.
 *
 * Two execution paths, keyed on the agent's provider:
 *   - API brains (claude-api / openai / deepseek) → an in-process AI-SDK turn
 *     (streamText + tools). In-process means EVERY tool call is interceptable:
 *     the grant is enforced in CODE (out-of-grant calls are refused to the model)
 *     and in-grant calls run through the SHARED governed executor, so a sensitive
 *     action queues for the human's approval exactly like a normal Alfred turn.
 *   - claude-cli → spawn `claude -p --model` with the context in the prompt
 *     (reuses claudeSpawn); the child reaches Alfred's governed tools via the MCP
 *     bridge, so sensitive actions still hit normal governance.
 *
 * ATTENDED: a human (the user / Alfred) fired this, so sensitive actions take the
 * NORMAL approval path — never the unattended fail-closed queue. The whole tool
 * is T2 (delegating autonomous execution), gated once before it runs.
 *
 * Token spend counts against the GLOBAL daily kill-switch (BudgetTracker). The
 * per-agent daily budget lands in stage 4.
 */
import { randomUUID } from 'node:crypto';
import { streamText, tool, jsonSchema, stepCountIs } from 'ai';
import type { ToolSet } from 'ai';
import { getAgent, loadAgentContext } from '../core/team.ts';
import {
  resolveTeamModel,
  agentBudgetDecision,
  blockedToolsForRole,
  restrictGrantForRole,
  canSpawn,
  DEFAULT_MAX_SPAWN_DEPTH,
  DEFAULT_MAX_CONCURRENT_CHILDREN,
  type DelegationRole,
  type SpawnLimits,
} from '../core/team-pure.ts';
import {
  grantAllows,
  jobActionDecision,
  escalateForTrifecta,
  updateCircuit,
  circuitBreakerTrip,
  isToolFailure,
  INITIAL_CIRCUIT_STATE,
  DEFAULT_CIRCUIT_THRESHOLDS,
  type JobRunState,
  type CircuitState,
} from '../core/jobs-pure.ts';
import { resolveProvider } from '../core/providers.ts';
import { agentToSpec, modelSupportsVision, buildToolModelOutput } from '../core/modelCatalog.ts';
import { runGovernedTool, classifyAction, maskSecrets, trifectaImpact } from '../core/governance.ts';
import { BudgetTracker, isOverDailyBudget, agentTokensToday, dayKey, callSignature } from '../core/budget.ts';
import { spawnClaudeCli, dangerousArgs } from '../core/claudeSpawn.ts';
import type { Capability, Governance, Tool, ToolCtx } from '../core/types.ts';

interface Args {
  agentId: string;
  task: string;
  model?: string;
}

/**
 * Per-parent active-children counter (concurrency ceiling, Phase 6 stage 2).
 * Process-wide and in-process — a delegate_to_agent call runs its child inline,
 * so this bounds how many children one parent has in flight at once.
 * ponytail: in-process Map — a multi-process fan-out would need a shared store;
 * there is exactly one orchestrator process, so a Map is the right ceiling.
 */
const activeByParent = new Map<string, number>();
function activeChildren(parentKey: string): number {
  return activeByParent.get(parentKey) ?? 0;
}
function enterChild(parentKey: string): void {
  activeByParent.set(parentKey, activeChildren(parentKey) + 1);
}
function exitChild(parentKey: string): void {
  const n = activeChildren(parentKey) - 1;
  if (n <= 0) activeByParent.delete(parentKey);
  else activeByParent.set(parentKey, n);
}

/** Spawn limits from env (defaults 2 / 3). */
function spawnLimits(): SpawnLimits {
  return {
    maxSpawnDepth: Number(process.env.ALFRED_MAX_SPAWN_DEPTH) || DEFAULT_MAX_SPAWN_DEPTH,
    maxConcurrentChildren: Number(process.env.ALFRED_MAX_CONCURRENT_CHILDREN) || DEFAULT_MAX_CONCURRENT_CHILDREN,
  };
}

/** Kill-switch (Phase 6 stage 2): is NEW spawn/fan-out paused? (setting spawn_paused='1'). */
function spawnPaused(db: ToolCtx['db']): boolean {
  return (db.prepare("SELECT value FROM settings WHERE key = 'spawn_paused'").get() as { value?: string } | undefined)?.value === '1';
}

/** DANGEROUS-mode read (inline, so this file stays strip-types-testable). */
function isDangerous(db: ToolCtx['db']): boolean {
  return (db.prepare("SELECT value FROM settings WHERE key = 'dangerous_mode'").get() as { value?: string } | undefined)?.value === '1';
}

/** Budget config for the global kill-switch, read from env (mirrors loadConfig). */
function budgetCfg(): { dailyLimit: number; stepCap: number; dailyUsdBudget?: number } {
  return {
    dailyLimit: Number(process.env.ALFRED_DAILY_TOKEN_BUDGET) || 2_000_000,
    stepCap: Number(process.env.ALFRED_STEP_CAP) || 40,
    dailyUsdBudget: process.env.ALFRED_DAILY_USD_BUDGET ? Number(process.env.ALFRED_DAILY_USD_BUDGET) || undefined : undefined,
  };
}

export const delegateToAgent: Tool<Args> = {
  name: 'delegate_to_agent',
  description:
    'Delegate a task to a named roster agent (see the team tool). Runs ONE turn on that agent\'s OWN model with its ' +
    'private knowledge as context, bounded by its grant (capabilities outside the grant are refused). Sensitive actions ' +
    'still go through normal approval (a human is present). {agentId, task, model?} — model optionally overrides the ' +
    'agent\'s model (must be in that agent\'s provider catalog, else the agent\'s model is used). Returns the agent\'s result. ' +
    'Token spend counts against the agent\'s per-agent daily budget (if set) AND the global daily kill-switch; an exhausted ' +
    'per-agent budget returns a clear error. Requires approval (T2).',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'The roster agent id to run (from the team tool op=list).' },
      task: { type: 'string', description: 'The task/prompt to hand to the agent.' },
      model: {
        type: 'string',
        description: 'Optional model override — must be in the agent\'s provider catalog, else the agent\'s configured model is used.',
      },
    },
    required: ['agentId', 'task'],
  },

  // Delegating autonomous execution is always a T2 verify-first action.
  risk: () => 'T2',

  async execute(a, ctx) {
    if (!a.task || !a.task.trim()) return { ok: false, error: 'task is required' };
    if (!a.agentId) return { ok: false, error: 'agentId is required' };

    const agent = getAgent(ctx.db, a.agentId);
    if (!agent) return { ok: false, error: `no roster agent with id "${a.agentId}" (create one with the team tool, or op=list to see them)` };

    // Spawn bounds + kill-switch (Phase 6 stage 2). `depth` is the CURRENT runner's
    // depth (0 = top-level, attended Alfred). The child runs at depth+1. Refuse —
    // EXPLICITLY, never silently — when paused, too deep, or over the concurrent
    // children ceiling. Applies to top-level and nested delegations alike.
    const depth = ctx.delegationDepth ?? 0;
    const parentKey = ctx.sessionId;
    const decision = canSpawn(depth, activeChildren(parentKey), spawnLimits(), spawnPaused(ctx.db));
    if (!decision.ok) {
      ctx.emit({ kind: 'tool.start', sessionId: ctx.sessionId, toolName: 'delegate_to_agent', args: maskSecrets({ agentId: a.agentId }), tier: 'T2' });
      ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: 'delegate_to_agent', status: 'blocked', error: decision.reason });
      return { ok: false, error: decision.reason };
    }
    // Reserve the slot SYNCHRONOUSLY, right after the check — before any `await`.
    // Otherwise parallel delegate_to_agent tool calls in one model step all read
    // activeChildren=0, all pass canSpawn, then all enterChild → the concurrency
    // ceiling is bypassed (TOCTOU). Reserving here serialises them correctly.
    enterChild(parentKey);
    try {
      const model = resolveTeamModel(a.model, agent);
      const context = await loadAgentContext(ctx.workspace, agent);

      // A NESTED spawn (this call itself runs inside a delegated child, depth ≥ 1)
      // is UNATTENDED — no human watches a fan-out — so the child runs FAIL-CLOSED
      // (sensitive actions denied/parked, never auto-run, never inheriting the
      // parent's interactive approval). A TOP-LEVEL delegate (Alfred, depth 0)
      // stays ATTENDED (the normal approval path).
      const nested = depth >= 1;
      if (agent.provider === 'claude-cli') return await runClaudeCli(ctx, context, a.task.trim(), model);
      return await runAgentTurn(ctx, {
        agentId: agent.id,
        provider: agent.provider,
        model,
        grant: agent.grant,
        delegationRole: agent.delegationRole,
        canMessageUser: agent.canMessageUser ?? false,
        delegationDepth: depth + 1,
        dailyTokenBudget: agent.dailyTokenBudget,
        system: context,
        task: a.task.trim(),
        unattended: nested ? { dangerous: isDangerous(ctx.db), queue: () => {} } : undefined,
      });
    } finally {
      exitChild(parentKey);
    }
  },
};

/** Result of one in-process agent turn (API brains). */
export interface AgentTurnResult {
  ok: boolean;
  result?: { model: string; text: string };
  error?: string;
  /** The per-agent daily budget is spent — the caller pauses a scheduled study / reports it attended. */
  budgetExhausted?: boolean;
  /** Tokens this turn spent (0 when unavailable, e.g. aborted). */
  tokens?: number;
}

export interface AgentTurnSpec {
  agentId: string;
  provider: Parameters<typeof agentToSpec>[0]['provider'];
  model: string;
  grant: Capability[];
  /** PRIVILEGE role — bounds the model-visible toolset + the effective grant. Default 'leaf'. */
  delegationRole?: DelegationRole;
  /** Inbox power: may this agent message the user directly? Threaded to ctx.caller for the inbox gate. */
  canMessageUser?: boolean;
  /** This runner's delegation depth (child of a delegate call). Threaded to its own sub-tools. Default 0. */
  delegationDepth?: number;
  dailyTokenBudget?: number;
  system: string;
  task: string;
  /**
   * UNATTENDED governance (scheduled study): sensitive actions never auto-run —
   * jobActionDecision + per-run trifecta escalation gate every tool call. A
   * queued (sensitive) action is handed to `queue` and refused to the model;
   * execute-time sensitive sub-ops are DENIED (fail-closed). Absent → ATTENDED
   * (a human is present; sensitive actions take the normal approval path).
   */
  unattended?: { dangerous: boolean; queue: (toolName: string, args: unknown) => void };
  /** Per-run hard-interrupt (scheduler) — aborts the turn when it fires. */
  signal?: AbortSignal;
}

/**
 * claude-cli path: spawn `claude -p --model` with the assembled context prepended
 * to the task prompt. The child reaches Alfred's governed tools via the MCP bridge
 * (attended governance applies to sensitive actions).
 * ponytail: on this path the grant is stated in the context prompt (advisory) —
 * only the in-process API path enforces it in code; the enforceable ceiling is the
 * normal sensitive-action approval, which applies to both. Upgrade path: map the
 * grant to `claude`'s --disallowedTools (as the reference agent does for read-only).
 */
async function runClaudeCli(ctx: ToolCtx, context: string, task: string, model: string) {
  const dangerous =
    (ctx.db.prepare("SELECT value FROM settings WHERE key = 'dangerous_mode'").get() as { value?: string } | undefined)?.value === '1';
  const prompt = `${context}\n\n# Task\n${task}`;
  const out = await spawnClaudeCli(
    ['-p', prompt, '--output-format', 'json', '--model', model, ...dangerousArgs(dangerous)],
    { cwd: ctx.workspace },
  );
  if (out.enoent) return { ok: false, error: 'Claude Code CLI not found on PATH. Install it: npm i -g @anthropic-ai/claude-code' };
  if (out.code !== 0) return { ok: false, error: `claude -p exited ${out.code}: ${(out.stderr || out.stdout).trim()}` };
  let text = out.stdout.trim();
  try {
    text = (JSON.parse(out.stdout) as { result?: string }).result ?? text;
  } catch {
    /* not JSON — use raw stdout */
  }
  return { ok: true, result: { model, text } };
}

/**
 * API path (claude-api / openai / deepseek): one in-process AI-SDK turn whose
 * every tool call is gated. Shared by delegate_to_agent (ATTENDED) and scheduled
 * study (UNATTENDED, via `spec.unattended`):
 *   - out-of-grant → refused to the model.
 *   - in-grant, ATTENDED → run through the shared governed executor (normal
 *     approvals for sensitive actions — a human is present).
 *   - in-grant, UNATTENDED → jobActionDecision + trifecta escalation: sensitive
 *     queues (handed to `queue`) or is denied; benign in-grant runs fail-closed.
 * Bounded by the GLOBAL kill-switch AND the per-agent daily budget (both checked
 * before the turn). Never throws; a failed run surfaces as { ok:false }.
 */
export async function runAgentTurn(ctx: ToolCtx, spec: AgentTurnSpec): Promise<AgentTurnResult> {
  const { agentId, provider, model, grant, system, task, unattended } = spec;
  const delegationRole: DelegationRole = spec.delegationRole ?? 'leaf';
  const delegationDepth = spec.delegationDepth ?? 0;
  // Role-floored effective grant: a leaf may never message the user (notify/send
  // stripped), regardless of how its grant was configured.
  const effGrant = restrictGrantForRole(delegationRole, grant);
  let resolved: ReturnType<typeof resolveProvider>;
  try {
    resolved = resolveProvider(agentToSpec({ name: agentId, provider, model }), process.env);
  } catch (err) {
    return { ok: false, error: `agent brain not connected: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Global daily kill-switch (shared across sessions via the day-keyed budget row).
  const cfg = budgetCfg();
  const tracker = new BudgetTracker(ctx.db, cfg, `agent:${agentId}`);
  if (isOverDailyBudget(tracker.snapshot())) {
    return { ok: false, error: 'daily token budget exhausted — try again tomorrow' };
  }
  // Per-agent daily budget (Phase 5 stage 4): the agent's own day-keyed spend
  // (usage_by_model, session agent:<id>) capped by its dailyTokenBudget. Checked
  // BEFORE the turn so an exhausted agent never starts one.
  const day = dayKey();
  const agentBudget = agentBudgetDecision({ dailyTokenBudget: spec.dailyTokenBudget }, Date.now(), 1, {
    tokens: agentTokensToday(ctx.db, agentId, day),
    day,
  });
  if (!agentBudget.allowed) {
    return { ok: false, budgetExhausted: true, error: `orçamento diário do agente ${agentId} esgotado — tenta amanhã` };
  }
  const stepCap = cfg.stepCap;

  // Fail-closed governance for the UNATTENDED path: no human to approve, so an
  // execute-time sensitive sub-op is DENIED (mirrors the JobScheduler's job ctx).
  const runState: JobRunState = { readUntrusted: false };
  // Sub-tool execution ctx carries this runner's OWN depth, so a nested
  // delegate_to_agent (orchestrator only) spawns its child at depth+1. It also
  // carries the caller identity so the inbox tool can gate on canMessageUserResolved.
  const baseCtx: ToolCtx = {
    ...ctx,
    delegationDepth,
    caller: { agentId, delegationRole, canMessageUser: spec.canMessageUser ?? false },
  };
  const unattendedCtx: ToolCtx = unattended
    ? {
        ...baseCtx,
        governance: {
          classify: classifyAction,
          requestApproval: async () => ({ id: randomUUID(), decision: 'deny', note: 'unattended child — no human to approve' }),
          markTrifecta: () => {},
          trifecta: () => ({ readUntrusted: false, hasPrivate: false, canEgress: false }),
        } satisfies Governance,
      }
    : baseCtx;

  const { tools: allTools } = (await import('./index.ts')) as { tools: Tool[] };
  // Role blocklist (Phase 6 stage 2): strip the tools this privilege role may
  // never use BEFORE the model sees them — spawn/scheduling/roster/shared-vault
  // for a leaf; the same minus delegate_to_agent for an orchestrator (it may
  // spawn a bounded child). This subsumes the old no-self-recursion filter.
  const blocked = new Set(blockedToolsForRole(delegationRole));
  const subTools = allTools.filter((t) => !blocked.has(t.name));
  const brainHasVision = modelSupportsVision(provider, model);

  const controller = new AbortController();
  // Per-run hard-interrupt from the scheduler: abort the turn when it fires.
  if (spec.signal) {
    if (spec.signal.aborted) controller.abort();
    else spec.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  // Tool-loop circuit breaker: a scheduled/unattended run HARD-STOPS on repeated
  // failure / no-progress so it can't burn the budget looping; an attended
  // delegate soft-warns (the human sees it). State threaded across tool calls.
  let circuit: CircuitState = INITIAL_CIRCUIT_STATE;
  let circuitWarned = false;
  const set: ToolSet = {};
  for (const t of subTools) {
    const runOne = async (args: unknown): Promise<unknown> => {
        // `inbox` has its OWN dedicated authority — canMessageUserResolved via
        // ctx.caller (orchestrator, or a leaf with can_message_user), finer than the
        // coarse capability grant. Messaging the user to bring a human in is SAFE (it
        // never acts autonomously — it surfaces to the owner), so it bypasses the
        // grant/role capability test in BOTH paths and self-gates inside the tool.
        // Without this, the default read+notify grant (inbox → 'write') would refuse
        // it before the real gate ran — e.g. the flagged-leaf case the Org UI shows.
        if (t.name === 'inbox') {
          return runGovernedTool(t, args, unattended ? unattendedCtx : baseCtx);
        }
        if (unattended) {
          // UNATTENDED: sensitive → queue/deny (pierces dangerous), in-grant benign → allow.
          let decision = jobActionDecision({ grant: effGrant, dangerous: unattended.dangerous, unattended: true }, t.name, args);
          decision = escalateForTrifecta(decision, runState, t.name, args);
          if (decision === 'deny') {
            ctx.emit({ kind: 'tool.start', sessionId: ctx.sessionId, toolName: t.name, args: maskSecrets(args), tier: classifyAction(t.name, args) });
            ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status: 'blocked', error: 'out of grant (unattended)' });
            return { ok: false, error: `não permitido nesta corrida não-supervisionada: ${t.name}` };
          }
          if (decision === 'queue-approval') {
            unattended.queue(t.name, args);
            ctx.emit({ kind: 'tool.start', sessionId: ctx.sessionId, toolName: t.name, args: maskSecrets(args), tier: classifyAction(t.name, args) });
            ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status: 'blocked', error: 'queued for approval' });
            return { ok: false, error: 'ação sensível colocada em fila para a tua aprovação' };
          }
          const out = await runGovernedTool(t, args, unattendedCtx);
          if (trifectaImpact(t.name).readUntrusted) runState.readUntrusted = true;
          return out;
        }
        // ATTENDED: a capability outside the agent's grant is refused to the model —
        // NOT auto-allowed by dangerous mode (dangerous bypasses approvals, not the grant).
        if (!grantAllows(effGrant, t.name, args)) {
          ctx.emit({ kind: 'tool.start', sessionId: ctx.sessionId, toolName: t.name, args: maskSecrets(args), tier: classifyAction(t.name, args) });
          ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status: 'blocked', error: 'out of agent grant' });
          return { ok: false, error: `not permitted by ${agentId}'s grant/role: ${t.name}` };
        }
        return runGovernedTool(t, args, baseCtx);
    };
    set[t.name] = tool({
      description: t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: jsonSchema(t.inputSchema as any),
      execute: async (args: unknown) => {
        const out = await runOne(args);
        const failed = isToolFailure(out);
        circuit = updateCircuit(circuit, { toolName: t.name, sig: callSignature(t.name, args), failed, progressed: !failed });
        const trip = circuitBreakerTrip(circuit.counters, DEFAULT_CIRCUIT_THRESHOLDS, !!unattended);
        if (trip.stop) {
          ctx.emit({ kind: 'error', sessionId: ctx.sessionId, message: `circuit breaker: ${trip.reason} — corrida autónoma interrompida (${agentId})` });
          controller.abort();
        } else if (trip.warn && !circuitWarned) {
          circuitWarned = true;
          ctx.emit({ kind: 'error', sessionId: ctx.sessionId, message: `circuit breaker (aviso): ${trip.reason} — possível loop de ferramentas (${agentId})` });
        }
        return out;
      },
      toModelOutput: ({ output }) => buildToolModelOutput(output, brainHasVision),
    });
  }

  try {
    const result = streamText({
      model: resolved.languageModel,
      system,
      prompt: task,
      maxOutputTokens: 4096,
      tools: set,
      stopWhen: stepCountIs(stepCap),
      abortSignal: controller.signal,
      prepareStep: () => {
        if (isOverDailyBudget(tracker.snapshot())) controller.abort();
        return {};
      },
      onStepFinish: ({ usage }) => {
        try {
          tracker.record({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 }, resolved.model);
        } catch (err) {
          console.error('[alfred] delegate_to_agent step accounting failed:', err instanceof Error ? err.message : err);
        }
      },
    });

    let text = '';
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') text += part.text;
      else if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
    let tokens = 0;
    try {
      const u = await result.usage;
      tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    } catch {
      /* usage unavailable (e.g. aborted) — leave 0 */
    }
    return { ok: true, result: { model, text: text.trim() }, tokens };
  } catch (err) {
    return { ok: false, error: `delegate_to_agent run failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
