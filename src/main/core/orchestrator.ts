/**
 * Orchestrator — manual tool-use loop over the Anthropic Messages API.
 *
 * Streams assistant text to the UI, runs tools through the shared ToolCtx,
 * and enforces the MVP guardrails on every step:
 *   - daily token kill-switch + per-session/day counters (BudgetTracker)
 *   - per-task step cap
 *   - identical-call loop detection
 *   - risk classification + HITL approvals (T2/T3)
 *   - trifecta-lite: block egress once untrusted-read + private data are in play
 *   - audit of every tool call (secrets masked)
 */

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HITL_TIERS } from './types.ts';
import type {
  AccountRecord,
  AlfredConfig,
  ApprovalDecision,
  AuditEntry,
  ChatMessage,
  ProjectRecord,
  RiskTier,
  StreamEvent,
  Tool,
  ToolCtx,
} from './types.ts';
import {
  BudgetTracker,
  callSignature,
  isLoop,
  isOverDailyBudget,
  isOverStepCap,
} from './budget.ts';
import {
  classifyAction,
  createGovernance,
  isEgressTool,
  maskSecrets,
  recordAudit,
  trifectaImpact,
} from './governance.ts';
import { ensureScaffold, readStable } from './memory.ts';
import { createSecrets } from './secrets.ts';
import { getProject, listProjects } from './projects.ts';
import { tools, createBrowserHandle } from '../tools/index.ts';

type AlfredDb = import('better-sqlite3').Database;

const ALFRED_IDENTITY = `You are Alfred, a personal Agent OS running natively on the user's Mac. You
operate the real machine on their behalf and render your own control-centre UI.
You are calm, precise and discreet — a trusted operator, not a chatbot. Act
autonomously within your remit; stop to ask only when governance requires an
approval or when genuinely blocked. Your name is Alfred, always — never "Jarvis".

Governance you must respect:
- Every tool call is risk-tiered. T0 (read/search/list) and T1 (reversible
  workspace writes) run freely; T2 (delete/send/install/egress) and T3
  (money/credentials) require the human's approval, which the host enforces.
- Never print, echo, or log secret values — mask them.
- Honour the token budget and step caps; if a task starts looping, stop and
  report rather than repeating.
Organise substantial work as projects under the workspace (ICM
folder-as-context); render live status into the surface with render_ui using
only the whitelisted components.`;

/** Task aborted by a guardrail (loop / step cap). Distinct from a hard budget stop. */
class TaskAbort extends Error {}
/** Daily token kill-switch tripped. */
class BudgetExceeded extends Error {}

export interface OrchestratorDeps {
  config: AlfredConfig;
  ctx: ToolCtx;
  tools: Tool[];
  /** Extra system context (active project manifest, etc.), assembled by the caller. */
  projectContext?: string;
  /** Cap on model output tokens per turn. */
  maxTokens?: number;
}

export class Orchestrator {
  private readonly client: Anthropic;
  private readonly budget: BudgetTracker;
  private readonly toolMap: Map<string, Tool>;
  private readonly maxTokens: number;
  private controller: AbortController | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.client = new Anthropic({ apiKey: deps.config.anthropicApiKey });
    this.budget = new BudgetTracker(
      deps.ctx.db,
      { dailyLimit: deps.config.dailyTokenBudget, stepCap: deps.config.stepCap },
      deps.ctx.sessionId,
    );
    this.toolMap = new Map(deps.tools.map((t) => [t.name, t]));
    this.maxTokens = deps.maxTokens ?? 4096;
  }

  /** Kill switch — abort the in-flight model call and stop the loop. */
  abort(): void {
    this.controller?.abort();
  }

  /** Run one user turn to completion (may span many model+tool round-trips). */
  async run(userText: string): Promise<void> {
    const { ctx } = this.deps;
    this.controller = new AbortController();
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userText }];
    const toolDefs: Anthropic.Tool[] = this.deps.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));
    const system = await this.buildSystem();
    const history: string[] = [];

    ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'thinking' });

    try {
      for (;;) {
        const state = this.budget.snapshot();
        if (isOverDailyBudget(state)) {
          throw new BudgetExceeded(
            `Daily token budget exhausted (${state.dailyTokens}/${state.dailyLimit}). Halting.`,
          );
        }
        if (isOverStepCap(state)) {
          throw new TaskAbort(`Step cap reached (${state.stepCap}). Halting task.`);
        }
        this.budget.step();

        ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'thinking' });
        const stream = this.client.messages.stream(
          {
            model: this.deps.config.model,
            max_tokens: this.maxTokens,
            system,
            tools: toolDefs,
            messages,
          },
          { signal: this.controller.signal },
        );
        stream.on('text', (delta) => ctx.emit({ kind: 'chat.delta', sessionId: ctx.sessionId, text: delta }));

        const msg = await stream.finalMessage();
        ctx.emit({
          kind: 'budget',
          state: this.budget.record({ inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }),
        });

        const text = msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text) ctx.emit({ kind: 'chat.message', message: this.chatMessage('assistant', text) });

        messages.push({ role: 'assistant', content: msg.content as Anthropic.ContentBlockParam[] });

        if (msg.stop_reason !== 'tool_use') {
          ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'done' });
          return;
        }

        const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) results.push(await this.runTool(tu, history));
        messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.emit({ kind: 'error', sessionId: ctx.sessionId, message });
      ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'error' });
    }
  }

  private async buildSystem(): Promise<string> {
    let sys = ALFRED_IDENTITY;
    const mem = await readStable(this.deps.ctx.workspace).catch(() => '');
    if (mem.trim()) sys += `\n\n# Stable memory (honour these)\n${mem}`;
    if (this.deps.projectContext?.trim()) sys += `\n\n# Active project\n${this.deps.projectContext}`;
    return sys;
  }

  private chatMessage(role: ChatMessage['role'], content: string): ChatMessage {
    return { id: crypto.randomUUID(), sessionId: this.deps.ctx.sessionId, role, content, ts: Date.now() };
  }

  private async runTool(
    tu: Anthropic.ToolUseBlock,
    history: string[],
  ): Promise<Anthropic.ToolResultBlockParam> {
    const { ctx } = this.deps;
    const args = tu.input;
    const tool = this.toolMap.get(tu.name);

    if (!tool) {
      return this.toolError(tu.id, `Unknown tool: ${tu.name}`);
    }

    // Loop detection — abort the whole task, don't just refuse this call.
    const sig = callSignature(tu.name, args);
    if (isLoop(history, sig)) {
      throw new TaskAbort(`Loop detected: "${tu.name}" called with identical args >3 times.`);
    }
    history.push(sig);

    const tier: RiskTier = tool.risk?.(args) ?? classifyAction(tu.name, args);

    // Trifecta-lite: reading web/email marks untrusted/private; an egress tool
    // that would complete the trifecta is escalated to a mandatory approval.
    ctx.governance.markTrifecta(trifectaImpact(tu.name));
    let needApproval = HITL_TIERS.includes(tier);
    let reason = `Risk tier ${tier}`;
    if (isEgressTool(tu.name)) {
      const tf = ctx.governance.trifecta();
      if (tf.readUntrusted && tf.hasPrivate) {
        ctx.governance.markTrifecta({ canEgress: true });
        needApproval = true;
        reason = 'Trifecta: untrusted read + private data + egress in one session';
      }
    }

    ctx.emit({ kind: 'tool.start', sessionId: ctx.sessionId, toolName: tu.name, args: maskSecrets(args), tier });

    if (needApproval) {
      ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'awaiting-approval' });
      const resolution = await ctx.governance.requestApproval({
        sessionId: ctx.sessionId,
        toolName: tu.name,
        args: maskSecrets(args),
        tier,
        reason,
      });
      if (resolution.decision === 'deny') {
        this.audit({ toolName: tu.name, args, tier, status: 'denied', error: resolution.timedOut ? 'approval timed out' : 'denied by user' });
        ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: tu.name, status: 'denied' });
        ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'thinking' });
        return this.toolError(tu.id, resolution.timedOut ? 'Approval timed out (treated as deny).' : 'Denied by the human.');
      }
      ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'tool' });
    } else {
      ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'tool' });
    }

    const started = Date.now();
    try {
      const out = await tool.execute(args, ctx);
      const status = out.ok ? 'ok' : 'error';
      this.audit({
        toolName: tu.name,
        args,
        tier,
        status,
        result: out.ok ? out.result : undefined,
        error: out.error,
        durationMs: Date.now() - started,
      });
      ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: tu.name, status, error: out.error });
      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(out.ok ? out.result ?? {} : { error: out.error }),
        is_error: !out.ok,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.audit({ toolName: tu.name, args, tier, status: 'error', error, durationMs: Date.now() - started });
      ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: tu.name, status: 'error', error });
      return this.toolError(tu.id, error);
    }
  }

  private toolError(toolUseId: string, message: string): Anthropic.ToolResultBlockParam {
    return { type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify({ error: message }), is_error: true };
  }

  private audit(e: Omit<AuditEntry, 'sessionId' | 'ts'>): void {
    recordAudit(this.deps.ctx.db, { ...e, sessionId: this.deps.ctx.sessionId, ts: Date.now() });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition — builds the ToolCtx, governance and browser handle, then exposes
// the IPC façade the shell (index.ts / ipc.ts) consumes.
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateOrchestratorOpts {
  config: AlfredConfig;
  db: AlfredDb;
  emit: (event: StreamEvent) => void;
  /** App data dir; the persistent browser profile lives under it. */
  dataDir: string;
}

export interface OrchestratorHandle {
  send(text: string): Promise<void>;
  stop(): void;
  resolveApproval(resolution: { id: string; decision: ApprovalDecision }): void;
  listProjects(): ProjectRecord[];
  listAccounts(): AccountRecord[];
  connectGmail(): Promise<AccountRecord | null>;
}

export function createOrchestrator(opts: CreateOrchestratorOpts): OrchestratorHandle {
  const { config, db, emit } = opts;
  const sessionId = randomUUID();

  const gov = createGovernance({ sessionId, emit });
  const browser = createBrowserHandle(join(opts.dataDir, 'browser-profile'));

  const ctx: ToolCtx = {
    sessionId,
    workspace: config.workspace,
    db,
    governance: gov.governance,
    secrets: createSecrets(),
    browser,
    emit,
    sendUi: (payload) => emit({ kind: 'ui.render', payload }),
  };

  void ensureScaffold(config.workspace).catch(() => {});

  let active: Orchestrator | null = null;

  const queryAccounts = (): AccountRecord[] =>
    db
      .prepare(
        'SELECT id, provider, email, secret_ref AS secretRef, connected_at AS connectedAt FROM accounts ORDER BY connected_at DESC',
      )
      .all() as AccountRecord[];

  /** Inject a known project's context when the prompt names one (ICM routing). */
  async function projectContext(text: string): Promise<string | undefined> {
    const lower = text.toLowerCase();
    const hit = listProjects(db).find((p) => lower.includes(p.slug) || lower.includes(p.name.toLowerCase()));
    if (!hit) return undefined;
    const detail = await getProject(db, config.workspace, hit.slug);
    if (!detail) return undefined;
    const m = detail.manifest;
    return [
      `${m.name} (${m.slug}) — ${m.stack}, status ${m.status}`,
      `Path: ${m.path}`,
      m.summary ? `Summary: ${m.summary}` : '',
      detail.files.length ? `Files:\n${detail.files.map((f) => `  ${f}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return {
    async send(text) {
      gov.resetTrifecta();
      active = new Orchestrator({ config, ctx, tools, projectContext: await projectContext(text) });
      await active.run(text);
    },
    stop() {
      active?.abort();
    },
    resolveApproval({ id, decision }) {
      gov.resolveApproval(id, decision);
    },
    listProjects() {
      return listProjects(db);
    },
    listAccounts() {
      return queryAccounts();
    },
    async connectGmail() {
      const gmailTool = tools.find((t) => t.name === 'gmail');
      if (!gmailTool) return null;
      const out = await gmailTool.execute({ op: 'connect' }, ctx);
      if (!out.ok) return null;
      const email = (out.result as { email?: string } | undefined)?.email;
      return queryAccounts().find((a) => a.email === email) ?? null;
    },
  };
}
